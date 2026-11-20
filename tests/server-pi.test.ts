import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readPiPrompt, resolvePiSessionFile } from "../server/providers/pi";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "turnline-pi-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readPiPrompt", () => {
  it("replays sections, patches, tool additions/removals, model changes, and compaction checkpoints", async () => {
    const file = join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T10:00:00Z",
        message: {
          role: "system",
          sections: { base: "Base instructions", temp: "Drop me", bad: 123 },
          toolsAdded: [{ name: "bash" }, { name: "read" }],
          provider: "anthropic",
          model: "claude-sonnet",
        },
      }),
      "not valid json {{{",
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T10:00:05Z",
        message: {
          role: "user",
          content: "Inspect repo",
          timestamp: Date.parse("2026-01-01T10:00:05Z"),
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T10:00:10Z",
        message: {
          role: "system",
          sections: { temp: null, extra: "Extra section" },
          toolsAdded: [{ name: "edit" }],
          toolsRemoved: [{ name: "read" }],
        },
      }),
      // Compaction WITHOUT systemMessage MUST NOT wipe accumulated prompt state
      JSON.stringify({
        type: "compaction",
        timestamp: "2026-01-01T10:00:15Z",
      }),
      JSON.stringify({
        type: "model_change",
        timestamp: "2026-01-01T10:00:20Z",
        provider: "openai",
        modelId: "gpt-5",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T10:00:25Z",
        message: {
          role: "assistant",
          timestamp: Number.NaN,
          content: [
            null,
            { type: "thinking", text: "Planning step" },
            { type: "text", text: "Running tool" },
            { type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
            { type: "toolResult", content: [{ type: "text", text: "ok" }] },
            { type: "image" },
          ],
        },
      }),
      // Compaction WITH systemMessage replaces accumulated state
      JSON.stringify({
        type: "compaction",
        timestamp: "2026-01-01T10:01:00Z",
        systemMessage: {
          sections: { compacted: "Fresh prompt" },
          toolsAdded: [{ name: "write" }],
          provider: "anthropic",
          model: "claude-opus",
        },
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    // Before compaction checkpoint (at 10:00:30Z)
    const beforeCompact = await readPiPrompt({
      sessionFile: file,
      at: "2026-01-01T10:00:30Z",
      includeMessages: true,
    });
    assert.equal(beforeCompact.model, "openai/gpt-5");
    assert.equal(beforeCompact.capturedAt, "2026-01-01T10:00:10Z");
    assert.deepEqual(beforeCompact.sections, [
      { name: "base", text: "Base instructions" },
      { name: "extra", text: "Extra section" },
    ]);
    assert.deepEqual(beforeCompact.tools, ["bash", "edit"]);
    assert.equal(beforeCompact.toolsKind, "declared");
    assert.equal(beforeCompact.messageCount, 2);
    assert.equal(beforeCompact.messages?.length, 2);
    assert.equal(beforeCompact.messages?.[1].at, "2026-01-01T10:00:25Z");
    assert.match(beforeCompact.messages?.[1].content ?? "", /\[thinking\]\nPlanning step/);
    assert.match(beforeCompact.messages?.[1].content ?? "", /\[tool call: bash\]/);
    assert.match(beforeCompact.messages?.[1].content ?? "", /\[image\]/);

    // Latest (after compaction checkpoint)
    const latest = await readPiPrompt({ sessionFile: file });
    assert.equal(latest.capturedAt, "2026-01-01T10:01:00Z");
    assert.equal(latest.model, "anthropic/claude-opus");
    assert.deepEqual(latest.sections, [{ name: "compacted", text: "Fresh prompt" }]);
    assert.deepEqual(latest.tools, ["write"]);
    assert.equal(latest.toolsKind, "declared");
    assert.equal(latest.messages, undefined);
    assert.equal(latest.messageCount, 2);
    assert.deepEqual(latest.source, { kind: "pi-session", path: file });
  });

  it("respects systemMessage.timestamp on compaction checkpoints when entry.timestamp is absent", async () => {
    const file = join(dir, "compaction-nested-ts.jsonl");
    const lines = [
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T10:00:00Z",
        message: { role: "system", sections: { base: "Original" } },
      }),
      JSON.stringify({
        type: "compaction",
        systemMessage: {
          timestamp: Date.parse("2026-01-01T10:05:00Z"),
          sections: { compacted: "After" },
          model: "standalone-model",
        },
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    const before = await readPiPrompt({ sessionFile: file, at: "2026-01-01T10:01:00Z" });
    assert.deepEqual(before.sections, [{ name: "base", text: "Original" }]);
    assert.equal(before.tools, undefined);

    const after = await readPiPrompt({ sessionFile: file, at: "2026-01-01T10:06:00Z" });
    assert.deepEqual(after.sections, [{ name: "compacted", text: "After" }]);
    assert.equal(after.model, "standalone-model");
    assert.equal(after.capturedAt, "2026-01-01T10:05:00.000Z");
  });

  it("throws on invalid `at` timestamp", async () => {
    const file = join(dir, "empty.jsonl");
    await writeFile(file, "", "utf8");
    await assert.rejects(
      () => readPiPrompt({ sessionFile: file, at: "not-a-timestamp" }),
      /invalid timestamp/,
    );
  });
});

describe("resolvePiSessionFile", () => {
  it("resolves direct existing .jsonl nativeHandle and falls back to cwd slug lookup", async () => {
    const direct = join(dir, "direct.jsonl");
    await writeFile(direct, "", "utf8");
    assert.equal(await resolvePiSessionFile(direct, undefined, undefined, dir), direct);

    const slugDir = join(dir, "--Users-dev-myproj--");
    await mkdir(slugDir, { recursive: true });
    const sessionPath = join(slugDir, "2026-01-01T00-00-00_abc123.jsonl");
    await writeFile(sessionPath, "", "utf8");

    // Handles trailing slash in cwd
    assert.equal(
      await resolvePiSessionFile(undefined, "abc123", "/Users/dev/myproj/", dir),
      sessionPath,
    );
    // Falls back if nativeHandle points to a moved/missing .jsonl file
    assert.equal(
      await resolvePiSessionFile("/missing/old.jsonl", "abc123", "/Users/dev/myproj", dir),
      sessionPath,
    );
    // Resolves moved .jsonl nativeHandle by basename when sessionId is omitted or empty
    assert.equal(
      await resolvePiSessionFile(
        "/moved/2026-01-01T00-00-00_abc123.jsonl",
        undefined,
        "/Users/dev/myproj",
        dir,
      ),
      sessionPath,
    );
    assert.equal(
      await resolvePiSessionFile(
        "/moved/2026-01-01T00-00-00_abc123.jsonl",
        "",
        "/Users/dev/myproj",
        dir,
      ),
      sessionPath,
    );
    assert.equal(
      await resolvePiSessionFile(undefined, "unknown", "/Users/dev/myproj", dir),
      undefined,
    );
  });
});
