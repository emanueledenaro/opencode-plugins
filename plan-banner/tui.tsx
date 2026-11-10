// TUI part of the plan-banner plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// One warning line above the composer while the assistant's LAST REPLY in this session ran under the
// plan agent. It does not claim to know the agent selected now: the TUI does not expose that. Read only.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, Show, createSignal, onCleanup } from "solid-js"
import { bannerLine, createWidthTracker, keyLabel, shouldShowBanner } from "./plan-banner-core.ts"

// Width used for the first frame, before the box has been measured; padding is one column each side.
const DEFAULT_WIDTH = 90
const PADDING = 2

// The one thing read from the OpenTUI box: its own width, as OpenCode's own footer does.
type Measured = { width: number; onSizeChange?: (() => void) | undefined }

export default Plugin.define({
  id: "local.plan-banner",
  async setup(context) {
    if (process.env.PLAN_BANNER_DISABLED === "1") return

    const theme = context.theme

    // Both reads sit inside accessors, so Solid re-renders when messages or the binding change.
    const Banner = (props: { sessionID: string }) => {
      // The composer can be any width, so the banner measures itself and picks the wording that fits.
      const [width, setWidth] = createSignal(DEFAULT_WIDTH)
      const tracker = createWidthTracker({ initial: DEFAULT_WIDTH, onChange: setWidth })
      let box: Measured | undefined
      onCleanup(() => {
        tracker.dispose()
        if (box) box.onSizeChange = undefined
      })
      const line = () => bannerLine(keyLabel(context.keymap.shortcuts("agent.cycle")), width() - PADDING)
      return (
        <Show
          when={shouldShowBanner(
            context.data.session.message.list(props.sessionID),
            context.data.session.get(props.sessionID)?.revert?.messageID,
          )}
        >
          <box
            paddingLeft={1}
            paddingRight={1}
            width="100%"
            flexShrink={0}
            ref={(el: Measured) => {
              box = el
              el.onSizeChange = () => tracker.report(el.width)
              queueMicrotask(() => tracker.report(el.width))
            }}
          >
            <Show when={line()}>
              {(text) => (
                <text fg={theme.text.feedback?.warning?.base ?? theme.text.base} wrapMode="none">
                  {text()}
                </text>
              )}
            </Show>
          </box>
        </Show>
      )
    }

    const unregister = context.ui.slot({
      append: "session.composer.top",
      render: (input: { sessionID: string }) => (
        <ErrorBoundary fallback={<text fg={theme.text.faint}>{"Banner Plan: non disponibile"}</text>}>
          <Banner sessionID={input.sessionID} />
        </ErrorBoundary>
      ),
    })

    return () => {
      unregister()
    }
  },
})
