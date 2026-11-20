import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getAgentPrompt } from "./shared/prompt";
import { getAgentPromptHandler } from "./server/prompt";

export default function contribute(server: PluginServerContext) {
  server.handle(getAgentPrompt, getAgentPromptHandler);
  return () => {};
}
