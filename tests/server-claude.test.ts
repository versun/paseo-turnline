import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { readClaudeUsage, resolveClaudeSessionFile } from "../server/providers/claude";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "turnline-claude-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveClaudeSessionFile", () => {
  it("resolves direct .jsonl path and cwd-slugged session file", async () => {
    const direct = join(dir, "direct.jsonl");
    await writeFile(direct, "", "utf8");
    assert.equal(await resolveClaudeSessionFile(direct, undefined, undefined, dir), direct);

    const slugDir = join(dir, "-Users-dev-my-app");
    await mkdir(slugDir, { recursive: true });
    const sessionPath = join(slugDir, "sess-123.jsonl");
    await writeFile(sessionPath, "", "utf8");

    assert.equal(
      await resolveClaudeSessionFile(undefined, "sess-123", "/Users/dev/my.app", dir),
      sessionPath,
    );
    assert.equal(
      await resolveClaudeSessionFile(undefined, "../escape", "/Users/dev/my.app", dir),
      undefined,
    );
  });

  it("rejects traversal paths and relative .jsonl handles, and supports fallback directory scan", async () => {
    const escapeFile = join(dir, "escape.jsonl");
    await writeFile(escapeFile, "", "utf8");
    const subDir = join(dir, "nested");
    await mkdir(subDir, { recursive: true });

    // Absolute path containing a ".." traversal segment must be rejected even if target exists
    const explicitTraversalAbs = `${subDir}/../escape.jsonl`;
    assert.equal(
      await resolveClaudeSessionFile(explicitTraversalAbs, undefined, undefined, dir),
      undefined,
    );

    // Relative .jsonl paths (both ../ and bare relative) must be rejected even when
    // the same basename exists inside the cwd slug directory (guards against basename stripping)
    const slugDir = join(dir, "-Users-dev-my-app");
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, "escape.jsonl"), "", "utf8");

    const relEscape = relative(process.cwd(), escapeFile);
    assert.equal(
      await resolveClaudeSessionFile(relEscape, undefined, undefined, dir),
      undefined,
    );
    assert.equal(
      await resolveClaudeSessionFile("../escape.jsonl", undefined, "/Users/dev/my.app", dir),
      undefined,
    );
    assert.equal(
      await resolveClaudeSessionFile("escape.jsonl", undefined, "/Users/dev/my.app", dir),
      undefined,
    );

    // Fallback directory scan finds session under another project slug when cwd differs or is omitted
    const otherSlug = join(dir, "-other-project");
    await mkdir(otherSlug, { recursive: true });
    const fallbackFile = join(otherSlug, "sess-fallback.jsonl");
    await writeFile(fallbackFile, "", "utf8");

    assert.equal(
      await resolveClaudeSessionFile(undefined, "sess-fallback", "/unmatched/cwd", dir),
      fallbackFile,
    );
    assert.equal(
      await resolveClaudeSessionFile(undefined, "sess-fallback", undefined, dir),
      fallbackFile,
    );
  });
});

describe("readClaudeUsage", () => {
  it("merges multi-line assistant entries sharing message.id and sums input + cache tokens", async () => {
    const file = join(dir, "claude-session.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:01Z",
        message: {
          id: "msg_1",
          role: "assistant",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 15000,
            output_tokens: 50,
          },
          content: [{ type: "thinking", thinking: "Thinking step" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:02Z",
        message: {
          id: "msg_1",
          role: "assistant",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 15000,
            output_tokens: 180,
          },
          content: [{ type: "tool_use", id: "toolu_abc", name: "Read" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:05Z",
        message: {
          id: "msg_2",
          role: "assistant",
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 20190,
            output_tokens: 90,
          },
          content: [{ type: "text", text: "Done editing." }],
        },
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    const records = await readClaudeUsage(file);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
      at: "2026-01-01T10:00:02Z",
      messageId: "msg_1",
      callIds: ["toolu_abc"],
      textPrefix: undefined,
      thinkingPrefix: "Thinking step",
      usage: {
        inputTokens: 20010,
        cachedInputTokens: 15000,
        cacheWriteTokens: 5000,
        outputTokens: 180,
      },
    });
    assert.deepEqual(records[1], {
      at: "2026-01-01T10:00:05Z",
      messageId: "msg_2",
      callIds: undefined,
      textPrefix: "Done editing.",
      thinkingPrefix: undefined,
      usage: {
        inputTokens: 20195,
        cachedInputTokens: 20190,
        cacheWriteTokens: undefined,
        outputTokens: 90,
      },
    });
  });

  it("handles JSON null/corrupt lines and preserves merged inputTokens and outputTokens when later lines omit fields", async () => {
    const file = join(dir, "claude-edge.jsonl");
    const lines = [
      "null",
      "{corrupt json",
      "42",
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { id: "no_usage", role: "assistant", content: "ignored" } }),
      // Line 1: full input + cache + initial output
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:01Z",
        message: {
          id: "msg_merge",
          role: "assistant",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 15000,
            output_tokens: 120,
          },
          content: [{ type: "thinking", thinking: "Step 1" }],
        },
      }),
      // Line 2: omits cache fields AND increases output_tokens
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:02Z",
        message: {
          id: "msg_merge",
          role: "assistant",
          usage: {
            input_tokens: 10,
            output_tokens: 180,
          },
          content: [{ type: "tool_use", id: "toolu_1", name: "Read" }],
        },
      }),
      // Line 3: omits output_tokens and emits cache_read_input_tokens: 0 (must NOT clobber 180 or 15000)
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:03Z",
        message: {
          id: "msg_merge",
          role: "assistant",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: "text", text: "Final text" }],
        },
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    const records = await readClaudeUsage(file);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      at: "2026-01-01T10:00:03Z",
      messageId: "msg_merge",
      callIds: ["toolu_1"],
      textPrefix: "Final text",
      thinkingPrefix: "Step 1",
      usage: {
        inputTokens: 20010,
        cachedInputTokens: 15000,
        cacheWriteTokens: 5000,
        outputTokens: 180,
      },
    });
  });
});
