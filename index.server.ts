import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getAgentPrompt } from "./shared/prompt";
import { getAgentUsage } from "./shared/usage";
import { getAgentPromptHandler } from "./server/prompt";
import { getAgentUsageHandler } from "./server/usage";

export default function contribute(server: PluginServerContext) {
  server.handle(getAgentPrompt, getAgentPromptHandler);
  server.handle(getAgentUsage, getAgentUsageHandler);
  return () => {};
}
