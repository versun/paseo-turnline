import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTurnSummaryText,
  computeTurnCounts,
  filterTurns,
  formatClock,
  formatCost,
  formatDayHeading,
  formatDuration,
  formatTimeOnly,
  formatTokens,
  formatToolError,
  groupTurns,
  groupTurnsByDay,
  itemIdentity,
  mergeUsage,
  normalizeInlineText,
  plural,
  sortTurns,
  stepKeyForEntry,
  summarizeTurn,
  turnDurationMs,
  turnMatchesQuery,
  type FeedEntry,
  type Turn,
  type TurnMeta,
} from "../client/turn-model";

function entry(
  seq: number,
  timestamp: string,
  item: FeedEntry["item"],
  turnId?: string,
): FeedEntry {
  return { seq, timestamp, item, turnId };
}

describe("turn-model helpers", () => {
  it("pluralizes counts", () => {
    assert.equal(plural(0, "turn"), "0 turns");
    assert.equal(plural(1, "turn"), "1 turn");
    assert.equal(plural(2, "thought"), "2 thoughts");
    assert.equal(plural(1, "entry", "entries"), "1 entry");
    assert.equal(plural(3, "entry", "entries"), "3 entries");
  });

  it("extracts stable itemIdentity and stepKeyForEntry", () => {
    const tool = entry(5, "2026-01-01T00:00:00Z", {
      type: "tool_call",
      callId: "call-1",
      name: "bash",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "ls" },
    });
    const plugin = entry(6, "2026-01-01T00:00:01Z", {
      type: "plugin",
      id: "p1",
      pluginId: "demo",
      kind: "note",
      version: 1,
      data: {},
    });
    const text = entry(7, "2026-01-01T00:00:02Z", {
      type: "assistant_message",
      text: "hello",
    });

    assert.equal(itemIdentity(tool.item), "tool:call-1");
    assert.equal(stepKeyForEntry(tool, 0), "tool:call-1");
    assert.equal(itemIdentity(plugin.item), "plugin:demo/p1");
    assert.equal(stepKeyForEntry(plugin, 1), "plugin:demo/p1");
    assert.equal(itemIdentity(text.item), null);
    assert.equal(stepKeyForEntry(text, 2), "7:2");
  });

  it("formats tool errors safely", () => {
    assert.equal(formatToolError(null), undefined);
    assert.equal(formatToolError(undefined), undefined);
    assert.equal(formatToolError("   "), undefined);
    assert.equal(formatToolError("ENOENT"), "ENOENT");
    assert.equal(formatToolError({ message: "permission denied" }), "permission denied");
    assert.equal(formatToolError({ code: 403 }), '{\n  "code": 403\n}');
  });

  it("merges usage without clobbering defined fields with undefined or non-finite values", () => {
    const merged = mergeUsage(
      { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.02 },
      { inputTokens: 200, outputTokens: Number.NaN, totalCostUsd: undefined, cachedInputTokens: 40 },
    );
    assert.deepEqual(merged, {
      inputTokens: 200,
      outputTokens: 50,
      totalCostUsd: 0.02,
      cachedInputTokens: 40,
    });
  });
});

describe("groupTurns", () => {
  it("groups entries by provider turnId and applies metadata", () => {
    const entries: FeedEntry[] = [
      entry(2, "2026-01-01T10:00:05Z", { type: "assistant_message", text: "Done" }, "t1"),
      entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "Fix bug" }, "t1"),
      entry(3, "2026-01-01T10:01:00Z", { type: "user_message", text: "Next" }, "t2"),
    ];
    const meta = new Map<string, TurnMeta>([
      ["t1", { status: "completed", usage: { inputTokens: 10, outputTokens: 5 } }],
      ["t2", { status: "failed", error: "rate limit" }],
    ]);

    const turns = groupTurns("a1", entries, meta, false);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].key, "a1:t1");
    assert.equal(turns[0].kind, "turn");
    assert.equal(turns[0].prompt, "Fix bug");
    assert.equal(turns[0].startedAt, "2026-01-01T10:00:00Z");
    assert.equal(turns[0].endedAt, "2026-01-01T10:00:05Z");
    assert.equal(turns[0].status, "completed");
    assert.deepEqual(turns[0].usage, { inputTokens: 10, outputTokens: 5 });

    assert.equal(turns[1].key, "a1:t2");
    assert.equal(turns[1].status, "failed");
    assert.equal(turns[1].error, "rate limit");
  });

  it("segments turnId-less entries by prompt and forms a leading open group", () => {
    const entries: FeedEntry[] = [
      entry(1, "2026-01-01T10:00:00Z", { type: "notification", level: "info", message: "Started" }),
      entry(2, "2026-01-01T10:00:01Z", { type: "user_message", text: "First prompt" }),
      entry(3, "2026-01-01T10:00:03Z", { type: "assistant_message", text: "First reply" }),
      entry(4, "2026-01-01T10:00:10Z", { type: "user_message", text: "Second prompt" }),
    ];

    const turns = groupTurns("a1", entries, new Map(), true);
    assert.equal(turns.length, 3);
    assert.equal(turns[0].kind, "lead");
    assert.equal(turns[0].status, "open");
    assert.equal(turns[1].kind, "prompt");
    assert.equal(turns[1].status, "completed");
    assert.equal(turns[2].kind, "prompt");
    assert.equal(turns[2].status, "running");
  });

  it("starts a new turn when a prompt without turnId follows a turn with turnId", () => {
    const entries: FeedEntry[] = [
      entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "Turn 1" }, "t1"),
      entry(2, "2026-01-01T10:00:02Z", { type: "assistant_message", text: "Reply 1" }, "t1"),
      entry(3, "2026-01-01T10:00:05Z", { type: "user_message", text: "Turn 2 no id" }),
      entry(4, "2026-01-01T10:00:08Z", { type: "assistant_message", text: "Reply 2" }),
    ];

    const turns = groupTurns("a1", entries, new Map(), false);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].prompt, "Turn 1");
    assert.equal(turns[0].items.length, 2);
    assert.equal(turns[1].prompt, "Turn 2 no id");
    assert.equal(turns[1].items.length, 2);
  });

  it("keeps Turn.key stable when older turns are prepended", () => {
    const later: FeedEntry[] = [
      entry(100, "2026-01-01T10:05:00Z", { type: "user_message", text: "Later" }),
      entry(101, "2026-01-01T10:05:05Z", { type: "assistant_message", text: "Reply" }),
    ];
    const earlier: FeedEntry[] = [
      entry(10, "2026-01-01T10:00:00Z", { type: "user_message", text: "Earlier" }),
    ];

    const beforeLoadOlder = groupTurns("a1", later, new Map(), false);
    const afterLoadOlder = groupTurns("a1", [...earlier, ...later], new Map(), false);

    assert.equal(afterLoadOlder.length, 2);
    assert.equal(afterLoadOlder[1].key, beforeLoadOlder[0].key);
  });

  it("disambiguates duplicate non-adjacent turnIds", () => {
    const entries: FeedEntry[] = [
      entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "A" }, "dup"),
      entry(2, "2026-01-01T10:01:00Z", { type: "user_message", text: "B" }, "mid"),
      entry(3, "2026-01-01T10:02:00Z", { type: "user_message", text: "C" }, "dup"),
    ];
    const turns = groupTurns("a1", entries, new Map(), false);
    assert.deepEqual(
      turns.map((t) => t.key),
      ["a1:dup", "a1:mid", "a1:dup#1"],
    );
  });
});

describe("sorting, counting, filtering, and day grouping", () => {
  it("sorts timestamps numerically across timezones and fractional seconds", () => {
    const mkTurn = (key: string, startedAt?: string, firstSeq = 1): Turn => ({
      key,
      agentId: "a1",
      kind: "turn",
      status: "completed",
      startedAt,
      firstSeq,
      items: [],
    });

    const tEarlyTz = mkTurn("early-tz", "2026-01-01T10:00:00+08:00"); // 02:00:00Z
    const tWholeSec = mkTurn("whole-sec", "2026-01-01T03:00:00Z"); // 03:00:00.000Z
    const tFracSec = mkTurn("frac-sec", "2026-01-01T03:00:00.123Z"); // 03:00:00.123Z
    const tMissing = mkTurn("missing", undefined, 0);

    const oldest = sortTurns([tFracSec, tWholeSec, tEarlyTz, tMissing], "oldest");
    assert.deepEqual(
      oldest.map((t) => t.key),
      ["missing", "early-tz", "whole-sec", "frac-sec"],
    );

    const newest = sortTurns([tFracSec, tWholeSec, tEarlyTz, tMissing], "newest");
    assert.deepEqual(
      newest.map((t) => t.key),
      ["frac-sec", "whole-sec", "early-tz", "missing"],
    );
  });

  it("computes counts safely even with NaN usage fields", () => {
    const turns: Turn[] = [
      {
        key: "1",
        agentId: "a1",
        kind: "turn",
        status: "running",
        firstSeq: 1,
        items: [],
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.01 },
      },
      {
        key: "2",
        agentId: "a1",
        kind: "turn",
        status: "failed",
        firstSeq: 2,
        items: [],
        usage: { inputTokens: Number.NaN, outputTokens: 25, totalCostUsd: Number.NaN },
      },
    ];
    const counts = computeTurnCounts(turns);
    assert.deepEqual(counts, {
      total: 2,
      running: 1,
      failed: 1,
      tokensTotal: 175,
      costTotal: 0.01,
    });
  });

  it("filters turns by status and query across agent title and failed tool errors", () => {
    const t1: Turn = {
      key: "a1:1",
      agentId: "a1",
      kind: "turn",
      status: "failed",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T00:00:00Z", {
          type: "tool_call",
          callId: "c1",
          name: "read",
          status: "failed",
          error: "ENOENT: missing config.json",
          detail: { type: "read", filePath: "/tmp/config.json" },
        }),
      ],
    };
    const t2: Turn = {
      key: "a2:1",
      agentId: "a2",
      kind: "turn",
      status: "running",
      prompt: "Deploy release",
      firstSeq: 1,
      items: [],
    };
    const titles = new Map([
      ["a1", "Backend Bot"],
      ["a2", "Release Bot"],
    ]);

    assert.equal(
      filterTurns([t1, t2], { statusFilter: "failed", searchQuery: "ENOENT", titleById: titles })
        .length,
      1,
    );
    assert.equal(
      filterTurns([t1, t2], { statusFilter: "running", searchQuery: "release bot", titleById: titles })
        .length,
      1,
    );
    assert.equal(turnMatchesQuery(t1, "config.json"), true);
    assert.equal(turnMatchesQuery(t1, "nonexistent"), false);
  });

  it("groups turns by day heading", () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    const todayIso = new Date(2026, 5, 15, 9, 0, 0).toISOString();
    const yesterdayIso = new Date(2026, 5, 14, 18, 0, 0).toISOString();
    const turns: Turn[] = [
      { key: "1", agentId: "a", kind: "turn", status: "completed", startedAt: todayIso, firstSeq: 1, items: [] },
      { key: "2", agentId: "a", kind: "turn", status: "completed", startedAt: todayIso, firstSeq: 2, items: [] },
      { key: "3", agentId: "a", kind: "turn", status: "completed", startedAt: yesterdayIso, firstSeq: 3, items: [] },
      { key: "4", agentId: "a", kind: "turn", status: "open", firstSeq: 4, items: [] },
    ];
    const groups = groupTurnsByDay(turns, now);
    assert.deepEqual(
      groups.map((g) => ({ label: g.label, count: g.turns.length })),
      [
        { label: "Today", count: 2 },
        { label: "Yesterday", count: 1 },
        { label: "Earlier", count: 1 },
      ],
    );
  });
});

describe("formatting and summarization", () => {
  it("formats durations cleanly across boundaries", () => {
    assert.equal(formatDuration(0), "0ms");
    assert.equal(formatDuration(-5), "0ms");
    assert.equal(formatDuration(Number.NaN), "0ms");
    assert.equal(formatDuration(0.2), "1ms");
    assert.equal(formatDuration(450), "450ms");
    assert.equal(formatDuration(999.6), "1s");
    assert.equal(formatDuration(1500), "2s");
    assert.equal(formatDuration(90_000), "1m 30s");
    assert.equal(formatDuration(3_720_000), "1h 2m");
  });

  it("computes turnDurationMs", () => {
    const base: Turn = {
      key: "1",
      agentId: "a",
      kind: "turn",
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:02.500Z",
      firstSeq: 1,
      items: [],
    };
    assert.equal(turnDurationMs(base), 2500);
    assert.equal(turnDurationMs({ ...base, endedAt: base.startedAt }), null);
    assert.equal(turnDurationMs({ ...base, endedAt: "2026-01-01T00:00:00.000Z" }), null);
    assert.equal(turnDurationMs({ ...base, endedAt: "2025-12-31T23:59:59Z" }), null);
  });

  it("formats clock, time only, day headings, tokens, and cost", () => {
    const now = new Date(2026, 5, 15, 14, 30, 0);
    const sameDay = new Date(2026, 5, 15, 9, 5, 0).toISOString();
    const earlierYear = new Date(2025, 0, 2, 8, 7, 0).toISOString();

    assert.equal(formatTimeOnly(sameDay), "09:05");
    assert.equal(formatTimeOnly("bad"), "");
    assert.equal(formatClock(sameDay, now), "09:05");
    assert.equal(formatClock(earlierYear, now), "Jan 2, 08:07");
    assert.equal(formatDayHeading(sameDay, now).label, "Today");
    assert.equal(formatDayHeading(earlierYear, now).label, "Jan 2, 2025");

    assert.equal(formatTokens(undefined), "—");
    assert.equal(formatTokens(Number.NaN), "—");
    assert.equal(formatTokens(-10), "—");
    assert.equal(formatTokens(42), "42");
    assert.equal(formatTokens(1250), "1.3k");
    assert.equal(formatTokens(999_999), "1.0M");
    assert.equal(formatTokens(2_500_000), "2.5M");

    assert.equal(formatCost(undefined), "");
    assert.equal(formatCost(-1), "");
    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(0.0025), "$0.0025");
    assert.equal(formatCost(0.123), "$0.123");
    assert.equal(formatCost(2.5), "$2.50");
  });

  it("summarizes turns and skips punctuation-only markdown lines in reply preview", () => {
    const turn: Turn = {
      key: "a:1",
      agentId: "a",
      kind: "turn",
      status: "completed",
      prompt: "  Refactor   parser \n",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T00:00:00Z", { type: "user_message", text: "Refactor parser" }),
        entry(2, "2026-01-01T00:00:01Z", { type: "reasoning", text: "Checking AST" }),
        entry(3, "2026-01-01T00:00:02Z", {
          type: "tool_call",
          callId: "c1",
          name: "edit",
          status: "failed",
          error: "conflict",
          detail: { type: "edit", filePath: "a.ts" },
        }),
        entry(4, "2026-01-01T00:00:03Z", {
          type: "assistant_message",
          text: "```\n---\n> \n### **Updated [parser](https://example.com)** successfully",
        }),
      ],
    };

    const summary = summarizeTurn(turn, "Done");
    assert.equal(normalizeInlineText(turn.prompt), "Refactor parser");
    assert.equal(summary.promptTitle, "Refactor parser");
    assert.equal(summary.replyPreview, "Updated parser successfully");
    assert.equal(summary.toolCount, 1);
    assert.equal(summary.failedToolCount, 1);
    assert.equal(summary.thinkingCount, 1);
    assert.equal(summary.stepCount, 4);
    assert.equal(summary.lastReplyIndex, 3);

    const exported = buildTurnSummaryText(turn, "Coder", new Date(2026, 0, 1, 12, 0));
    assert.match(exported, /^# Turn \(COMPLETED · Coder/);
    assert.match(exported, /## Prompt\nRefactor   parser/);
    assert.match(exported, /## Tool calls \(1\)\n- edit \(failed\)/);

    const blankSummary = buildTurnSummaryText({
      key: "a:blank",
      agentId: "a",
      kind: "turn",
      status: "completed",
      prompt: "   ",
      error: "  ",
      firstSeq: 1,
      items: [entry(1, "2026-01-01T00:00:00Z", { type: "assistant_message", text: "  \n " })],
    });
    assert.doesNotMatch(blankSummary, /## Prompt|## Reply|## Error/);
  });

  it("matches search queries across all timeline item and tool detail types", () => {
    const turn: Turn = {
      key: "a:all",
      agentId: "a",
      kind: "turn",
      status: "completed",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T00:00:00Z", { type: "reasoning", text: "Evaluating deadlock risk" }),
        entry(2, "2026-01-01T00:00:01Z", {
          type: "tool_call",
          callId: "c1",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "pytest -q", output: "12 passed" },
        }),
        entry(3, "2026-01-01T00:00:02Z", {
          type: "tool_call",
          callId: "c2",
          name: "grep",
          status: "completed",
          error: null,
          detail: { type: "search", query: "findWidget", filePaths: ["src/widget.ts"] },
        }),
        entry(4, "2026-01-01T00:00:03Z", {
          type: "tool_call",
          callId: "c3",
          name: "fetch",
          status: "completed",
          error: null,
          detail: { type: "fetch", url: "https://docs.example.dev/api", prompt: "read auth" },
        }),
        entry(5, "2026-01-01T00:00:04Z", {
          type: "tool_call",
          callId: "c4",
          name: "agent",
          status: "completed",
          error: null,
          detail: { type: "sub_agent", description: "Audit migrations", subAgentType: "reviewer" },
        }),
        entry(6, "2026-01-01T00:00:05Z", {
          type: "tool_call",
          callId: "c5",
          name: "plan",
          status: "completed",
          error: null,
          detail: { type: "plan", text: "Phase 1: schema" },
        }),
        entry(7, "2026-01-01T00:00:06Z", {
          type: "tool_call",
          callId: "c6",
          name: "worktree",
          status: "completed",
          error: null,
          detail: {
            type: "worktree_setup",
            branchName: "feat/turnline",
            worktreePath: "/wt/turnline",
            log: "",
            commands: [],
          },
        }),
        entry(8, "2026-01-01T00:00:07Z", {
          type: "todo",
          items: [{ text: "Ship patch", completed: false }],
        }),
        entry(9, "2026-01-01T00:00:08Z", {
          type: "notification",
          level: "warning",
          message: "Context near limit",
        }),
        entry(10, "2026-01-01T00:00:09Z", {
          type: "plugin",
          id: "x1",
          pluginId: "p",
          kind: "benchmark",
          version: 1,
          data: {},
        }),
      ],
    };

    for (const needle of [
      "deadlock",
      "pytest",
      "12 passed",
      "findwidget",
      "widget.ts",
      "docs.example.dev",
      "audit migrations",
      "reviewer",
      "phase 1",
      "feat/turnline",
      "ship patch",
      "near limit",
      "benchmark",
    ]) {
      assert.equal(turnMatchesQuery(turn, needle), true, `expected match for ${needle}`);
    }
    assert.equal(turnMatchesQuery(turn, "   "), true);
    assert.equal(turnMatchesQuery(turn, "does-not-exist"), false);
  });
});
