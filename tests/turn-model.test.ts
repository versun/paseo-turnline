import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
  formatItemUsageDetail,
  formatTokens,
  formatToolError,
  groupTurns,
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
import type { UsageRecord } from "../shared/usage";

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

describe("sorting, counting, and filtering", () => {
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
      cacheHitRate: undefined,
    });

    const cachedCounts = computeTurnCounts([
      {
        key: "c1",
        agentId: "a1",
        kind: "turn",
        status: "completed",
        firstSeq: 1,
        items: [],
        usage: { inputTokens: 1000, cachedInputTokens: 750, outputTokens: 100 },
      },
      {
        key: "c2",
        agentId: "a1",
        kind: "turn",
        status: "completed",
        firstSeq: 2,
        items: [],
        usage: { inputTokens: 1000, cachedInputTokens: 250, outputTokens: 100 },
      },
    ]);
    assert.equal(cachedCounts.cacheHitRate, 0.5);
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

  it("formats clock, tokens, and cost", () => {
    const now = new Date(2026, 5, 15, 14, 30, 0);
    const sameDay = new Date(2026, 5, 15, 9, 5, 0).toISOString();
    const earlierYear = new Date(2025, 0, 2, 8, 7, 0).toISOString();

    assert.equal(formatClock(undefined, now), "");
    assert.equal(formatClock("bad", now), "");
    assert.equal(formatClock(sameDay, now), "09:05");
    assert.equal(formatClock(earlierYear, now), "Jan 2, 08:07");

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

describe("cache hit rate & per-item usage attribution", () => {
  it("computes and formats cache hit rate and detail strings", () => {
    assert.equal(computeCacheHitRate(undefined), null);
    assert.equal(computeCacheHitRate({ inputTokens: 0, cachedInputTokens: 0 }), null);
    assert.equal(computeCacheHitRate({ inputTokens: 1000 }), null);
    assert.equal(computeCacheHitRate({ inputTokens: 1000, cachedInputTokens: 0 }), 0);
    assert.equal(computeCacheHitRate({ inputTokens: 1000, cachedInputTokens: 734 }), 0.734);
    assert.equal(computeCacheHitRate({ inputTokens: 1000, cachedInputTokens: 1500 }), 1);

    assert.equal(formatCacheRate(null), "");
    assert.equal(formatCacheRate(0), "0%");
    assert.equal(formatCacheRate(0.734), "73%");
    assert.equal(formatCacheRate(1), "100%");

    assert.equal(
      formatItemUsageDetail({
        inputTokens: 15_246,
        cachedInputTokens: 11_200,
        cacheWriteTokens: 1_500,
        outputTokens: 512,
        costUsd: 0.0216,
      }),
      "Input 15.2k (11.2k cached · 73% hit) · Write 1.5k · Output 512 · $0.022",
    );
    assert.equal(
      formatItemUsageDetail(
        { inputTokens: 15_246, cachedInputTokens: 11_200, outputTokens: 512, costUsd: 0.02 },
        { inputOnly: true },
      ),
      "Input 15.2k (11.2k cached · 73% hit)",
    );
  });

  it("attributes provider records to every item in multi-step turns without double-counting turn totals", () => {
    const turn1: Turn = {
      key: "a1:t1",
      agentId: "a1",
      kind: "turn",
      turnId: "t1",
      status: "completed",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:00:12Z",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "Fix the tests" }, "t1"),
        entry(2, "2026-01-01T10:00:02Z", { type: "reasoning", text: "Inspecting package.json first" }, "t1"),
        entry(
          3,
          "2026-01-01T10:00:03Z",
          {
            type: "tool_call",
            callId: "call_read_1",
            name: "read",
            status: "completed",
            error: null,
            detail: { type: "read", filePath: "package.json" },
          },
          "t1",
        ),
        entry(
          4,
          "2026-01-01T10:00:03Z",
          {
            type: "tool_call",
            callId: "call_bash_2",
            name: "bash",
            status: "completed",
            error: null,
            detail: { type: "shell", command: "npm test" },
          },
          "t1",
        ),
        entry(5, "2026-01-01T10:00:10Z", { type: "reasoning", text: "Tests passed now" }, "t1"),
        entry(
          6,
          "2026-01-01T10:00:12Z",
          { type: "assistant_message", text: "All tests pass now.", messageId: "msg_final_1" },
          "t1",
        ),
      ],
    };

    const records: UsageRecord[] = [
      {
        at: "2026-01-01T10:00:03Z",
        messageId: "msg_step_1",
        callIds: ["call_read_1", "call_bash_2"],
        thinkingPrefix: "Inspecting package.json first",
        usage: { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 200, costUsd: 0.01 },
      },
      {
        at: "2026-01-01T10:00:12Z",
        messageId: "msg_final_1",
        textPrefix: "All tests pass now.",
        usage: { inputTokens: 12_000, cachedInputTokens: 9_600, outputTokens: 300, costUsd: 0.005 },
      },
    ];

    const resolved = assignUsageToTurns([turn1], records).get("a1:t1")!;
    assert.ok(resolved);

    // Prompt (index 0) gets first LLM call input-only
    assert.deepEqual(resolved.itemUsages.get(0), {
      usage: records[0].usage,
      inputOnly: true,
    });
    // Reasoning (index 1) and both parallel tool_calls (indices 2, 3) get record 0
    assert.deepEqual(resolved.itemUsages.get(1), { usage: records[0].usage });
    assert.deepEqual(resolved.itemUsages.get(2), { usage: records[0].usage });
    assert.deepEqual(resolved.itemUsages.get(3), { usage: records[0].usage });
    // Second reasoning (index 4) has no thinkingPrefix on record 1, so it inherits adjacent assistant_message (record 1)
    assert.deepEqual(resolved.itemUsages.get(4), { usage: records[1].usage });
    // Final reply (index 5) matches by messageId -> record 1
    assert.deepEqual(resolved.itemUsages.get(5), { usage: records[1].usage });

    // Turn aggregate sums unique records ONCE (not 4x record 0 + 2x record 1!)
    assert.deepEqual(resolved.turnUsage, {
      inputTokens: 22_000,
      cachedInputTokens: 9_600,
      outputTokens: 500,
      totalCostUsd: 0.015,
    });
  });

  it("falls back to turn.usage for single-step turns when provider records are absent", () => {
    const turn: Turn = {
      key: "a1:solo",
      agentId: "a1",
      kind: "turn",
      status: "completed",
      firstSeq: 1,
      usage: { inputTokens: 4_000, cachedInputTokens: 3_000, outputTokens: 150 },
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "Hi" }),
        entry(2, "2026-01-01T10:00:01Z", { type: "assistant_message", text: "Hello!" }),
      ],
    };
    const resolved = assignUsageToTurns([turn], undefined).get("a1:solo")!;
    assert.equal(resolved.itemUsages.get(0)?.inputOnly, true);
    assert.equal(resolved.itemUsages.get(0)?.usage.inputTokens, 4_000);
    assert.equal(resolved.itemUsages.get(1)?.usage.outputTokens, 150);
    assert.equal(resolved.itemUsages.get(1)?.usage.cachedInputTokens, 3_000);
  });

  it("does not assign turn.usage fallback to multi-step turns when provider records are absent", () => {
    const turn: Turn = {
      key: "a1:multi-no-rec",
      agentId: "a1",
      kind: "turn",
      status: "completed",
      firstSeq: 1,
      usage: { inputTokens: 20_000, cachedInputTokens: 15_000, outputTokens: 600 },
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "Check" }),
        entry(2, "2026-01-01T10:00:02Z", {
          type: "tool_call",
          callId: "c1",
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "a.ts" },
        }),
        entry(3, "2026-01-01T10:00:05Z", { type: "assistant_message", text: "Done" }),
      ],
    };
    const resolved = assignUsageToTurns([turn], undefined).get("a1:multi-no-rec")!;
    assert.equal(resolved.itemUsages.size, 0);
    assert.deepEqual(resolved.turnUsage, turn.usage);
  });

  it("isolates records across turns and prevents swept hidden records from being stolen by a running next turn", () => {
    const turn0: Turn = {
      key: "a1:t0",
      agentId: "a1",
      kind: "turn",
      turnId: "t0",
      status: "completed",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:00:10Z",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "First" }, "t0"),
        entry(2, "2026-01-01T10:00:05Z", { type: "assistant_message", text: "First reply", messageId: "m0" }, "t0"),
      ],
    };
    const turn1: Turn = {
      key: "a1:t1",
      agentId: "a1",
      kind: "turn",
      turnId: "t1",
      status: "running",
      startedAt: "2026-01-01T10:00:12Z",
      endedAt: "2026-01-01T10:00:12Z",
      firstSeq: 3,
      items: [
        entry(3, "2026-01-01T10:00:12Z", { type: "user_message", text: "Second in flight" }, "t1"),
      ],
    };

    const records: UsageRecord[] = [
      {
        at: "2026-01-01T10:00:05Z",
        messageId: "m0",
        textPrefix: "First reply",
        usage: { inputTokens: 5_000, cachedInputTokens: 2_000, outputTokens: 100 },
      },
      // Hidden/unmatched step inside Turn 0's timespan (10:00:09Z is within 5s before Turn 1's 10:00:12Z)
      {
        at: "2026-01-01T10:00:09Z",
        messageId: "m0_hidden",
        usage: { inputTokens: 6_000, cachedInputTokens: 4_000, outputTokens: 120 },
      },
    ];

    const resolved = assignUsageToTurns([turn0, turn1], records);
    const r0 = resolved.get("a1:t0")!;
    const r1 = resolved.get("a1:t1")!;

    assert.deepEqual(r0.turnUsage, {
      inputTokens: 11_000,
      cachedInputTokens: 6_000,
      outputTokens: 220,
    });
    // Turn 1's prompt must NOT steal Turn 0's swept hidden record or double-count it
    assert.equal(r1.itemUsages.size, 0);
    assert.equal(r1.turnUsage, undefined);
  });

  it("matches records on a last turn lasting longer than 30 seconds", () => {
    const turn: Turn = {
      key: "a1:long",
      agentId: "a1",
      kind: "turn",
      status: "completed",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:00:10Z",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "Run long task" }),
        entry(2, "2026-01-01T10:01:25Z", { type: "assistant_message", text: "Finished after 85s" }),
      ],
    };
    const records: UsageRecord[] = [
      {
        at: "2026-01-01T10:01:25Z",
        textPrefix: "Finished after 85s",
        usage: { inputTokens: 9_000, cachedInputTokens: 7_200, outputTokens: 300 },
      },
    ];

    const resolved = assignUsageToTurns([turn], records).get("a1:long")!;
    assert.equal(resolved.itemUsages.get(1)?.usage.inputTokens, 9_000);
    assert.equal(resolved.itemUsages.get(0)?.inputOnly, true);
    assert.equal(resolved.turnUsage?.inputTokens, 9_000);
  });

  it("matches records for consecutive turns sharing the exact same startedAt and record timestamp", () => {
    const t0: Turn = {
      key: "a1:same0",
      agentId: "a1",
      kind: "turn",
      turnId: "s0",
      status: "completed",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:00:00Z",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "One" }, "s0"),
        entry(2, "2026-01-01T10:00:00Z", { type: "assistant_message", text: "Alpha reply" }, "s0"),
      ],
    };
    const t1: Turn = {
      key: "a1:same1",
      agentId: "a1",
      kind: "turn",
      turnId: "s1",
      status: "completed",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:00:00Z",
      firstSeq: 3,
      items: [
        entry(3, "2026-01-01T10:00:00Z", { type: "user_message", text: "Two" }, "s1"),
        entry(4, "2026-01-01T10:00:00Z", { type: "assistant_message", text: "Beta reply" }, "s1"),
      ],
    };

    // Both records share the exact same 10:00:00Z timestamp — Turn 0's sweep must not steal Turn 1's record.
    const records: UsageRecord[] = [
      {
        at: "2026-01-01T10:00:00Z",
        textPrefix: "Alpha reply",
        usage: { inputTokens: 1_000, cachedInputTokens: 500, outputTokens: 20 },
      },
      {
        at: "2026-01-01T10:00:00Z",
        textPrefix: "Beta reply",
        usage: { inputTokens: 2_000, cachedInputTokens: 1_500, outputTokens: 40 },
      },
    ];

    const resolved = assignUsageToTurns([t0, t1], records);
    assert.equal(resolved.get("a1:same0")?.itemUsages.get(1)?.usage.inputTokens, 1_000);
    assert.equal(resolved.get("a1:same0")?.turnUsage?.inputTokens, 1_000);
    assert.equal(resolved.get("a1:same1")?.itemUsages.get(1)?.usage.inputTokens, 2_000);
    assert.equal(resolved.get("a1:same1")?.turnUsage?.inputTokens, 2_000);
  });

  it("matches boundary records when back-to-back turns share t0.endedAt === t1.startedAt", () => {
    const t0: Turn = {
      key: "a1:b0",
      agentId: "a1",
      kind: "turn",
      turnId: "b0",
      status: "completed",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:00:05Z",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "First" }, "b0"),
        entry(2, "2026-01-01T10:00:05Z", { type: "assistant_message", text: "Alpha" }, "b0"),
      ],
    };
    const t1: Turn = {
      key: "a1:b1",
      agentId: "a1",
      kind: "turn",
      turnId: "b1",
      status: "completed",
      startedAt: "2026-01-01T10:00:05Z",
      endedAt: "2026-01-01T10:00:10Z",
      firstSeq: 3,
      items: [
        entry(3, "2026-01-01T10:00:05Z", { type: "user_message", text: "Second" }, "b1"),
        entry(4, "2026-01-01T10:00:10Z", { type: "assistant_message", text: "Beta" }, "b1"),
      ],
    };

    const records: UsageRecord[] = [
      {
        at: "2026-01-01T10:00:05Z",
        textPrefix: "Alpha",
        usage: { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 25 },
      },
      {
        at: "2026-01-01T10:00:10Z",
        textPrefix: "Beta",
        usage: { inputTokens: 2_000, cachedInputTokens: 1_200, outputTokens: 50 },
      },
    ];

    const resolved = assignUsageToTurns([t0, t1], records);
    assert.equal(resolved.get("a1:b0")?.itemUsages.get(1)?.usage.inputTokens, 1_000);
    assert.equal(resolved.get("a1:b0")?.turnUsage?.inputTokens, 1_000);
    assert.equal(resolved.get("a1:b1")?.itemUsages.get(1)?.usage.inputTokens, 2_000);
    assert.equal(resolved.get("a1:b1")?.turnUsage?.inputTokens, 2_000);
  });

  it("handles reused callId and messageId across turns without cross-turn stealing", () => {
    const t0: Turn = {
      key: "a1:r0",
      agentId: "a1",
      kind: "turn",
      turnId: "r0",
      status: "completed",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:00:05Z",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "T0" }, "r0"),
        entry(2, "2026-01-01T10:00:02Z", {
          type: "tool_call",
          callId: "call_0",
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "a.ts" },
        }, "r0"),
        entry(3, "2026-01-01T10:00:05Z", { type: "assistant_message", text: "Done 0", messageId: "msg_0" }, "r0"),
      ],
    };
    const t1: Turn = {
      key: "a1:r1",
      agentId: "a1",
      kind: "turn",
      turnId: "r1",
      status: "completed",
      startedAt: "2026-01-01T10:01:00Z",
      endedAt: "2026-01-01T10:01:05Z",
      firstSeq: 4,
      items: [
        entry(4, "2026-01-01T10:01:00Z", { type: "user_message", text: "T1" }, "r1"),
        entry(5, "2026-01-01T10:01:02Z", {
          type: "tool_call",
          callId: "call_0",
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "b.ts" },
        }, "r1"),
        entry(6, "2026-01-01T10:01:05Z", { type: "assistant_message", text: "Done 1", messageId: "msg_0" }, "r1"),
      ],
    };

    const records: UsageRecord[] = [
      {
        at: "2026-01-01T10:00:02Z",
        messageId: "msg_t0_tool",
        callIds: ["call_0"],
        usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 50 },
      },
      {
        at: "2026-01-01T10:00:05Z",
        messageId: "msg_0",
        usage: { inputTokens: 1_500, cachedInputTokens: 1_000, outputTokens: 60 },
      },
      {
        at: "2026-01-01T10:01:02Z",
        messageId: "msg_t1_tool",
        callIds: ["call_0"],
        usage: { inputTokens: 3_000, cachedInputTokens: 2_000, outputTokens: 70 },
      },
      // Note: only ONE msg_0 record exists (for Turn 0); Turn 1 must NOT steal Turn 0's msg_0 record!
    ];

    const resolved = assignUsageToTurns([t0, t1], records);
    assert.equal(resolved.get("a1:r0")?.itemUsages.get(1)?.usage.inputTokens, 1_000);
    assert.equal(resolved.get("a1:r0")?.itemUsages.get(2)?.usage.inputTokens, 1_500);
    assert.equal(resolved.get("a1:r1")?.itemUsages.get(1)?.usage.inputTokens, 3_000);
    assert.equal(resolved.get("a1:r1")?.itemUsages.get(2), undefined);

    // When a second record reuses msg_0 in Turn 1, each turn gets its own closest record.
    const withSecondMsg0: UsageRecord[] = [
      ...records,
      {
        at: "2026-01-01T10:01:05Z",
        messageId: "msg_0",
        usage: { inputTokens: 4_500, cachedInputTokens: 3_500, outputTokens: 90 },
      },
    ];
    const resolvedBoth = assignUsageToTurns([t0, t1], withSecondMsg0);
    assert.equal(resolvedBoth.get("a1:r0")?.itemUsages.get(2)?.usage.inputTokens, 1_500);
    assert.equal(resolvedBoth.get("a1:r1")?.itemUsages.get(2)?.usage.inputTokens, 4_500);
  });

  it("rejects claimed replies, ID-conflicting candidates, and >60s gaps in Pass 3a", () => {
    const turn: Turn = {
      key: "a1:p3a",
      agentId: "a1",
      kind: "turn",
      status: "running",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:02:05Z",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "Go" }),
        entry(2, "2026-01-01T10:00:02Z", {
          type: "tool_call",
          callId: "call_1",
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "a.ts" },
        }),
        entry(3, "2026-01-01T10:00:03Z", {
          type: "assistant_message",
          text: "First update",
          messageId: "msg_1",
        }),
        // In-flight tool_call with conflicting callId (even within 60s)
        entry(4, "2026-01-01T10:00:10Z", {
          type: "tool_call",
          callId: "call_2",
          name: "bash",
          status: "running",
          error: null,
          detail: { type: "shell", command: "ls" },
        }),
        // In-flight reply with conflicting messageId & >60s gap, plus another reply without messageId
        entry(5, "2026-01-01T10:02:05Z", {
          type: "assistant_message",
          text: "Second update",
          messageId: "msg_2",
        }),
        entry(6, "2026-01-01T10:00:12Z", {
          type: "assistant_message",
          text: "Third update",
        }),
      ],
    };

    const records: UsageRecord[] = [
      {
        at: "2026-01-01T10:00:02Z",
        messageId: "msg_1",
        callIds: ["call_1"],
        usage: { inputTokens: 8_000, cachedInputTokens: 6_000, outputTokens: 150 },
      },
    ];

    const resolved = assignUsageToTurns([turn], records).get("a1:p3a")!;
    assert.equal(resolved.itemUsages.get(1)?.usage.inputTokens, 8_000);
    assert.equal(resolved.itemUsages.get(2)?.usage.inputTokens, 8_000);
    assert.equal(resolved.itemUsages.get(3), undefined);
    assert.equal(resolved.itemUsages.get(4), undefined);
    assert.equal(resolved.itemUsages.get(5), undefined);

    // Pure >60s cap check: single unclaimed ID-less record 175s away must remain unmatched
    const farTurn: Turn = {
      key: "a1:p3a-far",
      agentId: "a1",
      kind: "turn",
      status: "running",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:03:00Z",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "Wait" }),
        entry(2, "2026-01-01T10:03:00Z", { type: "assistant_message", text: "Late reply" }),
      ],
    };
    const farResolved = assignUsageToTurns([farTurn], [
      {
        at: "2026-01-01T10:00:05Z",
        usage: { inputTokens: 4_000, cachedInputTokens: 2_000, outputTokens: 40 },
      },
    ]).get("a1:p3a-far")!;
    assert.equal(farResolved.itemUsages.get(1), undefined);
  });

  it("matches Pass 2a textPrefix, Pass 3a timestamp proximity, and Pass 3c todo items", () => {
    const turn: Turn = {
      key: "a1:passes",
      agentId: "a1",
      kind: "turn",
      status: "completed",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:00:20Z",
      firstSeq: 1,
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "Plan and execute" }),
        entry(2, "2026-01-01T10:00:04Z", {
          type: "todo",
          items: [{ text: "Step 1", completed: true }],
        }),
        // Tool call without matching callId on record -> Pass 3a timestamp proximity
        entry(3, "2026-01-01T10:00:05Z", {
          type: "tool_call",
          callId: "unmatched_call",
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "x.ts" },
        }),
        // Reply without messageId -> Pass 2a textPrefix
        entry(4, "2026-01-01T10:00:20Z", {
          type: "assistant_message",
          text: "  Final   summary   here ",
        }),
      ],
    };

    const records: UsageRecord[] = [
      {
        at: "2026-01-01T10:00:05Z",
        usage: { inputTokens: 4_000, cachedInputTokens: 2_000, outputTokens: 100 },
      },
      {
        at: "2026-01-01T10:00:20Z",
        textPrefix: "Final summary here",
        usage: { inputTokens: 6_000, cachedInputTokens: 5_000, outputTokens: 200 },
      },
    ];

    const resolved = assignUsageToTurns([turn], records).get("a1:passes")!;
    assert.equal(resolved.itemUsages.get(1)?.usage.inputTokens, 4_000);
    assert.equal(resolved.itemUsages.get(2)?.usage.inputTokens, 4_000);
    assert.equal(resolved.itemUsages.get(3)?.usage.inputTokens, 6_000);
    assert.deepEqual(resolved.turnUsage, {
      inputTokens: 10_000,
      cachedInputTokens: 7_000,
      outputTokens: 300,
    });
  });

  it("preserves live base turn.usage when providerSum lags behind and ignores undefined/NaN base keys", () => {
    const laggingTurn: Turn = {
      key: "a1:lag",
      agentId: "a1",
      kind: "turn",
      status: "completed",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:00:10Z",
      firstSeq: 1,
      usage: { inputTokens: 30_000, outputTokens: 1_000 },
      items: [
        entry(1, "2026-01-01T10:00:00Z", { type: "user_message", text: "Work" }),
        entry(2, "2026-01-01T10:00:03Z", {
          type: "assistant_message",
          text: "Step 1",
          messageId: "m_lag",
        }),
      ],
    };

    const nanBaseTurn: Turn = {
      key: "a1:nan",
      agentId: "a1",
      kind: "turn",
      status: "completed",
      startedAt: "2026-01-01T10:01:00Z",
      endedAt: "2026-01-01T10:01:05Z",
      firstSeq: 3,
      usage: {
        inputTokens: 12_000,
        outputTokens: undefined,
        cachedInputTokens: Number.NaN,
        totalCostUsd: undefined,
      },
      items: [
        entry(3, "2026-01-01T10:01:00Z", { type: "user_message", text: "Next" }),
        entry(4, "2026-01-01T10:01:05Z", {
          type: "assistant_message",
          text: "Step 2",
          messageId: "m_nan",
        }),
      ],
    };

    const completeBackfillTurn: Turn = {
      key: "a1:backfill",
      agentId: "a1",
      kind: "turn",
      status: "completed",
      startedAt: "2026-01-01T10:02:00Z",
      endedAt: "2026-01-01T10:02:05Z",
      firstSeq: 5,
      usage: { inputTokens: 10_000, outputTokens: 200 },
      items: [
        entry(5, "2026-01-01T10:02:00Z", { type: "user_message", text: "Third" }),
        entry(6, "2026-01-01T10:02:05Z", {
          type: "assistant_message",
          text: "Step 3",
          messageId: "m_bf",
        }),
      ],
    };

    const records: UsageRecord[] = [
      {
        at: "2026-01-01T10:00:03Z",
        messageId: "m_lag",
        usage: { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 200, costUsd: 0.01 },
      },
      {
        at: "2026-01-01T10:01:05Z",
        messageId: "m_nan",
        usage: { inputTokens: 9_000, cachedInputTokens: 7_000, outputTokens: 250, costUsd: 0.02 },
      },
      {
        at: "2026-01-01T10:02:05Z",
        messageId: "m_bf",
        usage: { inputTokens: 15_000, cachedInputTokens: 12_000, outputTokens: 300, costUsd: 0.03 },
      },
    ];

    const resolved = assignUsageToTurns([laggingTurn, nanBaseTurn, completeBackfillTurn], records);

    // Lagging providerSum must not regress live base inputTokens/outputTokens downward
    assert.deepEqual(resolved.get("a1:lag")?.turnUsage, {
      inputTokens: 30_000,
      outputTokens: 1_000,
      cachedInputTokens: 8_000,
      totalCostUsd: 0.01,
    });

    // Undefined / NaN keys on base must not clobber valid providerSum numbers
    assert.deepEqual(resolved.get("a1:nan")?.turnUsage, {
      inputTokens: 12_000,
      outputTokens: 250,
      cachedInputTokens: 7_000,
      totalCostUsd: 0.02,
    });

    // Complete providerSum (>= base) replaces base totals and backfills cache stats
    assert.deepEqual(resolved.get("a1:backfill")?.turnUsage, {
      inputTokens: 15_000,
      outputTokens: 300,
      cachedInputTokens: 12_000,
      totalCostUsd: 0.03,
    });
  });
});
