import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeEntry } from "../client/items";
import type { FeedEntry } from "../client/turn-model";

const mkEntry = (item: FeedEntry["item"]): FeedEntry => ({
  seq: 1,
  timestamp: "2026-01-01T00:00:00Z",
  item,
});

describe("describeEntry", () => {
  it("marks empty text entries as non-expandable", () => {
    assert.equal(describeEntry(mkEntry({ type: "user_message", text: "   " })).expandable, false);
    assert.equal(describeEntry(mkEntry({ type: "assistant_message", text: "" })).expandable, false);
    assert.equal(describeEntry(mkEntry({ type: "reasoning", text: "\n" })).expandable, false);
    assert.equal(describeEntry(mkEntry({ type: "error", message: "" })).expandable, false);
    assert.equal(
      describeEntry(mkEntry({ type: "user_message", text: "Hello\nWorld" })).summary,
      "Hello",
    );
  });

  it("surfaces failed tool call errors and marks them expandable", () => {
    const desc = describeEntry(
      mkEntry({
        type: "tool_call",
        callId: "c1",
        name: "read",
        status: "failed",
        error: "ENOENT: file not found",
        detail: { type: "read", filePath: "" },
      }),
    );
    assert.equal(desc.toolStatus, "failed");
    assert.equal(desc.errorText, "ENOENT: file not found");
    assert.equal(desc.summary, "ENOENT: file not found");
    assert.equal(desc.expandable, true);
  });

  it("describes shell, read/write (POSIX & Windows paths), and edit diffs cleanly", () => {
    const shell = describeEntry(
      mkEntry({
        type: "tool_call",
        callId: "s1",
        name: "bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm test", cwd: "/a/b/c/d", output: "ok", exitCode: 0 },
      }),
    );
    assert.equal(shell.bodyKind, "shell");
    assert.equal(shell.shell?.cwd, "/a/b/c/d");
    assert.equal(shell.shell?.exitCode, 0);
    assert.match(shell.body ?? "", /\$ npm test/);

    const winRead = describeEntry(
      mkEntry({
        type: "tool_call",
        callId: "r1",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "C:\\Users\\dev\\repo\\src\\index.ts", content: "hi" },
      }),
    );
    assert.equal(winRead.summary, "…/repo/src/index.ts");

    const edit = describeEntry(
      mkEntry({
        type: "tool_call",
        callId: "e1",
        name: "edit",
        status: "completed",
        error: null,
        detail: {
          type: "edit",
          filePath: "/repo/a.ts",
          unifiedDiff: "",
          oldString: "const a = 1;",
          newString: "const a = 2;",
        },
      }),
    );
    assert.equal(edit.bodyKind, "diff");
    assert.equal(edit.body, "- const a = 1;\n+ const a = 2;");

    const emptyShell = describeEntry(
      mkEntry({
        type: "tool_call",
        callId: "s-empty",
        name: "bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "" },
      }),
    );
    assert.equal(emptyShell.shell, undefined);
    assert.equal(emptyShell.expandable, false);
  });

  it("describes search, fetch, sub_agent, worktree_setup, todo, compaction, and plugin items", () => {
    const fetchDesc = describeEntry(
      mkEntry({
        type: "tool_call",
        callId: "f1",
        name: "fetch",
        status: "completed",
        error: null,
        detail: {
          type: "fetch",
          url: "https://example.com",
          code: 200,
          codeText: "OK",
          prompt: "get title",
          result: "Example",
        },
      }),
    );
    assert.equal(fetchDesc.bodyHeader, "HTTP 200 OK · https://example.com");

    const emptyUnknown = describeEntry(
      mkEntry({
        type: "tool_call",
        callId: "u1",
        name: "custom",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: undefined, output: undefined },
      }),
    );
    assert.equal(emptyUnknown.expandable, false);

    const todo = describeEntry(
      mkEntry({
        type: "todo",
        items: [
          { text: "Step 1", completed: true },
          { text: "Step 2", completed: false },
        ],
      }),
    );
    assert.equal(todo.summary, "1/2 completed");
    assert.equal(todo.expandable, true);

    const compaction = describeEntry(
      mkEntry({ type: "compaction", status: "completed", preTokens: 42_000 }),
    );
    assert.equal(compaction.label, "Context compacted");
    assert.equal(compaction.expandable, false);
    assert.match(compaction.summary ?? "", /42,000/);

    const compacting = describeEntry(mkEntry({ type: "compaction", status: "loading" }));
    assert.equal(compacting.label, "Compacting context…");
    assert.equal(compacting.expandable, false);

    const plugin = describeEntry(
      mkEntry({
        type: "plugin",
        id: "1",
        pluginId: "demo",
        kind: "trace",
        version: 1,
        data: { ok: true },
      }),
    );
    assert.equal(plugin.label, "Plugin · trace");
    assert.equal(plugin.expandable, true);
  });
});
