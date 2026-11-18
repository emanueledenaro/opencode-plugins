// TUI part of the agents-panel plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Lists the background subagents (child sessions) of the session you are looking at in the sidebar,
// in three groups: waiting for you, working, finished. Nothing is drawn while the session has none.
// Read only; a click opens the child session.
// The layout logic is in ./agents-core.ts (tested), see ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
  DEFAULT_WIDTH,
  MODEL_HUES,
  buildView,
  createRefreshBatch,
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
const BOLD = 1
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
    // Events of every session ask for a rebuild; a burst of them is one rebuild.
    const batch = createRefreshBatch({
      run: () => setRuns(tracker.snapshot()),
      scheduler: {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    })
    const refresh = () => batch.request()
    const at = (event: unknown) => {
      const created = (event as { created?: unknown } | undefined)?.created
      return typeof created === "number" ? created : Date.now()
    }
    type Data = {
      sessionID?: string
      id?: string
      requestID?: string
      name?: string
      input?: unknown
      model?: { id?: string }
      form?: { id?: string; sessionID?: string }
    }
    const dataOf = (event: unknown) => (event as { data?: Data } | undefined)?.data
    // A permission and a form can share an id, so each request is named with its kind.
    const permissionKey = (id: string) => `permission:${id}`
    const formKey = (id: string) => `form:${id}`
    const formAnswered = (event: unknown) => {
      const id = dataOf(event)?.id
      if (!id) return
      tracker.answered(formKey(id))
      refresh()
    }

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
      // When a permission or a question was asked is the start of the time shown under "Ti aspetta".
      context.data.on("permission.asked", (event) => {
        const data = dataOf(event)
        if (!data?.id || !data.sessionID) return
        tracker.asked(data.sessionID, permissionKey(data.id), at(event))
        refresh()
      }),
      context.data.on("permission.replied", (event) => {
        const requestID = dataOf(event)?.requestID
        if (!requestID) return
        tracker.answered(permissionKey(requestID))
        refresh()
      }),
      context.data.on("form.created", (event) => {
        const form = dataOf(event)?.form
        if (!form?.id || !form.sessionID) return
        tracker.asked(form.sessionID, formKey(form.id), at(event))
        refresh()
      }),
      context.data.on("form.replied", formAnswered),
      context.data.on("form.cancelled", formAnswered),
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
    // One fixed hue per model family (MODEL_HUES), never a hue that means a state in this panel.
    const modelColour = (key: ModelKey) => {
      const pick = MODEL_HUES[key]
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
      // No subagent, no panel: a session without subagents keeps its sidebar rows for something else.
      return (
        <Show when={!view().empty}>
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
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme.text.base} attributes={BOLD} wrapMode="none">{view().header.title}</text>
              <Show when={view().header.state !== ""}>
                <text
                  fg={view().header.stateKind === "waiting" ? groupColour("waiting") : theme.text.muted}
                  wrapMode="none"
                >
                  {view().header.state.trim()}
                </text>
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
          </box>
        </Show>
      )
    }

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input: { sessionID: string }) => (
        <ErrorBoundary fallback={<text fg={theme.text.faint}>{"Subagenti: non disponibile"}</text>}>
          <Panel sessionID={input.sessionID} />
        </ErrorBoundary>
      ),
    })

    return () => {
      clearInterval(clock)
      if (spinTimer) clearInterval(spinTimer)
      spinTimer = undefined
      stops.forEach((stop) => stop())
      batch.dispose()
      unregister()
    }
  },
})
