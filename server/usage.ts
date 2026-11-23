import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import type { getAgentUsage } from "../shared/usage";
import {
  antigravityConversationDbPath,
  readAntigravityUsage,
  resolveAntigravityConversationId,
} from "./providers/antigravity";
import { readClaudeUsage, resolveClaudeSessionFile } from "./providers/claude";
import { readCodexUsage, resolveCodexSessionFile } from "./providers/codex";
import { readDevinUsage } from "./providers/devin";
import { readPiUsage, resolvePiSessionFile } from "./providers/pi";
import { resolveAgent, resolveProviderChannel } from "./resolve-agent";

type Input = RpcInput<typeof getAgentUsage>;
type Output = RpcOutput<typeof getAgentUsage>;

export async function getAgentUsageHandler(
  input: Input,
  { paseo }: PluginHandlerContext,
): Promise<Output> {
  const agent = await resolveAgent(paseo, input.agentId);
  if (!agent) {
    return { provider: "unknown", status: "unavailable", reason: "agent not found" };
  }
  const provider = agent.provider ?? "unknown";
  const channel = resolveProviderChannel(agent);
  const sessionId = agent.persistence?.sessionId || agent.runtimeInfo?.sessionId || undefined;
  const nativeHandle = agent.persistence?.nativeHandle || undefined;

  try {
    switch (channel) {
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
          records: await readPiUsage(file),
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
          records: await readDevinUsage({ sessionId: id }),
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
          records: await readAntigravityUsage(db),
        };
      }
      case "claude": {
        const file = await resolveClaudeSessionFile(nativeHandle, sessionId, agent.cwd);
        if (!file || !existsSync(file)) {
          return {
            provider,
            status: "unavailable",
            reason: "claude session file not found",
          };
        }
        return {
          provider,
          status: "ok",
          records: await readClaudeUsage(file),
        };
      }
      case "codex": {
        const file = await resolveCodexSessionFile(
          nativeHandle,
          sessionId,
          agent.persistence?.metadata,
        );
        if (!file || !existsSync(file)) {
          return {
            provider,
            status: "unavailable",
            reason: "codex session file not found",
          };
        }
        return {
          provider,
          status: "ok",
          records: await readCodexUsage(file),
        };
      }
      default:
        return {
          provider,
          status: "unsupported",
          reason: `no usage channel for provider "${provider}"`,
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
