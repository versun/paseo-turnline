import type { AgentTimelineItem, AgentUsage, ToolCallDetail } from "@getpaseo/protocol/agent-types";

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
  thinkingCount: number;
  stepCount: number;
  lastReplyIndex: number;
}

export interface TurnCounts {
  total: number;
  running: number;
  failed: number;
  tokensTotal?: number;
  costTotal?: number;
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

  for (const t of turns) {
    if (t.status === "running") running += 1;
    if (t.status === "failed") failed += 1;
    const input = t.usage?.inputTokens;
    const output = t.usage?.outputTokens;
    const validInput = typeof input === "number" && Number.isFinite(input);
    const validOutput = typeof output === "number" && Number.isFinite(output);
    if (validInput || validOutput) {
      hasTokens = true;
      tokensTotal += (validInput ? input : 0) + (validOutput ? output : 0);
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
  let thinkingCount = 0;
  let lastReplyIndex = -1;
  let lastReplyText: string | undefined;

  turn.items.forEach((entry, index) => {
    const item = entry.item;
    if (item.type === "tool_call") {
      toolCount += 1;
      if (item.status === "failed") failedToolCount += 1;
    } else if (item.type === "reasoning") {
      thinkingCount += 1;
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
    thinkingCount,
    stepCount: turn.items.length,
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
