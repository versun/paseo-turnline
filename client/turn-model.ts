import type { AgentTimelineItem, AgentUsage, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { ItemUsage, UsageRecord } from "../shared/usage";

export interface FeedEntry {
  /** Ordering key. History entries use their canonical seqStart; live items follow maxSeq. */
  seq: number;
  timestamp: string;
  turnId?: string;
  item: AgentTimelineItem;
}

export type TurnStatus = "running" | "completed" | "failed" | "canceled" | "open";
export type TurnKind = "turn" | "prompt" | "lead";
export type StatusFilter = "all" | "running" | "failed";

export interface Turn {
  key: string;
  agentId: string;
  kind: TurnKind;
  turnId?: string;
  status: TurnStatus;
  prompt?: string;
  startedAt?: string;
  endedAt?: string;
  firstSeq: number;
  items: FeedEntry[];
  usage?: AgentUsage;
  error?: string;
}

export interface TurnMeta {
  status?: "running" | "completed" | "failed" | "canceled";
  usage?: AgentUsage;
  error?: string;
}

export interface TurnSummary {
  promptTitle: string;
  replyPreview?: string;
  toolCount: number;
  failedToolCount: number;
  lastReplyIndex: number;
}

export interface TurnCounts {
  total: number;
  running: number;
  failed: number;
  tokensTotal?: number;
  costTotal?: number;
  cacheHitRate?: number;
}

export interface ItemUsageDisplay {
  usage: ItemUsage;
  /** True for user_message rows: only input tokens and cache hit rate apply. */
  inputOnly?: boolean;
}

export interface ResolvedTurnUsage {
  /** Turn-level usage (Paseo turnMeta enriched/backfilled from provider records). */
  turnUsage?: AgentUsage;
  /** Per-item usage keyed by index within `turn.items`. */
  itemUsages: Map<number, ItemUsageDisplay>;
}

export interface DayGroup {
  id: string;
  label: string;
  turns: Turn[];
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function itemIdentity(item: AgentTimelineItem): string | null {
  if (item.type === "tool_call" && item.callId) return `tool:${item.callId}`;
  if (item.type === "plugin" && item.id) return `plugin:${item.pluginId}/${item.id}`;
  return null;
}

export function stepKeyForEntry(entry: FeedEntry, index: number): string {
  return itemIdentity(entry.item) ?? `${entry.seq}:${index}`;
}

export function formatToolError(error: unknown): string | undefined {
  if (error == null) return undefined;
  if (typeof error === "string") return error.trim() || undefined;
  if (typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message.trim() || undefined;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

export function mergeUsage(base: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  const merged: AgentUsage = { ...base };
  for (const [key, value] of Object.entries(next) as [keyof AgentUsage, number | undefined][]) {
    if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
  }
  return merged;
}

/**
 * Group ordered entries into turns. When entries carry a provider turnId it is
 * the grouping key; providers that omit it (e.g. pi) are segmented by prompt —
 * each user_message opens a new group, and items before the first prompt form
 * a leading "activity" group.
 */
export function groupTurns(
  agentId: string,
  entries: FeedEntry[],
  meta: Map<string, TurnMeta>,
  agentRunning: boolean,
): Turn[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const turns: Turn[] = [];
  const seenKeys = new Map<string, number>();
  let current: Turn | undefined;

  for (const entry of sorted) {
    const turnId = entry.turnId || undefined;
    const isPrompt = entry.item.type === "user_message";
    if (
      !current ||
      (turnId !== undefined && turnId !== current.turnId) ||
      (turnId === undefined && isPrompt)
    ) {
      if (current) turns.push(current);
      const kind: TurnKind = turnId ? "turn" : isPrompt ? "prompt" : "lead";
      const baseKey = `${agentId}:${turnId ?? `${kind}:${entry.seq}`}`;
      const seen = seenKeys.get(baseKey) ?? 0;
      seenKeys.set(baseKey, seen + 1);
      current = {
        key: seen === 0 ? baseKey : `${baseKey}#${seen}`,
        agentId,
        kind,
        turnId,
        status: "open",
        firstSeq: entry.seq,
        items: [],
      };
    }
    current.items.push(entry);
  }
  if (current && current.items.length > 0) turns.push(current);

  const last = turns[turns.length - 1];
  for (const turn of turns) {
    const info = turn.turnId ? meta.get(turn.turnId) : undefined;
    const first = turn.items[0];
    const tail = turn.items[turn.items.length - 1];
    turn.startedAt = first?.timestamp;
    turn.endedAt = tail?.timestamp;
    const promptEntry = turn.items.find((e) => e.item.type === "user_message");
    turn.prompt = promptEntry?.item.type === "user_message" ? promptEntry.item.text : undefined;
    turn.usage = info?.usage;
    turn.error = info?.error;
    if (info?.status) {
      turn.status = info.status;
    } else if (turn === last && agentRunning) {
      turn.status = "running";
    } else if (turn.kind === "lead") {
      turn.status = "open";
    } else {
      turn.status = "completed";
    }
  }
  return turns;
}

export function sortTurns(turns: readonly Turn[], sort: "newest" | "oldest"): Turn[] {
  const sorted = [...turns].sort((a, b) => {
    const msA = a.startedAt ? Date.parse(a.startedAt) : NaN;
    const msB = b.startedAt ? Date.parse(b.startedAt) : NaN;
    const validA = Number.isFinite(msA);
    const validB = Number.isFinite(msB);
    if (validA && validB && msA !== msB) return msA - msB;
    if (validA !== validB) return validA ? 1 : -1;
    if (a.firstSeq !== b.firstSeq) return a.firstSeq - b.firstSeq;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  if (sort === "newest") sorted.reverse();
  return sorted;
}

export function computeTurnCounts(turns: readonly Turn[]): TurnCounts {
  let running = 0;
  let failed = 0;
  let tokensTotal = 0;
  let costTotal = 0;
  let hasTokens = false;
  let hasCost = false;
  let cacheInputTotal = 0;
  let cachedTotal = 0;
  let hasCacheStats = false;

  for (const t of turns) {
    if (t.status === "running") running += 1;
    if (t.status === "failed") failed += 1;
    const input = t.usage?.inputTokens;
    const output = t.usage?.outputTokens;
    const cached = t.usage?.cachedInputTokens;
    const validInput = typeof input === "number" && Number.isFinite(input) && input >= 0;
    const validOutput = typeof output === "number" && Number.isFinite(output) && output >= 0;
    const validCached = typeof cached === "number" && Number.isFinite(cached) && cached >= 0;
    if (validInput || validOutput) {
      hasTokens = true;
      tokensTotal += (validInput ? input : 0) + (validOutput ? output : 0);
    }
    if (validInput && input > 0 && validCached) {
      hasCacheStats = true;
      cacheInputTotal += input;
      cachedTotal += Math.min(input, cached);
    }
    const cost = t.usage?.totalCostUsd;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      hasCost = true;
      costTotal += cost;
    }
  }

  return {
    total: turns.length,
    running,
    failed,
    tokensTotal: hasTokens ? tokensTotal : undefined,
    costTotal: hasCost ? costTotal : undefined,
    cacheHitRate: hasCacheStats && cacheInputTotal > 0 ? cachedTotal / cacheInputTotal : undefined,
  };
}

export function filterTurns(
  turns: readonly Turn[],
  options: {
    statusFilter: StatusFilter;
    searchQuery: string;
    titleById: ReadonlyMap<string, string>;
  },
): Turn[] {
  const { statusFilter, searchQuery, titleById } = options;
  const trimmed = searchQuery.trim();
  return turns.filter((turn) => {
    if (statusFilter === "running" && turn.status !== "running") return false;
    if (statusFilter === "failed" && turn.status !== "failed") return false;
    if (trimmed.length > 0) {
      return turnMatchesQuery(turn, trimmed, titleById.get(turn.agentId));
    }
    return true;
  });
}

export function groupTurnsByDay(turns: readonly Turn[], now = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const turn of turns) {
    const day = formatDayHeading(turn.startedAt, now);
    const last = groups[groups.length - 1];
    if (!last || last.id !== day.id) {
      groups.push({ id: day.id, label: day.label, turns: [turn] });
    } else {
      last.turns.push(turn);
    }
  }
  return groups;
}

export function turnDurationMs(turn: Turn): number | null {
  if (!turn.startedAt || !turn.endedAt || turn.startedAt === turn.endedAt) return null;
  const ms = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  const roundedMs = Math.max(1, Math.round(ms));
  if (roundedMs < 1000) return `${roundedMs}ms`;
  const s = Math.round(roundedMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatHM(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatTimeOnly(iso: string | undefined): string {
  const d = parseDate(iso);
  return d ? formatHM(d) : "";
}

export function formatClock(iso: string | undefined, now = new Date()): string {
  const d = parseDate(iso);
  if (!d) return "";
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = formatHM(d);
  if (sameDay) return time;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
}

export function formatDayHeading(
  iso: string | undefined,
  now = new Date(),
): { id: string; label: string } {
  const d = parseDate(iso);
  if (!d) return { id: "earlier", label: "Earlier" };

  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const targetUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = (todayUtc - targetUtc) / 86_400_000;
  const id = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  if (diffDays === 0) return { id, label: "Today" };
  if (diffDays === 1) return { id, label: "Yesterday" };
  if (d.getFullYear() === now.getFullYear()) {
    return { id, label: `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}` };
  }
  return { id, label: `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` };
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return "—";
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/**
 * Compute prompt cache hit rate (`cachedInputTokens / inputTokens`) in `[0, 1]`.
 * Returns `null` when `inputTokens` is zero/missing or `cachedInputTokens` was
 * not reported by the provider.
 */
export function computeCacheHitRate(
  usage: { inputTokens?: number; cachedInputTokens?: number } | undefined,
): number | null {
  if (!usage) return null;
  const input = usage.inputTokens;
  const cached = usage.cachedInputTokens;
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input <= 0 ||
    typeof cached !== "number" ||
    !Number.isFinite(cached) ||
    cached < 0
  ) {
    return null;
  }
  return Math.min(1, cached / input);
}

export function formatCacheRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate < 0) return "";
  return `${Math.round(Math.min(1, rate) * 100)}%`;
}

export function formatItemUsageDetail(
  usage: ItemUsage,
  options?: { inputOnly?: boolean },
): string {
  const rate = computeCacheHitRate(usage);
  const parts: string[] = [];

  if (
    typeof usage.cachedInputTokens === "number" &&
    Number.isFinite(usage.cachedInputTokens) &&
    rate !== null
  ) {
    parts.push(
      `Input ${formatTokens(usage.inputTokens)} (${formatTokens(usage.cachedInputTokens)} cached · ${formatCacheRate(rate)} hit)`,
    );
  } else {
    parts.push(`Input ${formatTokens(usage.inputTokens)}`);
  }

  if (
    typeof usage.cacheWriteTokens === "number" &&
    Number.isFinite(usage.cacheWriteTokens) &&
    usage.cacheWriteTokens > 0
  ) {
    parts.push(`Write ${formatTokens(usage.cacheWriteTokens)}`);
  }

  if (!options?.inputOnly) {
    parts.push(`Output ${formatTokens(usage.outputTokens)}`);
  }

  if (!options?.inputOnly && usage.costUsd !== undefined) {
    const cost = formatCost(usage.costUsd);
    if (cost) parts.push(cost);
  }

  return parts.join(" · ");
}

function parseTimestampMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function normalizeMatchPrefix(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 160) : undefined;
}

function prefixMatches(entryText: string | undefined, recordPrefix: string | undefined): boolean {
  const a = normalizeMatchPrefix(entryText);
  if (!a || !recordPrefix) return false;
  return a.startsWith(recordPrefix) || recordPrefix.startsWith(a);
}

function agentUsageToItemUsage(usage: AgentUsage | undefined): ItemUsage | undefined {
  if (!usage) return undefined;
  const input =
    typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
      ? usage.inputTokens
      : undefined;
  const output =
    typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0
      ? usage.outputTokens
      : undefined;
  if (input === undefined && output === undefined) return undefined;
  const cached =
    typeof usage.cachedInputTokens === "number" &&
    Number.isFinite(usage.cachedInputTokens) &&
    usage.cachedInputTokens >= 0
      ? usage.cachedInputTokens
      : undefined;
  const costUsd =
    typeof usage.totalCostUsd === "number" && Number.isFinite(usage.totalCostUsd) && usage.totalCostUsd >= 0
      ? usage.totalCostUsd
      : undefined;
  return {
    inputTokens: input ?? 0,
    cachedInputTokens: cached,
    outputTokens: output ?? 0,
    costUsd,
  };
}

function sumProviderUsage(records: readonly UsageRecord[], indices: Iterable<number>): AgentUsage | undefined {
  let count = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let hasCached = false;
  let totalCostUsd = 0;
  let hasCost = false;

  for (const idx of indices) {
    const u = records[idx]?.usage;
    if (!u) continue;
    count += 1;
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    if (typeof u.cachedInputTokens === "number" && Number.isFinite(u.cachedInputTokens)) {
      hasCached = true;
      cachedInputTokens += u.cachedInputTokens;
    }
    if (typeof u.costUsd === "number" && Number.isFinite(u.costUsd)) {
      hasCost = true;
      totalCostUsd += u.costUsd;
    }
  }
  if (count === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(hasCached ? { cachedInputTokens } : {}),
    ...(hasCost ? { totalCostUsd } : {}),
  };
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mergeTurnUsageWithProvider(
  base: AgentUsage | undefined,
  providerSum: AgentUsage | undefined,
): AgentUsage | undefined {
  if (!providerSum) return base;
  if (!base) return providerSum;
  const baseInput = finiteNumber(base.inputTokens);
  const baseOutput = finiteNumber(base.outputTokens);
  const baseCached = finiteNumber(base.cachedInputTokens);
  const baseHasTokens = baseInput !== undefined || baseOutput !== undefined;
  const baseHasCached = baseCached !== undefined;
  const providerAtLeastAsComplete =
    (finiteNumber(providerSum.inputTokens) ?? 0) >= (baseInput ?? 0) &&
    (finiteNumber(providerSum.outputTokens) ?? 0) >= (baseOutput ?? 0);

  if (
    !baseHasTokens ||
    (!baseHasCached && providerSum.cachedInputTokens !== undefined && providerAtLeastAsComplete)
  ) {
    const cleanBase = mergeUsage(undefined, base);
    const merged: AgentUsage = {
      ...cleanBase,
      inputTokens: providerSum.inputTokens,
      outputTokens: providerSum.outputTokens,
    };
    if (providerSum.cachedInputTokens !== undefined) {
      merged.cachedInputTokens = providerSum.cachedInputTokens;
    }
    const totalCostUsd = finiteNumber(base.totalCostUsd) ?? providerSum.totalCostUsd;
    if (totalCostUsd !== undefined) {
      merged.totalCostUsd = totalCostUsd;
    }
    return merged;
  }
  return mergeUsage(providerSum, base);
}

/**
 * Attribute provider-native per-LLM-call `UsageRecord`s to each item inside
 * an agent's turns, and aggregate unique matched records back onto each turn
 * (backfilling historical turns and cache statistics when Paseo's timeline
 * does not carry them).
 */
export function assignUsageToTurns(
  turns: readonly Turn[],
  records: readonly UsageRecord[] | undefined,
): Map<string, ResolvedTurnUsage> {
  const result = new Map<string, ResolvedTurnUsage>();
  if (turns.length === 0) return result;

  if (!records || records.length === 0) {
    for (const turn of turns) {
      const itemUsages = new Map<number, ItemUsageDisplay>();
      const fallback = agentUsageToItemUsage(turn.usage);
      if (fallback) {
        let toolCount = 0;
        let replyCount = 0;
        let reasoningCount = 0;
        for (const entry of turn.items) {
          if (entry.item.type === "tool_call") toolCount += 1;
          else if (entry.item.type === "assistant_message") replyCount += 1;
          else if (entry.item.type === "reasoning") reasoningCount += 1;
        }
        // Single-LLM-call turn fallback: when there are no tool calls and at
        // most one reply/reasoning pair, the turn usage equals that call's usage.
        if (toolCount === 0 && replyCount <= 1 && reasoningCount <= 1) {
          turn.items.forEach((entry, idx) => {
            if (entry.item.type === "user_message") {
              itemUsages.set(idx, { usage: fallback, inputOnly: true });
            } else if (entry.item.type === "assistant_message" || entry.item.type === "reasoning") {
              itemUsages.set(idx, { usage: fallback });
            }
          });
        }
      }
      result.set(turn.key, { turnUsage: turn.usage, itemUsages });
    }
    return result;
  }

  const chronoTurns = sortTurns(turns, "oldest");
  const recordMs = records.map((r) => parseTimestampMs(r.at));
  const byCallId = new Map<string, number[]>();
  const byMessageId = new Map<string, number[]>();
  records.forEach((rec, idx) => {
    if (rec.messageId) {
      const list = byMessageId.get(rec.messageId);
      if (list) list.push(idx);
      else byMessageId.set(rec.messageId, [idx]);
    }
    if (rec.callIds) {
      for (const callId of rec.callIds) {
        const list = byCallId.get(callId);
        if (list) list.push(idx);
        else byCallId.set(callId, [idx]);
      }
    }
  });

  // Pass 1: exact ID matching across all turns so records are unambiguously owned.
  const matchedByTurn: Array<Map<number, number>> = chronoTurns.map(() => new Map());
  const recordOwnerTurn = new Map<number, number>();

  const pickPass1Record = (
    pool: readonly number[] | undefined,
    tIdx: number,
    entryMs: number | undefined,
  ): number | undefined => {
    if (!pool || pool.length === 0) return undefined;
    const eligible: number[] = [];
    for (const rIdx of pool) {
      const owner = recordOwnerTurn.get(rIdx);
      if (owner !== undefined && owner !== tIdx) continue;
      eligible.push(rIdx);
    }
    if (eligible.length === 0) return undefined;
    if (eligible.length === 1 || entryMs === undefined) return eligible[0];
    let best: number | undefined;
    let bestDiff = Infinity;
    for (const rIdx of eligible) {
      const ms = recordMs[rIdx];
      if (ms === undefined) {
        if (best === undefined) best = rIdx;
        continue;
      }
      const diff = Math.abs(ms - entryMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = rIdx;
      }
    }
    return best;
  };

  chronoTurns.forEach((turn, tIdx) => {
    turn.items.forEach((entry, iIdx) => {
      let recIdx: number | undefined;
      const entryMs = parseTimestampMs(entry.timestamp);
      if (entry.item.type === "tool_call" && entry.item.callId) {
        recIdx = pickPass1Record(byCallId.get(entry.item.callId), tIdx, entryMs);
      } else if (entry.item.type === "assistant_message" && entry.item.messageId) {
        recIdx = pickPass1Record(byMessageId.get(entry.item.messageId), tIdx, entryMs);
      }
      if (recIdx !== undefined) {
        matchedByTurn[tIdx].set(iIdx, recIdx);
        recordOwnerTurn.set(recIdx, tIdx);
      }
    });
  });

  const turnStarts = chronoTurns.map((t) => parseTimestampMs(t.startedAt));
  const turnEnds = chronoTurns.map((t, i) => parseTimestampMs(t.endedAt) ?? turnStarts[i]);
  const turnWindows = chronoTurns.map((_, tIdx) => {
    let winStart = turnStarts[tIdx] !== undefined ? turnStarts[tIdx]! - 5_000 : undefined;
    if (tIdx > 0 && winStart !== undefined && turnStarts[tIdx] !== undefined) {
      const prevEnd = turnEnds[tIdx - 1] ?? turnStarts[tIdx - 1];
      if (prevEnd !== undefined && prevEnd <= turnStarts[tIdx]!) {
        winStart = Math.max(winStart, prevEnd);
      }
    }
    const nextStart = turnStarts[tIdx + 1];
    const curEnd = turnEnds[tIdx];
    const winEnd =
      nextStart !== undefined
        ? curEnd !== undefined && nextStart <= curEnd
          ? nextStart
          : nextStart - 1
        : undefined;
    return { winStart, winEnd };
  });

  const getCandidates = (tIdx: number): number[] => {
    const { winStart, winEnd } = turnWindows[tIdx];
    const candidates: number[] = [];
    for (let rIdx = 0; rIdx < records.length; rIdx++) {
      const owner = recordOwnerTurn.get(rIdx);
      if (owner === tIdx) {
        candidates.push(rIdx);
        continue;
      }
      if (owner !== undefined) continue;
      const ms = recordMs[rIdx];
      if (ms === undefined) {
        candidates.push(rIdx);
      } else if (
        (winStart === undefined || ms >= winStart) &&
        (winEnd === undefined || ms <= winEnd)
      ) {
        candidates.push(rIdx);
      }
    }
    return candidates;
  };

  const pickClosest = (
    pool: readonly number[],
    entryMs: number | undefined,
    maxDiffMs?: number,
  ): number | undefined => {
    if (pool.length === 0) return undefined;
    if (entryMs === undefined) return pool[0];
    let best: number | undefined;
    let bestDiff = Infinity;
    for (const rIdx of pool) {
      const ms = recordMs[rIdx];
      if (ms === undefined) {
        if (best === undefined) best = rIdx;
        continue;
      }
      const diff = Math.abs(ms - entryMs);
      if (maxDiffMs !== undefined && diff > maxDiffMs) continue;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = rIdx;
      }
    }
    return best;
  };

  const claimedReplyRecordsByTurn = chronoTurns.map(() => new Set<number>());
  const claimedThinkingRecordsByTurn = chronoTurns.map(() => new Set<number>());
  chronoTurns.forEach((turn, tIdx) => {
    for (const [iIdx, rIdx] of matchedByTurn[tIdx]) {
      const type = turn.items[iIdx]?.item.type;
      if (type === "assistant_message") claimedReplyRecordsByTurn[tIdx].add(rIdx);
      else if (type === "reasoning") claimedThinkingRecordsByTurn[tIdx].add(rIdx);
    }
  });

  // Pass 2: content prefix matching across all turns before timestamp fallbacks or sweeps,
  // so shared-boundary / same-second turns claim their exact matches first.
  chronoTurns.forEach((turn, tIdx) => {
    const matched = matchedByTurn[tIdx];
    const candidates = getCandidates(tIdx);
    const claimedReplyRecords = claimedReplyRecordsByTurn[tIdx];
    const claimedThinkingRecords = claimedThinkingRecordsByTurn[tIdx];

    // Pass 2a: assistant_message textPrefix match
    turn.items.forEach((entry, iIdx) => {
      if (entry.item.type !== "assistant_message" || matched.has(iIdx)) return;
      const replyText = entry.item.text;
      const entryMs = parseTimestampMs(entry.timestamp);
      const textHits = candidates.filter((rIdx) => prefixMatches(replyText, records[rIdx].textPrefix));
      const unclaimedHits = textHits.filter((rIdx) => !claimedReplyRecords.has(rIdx));
      const picked = pickClosest(unclaimedHits.length > 0 ? unclaimedHits : textHits, entryMs);
      if (picked !== undefined) {
        matched.set(iIdx, picked);
        claimedReplyRecords.add(picked);
        recordOwnerTurn.set(picked, tIdx);
      }
    });

    // Pass 2b: reasoning thinkingPrefix match
    turn.items.forEach((entry, iIdx) => {
      if (entry.item.type !== "reasoning" || matched.has(iIdx)) return;
      const thoughtText = entry.item.text;
      const entryMs = parseTimestampMs(entry.timestamp);
      const hits = candidates.filter((rIdx) => prefixMatches(thoughtText, records[rIdx].thinkingPrefix));
      const unclaimedHits = hits.filter((rIdx) => !claimedThinkingRecords.has(rIdx));
      const picked = pickClosest(unclaimedHits.length > 0 ? unclaimedHits : hits, entryMs);
      if (picked !== undefined) {
        matched.set(iIdx, picked);
        claimedThinkingRecords.add(picked);
        recordOwnerTurn.set(picked, tIdx);
      }
    });
  });

  // Pass 3: timestamp proximity and structural adjacency across all turns.
  chronoTurns.forEach((turn, tIdx) => {
    const matched = matchedByTurn[tIdx];
    const candidates = getCandidates(tIdx);
    const claimedReplyRecords = claimedReplyRecordsByTurn[tIdx];

    // Pass 3a: unmatched assistant_message / tool_call by nearest candidate timestamp
    turn.items.forEach((entry, iIdx) => {
      if (matched.has(iIdx)) return;
      const item = entry.item;
      if (item.type !== "assistant_message" && item.type !== "tool_call") return;
      const entryMs = parseTimestampMs(entry.timestamp);
      const pool = candidates.filter((rIdx) => {
        const rec = records[rIdx];
        if (item.type === "assistant_message") {
          if (claimedReplyRecords.has(rIdx)) return false;
          if (item.messageId && rec.messageId && rec.messageId !== item.messageId) return false;
          return true;
        }
        if (
          item.callId &&
          rec.callIds &&
          rec.callIds.length > 0 &&
          !rec.callIds.includes(item.callId)
        ) {
          return false;
        }
        return true;
      });
      const picked = pickClosest(pool, entryMs, 60_000);
      if (picked !== undefined) {
        matched.set(iIdx, picked);
        if (item.type === "assistant_message") claimedReplyRecords.add(picked);
        recordOwnerTurn.set(picked, tIdx);
      }
    });

    // Pass 3b: unmatched reasoning inherits immediately following tool_call / assistant_message,
    // or falls back to closest candidate record in time.
    turn.items.forEach((entry, iIdx) => {
      if (entry.item.type !== "reasoning" || matched.has(iIdx)) return;
      const entryMs = parseTimestampMs(entry.timestamp);
      let inherited: number | undefined;
      for (let j = iIdx + 1; j < turn.items.length; j++) {
        const nextType = turn.items[j].item.type;
        if (nextType === "reasoning") continue;
        if (nextType === "tool_call" || nextType === "assistant_message") {
          const nextRec = matched.get(j);
          if (nextRec !== undefined) {
            const nextMs = parseTimestampMs(turn.items[j].timestamp);
            if (entryMs === undefined || nextMs === undefined || Math.abs(nextMs - entryMs) <= 60_000) {
              inherited = nextRec;
            }
          }
        }
        break;
      }
      const picked =
        inherited ?? pickClosest(candidates, entryMs, candidates.length === 1 ? undefined : 60_000);
      if (picked !== undefined) {
        matched.set(iIdx, picked);
        recordOwnerTurn.set(picked, tIdx);
      }
    });

    // Pass 3c: todo items inherit adjacent or closest LLM record in the turn.
    turn.items.forEach((entry, iIdx) => {
      if (entry.item.type !== "todo" || matched.has(iIdx)) return;
      const entryMs = parseTimestampMs(entry.timestamp);
      const picked = pickClosest(candidates, entryMs, candidates.length === 1 ? undefined : 60_000);
      if (picked !== undefined) {
        matched.set(iIdx, picked);
        recordOwnerTurn.set(picked, tIdx);
      }
    });
  });

  // Pass 4 & aggregation: user_message input attribution, unclaimed timespan sweep,
  // and turn-level usage rollup (runs after all turns have claimed Pass 1–3 matches).
  chronoTurns.forEach((turn, tIdx) => {
    const matched = matchedByTurn[tIdx];
    const candidates = getCandidates(tIdx);

    // Build ItemUsageDisplay map for this turn.
    const itemUsages = new Map<number, ItemUsageDisplay>();
    const uniqueRecordIndices = new Set<number>();
    for (const [iIdx, rIdx] of matched) {
      itemUsages.set(iIdx, { usage: records[rIdx].usage });
      uniqueRecordIndices.add(rIdx);
    }

    // Pass 4: user_message ("Prompt") shows the input tokens & cache hit rate
    // of the first LLM call triggered after it in this turn.
    turn.items.forEach((entry, iIdx) => {
      if (entry.item.type !== "user_message" || itemUsages.has(iIdx)) return;
      let firstCallRec: number | undefined;
      for (let j = iIdx + 1; j < turn.items.length; j++) {
        const rIdx = matched.get(j);
        if (rIdx !== undefined) {
          firstCallRec = rIdx;
          break;
        }
      }
      if (firstCallRec === undefined && candidates.length > 0) {
        const entryMs = parseTimestampMs(entry.timestamp);
        firstCallRec = candidates.find((rIdx) => {
          if (recordOwnerTurn.get(rIdx) !== undefined) return false;
          const ms = recordMs[rIdx];
          if (entryMs !== undefined && ms !== undefined) {
            return ms >= entryMs - 1_000;
          }
          return true;
        });
      }
      if (firstCallRec !== undefined) {
        itemUsages.set(iIdx, { usage: records[firstCallRec].usage, inputOnly: true });
        uniqueRecordIndices.add(firstCallRec);
        recordOwnerTurn.set(firstCallRec, tIdx);
      }
    });

    // Include any unclaimed records strictly within the turn's observed timespan
    // in the turn aggregate (in case a generation produced only collapsed/hidden items).
    if (turnStarts[tIdx] !== undefined && turnEnds[tIdx] !== undefined) {
      for (const rIdx of candidates) {
        const owner = recordOwnerTurn.get(rIdx);
        if (owner !== undefined && owner !== tIdx) continue;
        const ms = recordMs[rIdx];
        if (ms !== undefined && ms >= turnStarts[tIdx]! && ms <= turnEnds[tIdx]! + 2_000) {
          uniqueRecordIndices.add(rIdx);
          recordOwnerTurn.set(rIdx, tIdx);
        }
      }
    }

    const providerSum = sumProviderUsage(records, uniqueRecordIndices);
    const turnUsage = mergeTurnUsageWithProvider(turn.usage, providerSum);
    result.set(turn.key, { turnUsage, itemUsages });
  });

  return result;
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return "";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function stripMarkdownSnippet(text: string): string {
  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("```") || trimmed.startsWith("---")) continue;
    const cleaned = trimmed
      .replace(/^#{1,6}(?:\s+|$)/, "")
      .replace(/^[-*+](?:\s+|$)/, "")
      .replace(/^>+(?:\s+|$)/, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) return cleaned;
  }
  return "";
}

export function normalizeInlineText(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

export function summarizeTurn(turn: Turn, fallbackTitle: string): TurnSummary {
  let toolCount = 0;
  let failedToolCount = 0;
  let lastReplyIndex = -1;
  let lastReplyText: string | undefined;

  turn.items.forEach((entry, index) => {
    const item = entry.item;
    if (item.type === "tool_call") {
      toolCount += 1;
      if (item.status === "failed") failedToolCount += 1;
    } else if (item.type === "assistant_message" && item.text.trim().length > 0) {
      lastReplyIndex = index;
      lastReplyText = item.text;
    }
  });

  const promptTitle = normalizeInlineText(turn.prompt) || fallbackTitle;
  const replyPreview = lastReplyText ? stripMarkdownSnippet(lastReplyText) : undefined;

  return {
    promptTitle,
    replyPreview: replyPreview && replyPreview !== promptTitle ? replyPreview : undefined,
    toolCount,
    failedToolCount,
    lastReplyIndex,
  };
}

function toolSearchableText(detail: ToolCallDetail): string {
  switch (detail.type) {
    case "shell":
      return `${detail.command ?? ""} ${detail.cwd ?? ""} ${detail.output ?? ""}`;
    case "read":
    case "write":
    case "edit":
      return detail.filePath ?? "";
    case "search":
      return `${detail.query ?? ""} ${detail.content ?? ""} ${(detail.filePaths ?? []).join(" ")} ${(detail.webResults ?? []).map((r) => `${r.title} ${r.url}`).join(" ")}`;
    case "fetch":
      return `${detail.url ?? ""} ${detail.prompt ?? ""} ${detail.result ?? ""}`;
    case "sub_agent":
      return `${detail.description ?? ""} ${detail.subAgentType ?? ""} ${detail.log ?? ""}`;
    case "plan":
      return detail.text ?? "";
    case "plain_text":
      return `${detail.label ?? ""} ${detail.text ?? ""}`;
    case "worktree_setup":
      return `${detail.branchName ?? ""} ${detail.worktreePath ?? ""}`;
    default:
      return "";
  }
}

export function turnMatchesQuery(turn: Turn, rawQuery: string, agentTitle?: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  if (turn.prompt?.toLowerCase().includes(q)) return true;
  if (turn.error?.toLowerCase().includes(q)) return true;
  if (agentTitle?.toLowerCase().includes(q)) return true;
  if (turn.status.toLowerCase().includes(q)) return true;

  for (const entry of turn.items) {
    const item = entry.item;
    switch (item.type) {
      case "user_message":
      case "assistant_message":
      case "reasoning":
        if (item.text.toLowerCase().includes(q)) return true;
        break;
      case "tool_call": {
        if (item.name.toLowerCase().includes(q)) return true;
        if (toolSearchableText(item.detail).toLowerCase().includes(q)) return true;
        if (item.status === "failed") {
          const err = formatToolError(item.error);
          if (err?.toLowerCase().includes(q)) return true;
        }
        break;
      }
      case "error":
      case "notification":
        if (item.message.toLowerCase().includes(q)) return true;
        break;
      case "todo":
        if (item.items.some((t) => t.text.toLowerCase().includes(q))) return true;
        break;
      case "plugin":
        if (item.kind.toLowerCase().includes(q)) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

export function buildTurnSummaryText(turn: Turn, agentTitle?: string, now?: Date): string {
  const lines: string[] = [];
  const headerParts = [
    turn.status.toUpperCase(),
    agentTitle,
    turn.startedAt ? formatClock(turn.startedAt, now) : undefined,
  ].filter(Boolean);
  lines.push(`# Turn (${headerParts.join(" · ")})`);
  const trimmedPrompt = turn.prompt?.trim();
  if (trimmedPrompt) {
    lines.push("", "## Prompt", trimmedPrompt);
  }
  const replies = turn.items
    .filter(
      (e): e is FeedEntry & { item: Extract<AgentTimelineItem, { type: "assistant_message" }> } =>
        e.item.type === "assistant_message",
    )
    .map((r) => r.item.text.trim())
    .filter(Boolean);
  if (replies.length > 0) {
    lines.push("", "## Reply", replies.join("\n\n"));
  }
  const tools = turn.items.filter(
    (e): e is FeedEntry & { item: Extract<AgentTimelineItem, { type: "tool_call" }> } =>
      e.item.type === "tool_call",
  );
  if (tools.length > 0) {
    lines.push(
      "",
      `## Tool calls (${tools.length})`,
      ...tools.map((t) => `- ${t.item.name} (${t.item.status})`),
    );
  }
  const trimmedError = turn.error?.trim();
  if (trimmedError) {
    lines.push("", "## Error", trimmedError);
  }
  return lines.join("\n");
}
