import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Pressable,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";
import type { ThingsTokens } from "./theme-utils";
import { withAlpha } from "./theme-utils";
import type { TurnStatus } from "./turn-model";

interface HoverState {
  pressed: boolean;
  hovered: boolean;
}

export function pressBg(
  state: HoverState,
  tokens: ThingsTokens,
  base = "transparent",
): string {
  return state.pressed ? tokens.rowPressedBg : state.hovered ? tokens.rowHoverBg : base;
}

export function statusTone(
  status: TurnStatus,
  theme: PluginTheme,
  tokens: ThingsTokens,
): { fg: string; bg: string } {
  switch (status) {
    case "running":
      return { fg: theme.colors.accent, bg: tokens.accentSoft };
    case "completed":
      return { fg: theme.colors.statusSuccess, bg: tokens.successSoft };
    case "failed":
      return { fg: theme.colors.statusDanger, bg: tokens.dangerSoft };
    case "canceled":
      return { fg: theme.colors.statusWarning, bg: tokens.warningSoft };
    default:
      return { fg: theme.colors.foregroundMuted, bg: tokens.subtlePillBg };
  }
}

export function HoverPressable({
  style,
  children,
  ...rest
}: Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle> | ((state: HoverState) => StyleProp<ViewStyle>);
  children?: ReactNode;
}) {
  return (
    <Pressable
      {...rest}
      style={
        typeof style === "function"
          ? (raw) =>
              style({
                pressed: raw.pressed,
                hovered: Boolean((raw as { hovered?: boolean }).hovered),
              })
          : style
      }
    >
      {children}
    </Pressable>
  );
}

function RunningStatusGlyph({
  theme,
  tokens,
  size,
}: {
  theme: PluginTheme;
  tokens: ThingsTokens;
  size: number;
}) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.out(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 300,
          easing: Easing.in(Easing.ease),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(0);
    };
  }, [pulse]);

  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.55] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.42, 0.14, 0] });
  const coreSize = Math.max(5, Math.round(size * 0.36));

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        style={{
          position: "absolute",
          width: size - 2,
          height: size - 2,
          borderRadius: size / 2,
          backgroundColor: theme.colors.accent,
          opacity: haloOpacity,
          transform: [{ scale: haloScale }],
        }}
      />
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderColor: theme.colors.accent,
          backgroundColor: tokens.accentSoft,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            width: coreSize,
            height: coreSize,
            borderRadius: 999,
            backgroundColor: theme.colors.accent,
          }}
        />
      </View>
    </View>
  );
}

/**
 * Things 3-inspired circular status glyph.
 * Running turns animate a gentle pulsing halo around the accent core.
 */
export function StatusGlyph({
  status,
  theme,
  tokens,
  size = 16,
}: {
  status: TurnStatus;
  theme: PluginTheme;
  tokens: ThingsTokens;
  size?: number;
}) {
  if (status === "running") {
    return <RunningStatusGlyph theme={theme} tokens={tokens} size={size} />;
  }

  if (status === "open") {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.25,
          borderStyle: "dashed",
          borderColor: withAlpha(theme.colors.foregroundMuted, 0.65),
        }}
      />
    );
  }

  const badge =
    status === "completed"
      ? {
          icon: "Check",
          color: theme.colors.statusSuccess,
          bg: tokens.successSoft,
          borderAlpha: 0.65,
          iconScale: 0.62,
        }
      : status === "failed"
        ? {
            icon: "X",
            color: theme.colors.statusDanger,
            bg: tokens.dangerSoft,
            borderAlpha: 0.7,
            iconScale: 0.62,
          }
        : {
            icon: "Minus",
            color: theme.colors.statusWarning,
            bg: tokens.warningSoft,
            borderAlpha: 0.7,
            iconScale: 0.6,
          };

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.25,
        borderColor: withAlpha(badge.color, badge.borderAlpha),
        backgroundColor: badge.bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={badge.icon} size={Math.round(size * badge.iconScale)} color={badge.color} />
    </View>
  );
}

/**
 * Things 3 hairline filter tag pill.
 * Quiet and understated when inactive; softly tinted with a subtle hairline ring when selected.
 */
export function TagPill({
  label,
  selected,
  tone = "accent",
  dotColor,
  count,
  theme,
  tokens,
  onPress,
}: {
  label: string;
  selected: boolean;
  tone?: "accent" | "danger";
  dotColor?: string;
  count?: number;
  theme: PluginTheme;
  tokens: ThingsTokens;
  onPress: () => void;
}) {
  const activeColor = tone === "danger" ? theme.colors.statusDanger : theme.colors.accent;
  const activeBg = tone === "danger" ? tokens.dangerSoft : tokens.accentSoft;
  const activeBorder = tone === "danger" ? tokens.dangerBorder : tokens.accentBorder;

  return (
    <HoverPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? activeBorder : tokens.subtleBorder,
        backgroundColor: selected ? activeBg : pressBg(state, tokens),
      })}
    >
      {dotColor && (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor }} />
      )}
      <Text
        style={{
          color: selected ? activeColor : theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: selected ? "600" : "500",
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {count !== undefined && count > 0 && (
        <Text
          style={{
            color: selected
              ? withAlpha(activeColor, 0.85)
              : withAlpha(theme.colors.foregroundMuted, 0.72),
            fontSize: 11,
            fontVariant: ["tabular-nums"],
          }}
        >
          {count}
        </Text>
      )}
    </HoverPressable>
  );
}

/**
 * Things 3 Logbook-style date / group section heading with a delicate hairline rule.
 */
export function SectionHeading({
  label,
  count,
  liveCount,
  first,
  theme,
  tokens,
}: {
  label: string;
  count: number;
  liveCount?: number;
  first?: boolean;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "baseline",
        justifyContent: "space-between",
        paddingTop: first ? 6 : 20,
        paddingBottom: 6,
        paddingHorizontal: 8,
        marginBottom: 4,
        borderBottomWidth: tokens.hairline,
        borderBottomColor: tokens.subtleBorder,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            fontWeight: "700",
            letterSpacing: -0.1,
          }}
        >
          {label}
        </Text>
        {liveCount !== undefined && liveCount > 0 && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingHorizontal: 6,
              paddingVertical: 1.5,
              borderRadius: 999,
              backgroundColor: tokens.accentSoft,
            }}
          >
            <View
              style={{
                width: 5,
                height: 5,
                borderRadius: 3,
                backgroundColor: theme.colors.accent,
              }}
            />
            <Text style={{ color: theme.colors.accent, fontSize: 10.5, fontWeight: "600" }}>
              {liveCount === 1 ? "Live" : `${liveCount} live`}
            </Text>
          </View>
        )}
      </View>
      <Text
        style={{
          color: withAlpha(theme.colors.foregroundMuted, 0.75),
          fontSize: 11.5,
          fontWeight: "500",
          fontVariant: ["tabular-nums"],
        }}
      >
        {count}
      </Text>
    </View>
  );
}

/**
 * Subtle Things-style segmented sort control.
 */
export function SegmentedSort({
  value,
  theme,
  tokens,
  onChange,
}: {
  value: "newest" | "oldest";
  theme: PluginTheme;
  tokens: ThingsTokens;
  onChange: (next: "newest" | "oldest") => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: tokens.subtlePillBg,
        borderRadius: 8,
        padding: 2,
        borderWidth: tokens.hairline,
        borderColor: tokens.subtleBorder,
      }}
    >
      {(["newest", "oldest"] as const).map((option) => {
        const selected = value === option;
        return (
          <HoverPressable
            key={option}
            onPress={() => onChange(option)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ hovered }) => ({
              paddingHorizontal: 9,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: selected
                ? theme.colors.surface1
                : hovered
                  ? tokens.rowHoverBg
                  : "transparent",
              ...(selected
                ? {
                    shadowColor: "#000000",
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: tokens.dark ? 0.25 : 0.06,
                    shadowRadius: 2,
                    elevation: 1,
                  }
                : null),
            })}
          >
            <Text
              style={{
                color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                fontSize: 12,
                fontWeight: selected ? "600" : "500",
              }}
            >
              {option === "newest" ? "Newest" : "Oldest"}
            </Text>
          </HoverPressable>
        );
      })}
    </View>
  );
}

/**
 * Quiet copy icon/pill button with inline confirmation tick and toast feedback.
 */
export function CopyButton({
  text,
  label,
  toastMessage = "Copied to clipboard",
  theme,
  tokens,
}: {
  text: string | (() => string);
  label?: string;
  toastMessage?: string;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = () => {
    const value = typeof text === "function" ? text() : text;
    void copyText(value)
      .then(() => {
        if (!mountedRef.current) return;
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          if (mountedRef.current) setCopied(false);
        }, 1500);
        toast.show(toastMessage, { variant: "success", durationMs: 1600 });
      })
      .catch(() => {
        if (!mountedRef.current) return;
        toast.error("Unable to copy to clipboard");
      });
  };

  return (
    <HoverPressable
      onPress={handleCopy}
      accessibilityRole="button"
      accessibilityLabel={label ?? "Copy"}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: label ? 7 : 5,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: pressBg(state, tokens),
      })}
    >
      <Icon
        name={copied ? "Check" : "Copy"}
        size={12}
        color={copied ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
      />
      {label && (
        <Text
          style={{
            color: copied ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
            fontSize: 11.5,
            fontWeight: "500",
          }}
        >
          {copied ? "Copied" : label}
        </Text>
      )}
    </HoverPressable>
  );
}

/**
 * Shared line-expansion toggle used across code wells, reasoning, and prompt sections.
 */
export function ExpandableLinesToggle({
  shownAll,
  onToggle,
  expandLabel,
  theme,
  tokens,
}: {
  shownAll: boolean;
  onToggle: () => void;
  expandLabel: string;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  return (
    <HoverPressable
      onPress={onToggle}
      accessibilityRole="button"
      style={(state) => ({
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        marginTop: 4,
        backgroundColor: pressBg(state, tokens),
      })}
    >
      <Icon
        name={shownAll ? "ChevronUp" : "ChevronDown"}
        size={12}
        color={theme.colors.accent}
      />
      <Text style={{ color: theme.colors.accent, fontSize: 11.5, fontWeight: "500" }}>
        {shownAll ? "Show less" : expandLabel}
      </Text>
    </HoverPressable>
  );
}

/**
 * Selectable text that previews up to `lineLimit` lines with an inline expand toggle.
 */
export function TruncatedText({
  text,
  lineLimit,
  textStyle,
  expandLabel,
  theme,
  tokens,
}: {
  text: string;
  lineLimit: number;
  textStyle: StyleProp<TextStyle>;
  expandLabel?: (totalLines: number) => string;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const isTruncated = lines.length > lineLimit;
  const visible = showAll || !isTruncated ? text : lines.slice(0, lineLimit).join("\n");

  return (
    <>
      <Text selectable style={textStyle}>
        {visible}
      </Text>
      {isTruncated && (
        <ExpandableLinesToggle
          shownAll={showAll}
          onToggle={() => setShowAll((v) => !v)}
          expandLabel={expandLabel ? expandLabel(lines.length) : `Show all ${lines.length} lines`}
          theme={theme}
          tokens={tokens}
        />
      )}
    </>
  );
}

/**
 * Shared rounded monospace/diff/shell frame with header bar and copy action.
 */
export function CodeWellFrame({
  header,
  trailing,
  copyTextValue,
  copyToast,
  hasBody = true,
  theme,
  tokens,
  children,
}: {
  header: ReactNode;
  trailing?: ReactNode;
  copyTextValue: string;
  copyToast: string;
  hasBody?: boolean;
  theme: PluginTheme;
  tokens: ThingsTokens;
  children?: ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: tokens.codeBg,
        borderRadius: 8,
        borderWidth: tokens.hairline,
        borderColor: tokens.subtleBorder,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: 10,
          paddingRight: 4,
          paddingVertical: 4,
          borderBottomWidth: hasBody ? tokens.hairline : 0,
          borderBottomColor: tokens.subtleBorder,
          gap: 8,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>{header}</View>
        {trailing}
        <CopyButton text={copyTextValue} toastMessage={copyToast} theme={theme} tokens={tokens} />
      </View>
      {children}
    </View>
  );
}

/**
 * Shared tonal callout box for errors, warnings, and notes.
 */
export function CalloutBox({
  tone,
  text,
  icon,
  mono,
  numberOfLines,
  style,
  theme,
  tokens,
}: {
  tone: "danger" | "warning" | "info";
  text: string;
  icon?: string;
  mono?: boolean;
  numberOfLines?: number;
  style?: StyleProp<ViewStyle>;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  const palette =
    tone === "danger"
      ? { bg: tokens.dangerSoft, border: tokens.dangerBorder, fg: theme.colors.statusDanger }
      : tone === "warning"
        ? { bg: tokens.warningSoft, border: tokens.warningBorder, fg: theme.colors.statusWarning }
        : { bg: tokens.accentSoft, border: tokens.accentBorder, fg: theme.colors.foreground };

  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: 8,
          backgroundColor: palette.bg,
          borderWidth: tokens.hairline,
          borderColor: palette.border,
        },
        style,
      ]}
    >
      {icon && (
        <View style={{ marginTop: 1 }}>
          <Icon name={icon} size={14} color={palette.fg} />
        </View>
      )}
      <Text
        selectable={!numberOfLines}
        numberOfLines={numberOfLines}
        style={{
          color: palette.fg,
          fontSize: 12,
          lineHeight: 18,
          flex: 1,
          fontFamily: mono ? tokens.monoFont : undefined,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

/**
 * Subtle Things-style horizontal fill bar for context window utilization.
 */
export function TinyProgressBar({
  ratio,
  theme,
  tokens,
}: {
  ratio: number;
  theme: PluginTheme;
  tokens: ThingsTokens;
}) {
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const fillColor =
    clamped > 0.85
      ? theme.colors.statusDanger
      : clamped > 0.65
        ? theme.colors.statusWarning
        : theme.colors.accent;
  return (
    <View
      style={{
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: tokens.subtlePillBg,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${Math.round(clamped * 100)}%`,
          height: "100%",
          borderRadius: 2,
          backgroundColor: fillColor,
        }}
      />
    </View>
  );
}
