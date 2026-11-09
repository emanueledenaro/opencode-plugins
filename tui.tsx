// TUI part of the claude-usage plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Shows Claude subscription usage (5-hour and weekly window) in the prompt footer as two small
// coloured meters, plus a /claude-usage dialog. Read only: see ./README.md and ./claude-usage.ts.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, Match, Show, Switch, createSignal } from "solid-js"
import {
  POLL_INTERVAL_MS,
  WEEKLY_THRESHOLD_PERCENT,
  failureIt,
  formatPercent,
  meter,
  resetIt,
  updatedIt,
  usageLevel,
  weeklyOverThreshold,
  type Level,
  type MonitorState,
  type UsageWindow,
} from "./claude-usage-core.ts"
import { createLiveMonitor, isDisabled } from "./claude-usage.ts"

// Render errors only (no token is ever in the render path): message and stack, for debugging.
function reportRenderError(where: string, error: unknown) {
  try {
    const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
    require("node:fs").writeFileSync("/tmp/claude-usage-render-error.txt", `${new Date().toISOString()} ${where}\n${text}\n`)
  } catch {
    // best effort
  }
}

const TICK_MS = 30_000 // the monitor itself enforces the 5 minute interval and the back-off
const FOOTER_CELLS = 6
const DIALOG_CELLS = 20

export default Plugin.define({
  id: "local.claude-usage",
  async setup(context) {
    if (isDisabled()) return

    const theme = context.theme
    const colour = (level: Level) =>
      level === "high"
        ? theme.text.feedback.error.base
        : level === "warn"
          ? theme.text.feedback.warning.base
          : theme.text.feedback.success.base

    const monitor = createLiveMonitor()
    const [state, setState] = createSignal<MonitorState>(monitor.state)
    const [now, setNow] = createSignal(Date.now())

    let warned = false
    const stopListening = monitor.subscribe((next) => {
      setState(next)
      const over = weeklyOverThreshold(next.snapshot)
      if (over && !warned && next.snapshot?.sevenDay) {
        context.ui.toast.show({
          title: "Abbonamento Claude",
          message: `Settimana al ${formatPercent(next.snapshot.sevenDay.percent)}: sei nella riserva del ${100 - WEEKLY_THRESHOLD_PERCENT}%.`,
          variant: "warning",
          duration: 8000,
        })
      }
      warned = over
    })

    // One small meter for the footer: "5h ▰▰▱▱▱▱ 23%".
    const FooterMeter = (props: { label: string; window: UsageWindow | null }) => (
      <box flexDirection="row">
        <text fg={theme.text.muted}>{`${props.label} `}</text>
        <Show when={props.window} fallback={<text fg={theme.text.faint}>libero</text>}>
          {(window) => {
            const bar = () => meter(window().percent, FOOTER_CELLS)
            const fg = () => colour(usageLevel(window().percent))
            return (
              <box flexDirection="row">
                <Show when={bar().filled.length > 0}>
                  <text fg={fg()}>{bar().filled}</text>
                </Show>
                <Show when={bar().empty.length > 0}>
                  <text fg={theme.text.faint}>{bar().empty}</text>
                </Show>
                <text fg={fg()}>{` ${formatPercent(window().percent)}`}</text>
              </box>
            )
          }}
        </Show>
      </box>
    )

    // Every read of state() sits inside JSX, so Solid re-renders when new numbers arrive.
    const loginFailure = () => {
      const kind = state().failure?.kind
      return kind === "login-expired" || kind === "no-login" ? state().failure : null
    }
    const Footer = () => (
      <Switch
        fallback={
          <box flexDirection="row">
            <FooterMeter label="5h" window={state().snapshot?.fiveHour ?? null} />
            <text>{"   "}</text>
            <FooterMeter label="sett" window={state().snapshot?.sevenDay ?? null} />
            <Show when={state().failure}>
              <text fg={theme.text.faint}>{"  (vecchio)"}</text>
            </Show>
          </box>
        }
      >
        <Match when={loginFailure()}>
          {(failure) => <text fg={theme.text.feedback.warning.base}>{`Claude: ${failureIt(failure())}`}</text>}
        </Match>
        <Match when={!state().snapshot}>
          <text fg={theme.text.faint}>Claude: in attesa dei dati</text>
        </Match>
      </Switch>
    )

    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <ErrorBoundary fallback={(error) => { reportRenderError("footer", error); return <text fg={theme.text.faint}>{"Claude: uso non disponibile"}</text> }}>
          <Footer />
        </ErrorBoundary>
      ),
    })

    // One row of the dialog: label, wide meter, percentage, then the reset line underneath.
    const DialogRow = (props: { label: string; window: UsageWindow | null }) => (
      <box flexDirection="column" paddingBottom={1}>
        <box flexDirection="row">
          <text fg={theme.text.base}>{props.label.padEnd(11)}</text>
          <Show when={props.window} fallback={<text fg={theme.text.faint}>nessuna finestra attiva</text>}>
            {(window) => {
              const bar = () => meter(window().percent, DIALOG_CELLS)
              const fg = () => colour(usageLevel(window().percent))
              return (
                <box flexDirection="row">
                  <Show when={bar().filled.length > 0}>
                    <text fg={fg()}>{bar().filled}</text>
                  </Show>
                  <Show when={bar().empty.length > 0}>
                    <text fg={theme.text.faint}>{bar().empty}</text>
                  </Show>
                  <text fg={fg()}>{`  ${formatPercent(window().percent).padStart(4)}`}</text>
                </box>
              )
            }}
          </Show>
        </box>
        <Show when={props.window}>
          {(window) => <text fg={theme.text.muted}>{`${"".padEnd(11)}${resetIt(window(), now())}`}</text>}
        </Show>
      </box>
    )

    const Dialog = () => {
      return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={theme.text.base}>Abbonamento Claude</text>
          <text>{" "}</text>
          <Show when={state().snapshot} fallback={<text fg={theme.text.faint}>Dati non ancora disponibili.</text>}>
            {(snap) => (
              <box flexDirection="column">
                <DialogRow label="5 ore" window={snap().fiveHour} />
                <DialogRow label="Settimana" window={snap().sevenDay} />
                <Show when={weeklyOverThreshold(snap())}>
                  <text fg={theme.text.feedback.error.base}>
                    {`Sopra il ${WEEKLY_THRESHOLD_PERCENT}%: stai usando la riserva del ${100 - WEEKLY_THRESHOLD_PERCENT}%.`}
                  </text>
                  <text>{" "}</text>
                </Show>
                <text fg={theme.text.faint}>{updatedIt(snap().fetchedAt, now())}</text>
              </box>
            )}
          </Show>
          <Show when={state().failure}>
            {(failure) => <text fg={theme.text.feedback.warning.base}>{`Ultimo aggiornamento non riuscito: ${failureIt(failure())}`}</text>}
          </Show>
          <text>{" "}</text>
          <text fg={theme.text.faint}>esc per chiudere</text>
        </box>
      )
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "local.claude-usage.show",
          title: "Uso dell'abbonamento Claude",
          group: "Claude",
          palette: true,
          slash: { name: "claude-usage", aliases: ["usage"] },
          run: async () => {
            setNow(Date.now())
            context.ui.dialog.set({ size: "medium", centered: true })
            context.ui.dialog.show(() => (
              <ErrorBoundary fallback={(error) => { reportRenderError("dialog", error); return <text fg={theme.text.faint}>{"Uso non disponibile."}</text> }}>
                <Dialog />
              </ErrorBoundary>
            ))
            await monitor.refresh(true)
            setNow(Date.now())
          },
        },
      ],
    }))

    // Never blocks startup: cached numbers first, then one poll in the background.
    void monitor.hydrate().then(() => monitor.refresh(false))
    const timer = setInterval(() => {
      setNow(Date.now())
      void monitor.refresh(false)
    }, Math.min(TICK_MS, POLL_INTERVAL_MS))

    return () => {
      clearInterval(timer)
      stopListening()
      unregisterFooter()
    }
  },
})
