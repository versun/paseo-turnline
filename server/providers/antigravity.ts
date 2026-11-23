import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import type { z } from "zod";
import type { providerPromptSchema } from "../../shared/prompt";
import type { UsageRecord } from "../../shared/usage";

type ProviderPrompt = z.infer<typeof providerPromptSchema>;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_FIELD_NUMBER = 0x1fffffffn;
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9._-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CACHE_ENTRIES = 4;

interface ProtoField {
  field: number;
  wire: number;
  /** varint (unsigned 64-bit representation) */
  num?: bigint;
  /** length-delimited payload */
  bytes?: Uint8Array;
}

/**
 * Decode an unsigned 64-bit protobuf varint without 32-bit JS bitwise truncation.
 * Supports full 10-byte encodings (including negative int32/int64 values).
 */
function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = pos;
  while (i < buf.length && shift <= 63n) {
    const b = buf[i];
    if (shift === 63n && b > 1) {
      throw new Error("varint overflow");
    }
    result |= BigInt(b & 0x7f) << shift;
    i += 1;
    if ((b & 0x80) === 0) return [result, i];
    shift += 7n;
  }
  throw new Error("truncated varint");
}

/**
 * Parse a buffer as a sequence of protobuf fields. Stops at the first
 * malformed field and returns what was cleanly read. Unknown wire types end
 * the parse — callers only rely on the leading structure of known records.
 */
function parseFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    let key: bigint;
    try {
      [key, i] = readVarint(buf, i);
    } catch {
      break;
    }
    const fieldBig = key >> 3n;
    const wire = Number(key & 7n);
    if (fieldBig <= 0n || fieldBig > MAX_FIELD_NUMBER) break;
    const field = Number(fieldBig);
    if (wire === 0) {
      try {
        const [num, next] = readVarint(buf, i);
        out.push({ field, wire, num });
        i = next;
      } catch {
        break;
      }
    } else if (wire === 2) {
      let lenBig: bigint;
      try {
        [lenBig, i] = readVarint(buf, i);
      } catch {
        break;
      }
      if (lenBig > BigInt(buf.length - i)) break;
      const len = Number(lenBig);
      out.push({ field, wire, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      if (i + 4 > buf.length) break;
      out.push({ field, wire });
      i += 4;
    } else if (wire === 1) {
      if (i + 8 > buf.length) break;
      out.push({ field, wire });
      i += 8;
    } else {
      break;
    }
  }
  return out;
}

function text(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function subfields(bytes: Uint8Array | undefined): ProtoField[] {
  return bytes ? parseFields(bytes) : [];
}

interface AntigravityToolCall {
  name?: string;
  args?: string;
}

interface AntigravityMessage {
  type: number;
  texts: string[];
  thinkings: string[];
  calls: AntigravityToolCall[];
}

function decodeMessage(bytes: Uint8Array): AntigravityMessage {
  const msg: AntigravityMessage = { type: -1, texts: [], thinkings: [], calls: [] };
  for (const f of parseFields(bytes)) {
    if (f.field === 2 && f.num !== undefined) {
      msg.type = Number(f.num);
    } else if (f.field === 3) {
      const t = text(f.bytes);
      if (t !== undefined) msg.texts.push(t);
    } else if (f.field === 6 && f.bytes) {
      // tool call: {1: call id, 2: name, 3: args json}
      let name: string | undefined;
      let args: string | undefined;
      for (const inner of subfields(f.bytes)) {
        if (inner.field === 2) name = text(inner.bytes) ?? name;
        if (inner.field === 3) args = text(inner.bytes) ?? args;
      }
      if (name !== undefined || args !== undefined) {
        msg.calls.push({ name, args });
      }
    } else if (f.field === 11) {
      const thought = text(f.bytes);
      if (thought !== undefined) msg.thinkings.push(thought);
    }
  }
  return msg;
}

const ROLE_BY_TYPE: Record<number, string> = { 1: "user", 2: "assistant", 4: "tool" };

function messageContent(msg: AntigravityMessage): string {
  const parts: string[] = [];
  for (const thought of msg.thinkings) {
    parts.push(`[thinking]\n${thought}`);
  }
  for (const call of msg.calls) {
    parts.push(`[tool call: ${call.name ?? "?"}]\n${call.args ?? ""}`);
  }
  parts.push(...msg.texts);
  return parts.join("\n\n");
}

function messageTimestamp(msg: AntigravityMessage): string | undefined {
  // Tool results embed "Created At: 2026-11-20T12:30:02+08:00" in their text.
  for (const t of msg.texts) {
    const match = /^Created At: (\S+)/m.exec(t);
    if (match) {
      const ms = Date.parse(match[1]);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  return undefined;
}

function looksLikeRequestBody(candidateField: number, inner: ProtoField[]): boolean {
  // Named prompt sections: f16 { 1: name?, 2: text }
  const hasNamedSection = inner.some(
    (f) =>
      f.field === 16 &&
      f.wire === 2 &&
      f.bytes !== undefined &&
      subfields(f.bytes).some((s) => s.field === 2 && s.wire === 2 && text(s.bytes) !== undefined),
  );
  if (hasNamedSection) return true;

  // Conversation messages: f2 { 2: roleType (1|2|4), ... }
  const hasMessage = inner.some(
    (f) =>
      f.field === 2 &&
      f.wire === 2 &&
      f.bytes !== undefined &&
      subfields(f.bytes).some(
        (s) =>
          s.field === 2 &&
          s.wire === 0 &&
          s.num !== undefined &&
          Object.hasOwn(ROLE_BY_TYPE, Number(s.num)),
      ),
  );
  if (hasMessage) return true;

  // Fallback concatenated system prompt in f1 alongside model metadata (f19/f21).
  if (candidateField === 1) {
    const hasSystemPrompt = inner.some(
      (f) => f.field === 1 && f.wire === 2 && (text(f.bytes)?.length ?? 0) > 0,
    );
    const hasModel = inner.some(
      (f) =>
        (f.field === 19 || f.field === 21) && f.wire === 2 && (text(f.bytes)?.length ?? 0) > 0,
    );
    if (hasSystemPrompt && hasModel) return true;
  }

  return false;
}

/**
 * The outermost field list carries configuration and a field-1 serialized
 * request body. Pick the largest length-delimited field whose inner structure
 * matches a serialized request (named sections, messages, or f1+model).
 */
function requestBody(blob: Uint8Array): ProtoField[] | undefined {
  const candidates = parseFields(blob)
    .filter((f) => f.wire === 2 && (f.bytes?.length ?? 0) > 0)
    .sort((a, b) => (b.bytes?.length ?? 0) - (a.bytes?.length ?? 0));
  for (const candidate of candidates) {
    const inner = parseFields(candidate.bytes!);
    if (looksLikeRequestBody(candidate.field, inner)) {
      return inner;
    }
  }
  return undefined;
}

interface ParsedSnapshot {
  fingerprint: string;
  capturedAt: string;
  model?: string;
  sections: { name: string; text: string }[];
  tools?: string[];
  messages: NonNullable<ProviderPrompt["messages"]>;
  messageCount: number;
}

const snapshotCache = new Map<string, ParsedSnapshot>();
const usageCache = new Map<string, { fingerprint: string; records: UsageRecord[] }>();

function lruCacheSet<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

async function readDbFingerprintAndMtime(dbPath: string): Promise<{
  fingerprint: string;
  mtimeMs: number;
}> {
  const dbStat = await stat(dbPath);
  let mtimeMs = dbStat.mtimeMs;
  let walPart = "none";
  try {
    const walStat = await stat(`${dbPath}-wal`);
    if (walStat.mtimeMs > mtimeMs) mtimeMs = walStat.mtimeMs;
    walPart = `${walStat.ino}:${walStat.size}:${walStat.mtimeMs}:${walStat.ctimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const fingerprint = `${dbStat.ino}:${dbStat.size}:${dbStat.mtimeMs}:${dbStat.ctimeMs}|${walPart}`;
  return { fingerprint, mtimeMs };
}

/**
 * Antigravity (`agy`) persists one SQLite database per conversation under
 * `~/.gemini/antigravity-cli/conversations/<id>.db`. Its `gen_metadata` table
 * holds small per-request metadata rows plus a single large row containing
 * the serialized request: named prompt sections, the full message list
 * (user, assistant with tool calls and thinking, tool results), model
 * identity, and request metadata — all as embedded protobuf records.
 *
 * Only the latest request is stored, so `at` is validated but does not
 * select an older snapshot the way it does for pi/devin.
 */
export async function readAntigravityPrompt(options: {
  dbPath: string;
  at?: string;
  includeMessages?: boolean;
}): Promise<ProviderPrompt> {
  const { dbPath, at, includeMessages } = options;
  if (at !== undefined && !Number.isFinite(Date.parse(at))) {
    throw new Error(`invalid timestamp: ${at}`);
  }
  if (!existsSync(dbPath)) {
    throw new Error(`antigravity conversation db not found at ${dbPath}`);
  }

  const { fingerprint, mtimeMs } = await readDbFingerprintAndMtime(dbPath);
  let snapshot = snapshotCache.get(dbPath);
  if (snapshot && snapshot.fingerprint === fingerprint) {
    lruCacheSet(snapshotCache, dbPath, snapshot);
  } else {
    const blob = await readLargestGenMetadata(dbPath);
    const body = blob ? requestBody(blob) : undefined;
    if (!body) {
      throw new Error("antigravity conversation has no serialized request");
    }

    const sections: { name: string; text: string }[] = [];
    const tools = new Set<string>();
    const messages: NonNullable<ProviderPrompt["messages"]> = [];
    let modelId: string | undefined;
    let modelName: string | undefined;
    let messageCount = 0;

    for (const f of body) {
      if (f.field === 2 && f.bytes) {
        messageCount += 1;
        const msg = decodeMessage(f.bytes);
        for (const call of msg.calls) {
          if (call.name) tools.add(call.name);
        }
        const role = ROLE_BY_TYPE[msg.type] ?? `type-${msg.type}`;
        messages.push({ role, content: messageContent(msg), at: messageTimestamp(msg) });
      } else if (f.field === 16 && f.bytes) {
        // named prompt section: {1: name, 2: text}
        let name: string | undefined;
        let bodyText: string | undefined;
        for (const inner of subfields(f.bytes)) {
          if (inner.field === 1) name = text(inner.bytes) ?? name;
          if (inner.field === 2) bodyText = text(inner.bytes) ?? bodyText;
        }
        if (bodyText !== undefined) {
          sections.push({ name: name ?? `section ${sections.length + 1}`, text: bodyText });
        }
      } else if (f.field === 19) {
        modelId = text(f.bytes) ?? modelId;
      } else if (f.field === 21) {
        modelName = text(f.bytes) ?? modelName;
      }
    }

    if (sections.length === 0) {
      // Fallback: the body may only carry the concatenated prompt as field 1.
      const combined = body
        .filter((f) => f.field === 1)
        .map((f) => text(f.bytes))
        .find((t): t is string => typeof t === "string" && t.length > 0);
      if (combined) sections.push({ name: "system", text: combined });
    }

    const observedTools = [...tools].sort();
    snapshot = {
      fingerprint,
      capturedAt: new Date(mtimeMs).toISOString(),
      model: modelName ?? modelId,
      sections,
      tools: observedTools.length > 0 ? observedTools : undefined,
      messages,
      messageCount,
    };
    lruCacheSet(snapshotCache, dbPath, snapshot);
  }

  return {
    capturedAt: snapshot.capturedAt,
    model: snapshot.model,
    sections: snapshot.sections.map((section) => ({ ...section })),
    tools: snapshot.tools ? [...snapshot.tools] : undefined,
    toolsKind: snapshot.tools ? "observed" : undefined,
    latestOnly: true,
    messages: includeMessages ? snapshot.messages.map((message) => ({ ...message })) : undefined,
    messageCount: snapshot.messageCount,
    source: { kind: "antigravity-db", path: dbPath },
  };
}

function toSafeNonNegInt(value: bigint | undefined): number | undefined {
  if (value === undefined || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(value);
}

function normalizePrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 160) : undefined;
}

function decodeProtoTimestamp(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined;
  let seconds: number | undefined;
  let nanos = 0;
  for (const f of parseFields(bytes)) {
    if (f.field === 1 && f.wire === 0) seconds = toSafeNonNegInt(f.num);
    else if (f.field === 2 && f.wire === 0) nanos = toSafeNonNegInt(f.num) ?? 0;
  }
  if (seconds === undefined) return undefined;
  const ms = seconds * 1000 + Math.floor(nanos / 1_000_000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function decodeAntigravityUsageStep(
  metaBuf: Buffer | undefined,
  payloadBuf: Buffer | undefined,
): UsageRecord | undefined {
  const payloadFields = payloadBuf ? parseFields(payloadBuf) : [];
  let effectiveMeta = metaBuf ? parseFields(metaBuf) : [];
  if (effectiveMeta.length === 0) {
    const embeddedMeta = payloadFields.find((f) => f.field === 5 && f.wire === 2)?.bytes;
    if (embeddedMeta) effectiveMeta = parseFields(embeddedMeta);
  }

  let at: string | undefined;
  let usageFieldBytes: Uint8Array | undefined;
  for (const f of effectiveMeta) {
    if (f.field === 1 && f.wire === 2 && !at) {
      at = decodeProtoTimestamp(f.bytes);
    } else if (f.field === 9 && f.wire === 2 && !usageFieldBytes) {
      usageFieldBytes = f.bytes;
    }
  }
  if (!usageFieldBytes) return undefined;

  let uncachedInput: number | undefined;
  let outputTokens: number | undefined;
  let cachedInput: number | undefined;
  for (const uf of parseFields(usageFieldBytes)) {
    if (uf.wire !== 0) continue;
    if (uf.field === 2) uncachedInput = toSafeNonNegInt(uf.num);
    else if (uf.field === 3) outputTokens = toSafeNonNegInt(uf.num);
    else if (uf.field === 5) cachedInput = toSafeNonNegInt(uf.num);
  }
  if (uncachedInput === undefined && outputTokens === undefined && cachedInput === undefined) {
    return undefined;
  }

  const inputTokens = (uncachedInput ?? 0) + (cachedInput ?? 0);
  const cachedInputTokens = cachedInput ?? 0;

  let messageId: string | undefined;
  let textPrefix: string | undefined;
  let thinkingPrefix: string | undefined;
  const callIds: string[] = [];

  const plannerBytes = payloadFields.find((f) => f.field === 20 && f.wire === 2)?.bytes;
  if (plannerBytes) {
    for (const pf of parseFields(plannerBytes)) {
      if (pf.wire !== 2) continue;
      if ((pf.field === 1 || pf.field === 8) && !textPrefix) {
        textPrefix = normalizePrefix(text(pf.bytes));
      } else if (pf.field === 3 && !thinkingPrefix) {
        thinkingPrefix = normalizePrefix(text(pf.bytes));
      } else if (pf.field === 6 && !messageId) {
        messageId = text(pf.bytes);
      } else if (pf.field === 7 && pf.bytes) {
        for (const cf of parseFields(pf.bytes)) {
          if (cf.field === 1 && cf.wire === 2) {
            const callId = text(cf.bytes);
            if (callId) callIds.push(callId);
            break;
          }
        }
      }
    }
  }

  return {
    at,
    messageId,
    callIds: callIds.length > 0 ? callIds : undefined,
    textPrefix,
    thinkingPrefix,
    usage: {
      inputTokens,
      cachedInputTokens,
      outputTokens: outputTokens ?? 0,
    },
  };
}

/**
 * Extract per-LLM-generation token usage records from an Antigravity
 * conversation database's `steps` table (`step_type = 15`, planner responses).
 */
export async function readAntigravityUsage(dbPath: string): Promise<UsageRecord[]> {
  if (!existsSync(dbPath)) {
    throw new Error(`antigravity conversation db not found at ${dbPath}`);
  }
  const { fingerprint } = await readDbFingerprintAndMtime(dbPath);
  const cached = usageCache.get(dbPath);
  if (cached && cached.fingerprint === fingerprint) {
    lruCacheSet(usageCache, dbPath, cached);
    return cached.records.map((record) => ({
      ...record,
      callIds: record.callIds ? [...record.callIds] : undefined,
      usage: { ...record.usage },
    }));
  }

  const rows = await readPlannerSteps(dbPath);
  const records: UsageRecord[] = [];
  for (const row of rows) {
    const metaBuf = row.meta_hex ? Buffer.from(row.meta_hex, "hex") : undefined;
    const payloadBuf = row.payload_hex ? Buffer.from(row.payload_hex, "hex") : undefined;
    const decoded = decodeAntigravityUsageStep(metaBuf, payloadBuf);
    if (decoded) records.push(decoded);
  }

  lruCacheSet(usageCache, dbPath, { fingerprint, records });
  return records.map((record) => ({
    ...record,
    callIds: record.callIds ? [...record.callIds] : undefined,
    usage: { ...record.usage },
  }));
}

function sanitizeConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    return undefined;
  }
  if (!SAFE_CONVERSATION_ID.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Plugin-provider agents encode persistence as `plugin:{"version":1,"data":
 * {"conversationId":"…"}}` in sessionId and mirror the raw object in
 * `metadata.pluginProviderPersistence`. Both resolve to the conversation id;
 * a bare UUID handle is accepted as a fallback.
 */
export function resolveAntigravityConversationId(
  nativeHandle: string | undefined,
  sessionId: string | undefined,
  metadata: unknown,
): string | undefined {
  const fromMeta = (metadata as { pluginProviderPersistence?: { data?: unknown } } | undefined)
    ?.pluginProviderPersistence?.data;
  const fromData = sanitizeConversationId(
    (fromMeta as { conversationId?: unknown } | undefined)?.conversationId,
  );
  if (fromData) return fromData;

  for (const handle of [nativeHandle, sessionId]) {
    if (!handle) continue;
    const trimmed = handle.trim();
    const raw = (trimmed.startsWith("plugin:") ? trimmed.slice("plugin:".length) : trimmed).trim();
    if (UUID_RE.test(raw)) {
      return raw;
    }
    try {
      const parsed = JSON.parse(raw) as { data?: { conversationId?: unknown } };
      const parsedId = sanitizeConversationId(parsed?.data?.conversationId);
      if (parsedId) return parsedId;
    } catch {
      // not a JSON handle
    }
  }
  return undefined;
}

export function antigravityConversationDbPath(
  conversationId: string,
  root = join(homedir(), ".gemini", "antigravity-cli", "conversations"),
): string {
  const safeId = sanitizeConversationId(conversationId);
  if (!safeId) {
    throw new Error(`invalid antigravity conversation id: ${conversationId}`);
  }
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, `${safeId}.db`);
  const rel = relative(resolvedRoot, candidate);
  if (!rel || rel.startsWith("..") || rel.includes("/") || rel.includes("\\")) {
    throw new Error(`invalid antigravity conversation id: ${conversationId}`);
  }
  return candidate;
}

/**
 * The conversation DBs are WAL-mode; a plain `sqlite3 -readonly` open fails
 * with CANTOPEN while Antigravity is writing. Copy db + wal aside (omitting
 * -shm so SQLite reconstructs a consistent WAL index from -wal) and query
 * the snapshot normally.
 */
async function withAntigravityDbCopy<T>(dbPath: string, query: (copyPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "turnline-agy-"));
  try {
    const copy = join(dir, "conversation.db");
    await copyFile(dbPath, copy);
    try {
      await copyFile(`${dbPath}-wal`, `${copy}-wal`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    return await query(copy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readLargestGenMetadata(dbPath: string): Promise<Buffer | undefined> {
  return withAntigravityDbCopy(dbPath, async (copy) => {
    const { stdout } = await execCommand(
      "sqlite3",
      ["-json", copy, `SELECT hex(data) AS hex FROM gen_metadata ORDER BY length(data) DESC LIMIT 1`],
      { timeout: 30_000, maxBuffer: 96 * 1024 * 1024 },
    );
    const rows = JSON.parse(stdout.trim() || "[]") as { hex?: string }[];
    const hex = rows[0]?.hex;
    return hex ? Buffer.from(hex, "hex") : undefined;
  });
}

async function readPlannerSteps(
  dbPath: string,
): Promise<{ meta_hex?: string | null; payload_hex?: string | null }[]> {
  return withAntigravityDbCopy(dbPath, async (copy) => {
    try {
      const { stdout } = await execCommand(
        "sqlite3",
        [
          "-json",
          copy,
          `SELECT hex(metadata) AS meta_hex, hex(step_payload) AS payload_hex FROM steps WHERE step_type = 15 ORDER BY idx`,
        ],
        { timeout: 30_000, maxBuffer: 96 * 1024 * 1024 },
      );
      return JSON.parse(stdout.trim() || "[]") as {
        meta_hex?: string | null;
        payload_hex?: string | null;
      }[];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no such table:\s*steps/i.test(msg)) return [];
      throw error;
    }
  });
}
