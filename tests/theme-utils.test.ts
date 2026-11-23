import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginTheme } from "@getpaseo/plugin";
import { createThingsTokens, isDarkSurface, withAlpha } from "../client/theme-utils";

const mockTheme = (surface0: string): PluginTheme => ({
  colors: {
    surface0,
    surface1: "#18181b",
    surface2: "#27272a",
    foreground: "#fafafa",
    foregroundMuted: "#a1a1aa",
    border: "#3f3f46",
    accent: "#3b82f6",
    statusSuccess: "#22c55e",
    statusDanger: "#ef4444",
    statusWarning: "#f59e0b",
  } as PluginTheme["colors"],
} as PluginTheme);

describe("theme-utils", () => {
  it("converts valid hex and rgb colors with alpha", () => {
    assert.equal(withAlpha("#fff", 0.5), "rgba(255, 255, 255, 0.5)");
    assert.equal(withAlpha("#0f8a", 0.25), "rgba(0, 255, 136, 0.25)");
    assert.equal(withAlpha("#3b82f6", 0.2), "rgba(59, 130, 246, 0.2)");
    assert.equal(withAlpha("#3b82f6ff", 2), "rgba(59, 130, 246, 1)");
    assert.equal(withAlpha("rgb(10, 20, 30)", -0.5), "rgba(10, 20, 30, 0)");
    assert.equal(withAlpha("rgba(300, 20, 30, 0.8)", 0.4), "rgba(255, 20, 30, 0.4)");
    assert.equal(withAlpha("rgb(10 20 30 / 50%)", 0.7), "rgba(10, 20, 30, 0.7)");
  });

  it("rejects malformed hex, rgb, and non-finite alpha gracefully", () => {
    assert.equal(withAlpha("#1g2", 0.5), "#1g2");
    assert.equal(withAlpha("#12zz34", 0.5), "#12zz34");
    assert.equal(withAlpha("#12", 0.5), "#12");
    assert.equal(withAlpha("rgb(10, 20, 30", 0.5), "rgb(10, 20, 30");
    assert.equal(withAlpha("rgba(10, 20, 30, ...)", 0.5), "rgba(10, 20, 30, ...)");
    assert.equal(withAlpha("hsl(200, 50%, 50%)", 0.5), "hsl(200, 50%, 50%)");
    assert.equal(withAlpha("#ffffff", Number.NaN), "#ffffff");
  });

  it("detects dark vs light surfaces", () => {
    assert.equal(isDarkSurface("#09090b"), true);
    assert.equal(isDarkSurface("#ffffff"), false);
    assert.equal(isDarkSurface("not-a-color"), false);
  });

  it("builds platform-appropriate monospace fonts and theme tokens", () => {
    const darkIos = createThingsTokens(mockTheme("#09090b"), "ios");
    assert.equal(darkIos.monoFont, "Menlo");
    assert.equal(darkIos.accentSoft, "rgba(59, 130, 246, 0.16)");

    const lightAndroid = createThingsTokens(mockTheme("#ffffff"), "android");
    assert.equal(lightAndroid.monoFont, "monospace");
    assert.equal(lightAndroid.accentSoft, "rgba(59, 130, 246, 0.1)");

    const web = createThingsTokens(mockTheme("#ffffff"), "web");
    assert.match(web.monoFont, /monospace/);
  });
});
