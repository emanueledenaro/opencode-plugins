// TUI part of the agents-panel plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Lists the background subagents (child sessions) of the session you are looking at in the sidebar,
// in three groups: waiting for you, working, finished. Read only; a click opens the child session.
// The layout logic is in ./agents-core.ts (tested), see ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
  DEFAULT_WIDTH,
  buildView,
  createRunTracker,
  createWidthTracker,
  rowLayout,
  spinnerFrame,
  toolDetail,
  type ChildInput,
  type GroupKind,
  type ModelKey,
} from "./agents-core.ts"

const CLOCK_MS = 5_000
const SPIN_MS = 140
const DIM = 2

// The one thing read from the OpenTUI box: its own width, as OpenCode's own footer does.
type Measured = { width: number; onSizeChange?: (() => void) | undefined }

export default Plugin.define({
  id: "local.agents-panel",
  async setup(context) {
    if (process.env.AGENTS_PANEL_DISABLED === "1") return

    const theme = context.theme
    const tracker = createRunTracker()
    const [runs, setRuns] = createSignal(tracker.snapshot())
    const [now, setNow] = createSignal(Date.now())
    const [frame, setFrame] = createSignal(0)
    const refresh = () => setRuns(tracker.snapshot())
    const at = (event: unknown) => {
      const created = (event as { created?: unknown } | undefined)?.created
      return typeof created === "number" ? created : Date.now()
    }
    type Data = { sessionID?: string; id?: string; name?: string; input?: unknown; model?: { id?: string } }
    const dataOf = (event: unknown) => (event as { data?: Data } | undefined)?.data

    // Tool calls are announced by name first and by input second; keep the name until the input comes.
    const toolNames = new Map<string, string>()
    const toolKey = (sessionID: string, id: string) => `${sessionID}:${id}`

    // Events give exact start and end times, tell an error from a normal end, and carry the model
    // and the latest tool call, so no message of a child is ever read.
    const stops = [
      context.data.on("session.execution.started", (event) => {
        const id = dataOf(event)?.sessionID
        if (!id) return
        tracker.started(id, at(event))
        refresh()
      }),
      context.data.on("session.execution.succeeded", (event) => {
        const id = dataOf(event)?.sessionID
        if (!id) return
        tracker.ended(id, "done", at(event))
        refresh()
      }),
      context.data.on("session.execution.failed", (event) => {
        const id = dataOf(event)?.sessionID
        if (!id) return
        tracker.ended(id, "error", at(event))
        refresh()
      }),
      context.data.on("session.execution.interrupted", (event) => {
        const id = dataOf(event)?.sessionID
        if (!id) return
        tracker.ended(id, "stopped", at(event))
        refresh()
      }),
      context.data.on("session.step.started", (event) => {
        const data = dataOf(event)
        if (!data?.sessionID || !data.model?.id) return
        tracker.model(data.sessionID, data.model.id)
        refresh()
      }),
      context.data.on("session.tool.input.started", (event) => {
        const data = dataOf(event)
        if (!data?.sessionID || !data.id || !data.name) return
        toolNames.set(toolKey(data.sessionID, data.id), data.name)
        if (toolNames.size > 200) toolNames.delete(toolNames.keys().next().value as string)
      }),
      context.data.on("session.tool.called", (event) => {
        const data = dataOf(event)
        if (!data?.sessionID || !data.id) return
        const key = toolKey(data.sessionID, data.id)
        const detail = toolDetail(toolNames.get(key), data.input)
        toolNames.delete(key)
        if (!detail) return
        tracker.tool(data.sessionID, detail)
        refresh()
      }),
      context.data.on("session.deleted", (event) => {
        const id = dataOf(event)?.sessionID
        if (!id) return
        tracker.forget(id)
        refresh()
      }),
    ]

    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS)

    // One spinner timer shared by every panel: it runs only while somebody is working.
    let spinUsers = 0
    let spinTimer: ReturnType<typeof setInterval> | undefined
    const spinStart = () => {
      spinUsers += 1
      if (!spinTimer) spinTimer = setInterval(() => setFrame((f) => f + 1), SPIN_MS)
    }
    const spinStop = () => {
      spinUsers = Math.max(0, spinUsers - 1)
      if (spinUsers === 0 && spinTimer) {
        clearInterval(spinTimer)
        spinTimer = undefined
      }
    }

    // Read inside the memo below, so it re-runs when OpenCode's store changes.
    const childrenOf = (sessionID: string): ChildInput[] =>
      context.data.session
        .family(sessionID)
        .flatMap((id) => {
          const info = context.data.session.get(id)
          if (!info || info.parentID !== sessionID) return []
          const model = info.model as unknown
          return [
            {
              id,
              title: info.title,
              createdAt: info.time.created,
              updatedAt: info.time.idle ?? info.time.updated,
              running: context.data.session.status(id) === "running",
              permissionPending: (context.data.session.permission.list(id) ?? []).length > 0,
              formPending: (context.data.session.form.list(id, context.location) ?? []).length > 0,
              modelId: typeof model === "string" ? model : (model as { id?: string } | undefined)?.id,
            },
          ]
        })

    // Colours come from the theme, each read when drawn, with a fallback.
    type Shade = Record<number, unknown>
    const palette = () =>
      theme as unknown as { categorical?: Shade[]; hue?: Record<string, Shade | undefined> & { accent?: Shade } }
    const groupColour = (kind: GroupKind) => {
      if (kind === "waiting") return theme.text.feedback.warning?.base ?? theme.text.base
      if (kind === "working") return palette().hue?.accent?.[200] ?? theme.text.action?.primary?.base ?? theme.text.base
      return theme.text.feedback.success?.base ?? theme.text.muted
    }
    // One fixed hue per model family, so the same model has the same colour in every theme.
    const MODEL_HUE: Record<ModelKey, { hue: string; slot: number } | undefined> = {
      opus: { hue: "blue", slot: 0 },
      sonnet: { hue: "cyan", slot: 1 },
      haiku: { hue: "orange", slot: 3 },
      fable: { hue: "purple", slot: 1 },
      other: undefined,
    }
    const modelColour = (key: ModelKey) => {
      const pick = MODEL_HUE[key]
      if (!pick) return theme.text.base
      return palette().hue?.[pick.hue]?.[200] ?? palette().categorical?.[pick.slot]?.[200] ?? theme.text.base
    }

    const Panel = (props: { sessionID: string }) => {
      // The sidebar can be any width, so the panel measures itself; a burst of resizes is one update.
      const [width, setWidth] = createSignal(DEFAULT_WIDTH)
      const tracker = createWidthTracker({ initial: DEFAULT_WIDTH, onChange: setWidth })
      const view = createMemo(() => buildView(childrenOf(props.sessionID), runs(), now(), width()))
      const showModel = () => rowLayout(width()).showModel
      const spinning = createMemo(() => view().groups.some((g) => g.kind === "working"))
      createEffect(() => {
        if (!spinning()) return
        spinStart()
        onCleanup(spinStop)
      })
      let box: Measured | undefined
      onCleanup(() => {
        tracker.dispose()
        if (box) box.onSizeChange = undefined
      })
      return (
        <box
          flexDirection="column"
          width="100%"
          gap={1}
          ref={(el: Measured) => {
            box = el
            el.onSizeChange = () => tracker.report(el.width)
            queueMicrotask(() => tracker.report(el.width))
          }}
        >
          <Show
            when={!view().empty}
            fallback={<text fg={theme.text.faint} wrapMode="none">{view().emptyText}</text>}
          >
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme.text.muted} wrapMode="none">{view().header.title}</text>
              <Show when={view().header.count !== ""}>
                <text fg={theme.text.muted} wrapMode="none">{view().header.count.trim()}</text>
              </Show>
            </box>
            <For each={view().groups}>
              {(group) => (
                <box flexDirection="column">
                  <text
                    fg={groupColour(group.kind)}
                    attributes={group.kind === "done" ? DIM : 0}
                    wrapMode="none"
                  >
                    {`${group.kind === "working" ? spinnerFrame(frame()) : group.icon} ${group.title}`}
                  </text>
                  <For each={group.rows}>
                    {(row) => (
                      <box
                        flexDirection="column"
                        onMouseDown={() => context.ui.router.navigate({ type: "session", sessionID: row.id })}
                      >
                        <box flexDirection="row">
                          <Show when={row.mark}>
                            <text fg={theme.text.feedback.error?.base ?? theme.text.base} wrapMode="none">
                              {row.mark as string}
                            </text>
                          </Show>
                          <Show when={row.lead !== ""}>
                            <text
                              fg={modelColour(row.modelKey)}
                              attributes={group.kind === "done" ? DIM : 0}
                              wrapMode="none"
                            >
                              {row.lead}
                            </text>
                          </Show>
                          <text
                            fg={showModel() ? theme.text.base : modelColour(row.modelKey)}
                            attributes={group.kind === "done" ? DIM : 0}
                            wrapMode="none"
                          >
                            {row.name}
                          </text>
                          <Show when={row.time !== ""}>
                            <text fg={theme.text.faint} wrapMode="none">{row.time}</text>
                          </Show>
                        </box>
                        <Show when={row.detail}>
                          <text fg={theme.text.faint} wrapMode="none">{row.detail as string}</text>
                        </Show>
                      </box>
                    )}
                  </For>
                </box>
              )}
            </For>
            <Show when={view().hidden > 0}>
              <text fg={theme.text.faint} wrapMode="none">{view().hiddenText}</text>
            </Show>
          </Show>
        </box>
      )
    }

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input: { sessionID: string }) => (
        <ErrorBoundary fallback={<text fg={theme.text.feedback?.warning?.base ?? theme.text.faint}>{"Subagenti: errore di visualizzazione"}</text>}>
          <Panel sessionID={input.sessionID} />
        </ErrorBoundary>
      ),
    })

    return () => {
      clearInterval(clock)
      if (spinTimer) clearInterval(spinTimer)
      spinTimer = undefined
      stops.forEach((stop) => stop())
      unregister()
    }
  },
})
