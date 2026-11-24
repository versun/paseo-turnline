import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  readCodexPrompt,
  readCodexUsage,
  resolveCodexSessionFile,
} from "../../../server/providers/codex";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "turnline-codex-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveCodexSessionFile", () => {
  it("resolves direct .jsonl handles, dated sessions rollouts, archived_sessions, metadata.threadId, and CODEX_HOME", async () => {
    const direct = join(dir, "direct.jsonl");
    await writeFile(direct, "", "utf8");
    assert.equal(await resolveCodexSessionFile(direct, undefined, undefined, dir), direct);

    const activeDir = join(dir, "sessions", "2026", "11", "23");
    await mkdir(activeDir, { recursive: true });
    const activeRollout = join(
      activeDir,
      "rollout-2026-11-23T08-00-00-019a1b2c-3d4e-7f5a-8b9c-0d1e2f3a4b5c.jsonl",
    );
    await writeFile(activeRollout, "", "utf8");

    assert.equal(
      await resolveCodexSessionFile(
        "019a1b2c-3d4e-7f5a-8b9c-0d1e2f3a4b5c",
        "019a1b2c-3d4e-7f5a-8b9c-0d1e2f3a4b5c",
        undefined,
        dir,
      ),
      activeRollout,
    );

    // Fallback via metadata.threadId
    assert.equal(
      await resolveCodexSessionFile(
        undefined,
        undefined,
        { threadId: "019a1b2c-3d4e-7f5a-8b9c-0d1e2f3a4b5c" },
        dir,
      ),
      activeRollout,
    );

    // Archived session lookup
    const archivedDir = join(dir, "archived_sessions");
    await mkdir(archivedDir, { recursive: true });
    const archivedRollout = join(
      archivedDir,
      "rollout-2026-11-20T12-00-00-thread-archived-1.jsonl",
    );
    await writeFile(archivedRollout, "", "utf8");

    assert.equal(
      await resolveCodexSessionFile(undefined, "thread-archived-1", undefined, dir),
      archivedRollout,
    );

    // Respects CODEX_HOME env var when codexHome argument is omitted
    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    try {
      assert.equal(
        await resolveCodexSessionFile(undefined, "thread-archived-1"),
        archivedRollout,
      );
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
    }
  });

  it("rejects traversal paths, relative .jsonl handles, and unsafe session ids", async () => {
    const escapeFile = join(dir, "escape.jsonl");
    await writeFile(escapeFile, "", "utf8");
    const subDir = join(dir, "nested");
    await mkdir(subDir, { recursive: true });

    assert.equal(
      await resolveCodexSessionFile(`${subDir}/../escape.jsonl`, undefined, undefined, dir),
      undefined,
    );
    assert.equal(
      await resolveCodexSessionFile(relative(process.cwd(), escapeFile), undefined, undefined, dir),
      undefined,
    );
    assert.equal(
      await resolveCodexSessionFile("../escape.jsonl", undefined, undefined, dir),
      undefined,
    );
    assert.equal(
      await resolveCodexSessionFile(undefined, "../escape", undefined, dir),
      undefined,
    );
    assert.equal(
      await resolveCodexSessionFile("escape.jsonl", undefined, undefined, dir),
      undefined,
    );
    assert.equal(
      await resolveCodexSessionFile(undefined, undefined, { threadId: "../escape" }, dir),
      undefined,
    );

    // Directory ending in .jsonl must not be accepted; falls back when sessionId or metadata.threadId is present
    const dirHandle = join(dir, "rollout-dir.jsonl");
    await mkdir(dirHandle, { recursive: true });
    const rolloutDir = join(dir, "sessions", "2026", "11", "24");
    await mkdir(rolloutDir, { recursive: true });
    const fallbackRollout = join(rolloutDir, "rollout-2026-11-24T09-00-00-thread-dir-fallback.jsonl");
    await writeFile(fallbackRollout, "", "utf8");

    assert.equal(
      await resolveCodexSessionFile(dirHandle, undefined, undefined, dir),
      undefined,
    );
    assert.equal(
      await resolveCodexSessionFile(dirHandle, "thread-dir-fallback", undefined, dir),
      fallbackRollout,
    );
    assert.equal(
      await resolveCodexSessionFile(dirHandle, "   ", { threadId: "thread-dir-fallback" }, dir),
      fallbackRollout,
    );

    // Whitespace-only sessionId must fall back to nativeHandle and metadata.threadId
    assert.equal(
      await resolveCodexSessionFile("thread-dir-fallback", "   ", undefined, dir),
      fallbackRollout,
    );
    assert.equal(
      await resolveCodexSessionFile(undefined, "   ", { threadId: "thread-dir-fallback" }, dir),
      fallbackRollout,
    );
  });
});

describe("readCodexPrompt", () => {
  it("replays session_meta, turn_context, developer sections, tool calls, and `at` filtering", async () => {
    const file = join(dir, "codex-prompt.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2026-11-23T10:00:00Z",
        type: "session_meta",
        payload: {
          id: "thread-1",
          timestamp: "2026-11-23T10:00:00Z",
          cwd: "/repo",
          base_instructions: { text: "You are Codex." },
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:01Z",
        type: "turn_context",
        payload: {
          model: "gpt-5.4",
          developer_instructions: "Follow repository guidelines.",
          user_instructions: "# AGENTS.md\nAlways run tests.",
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:01.100Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<permissions instructions>\nRead-only sandbox\n</permissions instructions>" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:01.200Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: 'Supersedes earlier.\n<paseo_instruction_snapshot>{"version":1,"instructions":"v1"}</paseo_instruction_snapshot>',
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:02Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Check git status" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:03Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checking repository state" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:04Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"git status"}',
          call_id: "call_1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:05Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "On branch main",
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:06Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "Clean working tree on main." }],
        },
      }),
      // Turn 2 updates model, supersedes Paseo instruction snapshot, and calls apply_patch
      JSON.stringify({
        timestamp: "2026-11-23T10:05:00Z",
        type: "turn_context",
        payload: {
          collaboration_mode: {
            mode: "plan",
            settings: {
              model: "gpt-5.4-codex",
              developer_instructions: "Plan mode instructions.",
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:05:00.500Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: 'Supersedes earlier.\n<paseo_instruction_snapshot>{"version":1,"instructions":"v2"}</paseo_instruction_snapshot>',
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:05:02Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch",
          call_id: "call_patch_1",
        },
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    // Snapshot at turn 1
    const t1 = await readCodexPrompt({
      sessionFile: file,
      at: "2026-11-23T10:01:00Z",
      includeMessages: true,
    });
    assert.equal(t1.model, "gpt-5.4");
    assert.equal(t1.capturedAt, "2026-11-23T10:00:06Z");
    assert.equal(t1.toolsKind, "observed");
    assert.deepEqual(t1.tools, ["exec_command"]);
    assert.deepEqual(
      t1.sections.map((s) => s.name),
      [
        "base_instructions",
        "developer_instructions",
        "user_instructions",
        "permissions_instructions",
        "paseo_instruction_snapshot",
      ],
    );
    assert.match(t1.sections[4].text, /"v1"/);
    assert.equal(t1.messageCount, 5);
    assert.equal(t1.messages?.length, 5);
    assert.equal(t1.messages?.[0].role, "user");
    assert.equal(t1.messages?.[1].content, "[thinking]\nChecking repository state");
    assert.match(t1.messages?.[2].content ?? "", /\[tool call: exec_command\]/);
    assert.equal(t1.messages?.[3].role, "tool");
    assert.equal(t1.messages?.[4].content, "Clean working tree on main.");
    assert.equal(t1.source?.kind, "codex-session");

    // Latest snapshot: updated model, replaced Paseo snapshot (no duplicate v1), new tool
    const latest = await readCodexPrompt({ sessionFile: file, includeMessages: false });
    assert.equal(latest.model, "gpt-5.4-codex");
    assert.deepEqual(latest.tools, ["exec_command", "apply_patch"]);
    const paseoSections = latest.sections.filter((s) => s.name === "paseo_instruction_snapshot");
    assert.equal(paseoSections.length, 1);
    assert.match(paseoSections[0].text, /"v2"/);
    assert.equal(
      latest.sections.find((s) => s.name === "developer_instructions")?.text,
      "Plan mode instructions.",
    );
    assert.equal(latest.messages, undefined);
    assert.equal(latest.messageCount, 6);
  });

  it("handles compacted replacement_history, event-only legacy rollouts, and invalid timestamps", async () => {
    const compactedFile = join(dir, "codex-compacted.jsonl");
    await writeFile(
      compactedFile,
      [
        JSON.stringify({
          timestamp: "2026-11-23T10:00:00Z",
          type: "session_meta",
          payload: { id: "t-comp", instructions: "Base prompt" },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T10:00:01Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Old message 1" }] },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T10:00:02Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Old reply 1" }] },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T10:01:00Z",
          type: "compacted",
          payload: {
            replacement_history: [
              { type: "message", role: "user", content: [{ type: "input_text", text: "Compacted summary" }] },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const compacted = await readCodexPrompt({ sessionFile: compactedFile, includeMessages: true });
    assert.equal(compacted.messageCount, 1);
    assert.equal(compacted.messages?.[0].content, "Compacted summary");
    assert.deepEqual(compacted.sections, [{ name: "base_instructions", text: "Base prompt" }]);

    // Legacy event_msg-only rollout
    const legacyFile = join(dir, "codex-legacy.jsonl");
    await writeFile(
      legacyFile,
      [
        "corrupt json",
        JSON.stringify({
          timestamp: "2026-11-23T11:00:00Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Legacy user prompt" },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T11:00:05Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Legacy reply" },
        }),
      ].join("\n"),
      "utf8",
    );
    const legacy = await readCodexPrompt({ sessionFile: legacyFile, includeMessages: true });
    assert.equal(legacy.messageCount, 2);
    assert.equal(legacy.messages?.[0].content, "Legacy user prompt");
    assert.equal(legacy.messages?.[1].content, "Legacy reply");

    await assert.rejects(
      () => readCodexPrompt({ sessionFile: legacyFile, at: "invalid-date" }),
      /invalid timestamp/,
    );
  });

  it("does not resurrect pre-compaction event_msg history on dual-logged rollouts and renders compaction checkpoints & summaries", async () => {
    // Case A: dual-logged rollout where replacement_history has developer/system + remote compaction item
    const dualCompactionFile = join(dir, "codex-dual-compaction.jsonl");
    await writeFile(
      dualCompactionFile,
      [
        JSON.stringify({
          timestamp: "2026-11-23T10:00:01Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Stale pre-compaction event user" },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T10:00:02Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Stale pre-compaction response user" }] },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T10:00:03Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Stale pre-compaction event assistant" },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T10:01:00Z",
          type: "compacted",
          payload: {
            replacement_history: [
              { type: "message", role: "developer", content: [{ type: "input_text", text: "Post-compaction dev rule" }] },
              { type: "compaction", encrypted_content: "opaque-blob" },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const dualCompacted = await readCodexPrompt({ sessionFile: dualCompactionFile, includeMessages: true });
    assert.equal(dualCompacted.messageCount, 1);
    assert.deepEqual(dualCompacted.messages, [
      { role: "system", content: "[compaction checkpoint]", at: "2026-11-23T10:01:00Z" },
    ]);
    assert.deepEqual(dualCompacted.sections, [{ name: "developer", text: "Post-compaction dev rule" }]);

    // Case B: dual-logged rollout where replacement_history has ONLY developer/system items (0 conversation messages)
    const devOnlyCompactionFile = join(dir, "codex-dual-devonly-compaction.jsonl");
    await writeFile(
      devOnlyCompactionFile,
      [
        JSON.stringify({
          timestamp: "2026-11-23T10:00:01Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Must NOT resurrect" },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T10:00:02Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Old response item" }] },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T10:01:00Z",
          type: "compacted",
          payload: {
            replacement_history: [
              { type: "message", role: "system", content: [{ type: "input_text", text: "System prompt only" }] },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const devOnly = await readCodexPrompt({ sessionFile: devOnlyCompactionFile, includeMessages: true });
    assert.equal(devOnly.messageCount, 0);
    assert.deepEqual(devOnly.messages, []);
    assert.deepEqual(devOnly.sections, [{ name: "system", text: "System prompt only" }]);

    // Case C: summary-only compacted entry (`payload.message`)
    const summaryOnlyFile = join(dir, "codex-compacted-summary.jsonl");
    await writeFile(
      summaryOnlyFile,
      JSON.stringify({
        timestamp: "2026-11-23T10:02:00Z",
        type: "compacted",
        payload: { message: "Summarized prior work." },
      }),
      "utf8",
    );
    const summaryOnly = await readCodexPrompt({ sessionFile: summaryOnlyFile, includeMessages: true });
    assert.equal(summaryOnly.messageCount, 1);
    assert.deepEqual(summaryOnly.messages, [
      { role: "system", content: "[compaction summary]\nSummarized prior work.", at: "2026-11-23T10:02:00Z" },
    ]);
  });

  it("guards whitespace-only angle-bracket tags, separates unnamed developer/system counters, handles empty files, and invalidates cache on update", async () => {
    const emptyFile = join(dir, "codex-empty.jsonl");
    await writeFile(emptyFile, "", "utf8");
    const emptyPrompt = await readCodexPrompt({ sessionFile: emptyFile, includeMessages: true });
    assert.equal(emptyPrompt.messageCount, 0);
    assert.deepEqual(emptyPrompt.sections, []);
    assert.deepEqual(emptyPrompt.messages, []);

    const sectionsFile = join(dir, "codex-sections-and-cache.jsonl");
    const initialLines = [
      JSON.stringify({
        timestamp: "2026-11-23T12:00:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<  >\nWhitespace tag body" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T12:00:01Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "First untagged system prompt" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T12:00:02Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Second untagged developer prompt" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T12:00:03Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "Second untagged system prompt" }],
        },
      }),
    ];
    await writeFile(sectionsFile, initialLines.join("\n"), "utf8");

    const first = await readCodexPrompt({ sessionFile: sectionsFile, includeMessages: true });
    assert.deepEqual(
      first.sections.map((s) => s.name),
      ["developer", "system", "developer #2", "system #2"],
    );

    // Mutate returned prompt to verify cache returns clones
    first.sections.push({ name: "mutated", text: "nope" });
    const cachedHit = await readCodexPrompt({ sessionFile: sectionsFile, includeMessages: true });
    assert.equal(cachedHit.sections.length, 4);

    // Append a new message and verify cache invalidates
    await writeFile(
      sectionsFile,
      [
        ...initialLines,
        JSON.stringify({
          timestamp: "2026-11-23T12:01:00Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "After update" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const updated = await readCodexPrompt({ sessionFile: sectionsFile, includeMessages: true });
    assert.equal(updated.messageCount, 1);
    assert.equal(updated.messages?.[0].content, "After update");
  });
});

describe("readCodexUsage", () => {
  it("extracts per-call usage from token_count, attaches callIds/messageId/prefixes, and skips null/duplicate events", async () => {
    const file = join(dir, "codex-usage.jsonl");
    const lines = [
      "null",
      "{bad json",
      JSON.stringify({
        timestamp: "2026-11-23T10:00:00Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn_1" },
      }),
      // Rate-limit-only token_count with null info must be skipped
      JSON.stringify({
        timestamp: "2026-11-23T10:00:00.500Z",
        type: "event_msg",
        payload: { type: "token_count", info: null },
      }),
      // LLM call 1: reasoning + 2 tool calls
      JSON.stringify({
        timestamp: "2026-11-23T10:00:01Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Need to inspect files." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:02Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_shell_1",
          name: "exec_command",
          arguments: '{"cmd":"ls"}',
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:02.100Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call_patch_1",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 12000,
              cached_input_tokens: 9000,
              output_tokens: 240,
              reasoning_output_tokens: 80,
              total_tokens: 12240,
            },
            total_token_usage: {
              input_tokens: 12000,
              cached_input_tokens: 9000,
              output_tokens: 240,
              total_tokens: 12240,
            },
          },
        },
      }),
      // Duplicate token_count with identical total_token_usage must be skipped
      JSON.stringify({
        timestamp: "2026-11-23T10:00:03.500Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 12000,
              cached_input_tokens: 9000,
              output_tokens: 240,
              total_tokens: 12240,
            },
            total_token_usage: {
              input_tokens: 12000,
              cached_input_tokens: 9000,
              output_tokens: 240,
              total_tokens: 12240,
            },
          },
        },
      }),
      // LLM call 2: assistant reply
      JSON.stringify({
        timestamp: "2026-11-23T10:00:06Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "msg_final_1",
          role: "assistant",
          content: [{ type: "output_text", text: "All files updated." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:07Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 15000,
              cached_input_tokens: 12500,
              output_tokens: 95,
              total_tokens: 15095,
            },
            total_token_usage: {
              input_tokens: 27000,
              cached_input_tokens: 21500,
              output_tokens: 335,
              total_tokens: 27335,
            },
          },
        },
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    const records = await readCodexUsage(file);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
      at: "2026-11-23T10:00:03Z",
      messageId: undefined,
      callIds: ["call_shell_1", "fc_1", "call_patch_1"],
      textPrefix: undefined,
      thinkingPrefix: "Need to inspect files.",
      usage: {
        inputTokens: 12000,
        cachedInputTokens: 9000,
        outputTokens: 240,
      },
    });
    assert.deepEqual(records[1], {
      at: "2026-11-23T10:00:07Z",
      messageId: "msg_final_1",
      callIds: undefined,
      textPrefix: "All files updated.",
      thinkingPrefix: undefined,
      usage: {
        inputTokens: 15000,
        cachedInputTokens: 12500,
        outputTokens: 95,
      },
    });
  });

  it("computes deltas when only total_token_usage is present and resets pending artifacts on new turns", async () => {
    const file = join(dir, "codex-usage-delta.jsonl");
    const lines = [
      // Orphaned assistant text from an aborted turn without token_count
      JSON.stringify({
        timestamp: "2026-11-23T10:00:01Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Aborted partial reply" },
      }),
      // New turn starts -> must clear stale pending textPrefix
      JSON.stringify({
        timestamp: "2026-11-23T10:01:00Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn_2" },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:01:02Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Fresh reply 1" },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:01:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:01:10Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Fresh reply 2" },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:01:11Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 2500, cached_input_tokens: 1600, output_tokens: 120 },
          },
        },
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    const records = await readCodexUsage(file);
    assert.equal(records.length, 2);
    assert.equal(records[0].textPrefix, "Fresh reply 1");
    assert.deepEqual(records[0].usage, {
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 50,
    });
    assert.equal(records[1].textPrefix, "Fresh reply 2");
    assert.deepEqual(records[1].usage, {
      inputTokens: 1500,
      cachedInputTokens: 1200,
      outputTokens: 70,
    });
  });

  it("handles cumulative counter resets on process resume, skips zero-token events without dropping pending attribution, handles empty files, and invalidates cache", async () => {
    const emptyFile = join(dir, "codex-usage-empty.jsonl");
    await writeFile(emptyFile, "", "utf8");
    assert.deepEqual(await readCodexUsage(emptyFile), []);

    const file = join(dir, "codex-usage-reset-and-zero.jsonl");
    const lines = [
      // Pending call + text accumulated before an initial zero-token heartbeat event
      JSON.stringify({
        timestamp: "2026-11-23T10:00:01Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call_keep_1",
          arguments: "{}",
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:00:01.500Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Kept across zero event" },
      }),
      // Zero-token heartbeat must NOT emit a 0/0 record and must NOT drop pending callIds/textPrefix
      JSON.stringify({
        timestamp: "2026-11-23T10:00:02Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
          },
        },
      }),
      // Actual call 1 completes
      JSON.stringify({
        timestamp: "2026-11-23T10:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 2500, cached_input_tokens: 1600, output_tokens: 120 },
          },
        },
      }),
      // Process resumes -> cumulative counter resets from 2500/1600/120 down to 600/200/45
      JSON.stringify({
        timestamp: "2026-11-23T10:05:00Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "After process resume" },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:05:01Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 600, cached_input_tokens: 200, output_tokens: 45 },
          },
        },
      }),
      // Next call after reset computes delta from 600/200/45 -> 900/500/55
      JSON.stringify({
        timestamp: "2026-11-23T10:05:10Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Follow-up after resume" },
      }),
      JSON.stringify({
        timestamp: "2026-11-23T10:05:11Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 1500, cached_input_tokens: 700, output_tokens: 100 },
          },
        },
      }),
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    const records = await readCodexUsage(file);
    assert.equal(records.length, 3);
    assert.deepEqual(records[0].callIds, ["call_keep_1"]);
    assert.equal(records[0].textPrefix, "Kept across zero event");
    assert.deepEqual(records[0].usage, {
      inputTokens: 2500,
      cachedInputTokens: 1600,
      outputTokens: 120,
    });
    assert.equal(records[1].textPrefix, "After process resume");
    assert.deepEqual(records[1].usage, {
      inputTokens: 600,
      cachedInputTokens: 200,
      outputTokens: 45,
    });
    assert.equal(records[2].textPrefix, "Follow-up after resume");
    assert.deepEqual(records[2].usage, {
      inputTokens: 900,
      cachedInputTokens: 500,
      outputTokens: 55,
    });

    // Mutate returned record to verify cache isolation, then verify cache invalidates on file update
    records[0].usage.outputTokens = 9999;
    const cached = await readCodexUsage(file);
    assert.equal(cached[0].usage.outputTokens, 120);

    await writeFile(
      file,
      [
        ...lines,
        JSON.stringify({
          timestamp: "2026-11-23T10:06:00Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 30 },
              total_token_usage: { input_tokens: 1900, cached_input_tokens: 800, output_tokens: 130 },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const updated = await readCodexUsage(file);
    assert.equal(updated.length, 4);
    assert.deepEqual(updated[3].usage, {
      inputTokens: 400,
      cachedInputTokens: 100,
      outputTokens: 30,
    });
  });
});
