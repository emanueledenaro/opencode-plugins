// TUI part of the ask-box plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Shows the "Serve da te:" block of the assistant's latest finished reply in the sidebar until the owner sends
// a new message. Read only: it only reads data.session.message.list(). See ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, Show, createSignal, onCleanup } from "solid-js"
import { askText, createWidthTracker, currentAsk } from "./ask-box-core.ts"

// Width used for the first frame, before the box has been measured.
const DEFAULT_WIDTH = 32

// The one thing read from the OpenTUI box: its own width, as OpenCode's own footer does.
type Measured = { width: number; onSizeChange?: (() => void) | undefined }

export default Plugin.define({
  id: "local.ask-box",
  async setup(context) {
    if (process.env.ASK_BOX_DISABLED === "1") return

    const theme = context.theme

    // The read of message.list() sits inside this accessor, so Solid re-renders when messages change.
    const AskBox = (props: { sessionID: string }) => {
      // The sidebar can be any width (and changes with the terminal), so the box measures itself.
      const [width, setWidth] = createSignal(DEFAULT_WIDTH)
      const tracker = createWidthTracker({ initial: DEFAULT_WIDTH, onChange: setWidth })
      let box: Measured | undefined
      onCleanup(() => {
        tracker.dispose()
        if (box) box.onSizeChange = undefined
      })

      const ask = () => {
        const revertID = context.data.session.get(props.sessionID)?.revert?.messageID
        const text = currentAsk(context.data.session.message.list(props.sessionID), revertID)
        return text === null ? null : askText(text, width())
      }
      return (
        <Show when={ask()}>
          {(text) => (
            <box
              flexDirection="column"
              paddingTop={1}
              width="100%"
              ref={(el: Measured) => {
                box = el
                el.onSizeChange = () => tracker.report(el.width)
                queueMicrotask(() => tracker.report(el.width))
              }}
            >
              <text fg={theme.text.feedback?.warning?.base ?? theme.text.base} wrapMode="none">{"Serve da te"}</text>
              <text fg={theme.text.base} wrapMode="none">{text()}</text>
            </box>
          )}
        </Show>
      )
    }

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input: { sessionID: string }) => (
        <ErrorBoundary fallback={<text fg={theme.text.faint}>{"Serve da te: non disponibile"}</text>}>
          <AskBox sessionID={input.sessionID} />
        </ErrorBoundary>
      ),
    })

    return () => {
      unregister()
    }
  },
})
