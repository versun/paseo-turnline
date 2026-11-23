import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type HandlerPaseoApi = PluginHandlerContext["paseo"];
export type ResolvedAgent = Awaited<
  ReturnType<HandlerPaseoApi["agents"]["list"]>
>["entries"][number]["agent"];

const BUILTIN_CHANNELS = new Set(["pi", "devin", "antigravity", "claude", "codex"]);

/**
 * Determine the underlying provider implementation channel for an agent.
 * Matches `agent.provider` first, and falls back to persistence/runtime
 * provider hints so custom Paseo providers extending a built-in provider
 * (e.g. a custom Claude or Codex profile) route to the right adapter.
 */
export function resolveProviderChannel(agent: ResolvedAgent): string {
  const primary = agent.provider ?? "unknown";
  if (BUILTIN_CHANNELS.has(primary)) return primary;
  const meta = agent.persistence?.metadata;
  const metaProvider =
    meta && typeof meta === "object" && !Array.isArray(meta) && typeof (meta as Record<string, unknown>).provider === "string"
      ? ((meta as Record<string, unknown>).provider as string)
      : undefined;
  for (const candidate of [agent.persistence?.provider, agent.runtimeInfo?.provider, metaProvider]) {
    if (candidate && BUILTIN_CHANNELS.has(candidate)) return candidate;
  }
  return primary;
}

export async function resolveAgent(
  paseo: HandlerPaseoApi,
  agentId: string,
): Promise<ResolvedAgent | null> {
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
