import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  readClaudePrompt,
  readClaudeUsage,
  resolveClaudeSessionFile,
} from "../../../server/providers/claude";

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

  it("respects CLAUDE_CONFIG_DIR and hashes >200-char cwd slugs like the Claude SDK", async () => {
    const customConfig = join(dir, "custom-claude-config");
    const longCwd = `/${"segment-".repeat(30)}app`;
    const expectedSlug =
      "-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-segment-gzw0w6";
    // Decoy sorts lexicographically before expectedSlug so fallback scan cannot mask broken hashing
    const decoyDir = join(customConfig, "projects", "-000-decoy");
    await mkdir(decoyDir, { recursive: true });
    await writeFile(join(decoyDir, "sess-env.jsonl"), "", "utf8");

    const slugDir = join(customConfig, "projects", expectedSlug);
    await mkdir(slugDir, { recursive: true });
    const sessionPath = join(slugDir, "sess-env.jsonl");
    await writeFile(sessionPath, "", "utf8");

    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = customConfig;
    try {
      assert.equal(
        await resolveClaudeSessionFile(undefined, "sess-env", longCwd),
        sessionPath,
      );
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it("handles symlinked cwd via realpath, rejects symlinked store files, and falls back on directory handles or whitespace sessionId", async () => {
    const projectsRoot = join(dir, "claude-sec-projects");
    await mkdir(projectsRoot, { recursive: true });

    // Symlinked cwd -> resolves via realpath(cwd) ahead of lexicographically earlier decoy
    const realWorkDir = join(dir, "real-workspace");
    await mkdir(realWorkDir, { recursive: true });
    const linkWorkDir = join(dir, "link-workspace");
    await symlink(realWorkDir, linkWorkDir);

    const canonicalWorkDir = await realpath(realWorkDir);
    const canonicalSlug = canonicalWorkDir.replace(/[^A-Za-z0-9]/g, "-");
    const decoyDir = join(projectsRoot, "-000-decoy");
    await mkdir(decoyDir, { recursive: true });
    await writeFile(join(decoyDir, "sess-link-cwd.jsonl"), "", "utf8");

    const realSlugDir = join(projectsRoot, canonicalSlug);
    await mkdir(realSlugDir, { recursive: true });
    const expectedPath = join(realSlugDir, "sess-link-cwd.jsonl");
    await writeFile(expectedPath, "", "utf8");

    assert.equal(
      await resolveClaudeSessionFile(undefined, "sess-link-cwd", linkWorkDir, projectsRoot),
      expectedPath,
    );

    // Symlinked .jsonl inside projectsRoot must be rejected in both direct cwd lookup and fallback scan
    const outsideSecret = join(dir, "outside-secret.txt");
    await writeFile(outsideSecret, "secret", "utf8");
    const symFile = join(realSlugDir, "sess-sym-escape.jsonl");
    await symlink(outsideSecret, symFile);

    assert.equal(
      await resolveClaudeSessionFile(undefined, "sess-sym-escape", linkWorkDir, projectsRoot),
      undefined,
    );
    assert.equal(
      await resolveClaudeSessionFile(undefined, "sess-sym-escape", undefined, projectsRoot),
      undefined,
    );

    // Directory ending in .jsonl must NOT be accepted as a direct handle; falls back to sessionId when provided
    const dirHandle = join(dir, "not-a-file.jsonl");
    await mkdir(dirHandle, { recursive: true });
    assert.equal(
      await resolveClaudeSessionFile(dirHandle, undefined, linkWorkDir, projectsRoot),
      undefined,
    );
    assert.equal(
      await resolveClaudeSessionFile(dirHandle, "sess-link-cwd", linkWorkDir, projectsRoot),
      expectedPath,
    );

    // Whitespace-only sessionId must fall back to nativeHandle
    assert.equal(
      await resolveClaudeSessionFile("sess-link-cwd", "   ", linkWorkDir, projectsRoot),
      expectedPath,
    );
    assert.equal(
      await resolveClaudeSessionFile(expectedPath, "   ", undefined, projectsRoot),
      expectedPath,
    );
  });
});

describe("readClaudePrompt", () => {
  it("replays api-request-shape, prompt_snapshot, system attachments, model, tools, and merged messages with `at` filtering", async () => {
    const file = join(dir, "claude-prompt-journal.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-01-01T10:00:00Z",
        message: { role: "user", content: "Inspect README" },
      }),
      JSON.stringify({
        type: "attachment",
        timestamp: "2026-01-01T10:00:00.500Z",
        renderedRole: "system",
        rendered: [{ content: "<system-reminder>\n# Environment\nCWD: /repo\n</system-reminder>" }],
        attachment: { type: "environment" },
      }),
      JSON.stringify({
        type: "api-request-shape",
        shapeHash: "shape-v1",
        timestamp: "2026-01-01T10:00:01Z",
        shape: {
          system: [
            { type: "text", text: "You are Claude Code." },
            { type: "text", text: "# Core\nBe helpful.\n# Style\nBe concise." },
          ],
          tools: [
            { name: "Read", description: "Read file" },
            { name: "Bash", description: "Run shell" },
          ],
        },
      }),
      JSON.stringify({
        type: "api-request",
        timestamp: "2026-01-01T10:00:01Z",
        shapeHash: "shape-v1",
        params: { model: "claude-opus-4-6" },
      }),
      // Multi-line assistant message sharing msg_1
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:02Z",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "thinking", thinking: "Let me read README." }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:03Z",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } }],
        },
      }),
      // Sidechain entry must be ignored
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        timestamp: "2026-01-01T10:00:04Z",
        message: {
          id: "msg_side",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "Subagent internal text" }],
        },
      }),
      // Later turn: prompt_snapshot breaks the system prompt into finer sections and adds Edit tool
      JSON.stringify({
        type: "user",
        timestamp: "2026-01-01T10:01:00Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "# Hello" }],
        },
      }),
      JSON.stringify({
        type: "attachment",
        timestamp: "2026-01-01T10:01:01Z",
        attachment: {
          type: "prompt_snapshot",
          cliPrefix: "You are Claude Code.",
          systemPrompt: ["# Core\nBe helpful.", "# Style\nBe concise."],
          tools: [{ name: "Read" }, { name: "Bash" }, { name: "Edit" }],
        },
      }),
      JSON.stringify({
        type: "api-request-shape",
        shapeHash: "shape-v2",
        timestamp: "2026-01-01T10:01:01.500Z",
        shape: {
          system: [
            { type: "text", text: "You are Claude Code." },
            { type: "text", text: "# Core\nBe helpful.\n# Style\nBe concise." },
          ],
          tools: [{ name: "Read" }, { name: "Bash" }, { name: "Edit" }],
        },
      }),
      JSON.stringify({
        type: "api-request",
        timestamp: "2026-01-01T10:01:02Z",
        shapeHash: "shape-v2",
        params: { model: "claude-sonnet-4-6" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:01:05Z",
        message: {
          id: "msg_2",
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "README says Hello." }],
        },
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    // Snapshot at turn 1 (before 10:01)
    const t1 = await readClaudePrompt({
      sessionFile: file,
      at: "2026-01-01T10:00:05Z",
      includeMessages: true,
    });
    assert.equal(t1.model, "claude-opus-4-6");
    assert.equal(t1.capturedAt, "2026-01-01T10:00:03Z");
    assert.equal(t1.toolsKind, "declared");
    assert.deepEqual(t1.tools, ["Read", "Bash"]);
    assert.deepEqual(
      t1.sections.map((s) => s.name),
      ["system", "Core", "environment"],
    );
    // Multi-line msg_1 merged into 1 assistant message, sidechain excluded
    assert.equal(t1.messageCount, 2);
    assert.equal(t1.messages?.length, 2);
    assert.equal(t1.messages?.[0].role, "user");
    assert.equal(t1.messages?.[1].role, "assistant");
    assert.match(t1.messages?.[1].content ?? "", /\[thinking\]/);
    assert.match(t1.messages?.[1].content ?? "", /\[tool call: Read\]/);
    assert.equal(t1.source?.kind, "claude-session");

    // Latest snapshot: prefers granular prompt_snapshot sections matching shape text, ignores <synthetic> model
    const latest = await readClaudePrompt({ sessionFile: file, includeMessages: false });
    assert.equal(latest.model, "claude-sonnet-4-6");
    assert.equal(latest.toolsKind, "declared");
    assert.deepEqual(latest.tools, ["Read", "Bash", "Edit"]);
    assert.deepEqual(
      latest.sections.map((s) => s.name),
      ["cli-prefix", "Core", "Style", "environment"],
    );
    assert.equal(latest.messages, undefined);
    assert.equal(latest.messageCount, 4);
  });

  it("falls back to classic transcript entries and observed tools when request journal is absent", async () => {
    const file = join(dir, "claude-classic.jsonl");
    const lines = [
      "not json",
      JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-01-01T09:00:00Z",
        content: "Session initialized.",
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-01-01T09:00:01Z",
        message: { role: "user", content: "Run tests" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T09:00:02Z",
        message: {
          id: "msg_a",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }],
        },
      }),
      JSON.stringify({
        type: "summary",
        timestamp: "2026-01-01T09:00:05Z",
        summary: "Ran unit tests.",
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    const prompt = await readClaudePrompt({ sessionFile: file, includeMessages: true });
    assert.equal(prompt.model, "claude-sonnet-4-5");
    assert.equal(prompt.toolsKind, "observed");
    assert.deepEqual(prompt.tools, ["Bash"]);
    assert.deepEqual(prompt.sections, [{ name: "init", text: "Session initialized." }]);
    assert.equal(prompt.messageCount, 4);
    assert.equal(prompt.messages?.[3].content, "[compaction summary]\nRan unit tests.");
  });

  it("skips isApiErrorMessage entries and invalidates prompt cache on file update", async () => {
    const file = join(dir, "claude-api-err-and-cache.jsonl");
    const baseLines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-01-01T10:00:00Z",
        message: { role: "user", content: "Hello" },
      }),
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        timestamp: "2026-01-01T10:00:05Z",
        message: {
          id: "msg_api_err",
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "API Error: overloaded" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:02Z",
        message: {
          id: "msg_ok",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Real answer" }],
        },
      }),
    ];
    await writeFile(file, baseLines.join("\n"), "utf8");

    const first = await readClaudePrompt({ sessionFile: file, includeMessages: true });
    assert.equal(first.messageCount, 2);
    assert.equal(first.capturedAt, "2026-01-01T10:00:02Z");
    assert.equal(first.model, "claude-sonnet-4-6");
    assert.deepEqual(
      first.messages?.map((m) => m.content),
      ["Hello", "Real answer"],
    );

    // Mutate returned object to verify cached copy is isolated
    first.messages?.push({ role: "user", content: "mutated" });
    const cachedHit = await readClaudePrompt({ sessionFile: file, includeMessages: true });
    assert.equal(cachedHit.messages?.length, 2);

    // Append a new message -> fingerprint changes and cache invalidates
    const updatedLines = [
      ...baseLines,
      JSON.stringify({
        type: "user",
        timestamp: "2026-01-01T10:01:00Z",
        message: { role: "user", content: "Follow-up question" },
      }),
    ];
    await writeFile(file, updatedLines.join("\n"), "utf8");

    const second = await readClaudePrompt({ sessionFile: file, includeMessages: true });
    assert.equal(second.messageCount, 3);
    assert.equal(second.capturedAt, "2026-01-01T10:01:00Z");
    assert.equal(second.messages?.[2].content, "Follow-up question");
  });

  it("throws on invalid `at` timestamp", async () => {
    const file = join(dir, "claude-invalid-at.jsonl");
    await writeFile(file, "", "utf8");
    await assert.rejects(
      () => readClaudePrompt({ sessionFile: file, at: "not-a-timestamp" }),
      /invalid timestamp/,
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

  it("skips sidechain, isApiErrorMessage, and synthetic zero-token stubs independently, and merges costUSD across chunks", async () => {
    const file = join(dir, "claude-sidechain-and-cost.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        timestamp: "2026-01-01T10:00:01Z",
        message: {
          id: "msg_side",
          role: "assistant",
          usage: { input_tokens: 500, output_tokens: 50 },
          content: [{ type: "text", text: "Subagent" }],
        },
      }),
      // API error stub with non-zero tokens -> filtered by isApiErrorMessage
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        timestamp: "2026-01-01T10:00:02Z",
        message: {
          id: "msg_api_err",
          role: "assistant",
          model: "claude-opus-4-6",
          usage: { input_tokens: 200, output_tokens: 30 },
          content: [{ type: "text", text: "API Error" }],
        },
      }),
      // Synthetic zero-token stub without isApiErrorMessage -> filtered by <synthetic> zero-token guard
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:02.500Z",
        message: {
          id: "msg_synth",
          role: "assistant",
          model: "<synthetic>",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: "Synthetic notice" }],
        },
      }),
      // Multi-line message merging costUSD (takes max across chunks)
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:03Z",
        costUSD: 0.042,
        message: {
          id: "msg_main",
          role: "assistant",
          model: "claude-opus-4-6",
          usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 40 },
          content: [{ type: "thinking", thinking: "Step 1" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:04Z",
        costUSD: 0.089,
        message: {
          id: "msg_main",
          role: "assistant",
          model: "claude-opus-4-6",
          usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 90 },
          content: [{ type: "text", text: "Main reply" }],
        },
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    const records = await readClaudeUsage(file);
    assert.equal(records.length, 1);
    assert.equal(records[0].messageId, "msg_main");
    assert.equal(records[0].usage.outputTokens, 90);
    assert.equal(records[0].usage.costUsd, 0.089);

    // Mutate returned record and verify cache returns a fresh clone, then invalidates on file update
    records[0].usage.costUsd = 999;
    const cached = await readClaudeUsage(file);
    assert.equal(cached[0].usage.costUsd, 0.089);

    await writeFile(
      file,
      [
        ...lines,
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-01-01T10:00:10Z",
          message: {
            id: "msg_next",
            role: "assistant",
            usage: { input_tokens: 300, output_tokens: 20 },
            content: [{ type: "text", text: "Second reply" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const updated = await readClaudeUsage(file);
    assert.equal(updated.length, 2);
    assert.equal(updated[1].messageId, "msg_next");
  });
});
