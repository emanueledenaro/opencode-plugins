// Pure logic of the agents-panel plugin: turns the child sessions of one session into the rows the
// sidebar shows. No OpenCode API and no I/O here, so it is all covered by agents-core.test.ts.

export const MAX_FINISHED = 5
export const TITLE_MAX = 60

export type Outcome = "done" | "error" | "stopped"
export type RunState = "running" | Outcome

export type StateLabel =
  | "in corso"
  | "in attesa di permesso"
  | "in attesa di risposta"
  | "finito"
  | "errore"
  | "fermato"

/** What the plugin reads from OpenCode for one child session. */
export type ChildInput = {
  id: string
  title?: string
  createdAt: number
  updatedAt: number
  /** OpenCode's own status for the session: true while it is running. */
  running: boolean
  permissionPending: boolean
  formPending: boolean
}

/** What the plugin saw happen through events (more exact than the session timestamps). */
export type Run = { startedAt?: number; endedAt?: number; outcome?: Outcome }

export type Row = {
  id: string
  title: string
  state: StateLabel
  /** "active" rows (running or waiting) come first; "finished" rows are capped. */
  kind: "active" | "finished"
  when: string
}

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "ora", "12 s fa", "3 min fa", "2 h fa", "1 g fa". */
export function agoIt(ms: number): string {
  if (ms < 5 * SECOND) return "ora"
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)} s fa`
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min fa`
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h fa`
  return `${Math.floor(ms / DAY)} g fa`
}

/** "da poco", "da 12 s", "da 3 min", "da 2 h", "da 1 g". */
export function runningForIt(ms: number): string {
  if (ms < 5 * SECOND) return "da poco"
  if (ms < MINUTE) return `da ${Math.floor(ms / SECOND)} s`
  if (ms < HOUR) return `da ${Math.floor(ms / MINUTE)} min`
  if (ms < DAY) return `da ${Math.floor(ms / HOUR)} h`
  return `da ${Math.floor(ms / DAY)} g`
}

const DEFAULT_TITLE = /^(Child|New) session - /

/** One line, no default OpenCode title, at most `max` characters. */
export function displayTitle(title: string | undefined, max: number): string {
  const text = (title ?? "").replace(/\s+/g, " ").trim()
  if (text === "" || DEFAULT_TITLE.test(text)) return "Subagente"
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function stateIt(state: RunState, permissionPending: boolean, formPending: boolean): StateLabel {
  if (permissionPending) return "in attesa di permesso"
  if (formPending) return "in attesa di risposta"
  if (state === "running") return "in corso"
  if (state === "error") return "errore"
  if (state === "stopped") return "fermato"
  return "finito"
}

export function createRunTracker() {
  const runs = new Map<string, Run>()
  return {
    started(id: string, at: number) {
      runs.set(id, { startedAt: at })
      if (runs.size > 200) runs.delete(runs.keys().next().value as string) // oldest first
    },
    ended(id: string, outcome: Outcome, at: number) {
      runs.set(id, { ...runs.get(id), endedAt: at, outcome })
    },
    get(id: string): Run | undefined {
      return runs.get(id)
    },
    forget(id: string) {
      runs.delete(id)
    },
    snapshot(): Record<string, Run> {
      return Object.fromEntries(runs)
    },
  }
}

/** Active rows first (newest start first), then the last MAX_FINISHED finished rows (newest end first). */
export function buildRows(children: ChildInput[], runs: Record<string, Run>, now: number): Row[] {
  const active: { row: Row; at: number }[] = []
  const finished: { row: Row; at: number }[] = []

  for (const child of children) {
    const run = runs[child.id]
    const waiting = child.permissionPending || child.formPending
    const title = displayTitle(child.title, TITLE_MAX)

    if (child.running || waiting) {
      const at = run?.startedAt ?? child.createdAt
      const state = stateIt("running", child.permissionPending, child.formPending)
      active.push({ row: { id: child.id, title, state, kind: "active", when: runningForIt(now - at) }, at })
      continue
    }

    const at = run?.endedAt ?? child.updatedAt
    const state = stateIt(run?.outcome ?? "done", false, false)
    finished.push({ row: { id: child.id, title, state, kind: "finished", when: agoIt(now - at) }, at })
  }

  active.sort((a, b) => b.at - a.at)
  finished.sort((a, b) => b.at - a.at)
  return [...active, ...finished.slice(0, MAX_FINISHED)].map((entry) => entry.row)
}
