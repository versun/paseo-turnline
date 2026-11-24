import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import contributeClient from "../../index.client";
import contributeServer from "../../index.server";
import { getAgentPromptHandler } from "../../server/prompt";
import { resolveProviderChannel, type ResolvedAgent } from "../../server/resolve-agent";
import { getAgentUsageHandler } from "../../server/usage";
import { getAgentPrompt } from "../../shared/prompt";
import { getAgentUsage } from "../../shared/usage";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "turnline-handler-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function mockHandlerContext(options: {
  refreshed?: any;
  refreshThrows?: boolean;
  listed?: any[];
  listedPages?: Array<{ entries: any[]; nextCursor?: string | null }>;
  onList?: (opts: any) => void;
}): PluginHandlerContext {
  return {
    paseo: {
      agents: {
        ref() {
          return {
            async refresh() {
              if (options.refreshThrows) throw new Error("archived");
              return options.refreshed ? { agent: options.refreshed } : null;
            },
          };
        },
        async list(opts?: any) {
          options.onList?.(opts);
          if (options.listedPages) {
            const pageIndex = opts?.page?.cursor ? Number(opts.page.cursor) : 0;
            const page = options.listedPages[pageIndex] ?? { entries: [], nextCursor: null };
            return {
              entries: page.entries.map((agent) => ({ agent })),
              pageInfo: {
                hasMore: Boolean(page.nextCursor),
                nextCursor: page.nextCursor ?? null,
                prevCursor: null,
              },
            };
          }
          return {
            entries: (options.listed ?? []).map((agent) => ({ agent })),
          };
        },
      },
    },
  } as unknown as PluginHandlerContext;
}

describe("getAgentPromptHandler", () => {
  it("returns unavailable when agent cannot be resolved", async () => {
    const out = await getAgentPromptHandler(
      { agentId: "missing" },
      mockHandlerContext({ refreshThrows: true, listed: [] }),
    );
    assert.equal(out.status, "unavailable");
    assert.equal(out.reason, "agent not found");
    assert.ok(getAgentPrompt.output.safeParse(out).success);
  });

  it("falls back to agents.list() when refresh throws and reads a pi session", async () => {
    const file = join(dir, "pi.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T10:00:00Z",
        message: { role: "system", sections: { core: "Hi" }, toolsAdded: [{ name: "bash" }] },
      }),
      "utf8",
    );

    const listCalls: any[] = [];
    const out = await getAgentPromptHandler(
      { agentId: "a1" },
      mockHandlerContext({
        refreshThrows: true,
        onList: (opts) => listCalls.push(opts),
        listedPages: [
          { entries: [{ id: "other", provider: "pi", cwd: dir }], nextCursor: "1" },
          {
            entries: [
              {
                id: "a1",
                provider: "pi",
                cwd: dir,
                persistence: { provider: "pi", sessionId: "s1", nativeHandle: file },
              },
            ],
            nextCursor: null,
          },
        ],
      }),
    );
    assert.equal(out.status, "ok");
    assert.equal(out.provider, "pi");
    assert.equal(listCalls.length, 2);
    assert.equal(listCalls[0]?.filter?.includeArchived, true);
    assert.equal(listCalls[0]?.page?.limit, 200);
    assert.equal(listCalls[1]?.page?.cursor, "1");
    assert.deepEqual(out.prompt?.sections, [{ name: "core", text: "Hi" }]);
    assert.ok(getAgentPrompt.output.safeParse(out).success);
  });

  it("returns unavailable when pi session file or devin session id is missing", async () => {
    const piMissing = await getAgentPromptHandler(
      { agentId: "a1" },
      mockHandlerContext({
        refreshed: { id: "a1", provider: "pi", cwd: dir },
      }),
    );
    assert.equal(piMissing.status, "unavailable");
    assert.match(piMissing.reason ?? "", /not found/);

    const devinMissing = await getAgentPromptHandler(
      { agentId: "a2" },
      mockHandlerContext({
        refreshed: { id: "a2", provider: "devin", cwd: dir },
      }),
    );
    assert.equal(devinMissing.status, "unavailable");
    assert.match(devinMissing.reason ?? "", /session id unknown/);
  });

  it("returns unsupported for providers without a prompt channel", async () => {
    const out = await getAgentPromptHandler(
      { agentId: "a3" },
      mockHandlerContext({
        refreshed: { id: "a3", provider: "opencode", cwd: dir },
      }),
    );
    assert.equal(out.status, "unsupported");
    assert.equal(out.provider, "opencode");
    assert.ok(getAgentPrompt.output.safeParse(out).success);
  });

  it("handles claude, codex, missing session files, and custom providers extending built-ins", async () => {
    const claudeMissing = await getAgentPromptHandler(
      { agentId: "cl-missing" },
      mockHandlerContext({
        refreshed: { id: "cl-missing", provider: "claude", cwd: dir },
      }),
    );
    assert.equal(claudeMissing.status, "unavailable");
    assert.match(claudeMissing.reason ?? "", /claude session file not found/);
    assert.ok(getAgentPrompt.output.safeParse(claudeMissing).success);

    const claudeFile = join(dir, "claude-handler-prompt.jsonl");
    await writeFile(
      claudeFile,
      [
        JSON.stringify({
          type: "api-request-shape",
          shapeHash: "h1",
          timestamp: "2026-01-01T10:00:00Z",
          shape: {
            system: [{ type: "text", text: "You are Claude Code." }],
            tools: [{ name: "Read" }],
          },
        }),
        JSON.stringify({
          type: "api-request",
          timestamp: "2026-01-01T10:00:00Z",
          shapeHash: "h1",
          params: { model: "claude-opus-4-6" },
        }),
      ].join("\n"),
      "utf8",
    );

    const claudeOk = await getAgentPromptHandler(
      { agentId: "cl-ok" },
      mockHandlerContext({
        refreshed: {
          id: "cl-ok",
          provider: "claude-work",
          cwd: dir,
          persistence: { provider: "claude", sessionId: "s-cl", nativeHandle: claudeFile },
        },
      }),
    );
    assert.equal(claudeOk.status, "ok");
    assert.equal(claudeOk.provider, "claude-work");
    assert.equal(claudeOk.prompt?.model, "claude-opus-4-6");
    assert.equal(claudeOk.prompt?.source?.kind, "claude-session");
    assert.deepEqual(claudeOk.prompt?.tools, ["Read"]);
    assert.ok(getAgentPrompt.output.safeParse(claudeOk).success);

    const codexMissing = await getAgentPromptHandler(
      { agentId: "cx-missing" },
      mockHandlerContext({
        refreshed: { id: "cx-missing", provider: "codex", cwd: dir },
      }),
    );
    assert.equal(codexMissing.status, "unavailable");
    assert.match(codexMissing.reason ?? "", /codex session file not found/);
    assert.ok(getAgentPrompt.output.safeParse(codexMissing).success);

    const codexHome = join(dir, "codex-prompt-home");
    const rolloutDir = join(codexHome, "sessions", "2026", "11", "23");
    await mkdir(rolloutDir, { recursive: true });
    const rolloutFile = join(rolloutDir, "rollout-2026-11-23T10-00-00-cx-thread-1.jsonl");
    await writeFile(
      rolloutFile,
      [
        JSON.stringify({
          timestamp: "2026-11-23T10:00:00Z",
          type: "session_meta",
          payload: { id: "cx-thread-1", base_instructions: { text: "Base Codex prompt" } },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T10:00:01Z",
          type: "turn_context",
          payload: { model: "gpt-5.4", developer_instructions: "Dev rules" },
        }),
      ].join("\n"),
      "utf8",
    );

    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const codexOk = await getAgentPromptHandler(
        { agentId: "cx-ok" },
        mockHandlerContext({
          refreshed: {
            id: "cx-ok",
            provider: "codex-work",
            cwd: dir,
            persistence: {
              provider: "codex",
              sessionId: "cx-thread-1",
              nativeHandle: "cx-thread-1",
            },
          },
        }),
      );
      assert.equal(codexOk.status, "ok");
      assert.equal(codexOk.provider, "codex-work");
      assert.equal(codexOk.prompt?.model, "gpt-5.4");
      assert.equal(codexOk.prompt?.source?.kind, "codex-session");
      assert.deepEqual(
        codexOk.prompt?.sections.map((s) => s.name),
        ["base_instructions", "developer_instructions"],
      );
      assert.ok(getAgentPrompt.output.safeParse(codexOk).success);
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
    }
  });

  it("rejects Claude and Codex sessionId traversal/absolute paths and catches invalid `at` timestamps", async () => {
    const secretFile = join(dir, "prompt-secret.jsonl");
    await writeFile(secretFile, "{}", "utf8");

    // Claude: traversal and absolute-path sessionId with unset nativeHandle must be rejected
    const claudeTraversal = await getAgentPromptHandler(
      { agentId: "cl-p-trav" },
      mockHandlerContext({
        refreshed: {
          id: "cl-p-trav",
          provider: "claude",
          cwd: dir,
          persistence: { provider: "claude", sessionId: "../prompt-secret.jsonl" },
        },
      }),
    );
    assert.equal(claudeTraversal.status, "unavailable");
    assert.match(claudeTraversal.reason ?? "", /claude session file not found/);
    assert.ok(getAgentPrompt.output.safeParse(claudeTraversal).success);

    const claudeAbs = await getAgentPromptHandler(
      { agentId: "cl-p-abs" },
      mockHandlerContext({
        refreshed: {
          id: "cl-p-abs",
          provider: "claude",
          cwd: dir,
          persistence: { provider: "claude", sessionId: secretFile },
        },
      }),
    );
    assert.equal(claudeAbs.status, "unavailable");
    assert.ok(getAgentPrompt.output.safeParse(claudeAbs).success);

    // Codex: traversal and absolute-path sessionId with unset nativeHandle must be rejected
    const codexTraversal = await getAgentPromptHandler(
      { agentId: "cx-p-trav" },
      mockHandlerContext({
        refreshed: {
          id: "cx-p-trav",
          provider: "codex",
          cwd: dir,
          persistence: { provider: "codex", sessionId: "../prompt-secret.jsonl" },
        },
      }),
    );
    assert.equal(codexTraversal.status, "unavailable");
    assert.match(codexTraversal.reason ?? "", /codex session file not found/);
    assert.ok(getAgentPrompt.output.safeParse(codexTraversal).success);

    const codexAbs = await getAgentPromptHandler(
      { agentId: "cx-p-abs" },
      mockHandlerContext({
        refreshed: {
          id: "cx-p-abs",
          provider: "codex",
          cwd: dir,
          persistence: { provider: "codex", sessionId: secretFile },
        },
      }),
    );
    assert.equal(codexAbs.status, "unavailable");
    assert.ok(getAgentPrompt.output.safeParse(codexAbs).success);

    // Invalid `at` timestamps hit the handler catch branch for both Claude and Codex
    const claudeInvalidAt = await getAgentPromptHandler(
      { agentId: "cl-p-bad-at", at: "not-a-date" },
      mockHandlerContext({
        refreshed: {
          id: "cl-p-bad-at",
          provider: "claude",
          cwd: dir,
          persistence: { provider: "claude", nativeHandle: secretFile },
        },
      }),
    );
    assert.equal(claudeInvalidAt.status, "unavailable");
    assert.equal(claudeInvalidAt.provider, "claude");
    assert.match(claudeInvalidAt.reason ?? "", /invalid timestamp/);
    assert.ok(getAgentPrompt.output.safeParse(claudeInvalidAt).success);

    const codexInvalidAt = await getAgentPromptHandler(
      { agentId: "cx-p-bad-at", at: "not-a-date" },
      mockHandlerContext({
        refreshed: {
          id: "cx-p-bad-at",
          provider: "codex",
          cwd: dir,
          persistence: { provider: "codex", nativeHandle: secretFile },
        },
      }),
    );
    assert.equal(codexInvalidAt.status, "unavailable");
    assert.equal(codexInvalidAt.provider, "codex");
    assert.match(codexInvalidAt.reason ?? "", /invalid timestamp/);
    assert.ok(getAgentPrompt.output.safeParse(codexInvalidAt).success);
  });

  it("handles antigravity missing id, missing db, and valid conversation db", async () => {
    const noId = await getAgentPromptHandler(
      { agentId: "ag1" },
      mockHandlerContext({
        refreshed: { id: "ag1", provider: "antigravity", cwd: dir },
      }),
    );
    assert.equal(noId.status, "unavailable");
    assert.match(noId.reason ?? "", /conversation id unknown/);
    assert.ok(getAgentPrompt.output.safeParse(noId).success);

    const convId = "11111111-2222-3333-4444-555555555555";
    const prevHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const missingDb = await getAgentPromptHandler(
        { agentId: "ag2" },
        mockHandlerContext({
          refreshed: {
            id: "ag2",
            provider: "antigravity",
            cwd: dir,
            persistence: {
              provider: "antigravity",
              sessionId: `plugin:${JSON.stringify({ version: 1, data: { conversationId: convId } })}`,
            },
          },
        }),
      );
      assert.equal(missingDb.status, "unavailable");
      assert.match(missingDb.reason ?? "", /conversation db not found/);
      assert.ok(getAgentPrompt.output.safeParse(missingDb).success);

      const convDir = join(dir, ".gemini", "antigravity-cli", "conversations");
      await mkdir(convDir, { recursive: true });
      const dbFile = join(convDir, `${convId}.db`);
      // Minimal valid protobuf: f1 { f16 { f1: "identity", f2: "Hi" }, f21: "Gemini" }
      const section = Buffer.concat([
        Buffer.from([0x0a, 0x08]),
        Buffer.from("identity"),
        Buffer.from([0x12, 0x02]),
        Buffer.from("Hi"),
      ]);
      const body = Buffer.concat([
        Buffer.from([0x82, 0x01, section.length]),
        section,
        Buffer.from([0xaa, 0x01, 0x06]),
        Buffer.from("Gemini"),
      ]);
      const blob = Buffer.concat([Buffer.from([0x0a, body.length]), body]);
      execFileSync("sqlite3", [
        dbFile,
        `CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (idx));
         INSERT INTO gen_metadata VALUES (1, x'${blob.toString("hex")}', ${blob.length});`,
      ]);

      const ok = await getAgentPromptHandler(
        { agentId: "ag3" },
        mockHandlerContext({
          refreshed: {
            id: "ag3",
            provider: "antigravity",
            cwd: dir,
            persistence: {
              provider: "antigravity",
              metadata: {
                pluginProviderPersistence: { version: 1, data: { conversationId: convId } },
              },
            },
          },
        }),
      );
      assert.equal(ok.status, "ok");
      assert.equal(ok.provider, "antigravity");
      assert.equal(ok.prompt?.model, "Gemini");
      assert.equal(ok.prompt?.latestOnly, true);
      assert.deepEqual(ok.prompt?.sections, [{ name: "identity", text: "Hi" }]);
      assert.ok(getAgentPrompt.output.safeParse(ok).success);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

describe("getAgentUsageHandler", () => {
  it("returns unavailable when agent cannot be resolved and unsupported for unknown providers", async () => {
    const missing = await getAgentUsageHandler({ agentId: "nope" }, mockHandlerContext({}));
    assert.equal(missing.status, "unavailable");
    assert.ok(getAgentUsage.output.safeParse(missing).success);

    const unsupported = await getAgentUsageHandler(
      { agentId: "opencode-1" },
      mockHandlerContext({ refreshed: { id: "opencode-1", provider: "opencode", cwd: dir } }),
    );
    assert.equal(unsupported.status, "unsupported");
    assert.ok(getAgentUsage.output.safeParse(unsupported).success);
  });

  it("reads pi, claude, and codex session usage records (including custom profiles) and validates against output schema", async () => {
    const piFile = join(dir, "pi-usage.jsonl");
    await writeFile(
      piFile,
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-01-01T10:00:00Z",
        message: {
          role: "assistant",
          usage: { input: 2000, cacheRead: 8000, cacheWrite: 0, output: 150, cost: { total: 0.01 } },
          content: [{ type: "text", text: "Hi" }],
        },
      }),
      "utf8",
    );

    const piRes = await getAgentUsageHandler(
      { agentId: "pi-1" },
      mockHandlerContext({
        refreshed: {
          id: "pi-1",
          provider: "pi",
          cwd: dir,
          persistence: { provider: "pi", nativeHandle: piFile },
        },
      }),
    );
    assert.equal(piRes.status, "ok");
    assert.equal(piRes.records?.length, 1);
    assert.equal(piRes.records?.[0].usage.inputTokens, 10000);
    assert.equal(piRes.records?.[0].usage.cachedInputTokens, 8000);
    assert.ok(getAgentUsage.output.safeParse(piRes).success);

    const claudeFile = join(dir, "claude-usage.jsonl");
    await writeFile(
      claudeFile,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T10:00:00Z",
        message: {
          id: "msg_c1",
          role: "assistant",
          usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 },
          content: [{ type: "text", text: "Hello" }],
        },
      }),
      "utf8",
    );

    const claudeRes = await getAgentUsageHandler(
      { agentId: "cl-1" },
      mockHandlerContext({
        refreshed: {
          id: "cl-1",
          provider: "claude",
          cwd: dir,
          persistence: { provider: "claude", nativeHandle: claudeFile },
        },
      }),
    );
    assert.equal(claudeRes.status, "ok");
    assert.equal(claudeRes.records?.length, 1);
    assert.equal(claudeRes.records?.[0].usage.inputTokens, 1000);
    assert.equal(claudeRes.records?.[0].usage.cachedInputTokens, 900);
    assert.ok(getAgentUsage.output.safeParse(claudeRes).success);

    const codexMissing = await getAgentUsageHandler(
      { agentId: "cx-missing" },
      mockHandlerContext({
        refreshed: { id: "cx-missing", provider: "codex", cwd: dir },
      }),
    );
    assert.equal(codexMissing.status, "unavailable");
    assert.match(codexMissing.reason ?? "", /codex session file not found/);
    assert.ok(getAgentUsage.output.safeParse(codexMissing).success);

    const codexFile = join(dir, "codex-usage-handler.jsonl");
    await writeFile(
      codexFile,
      [
        JSON.stringify({
          timestamp: "2026-11-23T10:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "msg_cx_1",
            role: "assistant",
            content: [{ type: "output_text", text: "Done." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-11-23T10:00:02Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 4000,
                cached_input_tokens: 3200,
                output_tokens: 80,
              },
              total_token_usage: {
                input_tokens: 4000,
                cached_input_tokens: 3200,
                output_tokens: 80,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const codexRes = await getAgentUsageHandler(
      { agentId: "cx-1" },
      mockHandlerContext({
        refreshed: {
          id: "cx-1",
          provider: "codex-custom",
          cwd: dir,
          persistence: { provider: "codex", nativeHandle: codexFile },
        },
      }),
    );
    assert.equal(codexRes.status, "ok");
    assert.equal(codexRes.provider, "codex-custom");
    assert.equal(codexRes.records?.length, 1);
    assert.equal(codexRes.records?.[0].messageId, "msg_cx_1");
    assert.equal(codexRes.records?.[0].usage.inputTokens, 4000);
    assert.equal(codexRes.records?.[0].usage.cachedInputTokens, 3200);
    assert.equal(codexRes.records?.[0].usage.outputTokens, 80);
    assert.ok(getAgentUsage.output.safeParse(codexRes).success);
  });

  it("handles devin, antigravity, missing files, Claude sessionId traversal rejection, and error catch branch", async () => {
    // Missing session file paths for pi and claude
    const piMissing = await getAgentUsageHandler(
      { agentId: "pi-missing" },
      mockHandlerContext({
        refreshed: {
          id: "pi-missing",
          provider: "pi",
          cwd: dir,
          persistence: { provider: "pi", nativeHandle: join(dir, "nope.jsonl") },
        },
      }),
    );
    assert.equal(piMissing.status, "unavailable");
    assert.match(piMissing.reason ?? "", /pi session file not found/);
    assert.ok(getAgentUsage.output.safeParse(piMissing).success);

    // Claude sessionId traversal must NOT be promoted into nativeHandle
    const claudeTraversal = await getAgentUsageHandler(
      { agentId: "cl-escape" },
      mockHandlerContext({
        refreshed: {
          id: "cl-escape",
          provider: "claude",
          cwd: dir,
          persistence: { provider: "claude", sessionId: "../escape.jsonl" },
        },
      }),
    );
    assert.equal(claudeTraversal.status, "unavailable");
    assert.match(claudeTraversal.reason ?? "", /claude session file not found/);
    assert.ok(getAgentUsage.output.safeParse(claudeTraversal).success);

    // Claude absolute path via sessionId (with nativeHandle unset) must also be rejected
    const secretFile = join(dir, "secret.jsonl");
    await writeFile(secretFile, "{}", "utf8");
    const claudeAbsSessionId = await getAgentUsageHandler(
      { agentId: "cl-abs-sid" },
      mockHandlerContext({
        refreshed: {
          id: "cl-abs-sid",
          provider: "claude",
          cwd: dir,
          persistence: { provider: "claude", sessionId: secretFile },
        },
      }),
    );
    assert.equal(claudeAbsSessionId.status, "unavailable");
    assert.ok(getAgentUsage.output.safeParse(claudeAbsSessionId).success);

    // Devin: unknown session id -> unavailable
    const devinNoId = await getAgentUsageHandler(
      { agentId: "dv-noid" },
      mockHandlerContext({
        refreshed: { id: "dv-noid", provider: "devin", cwd: dir },
      }),
    );
    assert.equal(devinNoId.status, "unavailable");
    assert.match(devinNoId.reason ?? "", /devin session id unknown/);
    assert.ok(getAgentUsage.output.safeParse(devinNoId).success);

    // Devin: valid DB via XDG_DATA_HOME + error catch branch when session is missing from DB
    const prevXdg = process.env.XDG_DATA_HOME;
    const xdgRoot = join(dir, "xdg-usage");
    const devinDir = join(xdgRoot, "devin", "cli");
    await mkdir(devinDir, { recursive: true });
    const devinDb = join(devinDir, "sessions.db");
    execFileSync("sqlite3", [
      devinDb,
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, main_chain_id INTEGER);
       CREATE TABLE message_nodes (node_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, parent_node_id INTEGER, created_at REAL, chat_message TEXT NOT NULL);
       INSERT INTO sessions VALUES ('dv-sess-1', 'swe-2', 1);
       INSERT INTO message_nodes VALUES (1, 'dv-sess-1', NULL, 5000, '{"message_id":"dm1","role":"assistant","content":"Ready","metadata":{"metrics":{"input_tokens":500,"cache_read_tokens":1500,"output_tokens":80,"context_input_tokens":2000}}}');`,
    ]);
    process.env.XDG_DATA_HOME = xdgRoot;
    try {
      const devinOk = await getAgentUsageHandler(
        { agentId: "dv-1" },
        mockHandlerContext({
          refreshed: {
            id: "dv-1",
            provider: "devin",
            cwd: dir,
            persistence: { provider: "devin", sessionId: "dv-sess-1" },
          },
        }),
      );
      assert.equal(devinOk.status, "ok");
      assert.equal(devinOk.provider, "devin");
      assert.equal(devinOk.records?.length, 1);
      assert.equal(devinOk.records?.[0].usage.inputTokens, 2000);
      assert.equal(devinOk.records?.[0].usage.cachedInputTokens, 1500);
      assert.ok(getAgentUsage.output.safeParse(devinOk).success);

      // Missing session throws inside readDevinUsage -> caught by handler catch branch
      const devinErr = await getAgentUsageHandler(
        { agentId: "dv-err" },
        mockHandlerContext({
          refreshed: {
            id: "dv-err",
            provider: "devin",
            cwd: dir,
            persistence: { provider: "devin", sessionId: "nonexistent-session" },
          },
        }),
      );
      assert.equal(devinErr.status, "unavailable");
      assert.match(devinErr.reason ?? "", /no devin session/);
      assert.ok(getAgentUsage.output.safeParse(devinErr).success);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
    }

    // Antigravity: missing id, missing db, and valid db with steps table
    const agNoId = await getAgentUsageHandler(
      { agentId: "ag-u1" },
      mockHandlerContext({
        refreshed: { id: "ag-u1", provider: "antigravity", cwd: dir },
      }),
    );
    assert.equal(agNoId.status, "unavailable");
    assert.match(agNoId.reason ?? "", /conversation id unknown/);
    assert.ok(getAgentUsage.output.safeParse(agNoId).success);

    const convId = "22222222-3333-4444-5555-666666666666";
    const prevHome = process.env.HOME;
    const agHome = join(dir, "ag-usage-home");
    process.env.HOME = agHome;
    try {
      const agMissingDb = await getAgentUsageHandler(
        { agentId: "ag-u2" },
        mockHandlerContext({
          refreshed: {
            id: "ag-u2",
            provider: "antigravity",
            cwd: dir,
            persistence: {
              provider: "antigravity",
              sessionId: `plugin:${JSON.stringify({ version: 1, data: { conversationId: convId } })}`,
            },
          },
        }),
      );
      assert.equal(agMissingDb.status, "unavailable");
      assert.match(agMissingDb.reason ?? "", /conversation db not found/);
      assert.ok(getAgentUsage.output.safeParse(agMissingDb).success);

      const convDir = join(agHome, ".gemini", "antigravity-cli", "conversations");
      await mkdir(convDir, { recursive: true });
      const dbFile = join(convDir, `${convId}.db`);
      // Minimal valid planner usage protobuf: meta { f9 { f2: 100 (uncached), f3: 25 (output), f5: 900 (cached) } }
      // varint(100)=0x64, varint(25)=0x19, varint(900)=0x84 0x07
      const usageBuf = Buffer.from([0x10, 0x64, 0x18, 0x19, 0x28, 0x84, 0x07]);
      const metaBuf = Buffer.concat([Buffer.from([0x4a, usageBuf.length]), usageBuf]);
      const payloadBuf = Buffer.from([0x08, 0x0f]);
      execFileSync("sqlite3", [
        dbFile,
        `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB);
         INSERT INTO steps VALUES (1, 15, x'${metaBuf.toString("hex")}', x'${payloadBuf.toString("hex")}');`,
      ]);

      const agOk = await getAgentUsageHandler(
        { agentId: "ag-u3" },
        mockHandlerContext({
          refreshed: {
            id: "ag-u3",
            provider: "antigravity",
            cwd: dir,
            persistence: {
              provider: "antigravity",
              metadata: {
                pluginProviderPersistence: { version: 1, data: { conversationId: convId } },
              },
            },
          },
        }),
      );
      assert.equal(agOk.status, "ok");
      assert.equal(agOk.provider, "antigravity");
      assert.equal(agOk.records?.length, 1);
      assert.equal(agOk.records?.[0].usage.inputTokens, 1000);
      assert.equal(agOk.records?.[0].usage.cachedInputTokens, 900);
      assert.equal(agOk.records?.[0].usage.outputTokens, 25);
      assert.ok(getAgentUsage.output.safeParse(agOk).success);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

describe("resolveProviderChannel", () => {
  const asAgent = (agent: Record<string, unknown>): ResolvedAgent =>
    agent as unknown as ResolvedAgent;

  it("follows precedence: agent.provider > persistence.provider > runtimeInfo.provider > persistence.metadata.provider", () => {
    // Built-in agent.provider wins over conflicting hints
    assert.equal(
      resolveProviderChannel(
        asAgent({
          provider: "claude",
          persistence: { provider: "codex", metadata: { provider: "pi" } },
          runtimeInfo: { provider: "devin" },
        }),
      ),
      "claude",
    );

    // Custom agent.provider falls back to built-in persistence.provider
    assert.equal(
      resolveProviderChannel(
        asAgent({
          provider: "my-claude-profile",
          persistence: { provider: "claude", metadata: { provider: "codex" } },
          runtimeInfo: { provider: "pi" },
        }),
      ),
      "claude",
    );

    // Custom persistence.provider falls through to built-in runtimeInfo.provider
    assert.equal(
      resolveProviderChannel(
        asAgent({
          provider: "my-codex-profile",
          persistence: { provider: "custom-store", metadata: { provider: "claude" } },
          runtimeInfo: { provider: "codex" },
        }),
      ),
      "codex",
    );

    // Custom runtimeInfo.provider falls through to built-in persistence.metadata.provider
    assert.equal(
      resolveProviderChannel(
        asAgent({
          provider: "my-custom-profile",
          persistence: { provider: "custom-store", metadata: { provider: "claude" } },
          runtimeInfo: { provider: "custom-runtime" },
        }),
      ),
      "claude",
    );
  });

  it("ignores malformed metadata and returns primary provider when no built-in channel matches", () => {
    assert.equal(
      resolveProviderChannel(
        asAgent({
          provider: "opencode",
          persistence: { provider: "opencode", metadata: ["claude"] },
        }),
      ),
      "opencode",
    );
    assert.equal(
      resolveProviderChannel(
        asAgent({
          provider: "opencode",
          persistence: { metadata: "claude" },
        }),
      ),
      "opencode",
    );
    assert.equal(
      resolveProviderChannel(
        asAgent({
          provider: "opencode",
          persistence: { metadata: { provider: 123 } },
        }),
      ),
      "opencode",
    );
    assert.equal(resolveProviderChannel(asAgent({})), "unknown");
  });
});

describe("plugin entrypoints", () => {
  it("registers the server RPC handlers", () => {
    const registered: unknown[] = [];
    const cleanup = contributeServer({
      handle(contract: unknown, handler: unknown) {
        registered.push({ contract, handler });
      },
    } as unknown as PluginServerContext);

    assert.equal(registered.length, 2);
    assert.equal((registered[0] as any).contract, getAgentPrompt);
    assert.equal((registered[0] as any).handler, getAgentPromptHandler);
    assert.equal((registered[1] as any).contract, getAgentUsage);
    assert.equal((registered[1] as any).handler, getAgentUsageHandler);
    assert.doesNotThrow(() => cleanup());
  });

  it("registers client panel and command center item and cleans up both on teardown", () => {
    let panelRemoved = false;
    let commandRemoved = false;
    let openedPanel: string | undefined;
    let panelDef: any;
    let commandDef: any;

    const cleanup = contributeClient({
      addWorkspacePanel(def: any) {
        panelDef = def;
        return () => {
          panelRemoved = true;
        };
      },
      addCommandCenterItem(def: any) {
        commandDef = def;
        return () => {
          commandRemoved = true;
        };
      },
    } as unknown as PluginClientContext);

    assert.equal(panelDef.id, "turns");
    assert.equal(commandDef.id, "open-turns");
    commandDef.onSelect({
      openPanel(id: string) {
        openedPanel = id;
      },
    });
    assert.equal(openedPanel, "turns");

    cleanup();
    assert.equal(panelRemoved, true);
    assert.equal(commandRemoved, true);
  });

  it("packages manifest icon, media assets, and OVERVIEW.md", async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const manifest = JSON.parse(await readFile(join(repoRoot, "paseo-plugin.json"), "utf8"));
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const packagedFiles: string[] = pkg.files ?? [];
    const isPackaged = (relPath: string) =>
      packagedFiles.some((entry) =>
        entry.endsWith("/") ? relPath.startsWith(entry) : entry === relPath,
      );

    assert.ok(existsSync(join(repoRoot, "OVERVIEW.md")), "OVERVIEW.md must exist");
    assert.ok(isPackaged("OVERVIEW.md"), "package.json#files must include OVERVIEW.md");

    const assetPaths = [manifest.icon, ...(manifest.media ?? [])].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    assert.ok(assetPaths.length > 0);
    for (const relPath of assetPaths) {
      assert.ok(existsSync(join(repoRoot, relPath)), `manifest asset missing: ${relPath}`);
      assert.ok(isPackaged(relPath), `package.json#files must include ${relPath}`);
    }
  });
});
