// TUI part of the stato plugin (OpenCode 2 plugin API, docs: /build/plugins/cli, section Markdown).
// Registers a renderer for fenced ```stato blocks: each line is drawn in the theme colour of its first
// symbol (✓ success, ✗ error, … warning, ➜ info). Long lines wrap. It reads only the text of the block.
// If anything goes wrong the block is drawn by the default renderer. The logic is in ./stato-core.ts and
// ./stato-render.ts (tested); this file only hands in the real OpenTUI classes.
import { Plugin } from "@opencode/plugin/tui"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { registerStato } from "./stato-render.ts"

export default Plugin.define({
  id: "local.stato",
  setup(context) {
    if (process.env.STATO_DISABLED === "1") return

    const renderer = context.renderer as never
    return registerStato(context.markdown, {
      makeBox: () => new BoxRenderable(renderer, { flexDirection: "column", width: "100%", flexShrink: 0 }),
      makeText: (content, fg) =>
        new TextRenderable(renderer, {
          content,
          wrapMode: "word",
          flexShrink: 0,
          ...(fg === undefined ? {} : { fg: fg as never }),
        }),
      theme: () => context.theme as never,
    })
  },
})
