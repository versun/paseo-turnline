import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { z } from "zod";
import type { providerPromptSchema } from "../../shared/prompt";

type ProviderPrompt = z.infer<typeof providerPromptSchema>;

interface PiMessage {
  role?: string;
  content?: unknown;
  sections?: Record<string, string | null>;
  toolsAdded?: Array<{ name?: string }>;
  toolsRemoved?: Array<{ name?: string }>;
  provider?: string;
  model?: string;
  timestamp?: number;
}

interface PiEntry {
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
