// TUI part of the agents-panel plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Lists the background subagents (child sessions) of the session you are looking at in the sidebar:
// title, state, how long ago. Read only. The logic is in ./agents-core.ts (tested), see ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, For, Show, createMemo, createSignal } from "solid-js"
import {
  buildRows,
  createRunTracker,
  type ChildInput,
  type Row,
} from "./agents-core.ts"

const TICK_MS = 5_000

export default Plugin.define({
  id: "local.agents-panel",
  async setup(context) {
    if (process.env.AGENTS_PANEL_DISABLED === "1") return

    const theme = context.theme
    const tracker = createRunTracker()
    const [runs, setRuns] = createSignal(tracker.snapshot())
    const [now, setNow] = createSignal(Date.now())
    const refresh = () => setRuns(tracker.snapshot())
    const at = (event: unknown) => {
      const created = (event as { created?: unknown } | undefined)?.created
      return typeof created === "number" ? created : Date.now()
    }
    const sessionOf = (event: unknown) => (event as { data?: { sessionID?: string } } | undefined)?.data?.sessionID

    // Events give exact start and end times and tell an error from a normal end.
    const stops = [
      context.data.on("session.execution.started", (event) => {
        const id = sessionOf(event)
        if (!id) return
        tracker.started(id, at(event))
        refresh()
      }),
      context.data.on("session.execution.succeeded", (event) => {
        const id = sessionOf(event)
        if (!id) return
        tracker.ended(id, "done", at(event))
        refresh()
      }),
      context.data.on("session.execution.failed", (event) => {
        const id = sessionOf(event)
        if (!id) return
        tracker.ended(id, "error", at(event))
        refresh()
      }),
      context.data.on("session.execution.interrupted", (event) => {
        const id = sessionOf(event)
        if (!id) return
        tracker.ended(id, "stopped", at(event))
        refresh()
      }),
      context.data.on("session.deleted", (event) => {
        const id = sessionOf(event)
        if (!id) return
        tracker.forget(id)
        refresh()
      }),
    ]
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)

    // Read inside the memo below, so it re-runs when OpenCode's store changes.
    const childrenOf = (sessionID: string): ChildInput[] =>
      context.data.session
        .family(sessionID)
        .flatMap((id) => {
          const info = context.data.session.get(id)
          if (!info || info.parentID !== sessionID) return []
          return [
            {
              id,
              title: info.title,
              createdAt: info.time.created,
              updatedAt: info.time.idle ?? info.time.updated,
              running: context.data.session.status(id) === "running",
              permissionPending: (context.data.session.permission.list(id) ?? []).length > 0,
              formPending: (context.data.session.form.list(id, context.location) ?? []).length > 0,
            },
          ]
        })

    const colour = (row: Row) => {
      if (row.state === "errore") return theme.text.feedback.error.base
      if (row.state === "in attesa di permesso" || row.state === "in attesa di risposta") {
        return theme.text.feedback.warning.base
      }
      if (row.state === "in corso") return theme.text.feedback.info.base
      return theme.text.muted
    }

    const Panel = (props: { sessionID: string }) => {
      const rows = createMemo(() => buildRows(childrenOf(props.sessionID), runs(), now()))
      const activeCount = () => rows().filter((row) => row.kind === "active").length
      return (
        <Show when={rows().length > 0}>
          <box flexDirection="column">
            <text fg={theme.text.base}>
              {activeCount() > 0 ? `Subagenti, ${activeCount()} in corso` : "Subagenti, tutti finiti"}
            </text>
            <For each={rows()}>
              {(row) => (
                <box
                  flexDirection="column"
                  onMouseDown={() => context.ui.router.navigate({ type: "session", sessionID: row.id })}
                >
                  <text fg={theme.text.base} wrapMode="none" truncate={true}>{`${row.title}`}</text>
                  <text fg={colour(row)} wrapMode="none" truncate={true}>{`  ${row.state}, ${row.when}`}</text>
                </box>
              )}
            </For>
          </box>
        </Show>
      )
    }

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input: { sessionID: string }) => (
        <ErrorBoundary fallback={<text fg={theme.text.feedback.warning.base}>{"Subagenti: errore di visualizzazione"}</text>}>
          <Panel sessionID={input.sessionID} />
        </ErrorBoundary>
      ),
    })

    return () => {
      clearInterval(timer)
      stops.forEach((stop) => stop())
      unregister()
    }
  },
})
