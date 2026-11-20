import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { devinDbPath, readDevinPrompt } from "../server/providers/devin";

let dir: string;
let dbPath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "turnline-devin-"));
  dbPath = join(dir, "sessions.db");

  const sql = `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      model TEXT,
      main_chain_id INTEGER
    );
    CREATE TABLE message_nodes (
      node_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_node_id INTEGER,
      created_at REAL,
      chat_message TEXT NOT NULL
    );

    INSERT INTO sessions (id, model, main_chain_id) VALUES ('sess-1', 'claude-opus', 1);
    INSERT INTO sessions (id, model, main_chain_id) VALUES ('sess''quote', 'gpt-5', 1);
    INSERT INTO sessions (id, model, main_chain_id) VALUES ('sess-empty', 'claude-opus', 1);

    -- Request 1 at t=1000 (single system prompt)
    INSERT INTO message_nodes VALUES (1, 'sess-1', NULL, 1000, '{"role":"system","content":"System v1"}');
    INSERT INTO message_nodes VALUES (2, 'sess-1', 1, 1001, '{"role":"user","content":"Hello"}');

    -- Request 2 at t=2000 (two system prompts + structured array content)
    INSERT INTO message_nodes VALUES (10, 'sess-1', NULL, 2000, '{"role":"system","content":"System A"}');
    INSERT INTO message_nodes VALUES (11, 'sess-1', 10, 2000, '{"role":"system","content":"System B"}');
    INSERT INTO message_nodes VALUES (12, 'sess-1', 11, 2001, '{"role":"user","content":[{"type":"text","text":"Next"}]}');
    INSERT INTO message_nodes VALUES (13, 'sess-1', 12, 2002, '{"role":"assistant","content":"Done"}');

    -- Session with single quote in ID
    INSERT INTO message_nodes VALUES (20, 'sess''quote', NULL, 3000, '{"role":"system","content":"Escaped OK"}');

    -- Session with NULL created_at root after a timestamped root
    INSERT INTO sessions (id, model, main_chain_id) VALUES ('sess-null-ts', 'claude-opus', 1);
    INSERT INTO message_nodes VALUES (30, 'sess-null-ts', NULL, 1000, '{"role":"system","content":"Dated root"}');
    INSERT INTO message_nodes VALUES (31, 'sess-null-ts', NULL, NULL, '{"role":"system","content":"Undated root"}');

    -- Session containing malformed JSON in a message row
    INSERT INTO sessions (id, model, main_chain_id) VALUES ('sess-bad-json', '', 1);
    INSERT INTO message_nodes VALUES (40, 'sess-bad-json', NULL, 4000, '{"role":"system","content":"Valid system"}');
    INSERT INTO message_nodes VALUES (41, 'sess-bad-json', 40, 4001, '{corrupt json');
  `;
  execFileSync("sqlite3", [dbPath, sql]);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readDevinPrompt", () => {
  it("reads the latest request when `at` is omitted and numbers multiple system sections", async () => {
    const prompt = await readDevinPrompt({
      sessionId: "sess-1",
      includeMessages: true,
      dbPath,
    });
    assert.equal(prompt.model, "claude-opus");
    assert.equal(prompt.capturedAt, new Date(2000 * 1000).toISOString());
    assert.deepEqual(prompt.sections, [
      { name: "system 1", text: "System A" },
      { name: "system 2", text: "System B" },
    ]);
    assert.equal(prompt.messageCount, 4);
    assert.equal(prompt.messages?.length, 4);
    assert.equal(prompt.messages?.[3].content, "Done");
    assert.deepEqual(prompt.source, { kind: "devin-db", path: dbPath });
  });

  it("selects the latest request when `at` is AFTER all roots", async () => {
    const prompt = await readDevinPrompt({
      sessionId: "sess-1",
      at: new Date(9999 * 1000).toISOString(),
      dbPath,
    });
    assert.equal(prompt.capturedAt, new Date(2000 * 1000).toISOString());
    assert.equal(prompt.sections.length, 2);
    assert.equal(prompt.messages, undefined);
  });

  it("selects the earlier request when `at` falls between roots or matches exactly", async () => {
    const exact = await readDevinPrompt({
      sessionId: "sess-1",
      at: new Date(1000 * 1000).toISOString(),
      dbPath,
    });
    assert.deepEqual(exact.sections, [{ name: "system", text: "System v1" }]);
    assert.equal(exact.messageCount, 2);

    const between = await readDevinPrompt({
      sessionId: "sess-1",
      at: new Date(1500 * 1000).toISOString(),
      dbPath,
    });
    assert.deepEqual(between.sections, [{ name: "system", text: "System v1" }]);
  });

  it("safely escapes single quotes in sessionId and rejects NUL bytes", async () => {
    const prompt = await readDevinPrompt({ sessionId: "sess'quote", dbPath });
    assert.deepEqual(prompt.sections, [{ name: "system", text: "Escaped OK" }]);

    await assert.rejects(
      () => readDevinPrompt({ sessionId: "bad\0id", dbPath }),
      /invalid devin session id/,
    );
  });

  it("throws clear errors for missing db, missing session, empty session, too-early `at`, and invalid `at`", async () => {
    await assert.rejects(
      () => readDevinPrompt({ sessionId: "sess-1", dbPath: join(dir, "nope.db") }),
      /not found/,
    );
    await assert.rejects(
      () => readDevinPrompt({ sessionId: "missing", dbPath }),
      /no devin session/,
    );
    await assert.rejects(
      () => readDevinPrompt({ sessionId: "sess-empty", dbPath }),
      /no recorded requests/,
    );
    await assert.rejects(
      () =>
        readDevinPrompt({
          sessionId: "sess-1",
          at: new Date(500 * 1000).toISOString(),
          dbPath,
        }),
      /no request recorded before that time/,
    );
    await assert.rejects(
      () => readDevinPrompt({ sessionId: "sess-1", at: "invalid-date", dbPath }),
      /invalid timestamp/,
    );
  });

  it("does not match roots with NULL created_at when filtering by `at`", async () => {
    const prompt = await readDevinPrompt({
      sessionId: "sess-null-ts",
      at: new Date(1500 * 1000).toISOString(),
      dbPath,
    });
    assert.deepEqual(prompt.sections, [{ name: "system", text: "Dated root" }]);

    await assert.rejects(
      () =>
        readDevinPrompt({
          sessionId: "sess-null-ts",
          at: new Date(500 * 1000).toISOString(),
          dbPath,
        }),
      /no request recorded before that time/,
    );
  });

  it("handles malformed JSON rows gracefully and normalizes empty model strings", async () => {
    const prompt = await readDevinPrompt({
      sessionId: "sess-bad-json",
      includeMessages: true,
      dbPath,
    });
    assert.equal(prompt.model, undefined);
    assert.deepEqual(prompt.sections, [{ name: "system", text: "Valid system" }]);
    assert.equal(prompt.messageCount, 2);
    assert.equal(prompt.messages?.[1].role, "unknown");
    assert.equal(prompt.messages?.[1].content, "");
  });

  it("falls back to ~/.local/share when XDG_DATA_HOME is empty or unset", () => {
    const prev = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = "";
      assert.equal(devinDbPath(), join(homedir(), ".local", "share", "devin", "cli", "sessions.db"));

      process.env.XDG_DATA_HOME = "/custom/xdg";
      assert.equal(devinDbPath(), join("/custom/xdg", "devin", "cli", "sessions.db"));
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
    }
  });
});
