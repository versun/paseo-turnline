import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginPaseoApi } from "@getpaseo/plugin/client";
import { TurnFeedStore } from "../../client/feed";

interface MockEntry {
  seqStart: number;
  seqEnd: number;
  timestamp: string;
  turnId?: string;
  item: any;
}

interface MockPage {
  entries: MockEntry[];
  hasOlder: boolean;
  startCursor: { epoch: string; seq: number } | null;
  error: string | null;
}

function createMockPaseo() {
  const subscribers = new Map<string, (update: any) => void>();
  const unsubCounts = new Map<string, number>();
  const refetchLog: Array<{ agentId: string; options: any }> = [];
  const handlers = new Map<string, (options: any) => Promise<MockPage>>();

  const paseo = {
    agents: {
      ref(agentId: string) {
        return {
          timeline: {
            subscribe(handler: (update: any) => void) {
              subscribers.set(agentId, handler);
              const unsub = (() => {
                unsubCounts.set(agentId, (unsubCounts.get(agentId) ?? 0) + 1);
                if (subscribers.get(agentId) === handler) subscribers.delete(agentId);
              }) as (() => void) & { ready: Promise<void> };
              unsub.ready = Promise.resolve();
              return unsub;
            },
            refetch(options: any) {
              refetchLog.push({ agentId, options });
              const fn = handlers.get(agentId);
              if (!fn) {
                return Promise.resolve({
                  entries: [],
                  hasOlder: false,
                  startCursor: null,
                  error: null,
                });
              }
              return fn(options);
            },
          },
        };
      },
    },
  } as unknown as PluginPaseoApi;

  return {
    paseo,
    emit(agentId: string, update: any) {
      subscribers.get(agentId)?.(update);
    },
    setRefetch(agentId: string, fn: (options: any) => Promise<MockPage>) {
      handlers.set(agentId, fn);
    },
    unsubCounts,
    refetchLog,
  };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("TurnFeedStore", () => {
  it("loads initial tail, avoids no-op emits, and detaches removed agents", async () => {
    const mock = createMockPaseo();
    mock.setRefetch("a1", async () => ({
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          timestamp: "2026-01-01T10:00:00Z",
          turnId: "t1",
          item: { type: "user_message", text: "Hi" },
        },
      ],
      hasOlder: false,
      startCursor: { epoch: "e1", seq: 1 },
      error: null,
    }));

    const store = new TurnFeedStore(mock.paseo);
    let emits = 0;
    store.subscribe(() => {
      emits += 1;
    });

    store.setAgents([{ id: "a1", running: false }]);
    await flush();
    const afterAttach = emits;
    assert.equal(store.getSnapshot().get("a1")?.turns.length, 1);
    assert.equal(store.getSnapshot().get("a1")?.loading, false);

    // Identical agent list should not re-emit
    store.setAgents([{ id: "a1", running: false }]);
    assert.equal(emits, afterAttach);

    // Removing agent unsubscribes it
    store.setAgents([]);
    assert.equal(mock.unsubCounts.get("a1"), 1);
    assert.equal(store.getSnapshot().size, 0);
  });

  it("updates live tool_call in place by callId and preserves update.timestamp", async () => {
    const mock = createMockPaseo();
    mock.setRefetch("a1", async () => ({
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          timestamp: "2026-01-01T10:00:00Z",
          turnId: "t1",
          item: { type: "user_message", text: "Run ls" },
        },
      ],
      hasOlder: false,
      startCursor: { epoch: "e1", seq: 1 },
      error: null,
    }));

    const store = new TurnFeedStore(mock.paseo);
    store.setAgents([{ id: "a1", running: true }]);
    await flush();

    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:02Z",
      seq: 2,
      event: {
        type: "timeline",
        turnId: "t1",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "c1",
          name: "bash",
          status: "running",
          error: null,
          detail: { type: "shell", command: "ls" },
        },
      },
    });
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:04Z",
      seq: 3,
      event: {
        type: "timeline",
        turnId: "t1",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "c1",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "ls", output: "README.md", exitCode: 0 },
        },
      },
    });

    const turn = store.getSnapshot().get("a1")!.turns[0];
    const tools = turn.items.filter((e) => e.item.type === "tool_call");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].timestamp, "2026-01-01T10:00:02Z");
    assert.equal(tools[0].item.type === "tool_call" && tools[0].item.status, "completed");
  });

  it("preserves older cursor on non-reset tail refetch and drops covered live items", async () => {
    const mock = createMockPaseo();
    let tailCalls = 0;
    mock.setRefetch("a1", async (opts) => {
      if (opts.direction === "before") {
        return {
          entries: [
            {
              seqStart: 1,
              seqEnd: 1,
              timestamp: "2026-01-01T09:00:00Z",
              turnId: "t0",
              item: { type: "user_message", text: "Old" },
            },
          ],
          hasOlder: false,
          startCursor: { epoch: "e1", seq: 1 },
          error: null,
        };
      }
      tailCalls += 1;
      if (tailCalls === 1) {
        return {
          entries: [
            {
              seqStart: 10,
              seqEnd: 10,
              timestamp: "2026-01-01T10:00:00Z",
              turnId: "t1",
              item: { type: "user_message", text: "Current" },
            },
          ],
          hasOlder: true,
          startCursor: { epoch: "e1", seq: 10 },
          error: null,
        };
      }
      return {
        entries: [
          {
            seqStart: 10,
            seqEnd: 10,
            timestamp: "2026-01-01T10:00:00Z",
            turnId: "t1",
            item: { type: "user_message", text: "Current" },
          },
          {
            seqStart: 11,
            seqEnd: 12,
            timestamp: "2026-01-01T10:00:05Z",
            turnId: "t1",
            item: { type: "assistant_message", text: "Merged reply" },
          },
        ],
        hasOlder: true,
        startCursor: { epoch: "e1", seq: 10 },
        error: null,
      };
    });

    const store = new TurnFeedStore(mock.paseo);
    store.setAgents([{ id: "a1", running: false }]);
    await flush();

    // Load older history -> reaches beginning (hasOlder: false, startCursor.seq: 1)
    await store.loadOlder("a1");
    assert.equal(store.getSnapshot().get("a1")?.hasOlder, false);
    assert.equal(store.getSnapshot().get("a1")?.turns.length, 2);

    // Live chunks arrive then turn completes -> triggers non-reset tail reconciliation
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:03Z",
      seq: 11,
      event: { type: "timeline", turnId: "t1", provider: "pi", item: { type: "assistant_message", text: "Merged " } },
    });
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:05Z",
      event: {
        type: "turn_completed",
        turnId: "t1",
        provider: "pi",
        usage: { inputTokens: 10, outputTokens: 4 },
      },
    });
    await flush();

    const view = store.getSnapshot().get("a1")!;
    // Older history & hasOlder=false MUST still be preserved!
    assert.equal(view.hasOlder, false);
    assert.equal(view.turns.length, 2);
    assert.equal(view.turns[1].items.length, 2);
    assert.equal(
      view.turns[1].items[1].item.type === "assistant_message" && view.turns[1].items[1].item.text,
      "Merged reply",
    );
    assert.deepEqual(view.turns[1].usage, { inputTokens: 10, outputTokens: 4 });
  });

  it("ignores stale loadOlder after replacement reset and clears errors after recovery", async () => {
    const mock = createMockPaseo();
    let resolveBefore!: (page: MockPage) => void;
    let tailAttempt = 0;

    mock.setRefetch("a1", (opts) => {
      if (opts.direction === "before") {
        return new Promise<MockPage>((resolve) => {
          resolveBefore = resolve;
        });
      }
      tailAttempt += 1;
      if (tailAttempt === 1) {
        return Promise.resolve({
          entries: [
            {
              seqStart: 50,
              seqEnd: 50,
              timestamp: "2026-01-01T10:00:00Z",
              turnId: "t1",
              item: { type: "user_message", text: "Epoch 1" },
            },
          ],
          hasOlder: true,
          startCursor: { epoch: "e1", seq: 50 },
          error: null,
        });
      }
      if (tailAttempt === 2) {
        return Promise.resolve({
          entries: [],
          hasOlder: false,
          startCursor: null,
          error: "temporary backend error",
        });
      }
      return Promise.resolve({
        entries: [
          {
            seqStart: 1,
            seqEnd: 1,
            timestamp: "2026-01-01T10:05:00Z",
            turnId: "t2",
            item: { type: "user_message", text: "Epoch 2" },
          },
        ],
        hasOlder: false,
        startCursor: { epoch: "e2", seq: 1 },
        error: null,
      });
    });

    const store = new TurnFeedStore(mock.paseo);
    store.setAgents([{ id: "a1", running: false }]);
    await flush();

    // Trigger loadOlder that stays in-flight
    const loadOlderPromise = store.loadOlder("a1");

    // First replacement gets page.error -> surfaces error without losing existing entries
    mock.emit("a1", { agentId: "a1", event: { type: "replacement", epoch: "e2" } });
    await flush();
    assert.equal(store.getSnapshot().get("a1")?.error, "temporary backend error");
    assert.equal(store.getSnapshot().get("a1")?.turns.length, 1);

    // Second replacement succeeds -> clears error and resets to Epoch 2
    mock.emit("a1", { agentId: "a1", event: { type: "subscription_restored" } });
    await flush();
    assert.equal(store.getSnapshot().get("a1")?.error, undefined);
    assert.equal(store.getSnapshot().get("a1")?.turns[0].prompt, "Epoch 2");

    // Now the stale loadOlder from Epoch 1 resolves -> MUST be ignored!
    resolveBefore({
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          timestamp: "2026-01-01T08:00:00Z",
          turnId: "stale",
          item: { type: "user_message", text: "Stale Epoch 1" },
        },
      ],
      hasOlder: true,
      startCursor: { epoch: "e1", seq: 1 },
      error: null,
    });
    await loadOlderPromise;
    assert.equal(store.getSnapshot().get("a1")?.turns.length, 1);
    assert.equal(store.getSnapshot().get("a1")?.turns[0].prompt, "Epoch 2");
  });

  it("recovers cleanly after dispose() when re-mounted (StrictMode compatibility)", async () => {
    const mock = createMockPaseo();
    mock.setRefetch("a1", async () => ({
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          timestamp: "2026-01-01T10:00:00Z",
          turnId: "t1",
          item: { type: "user_message", text: "StrictMode" },
        },
      ],
      hasOlder: false,
      startCursor: { epoch: "e1", seq: 1 },
      error: null,
    }));

    const store = new TurnFeedStore(mock.paseo);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.setAgents([{ id: "a1", running: false }]);
    store.dispose();
    store.setAgents([{ id: "a1", running: false }]);
    await flush();

    assert.ok(notifications > 0);
    assert.equal(store.getSnapshot().get("a1")?.turns[0].prompt, "StrictMode");
  });

  it("updates canonical tool_call in place on live completion and keeps newer in-flight live items", async () => {
    const mock = createMockPaseo();
    let resolveSecondTail!: (page: MockPage) => void;
    let tailCalls = 0;

    mock.setRefetch("a1", () => {
      tailCalls += 1;
      if (tailCalls === 1) {
        return Promise.resolve({
          entries: [
            {
              seqStart: 1,
              seqEnd: 1,
              timestamp: "2026-01-01T10:00:00Z",
              turnId: "t1",
              item: {
                type: "tool_call",
                callId: "c1",
                name: "bash",
                status: "running",
                error: null,
                detail: { type: "shell", command: "sleep 1" },
              },
            },
          ],
          hasOlder: false,
          startCursor: { epoch: "e1", seq: 1 },
          error: null,
        });
      }
      return new Promise<MockPage>((resolve) => {
        resolveSecondTail = resolve;
      });
    });

    const store = new TurnFeedStore(mock.paseo);
    store.setAgents([{ id: "a1", running: true }]);
    await flush();

    // Live completion arrives for already-canonical tool_call c1 -> updates in place without duplicate
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:02Z",
      seq: 2,
      event: {
        type: "timeline",
        turnId: "t1",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "c1",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "sleep 1", output: "done", exitCode: 0 },
        },
      },
    });
    assert.equal(store.getSnapshot().get("a1")?.turns[0].items.length, 1);
    const updated = store.getSnapshot().get("a1")!.turns[0].items[0].item;
    assert.equal(updated.type === "tool_call" && updated.status, "completed");

    // turn_failed starts a tail refetch; while it is in flight, a new live prompt for t2 arrives
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:03Z",
      event: { type: "turn_failed", turnId: "t1", provider: "pi", error: "boom" },
    });
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:04Z",
      seq: 5,
      event: {
        type: "timeline",
        turnId: "t2",
        provider: "pi",
        item: { type: "user_message", text: "Follow-up while refetching" },
      },
    });

    resolveSecondTail({
      entries: [
        {
          seqStart: 1,
          seqEnd: 2,
          timestamp: "2026-01-01T10:00:00Z",
          turnId: "t1",
          item: {
            type: "tool_call",
            callId: "c1",
            name: "bash",
            status: "completed",
            error: null,
            detail: { type: "shell", command: "sleep 1", output: "done", exitCode: 0 },
          },
        },
      ],
      hasOlder: false,
      startCursor: { epoch: "e1", seq: 1 },
      error: null,
    });
    await flush();

    const turns = store.getSnapshot().get("a1")!.turns;
    assert.equal(turns.length, 2);
    assert.equal(turns[0].status, "failed");
    assert.equal(turns[0].error, "boom");
    assert.equal(turns[1].prompt, "Follow-up while refetching");
  });

  it("drops out-of-order tail refetches, preserves pendingReset across superseded refetches, and clears turnMeta on replacement", async () => {
    const mock = createMockPaseo();
    const resolvers: Array<(page: MockPage) => void> = [];
    mock.setRefetch(
      "a1",
      () =>
        new Promise<MockPage>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const store = new TurnFeedStore(mock.paseo);
    store.setAgents([{ id: "a1", running: true }]);
    await flush();
    assert.equal(resolvers.length, 1);

    // Initial tail resolves with epoch 1 entry
    resolvers[0]({
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          timestamp: "2026-01-01T10:00:00Z",
          turnId: "t1",
          item: { type: "user_message", text: "Epoch 1" },
        },
      ],
      hasOlder: false,
      startCursor: { epoch: "e1", seq: 1 },
      error: null,
    });
    await flush();

    // Record failure metadata on t1, then trigger replacement followed immediately by turn_completed
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:01Z",
      event: { type: "turn_failed", turnId: "t1", provider: "pi", error: "old error" },
    });
    mock.emit("a1", {
      agentId: "a1",
      event: { type: "replacement", epoch: "e2" },
    });
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:02Z",
      event: { type: "turn_completed", turnId: "t2", provider: "pi" },
    });
    assert.equal(resolvers.length, 4);

    // Newest tail (#4) resolves first -> MUST still apply pendingReset from #3 and clear stale turnMeta
    resolvers[3]({
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          timestamp: "2026-01-01T11:00:00Z",
          turnId: "t1",
          item: { type: "user_message", text: "Epoch 2" },
        },
      ],
      hasOlder: false,
      startCursor: { epoch: "e2", seq: 1 },
      error: null,
    });
    await flush();

    // Older in-flight tail (#2, from before replacement) resolves late -> MUST be ignored
    resolvers[1]({
      entries: [
        {
          seqStart: 99,
          seqEnd: 99,
          timestamp: "2026-01-01T10:00:05Z",
          turnId: "stale",
          item: { type: "user_message", text: "Stale tail" },
        },
      ],
      hasOlder: true,
      startCursor: { epoch: "e1", seq: 1 },
      error: null,
    });
    await flush();

    const turns = store.getSnapshot().get("a1")!.turns;
    assert.equal(turns.length, 1);
    assert.equal(turns[0].prompt, "Epoch 2");
    assert.equal(turns[0].status, "completed");
    assert.equal(turns[0].error, undefined);
  });

  it("ignores stale loadOlder rejection after reset and does not clear new epoch loadingOlder", async () => {
    const mock = createMockPaseo();
    let rejectOldBefore!: (err: Error) => void;
    let resolveNewBefore!: (page: MockPage) => void;
    let beforeCalls = 0;
    let tailCalls = 0;

    mock.setRefetch("a1", (opts) => {
      if (opts.direction === "before") {
        beforeCalls += 1;
        if (beforeCalls === 1) {
          return new Promise<MockPage>((_resolve, reject) => {
            rejectOldBefore = reject;
          });
        }
        return new Promise<MockPage>((resolve) => {
          resolveNewBefore = resolve;
        });
      }
      tailCalls += 1;
      const epoch = tailCalls === 1 ? "e1" : "e2";
      return Promise.resolve({
        entries: [
          {
            seqStart: 10,
            seqEnd: 10,
            timestamp: "2026-01-01T10:00:00Z",
            turnId: `t-${epoch}`,
            item: { type: "user_message", text: epoch },
          },
        ],
        hasOlder: true,
        startCursor: { epoch, seq: 10 },
        error: null,
      });
    });

    const store = new TurnFeedStore(mock.paseo);
    store.setAgents([{ id: "a1", running: false }]);
    await flush();

    // Start loadOlder on epoch 1
    const oldLoad = store.loadOlder("a1");
    assert.equal(store.getSnapshot().get("a1")?.loadingOlder, true);

    // Replacement resets epoch and clears loadingOlder so epoch 2 can load older immediately
    mock.emit("a1", { agentId: "a1", event: { type: "replacement", epoch: "e2" } });
    await flush();
    assert.equal(store.getSnapshot().get("a1")?.loadingOlder, false);

    // Start loadOlder on epoch 2, then reject stale epoch 1 loadOlder
    const newLoad = store.loadOlder("a1");
    assert.equal(store.getSnapshot().get("a1")?.loadingOlder, true);

    rejectOldBefore(new Error("stale epoch 1 failure"));
    await oldLoad;
    assert.equal(store.getSnapshot().get("a1")?.error, undefined);
    assert.equal(store.getSnapshot().get("a1")?.loadingOlder, true);

    resolveNewBefore({
      entries: [],
      hasOlder: false,
      startCursor: { epoch: "e2", seq: 1 },
      error: null,
    });
    await newLoad;
    assert.equal(store.getSnapshot().get("a1")?.loadingOlder, false);
  });

  it("removes subsumed canonical chunks and drops rawSeq-less merged live chunks after tail refetch", async () => {
    const mock = createMockPaseo();
    let tailCalls = 0;

    mock.setRefetch("a1", async () => {
      tailCalls += 1;
      if (tailCalls === 1) {
        return {
          entries: [
            {
              seqStart: 1,
              seqEnd: 1,
              timestamp: "2026-01-01T10:00:00Z",
              item: { type: "user_message", text: "Hi" },
            },
            {
              seqStart: 2,
              seqEnd: 2,
              timestamp: "2026-01-01T10:00:01Z",
              item: { type: "assistant_message", text: "Part 1 " },
            },
            {
              seqStart: 3,
              seqEnd: 3,
              timestamp: "2026-01-01T10:00:02Z",
              item: { type: "assistant_message", text: "Part 2" },
            },
          ],
          hasOlder: false,
          startCursor: { epoch: "e1", seq: 1 },
          error: null,
        };
      }
      return {
        entries: [
          {
            seqStart: 1,
            seqEnd: 1,
            timestamp: "2026-01-01T10:00:00Z",
            item: { type: "user_message", text: "Hi" },
          },
          {
            seqStart: 2,
            seqEnd: 4,
            timestamp: "2026-01-01T10:00:01Z",
            item: { type: "assistant_message", text: "Part 1 Part 2 Part 3" },
          },
        ],
        hasOlder: false,
        startCursor: { epoch: "e1", seq: 1 },
        error: null,
      };
    });

    const store = new TurnFeedStore(mock.paseo);
    store.setAgents([{ id: "a1", running: true }]);
    await flush();

    // Live chunk without rawSeq and without turnId arrives
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:03Z",
      event: {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "Part 3" },
      },
    });
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:04Z",
      event: { type: "turn_completed", provider: "pi" },
    });
    await flush();

    const items = store.getSnapshot().get("a1")!.turns[0].items;
    assert.equal(items.length, 2);
    assert.equal(
      items[1].item.type === "assistant_message" && items[1].item.text,
      "Part 1 Part 2 Part 3",
    );
  });

  it("clears prior error on turn_completed and merges usage across events", async () => {
    const mock = createMockPaseo();
    mock.setRefetch("a1", async () => ({
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          timestamp: "2026-01-01T10:00:00Z",
          turnId: "t1",
          item: { type: "user_message", text: "Hello" },
        },
      ],
      hasOlder: false,
      startCursor: { epoch: "e1", seq: 1 },
      error: null,
    }));

    const store = new TurnFeedStore(mock.paseo);
    store.setAgents([{ id: "a1", running: true }]);
    await flush();

    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:01Z",
      event: { type: "turn_failed", turnId: "t1", provider: "pi", error: "transient" },
    });
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:02Z",
      event: {
        type: "turn_completed",
        turnId: "t1",
        provider: "pi",
        usage: { inputTokens: 120, outputTokens: 30 },
      },
    });
    await flush();

    const turn = store.getSnapshot().get("a1")!.turns[0];
    assert.equal(turn.status, "completed");
    assert.equal(turn.error, undefined);
    assert.deepEqual(turn.usage, {
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it("does not regress a newer live tool_call completion when an older in-flight tail resolves", async () => {
    const mock = createMockPaseo();
    const resolvers: Array<(page: MockPage) => void> = [];
    mock.setRefetch(
      "a1",
      () =>
        new Promise<MockPage>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const store = new TurnFeedStore(mock.paseo);
    store.setAgents([{ id: "a1", running: true }]);
    await flush();

    // Initial tail starts with a running tool_call c1 at seq 1
    resolvers[0]({
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          timestamp: "2026-01-01T10:00:00Z",
          turnId: "t1",
          item: {
            type: "tool_call",
            callId: "c1",
            name: "bash",
            status: "running",
            error: null,
            detail: { type: "shell", command: "npm test" },
          },
        },
      ],
      hasOlder: false,
      startCursor: { epoch: "e1", seq: 1 },
      error: null,
    });
    await flush();

    // Start a tail refetch (e.g. from turn_completed on an earlier turn), then live updates arrive
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:01Z",
      event: { type: "turn_completed", turnId: "t0", provider: "pi" },
    });
    assert.equal(resolvers.length, 2);

    // Live completion for canonical c1 (rawSeq: 5) and live c2 starting (seq 6) then completing (seq 8)
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:02Z",
      seq: 5,
      event: {
        type: "timeline",
        turnId: "t1",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "c1",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "npm test", output: "ok", exitCode: 0 },
        },
      },
    });
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:03Z",
      seq: 6,
      event: {
        type: "timeline",
        turnId: "t1",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "c2",
          name: "read",
          status: "running",
          error: null,
          detail: { type: "read", filePath: "a.ts" },
        },
      },
    });
    mock.emit("a1", {
      agentId: "a1",
      timestamp: "2026-01-01T10:00:04Z",
      seq: 8,
      event: {
        type: "timeline",
        turnId: "t1",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "c2",
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "a.ts", content: "hello" },
        },
      },
    });

    // In-flight tail resolves with stale snapshots (c1 at seq 1 running, c2 at seq 6 running)
    resolvers[1]({
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          timestamp: "2026-01-01T10:00:00Z",
          turnId: "t1",
          item: {
            type: "tool_call",
            callId: "c1",
            name: "bash",
            status: "running",
            error: null,
            detail: { type: "shell", command: "npm test" },
          },
        },
        {
          seqStart: 6,
          seqEnd: 6,
          timestamp: "2026-01-01T10:00:03Z",
          turnId: "t1",
          item: {
            type: "tool_call",
            callId: "c2",
            name: "read",
            status: "running",
            error: null,
            detail: { type: "read", filePath: "a.ts" },
          },
        },
      ],
      hasOlder: false,
      startCursor: { epoch: "e1", seq: 1 },
      error: null,
    });
    await flush();

    const items = store.getSnapshot().get("a1")!.turns[0].items;
    assert.equal(items.length, 2);
    assert.equal(items[0].item.type === "tool_call" && items[0].item.status, "completed");
    assert.equal(items[1].item.type === "tool_call" && items[1].item.status, "completed");
    assert.equal("arrivalSeq" in items[0], false);
    assert.equal("liveRawSeq" in items[0], false);
  });
});
