import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import type { getAgentPrompt } from "../shared/prompt";
import {
  antigravityConversationDbPath,
  readAntigravityPrompt,
  resolveAntigravityConversationId,
} from "./providers/antigravity";
import { readDevinPrompt } from "./providers/devin";
import { readPiPrompt, resolvePiSessionFile } from "./providers/pi";

type Input = RpcInput<typeof getAgentPrompt>;
type Output = RpcOutput<typeof getAgentPrompt>;

export async function getAgentPromptHandler(
  input: Input,
  { paseo }: PluginHandlerContext,
): Promise<Output> {
  const agent = await resolveAgent(paseo, input.agentId);
  if (!agent) {
    return { provider: "unknown", status: "unavailable", reason: "agent not found" };
  }
  const provider = agent.provider ?? "unknown";
  const sessionId = agent.persistence?.sessionId || agent.runtimeInfo?.sessionId || undefined;
  const nativeHandle = agent.persistence?.nativeHandle || sessionId;

  try {
    switch (provider) {
      case "pi": {
        const file = await resolvePiSessionFile(nativeHandle, sessionId, agent.cwd);
        if (!file || !existsSync(file)) {
          return {
            provider,
            status: "unavailable",
            reason: "pi session file not found",
          };
        }
        return {
          provider,
          status: "ok",
          prompt: await readPiPrompt({
            sessionFile: file,
            at: input.at,
            includeMessages: input.includeMessages,
          }),
        };
      }
      case "devin": {
        const id = sessionId || nativeHandle;
        if (!id) {
          return { provider, status: "unavailable", reason: "devin session id unknown" };
        }
        return {
          provider,
          status: "ok",
          prompt: await readDevinPrompt({
            sessionId: id,
            at: input.at,
            includeMessages: input.includeMessages,
          }),
        };
      }
      case "antigravity": {
        const conversationId = resolveAntigravityConversationId(
          nativeHandle,
          sessionId,
          agent.persistence?.metadata,
        );
        if (!conversationId) {
          return {
            provider,
            status: "unavailable",
            reason: "antigravity conversation id unknown",
          };
        }
        const db = antigravityConversationDbPath(conversationId);
        if (!existsSync(db)) {
          return {
            provider,
            status: "unavailable",
            reason: "antigravity conversation db not found",
          };
        }
        return {
          provider,
          status: "ok",
          prompt: await readAntigravityPrompt({
            dbPath: db,
            at: input.at,
            includeMessages: input.includeMessages,
          }),
        };
      }
      default:
        return {
          provider,
          status: "unsupported",
          reason: `no prompt channel for provider "${provider}"`,
        };
    }
  } catch (error) {
    return {
      provider,
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveAgent(paseo: PaseoApi, agentId: string): Promise<PaseoAgent | null> {
  try {
    const result = await paseo.agents.ref(agentId).refresh();
    if (result?.agent) return result.agent;
  } catch {
    // Fall through to a list lookup; refresh may fail on archived agents.
  }
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await paseo.agents.list({
        filter: { includeArchived: true },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      const found = result.entries.find((entry) => entry.agent.id === agentId);
      if (found) return found.agent;
      if (!result.pageInfo?.hasMore || !result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) {
        break;
      }
      cursor = result.pageInfo.nextCursor;
    }
  } catch {
    // ignore
  }
  return null;
}
