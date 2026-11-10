// TUI part of the claude-usage plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Shows Claude subscription usage (5-hour and weekly window, plus the weekly Fable limit when the
// plan has one) in the prompt footer as small coloured meters, plus a /claude-usage dialog. Read only: see ./README.md and ./claude-usage.ts.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, For, Match, Show, Switch, createMemo, createSignal, onCleanup } from "solid-js"
import {
  FABLE_TOAST,
  POLL_INTERVAL_MS,
  WEEKLY_THRESHOLD_PERCENT,
  createFableWatch,
  createWidthTracker,
  dialogLayout,
  failureIt,
  fableLevel,
  fitText,
  footerLayout,
  footerMessage,
  formatPercent,
  meter,
  resetFit,
  rowBudget,
  updatedIt,
  usageLevel,
  weeklyOverThreshold,
  type FooterPart,
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
const LAYOUT_CHECK_MS = 1_000 // re-reads the row width, e.g. after the sidebar opens; no redraw unless it changed
const LAYOUT_SETTLE_MS = 40 // after a resize event the layout is ready within a frame or two
const PATH_RESERVE = 12 // columns OpenCode's own status box keeps when the footer item grows
const FALLBACK_OTHERS = 45 // path and key hints, when the row cannot be measured
const DIALOG_DEFAULT_WIDTH = 56
const DIALOG_PADDING = 4

// The few things read from OpenTUI renderables. Host renderables are not a public API, so every
// access is optional and a failure only means the fallback width is used.
type Node = {
  width: number
  parent?: Node | null
  getChildren?: () => Node[]
  getFlexGrow?: () => number
  onSizeChange?: (() => void) | undefined
}

export default Plugin.define({
  id: "local.claude-usage",
  async setup(context) {
    if (isDisabled()) return

    const theme = context.theme
    const colour = (level: Level) =>
      level === "high"
        ? (theme.text.feedback?.error?.base ?? theme.text.base)
        : level === "warn"
          ? (theme.text.feedback?.warning?.base ?? theme.text.base)
          : (theme.text.feedback?.success?.base ?? theme.text.base)

    const monitor = createLiveMonitor()
    const [state, setState] = createSignal<MonitorState>(monitor.state)
    const [now, setNow] = createSignal(Date.now())

    let warned = false
    const fableCrossed = createFableWatch()
    const stopListening = monitor.subscribe((next) => {
      setState(next)
      if (fableCrossed(next.snapshot)) {
        context.ui.toast.show({ title: "Abbonamento Claude", message: FABLE_TOAST, variant: "warning", duration: 8000 })
      }
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

    // Every read of state() sits inside JSX, so Solid re-renders when new numbers arrive.
    const loginFailure = () => {
      const kind = state().failure?.kind
      return kind === "login-expired" || kind === "no-login" ? state().failure : null
    }

    // One window of the footer: "5h ▰▱▱▱▱▱ 23%", or "5h 23%" when there is no room for the bar.
    const FooterPiece = (props: { part: FooterPart }) => {
      const percent = () => props.part.percent
      const bar = () => {
        const value = percent()
        return value === null || props.part.cells === 0 ? undefined : meter(value, props.part.cells)
      }
      const fg = () => {
        const value = percent()
        if (value === null) return theme.text.faint
        return colour(props.part.window === "fable" ? fableLevel(value) : usageLevel(value))
      }
      return (
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme.text.muted} wrapMode="none">{`${props.part.label} `}</text>
          <Show when={percent() !== null} fallback={<text fg={theme.text.faint} wrapMode="none">libero</text>}>
            <Show when={bar()}>
              {(drawn) => (
                <box flexDirection="row" flexShrink={0}>
                  <Show when={drawn().filled.length > 0}>
                    <text fg={fg()} wrapMode="none">{drawn().filled}</text>
                  </Show>
                  <Show when={drawn().empty.length > 0}>
                    <text fg={theme.text.faint} wrapMode="none">{drawn().empty}</text>
                  </Show>
                </box>
              )}
            </Show>
            <text fg={fg()} wrapMode="none">{`${bar() ? " " : ""}${formatPercent(percent() ?? 0)}`}</text>
          </Show>
        </box>
      )
    }

    const Footer = () => {
      // Columns this item may use: measured from the row it sits in (never from the terminal width,
      // because the footer is as wide as the prompt, not as the screen).
      const fallback = () => Math.max(1, ((context.renderer as { width?: number }).width ?? 100) - FALLBACK_OTHERS)
      const [budget, setBudget] = createSignal(fallback())
      const tracker = createWidthTracker({ initial: budget(), onChange: setBudget })
      let box: Node | undefined
      const measure = () => {
        try {
          if (!box) return
          const grower = box.parent?.getChildren?.().find((kid) => kid !== box && (kid.getFlexGrow?.() ?? 0) > 0)
          tracker.report(rowBudget(box.width, grower?.width, PATH_RESERVE) ?? fallback())
        } catch {
          tracker.report(fallback())
        }
      }
      const renderer = context.renderer as unknown as {
        on?: (event: string, listener: () => void) => unknown
        off?: (event: string, listener: () => void) => unknown
      }
      // The resize event comes before the new layout is computed, so the row is read one short step later.
      let afterResize: ReturnType<typeof setTimeout> | undefined
      const onResize = () => {
        if (afterResize === undefined) {
          afterResize = setTimeout(() => {
            afterResize = undefined
            measure()
          }, LAYOUT_SETTLE_MS)
        }
      }
      renderer.on?.("resize", onResize)
      const check = setInterval(measure, LAYOUT_CHECK_MS)
      onCleanup(() => {
        renderer.off?.("resize", onResize)
        if (afterResize !== undefined) clearTimeout(afterResize)
        clearInterval(check)
        tracker.dispose()
        if (box) box.onSizeChange = undefined
      })

      const layout = createMemo(() =>
        footerLayout(
          {
            five: state().snapshot?.fiveHour?.percent ?? null,
            week: state().snapshot?.sevenDay?.percent ?? null,
            fable: state().snapshot?.fable?.percent ?? null,
            stale: state().failure !== null,
          },
          budget(),
        ),
      )
      const message = (kind: "login" | "waiting") => footerMessage(kind, budget())

      return (
        <box
          flexDirection="row"
          flexShrink={0}
          ref={(el: Node) => {
            box = el
            el.onSizeChange = () => queueMicrotask(measure)
            queueMicrotask(measure)
          }}
        >
          <Switch
            fallback={
              <Show when={layout()}>
                {(drawn) => (
                  <box flexDirection="row" flexShrink={0}>
                    <For each={drawn().parts}>
                      {(part, index) => (
                        <>
                          <Show when={index() > 0}>
                            <text wrapMode="none">{" ".repeat(drawn().gap)}</text>
                          </Show>
                          <FooterPiece part={part} />
                        </>
                      )}
                    </For>
                    <Show when={drawn().marker}>
                      <text fg={theme.text.faint} wrapMode="none">{"  (vecchio)"}</text>
                    </Show>
                  </box>
                )}
              </Show>
            }
          >
            <Match when={loginFailure()}>
              <Show when={message("login")}>
                {(text) => <text fg={(theme.text.feedback?.warning?.base ?? theme.text.base)} wrapMode="none">{text()}</text>}
              </Show>
            </Match>
            <Match when={!state().snapshot}>
              <Show when={message("waiting")}>
                {(text) => <text fg={theme.text.faint} wrapMode="none">{text()}</text>}
              </Show>
            </Match>
          </Switch>
        </box>
      )
    }

    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <ErrorBoundary fallback={(error) => { reportRenderError("footer", error); return <text fg={theme.text.faint} wrapMode="none">{"Claude: uso non disponibile"}</text> }}>
          <Footer />
        </ErrorBoundary>
      ),
    })

    // One row of the dialog: label, meter, percentage, then the reset line underneath. The meter and
    // the reset line follow the width of the dialog.
    const DialogRow = (props: {
      label: string
      window: UsageWindow | null
      cells: number
      inner: number
      level?: (percent: number) => Level
    }) => {
      const pad = () => dialogLayout(props.inner).labelWidth
      return (
        <box flexDirection="column" paddingBottom={1}>
          <box flexDirection="row">
            <text fg={theme.text.base} wrapMode="none">{props.label.padEnd(pad())}</text>
            <Show when={props.window} fallback={<text fg={theme.text.faint} wrapMode="none">{fitText("nessuna finestra attiva", Math.max(1, props.inner - pad()))}</text>}>
              {(window) => {
                const bar = () => meter(window().percent, props.cells)
                const fg = () => colour((props.level ?? usageLevel)(window().percent))
                return (
                  <box flexDirection="row" flexShrink={0}>
                    <Show when={bar().filled.length > 0}>
                      <text fg={fg()} wrapMode="none">{bar().filled}</text>
                    </Show>
                    <Show when={bar().empty.length > 0}>
                      <text fg={theme.text.faint} wrapMode="none">{bar().empty}</text>
                    </Show>
                    <text fg={fg()} wrapMode="none">{`  ${formatPercent(window().percent).padStart(4)}`}</text>
                  </box>
                )
              }}
            </Show>
          </box>
          <Show when={props.window}>
            {(window) => (
              <text fg={theme.text.muted} wrapMode="none">
                {`${"".padEnd(pad())}${resetFit(window(), now(), Math.max(1, props.inner - pad()))}`}
              </text>
            )}
          </Show>
        </box>
      )
    }

    const Dialog = () => {
      const [width, setWidth] = createSignal(DIALOG_DEFAULT_WIDTH)
      const tracker = createWidthTracker({ initial: DIALOG_DEFAULT_WIDTH, onChange: setWidth })
      let box: Node | undefined
      onCleanup(() => {
        tracker.dispose()
        if (box) box.onSizeChange = undefined
      })
      const inner = () => Math.max(1, width() - DIALOG_PADDING)
      const cells = () => dialogLayout(inner()).cells
      return (
        <box
          flexDirection="column"
          width="100%"
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          ref={(el: Node) => {
            box = el
            el.onSizeChange = () => queueMicrotask(() => tracker.report(el.width))
            queueMicrotask(() => tracker.report(el.width))
          }}
        >
          <text fg={theme.text.base}>Abbonamento Claude</text>
          <text>{" "}</text>
          <Show when={state().snapshot} fallback={<text fg={theme.text.faint}>Dati non ancora disponibili.</text>}>
            {(snap) => (
              <box flexDirection="column">
                <DialogRow label="5 ore" window={snap().fiveHour} cells={cells()} inner={inner()} />
                <DialogRow label="Settimana" window={snap().sevenDay} cells={cells()} inner={inner()} />
                <Show when={snap().fable}>
                  {(fable) => <DialogRow label="Fable" window={fable()} cells={cells()} inner={inner()} level={fableLevel} />}
                </Show>
                <Show when={weeklyOverThreshold(snap())}>
                  <text fg={(theme.text.feedback?.error?.base ?? theme.text.base)}>
                    {`Sopra il ${WEEKLY_THRESHOLD_PERCENT}%: stai usando la riserva del ${100 - WEEKLY_THRESHOLD_PERCENT}%.`}
                  </text>
                  <text>{" "}</text>
                </Show>
                <text fg={theme.text.faint}>{updatedIt(snap().fetchedAt, now())}</text>
              </box>
            )}
          </Show>
          <Show when={state().failure}>
            {(failure) => <text fg={(theme.text.feedback?.warning?.base ?? theme.text.base)}>{`Ultimo aggiornamento non riuscito: ${failureIt(failure())}`}</text>}
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
