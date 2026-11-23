import { StyleSheet, type ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^[0-9a-f]+$/i;
const RGB_RE =
  /^rgba?\(\s*(\d+(?:\.\d+)?)\s*(?:,\s*|\s+)(\d+(?:\.\d+)?)\s*(?:,\s*|\s+)(\d+(?:\.\d+)?)(?:\s*(?:,|\/)\s*(?:\d+(?:\.\d+)?|\.\d+)%?)?\s*\)$/i;

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseColor(color: string): Rgb | null {
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (!HEX_RE.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    }
    return null;
  }

  const rgbMatch = trimmed.match(RGB_RE);
  if (rgbMatch) {
    return {
      r: clampChannel(Number(rgbMatch[1])),
      g: clampChannel(Number(rgbMatch[2])),
      b: clampChannel(Number(rgbMatch[3])),
    };
  }
  return null;
}

/**
 * Safely produces an rgba() tint from a PluginTheme color token.
 * Falls back to the raw color if the token uses an unsupported CSS format.
 */
export function withAlpha(color: string, alpha: number): string {
  if (!Number.isFinite(alpha)) return color;
  const rgb = parseColor(color);
  if (!rgb) return color;
  const clamped = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamped})`;
}

/** Rough perceived luminance check to tune subtle Things-style paper elevation in light vs dark themes. */
export function isDarkSurface(color: string): boolean {
  const rgb = parseColor(color);
  if (!rgb) return false;
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance < 0.5;
}

export interface ThingsTokens {
  hairline: number;
  monoFont: string;
  accentSoft: string;
  accentBorder: string;
  successSoft: string;
  dangerSoft: string;
  dangerBorder: string;
  warningSoft: string;
  warningBorder: string;
  rowHoverBg: string;
  rowPressedBg: string;
  subtlePillBg: string;
  subtleBorder: string;
  codeBg: string;
  cardShadow: ViewStyle;
}

export function createThingsTokens(
  theme: PluginTheme,
  platform: "ios" | "android" | "web",
): ThingsTokens {
  const dark = isDarkSurface(theme.colors.surface0);
  const c = theme.colors;
  const monoFont =
    platform === "ios"
      ? "Menlo"
      : platform === "android"
        ? "monospace"
        : "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

  return {
    hairline: StyleSheet.hairlineWidth,
    monoFont,
    accentSoft: withAlpha(c.accent, dark ? 0.16 : 0.1),
    accentBorder: withAlpha(c.accent, dark ? 0.36 : 0.28),
    successSoft: withAlpha(c.statusSuccess, dark ? 0.16 : 0.11),
    dangerSoft: withAlpha(c.statusDanger, dark ? 0.16 : 0.1),
    dangerBorder: withAlpha(c.statusDanger, dark ? 0.36 : 0.26),
    warningSoft: withAlpha(c.statusWarning, dark ? 0.16 : 0.11),
    warningBorder: withAlpha(c.statusWarning, dark ? 0.36 : 0.28),
    rowHoverBg: withAlpha(c.foreground, dark ? 0.045 : 0.032),
    rowPressedBg: withAlpha(c.foreground, dark ? 0.08 : 0.055),
    subtlePillBg: withAlpha(c.foreground, dark ? 0.06 : 0.045),
    subtleBorder: withAlpha(c.border, dark ? 0.85 : 0.9),
    codeBg: dark ? withAlpha(c.surface0, 0.72) : withAlpha(c.surface2, 0.55),
    cardShadow: {
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: dark ? 6 : 4 },
      shadowOpacity: dark ? 0.28 : 0.08,
      shadowRadius: dark ? 16 : 12,
      elevation: dark ? 4 : 2,
    },
  };
}
