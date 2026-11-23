import { lstatSync, statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { z } from "zod";
import type { providerPromptSchema } from "../../shared/prompt";
import type { UsageRecord } from "../../shared/usage";

type ProviderPrompt = z.infer<typeof providerPromptSchema>;
type PromptSection = ProviderPrompt["sections"][number];

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;
const PROJECT_DIR_LENGTH_CAP = 200;
const MAX_PATH_CACHE_ENTRIES = 64;
const MAX_READ_CACHE_ENTRIES = 32;

const claudeFallbackPathCache = new Map<string, string>();
const claudePromptCache = new Map<string, { fingerprint: string; prompt: ProviderPrompt }>();
const claudeUsageCache = new Map<string, { fingerprint: string; records: UsageRecord[] }>();

interface ClaudeUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

interface ClaudeMessage {
  id?: unknown;
  role?: unknown;
  model?: unknown;
  content?: unknown;
  usage?: ClaudeUsage;
}

interface ClaudeEntry {
  type?: unknown;
  subtype?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  costUSD?: unknown;
  content?: unknown;
  summary?: unknown;
  message?: ClaudeMessage;
  shapeHash?: unknown;
  shape?: {
    system?: unknown;
    tools?: unknown;
  };
  params?: {
    model?: unknown;
  };
  attachment?: {
    type?: unknown;
    cliPrefix?: unknown;
    systemPrompt?: unknown;
    tools?: unknown;
  };
  renderedRole?: unknown;
  rendered?: unknown;
}

export function defaultClaudeProjectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(configDir || join(homedir(), ".claude"), "projects");
}

/**
 * Claude Code stores session transcripts under
 * `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd-slug>/<sessionId>.jsonl`.
 */
export async function resolveClaudeSessionFile(
  nativeHandle: string | undefined,
  sessionId: string | undefined,
  cwd: string | undefined,
  projectsRoot = defaultClaudeProjectsRoot(),
): Promise<string | undefined> {
  const trimmedHandle = nonEmptyString(nativeHandle);
  const trimmedSessionId = nonEmptyString(sessionId);

  if (trimmedHandle?.endsWith(".jsonl")) {
    if (isAbsolute(trimmedHandle) && !hasTraversalSegment(trimmedHandle) && isRegularFile(trimmedHandle)) {
      return trimmedHandle;
    }
    if (!trimmedSessionId) return undefined;
  }
  const id =
    trimmedSessionId ||
    (trimmedHandle && !trimmedHandle.endsWith(".jsonl") ? trimmedHandle : undefined);
  if (!id || id === "." || id === ".." || id.includes("..") || !SAFE_SESSION_ID.test(id)) {
    return undefined;
  }

  const filename = `${id}.jsonl`;
  if (cwd) {
    const slugs = new Set<string>();
    const normalized = normalizeProjectPath(cwd);
    slugs.add(encodeClaudeProjectSlug(normalized));
    try {
      const canonical = normalizeProjectPath(await realpath(cwd));
      slugs.add(encodeClaudeProjectSlug(canonical));
    } catch {
      // cwd may no longer exist on disk
    }
    for (const slug of slugs) {
      const candidate = join(projectsRoot, slug, filename);
      if (isNonSymlinkRegularFile(candidate)) return candidate;
    }
  }

  const cacheKey = `${projectsRoot}\0${id}`;
  const cached = claudeFallbackPathCache.get(cacheKey);
  if (cached) {
    if (isNonSymlinkRegularFile(cached)) {
      lruCacheSet(claudeFallbackPathCache, cacheKey, cached, MAX_PATH_CACHE_ENTRIES);
      return cached;
    }
    claudeFallbackPathCache.delete(cacheKey);
  }

  try {
    const dirs = await readdir(projectsRoot, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const candidate = join(projectsRoot, dir.name, filename);
      if (isNonSymlinkRegularFile(candidate)) {
        lruCacheSet(claudeFallbackPathCache, cacheKey, candidate, MAX_PATH_CACHE_ENTRIES);
        return candidate;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Replay a Claude Code JSONL transcript up to `at` (or latest) to extract
 * effective prompt sections, declared/observed tools, model, and conversation
 * context messages.
 *
 * Modern Claude Code transcripts include `api-request-shape` / `api-request`
 * records and `prompt_snapshot` / system `attachment` records carrying the exact
 * system prompt and declared tool list. Older transcripts without request
 * journals fall back gracefully to system entries, model metadata, observed
 * tool calls, and the user/assistant message chain.
 */
export async function readClaudePrompt(options: {
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
  const cached = claudePromptCache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) {
    lruCacheSet(claudePromptCache, cacheKey, cached, MAX_READ_CACHE_ENTRIES);
    return cloneProviderPrompt(cached.prompt);
  }

  const raw = await readFile(sessionFile, "utf8");
  const shapes = new Map<string, { sections: PromptSection[]; tools: string[] }>();

  let latestShapeSections: PromptSection[] | undefined;
  let latestShapeTools: string[] | undefined;
  let latestShapeOrder = -1;
  let latestShapeToolsOrder = -1;

  let latestSnapshotSections: PromptSection[] | undefined;
  let latestSnapshotTools: string[] | undefined;
  let latestSnapshotOrder = -1;
  let latestSnapshotToolsOrder = -1;

  const attachmentSections = new Map<string, string>();
  const fallbackSystemSections: PromptSection[] = [];
  const observedTools = new Set<string>();
  const messages: NonNullable<ProviderPrompt["messages"]> = [];
  const assistantIndexById = new Map<string, number>();

  let model: string | undefined;
  let capturedAt: string | undefined;
  let messageCount = 0;
  let lineOrder = 0;

  const inRange = (timestamp: unknown): boolean => {
    if (atMs === undefined) return true;
    const ms = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    return Number.isFinite(ms) && ms <= atMs;
  };

  for (const line of raw.split("\n")) {
    lineOrder += 1;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const entry = parsed as ClaudeEntry;
    if (entry.isSidechain === true || entry.isApiErrorMessage === true) continue;

    const entryType = typeof entry.type === "string" ? entry.type : undefined;
    if (!entryType) continue;

    if (entryType === "api-request-shape") {
      const shapeHash = typeof entry.shapeHash === "string" && entry.shapeHash ? entry.shapeHash : undefined;
      if (shapeHash && isRecord(entry.shape)) {
        const parsedShape = parseRequestShape(entry.shape);
        shapes.set(shapeHash, parsedShape);
        // If no api-request has referenced a shape yet and this shape is in range,
        // keep it as a baseline so truncated logs still show its prompt/tools.
        if (latestShapeOrder < 0 && inRange(entry.timestamp)) {
          if (parsedShape.sections.length > 0) {
            latestShapeSections = parsedShape.sections;
            latestShapeOrder = lineOrder;
          }
          if (parsedShape.tools.length > 0) {
            latestShapeTools = parsedShape.tools;
            latestShapeToolsOrder = lineOrder;
          }
          capturedAt = validIso(entry.timestamp) ?? capturedAt;
        }
      }
      continue;
    }

    if (!inRange(entry.timestamp)) continue;
    const ts = validIso(entry.timestamp);

    switch (entryType) {
      case "api-request": {
        const shapeHash = typeof entry.shapeHash === "string" ? entry.shapeHash : undefined;
        const shape = shapeHash ? shapes.get(shapeHash) : undefined;
        if (shape) {
          if (shape.sections.length > 0) {
            latestShapeSections = shape.sections;
            latestShapeOrder = lineOrder;
          }
          if (shape.tools.length > 0) {
            latestShapeTools = shape.tools;
            latestShapeToolsOrder = lineOrder;
          }
        }
        const reqModel = validModel(entry.params?.model);
        if (reqModel) model = reqModel;
        capturedAt = ts ?? capturedAt;
        break;
      }

      case "attachment": {
        const att = isRecord(entry.attachment) ? entry.attachment : undefined;
        const attType = typeof att?.type === "string" ? att.type : undefined;
        if (att && attType === "prompt_snapshot") {
          const snapSections = parsePromptSnapshotSections(att);
          if (snapSections.length > 0) {
            latestSnapshotSections = snapSections;
            latestSnapshotOrder = lineOrder;
          }
          const snapTools = extractDeclaredToolNames(att.tools);
          if (snapTools.length > 0) {
            latestSnapshotTools = snapTools;
            latestSnapshotToolsOrder = lineOrder;
          }
          capturedAt = ts ?? capturedAt;
        } else if (entry.renderedRole === "system") {
          const renderedText = extractRenderedAttachmentText(entry.rendered);
          if (renderedText) {
            const key = attType || "system-attachment";
            attachmentSections.set(key, renderedText);
            capturedAt = ts ?? capturedAt;
          }
        }
        break;
      }

      case "system": {
        const text = extractSystemEntryText(entry);
        if (text) {
          const name =
            typeof entry.subtype === "string" && entry.subtype.trim()
              ? entry.subtype.trim()
              : "system";
          fallbackSystemSections.push({ name, text });
          messageCount += 1;
          if (includeMessages) {
            messages.push({ role: "system", content: text, at: ts });
          }
          capturedAt = ts ?? capturedAt;
        }
        break;
      }

      case "summary": {
        const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
        if (summary) {
          messageCount += 1;
          if (includeMessages) {
            messages.push({ role: "system", content: `[compaction summary]\n${summary}`, at: ts });
          }
          capturedAt = ts ?? capturedAt;
        }
        break;
      }

      case "user": {
        const msg = isRecord(entry.message) ? (entry.message as ClaudeMessage) : undefined;
        if (!msg) break;
        const content = serializeClaudeContent(msg.content);
        if (!content) break;
        messageCount += 1;
        if (includeMessages) {
          messages.push({ role: "user", content, at: ts });
        }
        capturedAt = ts ?? capturedAt;
        break;
      }

      case "assistant": {
        const msg = isRecord(entry.message) ? (entry.message as ClaudeMessage) : undefined;
        if (!msg) break;
        const msgModel = validModel(msg.model);
        if (msgModel) model = msgModel;
        collectObservedToolNames(msg.content, observedTools);

        const content = serializeClaudeContent(msg.content);
        const msgId = typeof msg.id === "string" && msg.id ? msg.id : undefined;

        if (content) {
          if (msgId !== undefined && assistantIndexById.has(msgId)) {
            const idx = assistantIndexById.get(msgId)!;
            if (includeMessages && messages[idx]) {
              messages[idx] = {
                ...messages[idx],
                content: `${messages[idx].content}\n\n${content}`,
                at: ts ?? messages[idx].at,
              };
            }
          } else {
            const nextIdx = includeMessages ? messages.length : messageCount;
            messageCount += 1;
            if (includeMessages) {
              messages.push({ role: "assistant", content, at: ts });
            }
            if (msgId !== undefined) {
              assistantIndexById.set(msgId, nextIdx);
            }
          }
        }
        capturedAt = ts ?? capturedAt;
        break;
      }

      default:
        break;
    }
  }

  const coreSections = chooseCoreSections(
    latestShapeSections,
    latestShapeOrder,
    latestSnapshotSections,
    latestSnapshotOrder,
  );

  const sections: PromptSection[] = [];
  const seenTexts = new Set<string>();
  const pushSection = (section: PromptSection) => {
    const trimmed = section.text.trim();
    if (!trimmed) return;
    const norm = normalizeForCompare(trimmed);
    if (seenTexts.has(norm)) return;
    seenTexts.add(norm);
    sections.push({ name: section.name, text: section.text });
  };

  for (const s of coreSections) pushSection(s);
  for (const [name, text] of attachmentSections) {
    pushSection({ name, text });
  }
  if (sections.length === 0) {
    for (const s of fallbackSystemSections) pushSection(s);
  }

  let tools: string[] | undefined;
  let toolsKind: ProviderPrompt["toolsKind"];
  if (latestShapeTools?.length || latestSnapshotTools?.length) {
    tools =
      latestSnapshotToolsOrder >= latestShapeToolsOrder && latestSnapshotTools?.length
        ? latestSnapshotTools
        : latestShapeTools?.length
          ? latestShapeTools
          : latestSnapshotTools;
    toolsKind = "declared";
  } else if (observedTools.size > 0) {
    tools = [...observedTools];
    toolsKind = "observed";
  }

  const result: ProviderPrompt = {
    capturedAt,
    model,
    sections,
    tools,
    toolsKind,
    messages: includeMessages ? messages : undefined,
    messageCount,
    source: { kind: "claude-session", path: sessionFile },
  };
  lruCacheSet(claudePromptCache, cacheKey, { fingerprint, prompt: result }, MAX_READ_CACHE_ENTRIES);
  return cloneProviderPrompt(result);
}

/**
 * Extract per-LLM-call token usage records from a Claude Code JSONL transcript.
 * Claude emits multiple JSONL lines per assistant `message.id` (e.g., thinking
 * block followed by tool_use or text blocks); lines sharing the same message id
 * are merged into one UsageRecord carrying all callIds and the latest usage.
 */
export async function readClaudeUsage(sessionFile: string): Promise<UsageRecord[]> {
  const fingerprint = await readFileFingerprint(sessionFile);
  const cached = claudeUsageCache.get(sessionFile);
  if (cached && cached.fingerprint === fingerprint) {
    lruCacheSet(claudeUsageCache, sessionFile, cached, MAX_READ_CACHE_ENTRIES);
    return cloneUsageRecords(cached.records);
  }

  const raw = await readFile(sessionFile, "utf8");
  const records: UsageRecord[] = [];
  const indexByMessageId = new Map<string, number>();

  for (const line of raw.split("\n")) {
    if (!line.trim() || !line.includes('"assistant"')) continue;
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
    if (entry.isSidechain === true || entry.isApiErrorMessage === true) continue;
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
    if (msg.model === "<synthetic>" && inputTokens === 0 && outputTokens === 0) {
      continue;
    }
    const hasCacheField = "cache_read_input_tokens" in u;
    const costUsd = finiteNonNeg(entry.costUSD);

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
        const mergedCostUsd =
          costUsd !== undefined
            ? Math.max(existing.usage.costUsd ?? 0, costUsd)
            : existing.usage.costUsd;
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
            ...(mergedCostUsd !== undefined ? { costUsd: mergedCostUsd } : {}),
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
        ...(costUsd !== undefined ? { costUsd } : {}),
      },
    });
  }

  lruCacheSet(claudeUsageCache, sessionFile, { fingerprint, records }, MAX_READ_CACHE_ENTRIES);
  return cloneUsageRecords(records);
}

function chooseCoreSections(
  shapeSections: PromptSection[] | undefined,
  shapeOrder: number,
  snapshotSections: PromptSection[] | undefined,
  snapshotOrder: number,
): PromptSection[] {
  const hasShape = Boolean(shapeSections && shapeSections.length > 0);
  const hasSnapshot = Boolean(snapshotSections && snapshotSections.length > 0);
  if (!hasShape && !hasSnapshot) return [];
  if (hasShape && !hasSnapshot) return shapeSections!;
  if (!hasShape && hasSnapshot) return snapshotSections!;

  // When both exist, prefer prompt_snapshot if it is newer OR if it represents
  // the same system prompt broken into finer-grained sections.
  if (snapshotOrder >= shapeOrder) return snapshotSections!;
  if (
    snapshotSections!.length > shapeSections!.length &&
    normalizeSectionsText(snapshotSections!) === normalizeSectionsText(shapeSections!)
  ) {
    return snapshotSections!;
  }
  return shapeSections!;
}

function parseRequestShape(shape: { system?: unknown; tools?: unknown }): {
  sections: PromptSection[];
  tools: string[];
} {
  const rawParts: string[] = [];
  if (typeof shape.system === "string" && shape.system.trim()) {
    rawParts.push(shape.system);
  } else if (Array.isArray(shape.system)) {
    for (const part of shape.system) {
      if (typeof part === "string" && part.trim()) {
        rawParts.push(part);
      } else if (isRecord(part) && typeof part.text === "string" && part.text.trim()) {
        rawParts.push(part.text);
      }
    }
  }
  return {
    sections: labelSections(rawParts),
    tools: extractDeclaredToolNames(shape.tools),
  };
}

function parsePromptSnapshotSections(att: Record<string, unknown>): PromptSection[] {
  const sections: PromptSection[] = [];
  const usedNames = new Map<string, number>();

  if (typeof att.cliPrefix === "string" && att.cliPrefix.trim()) {
    sections.push({ name: "cli-prefix", text: att.cliPrefix });
    usedNames.set("cli-prefix", 1);
  }

  const rawParts: string[] = [];
  if (typeof att.systemPrompt === "string" && att.systemPrompt.trim()) {
    rawParts.push(att.systemPrompt);
  } else if (Array.isArray(att.systemPrompt)) {
    for (const part of att.systemPrompt) {
      if (typeof part === "string" && part.trim()) {
        rawParts.push(part);
      } else if (isRecord(part) && typeof part.text === "string" && part.text.trim()) {
        rawParts.push(part.text);
      }
    }
  }

  for (const section of labelSections(rawParts, usedNames)) {
    sections.push(section);
  }
  return sections;
}

function labelSections(
  parts: string[],
  usedNames = new Map<string, number>(),
): PromptSection[] {
  const nonEmpty = parts.filter((p) => p.trim().length > 0);
  const unnamedCount = nonEmpty.filter((p) => !extractLeadingHeading(p)).length;
  let unnamedIndex = 0;

  return nonEmpty.map((text) => {
    const heading = extractLeadingHeading(text);
    let baseName: string;
    if (heading) {
      baseName = heading;
    } else {
      unnamedIndex += 1;
      baseName = unnamedCount > 1 ? `system #${unnamedIndex}` : "system";
    }
    const prev = usedNames.get(baseName) ?? 0;
    usedNames.set(baseName, prev + 1);
    const name = prev > 0 ? `${baseName} #${prev + 1}` : baseName;
    return { name, text };
  });
}

function extractLeadingHeading(text: string): string | undefined {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^#{1,3}\s+(.+?)\s*#*$/.exec(line);
    if (match?.[1]) {
      const title = match[1].trim();
      if (title.length > 0) return title.slice(0, 64);
    }
    return undefined;
  }
  return undefined;
}

function extractDeclaredToolNames(rawTools: unknown): string[] {
  if (!Array.isArray(rawTools)) return [];
  const names = new Set<string>();
  for (const tool of rawTools) {
    if (typeof tool === "string" && tool.trim()) {
      names.add(tool.trim());
    } else if (isRecord(tool) && typeof tool.name === "string" && tool.name.trim()) {
      names.add(tool.name.trim());
    }
  }
  return [...names];
}

function extractRenderedAttachmentText(rendered: unknown): string | undefined {
  if (typeof rendered === "string") {
    const trimmed = rendered.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(rendered)) {
    const parts: string[] = [];
    for (const item of rendered) {
      if (typeof item === "string" && item.trim()) {
        parts.push(item.trim());
      } else if (isRecord(item)) {
        const text =
          typeof item.content === "string"
            ? item.content
            : typeof item.text === "string"
              ? item.text
              : undefined;
        if (text?.trim()) parts.push(text.trim());
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

function extractSystemEntryText(entry: ClaudeEntry): string | undefined {
  if (typeof entry.content === "string" && entry.content.trim()) {
    return entry.content.trim();
  }
  if (isRecord(entry.message)) {
    const serialized = serializeClaudeContent(entry.message.content).trim();
    if (serialized) return serialized;
  }
  return undefined;
}

function collectObservedToolNames(content: unknown, out: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_use" || block.type === "toolCall") {
      const name = typeof block.name === "string" ? block.name.trim() : "";
      if (name) out.add(name);
    }
  }
}

function serializeClaudeContent(content: unknown): string {
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
        case "thinking": {
          const text =
            typeof b.thinking === "string"
              ? b.thinking
              : typeof b.text === "string"
                ? b.text
                : "";
          return text ? `[thinking]\n${text}` : "";
        }
        case "tool_use":
        case "toolCall": {
          const args = b.input ?? b.arguments ?? b.args ?? {};
          const formattedArgs = typeof args === "string" ? args : JSON.stringify(args, null, 2);
          return `[tool call: ${String(b.name ?? b.toolName ?? "?")}]\n${formattedArgs}`;
        }
        case "tool_result":
        case "toolResult": {
          const body = serializeClaudeContent(b.content);
          return body ? `[tool result]\n${body}` : "[tool result]";
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

function normalizeProjectPath(input: string): string {
  return process.platform === "darwin" ? input.normalize("NFC") : input;
}

function encodeClaudeProjectSlug(input: string): string {
  const replaced = input.replace(/[^A-Za-z0-9]/g, "-");
  if (replaced.length <= PROJECT_DIR_LENGTH_CAP) {
    return replaced;
  }
  return `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${hashSuffix(input)}`;
}

function hashSuffix(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeSectionsText(sections: PromptSection[]): string {
  return normalizeForCompare(sections.map((s) => s.text).join("\n"));
}

function validModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "<synthetic>") return undefined;
  return trimmed;
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? value : undefined;
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

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
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
