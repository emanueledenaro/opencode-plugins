// Server part of the ask-box plugin. It does nothing on purpose: the plugin is read only and lives in
// the TUI part (./tui.tsx). This file exists so OpenCode 2 loads the directory as a plugin and then
// loads its TUI part.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "local.ask-box",
  setup() {},
})
