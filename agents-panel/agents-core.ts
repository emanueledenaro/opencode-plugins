// Pure logic of the agents-panel plugin: turns the child sessions of one session into the lines the
// sidebar draws (groups, rows, alignment, truncation, time format). No OpenCode API and no I/O here,
// so it is all covered by agents-core.test.ts.

export const MAX_FINISHED = 3
export const MAX_ROWS = 10
export const TITLE_MAX = 60
export const MIN_WIDTH = 24
export const MAX_RUNS = 200

const MODEL_COLUMN = 9
const DETAIL_INDENT = " ".repeat(11)
const NAME_GAP = 2

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export type Outcome = "done" | "error" | "stopped"
export type ModelKey = "opus" | "sonnet" | "haiku" | "fable" | "other"
export type GroupKind = "waiting" | "working" | "done"

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
  /** Model id from the session info, used when no event told us the model. */
  modelId?: string
}

/** What the plugin saw happen through events (more exact than the session timestamps). */
export type Run = {
  startedAt?: number
  endedAt?: number
  outcome?: Outcome
  modelId?: string
  /** Short title of the latest tool call of the current run. */
  tool?: string
}

export type ViewRow = {
  id: string
  /** "✗ " on an error row (it takes the place of the indent), otherwise undefined. */
  mark?: string
  /** Indent plus model name, padded to the model column. */
  lead: string
  /** Name padded so that the time lands on the right edge. */
  name: string
  time: string
  /** Second line, already indented, starting with "└ ". */
  detail?: string
  failed: boolean
  modelKey: ModelKey
}

export type ViewGroup = { kind: GroupKind; icon: string; title: string; rows: ViewRow[] }

export type View = {
  empty: boolean
  emptyText: string
  header: { title: string; count: string }
  groups: ViewGroup[]
  /** Active rows that did not fit in MAX_ROWS. */
  hidden: number
  hiddenText: string
}

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "40s", "12m", "2h", "1g", and " fa" after it for a finished run. */
export function clockIt(ms: number, finished: boolean): string {
  const gap = ms > 0 ? ms : 0
  let text: string
  if (gap < MINUTE) text = `${Math.floor(gap / SECOND)}s`
  else if (gap < HOUR) text = `${Math.floor(gap / MINUTE)}m`
  else if (gap < DAY) text = `${Math.floor(gap / HOUR)}h`
  else text = `${Math.floor(gap / DAY)}g`
  return finished ? `${text} fa` : text
}

/** Cuts text to `width` characters, ending with "…" when it was longer. */
export function fit(text: string, width: number): string {
  if (width <= 0) return ""
  const chars = [...text]
  if (chars.length <= width) return text
  return `${chars.slice(0, width - 1).join("")}…`
}

export function spinnerFrame(index: number): string {
  const n = SPINNER_FRAMES.length
  return SPINNER_FRAMES[((index % n) + n) % n]
}

const KNOWN_MODELS: { key: Exclude<ModelKey, "other">; label: string }[] = [
  { key: "opus", label: "Opus" },
  { key: "sonnet", label: "Sonnet" },
  { key: "haiku", label: "Haiku" },
  { key: "fable", label: "Fable" },
]

/** Short name and colour key of a model id: Opus, Sonnet, Haiku, Fable, else its first word. */
export function shortModel(id: string | undefined): { label: string; key: ModelKey } {
  const bare = (id ?? "").split("/").pop()?.toLowerCase() ?? ""
  for (const known of KNOWN_MODELS) if (bare.includes(known.key)) return { label: known.label, key: known.key }
  const word = bare.split(/[^a-z]+/).find((part) => part !== "")
  if (!word) return { label: "Agente", key: "other" }
  const cut = word.slice(0, 8)
  return { label: cut[0].toUpperCase() + cut.slice(1), key: "other" }
}

const DEFAULT_TITLE = /^(Child|New) session - /

/** One line, no default OpenCode title, at most `max` characters. */
export function displayTitle(title: string | undefined, max: number): string {
  const text = (title ?? "").replace(/\s+/g, " ").trim()
  if (text === "" || DEFAULT_TITLE.test(text)) return "Subagente"
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Short title of one tool call, from the tool name and its input. Undefined without a tool name. */
export function toolDetail(name: string | undefined, input: unknown): string | undefined {
  if (typeof name !== "string" || name === "") return undefined
  const data = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const text = (key: string) => (typeof data[key] === "string" ? (data[key] as string).trim() : "")
  const withName = (value: string) => (value === "" ? name : `${name} ${value}`)
  const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? ""
  switch (name) {
    case "shell": {
      // Never the command line itself: it can carry a token or a password. The agent's own short
      // description if there is one, else only the program name, skipping VAR=value prefixes.
      const description = text("description").split("\n")[0].replace(/\s+/g, " ").trim()
      if (description !== "") return description
      const words = text("command").split(/\s+/).filter((word) => word !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
      const program = (words[0] === "sudo" || words[0] === "env" ? words[1] : words[0]) ?? ""
      return base(program) || name
    }
    case "read":
    case "edit":
    case "write":
      return withName(base(text("path") || text("filePath")))
    case "grep":
    case "glob":
    case "websearch":
      return name // patterns and queries can hold a pasted value
    case "subagent":
      return text("description") || name
    case "webfetch": {
      try {
        return withName(new URL(text("url")).host)
      } catch {
        return name
      }
    }
    case "skill":
      return withName(text("id") || text("name"))
    default:
      return name
  }
}

export function createRunTracker() {
  const runs = new Map<string, Run>()
  /** Latest write wins the place; past MAX_RUNS the least recently written run is dropped. */
  const put = (id: string, run: Run) => {
    runs.delete(id)
    runs.set(id, run)
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value as string) // oldest first
  }
  return {
    started(id: string, at: number) {
      const modelId = runs.get(id)?.modelId
      put(id, modelId === undefined ? { startedAt: at } : { startedAt: at, modelId })
    },
    ended(id: string, outcome: Outcome, at: number) {
      const { tool: _tool, ...rest } = runs.get(id) ?? {}
      put(id, { ...rest, endedAt: at, outcome })
    },
    model(id: string, modelId: string) {
      put(id, { ...runs.get(id), modelId })
    },
    tool(id: string, detail: string) {
      put(id, { ...runs.get(id), tool: detail })
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

type Entry = { child: ChildInput; run: Run | undefined }

function makeRow(entry: Entry, kind: GroupKind, now: number, width: number): ViewRow {
  const { child, run } = entry
  const model = shortModel(run?.modelId ?? child.modelId)
  const finished = kind === "done"
  const failed = finished && run?.outcome === "error"
  const since = finished ? (run?.endedAt ?? child.updatedAt) : (run?.startedAt ?? child.createdAt)
  const time = clockIt(now - since, finished)
  const mark = failed ? "✗ " : undefined
  const lead = `${mark ? "" : "  "}${model.label.padEnd(MODEL_COLUMN)}`
  const room = width - 2 - MODEL_COLUMN - time.length
  const name = fit(displayTitle(child.title, TITLE_MAX), room - NAME_GAP).padEnd(room)

  let detailText: string | undefined
  if (kind === "waiting") detailText = child.permissionPending ? "chiede un permesso" : "ha una domanda"
  else if (kind === "working") detailText = run?.tool
  const detail = detailText ? `${DETAIL_INDENT}└ ${fit(detailText, width - DETAIL_INDENT.length - 2)}` : undefined

  return { id: child.id, mark, lead, name, time, detail, failed, modelKey: model.key }
}

const GROUPS: { kind: GroupKind; icon: string; title: string }[] = [
  { kind: "waiting", icon: "⚠", title: "Ti aspetta" },
  { kind: "working", icon: "", title: "Al lavoro" },
  { kind: "done", icon: "✓", title: "Finiti" },
]

/**
 * The whole sidebar as data. Order: waiting, working (oldest first), the last MAX_FINISHED finished
 * (newest first). At most MAX_ROWS rows: active rows win, finished fill what is left.
 */
export function buildView(children: ChildInput[], runs: Record<string, Run>, now: number, width: number): View {
  const w = Math.max(width, MIN_WIDTH)
  const entries: Entry[] = children.map((child) => ({ child, run: runs[child.id] }))
  const startOf = (e: Entry) => e.run?.startedAt ?? e.child.createdAt
  const endOf = (e: Entry) => e.run?.endedAt ?? e.child.updatedAt

  const waiting = entries.filter((e) => e.child.permissionPending || e.child.formPending).sort((a, b) => startOf(a) - startOf(b))
  const waitingIds = new Set(waiting.map((e) => e.child.id))
  const working = entries.filter((e) => !waitingIds.has(e.child.id) && e.child.running).sort((a, b) => startOf(a) - startOf(b))
  const activeIds = new Set([...waitingIds, ...working.map((e) => e.child.id)])
  const done = entries.filter((e) => !activeIds.has(e.child.id)).sort((a, b) => endOf(b) - endOf(a))

  const activeCount = waiting.length + working.length
  const shownWaiting = waiting.slice(0, MAX_ROWS)
  const shownWorking = working.slice(0, MAX_ROWS - shownWaiting.length)
  const shownActive = shownWaiting.length + shownWorking.length
  const shownDone = done.slice(0, Math.min(MAX_FINISHED, MAX_ROWS - shownActive))

  const byKind: Record<GroupKind, Entry[]> = { waiting: shownWaiting, working: shownWorking, done: shownDone }
  const groups: ViewGroup[] = GROUPS.filter((g) => byKind[g.kind].length > 0).map((g) => ({
    ...g,
    rows: byKind[g.kind].map((e) => makeRow(e, g.kind, now, w)),
  }))

  const title = "SUBAGENTI"
  const hidden = activeCount - shownActive
  return {
    empty: children.length === 0,
    emptyText: "Nessun subagente",
    header: { title, count: activeCount > 0 ? String(activeCount).padStart(w - title.length) : "" },
    groups,
    hidden,
    hiddenText: `+${hidden} altri`,
  }
}
