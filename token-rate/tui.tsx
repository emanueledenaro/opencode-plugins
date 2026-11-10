// TUI part of the token-rate plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Measures how fast the model streams a reply (output tokens divided by the time between the first and
// the last streamed text chunk). Footer: a sparkline of the last replies and the last rate, "▂▃▅▇▆ 42 tok/s",
// a spinner and a live estimate while a reply streams. /velocita opens a dialog with today's numbers per
// model. Every measurement is appended to a jsonl log. Logic is in ./token-rate-core.ts (tested), the
// log in ./token-rate-log.ts, see ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import {
  buildFooterView,
  buildSpeedDialog,
  contentWidth,
  createLiveRate,
  createRateTracker,
  createWidthSettler,
  dedupeMeasurements,
  dialogSparkCells,
  fitFooter,
  fitText,
  footerRoom,
  formatModelDetail,
  formatNumberIt,
  formatRateIt,
  formatSecondsIt,
  isUsableMeasurement,
  padColumns,
  sparkline,
  visibleColumns,
  type LayoutBox,
  type LiveSample,
  type ThroughputMeasurement,
} from "./token-rate-core.ts"
import { appendMeasurement, readMeasurements } from "./token-rate-log.ts"

const KEPT_IN_MEMORY = 200
const RESIZE_SETTLE_MS = 60
const DIALOG_WIDTH_GUESS = 56
const COLUMN_GAP = 2
// How strongly the path takes the cut when the footer row is too full (the other items default to 1).
const PATH_SHRINK = 50
// OpenCode lays the footer row out a frame or two after a reply starts or ends.
const LAYOUT_SETTLE_MS = 50
const PATH_ITEM_ID = "prompt.footer.location"

// A theme token is either a colour or an object with .base; anything missing falls back.
// (text.muted and text.faint are plain colours, feedback.warning has .base.)
const pick = (token: any): any => (token && typeof token === "object" && "base" in token ? token.base : token)

const layoutOf = (node: any): LayoutBox => ({
  x: node.x,
  width: node.width,
  children: (node.getChildren?.() ?? []).map(layoutOf),
})

// True for the footer item that holds the working-directory path (2.2.6 gives it this id).
const isPathItem = (node: any): boolean =>
  node?.id === PATH_ITEM_ID || (node?.getChildren?.() ?? []).some((child: any) => isPathItem(child))

export default Plugin.define({
  id: "local.token-rate",
  async setup(context) {
    if (process.env.TOKEN_RATE_DISABLED === "1") return

    const theme = context.theme as any
    // Read at render time (getters), so a theme change reaches the next frame.
    const colour = {
      get base() {
        return pick(theme.text?.base)
      },
      get muted() {
        return pick(theme.text?.muted) ?? pick(theme.text?.base)
      },
      get faint() {
        return pick(theme.text?.faint) ?? pick(theme.text?.muted) ?? pick(theme.text?.base)
      },
      // the one accent: "slower than this model usually is"
      get slow() {
        return pick(theme.text?.feedback?.warning) ?? pick(theme.text?.base)
      },
    }

    const tracker = createRateTracker()
    const liveRate = createLiveRate()
    const logging = process.env.TOKEN_RATE_LOG !== "off"
    const [recent, setRecent] = createSignal<ThroughputMeasurement[]>([])
    const [seed, setSeed] = createSignal<ThroughputMeasurement[]>([])
    const [liveBySession, setLiveBySession] = createSignal<Record<string, LiveSample>>({})

    // The model's usual speed comes from the log, read once here and never per frame. Deduped and
    // filtered once here, so an idle view does not redo it for about 4000 rows.
    if (logging) void readMeasurements().then((found) => setSeed(dedupeMeasurements(found).filter(isUsableMeasurement)))

    const record = (measurement: ThroughputMeasurement) => {
      setRecent((current) => [...current, measurement].slice(-KEPT_IN_MEMORY))
      if (!logging) return
      // the log is a bonus; the footer still works without it
      void appendMeasurement(measurement).catch(() => {})
    }

    const dropLiveSample = (sessionID: string) =>
      setLiveBySession((current) => {
        if (!(sessionID in current)) return current
        const { [sessionID]: _gone, ...rest } = current
        return rest
      })
    const clearLive = (sessionID: string, messageID: string) => {
      liveRate.end({ sessionID, messageID })
      dropLiveSample(sessionID)
    }
    // A whole execution ended (done, failed or interrupted): nothing of that session may stay "live".
    const endSession = (sessionID: string) => {
      liveRate.endSession(sessionID)
      dropLiveSample(sessionID)
    }

    type Event<T> = { data: T; created?: number }
    const at = (event: { created?: number }) => (typeof event.created === "number" ? event.created : Date.now())

    const stops = [
      context.data.on("session.step.started", (event: Event<any>) => {
        if (!event.data?.sessionID) return
        tracker.stepStarted({
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          startedAt: typeof event.data.started === "number" ? event.data.started : at(event),
          providerID: String(event.data.model?.providerID ?? ""),
          modelID: String(event.data.model?.id ?? ""),
        })
      }),
      context.data.on("session.text.delta", (event: Event<any>) => {
        const sessionID = event.data?.sessionID
        if (!sessionID) return
        const messageID = event.data.assistantMessageID
        tracker.textDelta({ sessionID, messageID, ordinal: Number(event.data.ordinal ?? 0), at: at(event) })
        const sample = liveRate.delta({
          sessionID,
          messageID,
          chars: typeof event.data.delta === "string" ? event.data.delta.length : 0,
          at: at(event),
        })
        if (sample) setLiveBySession((current) => ({ ...current, [sessionID]: sample }))
      }),
      context.data.on("session.step.ended", (event: Event<any>) => {
        const sessionID = event.data?.sessionID
        if (!sessionID) return
        const messageID = event.data.assistantMessageID
        const measurement = tracker.stepEnded({ sessionID, messageID, outputTokens: Number(event.data.tokens?.output ?? 0) })
        clearLive(sessionID, messageID)
        // a burst (the whole text at once) says nothing about speed: not shown, not logged
        if (measurement && isUsableMeasurement(measurement)) record(measurement)
      }),
      context.data.on("session.step.failed", (event: Event<any>) => {
        const sessionID = event.data?.sessionID
        if (!sessionID) return
        tracker.stepFailed({ sessionID, messageID: event.data.assistantMessageID })
        clearLive(sessionID, event.data.assistantMessageID)
      }),
      ...["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].map((name) =>
        context.data.on(name, (event: Event<any>) => {
          const sessionID = event.data?.sessionID
          if (sessionID) endSession(sessionID)
        }),
      ),
    ]

    const viewedSessionID = (): string | undefined => {
      const route = context.ui.router.current() as { type?: string; sessionID?: string } | undefined
      return route?.type === "session" ? route.sessionID : undefined
    }
    const view = createMemo(() => {
      const viewed = viewedSessionID()
      return buildFooterView({
        recent: recent(),
        seed: seed(),
        viewedSessionID: viewed,
        live: viewed === undefined ? undefined : liveBySession()[viewed],
      })
    })

    // The footer shares its row with OpenCode's hints and other plugins (claude-usage). It measures what
    // the row has left (row width minus the other items and their gaps) and steps down to fit:
    // sparkline and rate, then the rate alone, then nothing. It never wraps and never pushes a neighbour.
    const [room, setRoom] = createSignal<number | undefined>(undefined)

    const Footer = () => {
      let box: any
      const watched = new Set<any>()
      const detach: (() => void)[] = []
      const settler = createWidthSettler({
        delayMs: RESIZE_SETTLE_MS,
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        onSettle: setRoom,
      })
      const measure = () => {
        // A layout node can be gone or half built while OpenCode rebuilds the row: skip this round.
        try {
          measureRow()
        } catch {}
      }
      const measureRow = () => {
        const row = box?.parent
        if (!row || typeof row.getChildren !== "function") return
        const items: any[] = row.getChildren()
        for (const node of [row, ...items]) watch(node)
        const siblings = items.filter((item) => item !== box)
        // The first item is stretched to fill the row. Idle it holds the working-directory path, which
        // truncates itself, so it may give up cells. While a reply streams it holds OpenCode's
        // "esc interrupt" hint: that must never be cut, so it keeps all of its content.
        const first = siblings[0]
        const isPath = first !== undefined && isPathItem(first)
        if (isPath) absorbShrink(first)
        settler.observe(
          footerRoom({
            rowWidth: row.width,
            siblingWidths: siblings.map((item) => item.width),
            flexibleIndex: first ? 0 : undefined,
            flexibleFloor: first && !isPath ? contentWidth(layoutOf(first)) : undefined,
          }),
        )
      }
      // When the row is too full, flexbox takes cells from every item in proportion to its size, so
      // claude-usage would lose a meter cell. The path already truncates itself, so it is told to take
      // the whole cut. Put back on cleanup.
      let pathBox: any
      let pathShrink: unknown
      const absorbShrink = (node: any) => {
        try {
          if (!node || node === pathBox || node === box || !("flexShrink" in node)) return
          pathBox = node
          pathShrink = node.flexShrink
          node.flexShrink = PATH_SHRINK
        } catch {}
      }
      // A resize of the row or of any item in it re-measures; an unchanged result does no work.
      const watch = (node: any) => {
        if (!node || watched.has(node) || typeof node.on !== "function") return
        watched.add(node)
        node.on("resize", measure)
        detach.push(() => node.off?.("resize", measure))
      }
      const first = setTimeout(measure, 0)
      // The first item of the row changes when a reply starts or ends (path <-> interrupt hint): look again.
      let again: ReturnType<typeof setTimeout> | undefined
      const isLive = createMemo(() => view()?.live === true)
      createEffect(
        on(
          isLive,
          () => {
            clearTimeout(again)
            again = setTimeout(measure, LAYOUT_SETTLE_MS)
          },
          { defer: true },
        ),
      )
      onCleanup(() => {
        clearTimeout(first)
        clearTimeout(again)
        settler.dispose()
        detach.forEach((stop) => stop())
        watched.clear()
        try {
          if (pathBox && !pathBox.isDestroyed) pathBox.flexShrink = pathShrink ?? 1
        } catch {}
      })

      const fit = createMemo(() => fitFooter(view(), room() ?? 0))
      return (
        <box
          ref={(node: any) => {
            box = node
            watch(node)
          }}
          flexDirection="row"
          flexShrink={0}
          paddingLeft={2}
          visible={fit() !== undefined}
        >
          <Show when={fit()?.lead}>
            {(lead) => <text fg={colour.faint} wrapMode="none">{`${lead()} `}</text>}
          </Show>
          <text fg={fit()?.tone === "slow" ? colour.slow : colour.muted} wrapMode="none">{fit()?.rateText ?? " "}</text>
        </box>
      )
    }

    // Appended to the status row, next to what other plugins (claude-usage) put there.
    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <ErrorBoundary fallback={<text fg={colour.faint} wrapMode="none">{"tok/s non disponibile"}</text>}>
          <Footer />
        </ErrorBoundary>
      ),
    })

    // ---- /velocita dialog: the log is read once when it opens ----
    type DialogData = ReturnType<typeof buildSpeedDialog>
    const [dialogData, setDialogData] = createSignal<DialogData | undefined>(undefined)

    // The dialog follows its own width: sparkline cells, wording and columns shrink, nothing wraps.
    const [dialogWidth, setDialogWidth] = createSignal(DIALOG_WIDTH_GUESS)

    const ModelRows = (props: { data: DialogData }) => {
      const cells = () =>
        padColumns(
          props.data.models.map((row) => [row.label, formatRateIt(row.medianRate) ?? "n/d"]),
          ["left", "right"],
        )
      const labelWidth = () => cells()[0]?.[0]?.length ?? 0
      const rateWidth = () => cells()[0]?.[1]?.length ?? 0
      const sparkCells = () => dialogSparkCells(dialogWidth(), labelWidth() + COLUMN_GAP + rateWidth() + COLUMN_GAP)
      return (
        <For each={props.data.models}>
          {(row, index) => (
            <box flexDirection="column" paddingBottom={1}>
              <box flexDirection="row">
                <text fg={colour.base} wrapMode="none">{cells()[index()]?.[0] ?? row.label}</text>
                <text fg={colour.base} wrapMode="none">{`  ${cells()[index()]?.[1] ?? ""}`}</text>
                <Show when={sparkCells() > 0}>
                  <text fg={colour.muted} wrapMode="none">{`  ${sparkline(row.rates, sparkCells())}`}</text>
                </Show>
              </box>
              <Show when={formatModelDetail(row, dialogWidth() - labelWidth() - COLUMN_GAP)}>
                {(detail) => (
                  <text fg={colour.muted} wrapMode="none">{`${" ".repeat(labelWidth() + COLUMN_GAP)}${detail()}`}</text>
                )}
              </Show>
            </box>
          )}
        </For>
      )
    }

    // label, rate, tokens, time, and a note on slow replies; the least important go first when narrow.
    const SESSION_PRIORITY = [1, 0, 3, 2, 4]
    const SessionRows = (props: { data: DialogData }) => {
      const table = () => {
        const rows = props.data.session.map((row) => [
          row.label,
          formatRateIt(row.rate) ?? "n/d",
          `${formatNumberIt(row.outputTokens, 0)} token`,
          formatSecondsIt(row.generationMs) ?? "n/d",
          row.slow ? "lenta" : "",
        ])
        const align: ("left" | "right")[] = ["left", "right", "right", "right", "left"]
        const widths = align.map((_, column) => Math.max(0, ...rows.map((row) => row[column]!.length)))
        const priority = SESSION_PRIORITY.filter((column) => widths[column]! > 0)
        const shown = visibleColumns(widths, priority, dialogWidth(), COLUMN_GAP)
        const keep = align.map((_, column) => column).filter((column) => shown[column])
        const padded = padColumns(
          rows.map((row) => keep.map((column) => row[column]!)),
          keep.map((column) => align[column]!),
        )
        return { keep, padded }
      }
      const colourOf = (column: number, slow: boolean) => {
        if (column === 0) return colour.muted
        if (column === 4 || (column === 1 && slow)) return colour.slow
        return colour.base
      }
      return (
        <For each={props.data.session}>
          {(row, index) => (
            <box flexDirection="row">
              <For each={table().keep}>
                {(column, position) => (
                  <text fg={colourOf(column, row.slow)} wrapMode="none">{`${position() === 0 ? "" : "  "}${table().padded[index()]?.[position()] ?? ""}` || " "}</text>
                )}
              </For>
            </box>
          )}
        </For>
      )
    }

    // A heading is shortened to the dialog width, never cut in the middle of a word.
    const fit = (...wordings: string[]) => fitText(wordings, dialogWidth()) || " "

    const Dialog = () => {
      const settler = createWidthSettler({
        delayMs: RESIZE_SETTLE_MS,
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        onSettle: setDialogWidth,
      })
      onCleanup(() => settler.dispose())
      return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <box
            flexDirection="column"
            width="100%"
            onSizeChange={function (this: any) {
              if (this.width > 0) settler.observe(this.width)
            }}
          >
            <text fg={colour.base} wrapMode="none">{fit("Velocità del modello", "Velocità")}</text>
            <text>{" "}</text>
            <Show when={dialogData()} fallback={<text fg={colour.faint} wrapMode="none">{fit("Leggo il registro...", "Leggo...")}</text>}>
              {(data) => (
                <box flexDirection="column">
                  <text fg={colour.muted} wrapMode="none">{"Oggi"}</text>
                  <Show
                    when={data().models.length > 0}
                    fallback={<text fg={colour.faint} wrapMode="none">{fit("Ancora nessuna risposta misurata.", "Nessuna risposta.", "Nessuna.")}</text>}
                  >
                    <box flexDirection="column" paddingTop={1}>
                      <ModelRows data={data()} />
                    </box>
                    <Show when={data().hiddenModels > 0}>
                      <text fg={colour.faint} wrapMode="none">{fit(`e altri ${data().hiddenModels} modelli`, `altri ${data().hiddenModels}`)}</text>
                    </Show>
                  </Show>
                  <text>{" "}</text>
                  <text fg={colour.muted} wrapMode="none">{fit("Questa sessione, ultime risposte", "Questa sessione", "Sessione")}</text>
                  <Show
                    when={data().session.length > 0}
                    fallback={<text fg={colour.faint} wrapMode="none">{fit("Nessuna risposta misurata.", "Nessuna risposta.", "Nessuna.")}</text>}
                  >
                    <SessionRows data={data()} />
                  </Show>
                </box>
              )}
            </Show>
            <text>{" "}</text>
            <text fg={colour.faint} wrapMode="none">{fit("esc per chiudere", "esc chiude", "esc")}</text>
          </box>
        </box>
      )
    }

    const unlayer = context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "local.token-rate.show",
          title: "Velocità del modello",
          group: "Modello",
          palette: true,
          slash: { name: "velocita" },
          run: async () => {
            setDialogData(undefined)
            context.ui.dialog.set({ size: "medium", centered: true })
            context.ui.dialog.show(() => (
              <ErrorBoundary fallback={<text fg={colour.faint}>{"Velocità non disponibile."}</text>}>
                <Dialog />
              </ErrorBoundary>
            ))
            const sessionID = viewedSessionID()
            const fromLog = logging ? await readMeasurements() : []
            const all = dedupeMeasurements([...fromLog, ...recent()]).sort((a, b) => a.timestamp - b.timestamp)
            setDialogData(buildSpeedDialog({ measurements: all, sessionID, now: Date.now() }))
          },
        },
      ],
    }))

    return () => {
      stops.forEach((stop) => stop())
      unregisterFooter()
      if (typeof unlayer === "function") unlayer()
    }
  },
})
