import { story } from "./story.mjs";

export default { title: "Pages/Appearance" };

export const DarkLogin = { ...story("appearanceDarkLogin"), name: "Dark signed out" };
export const DarkAgents = { ...story("appearanceDarkAgents"), name: "Dark populated Agents" };
export const DarkShell = { ...story("appearanceDarkShell"), name: "Dark shell and status" };
export const DarkChannelDrawer = {
  ...story("appearanceDarkChannelDrawer"),
  name: "Dark channel drawer",
};
export const DarkStopDialog = { ...story("appearanceDarkStopDialog"), name: "Dark stop dialog" };
