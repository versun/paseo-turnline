import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { z } from "zod";
import type { providerPromptSchema } from "../../shared/prompt";
import type { UsageRecord } from "../../shared/usage";

type ProviderPrompt = z.infer<typeof providerPromptSchema>;

interface PiUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
  cost?: { total?: unknown } | null;
}

interface PiMessage {
  role?: string;
  content?: unknown;
  sections?: Record<string, string | null>;
  toolsAdded?: Array<{ name?: string }>;
  toolsRemoved?: Array<{ name?: string }>;
  provider?: string;
  model?: string;
  timestamp?: number;
  responseId?: string;
  usage?: PiUsage;
}

interface PiEntry {
  id?: string;
  type?: string;
  timestamp?: string;
  message?: PiMessage;
  provider?: string;
  modelId?: string;
  /** compaction: replayed prompt/tool checkpoint at the compaction boundary. */
  systemMessage?: PiMessage;
}

/**
 * Pi persists its prompt as `role:"system"` message entries in the session
 * JSONL (`~/.pi/agent/sessions/--<cwd-slug>--/<ts>_<id>.jsonl`). The first
 * request writes every section plus `toolsAdded`; later requests append patch
 * entries (`sections` merged by name, `null` removes; `toolsAdded` /
 * `toolsRemoved`). A `compaction` entry may carry a `systemMessage` checkpoint
 * that replaces the accumulated state. Replaying the entries in append order
 * yields the effective prompt at any point.
 *
 * Entries form a tree via parentId across branches; append order approximates
 * the active branch, which is fine for inspection.
 */
export async function readPiPrompt(options: {
  sessionFile: string;
  at?: string;
  includeMessages?: boolean;
}): Promise<ProviderPrompt> {
  const { sessionFile, at, includeMessages } = options;
  let atMs: number | undefined;
  if (at !== undefined) {
    atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) {
      throw new Error(`invalid timestamp: ${at}`);
    }
  }
  const raw = await readFile(sessionFile, "utf8");

  const sections = new Map<string, string>();
  const tools = new Set<string>();
  const messages: NonNullable<ProviderPrompt["messages"]> = [];
  let model: string | undefined;
  let capturedAt: string | undefined;
  let messageCount = 0;

  const applySystemMessage = (message: PiMessage) => {
    if (message.sections && typeof message.sections === "object" && !Array.isArray(message.sections)) {
      for (const [name, text] of Object.entries(message.sections)) {
        if (text === null) sections.delete(name);
        else if (typeof text === "string") sections.set(name, text);
      }
    }
    if (Array.isArray(message.toolsAdded)) {
      for (const tool of message.toolsAdded) {
        if (typeof tool?.name === "string" && tool.name) tools.add(tool.name);
      }
    }
    if (Array.isArray(message.toolsRemoved)) {
      for (const tool of message.toolsRemoved) {
        if (typeof tool?.name === "string" && tool.name) tools.delete(tool.name);
      }
    }
  };

  const inRange = (iso: string | undefined, nestedMs?: number): boolean => {
    if (atMs === undefined) return true;
    const ms =
      typeof nestedMs === "number" && Number.isFinite(nestedMs)
        ? nestedMs
        : iso
          ? Date.parse(iso)
          : NaN;
    return Number.isFinite(ms) && ms <= atMs;
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: PiEntry;
    try {
      entry = JSON.parse(line) as PiEntry;
    } catch {
      continue;
    }

    switch (entry.type) {
      case "message": {
        const message = entry.message;
        if (!message?.role) break;
        if (!inRange(entry.timestamp, message.timestamp)) break;
        if (message.role === "system") {
          applySystemMessage(message);
          capturedAt = entry.timestamp ?? isoOf(message.timestamp) ?? capturedAt;
        } else {
          messageCount += 1;
          if (includeMessages) {
            messages.push({
              role: message.role,
              content: serializeContent(message.content),
              at: isoOf(message.timestamp) ?? entry.timestamp,
            });
          }
        }
        model = formatModel(message.provider, message.model) ?? model;
        break;
      }
      case "compaction": {
        if (!entry.systemMessage || !inRange(entry.timestamp, entry.systemMessage.timestamp)) break;
        // The checkpoint replaces accumulated prompt state; entries kept from
        // before are superseded and later patches apply on top.
        sections.clear();
        tools.clear();
        applySystemMessage(entry.systemMessage);
        model = formatModel(entry.systemMessage.provider, entry.systemMessage.model) ?? model;
        capturedAt = entry.timestamp ?? isoOf(entry.systemMessage.timestamp) ?? capturedAt;
        break;
      }
      case "model_change": {
        if (!inRange(entry.timestamp)) break;
        model = formatModel(entry.provider, entry.modelId) ?? model;
        break;
      }
      default:
        break;
    }
  }

  const declaredTools = [...tools].sort();
  return {
    capturedAt,
    model,
    sections: [...sections.entries()].map(([name, text]) => ({ name, text })),
    tools: declaredTools.length > 0 ? declaredTools : undefined,
    toolsKind: declaredTools.length > 0 ? "declared" : undefined,
    messages: includeMessages ? messages : undefined,
    messageCount,
    source: { kind: "pi-session", path: sessionFile },
  };
}

/**
 * Extract per-LLM-call token usage records from a Pi session JSONL file.
 * Pi records uncached `input`, `cacheRead`, `cacheWrite`, and `output`
 * separately, so total input tokens = `input + cacheRead + cacheWrite`.
 */
export async function readPiUsage(sessionFile: string): Promise<UsageRecord[]> {
  const raw = await readFile(sessionFile, "utf8");
  const records: UsageRecord[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || (parsed as PiEntry).type !== "message") {
      continue;
    }
    const entry = parsed as PiEntry;
    const message = entry.message;
    if (!message || message.role !== "assistant" || !message.usage || typeof message.usage !== "object") {
      continue;
    }

    const u = message.usage;
    const uncached = finiteNonNeg(u.input);
    const cacheRead = finiteNonNeg(u.cacheRead);
    const cacheWrite = finiteNonNeg(u.cacheWrite);
    const output = finiteNonNeg(u.output);
    if (uncached === undefined && cacheRead === undefined && cacheWrite === undefined && output === undefined) {
      continue;
    }

    const inputTokens = (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    const outputTokens = output ?? 0;
    const costUsd = finiteNonNeg(u.cost?.total);

    const callIds: string[] = [];
    let textPrefix: string | undefined;
    let thinkingPrefix: string | undefined;

    if (typeof message.content === "string") {
      textPrefix = normalizePrefix(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if ((b.type === "toolCall" || b.type === "tool_call")) {
          const id = typeof b.id === "string" ? b.id : typeof b.callId === "string" ? b.callId : undefined;
          if (id) callIds.push(id);
        } else if (b.type === "text" && !textPrefix && typeof b.text === "string") {
          textPrefix = normalizePrefix(b.text);
        } else if (b.type === "thinking" && !thinkingPrefix) {
          const t = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : undefined;
          if (t) thinkingPrefix = normalizePrefix(t);
        }
      }
    }

    const messageId =
      typeof message.responseId === "string" && message.responseId
        ? message.responseId
        : typeof entry.id === "string" && entry.id
          ? entry.id
          : undefined;

    records.push({
      at:
        (typeof entry.timestamp === "string" && entry.timestamp ? entry.timestamp : undefined) ??
        isoOf(message.timestamp),
      messageId,
      callIds: callIds.length > 0 ? callIds : undefined,
      textPrefix,
      thinkingPrefix,
      usage: {
        inputTokens,
        cachedInputTokens: cacheRead ?? ("cacheRead" in u ? 0 : undefined),
        cacheWriteTokens: cacheWrite && cacheWrite > 0 ? cacheWrite : undefined,
        outputTokens,
        costUsd,
      },
    });
  }

  return records;
}

/**
 * The agent record's nativeHandle is normally the session file path. When it
 * only carries the session id (or points to a moved path), locate the file
 * under pi's session directory for the agent's cwd (`--<path with separators as ->--`)
 * by id suffix.
 */
export async function resolvePiSessionFile(
  nativeHandle: string | undefined,
  sessionId: string | undefined,
  cwd: string | undefined,
  sessionsRoot = join(homedir(), ".pi", "agent", "sessions"),
): Promise<string | undefined> {
  if (nativeHandle?.endsWith(".jsonl") && existsSync(nativeHandle)) return nativeHandle;
  const id = sessionId || nativeHandle;
  if (!id || !cwd) return undefined;
  const trimmedCwd = cwd.replace(/^[/\\]+|[/\\]+$/g, "");
  const slug = `--${trimmedCwd.replace(/[/\\:]/g, "-")}--`;
  const dir = join(sessionsRoot, slug);
  const movedName = !sessionId && nativeHandle?.endsWith(".jsonl") ? basename(nativeHandle) : undefined;
  try {
    const match = (await readdir(dir)).find((name) =>
      movedName ? name === movedName : name.endsWith(`_${id}.jsonl`),
    );
    return match ? join(dir, match) : undefined;
  } catch {
    return undefined;
  }
}

function formatModel(provider: string | undefined, modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return provider ? `${provider}/${modelId}` : modelId;
}

function isoOf(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizePrefix(text: string): string | undefined {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 160) : undefined;
}

function serializeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      if (block == null) return "";
      if (typeof block !== "object") return String(block);
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case "text":
          return typeof b.text === "string" ? b.text : "";
        case "toolCall":
        case "tool_call": {
          const args = b.arguments ?? b.args ?? b.input ?? {};
          const formattedArgs = typeof args === "string" ? args : JSON.stringify(args, null, 2);
          return `[tool call: ${String(b.name ?? b.toolName ?? "?")}]\n${formattedArgs}`;
        }
        case "toolResult":
        case "tool_result":
          return `[tool result]\n${serializeContent(b.content)}`;
        case "thinking": {
          const text = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          return `[thinking]\n${text}`;
        }
        case "image":
          return "[image]";
        default:
          return JSON.stringify(block);
      }
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
}
