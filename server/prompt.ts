import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import type { getAgentPrompt } from "../shared/prompt";
import {
  antigravityConversationDbPath,
  readAntigravityPrompt,
  resolveAntigravityConversationId,
} from "./providers/antigravity";
import { readClaudePrompt, resolveClaudeSessionFile } from "./providers/claude";
import { readCodexPrompt, resolveCodexSessionFile } from "./providers/codex";
import { readDevinPrompt } from "./providers/devin";
import { readPiPrompt, resolvePiSessionFile } from "./providers/pi";
import { resolveAgent, resolveProviderChannel } from "./resolve-agent";

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
  const channel = resolveProviderChannel(agent);
  const sessionId = agent.persistence?.sessionId || agent.runtimeInfo?.sessionId || undefined;
  const rawNativeHandle = agent.persistence?.nativeHandle || undefined;
  const nativeHandle = rawNativeHandle || sessionId;

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
      case "claude": {
        const file = await resolveClaudeSessionFile(rawNativeHandle, sessionId, agent.cwd);
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
          prompt: await readClaudePrompt({
            sessionFile: file,
            at: input.at,
            includeMessages: input.includeMessages,
          }),
        };
      }
      case "codex": {
        const file = await resolveCodexSessionFile(
          rawNativeHandle,
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
          prompt: await readCodexPrompt({
            sessionFile: file,
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
