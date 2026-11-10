// TUI part of the plan-banner plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// One warning line above the composer while the assistant's LAST REPLY in this session ran under the
// plan agent. It does not claim to know the agent selected now: the TUI does not expose that. Read only.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, Show } from "solid-js"
import { bannerText, keyLabel, shouldShowBanner } from "./plan-banner-core.ts"

export default Plugin.define({
  id: "local.plan-banner",
  async setup(context) {
    if (process.env.PLAN_BANNER_DISABLED === "1") return

    const theme = context.theme

    // Both reads sit inside accessors, so Solid re-renders when messages or the binding change.
    const Banner = (props: { sessionID: string }) => (
      <Show
        when={shouldShowBanner(
          context.data.session.message.list(props.sessionID),
          context.data.session.get(props.sessionID)?.revert?.messageID,
        )}
      >
        <box paddingLeft={1} paddingRight={1}>
          <text fg={theme.text.feedback?.warning?.base ?? theme.text.base}>{bannerText(keyLabel(context.keymap.shortcuts("agent.cycle")))}</text>
        </box>
      </Show>
    )

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
