// TUI part of the ask-box plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Keeps the last "Serve da te:" block of the assistant visible in the sidebar until the owner sends
// a new message. Read only: it only reads data.session.message.list(). See ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, Show } from "solid-js"
import { capAsk, currentAsk } from "./ask-box-core.ts"

// Characters per line used to count the 8-line limit. The sidebar is about 36 columns wide on a
// 140 column terminal; a bit under that keeps the real wrapping from adding lines.
const WRAP_WIDTH = 32

export default Plugin.define({
  id: "local.ask-box",
  async setup(context) {
    if (process.env.ASK_BOX_DISABLED === "1") return

    const theme = context.theme

    // The read of message.list() sits inside this accessor, so Solid re-renders when messages change.
    const AskBox = (props: { sessionID: string }) => {
      const ask = () => {
        const revertID = context.data.session.get(props.sessionID)?.revert?.messageID
        const text = currentAsk(context.data.session.message.list(props.sessionID), revertID)
        return text === null ? null : capAsk(text, WRAP_WIDTH)
      }
      return (
        <Show when={ask()}>
          {(text) => (
            <box flexDirection="column" paddingTop={1}>
              <text fg={theme.text.feedback?.warning?.base ?? theme.text.base}>{"Serve da te"}</text>
              <text fg={theme.text.base} wrapMode="word">{text()}</text>
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
