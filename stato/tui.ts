// TUI part of the stato plugin (OpenCode 2 plugin API, docs: /build/plugins/cli, section Markdown).
// Registers a renderer for fenced ```stato blocks: each line is drawn in the theme colour of its first
// symbol (✓ success, ✗ error, ◐ warning, ➜ info). Long lines wrap. The ◐ of a block in the latest assistant
// reply spins; it is found by comparing the block text with the session's cached messages (read only).
// If anything goes wrong the block is drawn by the default renderer. The logic is in ./stato-core.ts and
// ./stato-render.ts (tested); this file only hands in the real OpenTUI classes.
import { Plugin } from "@opencode/plugin/tui"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { replyBlocks, spinsIn } from "./stato-core.ts"
import { registerStato } from "./stato-render.ts"

export default Plugin.define({
  id: "local.stato",
  setup(context) {
    if (process.env.STATO_DISABLED === "1") return

    const renderer = context.renderer as never
    // Blocks of older messages, kept so a long session is not parsed again on every tick.
    const cache = new WeakMap<object, Set<string>>()
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
      spin: {
        session: () => {
          const route = context.ui.router.current() as { type?: unknown; sessionID?: unknown } | undefined
          return route?.type === "session" && typeof route.sessionID === "string" ? route.sessionID : undefined
        },
        replyCheck: (sessionID) => {
          const messages = context.data.session.message.list(sessionID)
          const revertID = context.data.session.get(sessionID)?.revert?.messageID
          const blocks = replyBlocks(messages, revertID, cache)
          return (blockText) => spinsIn(blocks, blockText)
        },
        setContent: (node, content) => {
          ;(node as { content: string }).content = content
        },
        isAlive: (node) => (node as { isDestroyed?: boolean }).isDestroyed !== true,
        every: (run, ms) => {
          const timer = setInterval(run, ms)
          timer.unref?.()
          return () => clearInterval(timer)
        },
        now: () => Date.now(),
      },
    })
  },
})
