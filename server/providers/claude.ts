import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { UsageRecord } from "../../shared/usage";

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

interface ClaudeUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

interface ClaudeMessage {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  usage?: ClaudeUsage;
}

interface ClaudeEntry {
  type?: unknown;
  timestamp?: unknown;
  message?: ClaudeMessage;
}

/**
 * Claude Code stores session transcripts under
 * `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`.
 */
export async function resolveClaudeSessionFile(
  nativeHandle: string | undefined,
  sessionId: string | undefined,
  cwd: string | undefined,
  projectsRoot = join(homedir(), ".claude", "projects"),
): Promise<string | undefined> {
  if (nativeHandle?.endsWith(".jsonl")) {
    if (isAbsolute(nativeHandle) && !hasTraversalSegment(nativeHandle) && existsSync(nativeHandle)) {
      return nativeHandle;
    }
    if (!sessionId) return undefined;
  }
  const rawId = sessionId || nativeHandle;
  const id = rawId?.trim();
  if (!id || id === "." || id === ".." || id.includes("..") || !SAFE_SESSION_ID.test(id)) {
    return undefined;
  }

  const filename = `${id}.jsonl`;
  if (cwd) {
    const slug = cwd.replace(/[^A-Za-z0-9-]/g, "-");
    const candidate = join(projectsRoot, slug, filename);
    if (existsSync(candidate)) return candidate;
  }

  try {
    const dirs = await readdir(projectsRoot, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const candidate = join(projectsRoot, dir.name, filename);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Extract per-LLM-call token usage records from a Claude Code JSONL transcript.
 * Claude emits multiple JSONL lines per assistant `message.id` (e.g., thinking
 * block followed by tool_use or text blocks); lines sharing the same message id
 * are merged into one UsageRecord carrying all callIds and the latest usage.
 */
export async function readClaudeUsage(sessionFile: string): Promise<UsageRecord[]> {
  const raw = await readFile(sessionFile, "utf8");
  const records: UsageRecord[] = [];
  const indexByMessageId = new Map<string, number>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || (parsed as ClaudeEntry).type !== "assistant") {
      continue;
    }
    const entry = parsed as ClaudeEntry;
    const msg = entry.message;
    if (!msg || typeof msg !== "object" || !msg.usage || typeof msg.usage !== "object") continue;

    const u = msg.usage;
    const uncached = finiteNonNeg(u.input_tokens);
    const cacheRead = finiteNonNeg(u.cache_read_input_tokens);
    const cacheWrite = finiteNonNeg(u.cache_creation_input_tokens);
    const output = finiteNonNeg(u.output_tokens);
    if (uncached === undefined && cacheRead === undefined && cacheWrite === undefined && output === undefined) {
      continue;
    }

    const inputTokens = (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    const outputTokens = output ?? 0;
    const hasCacheField = "cache_read_input_tokens" in u;

    const callIds: string[] = [];
    let textPrefix: string | undefined;
    let thinkingPrefix: string | undefined;

    if (typeof msg.content === "string") {
      textPrefix = normalizePrefix(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if ((b.type === "tool_use" || b.type === "toolCall") && typeof b.id === "string" && b.id) {
          callIds.push(b.id);
        } else if (b.type === "text" && !textPrefix && typeof b.text === "string") {
          textPrefix = normalizePrefix(b.text);
        } else if (b.type === "thinking" && !thinkingPrefix) {
          const t = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : undefined;
          if (t) thinkingPrefix = normalizePrefix(t);
        }
      }
    }

    const messageId = typeof msg.id === "string" && msg.id ? msg.id : undefined;
    const at = typeof entry.timestamp === "string" && entry.timestamp ? entry.timestamp : undefined;

    if (messageId !== undefined) {
      const existingIdx = indexByMessageId.get(messageId);
      if (existingIdx !== undefined) {
        const existing = records[existingIdx];
        const mergedCalls = new Set([...(existing.callIds ?? []), ...callIds]);
        const mergedCached =
          cacheRead !== undefined
            ? Math.max(existing.usage.cachedInputTokens ?? 0, cacheRead)
            : existing.usage.cachedInputTokens ?? (hasCacheField ? 0 : undefined);
        const mergedCacheWrite =
          cacheWrite !== undefined && cacheWrite > 0
            ? Math.max(existing.usage.cacheWriteTokens ?? 0, cacheWrite)
            : existing.usage.cacheWriteTokens;
        const mergedInputTokens = Math.max(
          existing.usage.inputTokens,
          (uncached ?? 0) + (mergedCached ?? 0) + (mergedCacheWrite ?? 0),
        );
        const mergedOutputTokens =
          output !== undefined
            ? Math.max(existing.usage.outputTokens, output)
            : existing.usage.outputTokens;
        records[existingIdx] = {
          at: at ?? existing.at,
          messageId,
          callIds: mergedCalls.size > 0 ? [...mergedCalls] : undefined,
          textPrefix: existing.textPrefix ?? textPrefix,
          thinkingPrefix: existing.thinkingPrefix ?? thinkingPrefix,
          usage: {
            inputTokens: mergedInputTokens,
            cachedInputTokens: mergedCached,
            cacheWriteTokens: mergedCacheWrite,
            outputTokens: mergedOutputTokens,
          },
        };
        continue;
      }
      indexByMessageId.set(messageId, records.length);
    }

    records.push({
      at,
      messageId,
      callIds: callIds.length > 0 ? callIds : undefined,
      textPrefix,
      thinkingPrefix,
      usage: {
        inputTokens,
        cachedInputTokens: cacheRead ?? (hasCacheField ? 0 : undefined),
        cacheWriteTokens: cacheWrite && cacheWrite > 0 ? cacheWrite : undefined,
        outputTokens,
      },
    });
  }

  return records;
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
