import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  antigravityConversationDbPath,
  readAntigravityPrompt,
  readAntigravityUsage,
  resolveAntigravityConversationId,
} from "../../../server/providers/antigravity";

let dir: string;
let dbPath: string;

function varint(n: number | bigint): Buffer {
  let v = typeof n === "bigint" ? BigInt.asUintN(64, n) : BigInt.asUintN(64, BigInt(n));
  const bytes: number[] = [];
  while (v > 0x7fn) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function fieldLen(field: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  return Buffer.concat([varint((field << 3) | 2), varint(body.length), body]);
}

function fieldVar(field: number, value: number | bigint): Buffer {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

function message(fields: Buffer[]): Buffer {
  return Buffer.concat(fields);
}

function buildRequestBlob(): Buffer {
  const section = (name: string, body: string) =>
    fieldLen(16, message([fieldLen(1, name), fieldLen(2, body)]));

  const userMessage = fieldLen(
    2,
    message([
      fieldVar(2, 1),
      fieldLen(3, "<USER_REQUEST>\nfix the tests\n</USER_REQUEST>"),
      fieldLen(21, "e1d53217a56f466c920bafea274063ec"),
    ]),
  );
  const assistantMessage = fieldLen(
    2,
    message([
      fieldLen(1, "bot-abc"),
      fieldVar(2, 2),
      fieldLen(
        6,
        message([
          fieldLen(1, "call_1"),
          fieldLen(2, "run_command"),
          fieldLen(3, '{"CommandLine":"npm test"}'),
        ]),
      ),
      fieldLen(11, "Let me run the tests."),
    ]),
  );
  const toolResult = fieldLen(
    2,
    message([
      fieldVar(2, 4),
      fieldLen(
        3,
        "Created At: 2026-11-20T12:30:02+08:00\nCompleted At: 2026-11-20T12:30:03+08:00\nCommand exited with code 0.\n\nCommand output:\nok\n",
      ),
      fieldLen(7, "call_1"),
    ]),
  );

  // Deliberately compact (< 1024 bytes, no artificial padding).
  const body = Buffer.concat([
    userMessage,
    assistantMessage,
    toolResult,
    section("identity", "<identity>\nYou are Antigravity.\n</identity>"),
    section("skills", "<skills>\n- wrangler\n</skills>"),
    fieldLen(19, "gemini-4-neon"),
    fieldLen(20, message([fieldLen(1, "request_id"), fieldLen(2, "req-123")])),
    fieldLen(21, "Gemini 4 Neon (XHigh)"),
  ]);
  return Buffer.concat([
    fieldLen(2, Buffer.from([0xac, 0x01])),
    fieldLen(3, Buffer.alloc(64)),
    fieldLen(4, "c6f27901-dd09-4d7d-9a94-0bc78b83dd25"),
    fieldLen(1, body),
  ]);
}

function writeGenMetadataDb(path: string, blob: Buffer, walMode = false): void {
  const setup = walMode
    ? `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;`
    : "";
  execFileSync("sqlite3", [
    path,
    `${setup}
     CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (idx));
     INSERT INTO gen_metadata VALUES (0, X'00', 1);
     INSERT INTO gen_metadata VALUES (1, x'${blob.toString("hex")}', ${blob.length});`,
  ]);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "turnline-agy-"));
  dbPath = join(dir, "conv.db");
  writeGenMetadataDb(dbPath, buildRequestBlob());
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readAntigravityPrompt", () => {
  it("extracts named sections, model, observed tools and messages from a compact serialized request", async () => {
    const prompt = await readAntigravityPrompt({ dbPath, includeMessages: true });
    assert.deepEqual(prompt.sections, [
      { name: "identity", text: "<identity>\nYou are Antigravity.\n</identity>" },
      { name: "skills", text: "<skills>\n- wrangler\n</skills>" },
    ]);
    assert.equal(prompt.model, "Gemini 4 Neon (XHigh)");
    assert.deepEqual(prompt.tools, ["run_command"]);
    assert.equal(prompt.toolsKind, "observed");
    assert.equal(prompt.latestOnly, true);
    assert.equal(prompt.messageCount, 3);
    assert.deepEqual(
      prompt.messages?.map((m) => m.role),
      ["user", "assistant", "tool"],
    );
    assert.match(prompt.messages?.[0].content ?? "", /fix the tests/);
    assert.match(prompt.messages?.[1].content ?? "", /tool call: run_command/);
    assert.match(prompt.messages?.[1].content ?? "", /thinking/);
    assert.equal(prompt.messages?.[2].at, "2026-11-20T04:30:02.000Z");
    assert.deepEqual(prompt.source, { kind: "antigravity-db", path: dbPath });
    assert.ok(prompt.capturedAt);
  });

  it("omits messages unless requested and still counts them", async () => {
    const prompt = await readAntigravityPrompt({ dbPath });
    assert.equal(prompt.messages, undefined);
    assert.equal(prompt.messageCount, 3);
  });

  it("preserves multiple parallel tool calls and thinking blocks without arg bleed", async () => {
    const parallelDb = join(dir, "parallel.db");
    const assistant = fieldLen(
      2,
      message([
        fieldVar(2, 2),
        fieldLen(11, "First thought."),
        fieldLen(11, "Second thought."),
        fieldLen(
          6,
          message([
            fieldLen(1, "call_1"),
            fieldLen(2, "read_file"),
            fieldLen(3, '{"Path":"/tmp/a.ts"}'),
          ]),
        ),
        // Second call intentionally omits field 3 (args) to ensure args do not bleed from call_1.
        fieldLen(6, message([fieldLen(1, "call_2"), fieldLen(2, "list_tools")])),
      ]),
    );
    const blob = fieldLen(
      1,
      Buffer.concat([
        assistant,
        fieldLen(16, message([fieldLen(1, "core"), fieldLen(2, "hello")])),
      ]),
    );
    writeGenMetadataDb(parallelDb, blob);

    const prompt = await readAntigravityPrompt({ dbPath: parallelDb, includeMessages: true });
    assert.deepEqual(prompt.tools, ["list_tools", "read_file"]);
    assert.equal(prompt.toolsKind, "observed");
    const content = prompt.messages?.[0].content ?? "";
    assert.match(content, /\[thinking\]\nFirst thought\./);
    assert.match(content, /\[thinking\]\nSecond thought\./);
    assert.match(content, /\[tool call: read_file\]\n\{"Path":"\/tmp\/a\.ts"\}/);
    assert.match(content, /\[tool call: list_tools\]\n$/);
    assert.doesNotMatch(content, /\[tool call: list_tools\]\n\{"Path"/);
  });

  it("handles 64-bit and negative 10-byte varints without truncating subsequent fields", async () => {
    const varintDb = join(dir, "varint64.db");
    const body = Buffer.concat([
      // Negative int64 (-1 => 10-byte varint) and 64-bit nanosecond timestamp before real fields.
      fieldVar(8, -1n),
      fieldVar(9, 1_795_000_000_123_456_789n),
      fieldLen(
        2,
        message([
          fieldVar(99, -42n),
          fieldVar(2, 1),
          fieldLen(3, "after 64-bit varints"),
        ]),
      ),
      fieldLen(16, message([fieldLen(1, "identity"), fieldLen(2, "still parsed")])),
      // f21 emitted BEFORE f19: display name must still take precedence over model id.
      fieldLen(21, "Gemini Display Name"),
      fieldLen(19, "gemini-raw-id"),
    ]);
    writeGenMetadataDb(varintDb, fieldLen(1, body));

    const prompt = await readAntigravityPrompt({ dbPath: varintDb, includeMessages: true });
    assert.deepEqual(prompt.sections, [{ name: "identity", text: "still parsed" }]);
    assert.equal(prompt.model, "Gemini Display Name");
    assert.equal(prompt.tools, undefined);
    assert.equal(prompt.toolsKind, undefined);
    assert.equal(prompt.messages?.[0].role, "user");
    assert.equal(prompt.messages?.[0].content, "after 64-bit varints");
  });

  it("falls back to field 1 system prompt and f19 model id when f16/f21 are absent", async () => {
    const fallbackDb = join(dir, "fallback.db");
    const body = Buffer.concat([
      fieldLen(1, "Concatenated system prompt"),
      fieldLen(19, "gemini-id-only"),
    ]);
    writeGenMetadataDb(fallbackDb, fieldLen(1, body));

    const prompt = await readAntigravityPrompt({ dbPath: fallbackDb });
    assert.deepEqual(prompt.sections, [{ name: "system", text: "Concatenated system prompt" }]);
    assert.equal(prompt.model, "gemini-id-only");
    assert.equal(prompt.messageCount, 0);
  });

  it("reads uncheckpointed WAL writes without copying -shm and uses newer -wal mtime", async () => {
    const walDb = join(dir, "wal.db");
    execFileSync("sqlite3", [
      walDb,
      `PRAGMA journal_mode=WAL;
       CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (idx));`,
    ]);
    // Write the serialized request into -wal without checkpointing.
    const blob = buildRequestBlob();
    execFileSync("sqlite3", [
      walDb,
      `PRAGMA wal_autocheckpoint=0;
       INSERT INTO gen_metadata VALUES (1, x'${blob.toString("hex")}', ${blob.length});`,
    ]);
    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    const newerWalTime = new Date("2026-06-15T12:34:56.000Z");
    await utimes(walDb, oldTime, oldTime);
    await utimes(`${walDb}-wal`, newerWalTime, newerWalTime);

    const prompt = await readAntigravityPrompt({ dbPath: walDb });
    assert.equal(prompt.model, "Gemini 4 Neon (XHigh)");
    assert.equal(prompt.capturedAt, newerWalTime.toISOString());

    // Updating the DB invalidates the cached snapshot.
    const updatedBlob = fieldLen(
      1,
      Buffer.concat([
        fieldLen(16, message([fieldLen(1, "identity"), fieldLen(2, "updated")])),
        fieldLen(21, "Updated Model"),
      ]),
    );
    execFileSync("sqlite3", [
      walDb,
      `PRAGMA wal_autocheckpoint=0;
       UPDATE gen_metadata SET data = x'${updatedBlob.toString("hex")}', size = ${updatedBlob.length} WHERE idx = 1;`,
    ]);
    const refreshed = await readAntigravityPrompt({ dbPath: walDb });
    assert.equal(refreshed.model, "Updated Model");
    assert.deepEqual(refreshed.sections, [{ name: "identity", text: "updated" }]);
  });

  it("rejects an invalid timestamp and a missing db", async () => {
    await assert.rejects(
      () => readAntigravityPrompt({ dbPath, at: "not-a-date" }),
      /invalid timestamp/,
    );
    await assert.rejects(
      () => readAntigravityPrompt({ dbPath: join(dir, "nope.db") }),
      /not found/,
    );
  });

  it("rejects a db without a serialized request or with an empty gen_metadata table", async () => {
    const empty = join(dir, "empty.db");
    execFileSync("sqlite3", [
      empty,
      `CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (idx));
       INSERT INTO gen_metadata VALUES (0, X'00', 1);`,
    ]);
    await assert.rejects(() => readAntigravityPrompt({ dbPath: empty }), /no serialized request/);

    const zeroRows = join(dir, "zero-rows.db");
    execFileSync("sqlite3", [
      zeroRows,
      `CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (idx));`,
    ]);
    await assert.rejects(() => readAntigravityPrompt({ dbPath: zeroRows }), /no serialized request/);
  });
});

describe("resolveAntigravityConversationId", () => {
  const id = "cee4ae17-ff7f-41fb-98ea-640b242eb1c5";

  it("prefers pluginProviderPersistence metadata", () => {
    assert.equal(
      resolveAntigravityConversationId(undefined, undefined, {
        pluginProviderPersistence: { version: 1, data: { conversationId: id } },
      }),
      id,
    );
  });

  it("decodes plugin:-encoded sessionId and falls through empty nativeHandle ids", () => {
    const encoded = `plugin:${JSON.stringify({ version: 1, data: { conversationId: id } })}`;
    const emptyEncoded = `plugin:${JSON.stringify({ version: 1, data: { conversationId: "" } })}`;
    assert.equal(resolveAntigravityConversationId(undefined, encoded, undefined), id);
    assert.equal(resolveAntigravityConversationId(encoded, undefined, undefined), id);
    assert.equal(resolveAntigravityConversationId(emptyEncoded, encoded, undefined), id);
  });

  it("accepts a bare uuid and rejects non-conversation or traversal handles", () => {
    assert.equal(resolveAntigravityConversationId(id, undefined, undefined), id);
    assert.equal(resolveAntigravityConversationId(`  ${id}  `, undefined, undefined), id);
    assert.equal(resolveAntigravityConversationId(undefined, "session-42", undefined), undefined);
    assert.equal(resolveAntigravityConversationId(undefined, undefined, undefined), undefined);
    assert.equal(
      resolveAntigravityConversationId(undefined, undefined, {
        pluginProviderPersistence: { data: { conversationId: "../../etc/passwd" } },
      }),
      undefined,
    );
    assert.equal(
      resolveAntigravityConversationId(
        `plugin:${JSON.stringify({ data: { conversationId: "dir/escape" } })}`,
        undefined,
        undefined,
      ),
      undefined,
    );
  });

  it("maps valid conversation id to the conversations dir and rejects traversal ids", () => {
    assert.equal(
      antigravityConversationDbPath(id, "/root"),
      "/root/cee4ae17-ff7f-41fb-98ea-640b242eb1c5.db",
    );
    assert.throws(() => antigravityConversationDbPath("../escape", "/root"), /invalid/);
    assert.throws(() => antigravityConversationDbPath("a/b", "/root"), /invalid/);
    assert.throws(() => antigravityConversationDbPath("", "/root"), /invalid/);
  });
});

describe("readAntigravityUsage", () => {
  it("decodes planner step usage, cache read, callIds, thinking, and reply text from steps table", async () => {
    const stepsDb = join(dir, "steps-usage.db");
    const ts1 = message([fieldVar(1, 1704103200), fieldVar(2, 500_000_000)]);
    const usage1 = message([fieldVar(2, 3000), fieldVar(3, 250), fieldVar(5, 9000)]);
    const meta1 = message([fieldLen(1, ts1), fieldLen(9, usage1)]);
    const payload1 = message([
      fieldVar(1, 15),
      fieldLen(
        20,
        message([
          fieldLen(3, "Checking files first"),
          fieldLen(6, "bot-step-1"),
          fieldLen(7, message([fieldLen(1, "call_agy_1"), fieldLen(2, "read_file")])),
        ]),
      ),
    ]);

    const ts2 = message([fieldVar(1, 1704103210)]);
    const usage2 = message([fieldVar(2, 12000), fieldVar(3, 400)]);
    const meta2 = message([fieldLen(1, ts2), fieldLen(9, usage2)]);
    const payload2 = message([
      fieldVar(1, 15),
      fieldLen(5, meta2),
      fieldLen(
        20,
        message([
          fieldLen(1, "Everything is fixed."),
          fieldLen(6, "bot-step-2"),
        ]),
      ),
    ]);

    execFileSync("sqlite3", [
      stepsDb,
      `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB);
       INSERT INTO steps VALUES (0, 14, NULL, NULL);
       INSERT INTO steps VALUES (1, 15, x'${meta1.toString("hex")}', x'${payload1.toString("hex")}');
       INSERT INTO steps VALUES (2, 15, NULL, x'${payload2.toString("hex")}');`,
    ]);

    const records = await readAntigravityUsage(stepsDb);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
      at: new Date(1704103200 * 1000 + 500).toISOString(),
      messageId: "bot-step-1",
      callIds: ["call_agy_1"],
      textPrefix: undefined,
      thinkingPrefix: "Checking files first",
      usage: {
        inputTokens: 12000,
        cachedInputTokens: 9000,
        outputTokens: 250,
      },
    });
    assert.deepEqual(records[1], {
      at: new Date(1704103210 * 1000).toISOString(),
      messageId: "bot-step-2",
      callIds: undefined,
      textPrefix: "Everything is fixed.",
      thinkingPrefix: undefined,
      usage: {
        inputTokens: 12000,
        cachedInputTokens: 0,
        outputTokens: 400,
      },
    });
  });

  it("returns empty array when steps table does not exist", async () => {
    const records = await readAntigravityUsage(dbPath);
    assert.deepEqual(records, []);
  });

  it("reads uncheckpointed WAL writes, invalidates usageCache on updates, skips corrupt/empty steps, and rejects missing db", async () => {
    const walUsageDb = join(dir, "wal-usage.db");
    const ts1 = message([fieldVar(1, 1704104000)]);
    const usage1 = message([fieldVar(2, 1000), fieldVar(3, 100), fieldVar(5, 4000)]);
    const meta1 = message([fieldLen(1, ts1), fieldLen(9, usage1)]);
    const payload1 = message([
      fieldVar(1, 15),
      fieldLen(20, message([fieldLen(1, "Step one"), fieldLen(6, "bot-wal-1")])),
    ]);

    execFileSync("sqlite3", [
      walUsageDb,
      `PRAGMA journal_mode=WAL;
       CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB);`,
    ]);
    execFileSync("sqlite3", [
      walUsageDb,
      `PRAGMA wal_autocheckpoint=0;
       INSERT INTO steps VALUES (1, 15, NULL, NULL);
       INSERT INTO steps VALUES (2, 15, x'ffffffffff', x'ffffffffff');
       INSERT INTO steps VALUES (3, 15, x'${meta1.toString("hex")}', x'${payload1.toString("hex")}');`,
    ]);

    const first = await readAntigravityUsage(walUsageDb);
    assert.equal(first.length, 1);
    assert.equal(first[0].messageId, "bot-wal-1");
    assert.equal(first[0].usage.inputTokens, 5000);
    assert.equal(first[0].usage.cachedInputTokens, 4000);

    // Mutate returned record to confirm cached objects are defensively cloned
    first[0].usage.inputTokens = 999999;
    const cachedRead = await readAntigravityUsage(walUsageDb);
    assert.equal(cachedRead[0].usage.inputTokens, 5000);

    // Append another step in WAL mode without checkpointing -> invalidates usageCache
    const ts2 = message([fieldVar(1, 1704104010)]);
    const usage2 = message([fieldVar(2, 2000), fieldVar(3, 250), fieldVar(5, 6000)]);
    const meta2 = message([fieldLen(1, ts2), fieldLen(9, usage2)]);
    const payload2 = message([
      fieldVar(1, 15),
      fieldLen(20, message([fieldLen(1, "Step two"), fieldLen(6, "bot-wal-2")])),
    ]);
    execFileSync("sqlite3", [
      walUsageDb,
      `PRAGMA wal_autocheckpoint=0;
       INSERT INTO steps VALUES (4, 15, x'${meta2.toString("hex")}', x'${payload2.toString("hex")}');`,
    ]);

    const updated = await readAntigravityUsage(walUsageDb);
    assert.equal(updated.length, 2);
    assert.equal(updated[1].messageId, "bot-wal-2");
    assert.equal(updated[1].usage.inputTokens, 8000);
    assert.equal(updated[1].usage.cachedInputTokens, 6000);

    await assert.rejects(
      () => readAntigravityUsage(join(dir, "missing-usage.db")),
      /not found/,
    );
  });
});
