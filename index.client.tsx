import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TurnsPanel } from "./client/turns-panel";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "turns",
    title: "Turns",
    icon: "History",
    locations: ["workspace", "explorer"],
    Component: TurnsPanel,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "open-turns",
    title: "Open turn inspector",
    icon: "History",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("turns");
    },
  });
  return () => {
    removeCommand();
    removePanel();
  };
}
