import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme, RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { getAgentPrompt } from "../shared/prompt";
import type { ThingsTokens } from "./theme-utils";
import { withAlpha } from "./theme-utils";
import {
  CopyButton,
  ExpandableLinesToggle,
  HoverPressable,
  pressBg,
  TruncatedText,
} from "./things-ui";
import { formatClock, plural } from "./turn-model";

type PromptOutput = RpcOutput<typeof getAgentPrompt>;

const SECTION_LINE_LIMIT = 16;
const MESSAGE_LINE_LIMIT = 8;
const MESSAGE_CHAR_LIMIT = 400;
const INITIAL_TOOLS_LIMIT = 14;

function formatChars(len: number): string {
  if (len >= 1000) return `${(len / 1000).toFixed(1)}k chars`;
  return `${len} chars`;
}

/**
 * Provider-native prompt inspection for one turn. `at` pins the provider's
 * records to a moment in time: pass the turn's end so the snapshot reflects
 * the most complete request context that turn produced (omit while running).
 */
export function TurnPrompt({
  agentId,
  at,
  theme,
  tokens,
}: {
  agentId: string;
  at?: string;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  const getPrompt = useRpc(getAgentPrompt);
  const [open, setOpen] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
  const [messagesRequested, setMessagesRequested] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);

  const baseQuery = useQuery({
    queryKey: ["turnline-prompt", agentId, at ?? "latest", false],
    queryFn: () => getPrompt({ agentId, at, includeMessages: false }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const messagesQuery = useQuery({
    queryKey: ["turnline-prompt", agentId, at ?? "latest", true],
    queryFn: () => getPrompt({ agentId, at, includeMessages: true }),
    enabled: messagesRequested,
    staleTime: 15_000,
  });

  const result: PromptOutput | undefined =
    messagesQuery.data?.status === "ok" ? messagesQuery.data : baseQuery.data;
  const prompt = result?.status === "ok" ? result.prompt : undefined;
  const capturedLabel = prompt?.capturedAt ? formatClock(prompt.capturedAt) : "";

  const summary = useMemo(() => {
    if (!result) return baseQuery.isError ? "Unavailable" : "Loading…";
    if (result.status === "ok" && result.prompt) {
      const parts: string[] = [];
      if (result.provider) parts.push(result.provider);
      parts.push(plural(result.prompt.sections.length, "section"));
      if (result.prompt.tools?.length) {
        parts.push(plural(result.prompt.tools.length, "tool"));
      }
      if (result.prompt.model) parts.push(result.prompt.model);
      return parts.join(" · ");
    }
    return result.reason ?? result.status;
  }, [result, baseQuery.isError]);

  const visibleTools = useMemo(() => {
    if (!prompt?.tools) return [];
    return showAllTools ? prompt.tools : prompt.tools.slice(0, INITIAL_TOOLS_LIMIT);
  }, [prompt?.tools, showAllTools]);

  if (result?.status === "unsupported") return null;

  const toggleMessages = () => {
    const next = !showMessages;
    setShowMessages(next);
    if (next) {
      if (messagesRequested && (messagesQuery.isError || messagesQuery.data?.status !== "ok")) {
        void messagesQuery.refetch();
      } else {
        setMessagesRequested(true);
      }
    }
  };

  const unavailableMessage =
    result && result.status !== "ok"
      ? (result.reason ?? "Prompt inspection is not available for this provider.")
      : baseQuery.isError
        ? baseQuery.error instanceof Error
          ? baseQuery.error.message
          : "Prompt inspection failed."
        : undefined;

  const messagesError =
    messagesQuery.isError
      ? messagesQuery.error instanceof Error
        ? messagesQuery.error.message
        : "Unable to load context messages."
      : messagesQuery.data && messagesQuery.data.status !== "ok"
        ? (messagesQuery.data.reason ?? "Unable to load context messages.")
        : undefined;

  const metaParts: string[] = [];
  if (capturedLabel) metaParts.push(`Captured ${capturedLabel}`);
  if (prompt?.latestOnly && at) metaParts.push("Latest snapshot");

  return (
    <View style={{ gap: 4 }}>
      <HoverPressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        style={(state) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 6,
          paddingHorizontal: 8,
          borderRadius: 7,
          backgroundColor: pressBg(state, tokens),
        })}
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          size={12}
          color={withAlpha(theme.colors.foregroundMuted, 0.75)}
        />
        <Icon name="Layers" size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "500" }}>
          Prompt context
        </Text>
        <Text
          style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }}
          numberOfLines={1}
        >
          {summary}
        </Text>
      </HoverPressable>

      {open && prompt && (
        <View
          style={{
            marginLeft: 28,
            marginRight: 4,
            marginBottom: 6,
            backgroundColor: tokens.codeBg,
            borderRadius: 8,
            borderWidth: tokens.hairline,
            borderColor: tokens.subtleBorder,
            paddingHorizontal: 10,
            paddingVertical: 8,
            gap: 8,
          }}
        >
          {(prompt.model || metaParts.length > 0) && (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 6,
                paddingBottom: 6,
                borderBottomWidth: tokens.hairline,
                borderBottomColor: tokens.subtleBorder,
              }}
            >
              {prompt.model && (
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 11.5,
                    fontWeight: "600",
                    fontFamily: tokens.monoFont,
                  }}
                >
                  {prompt.model}
                </Text>
              )}
              {metaParts.length > 0 && (
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {prompt.model ? `· ${metaParts.join(" · ")}` : metaParts.join(" · ")}
                </Text>
              )}
            </View>
          )}

          {prompt.sections.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              No prompt sections recorded before this point.
            </Text>
          ) : (
            <View>
              {prompt.sections.map((section, index) => (
                <PromptSection
                  key={`${section.name}:${index}`}
                  name={section.name}
                  text={section.text}
                  first={index === 0}
                  theme={theme}
                  tokens={tokens}
                />
              ))}
            </View>
          )}

          {prompt.tools && prompt.tools.length > 0 && (
            <View
              style={{
                gap: 5,
                paddingTop: 6,
                borderTopWidth: tokens.hairline,
                borderTopColor: tokens.subtleBorder,
              }}
            >
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 11,
                  fontWeight: "500",
                }}
              >
                {prompt.toolsKind === "observed" ? "Tools called" : "Declared tools"} (
                {prompt.tools.length})
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                {visibleTools.map((tool) => (
                  <View
                    key={tool}
                    style={{
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 5,
                      backgroundColor: tokens.subtlePillBg,
                    }}
                  >
                    <Text
                      style={{
                        color: theme.colors.foreground,
                        fontSize: 11,
                        fontFamily: tokens.monoFont,
                      }}
                    >
                      {tool}
                    </Text>
                  </View>
                ))}
                {prompt.tools.length > INITIAL_TOOLS_LIMIT && (
                  <HoverPressable
                    onPress={() => setShowAllTools((v) => !v)}
                    accessibilityRole="button"
                    style={({ hovered }) => ({
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 5,
                      backgroundColor: hovered ? tokens.accentSoft : "transparent",
                    })}
                  >
                    <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "500" }}>
                      {showAllTools
                        ? "Show fewer"
                        : `+${prompt.tools.length - INITIAL_TOOLS_LIMIT} more`}
                    </Text>
                  </HoverPressable>
                )}
              </View>
            </View>
          )}

          {prompt.messageCount !== undefined && prompt.messageCount > 0 && (
            <View
              style={{
                paddingTop: 6,
                borderTopWidth: tokens.hairline,
                borderTopColor: tokens.subtleBorder,
                gap: 6,
              }}
            >
              <HoverPressable
                onPress={toggleMessages}
                accessibilityRole="button"
                style={({ hovered, pressed }) => ({
                  alignSelf: "flex-start",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingHorizontal: 6,
                  paddingVertical: 3,
                  borderRadius: 6,
                  backgroundColor: pressed
                    ? tokens.rowPressedBg
                    : hovered
                      ? tokens.accentSoft
                      : "transparent",
                })}
              >
                <Icon
                  name={showMessages ? "ChevronDown" : "ChevronRight"}
                  size={12}
                  color={theme.colors.accent}
                />
                <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "500" }}>
                  {showMessages
                    ? `Hide messages (${prompt.messageCount})`
                    : `Context messages (${prompt.messageCount})`}
                </Text>
              </HoverPressable>

              {showMessages && messagesQuery.isFetching && !prompt.messages && (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, marginLeft: 6 }}>
                  Loading messages…
                </Text>
              )}

              {showMessages && messagesError && !messagesQuery.isFetching && !prompt.messages && (
                <Text style={{ color: theme.colors.statusDanger, fontSize: 11.5, marginLeft: 6 }}>
                  {messagesError}
                </Text>
              )}

              {showMessages && prompt.messages && (
                <View>
                  {prompt.messages.map((message, index) => (
                    <ContextMessageRow
                      key={index}
                      role={message.role}
                      content={message.content}
                      at={message.at}
                      first={index === 0}
                      theme={theme}
                      tokens={tokens}
                    />
                  ))}
                </View>
              )}
            </View>
          )}
        </View>
      )}

      {open && !prompt && unavailableMessage && (
        <View
          style={{
            marginLeft: 28,
            marginRight: 4,
            marginBottom: 4,
            paddingHorizontal: 10,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: tokens.subtlePillBg,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {unavailableMessage}
          </Text>
        </View>
      )}
    </View>
  );
}

function PromptSection({
  name,
  text,
  first,
  theme,
  tokens,
}: {
  name: string;
  text: string;
  first: boolean;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  const [open, setOpen] = useState(false);

  return (
    <View
      style={{
        borderTopWidth: first ? 0 : tokens.hairline,
        borderTopColor: tokens.subtleBorder,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 4,
          gap: 4,
        }}
      >
        <HoverPressable
          onPress={() => setOpen((v) => !v)}
          accessibilityRole="button"
          style={(state) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            flex: 1,
            paddingHorizontal: 4,
            paddingVertical: 3,
            borderRadius: 5,
            backgroundColor: pressBg(state, tokens),
          })}
        >
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            size={12}
            color={theme.colors.foregroundMuted}
          />
          <Text
            style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "500", flex: 1 }}
            numberOfLines={1}
          >
            {name}
          </Text>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 10.5,
              fontVariant: ["tabular-nums"],
            }}
          >
            {formatChars(text.length)}
          </Text>
        </HoverPressable>
        <CopyButton text={text} toastMessage={`Copied "${name}"`} theme={theme} tokens={tokens} />
      </View>

      {open && (
        <View style={{ paddingLeft: 20, paddingRight: 4, paddingBottom: 8, gap: 4 }}>
          <TruncatedText
            text={text}
            lineLimit={SECTION_LINE_LIMIT}
            textStyle={{
              color: theme.colors.foreground,
              fontSize: 11.5,
              lineHeight: 16.5,
              fontFamily: tokens.monoFont,
            }}
            theme={theme}
            tokens={tokens}
          />
        </View>
      )}
    </View>
  );
}

function ContextMessageRow({
  role,
  content,
  at,
  first,
  theme,
  tokens,
}: {
  role: string;
  content: string;
  at?: string;
  first: boolean;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => content.split("\n"), [content]);
  const isLong = lines.length > MESSAGE_LINE_LIMIT || content.length > MESSAGE_CHAR_LIMIT;
  const visibleContent =
    expanded || !isLong
      ? content
      : lines.length > MESSAGE_LINE_LIMIT
        ? lines.slice(0, MESSAGE_LINE_LIMIT).join("\n")
        : `${content.slice(0, MESSAGE_CHAR_LIMIT)}…`;

  const atLabel = formatClock(at);
  const roleLower = role.toLowerCase();
  const roleFg =
    roleLower === "system"
      ? theme.colors.accent
      : roleLower === "assistant"
        ? theme.colors.statusSuccess
        : theme.colors.foregroundMuted;

  return (
    <View
      style={{
        borderTopWidth: first ? 0 : tokens.hairline,
        borderTopColor: tokens.subtleBorder,
        paddingVertical: 7,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text
          style={{
            color: roleFg,
            fontSize: 10.5,
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          {role}
        </Text>
        {atLabel ? (
          <Text
            style={{
              color: withAlpha(theme.colors.foregroundMuted, 0.78),
              fontSize: 10.5,
              fontVariant: ["tabular-nums"],
            }}
          >
            {atLabel}
          </Text>
        ) : null}
        <View style={{ flex: 1 }} />
        <CopyButton text={content} toastMessage="Copied message" theme={theme} tokens={tokens} />
      </View>

      <Text
        selectable
        style={{
          color: theme.colors.foreground,
          fontSize: 11.5,
          lineHeight: 16.5,
          fontFamily: tokens.monoFont,
        }}
        numberOfLines={!expanded && isLong ? MESSAGE_LINE_LIMIT : undefined}
      >
        {visibleContent}
      </Text>
      {isLong && (
        <ExpandableLinesToggle
          shownAll={expanded}
          onToggle={() => setExpanded((v) => !v)}
          expandLabel={
            lines.length > MESSAGE_LINE_LIMIT
              ? `Show all ${lines.length} lines`
              : "Show full message"
          }
          theme={theme}
          tokens={tokens}
        />
      )}
    </View>
  );
}
