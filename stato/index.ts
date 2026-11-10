// Server part of the stato plugin. It does nothing on purpose: the plugin lives in the TUI part (./tui.ts).
// This file exists so OpenCode 2 loads the directory as a plugin and then loads its TUI part.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "local.stato",
  setup() {},
})
