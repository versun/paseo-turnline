import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme, RpcOutput } from "@getpaseo/plugin";
import { usePaseo, useRpc, useTabState, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { FlatList, Icon, Loading, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { getAgentUsage, type UsageRecord } from "../shared/usage";
import { useTurnFeeds } from "./feed";
import { describeEntry, ItemRow } from "./items";
import { TurnPrompt } from "./prompt";
import { createThingsTokens, withAlpha, type ThingsTokens } from "./theme-utils";
import {
  CalloutBox,
  CopyButton,
  HoverPressable,
  pressBg,
  SectionHeading,
  SegmentedSort,
  StatusGlyph,
  statusTone,
  TagPill,
  TinyProgressBar,
} from "./things-ui";
import {
  assignUsageToTurns,
  buildTurnSummaryText,
  computeCacheHitRate,
  computeTurnCounts,
  filterTurns,
  formatCacheRate,
  formatClock,
  formatCost,
  formatDuration,
  formatTimeOnly,
  formatTokens,
  groupTurnsByDay,
  plural,
  sortTurns,
  stepKeyForEntry,
  summarizeTurn,
  turnDurationMs,
  type ItemUsageDisplay,
  type StatusFilter,
  type Turn,
  type TurnStatus,
  type TurnSummary,
} from "./turn-model";

type PaseoClient = ReturnType<typeof usePaseo>;
type AgentListResult = Awaited<ReturnType<PaseoClient["agents"]["list"]>>;
type AgentListSubscription = AgentListResult["subscription"];
type ListedAgent = AgentListResult["entries"][number]["agent"];

interface AgentLite {
  id: string;
  title: string;
  workspaceId: string;
  running: boolean;
}

const tabStateSchema = z.object({
  sort: z.enum(["newest", "oldest"]),
  agentId: z.string().optional(),
  statusFilter: z.enum(["all", "running", "failed"]).optional(),
});

function toAgentLite(agent: ListedAgent): AgentLite {
  return {
    id: agent.id,
    title: agent.title?.trim() || "Untitled agent",
    workspaceId: agent.workspaceId ?? "",
    running: agent.status === "running" || agent.status === "initializing",
  };
}

function hasTokenUsage(usage: Turn["usage"]): boolean {
  if (!usage) return false;
  return (
    (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)) ||
    (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens))
  );
}

function useWorkspaceAgents(
  paseo: PaseoClient,
  workspaceId: string,
): { agents: AgentLite[]; loading: boolean; error?: string } {
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const ac = new AbortController();
    let subscription: AgentListSubscription | undefined;
    let unsubscribe: (() => void) | undefined;
    setAgents([]);
    setLoading(true);
    setError(undefined);

    paseo.agents
      .list({ subscribe: {}, signal: ac.signal })
      .then((result) => {
        if (ac.signal.aborted) {
          void result.subscription.release().catch(() => {});
          return;
        }
        subscription = result.subscription;
        unsubscribe = subscription.subscribe({
          snapshot: ({ entries }) => {
            if (ac.signal.aborted) return;
            setAgents(
              entries
                .map(({ agent }) => toAgentLite(agent))
                .filter((a) => a.workspaceId === workspaceId),
            );
            setLoading(false);
            setError(undefined);
          },
          update: (message) => {
            if (ac.signal.aborted || message.type !== "agent_update") return;
            const update = message.payload;
            setAgents((prev) => {
              if (update.kind === "remove") {
                return prev.some((a) => a.id === update.agentId)
                  ? prev.filter((a) => a.id !== update.agentId)
                  : prev;
              }
              const lite = toAgentLite(update.agent);
              if (lite.workspaceId !== workspaceId) {
                return prev.some((a) => a.id === lite.id)
                  ? prev.filter((a) => a.id !== lite.id)
                  : prev;
              }
              const index = prev.findIndex((a) => a.id === lite.id);
              if (index < 0) return [...prev, lite];
              const existing = prev[index];
              if (existing.title === lite.title && existing.running === lite.running) return prev;
              const next = [...prev];
              next[index] = lite;
              return next;
            });
          },
          error: (err) => {
            if (ac.signal.aborted) return;
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          },
        });
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      ac.abort();
      unsubscribe?.();
      void subscription?.release().catch(() => {});
    };
  }, [paseo, workspaceId]);

  return { agents, loading, error };
}

const STATUS_LABEL: Record<TurnStatus, string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  canceled: "Canceled",
  open: "Activity",
};

/**
 * Things 3 signature row-to-card morph:
 * - Collapsed: calm, flat, airy list row directly on the canvas (`surface0`).
 * - Expanded: lifts off the canvas into an elevated paper card (`surface1`).
 */
function TurnRowCard({
  turn,
  itemUsages,
  agentTitle,
  showCollapsedAgentTag,
  theme,
  tokens,
  compact,
  expanded,
  onToggle,
  onOpenAgent,
}: {
  turn: Turn;
  itemUsages?: ReadonlyMap<number, ItemUsageDisplay>;
  agentTitle?: string;
  showCollapsedAgentTag: boolean;
  theme: PluginTheme;
  tokens: ThingsTokens;
  compact: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenAgent?: () => void;
}) {
  const duration = turnDurationMs(turn);
  const usage = turn.usage;
  const cacheRate = computeCacheHitRate(usage);
  const summary = useMemo(() => summarizeTurn(turn, STATUS_LABEL[turn.status]), [turn]);
  const costText = formatCost(usage?.totalCostUsd);

  if (expanded) {
    return (
      <ExpandedTurnCard
        turn={turn}
        itemUsages={itemUsages}
        agentTitle={agentTitle}
        summary={summary}
        duration={duration}
        costText={costText}
        theme={theme}
        tokens={tokens}
        compact={compact}
        onCollapse={onToggle}
        onOpenAgent={onOpenAgent}
      />
    );
  }

  const showStatusWord =
    turn.status === "running" || turn.status === "failed" || turn.status === "canceled";

  return (
    <HoverPressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: false }}
      style={(state) => ({
        borderRadius: 10,
        paddingHorizontal: compact ? 8 : 10,
        paddingVertical: 9,
        backgroundColor: pressBg(state, tokens),
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ marginTop: 2 }}>
          <StatusGlyph status={turn.status} theme={theme} tokens={tokens} size={16} />
        </View>

        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 14.5,
                fontWeight: "500",
                lineHeight: 20,
                flex: 1,
              }}
              numberOfLines={2}
            >
              {summary.promptTitle}
            </Text>
            <Text
              style={{
                color: withAlpha(theme.colors.foregroundMuted, 0.78),
                fontSize: 11.5,
                marginTop: 3,
                fontVariant: ["tabular-nums"],
              }}
            >
              {formatTimeOnly(turn.startedAt)}
            </Text>
          </View>

          {turn.error ? (
            <Text
              style={{ color: theme.colors.statusDanger, fontSize: 12.5, lineHeight: 17 }}
              numberOfLines={1}
            >
              {turn.error}
            </Text>
          ) : summary.replyPreview ? (
            <Text
              style={{ color: theme.colors.foregroundMuted, fontSize: 12.5, lineHeight: 17 }}
              numberOfLines={1}
            >
              {summary.replyPreview}
            </Text>
          ) : null}

          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              marginTop: 1,
            }}
          >
            {showStatusWord && (
              <Text
                style={{
                  color: statusTone(turn.status, theme, tokens).fg,
                  fontSize: 11.5,
                  fontWeight: "600",
                }}
              >
                {turn.status === "running" ? "Running…" : STATUS_LABEL[turn.status]}
              </Text>
            )}

            {showCollapsedAgentTag && agentTitle && (
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  borderRadius: 5,
                  borderWidth: tokens.hairline,
                  borderColor: tokens.subtleBorder,
                  backgroundColor: tokens.subtlePillBg,
                  maxWidth: 160,
                }}
              >
                <Text
                  style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "500" }}
                  numberOfLines={1}
                >
                  {agentTitle}
                </Text>
              </View>
            )}

            {summary.toolCount > 0 && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <Icon
                  name="Wrench"
                  size={11}
                  color={
                    summary.failedToolCount > 0
                      ? theme.colors.statusDanger
                      : withAlpha(theme.colors.foregroundMuted, 0.8)
                  }
                />
                <Text
                  style={{
                    color:
                      summary.failedToolCount > 0
                        ? theme.colors.statusDanger
                        : theme.colors.foregroundMuted,
                    fontSize: 11.5,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {plural(summary.toolCount, "tool")}
                  {summary.failedToolCount > 0 ? ` (${summary.failedToolCount} failed)` : ""}
                </Text>
              </View>
            )}

            {duration !== null && (
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 11.5,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {formatDuration(duration)}
              </Text>
            )}

            {hasTokenUsage(usage) && usage && (
              <Text
                style={{
                  color: withAlpha(theme.colors.foregroundMuted, 0.85),
                  fontSize: 11.5,
                  fontVariant: ["tabular-nums"],
                }}
              >
                ↓{formatTokens(usage.inputTokens)} ↑{formatTokens(usage.outputTokens)}
                {cacheRate !== null ? ` · ${formatCacheRate(cacheRate)} cache` : ""}
              </Text>
            )}

            {costText ? (
              <Text
                style={{
                  color: withAlpha(theme.colors.foregroundMuted, 0.85),
                  fontSize: 11.5,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {costText}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </HoverPressable>
  );
}

/**
 * Mounted only while expanded so collapsed rows stay light and expanding a turn
 * initializes with the latest final reply visible (like a Things card note).
 */
function ExpandedTurnCard({
  turn,
  itemUsages,
  agentTitle,
  summary,
  duration,
  costText,
  theme,
  tokens,
  compact,
  onCollapse,
  onOpenAgent,
}: {
  turn: Turn;
  itemUsages?: ReadonlyMap<number, ItemUsageDisplay>;
  agentTitle?: string;
  summary: TurnSummary;
  duration: number | null;
  costText: string;
  theme: PluginTheme;
  tokens: ThingsTokens;
  compact: boolean;
  onCollapse: () => void;
  onOpenAgent?: () => void;
}) {
  const usage = turn.usage;
  const cacheRate = computeCacheHitRate(usage);
  const sColor = statusTone(turn.status, theme, tokens);

  const stepMeta = useMemo(() => {
    const seen = new Map<string, number>();
    return turn.items.map((entry, idx) => {
      const base = stepKeyForEntry(entry, idx);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const key = count === 0 ? base : `${base}#${count}`;
      const description = describeEntry(entry);
      return { idx, key, entry, description, expandable: description.expandable };
    });
  }, [turn.items]);

  const [openSteps, setOpenSteps] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (summary.lastReplyIndex >= 0 && stepMeta[summary.lastReplyIndex]?.expandable) {
      initial.add(stepMeta[summary.lastReplyIndex].key);
    }
    return initial;
  });

  const expandableKeys = useMemo(
    () => stepMeta.filter((s) => s.expandable).map((s) => s.key),
    [stepMeta],
  );
  const allStepsOpen =
    expandableKeys.length > 0 && expandableKeys.every((key) => openSteps.has(key));

  const toggleStep = useCallback((key: string) => {
    setOpenSteps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAllSteps = useCallback(() => {
    setOpenSteps((prev) => {
      const everyOpen = expandableKeys.length > 0 && expandableKeys.every((k) => prev.has(k));
      return everyOpen ? new Set() : new Set(expandableKeys);
    });
  }, [expandableKeys]);

  const rawRatio =
    usage?.contextWindowUsedTokens !== undefined &&
    usage?.contextWindowMaxTokens !== undefined &&
    usage.contextWindowMaxTokens > 0
      ? usage.contextWindowUsedTokens / usage.contextWindowMaxTokens
      : null;
  const contextRatio = rawRatio !== null && Number.isFinite(rawRatio) ? rawRatio : null;

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: tokens.subtleBorder,
        marginVertical: 8,
        paddingHorizontal: compact ? 12 : 16,
        paddingTop: 14,
        paddingBottom: 10,
        gap: 10,
        ...tokens.cardShadow,
      }}
    >
      {/* Card Header */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ marginTop: 3 }}>
          <StatusGlyph status={turn.status} theme={theme} tokens={tokens} size={17} />
        </View>

        <HoverPressable
          onPress={onCollapse}
          accessibilityRole="button"
          accessibilityState={{ expanded: true }}
          style={{ flex: 1 }}
        >
          <Text
            selectable
            style={{
              color: theme.colors.foreground,
              fontSize: 15,
              fontWeight: "600",
              lineHeight: 21,
            }}
          >
            {turn.prompt?.trim() || STATUS_LABEL[turn.status]}
          </Text>
        </HoverPressable>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
          {turn.prompt?.trim() && (
            <CopyButton
              text={turn.prompt.trim()}
              toastMessage="Copied prompt"
              theme={theme}
              tokens={tokens}
            />
          )}
          <HoverPressable
            onPress={onCollapse}
            accessibilityRole="button"
            accessibilityLabel="Collapse turn"
            style={(state) => ({
              padding: 5,
              borderRadius: 6,
              backgroundColor: pressBg(state, tokens),
            })}
          >
            <Icon name="ChevronUp" size={14} color={theme.colors.foregroundMuted} />
          </HoverPressable>
        </View>
      </View>

      {/* Error banner */}
      {turn.error && (
        <CalloutBox
          tone="danger"
          icon="CircleAlert"
          text={turn.error}
          style={{ marginLeft: 27 }}
          theme={theme}
          tokens={tokens}
        />
      )}

      {/* Quiet Metadata Strip */}
      <View
        style={{
          marginLeft: 27,
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        <View
          style={{
            paddingHorizontal: 7,
            paddingVertical: 2,
            borderRadius: 999,
            backgroundColor: sColor.bg,
          }}
        >
          <Text style={{ color: sColor.fg, fontSize: 11, fontWeight: "600" }}>
            {STATUS_LABEL[turn.status]}
          </Text>
        </View>

        {agentTitle && (
          <HoverPressable
            onPress={onOpenAgent}
            disabled={!onOpenAgent}
            accessibilityRole={onOpenAgent ? "button" : undefined}
            style={(state) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 6,
              borderWidth: tokens.hairline,
              borderColor: tokens.subtleBorder,
              backgroundColor: onOpenAgent
                ? pressBg(state, tokens, tokens.subtlePillBg)
                : tokens.subtlePillBg,
            })}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontWeight: "500" }}>
              {agentTitle}
            </Text>
            {onOpenAgent && (
              <Icon name="ArrowUpRight" size={11} color={theme.colors.foregroundMuted} />
            )}
          </HoverPressable>
        )}

        {turn.startedAt && (
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 11.5,
              fontVariant: ["tabular-nums"],
            }}
          >
            {formatClock(turn.startedAt)}
            {duration !== null ? ` · ${formatDuration(duration)}` : ""}
          </Text>
        )}

        {hasTokenUsage(usage) && usage && (
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 11.5,
              fontVariant: ["tabular-nums"],
            }}
          >
            ↓{formatTokens(usage.inputTokens)}
            {cacheRate !== null
              ? typeof usage.cachedInputTokens === "number" &&
                Number.isFinite(usage.cachedInputTokens) &&
                usage.cachedInputTokens > 0
                ? ` (${formatTokens(usage.cachedInputTokens)} · ${formatCacheRate(cacheRate)} cache)`
                : ` (${formatCacheRate(cacheRate)} cache)`
              : ""}{" "}
            ↑{formatTokens(usage.outputTokens)}
          </Text>
        )}

        {contextRatio !== null && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <TinyProgressBar ratio={contextRatio} theme={theme} tokens={tokens} />
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontVariant: ["tabular-nums"],
              }}
            >
              {Math.round(Math.max(0, contextRatio) * 100)}% ctx
            </Text>
          </View>
        )}

        {costText ? (
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 11.5,
              fontWeight: "500",
              fontVariant: ["tabular-nums"],
            }}
          >
            {costText}
          </Text>
        ) : null}
      </View>

      <View style={{ height: tokens.hairline, backgroundColor: tokens.subtleBorder, marginTop: 2 }} />

      {/* Checklist Timeline & Provider Prompt */}
      <View style={{ gap: 2 }}>
        <TurnPrompt
          agentId={turn.agentId}
          at={turn.status === "running" ? undefined : (turn.endedAt ?? turn.startedAt)}
          theme={theme}
          tokens={tokens}
        />
        {stepMeta.map(({ idx, key, entry, description }) => (
          <ItemRow
            key={key}
            entry={entry}
            description={description}
            itemUsage={itemUsages?.get(idx)}
            compact={compact}
            theme={theme}
            tokens={tokens}
            expanded={openSteps.has(key)}
            onToggle={() => toggleStep(key)}
          />
        ))}
      </View>

      {/* Quiet Card Footer Bar */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingTop: 8,
          borderTopWidth: tokens.hairline,
          borderTopColor: tokens.subtleBorder,
        }}
      >
        <Text
          style={{
            color: withAlpha(theme.colors.foregroundMuted, 0.8),
            fontSize: 11.5,
            fontVariant: ["tabular-nums"],
          }}
        >
          {plural(summary.stepCount, "step")}
          {summary.toolCount > 0 ? ` · ${plural(summary.toolCount, "tool")}` : ""}
          {summary.thinkingCount > 0 ? ` · ${plural(summary.thinkingCount, "thought")}` : ""}
        </Text>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          {expandableKeys.length > 1 && (
            <HoverPressable
              onPress={toggleAllSteps}
              accessibilityRole="button"
              style={(state) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 7,
                paddingVertical: 4,
                borderRadius: 6,
                backgroundColor: pressBg(state, tokens),
              })}
            >
              <Icon
                name={allStepsOpen ? "ChevronsDownUp" : "ChevronsUpDown"}
                size={12}
                color={theme.colors.foregroundMuted}
              />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontWeight: "500" }}>
                {allStepsOpen ? "Collapse steps" : "Expand all"}
              </Text>
            </HoverPressable>
          )}

          <CopyButton
            text={() => buildTurnSummaryText(turn, agentTitle)}
            label="Copy"
            toastMessage="Copied turn summary"
            theme={theme}
            tokens={tokens}
          />

          <HoverPressable
            onPress={onCollapse}
            accessibilityRole="button"
            style={({ hovered, pressed }) => ({
              paddingHorizontal: 9,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: pressed || hovered ? tokens.accentSoft : tokens.subtlePillBg,
            })}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 11.5, fontWeight: "600" }}>
              Done
            </Text>
          </HoverPressable>
        </View>
      </View>
    </View>
  );
}

type ListRow =
  | { type: "section"; id: string; label: string; count: number; liveCount: number; first: boolean }
  | { type: "turn"; id: string; turn: Turn };

export function TurnsPanel({
  theme,
  layout,
  workspaceId,
  tab,
  navigation,
}: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const getUsage = useRpc(getAgentUsage);
  const queryClient = useQueryClient();
  const [state, setState] = useTabState(tab, tabStateSchema, { sort: "newest" });
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setExpandedKeys(new Set());
    setSearchQuery("");
    setSearchOpen(false);
  }, [workspaceId]);

  const tokens = useMemo(
    () => createThingsTokens(theme, layout.platform),
    [theme, layout.platform],
  );

  const { agents, loading: agentsLoading, error: agentsError } = useWorkspaceAgents(
    paseo,
    workspaceId,
  );
  const statusFilter: StatusFilter = state.statusFilter ?? "all";
  const selectedAgentId =
    state.agentId && agents.some((a) => a.id === state.agentId) ? state.agentId : "all";

  const { feeds, loadOlder } = useTurnFeeds(paseo, agents);

  const visibleAgents = useMemo(() => {
    if (selectedAgentId === "all") return agents;
    return agents.filter((a) => a.id === selectedAgentId);
  }, [agents, selectedAgentId]);

  const usageQueries = useQueries({
    queries: visibleAgents.map((agent) => ({
      queryKey: ["turnline-usage", agent.id] as const,
      queryFn: () => getUsage({ agentId: agent.id }),
      staleTime: agent.running ? 2_000 : 15_000,
      refetchInterval: agent.running
        ? (query: { state: { data?: RpcOutput<typeof getAgentUsage> } }) =>
            query.state.data?.status === "unsupported" ? false : 4_000
        : (false as const),
    })),
  });

  const activityByAgent = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      const view = feeds.get(agent.id);
      if (!view || view.loading) continue;
      let itemCount = 0;
      let completedCount = 0;
      for (const t of view.turns) {
        itemCount += t.items.length;
        if (t.status !== "running") completedCount += 1;
      }
      map.set(agent.id, `${view.turns.length}:${itemCount}:${completedCount}:${agent.running ? 1 : 0}`);
    }
    return map;
  }, [agents, feeds]);

  const prevActivityRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const prev = prevActivityRef.current;
    for (const [agentId, sig] of activityByAgent) {
      const prevSig = prev.get(agentId);
      if (prevSig !== undefined && prevSig !== sig) {
        const cached = queryClient.getQueryData<RpcOutput<typeof getAgentUsage>>([
          "turnline-usage",
          agentId,
        ]);
        if (cached?.status === "unsupported") continue;
        void queryClient.invalidateQueries({ queryKey: ["turnline-usage", agentId] });
      }
    }
    prevActivityRef.current = new Map(activityByAgent);
  }, [activityByAgent, queryClient]);

  const usageRecordsRef = useRef<Map<string, readonly UsageRecord[]>>(new Map());
  const usageRecordsByAgent = useMemo(() => {
    const next = new Map<string, readonly UsageRecord[]>();
    visibleAgents.forEach((agent, index) => {
      const data = usageQueries[index]?.data;
      if (data?.status === "ok" && data.records) {
        next.set(agent.id, data.records);
      }
    });
    const prev = usageRecordsRef.current;
    if (prev.size === next.size) {
      let same = true;
      for (const [k, v] of next) {
        if (prev.get(k) !== v) {
          same = false;
          break;
        }
      }
      if (same) return prev;
    }
    usageRecordsRef.current = next;
    return next;
  }, [visibleAgents, usageQueries]);

  const visibleFeeds = useMemo(() => {
    if (selectedAgentId === "all") return [...feeds.values()];
    const view = feeds.get(selectedAgentId);
    return view ? [view] : [];
  }, [feeds, selectedAgentId]);

  const titleById = useMemo(() => new Map(agents.map((a) => [a.id, a.title])), [agents]);

  const { allTurns, itemUsagesByTurnKey } = useMemo(() => {
    const combined: Turn[] = [];
    const usagesByKey = new Map<string, Map<number, ItemUsageDisplay>>();
    for (const view of visibleFeeds) {
      const records = usageRecordsByAgent.get(view.agentId);
      const resolved = assignUsageToTurns(view.turns, records);
      for (const turn of view.turns) {
        const entry = resolved.get(turn.key);
        if (entry) {
          usagesByKey.set(turn.key, entry.itemUsages);
          combined.push(entry.turnUsage !== turn.usage ? { ...turn, usage: entry.turnUsage } : turn);
        } else {
          combined.push(turn);
        }
      }
    }
    return {
      allTurns: sortTurns(combined, state.sort),
      itemUsagesByTurnKey: usagesByKey,
    };
  }, [visibleFeeds, usageRecordsByAgent, state.sort]);

  const counts = useMemo(() => computeTurnCounts(allTurns), [allTurns]);

  const filteredTurns = useMemo(
    () => filterTurns(allTurns, { statusFilter, searchQuery, titleById }),
    [allTurns, statusFilter, searchQuery, titleById],
  );

  const listRows = useMemo<ListRow[]>(() => {
    const groups = groupTurnsByDay(filteredTurns);
    const rows: ListRow[] = [];
    groups.forEach((group, index) => {
      rows.push({
        type: "section",
        id: `section:${group.id}`,
        label: group.label,
        count: group.turns.length,
        liveCount: group.turns.filter((t) => t.status === "running").length,
        first: index === 0,
      });
      for (const turn of group.turns) {
        rows.push({ type: "turn", id: turn.key, turn });
      }
    });
    return rows;
  }, [filteredTurns]);

  const feedStatus = useMemo(() => {
    const errors = new Set<string>();
    if (agentsError) errors.add(agentsError);
    let anyLoading = false;
    let anyLoadingOlder = false;
    const olderAgentIds: string[] = [];

    for (const view of visibleFeeds) {
      if (view.error) errors.add(view.error);
      if (view.loading) anyLoading = true;
      if (view.loadingOlder) anyLoadingOlder = true;
      if (view.hasOlder) olderAgentIds.push(view.agentId);
    }
    return { errors: [...errors], anyLoading, anyLoadingOlder, olderAgentIds };
  }, [visibleFeeds, agentsError]);

  const hasVisibleExpanded = useMemo(
    () => expandedKeys.size > 0 && filteredTurns.some((t) => expandedKeys.has(t.key)),
    [expandedKeys, filteredTurns],
  );

  const toggleTurn = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const hasActiveFilters =
    searchQuery.trim().length > 0 || statusFilter !== "all" || selectedAgentId !== "all";

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setSearchOpen(false);
    setState({ ...state, agentId: undefined, statusFilter: "all" });
  }, [setState, state]);

  const subtitleParts = useMemo(() => {
    if (counts.total === 0) return [];
    const parts: string[] = [plural(counts.total, "turn")];
    if (counts.running > 0) parts.push(`${counts.running} running`);
    if (counts.failed > 0) parts.push(`${counts.failed} failed`);
    if (counts.tokensTotal !== undefined) parts.push(`${formatTokens(counts.tokensTotal)} tokens`);
    if (counts.cacheHitRate !== undefined) {
      parts.push(`${formatCacheRate(counts.cacheHitRate)} cache`);
    }
    if (counts.costTotal !== undefined) {
      const formatted = formatCost(counts.costTotal);
      if (formatted) parts.push(formatted);
    }
    return parts;
  }, [counts]);

  const showFilterRow =
    agents.length > 1 || counts.running > 0 || counts.failed > 0 || statusFilter !== "all";
  const hasOlder = feedStatus.olderAgentIds.length > 0;

  const loadOlderRow = (
    <View style={{ alignItems: "center", paddingVertical: 14 }}>
      <HoverPressable
        onPress={() => {
          for (const agentId of feedStatus.olderAgentIds) void loadOlder(agentId);
        }}
        disabled={feedStatus.anyLoadingOlder}
        accessibilityRole="button"
        style={(state) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 14,
          paddingVertical: 7,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: tokens.subtleBorder,
          backgroundColor: pressBg(state, tokens, theme.colors.surface1),
        })}
      >
        <Icon name="History" size={13} color={theme.colors.accent} />
        <Text style={{ color: theme.colors.accent, fontSize: 12.5, fontWeight: "500" }}>
          {feedStatus.anyLoadingOlder ? "Loading earlier activity…" : "Load earlier activity"}
        </Text>
      </HoverPressable>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{
          flex: 1,
          width: "100%",
          maxWidth: 780,
          alignSelf: "center",
          paddingHorizontal: layout.compact ? 12 : 28,
        }}
      >
        {/* View Header */}
        <View style={{ paddingTop: layout.compact ? 14 : 22, paddingBottom: 10, gap: 10 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
              <View
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  backgroundColor: tokens.accentSoft,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="History" size={16} color={theme.colors.accent} />
              </View>
              <View style={{ flexShrink: 1 }}>
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: layout.compact ? 21 : 24,
                    fontWeight: "700",
                    letterSpacing: -0.4,
                  }}
                >
                  Turns
                </Text>
                {subtitleParts.length > 0 && (
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 12,
                      fontVariant: ["tabular-nums"],
                      marginTop: 1,
                    }}
                    numberOfLines={1}
                  >
                    {subtitleParts.join(" · ")}
                  </Text>
                )}
              </View>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {hasVisibleExpanded && (
                <HoverPressable
                  onPress={() => setExpandedKeys(new Set())}
                  accessibilityRole="button"
                  accessibilityLabel="Collapse all expanded turns"
                  style={(state) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingHorizontal: 8,
                    paddingVertical: 5,
                    borderRadius: 7,
                    backgroundColor: pressBg(state, tokens),
                  })}
                >
                  <Icon name="ChevronsDownUp" size={14} color={theme.colors.foregroundMuted} />
                  {!layout.compact && (
                    <Text
                      style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" }}
                    >
                      Collapse
                    </Text>
                  )}
                </HoverPressable>
              )}

              <HoverPressable
                onPress={() => {
                  if (searchOpen) {
                    setSearchOpen(false);
                    setSearchQuery("");
                  } else {
                    setSearchOpen(true);
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel="Search turns"
                style={(state) => ({
                  padding: 6,
                  borderRadius: 8,
                  borderWidth: tokens.hairline,
                  borderColor: searchOpen ? tokens.accentBorder : tokens.subtleBorder,
                  backgroundColor: searchOpen ? tokens.accentSoft : pressBg(state, tokens),
                })}
              >
                <Icon
                  name="Search"
                  size={14}
                  color={searchOpen ? theme.colors.accent : theme.colors.foregroundMuted}
                />
              </HoverPressable>

              <SegmentedSort
                value={state.sort}
                theme={theme}
                tokens={tokens}
                onChange={(sort) => setState({ ...state, sort })}
              />
            </View>
          </View>

          {/* Quick Find Search Field */}
          {searchOpen && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                backgroundColor: theme.colors.surface1,
                borderRadius: 9,
                borderWidth: 1,
                borderColor: searchQuery.length > 0 ? tokens.accentBorder : tokens.subtleBorder,
                paddingHorizontal: 10,
                paddingVertical: layout.compact ? 7 : 6,
              }}
            >
              <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Filter turns, replies, tools, files…"
                placeholderTextColor={withAlpha(theme.colors.foregroundMuted, 0.7)}
                autoFocus
                returnKeyType="search"
                style={{ flex: 1, color: theme.colors.foreground, fontSize: 13, paddingVertical: 0 }}
              />
              {searchQuery.length > 0 && (
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11.5,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {filteredTurns.length}
                </Text>
              )}
              <HoverPressable
                onPress={() => {
                  setSearchQuery("");
                  setSearchOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                style={({ hovered }) => ({
                  padding: 3,
                  borderRadius: 999,
                  backgroundColor: hovered ? tokens.rowHoverBg : "transparent",
                })}
              >
                <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
              </HoverPressable>
            </View>
          )}

          {/* Filter Tag Bar */}
          {showFilterRow && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingVertical: 1,
              }}
            >
              {agents.length > 1 && (
                <>
                  <TagPill
                    label="All agents"
                    selected={selectedAgentId === "all"}
                    theme={theme}
                    tokens={tokens}
                    onPress={() => setState({ ...state, agentId: undefined })}
                  />
                  {agents.map((agent) => (
                    <TagPill
                      key={agent.id}
                      label={agent.title}
                      selected={selectedAgentId === agent.id}
                      dotColor={agent.running ? theme.colors.accent : undefined}
                      theme={theme}
                      tokens={tokens}
                      onPress={() => setState({ ...state, agentId: agent.id })}
                    />
                  ))}
                </>
              )}

              {agents.length > 1 &&
                (counts.running > 0 || counts.failed > 0 || statusFilter !== "all") && (
                  <View
                    style={{
                      width: 1,
                      height: 16,
                      backgroundColor: tokens.subtleBorder,
                      marginHorizontal: 2,
                    }}
                  />
                )}

              {(counts.running > 0 || statusFilter === "running") && (
                <TagPill
                  label="Running"
                  count={counts.running}
                  selected={statusFilter === "running"}
                  dotColor={theme.colors.accent}
                  theme={theme}
                  tokens={tokens}
                  onPress={() =>
                    setState({
                      ...state,
                      statusFilter: statusFilter === "running" ? "all" : "running",
                    })
                  }
                />
              )}

              {(counts.failed > 0 || statusFilter === "failed") && (
                <TagPill
                  label="Failed"
                  count={counts.failed}
                  tone="danger"
                  selected={statusFilter === "failed"}
                  dotColor={theme.colors.statusDanger}
                  theme={theme}
                  tokens={tokens}
                  onPress={() =>
                    setState({
                      ...state,
                      statusFilter: statusFilter === "failed" ? "all" : "failed",
                    })
                  }
                />
              )}
            </ScrollView>
          )}

          {/* Error banner */}
          {feedStatus.errors.length > 0 && (
            <CalloutBox
              tone="danger"
              icon="CircleAlert"
              text={feedStatus.errors[0]}
              numberOfLines={2}
              theme={theme}
              tokens={tokens}
            />
          )}
        </View>

        {/* Main Content */}
        {listRows.length === 0 ? (
          agentsLoading || feedStatus.anyLoading ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: 60 }}>
              <Loading />
            </View>
          ) : (
            <View
              style={{
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 24,
                paddingBottom: 72,
                gap: 10,
              }}
            >
              <View
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 24,
                  backgroundColor: tokens.subtlePillBg,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon
                  name={hasActiveFilters ? "Search" : "History"}
                  size={20}
                  color={theme.colors.foregroundMuted}
                />
              </View>
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 15,
                  fontWeight: "600",
                  textAlign: "center",
                }}
              >
                {hasActiveFilters
                  ? "No matching turns"
                  : agents.length === 0
                    ? "No agents yet"
                    : "No turns yet"}
              </Text>
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 13,
                  textAlign: "center",
                  lineHeight: 19,
                  maxWidth: 320,
                }}
              >
                {hasActiveFilters
                  ? "Try clearing your search or switching agent and status filters."
                  : agents.length === 0
                    ? "Start an agent in this workspace to inspect prompts, tool calls, and replies here."
                    : "Agent activity will stream into this timeline as soon as a turn begins."}
              </Text>
              {hasActiveFilters && (
                <HoverPressable
                  onPress={clearFilters}
                  accessibilityRole="button"
                  style={({ hovered, pressed }) => ({
                    marginTop: 4,
                    paddingHorizontal: 14,
                    paddingVertical: 6,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: tokens.accentBorder,
                    backgroundColor: pressed || hovered ? tokens.accentSoft : "transparent",
                  })}
                >
                  <Text style={{ color: theme.colors.accent, fontSize: 12.5, fontWeight: "600" }}>
                    Clear filters
                  </Text>
                </HoverPressable>
              )}
              {hasOlder && loadOlderRow}
            </View>
          )
        ) : (
          <FlatList
            data={listRows}
            keyExtractor={(row) => row.id}
            contentContainerStyle={{ paddingBottom: 36 }}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => {
              if (item.type === "section") {
                return (
                  <SectionHeading
                    label={item.label}
                    count={item.count}
                    liveCount={item.liveCount}
                    first={item.first}
                    theme={theme}
                    tokens={tokens}
                  />
                );
              }
              const turn = item.turn;
              return (
                <TurnRowCard
                  turn={turn}
                  itemUsages={itemUsagesByTurnKey.get(turn.key)}
                  agentTitle={titleById.get(turn.agentId)}
                  showCollapsedAgentTag={selectedAgentId === "all" && agents.length > 1}
                  theme={theme}
                  tokens={tokens}
                  compact={layout.compact}
                  expanded={expandedKeys.has(turn.key)}
                  onToggle={() => toggleTurn(turn.key)}
                  onOpenAgent={
                    navigation?.openAgent
                      ? () => navigation.openAgent({ agentId: turn.agentId })
                      : undefined
                  }
                />
              );
            }}
            ListHeaderComponent={state.sort === "oldest" && hasOlder ? loadOlderRow : null}
            ListFooterComponent={state.sort === "newest" && hasOlder ? loadOlderRow : null}
          />
        )}
      </View>
    </View>
  );
}
