import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import contributeClient from "../index.client";
import contributeServer from "../index.server";
import { getAgentPromptHandler } from "../server/prompt";
import { getAgentPrompt } from "../shared/prompt";

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
        refreshed: { id: "a3", provider: "claude", cwd: dir },
      }),
    );
    assert.equal(out.status, "unsupported");
    assert.equal(out.provider, "claude");
    assert.ok(getAgentPrompt.output.safeParse(out).success);
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

describe("plugin entrypoints", () => {
  it("registers the server RPC handler", () => {
    const registered: unknown[] = [];
    const cleanup = contributeServer({
      handle(contract: unknown, handler: unknown) {
        registered.push({ contract, handler });
      },
    } as unknown as PluginServerContext);

    assert.equal(registered.length, 1);
    assert.equal((registered[0] as any).contract, getAgentPrompt);
    assert.equal((registered[0] as any).handler, getAgentPromptHandler);
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
});
