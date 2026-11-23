import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type HandlerPaseoApi = PluginHandlerContext["paseo"];
export type ResolvedAgent = Awaited<
  ReturnType<HandlerPaseoApi["agents"]["list"]>
>["entries"][number]["agent"];

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
