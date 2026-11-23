import { lstatSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { z } from "zod";
import type { providerPromptSchema } from "../../shared/prompt";
import type { UsageRecord } from "../../shared/usage";

type ProviderPrompt = z.infer<typeof providerPromptSchema>;
type PromptSection = ProviderPrompt["sections"][number];

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;
const MAX_SCAN_DEPTH = 4;
const MAX_PATH_CACHE_ENTRIES = 64;
const MAX_READ_CACHE_ENTRIES = 32;

const codexPathCache = new Map<string, string>();
const codexPromptCache = new Map<string, { fingerprint: string; prompt: ProviderPrompt }>();
const codexUsageCache = new Map<string, { fingerprint: string; records: UsageRecord[] }>();

interface CodexEntry {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface ParsedTokenCounts {
  input?: number;
  cached?: number;
  hasCachedField: boolean;
  output?: number;
  total?: number;
}

export function defaultCodexHome(): string {
  const override = process.env.CODEX_HOME?.trim();
  return override || join(homedir(), ".codex");
}

/**
 * Codex CLI stores session rollouts under:
 * - `<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`
 * - `<CODEX_HOME|~/.codex>/archived_sessions/rollout-<timestamp>-<threadId>.jsonl`
 */
export async function resolveCodexSessionFile(
  nativeHandle: string | undefined,
  sessionId: string | undefined,
  metadata?: unknown,
  codexHome = defaultCodexHome(),
): Promise<string | undefined> {
  const trimmedHandle = nonEmptyString(nativeHandle);
  const trimmedSessionId = nonEmptyString(sessionId);
  const metaThreadId = readMetadataThreadId(metadata);

  if (trimmedHandle?.endsWith(".jsonl")) {
    if (isAbsolute(trimmedHandle) && !hasTraversalSegment(trimmedHandle) && isRegularFile(trimmedHandle)) {
      return trimmedHandle;
    }
    if (!trimmedSessionId && !metaThreadId) return undefined;
  }

  const id =
    trimmedSessionId ||
    (trimmedHandle && !trimmedHandle.endsWith(".jsonl") ? trimmedHandle : undefined) ||
    metaThreadId;
  if (!id || id === "." || id === ".." || id.includes("..") || !SAFE_SESSION_ID.test(id)) {
    return undefined;
  }

  const cacheKey = `${codexHome}\0${id}`;
  const cached = codexPathCache.get(cacheKey);
  if (cached) {
    if (isNonSymlinkRegularFile(cached)) {
      lruCacheSet(codexPathCache, cacheKey, cached, MAX_PATH_CACHE_ENTRIES);
      return cached;
    }
    codexPathCache.delete(cacheKey);
  }

  const matches = (name: string): boolean =>
    name === `${id}.jsonl` || name.endsWith(`-${id}.jsonl`) || name.endsWith(`_${id}.jsonl`);

  for (const subdir of ["sessions", "archived_sessions"]) {
    const found = await findRolloutFile(join(codexHome, subdir), matches, 0);
    if (found) {
      lruCacheSet(codexPathCache, cacheKey, found, MAX_PATH_CACHE_ENTRIES);
      return found;
    }
  }
  return undefined;
}

async function findRolloutFile(
  dir: string,
  matches: (name: string) => boolean,
  depth: number,
): Promise<string | undefined> {
  if (depth > MAX_SCAN_DEPTH) return undefined;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  // Sort descending so newest date directories (YYYY/MM/DD) and rollouts are checked first.
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      files.push(entry.name);
    } else if (entry.isDirectory()) {
      subdirs.push(entry.name);
    }
  }
  files.sort((a, b) => b.localeCompare(a));
  for (const name of files) {
    if (matches(name)) return join(dir, name);
  }
  subdirs.sort((a, b) => b.localeCompare(a));
  for (const name of subdirs) {
    const found = await findRolloutFile(join(dir, name), matches, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Replay a Codex rollout JSONL file up to `at` (or latest) to extract
 * effective prompt instructions (`base_instructions`, `developer_instructions`,
 * `user_instructions`, and developer/system message sections), model, observed
 * tool calls, and conversation context messages.
 */
export async function readCodexPrompt(options: {
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

  const fingerprint = await readFileFingerprint(sessionFile);
  const cacheKey = `${sessionFile}\0${at ?? ""}\0${includeMessages ? "1" : "0"}`;
  const cached = codexPromptCache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) {
    lruCacheSet(codexPromptCache, cacheKey, cached, MAX_READ_CACHE_ENTRIES);
    return cloneProviderPrompt(cached.prompt);
  }

  const raw = await readFile(sessionFile, "utf8");

  let baseInstructions: string | undefined;
  let developerInstructions: string | undefined;
  let userInstructions: string | undefined;
  const promptMessageSections = new Map<string, PromptSection>();
  const unnamedSectionCounts = new Map<string, number>();

  let model: string | undefined;
  let capturedAt: string | undefined;
  const observedTools = new Set<string>();

  const responseMessages: NonNullable<ProviderPrompt["messages"]> = [];
  let responseMessageCount = 0;
  let sawResponseItems = false;

  // Legacy event-only rollouts may omit response_item entries; keep a fallback
  // list from event_msg and only use it when no response_item messages exist.
  const eventFallbackMessages: NonNullable<ProviderPrompt["messages"]> = [];
  let eventFallbackCount = 0;

  const inRange = (timestamp: unknown, fallbackTs?: unknown): boolean => {
    if (atMs === undefined) return true;
    const ms = parseTimestampMs(timestamp) ?? parseTimestampMs(fallbackTs);
    return ms !== undefined && ms <= atMs;
  };

  const applyResponseItem = (payload: Record<string, unknown>, ts: string | undefined) => {
    const itemType = typeof payload.type === "string" ? payload.type : undefined;
    if (!itemType) return;

    switch (itemType) {
      case "message": {
        const role = typeof payload.role === "string" ? payload.role : undefined;
        if (!role) break;
        const text = serializeCodexContent(payload.content);
        if (!text) break;

        if (role === "developer" || role === "system") {
          const detected = classifyCodexPromptSection(text, role);
          if (detected.replaceKey) {
            promptMessageSections.set(detected.replaceKey, { name: detected.name, text });
          } else {
            const nextCount = (unnamedSectionCounts.get(role) ?? 0) + 1;
            unnamedSectionCounts.set(role, nextCount);
            const key = `${role}:${nextCount}`;
            const name = nextCount > 1 ? `${role} #${nextCount}` : role;
            promptMessageSections.set(key, { name, text });
          }
          capturedAt = ts ?? capturedAt;
        } else {
          responseMessageCount += 1;
          if (includeMessages) {
            responseMessages.push({ role, content: text, at: ts });
          }
          capturedAt = ts ?? capturedAt;
        }
        break;
      }

      case "reasoning": {
        const text = extractCodexReasoningText(payload);
        if (text) {
          responseMessageCount += 1;
          if (includeMessages) {
            responseMessages.push({ role: "assistant", content: `[thinking]\n${text}`, at: ts });
          }
          capturedAt = ts ?? capturedAt;
        }
        break;
      }

      case "function_call": {
        const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : "?";
        if (name !== "?") observedTools.add(name);
        const args = formatToolPayload(payload.arguments);
        responseMessageCount += 1;
        if (includeMessages) {
          responseMessages.push({
            role: "assistant",
            content: args ? `[tool call: ${name}]\n${args}` : `[tool call: ${name}]`,
            at: ts,
          });
        }
        capturedAt = ts ?? capturedAt;
        break;
      }

      case "function_call_output":
      case "custom_tool_call_output": {
        const out = formatToolPayload(payload.output);
        responseMessageCount += 1;
        if (includeMessages) {
          responseMessages.push({
            role: "tool",
            content: out ? `[tool result]\n${out}` : "[tool result]",
            at: ts,
          });
        }
        capturedAt = ts ?? capturedAt;
        break;
      }

      case "custom_tool_call": {
        const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : "?";
        if (name !== "?") observedTools.add(name);
        const input = formatToolPayload(payload.input);
        responseMessageCount += 1;
        if (includeMessages) {
          responseMessages.push({
            role: "assistant",
            content: input ? `[tool call: ${name}]\n${input}` : `[tool call: ${name}]`,
            at: ts,
          });
        }
        capturedAt = ts ?? capturedAt;
        break;
      }

      case "local_shell_call": {
        observedTools.add("local_shell");
        const action = formatToolPayload(payload.action);
        responseMessageCount += 1;
        if (includeMessages) {
          responseMessages.push({
            role: "assistant",
            content: action ? `[tool call: local_shell]\n${action}` : "[tool call: local_shell]",
            at: ts,
          });
        }
        capturedAt = ts ?? capturedAt;
        break;
      }

      case "web_search_call": {
        observedTools.add("web_search");
        const action = formatToolPayload(payload.action);
        responseMessageCount += 1;
        if (includeMessages) {
          responseMessages.push({
            role: "assistant",
            content: action ? `[tool call: web_search]\n${action}` : "[tool call: web_search]",
            at: ts,
          });
        }
        capturedAt = ts ?? capturedAt;
        break;
      }

      case "compaction": {
        responseMessageCount += 1;
        if (includeMessages) {
          responseMessages.push({
            role: "system",
            content: "[compaction checkpoint]",
            at: ts,
          });
        }
        capturedAt = ts ?? capturedAt;
        break;
      }

      default:
        break;
    }
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const entry = parsed as CodexEntry;
    const entryType = typeof entry.type === "string" ? entry.type : undefined;
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    if (!entryType || !payload) continue;

    if (!inRange(entry.timestamp, payload.timestamp)) continue;
    const ts = validIso(entry.timestamp) ?? validIso(payload.timestamp);

    switch (entryType) {
      case "session_meta": {
        const base =
          extractInstructionText(payload.base_instructions) ??
          extractInstructionText(payload.instructions);
        if (base) baseInstructions = base;
        const metaModel = nonEmptyString(payload.model);
        if (metaModel) model = metaModel;
        capturedAt = ts ?? capturedAt;
        break;
      }

      case "turn_context": {
        const collabSettings = isRecord(payload.collaboration_mode)
          ? isRecord(payload.collaboration_mode.settings)
            ? payload.collaboration_mode.settings
            : undefined
          : undefined;
        const turnModel = nonEmptyString(payload.model) ?? nonEmptyString(collabSettings?.model);
        if (turnModel) model = turnModel;

        const base = extractInstructionText(payload.base_instructions);
        if (base) baseInstructions = base;

        const dev =
          extractInstructionText(payload.developer_instructions) ??
          extractInstructionText(collabSettings?.developer_instructions);
        if (dev) developerInstructions = dev;

        const userInst = extractInstructionText(payload.user_instructions);
        if (userInst) userInstructions = userInst;

        capturedAt = ts ?? capturedAt;
        break;
      }

      case "response_item": {
        sawResponseItems = true;
        applyResponseItem(payload, ts);
        break;
      }

      case "compacted": {
        if (Array.isArray(payload.replacement_history)) {
          sawResponseItems = true;
          responseMessages.length = 0;
          responseMessageCount = 0;
          eventFallbackMessages.length = 0;
          eventFallbackCount = 0;
          promptMessageSections.clear();
          unnamedSectionCounts.clear();
          for (const item of payload.replacement_history) {
            if (isRecord(item)) applyResponseItem(item, ts);
          }
          capturedAt = ts ?? capturedAt;
        } else if (typeof payload.message === "string" && payload.message.trim()) {
          responseMessageCount += 1;
          if (includeMessages) {
            responseMessages.push({
              role: "system",
              content: `[compaction summary]\n${payload.message.trim()}`,
              at: ts,
            });
          }
          capturedAt = ts ?? capturedAt;
        }
        break;
      }

      case "event_msg": {
        const evType = typeof payload.type === "string" ? payload.type : undefined;
        if (evType === "user_message" && typeof payload.message === "string" && payload.message.trim()) {
          eventFallbackCount += 1;
          if (includeMessages) {
            eventFallbackMessages.push({ role: "user", content: payload.message, at: ts });
          }
          capturedAt = ts ?? capturedAt;
        } else if (evType === "agent_message" && typeof payload.message === "string" && payload.message.trim()) {
          eventFallbackCount += 1;
          if (includeMessages) {
            eventFallbackMessages.push({ role: "assistant", content: payload.message, at: ts });
          }
          capturedAt = ts ?? capturedAt;
        } else if (
          (evType === "agent_reasoning" || evType === "agent_reasoning_raw_content") &&
          typeof payload.text === "string" &&
          payload.text.trim()
        ) {
          eventFallbackCount += 1;
          if (includeMessages) {
            eventFallbackMessages.push({
              role: "assistant",
              content: `[thinking]\n${payload.text}`,
              at: ts,
            });
          }
          capturedAt = ts ?? capturedAt;
        }
        break;
      }

      default:
        break;
    }
  }

  const sections: PromptSection[] = [];
  const seenTexts = new Set<string>();
  const pushSection = (name: string, text: string | undefined) => {
    if (!text) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const norm = normalizeForCompare(trimmed);
    if (seenTexts.has(norm)) return;
    seenTexts.add(norm);
    sections.push({ name, text });
  };

  pushSection("base_instructions", baseInstructions);
  pushSection("developer_instructions", developerInstructions);
  pushSection("user_instructions", userInstructions);
  for (const sec of promptMessageSections.values()) {
    pushSection(sec.name, sec.text);
  }

  const useResponseItems = responseMessageCount > 0 || sawResponseItems;
  const messageCount = useResponseItems ? responseMessageCount : eventFallbackCount;
  const messages = includeMessages
    ? useResponseItems
      ? responseMessages
      : eventFallbackMessages
    : undefined;

  const result: ProviderPrompt = {
    capturedAt,
    model,
    sections,
    tools: observedTools.size > 0 ? [...observedTools] : undefined,
    toolsKind: observedTools.size > 0 ? "observed" : undefined,
    messages,
    messageCount,
    source: { kind: "codex-session", path: sessionFile },
  };
  lruCacheSet(codexPromptCache, cacheKey, { fingerprint, prompt: result }, MAX_READ_CACHE_ENTRIES);
  return cloneProviderPrompt(result);
}

/**
 * Extract per-LLM-call token usage records from a Codex rollout JSONL file.
 * Codex logs assistant `response_item` entries (reasoning, tool calls, replies)
 * as they complete, followed by an `event_msg` of type `token_count` carrying
 * `info.last_token_usage` and cumulative `info.total_token_usage`. Duplicate
 * `token_count` events (identical `total_token_usage` or `info: null`) are
 * skipped so each LLM call is counted once.
 */
export async function readCodexUsage(sessionFile: string): Promise<UsageRecord[]> {
  const fingerprint = await readFileFingerprint(sessionFile);
  const cached = codexUsageCache.get(sessionFile);
  if (cached && cached.fingerprint === fingerprint) {
    lruCacheSet(codexUsageCache, sessionFile, cached, MAX_READ_CACHE_ENTRIES);
    return cloneUsageRecords(cached.records);
  }

  const raw = await readFile(sessionFile, "utf8");
  const records: UsageRecord[] = [];

  let pendingCallIds: string[] = [];
  let pendingCallIdSet = new Set<string>();
  let pendingMessageId: string | undefined;
  let pendingTextPrefix: string | undefined;
  let pendingThinkingPrefix: string | undefined;

  let prevTotal: ParsedTokenCounts | undefined;

  const resetPending = () => {
    pendingCallIds = [];
    pendingCallIdSet = new Set<string>();
    pendingMessageId = undefined;
    pendingTextPrefix = undefined;
    pendingThinkingPrefix = undefined;
  };

  const addCallId = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || pendingCallIdSet.has(trimmed)) return;
    pendingCallIdSet.add(trimmed);
    pendingCallIds.push(trimmed);
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const entry = parsed as CodexEntry;
    const entryType = typeof entry.type === "string" ? entry.type : undefined;
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    if (!entryType || !payload) continue;

    if (entryType === "response_item") {
      const itemType = typeof payload.type === "string" ? payload.type : undefined;
      switch (itemType) {
        case "message": {
          const role = typeof payload.role === "string" ? payload.role : undefined;
          if (role === "user") {
            resetPending();
          } else if (role === "assistant") {
            const id = nonEmptyString(payload.id);
            if (id) pendingMessageId = id;
            if (!pendingTextPrefix) {
              const text = serializeCodexContent(payload.content);
              if (text) pendingTextPrefix = normalizePrefix(text);
            }
          }
          break;
        }
        case "reasoning": {
          if (!pendingThinkingPrefix) {
            const text = extractCodexReasoningText(payload);
            if (text) pendingThinkingPrefix = normalizePrefix(text);
          }
          break;
        }
        case "function_call":
        case "custom_tool_call":
        case "local_shell_call":
        case "web_search_call": {
          addCallId(payload.call_id);
          addCallId(payload.id);
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (entryType !== "event_msg") continue;
    const evType = typeof payload.type === "string" ? payload.type : undefined;

    if (evType === "task_started" || evType === "user_message") {
      resetPending();
      continue;
    }

    if (evType === "agent_message") {
      if (!pendingMessageId) {
        const id = nonEmptyString(payload.id);
        if (id) pendingMessageId = id;
      }
      if (!pendingTextPrefix && typeof payload.message === "string") {
        pendingTextPrefix = normalizePrefix(payload.message);
      }
      continue;
    }

    if (evType === "agent_reasoning" || evType === "agent_reasoning_raw_content") {
      if (!pendingThinkingPrefix && typeof payload.text === "string") {
        pendingThinkingPrefix = normalizePrefix(payload.text);
      }
      continue;
    }

    if (evType !== "token_count") continue;
    const info = isRecord(payload.info) ? payload.info : undefined;
    if (!info) continue;

    const total = parseCodexTokenCounts(info.total_token_usage);
    const last = parseCodexTokenCounts(info.last_token_usage);

    if (total && prevTotal && sameTokenCounts(total, prevTotal)) {
      continue;
    }

    let inputTokens: number | undefined;
    let cachedInputTokens: number | undefined;
    let outputTokens: number | undefined;

    if (last) {
      inputTokens = Math.max(last.input ?? 0, last.cached ?? 0);
      cachedInputTokens = last.cached ?? (last.hasCachedField ? 0 : undefined);
      outputTokens = last.output ?? 0;
    } else if (total) {
      const counterReset =
        prevTotal !== undefined &&
        ((total.input ?? 0) < (prevTotal.input ?? 0) ||
          (total.output ?? 0) < (prevTotal.output ?? 0) ||
          (total.cached !== undefined &&
            prevTotal.cached !== undefined &&
            total.cached < prevTotal.cached));
      const baseTotal = counterReset ? undefined : prevTotal;
      const deltaInput = Math.max(0, (total.input ?? 0) - (baseTotal?.input ?? 0));
      const deltaCached =
        total.cached !== undefined
          ? Math.max(0, total.cached - (baseTotal?.cached ?? 0))
          : total.hasCachedField
            ? 0
            : undefined;
      const deltaOutput = Math.max(0, (total.output ?? 0) - (baseTotal?.output ?? 0));
      inputTokens = Math.max(deltaInput, deltaCached ?? 0);
      cachedInputTokens = deltaCached;
      outputTokens = deltaOutput;
    } else {
      continue;
    }

    if (inputTokens === 0 && outputTokens === 0) {
      if (total) prevTotal = total;
      continue;
    }

    if (total) prevTotal = total;

    const at = validIso(entry.timestamp);
    records.push({
      at,
      messageId: pendingMessageId,
      callIds: pendingCallIds.length > 0 ? [...pendingCallIds] : undefined,
      textPrefix: pendingTextPrefix,
      thinkingPrefix: pendingThinkingPrefix,
      usage: {
        inputTokens,
        cachedInputTokens,
        outputTokens,
      },
    });
    resetPending();
  }

  lruCacheSet(codexUsageCache, sessionFile, { fingerprint, records }, MAX_READ_CACHE_ENTRIES);
  return cloneUsageRecords(records);
}

function classifyCodexPromptSection(
  text: string,
  role: string,
): { name: string; replaceKey?: string } {
  const trimmed = text.trim();
  if (trimmed.includes("<paseo_instruction_snapshot>")) {
    return { name: "paseo_instruction_snapshot", replaceKey: "tag:paseo_instruction_snapshot" };
  }
  const tagMatch = /^<([a-zA-Z0-9_ -]{2,48})>/.exec(trimmed);
  if (tagMatch?.[1]) {
    const tag = tagMatch[1].trim().replace(/\s+/g, "_").toLowerCase();
    if (tag) {
      return { name: tag, replaceKey: `tag:${tag}` };
    }
  }
  return { name: role };
}

function extractInstructionText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? value : undefined;
  }
  if (isRecord(value) && typeof value.text === "string" && value.text.trim()) {
    return value.text;
  }
  return undefined;
}

function serializeCodexContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      if (block == null) return "";
      if (typeof block !== "object") return String(block);
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case "input_text":
        case "output_text":
        case "text":
          return typeof b.text === "string" ? b.text : "";
        case "input_image":
        case "image":
          return "[image]";
        default:
          return typeof b.text === "string" ? b.text : JSON.stringify(block);
      }
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function extractCodexReasoningText(payload: Record<string, unknown>): string | undefined {
  const extractParts = (arr: unknown): string[] => {
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const part of arr) {
      if (typeof part === "string" && part.trim()) {
        out.push(part);
      } else if (isRecord(part) && typeof part.text === "string" && part.text.trim()) {
        out.push(part.text);
      }
    }
    return out;
  };
  const summary = extractParts(payload.summary);
  if (summary.length > 0) return summary.join("\n");
  const content = extractParts(payload.content);
  if (content.length > 0) return content.join("\n");
  return undefined;
}

function formatToolPayload(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function parseCodexTokenCounts(value: unknown): ParsedTokenCounts | undefined {
  if (!isRecord(value)) return undefined;
  const input = finiteNonNeg(value.input_tokens);
  const cached = finiteNonNeg(value.cached_input_tokens);
  const output = finiteNonNeg(value.output_tokens);
  const total = finiteNonNeg(value.total_tokens);
  if (input === undefined && cached === undefined && output === undefined) {
    return undefined;
  }
  return {
    input,
    cached,
    hasCachedField: "cached_input_tokens" in value,
    output,
    total,
  };
}

function sameTokenCounts(a: ParsedTokenCounts, b: ParsedTokenCounts): boolean {
  return (
    a.input === b.input &&
    a.cached === b.cached &&
    a.output === b.output &&
    a.total === b.total
  );
}

function readMetadataThreadId(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined;
  return nonEmptyString(metadata.threadId);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? value : undefined;
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasTraversalSegment(filePath: string): boolean {
  return filePath.split(/[/\\]/).includes("..");
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizePrefix(text: string): string | undefined {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 160) : undefined;
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isNonSymlinkRegularFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function lruCacheSet<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

async function readFileFingerprint(filePath: string): Promise<string> {
  const st = await stat(filePath);
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

function cloneProviderPrompt(prompt: ProviderPrompt): ProviderPrompt {
  return {
    ...prompt,
    sections: prompt.sections.map((section) => ({ ...section })),
    tools: prompt.tools ? [...prompt.tools] : undefined,
    messages: prompt.messages ? prompt.messages.map((message) => ({ ...message })) : undefined,
    source: prompt.source ? { ...prompt.source } : undefined,
  };
}

function cloneUsageRecords(records: UsageRecord[]): UsageRecord[] {
  return records.map((record) => ({
    ...record,
    callIds: record.callIds ? [...record.callIds] : undefined,
    usage: { ...record.usage },
  }));
}
