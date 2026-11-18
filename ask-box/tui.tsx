// TUI part of the ask-box plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Shows the "Serve da te:" block of the assistant's latest finished reply in the sidebar until the owner sends
// a new message, with how long it has waited. Read only: it only reads data.session.message.list(). See ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { askHeader, askText, createWidthTracker, currentRequest, sameRequest } from "./ask-box-core.ts"

// Width used for the first frame, before the box has been measured.
const DEFAULT_WIDTH = 32
// The age in the header counts minutes, so the clock moves twice a minute.
const CLOCK_MS = 30_000
const BOLD = 1

// The one thing read from the OpenTUI box: its own width, as OpenCode's own footer does.
type Measured = { width: number; onSizeChange?: (() => void) | undefined }

export default Plugin.define({
  id: "local.ask-box",
  async setup(context) {
    if (process.env.ASK_BOX_DISABLED === "1") return

    const theme = context.theme
    // One clock for every box; nothing reads it while no box is shown.
    const [now, setNow] = createSignal(Date.now())
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS)

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

      // The message list changes on every streamed token; the same request again redraws nothing.
      const request = createMemo(
        () => {
          const revertID = context.data.session.get(props.sessionID)?.revert?.messageID
          return currentRequest(context.data.session.message.list(props.sessionID), revertID)
        },
        undefined,
        { equals: sameRequest },
      )
      const header = () => {
        now() // read so the age is drawn again on each tick; the age itself counts from the real time
        return askHeader(request()?.askedAt, Date.now(), width())
      }
      // No blank row of its own: the sidebar already puts one between its blocks.
      return (
        <Show when={request()}>
          {(asked) => (
            <box
              flexDirection="column"
              width="100%"
              ref={(el: Measured) => {
                box = el
                el.onSizeChange = () => tracker.report(el.width)
                queueMicrotask(() => tracker.report(el.width))
              }}
            >
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.text.feedback?.warning?.base ?? theme.text.base} attributes={BOLD} wrapMode="none">
                  {header().title}
                </text>
                <Show when={header().age !== ""}>
                  <text fg={theme.text.faint} wrapMode="none">{header().age}</text>
                </Show>
              </box>
              <text fg={theme.text.base} wrapMode="none">{askText(asked().text, width())}</text>
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
      clearInterval(clock)
      unregister()
    }
  },
})
