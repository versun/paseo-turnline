import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Markdown } from "@getpaseo/plugin/client/ui";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { ThingsTokens } from "./theme-utils";
import { withAlpha } from "./theme-utils";
import {
  CalloutBox,
  CodeWellFrame,
  CopyButton,
  ExpandableLinesToggle,
  HoverPressable,
  pressBg,
  statusTone,
  TruncatedText,
} from "./things-ui";
import {
  computeCacheHitRate,
  formatCacheRate,
  formatItemUsageDetail,
  formatTimeOnly,
  formatTokens,
  formatToolError,
  plural,
  type FeedEntry,
  type ItemUsageDisplay,
} from "./turn-model";

type BodyKind = "markdown" | "mono" | "reasoning" | "diff" | "shell" | "todo" | "callout";

interface ShellPayload {
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number | null;
}

export interface ItemDescription {
  icon: string;
  label: string;
  summary?: string;
  summaryMono?: boolean;
  body?: string;
  bodyKind?: BodyKind;
  bodyHeader?: string;
  shell?: ShellPayload;
  errorText?: string;
  todos?: readonly { text: string; completed: boolean }[];
  calloutTone?: "danger" | "warning" | "info";
  toolStatus?: "running" | "completed" | "failed" | "canceled";
  expandable: boolean;
}

const PREVIEW_LINE_LIMIT = 18;
const REASONING_LINE_LIMIT = 12;

function firstLine(text: string | undefined, max = 110): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? text.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function joinParts(parts: (string | undefined)[], sep = "\n\n"): string | undefined {
  const out = parts.filter((p): p is string => Boolean(p));
  return out.length ? out.join(sep) : undefined;
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function shortPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

function describeToolDetail(detail: ToolCallDetail): {
  summary?: string;
  summaryMono?: boolean;
  body?: string;
  bodyKind?: BodyKind;
  bodyHeader?: string;
  shell?: ShellPayload;
} {
  switch (detail.type) {
    case "shell": {
      const hasShellData = Boolean(
        detail.command ||
          detail.cwd ||
          detail.output ||
          (detail.exitCode !== undefined && detail.exitCode !== null),
      );
      return {
        summary: firstLine(detail.command, 90),
        summaryMono: true,
        bodyKind: "shell",
        shell: hasShellData
          ? {
              command: detail.command,
              cwd: detail.cwd,
              output: detail.output,
              exitCode: detail.exitCode,
            }
          : undefined,
        body: joinParts([
          detail.command ? `$ ${detail.command}` : undefined,
          detail.output,
          detail.exitCode !== undefined && detail.exitCode !== null
            ? `exit code ${detail.exitCode}`
            : undefined,
        ]),
      };
    }
    case "read":
    case "write":
      return {
        summary: shortPath(detail.filePath),
        summaryMono: true,
        bodyHeader: detail.filePath,
        body: detail.content,
        bodyKind: "mono",
      };
    case "edit": {
      const diffBody =
        detail.unifiedDiff ||
        joinParts(
          [
            detail.oldString
              ? detail.oldString
                  .split("\n")
                  .map((l) => `- ${l}`)
                  .join("\n")
              : undefined,
            detail.newString
              ? detail.newString
                  .split("\n")
                  .map((l) => `+ ${l}`)
                  .join("\n")
              : undefined,
          ],
          "\n",
        );
      return {
        summary: shortPath(detail.filePath),
        summaryMono: true,
        bodyHeader: detail.filePath,
        body: diffBody,
        bodyKind: "diff",
      };
    }
    case "search":
      return {
        summary: detail.query,
        summaryMono: true,
        bodyHeader: detail.query ? `query: ${detail.query}` : undefined,
        body: joinParts([
          detail.content,
          detail.filePaths?.length ? detail.filePaths.join("\n") : undefined,
          detail.webResults?.length
            ? detail.webResults.map((r) => `${r.title} — ${r.url}`).join("\n")
            : undefined,
        ]),
        bodyKind: "mono",
      };
    case "fetch":
      return {
        summary: detail.url,
        summaryMono: true,
        bodyHeader:
          detail.code !== undefined
            ? `HTTP ${detail.code}${detail.codeText ? ` ${detail.codeText}` : ""} · ${detail.url}`
            : detail.url,
        body: joinParts([detail.prompt ? `prompt: ${detail.prompt}` : undefined, detail.result]),
        bodyKind: "mono",
      };
    case "sub_agent":
      return {
        summary: detail.description ?? detail.subAgentType,
        bodyHeader: detail.subAgentType ? `sub-agent · ${detail.subAgentType}` : undefined,
        body: joinParts([
          detail.actions?.length
            ? detail.actions
                .map((a) => `${a.index}. ${a.toolName}${a.summary ? ` — ${a.summary}` : ""}`)
                .join("\n")
            : undefined,
          detail.log,
        ]),
        bodyKind: "mono",
      };
    case "plan":
      return {
        summary: firstLine(detail.text),
        body: detail.text,
        bodyKind: "markdown",
      };
    case "plain_text":
      return {
        summary: detail.label,
        body: detail.text,
        bodyKind: "mono",
      };
    case "worktree_setup":
      return {
        summary: detail.branchName ?? shortPath(detail.worktreePath),
        summaryMono: true,
        bodyHeader: detail.branchName ? `branch: ${detail.branchName}` : detail.worktreePath,
        body: detail.commands?.length
          ? detail.commands
              .map(
                (c) =>
                  `$ ${c.command}${c.exitCode !== null && c.exitCode !== undefined ? ` → ${c.exitCode}` : ""}${c.log ? `\n${c.log}` : ""}`,
              )
              .join("\n\n")
          : detail.log || undefined,
        bodyKind: "mono",
      };
    default: {
      const payload =
        detail.input !== undefined || detail.output !== undefined
          ? safeJson({ input: detail.input, output: detail.output })
          : undefined;
      return {
        summary: undefined,
        body: payload,
        bodyKind: "mono",
      };
    }
  }
}

const TOOL_ICONS: Record<string, string> = {
  shell: "SquareTerminal",
  read: "Eye",
  edit: "Pencil",
  write: "FileText",
  search: "Search",
  fetch: "Globe",
  sub_agent: "Bot",
  plan: "ListChecks",
  worktree_setup: "GitBranch",
  plain_text: "MessageSquare",
  unknown: "Wrench",
};

export function describeEntry(entry: FeedEntry): ItemDescription {
  const item = entry.item;
  switch (item.type) {
    case "user_message":
      return {
        icon: "CircleUser",
        label: "Prompt",
        summary: firstLine(item.text, 85),
        body: item.text,
        bodyKind: "markdown",
        expandable: item.text.trim().length > 0,
      };
    case "assistant_message":
      return {
        icon: "Sparkles",
        label: "Reply",
        summary: firstLine(item.text, 90),
        body: item.text,
        bodyKind: "markdown",
        expandable: item.text.trim().length > 0,
      };
    case "reasoning":
      return {
        icon: "Brain",
        label: "Thinking",
        summary: firstLine(item.text, 90),
        body: item.text,
        bodyKind: "reasoning",
        expandable: item.text.trim().length > 0,
      };
    case "tool_call": {
      const detail = describeToolDetail(item.detail);
      const errorText = item.status === "failed" ? formatToolError(item.error) : undefined;
      return {
        icon: TOOL_ICONS[item.detail.type] ?? "Wrench",
        label: item.name,
        summary: detail.summary ?? firstLine(errorText, 90),
        summaryMono: detail.summary ? detail.summaryMono : false,
        body: detail.body,
        bodyKind: detail.bodyKind ?? "mono",
        bodyHeader: detail.bodyHeader,
        shell: detail.shell,
        errorText,
        toolStatus: item.status,
        expandable: Boolean(detail.body || detail.shell || detail.summary || errorText),
      };
    }
    case "todo": {
      const done = item.items.filter((t) => t.completed).length;
      return {
        icon: "ListTodo",
        label: "Checklist",
        summary: `${done}/${item.items.length} completed`,
        todos: item.items,
        bodyKind: "todo",
        expandable: item.items.length > 0,
      };
    }
    case "error":
      return {
        icon: "CircleAlert",
        label: "Error",
        summary: firstLine(item.message),
        body: item.message,
        bodyKind: "callout",
        calloutTone: "danger",
        expandable: item.message.trim().length > 0,
      };
    case "notification": {
      const tone =
        item.level === "error" ? "danger" : item.level === "warning" ? "warning" : "info";
      return {
        icon:
          item.level === "error"
            ? "CircleAlert"
            : item.level === "warning"
              ? "TriangleAlert"
              : "Info",
        label: item.level === "error" ? "Error" : item.level === "warning" ? "Warning" : "Note",
        summary: firstLine(item.message),
        body: item.message,
        bodyKind: "callout",
        calloutTone: tone,
        expandable: item.message.trim().length > 0,
      };
    }
    case "compaction":
      return {
        icon: "FoldVertical",
        label: item.status === "loading" ? "Compacting context…" : "Context compacted",
        summary:
          typeof item.preTokens === "number" && Number.isFinite(item.preTokens) && item.preTokens > 0
            ? `${item.preTokens.toLocaleString()} tokens before`
            : undefined,
        expandable: false,
      };
    case "plugin": {
      const body = safeJson(item.data);
      return {
        icon: "Blocks",
        label: `Plugin · ${item.kind}`,
        body,
        bodyKind: "mono",
        expandable: Boolean(body),
      };
    }
    default:
      return { icon: "Circle", label: "Event", expandable: false };
  }
}

function MonoWell({
  header,
  text,
  theme,
  tokens,
}: {
  header?: string;
  text: string;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  const lineCount = useMemo(() => (header ? 0 : text.split("\n").length), [header, text]);

  return (
    <CodeWellFrame
      header={
        <Text
          style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: tokens.monoFont }}
          numberOfLines={1}
        >
          {header ?? plural(lineCount, "line")}
        </Text>
      }
      copyTextValue={text}
      copyToast="Copied output"
      theme={theme}
      tokens={tokens}
    >
      <View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
        <TruncatedText
          text={text}
          lineLimit={PREVIEW_LINE_LIMIT}
          textStyle={{
            color: theme.colors.foreground,
            fontSize: 11.5,
            lineHeight: 17,
            fontFamily: tokens.monoFont,
          }}
          theme={theme}
          tokens={tokens}
        />
      </View>
    </CodeWellFrame>
  );
}

function DiffWell({
  header,
  text,
  theme,
  tokens,
}: {
  header?: string;
  text: string;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const visibleLines =
    showAll || lines.length <= PREVIEW_LINE_LIMIT ? lines : lines.slice(0, PREVIEW_LINE_LIMIT);

  return (
    <CodeWellFrame
      header={
        <Text
          style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: tokens.monoFont }}
          numberOfLines={1}
        >
          {header ?? "Diff"}
        </Text>
      }
      copyTextValue={text}
      copyToast="Copied diff"
      theme={theme}
      tokens={tokens}
    >
      <View style={{ paddingVertical: 6 }}>
        {visibleLines.map((line, index) => {
          const isAdd = line.startsWith("+") && !line.startsWith("+++ ");
          const isDel = line.startsWith("-") && !line.startsWith("--- ");
          const isHunk = line.startsWith("@@");
          const bg = isAdd
            ? tokens.successSoft
            : isDel
              ? tokens.dangerSoft
              : isHunk
                ? tokens.accentSoft
                : "transparent";
          const fg = isAdd
            ? theme.colors.statusSuccess
            : isDel
              ? theme.colors.statusDanger
              : isHunk
                ? theme.colors.accent
                : theme.colors.foreground;
          return (
            <View key={index} style={{ backgroundColor: bg, paddingHorizontal: 10, paddingVertical: 1 }}>
              <Text
                selectable
                style={{
                  color: fg,
                  fontSize: 11.5,
                  lineHeight: 16.5,
                  fontFamily: tokens.monoFont,
                }}
              >
                {line.length === 0 ? " " : line}
              </Text>
            </View>
          );
        })}
        {lines.length > PREVIEW_LINE_LIMIT && (
          <View style={{ paddingHorizontal: 6, paddingTop: 2 }}>
            <ExpandableLinesToggle
              shownAll={showAll}
              onToggle={() => setShowAll((v) => !v)}
              expandLabel={`Show all ${lines.length} lines`}
              theme={theme}
              tokens={tokens}
            />
          </View>
        )}
      </View>
    </CodeWellFrame>
  );
}

function ShellWell({
  shell,
  fallbackText,
  theme,
  tokens,
}: {
  shell: ShellPayload;
  fallbackText: string;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  const hasExit = shell.exitCode !== undefined && shell.exitCode !== null;
  const exitOk = shell.exitCode === 0;

  return (
    <CodeWellFrame
      header={
        <View style={{ gap: 2 }}>
          {shell.command ? (
            <Text
              selectable
              style={{ color: theme.colors.foreground, fontSize: 11.5, fontFamily: tokens.monoFont }}
            >
              <Text style={{ color: theme.colors.accent }}>$ </Text>
              {shell.command}
            </Text>
          ) : (
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontFamily: tokens.monoFont,
              }}
            >
              Shell
            </Text>
          )}
          {shell.cwd && (
            <Text
              style={{
                color: withAlpha(theme.colors.foregroundMuted, 0.78),
                fontSize: 10.5,
                fontFamily: tokens.monoFont,
              }}
              numberOfLines={1}
            >
              {shortPath(shell.cwd)}
            </Text>
          )}
        </View>
      }
      trailing={
        hasExit ? (
          <View
            style={{
              paddingHorizontal: 6,
              paddingVertical: 1.5,
              borderRadius: 999,
              backgroundColor: exitOk ? tokens.successSoft : tokens.dangerSoft,
            }}
          >
            <Text
              style={{
                color: exitOk ? theme.colors.statusSuccess : theme.colors.statusDanger,
                fontSize: 10.5,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
              }}
            >
              exit {shell.exitCode}
            </Text>
          </View>
        ) : undefined
      }
      copyTextValue={fallbackText}
      copyToast="Copied command"
      hasBody={Boolean(shell.output)}
      theme={theme}
      tokens={tokens}
    >
      {shell.output ? (
        <View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
          <TruncatedText
            text={shell.output}
            lineLimit={PREVIEW_LINE_LIMIT}
            textStyle={{
              color: theme.colors.foregroundMuted,
              fontSize: 11.5,
              lineHeight: 16.5,
              fontFamily: tokens.monoFont,
            }}
            theme={theme}
            tokens={tokens}
          />
        </View>
      ) : null}
    </CodeWellFrame>
  );
}

function ReasoningWell({
  text,
  theme,
  tokens,
}: {
  text: string;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  return (
    <View
      style={{
        borderLeftWidth: 2,
        borderLeftColor: withAlpha(theme.colors.foregroundMuted, 0.35),
        paddingLeft: 10,
        paddingVertical: 2,
        gap: 4,
      }}
    >
      <TruncatedText
        text={text}
        lineLimit={REASONING_LINE_LIMIT}
        textStyle={{ color: theme.colors.foregroundMuted, fontSize: 12.5, lineHeight: 19 }}
        expandLabel={(total) => `Show full thought (${total} lines)`}
        theme={theme}
        tokens={tokens}
      />
    </View>
  );
}

function ItemUsageInline({
  itemUsage,
  compact,
  theme,
  tokens,
}: {
  itemUsage?: ItemUsageDisplay;
  compact?: boolean;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  if (!itemUsage) {
    return (
      <Text
        style={{
          color: withAlpha(theme.colors.foregroundMuted, 0.45),
          fontSize: 11,
          fontVariant: ["tabular-nums"],
        }}
      >
        —
      </Text>
    );
  }

  const { usage, inputOnly } = itemUsage;
  const tokensText = inputOnly
    ? `↓${formatTokens(usage.inputTokens)}`
    : `↓${formatTokens(usage.inputTokens)} ↑${formatTokens(usage.outputTokens)}`;
  const cacheRate = computeCacheHitRate(usage);
  const cacheText =
    cacheRate !== null
      ? compact
        ? formatCacheRate(cacheRate)
        : `${formatCacheRate(cacheRate)} cache`
      : "—";
  const highCache = cacheRate !== null && cacheRate >= 0.5;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 0 }}>
      <Text
        style={{
          color: withAlpha(theme.colors.foregroundMuted, 0.88),
          fontSize: 11,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
      >
        {tokensText}
      </Text>
      <View
        style={{
          paddingHorizontal: 5,
          paddingVertical: 1,
          borderRadius: 999,
          backgroundColor: highCache ? tokens.successSoft : tokens.subtlePillBg,
        }}
      >
        <Text
          style={{
            color: highCache
              ? theme.colors.statusSuccess
              : withAlpha(theme.colors.foregroundMuted, cacheRate !== null && cacheRate > 0 ? 0.92 : 0.72),
            fontSize: 10.5,
            fontWeight: highCache ? "600" : "500",
            fontVariant: ["tabular-nums"],
          }}
          numberOfLines={1}
        >
          {cacheText}
        </Text>
      </View>
    </View>
  );
}

export function ItemRow({
  entry,
  description,
  itemUsage,
  compact,
  theme,
  tokens,
  expanded,
  onToggle,
}: {
  entry: FeedEntry;
  description?: ItemDescription;
  itemUsage?: ItemUsageDisplay;
  compact?: boolean;
  theme: PluginTheme;
  tokens: ThingsTokens;
  expanded: boolean;
  onToggle: () => void;
}) {
  const computed = useMemo(() => (description ? undefined : describeEntry(entry)), [description, entry]);
  const d = description ?? computed!;
  const failed =
    entry.item.type === "error" ||
    (entry.item.type === "notification" && entry.item.level === "error") ||
    (entry.item.type === "tool_call" && entry.item.status === "failed");
  const warning = entry.item.type === "notification" && entry.item.level === "warning";

  if (entry.item.type === "compaction") {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 6,
          paddingHorizontal: 6,
        }}
      >
        <View style={{ flex: 1, height: tokens.hairline, backgroundColor: tokens.subtleBorder }} />
        <Icon name={d.icon} size={12} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontWeight: "500" }}>
          {d.label}
          {d.summary ? ` · ${d.summary}` : ""}
        </Text>
        <View style={{ flex: 1, height: tokens.hairline, backgroundColor: tokens.subtleBorder }} />
      </View>
    );
  }

  const iconColor = failed
    ? theme.colors.statusDanger
    : warning
      ? theme.colors.statusWarning
      : d.toolStatus === "running" || entry.item.type === "assistant_message"
        ? theme.colors.accent
        : theme.colors.foregroundMuted;
  const toolTone =
    d.toolStatus && d.toolStatus !== "completed" ? statusTone(d.toolStatus, theme, tokens) : null;
  const fallbackExpandedText = d.bodyHeader ?? d.summary;

  return (
    <View style={{ gap: 4 }}>
      <HoverPressable
        onPress={d.expandable ? onToggle : undefined}
        disabled={!d.expandable}
        accessibilityRole={d.expandable ? "button" : undefined}
        style={(state) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 6,
          paddingHorizontal: 8,
          borderRadius: 7,
          backgroundColor: d.expandable ? pressBg(state, tokens) : "transparent",
        })}
      >
        <Icon
          name={d.expandable ? (expanded ? "ChevronDown" : "ChevronRight") : "Minus"}
          size={12}
          color={withAlpha(theme.colors.foregroundMuted, d.expandable ? 0.75 : 0.35)}
        />
        <Icon name={d.icon} size={14} color={iconColor} />
        <Text
          numberOfLines={1}
          style={{
            color: failed ? theme.colors.statusDanger : theme.colors.foreground,
            fontSize: 13,
            fontWeight: entry.item.type === "assistant_message" ? "600" : "500",
            flexShrink: 1,
          }}
        >
          {d.label}
        </Text>

        {toolTone && (
          <View
            style={{
              paddingHorizontal: 5,
              paddingVertical: 1,
              borderRadius: 999,
              backgroundColor: toolTone.bg,
            }}
          >
            <Text style={{ color: toolTone.fg, fontSize: 10.5, fontWeight: "600" }}>
              {d.toolStatus}
            </Text>
          </View>
        )}

        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: d.summaryMono ? 11.5 : 12.5,
            fontFamily: d.summaryMono ? tokens.monoFont : undefined,
            flex: 1,
          }}
          numberOfLines={1}
        >
          {expanded ? "" : (d.summary ?? "")}
        </Text>

        <ItemUsageInline
          itemUsage={itemUsage}
          compact={compact}
          theme={theme}
          tokens={tokens}
        />

        <Text
          numberOfLines={1}
          style={{
            color: withAlpha(theme.colors.foregroundMuted, 0.72),
            fontSize: 11,
            fontVariant: ["tabular-nums"],
            flexShrink: 0,
          }}
        >
          {formatTimeOnly(entry.timestamp)}
        </Text>
      </HoverPressable>

      {expanded && (
        <View style={{ marginLeft: 28, marginRight: 4, marginBottom: 6, gap: 6 }}>
          {itemUsage && (
            <Text
              style={{
                color: withAlpha(theme.colors.foregroundMuted, 0.85),
                fontSize: 11,
                fontVariant: ["tabular-nums"],
              }}
            >
              {formatItemUsageDetail(itemUsage.usage, { inputOnly: itemUsage.inputOnly })}
            </Text>
          )}
          {d.errorText && (
            <CalloutBox
              tone="danger"
              icon="CircleAlert"
              text={d.errorText}
              mono
              theme={theme}
              tokens={tokens}
            />
          )}
          {d.bodyKind === "markdown" && d.body ? (
            <View style={{ gap: 4 }}>
              <Markdown>{d.body}</Markdown>
              <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                <CopyButton
                  text={d.body}
                  label="Copy"
                  toastMessage={`Copied ${d.label.toLowerCase()}`}
                  theme={theme}
                  tokens={tokens}
                />
              </View>
            </View>
          ) : d.bodyKind === "reasoning" && d.body ? (
            <ReasoningWell text={d.body} theme={theme} tokens={tokens} />
          ) : d.bodyKind === "shell" && d.shell ? (
            <ShellWell
              shell={d.shell}
              fallbackText={d.body ?? d.shell.command ?? ""}
              theme={theme}
              tokens={tokens}
            />
          ) : d.bodyKind === "diff" && d.body ? (
            <DiffWell header={d.bodyHeader} text={d.body} theme={theme} tokens={tokens} />
          ) : d.bodyKind === "todo" && d.todos ? (
            <View style={{ gap: 5, paddingVertical: 2 }}>
              {d.todos.map((task, idx) => (
                <View key={idx} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                  <View style={{ marginTop: 2 }}>
                    <Icon
                      name={task.completed ? "CheckCircle2" : "Circle"}
                      size={14}
                      color={
                        task.completed ? theme.colors.statusSuccess : theme.colors.foregroundMuted
                      }
                    />
                  </View>
                  <Text
                    style={{
                      color: task.completed
                        ? theme.colors.foregroundMuted
                        : theme.colors.foreground,
                      fontSize: 13,
                      lineHeight: 18,
                      flex: 1,
                      textDecorationLine: task.completed ? "line-through" : "none",
                    }}
                  >
                    {task.text}
                  </Text>
                </View>
              ))}
            </View>
          ) : d.bodyKind === "callout" && d.body ? (
            <CalloutBox
              tone={d.calloutTone ?? "info"}
              text={d.body}
              mono={d.calloutTone === "danger"}
              theme={theme}
              tokens={tokens}
            />
          ) : d.body ? (
            <MonoWell header={d.bodyHeader} text={d.body} theme={theme} tokens={tokens} />
          ) : !d.errorText && fallbackExpandedText ? (
            <Text
              selectable
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: d.summaryMono ? 11.5 : 12.5,
                fontFamily: d.summaryMono ? tokens.monoFont : undefined,
              }}
            >
              {fallbackExpandedText}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}
