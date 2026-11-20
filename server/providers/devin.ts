import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import type { z } from "zod";
import type { providerPromptSchema } from "../../shared/prompt";

type ProviderPrompt = z.infer<typeof providerPromptSchema>;

interface DevinNodeRow {
  node_id: number;
  created_at: number | null;
  chat_message: string;
}

interface DevinSessionRow {
  id: string;
  model: string | null;
}

/**
 * Devin CLI persists every request to `~/.local/share/devin/cli/sessions.db`.
 * `message_nodes` stores each request's complete message list as one tree:
 * roots (`parent_node_id IS NULL`) start a new request, and the nodes between
 * two roots are that request's system + conversation messages in order.
 * The schema is internal (undocumented) but it is the provider's own store.
 */
export async function readDevinPrompt(options: {
  sessionId: string;
  at?: string;
  includeMessages?: boolean;
  dbPath?: string;
}): Promise<ProviderPrompt> {
  const { sessionId, at, includeMessages } = options;
  let atSec: number | undefined;
  if (at !== undefined) {
    const parsedMs = Date.parse(at);
    if (!Number.isFinite(parsedMs)) {
      throw new Error(`invalid timestamp: ${at}`);
    }
    atSec = parsedMs / 1000;
  }
  const dbPath = options.dbPath ?? devinDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`devin sessions.db not found at ${dbPath}`);
  }

  const id = sqlString(sessionId);
  const [session] = await sqliteJson<DevinSessionRow>(
    dbPath,
    `SELECT id, model FROM sessions WHERE id=${id}`,
  );
  if (!session) {
    throw new Error(`no devin session ${sessionId} in sessions.db`);
  }

  // Request boundaries: every tree root begins one serialized request.
  const roots = await sqliteJson<{ node_id: number; created_at: number | null }>(
    dbPath,
    `SELECT node_id, created_at FROM message_nodes WHERE session_id=${id} AND parent_node_id IS NULL ORDER BY node_id`,
  );
  if (roots.length === 0) {
    throw new Error(`devin session ${sessionId} has no recorded requests`);
  }

  let rootIndex = roots.length - 1;
  if (atSec !== undefined) {
    rootIndex = -1;
    for (let i = roots.length - 1; i >= 0; i--) {
      const createdAt = roots[i].created_at;
      if (typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt <= atSec) {
        rootIndex = i;
        break;
      }
    }
    if (rootIndex < 0) {
      throw new Error("no request recorded before that time");
    }
  }
  const root = roots[rootIndex];
  const nextRoot = roots[rootIndex + 1];

  const rows = await sqliteJson<DevinNodeRow>(
    dbPath,
    `SELECT node_id, created_at, chat_message
     FROM message_nodes WHERE session_id=${id} AND node_id >= ${Number(root.node_id)}${
       nextRoot ? ` AND node_id < ${Number(nextRoot.node_id)}` : ""
     } ORDER BY node_id`,
  );

  const sections: { name: string; text: string }[] = [];
  const messages: NonNullable<ProviderPrompt["messages"]> = [];
  for (const row of rows) {
    const parsed = parseMessage(row.chat_message);
    const content = contentText(parsed?.content);
    const role = typeof parsed?.role === "string" && parsed.role ? parsed.role : "unknown";
    if (role === "system") {
      sections.push({ name: "system", text: content });
    }
    if (includeMessages) {
      messages.push({ role, content, at: secToIso(row.created_at) });
    }
  }
  if (sections.length > 1) {
    sections.forEach((section, index) => {
      section.name = `system ${index + 1}`;
    });
  }

  return {
    capturedAt: secToIso(root.created_at),
    model: session.model || undefined,
    sections,
    messages: includeMessages ? messages : undefined,
    messageCount: rows.length,
    source: { kind: "devin-db", path: dbPath },
  };
}

export function devinDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "devin", "cli", "sessions.db");
}

function sqlString(value: string): string {
  if (value.includes("\0")) {
    throw new Error("invalid devin session id");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

async function sqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execCommand(
    "sqlite3",
    ["-readonly", "-cmd", ".timeout 3000", "-json", dbPath, sql],
    {
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (!stdout.trim()) return [];
  return JSON.parse(stdout) as T[];
}

function secToIso(sec: number | null): string | undefined {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return undefined;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function parseMessage(raw: string): { role?: unknown; content?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as { role?: unknown; content?: unknown };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}
