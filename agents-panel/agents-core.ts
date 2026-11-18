// Pure logic of the agents-panel plugin: turns the child sessions of one session into the lines the
// sidebar draws (groups, rows, alignment, truncation, time format). No OpenCode API and no I/O here,
// so it is all covered by agents-core.test.ts.

export const MAX_FINISHED = 3
export const MAX_ROWS = 10
export const TITLE_MAX = 60
export const MAX_RUNS = 200
export const RESIZE_COALESCE_MS = 50

/** Width assumed before the panel has been measured, and for a width that is not a usable number. */
export const DEFAULT_WIDTH = 34
/** Below this the model column goes, so the name keeps its room. */
export const MODEL_MIN_WIDTH = 24
/** Below this the time goes too: only the name is left. */
export const TIME_MIN_WIDTH = 14

const MODEL_COLUMN = 9
const DETAIL_INDENT = " ".repeat(11)
const COMPACT_INDENT = "  "
const NAME_GAP = 2
/** A time that would leave the name fewer characters than this is left out: the name says who it is. */
const NAME_MIN = 4

// Quadrant blocks, as token-rate uses: SF Mono and Menlo have them, they have no braille patterns.
export const SPINNER_FRAMES = ["▘", "▝", "▗", "▖"]

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
  /** When the oldest permission or question still open was asked: how long the agent has waited for you. */
  waitingSince?: number
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

/** What the header says on its right edge: who waits for you, else who works. */
export type HeaderState = { text: string; kind: "waiting" | "working" }

export type View = {
  /** No subagent at all: the panel draws nothing. */
  empty: boolean
  /** `state` is padded on the left so that `title + state` is the whole line; "" when it does not fit. */
  header: { title: string; state: string; stateKind?: HeaderState["kind"] }
  groups: ViewGroup[]
  /** Active rows that did not fit in MAX_ROWS. */
  hidden: number
  hiddenText: string
}

/**
 * A span of time the way every panel shows it: "<1m", "12m", "1h 5m", "2g 3h". At most two units, the
 * smaller one left out when it is 0. A negative or unusable span reads as "<1m".
 * Keep identical in every core that has it: copies.test.ts at the root lists and compares them.
 */
export function relativeIt(ms: number): string {
  const minutes = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}g` : `${days}g ${hours % 24}h`
}

/** The time on a row: "12m" for an agent at work, "3m fa" for a finished one, "da 2m" for one that waits for you. */
export function rowTime(gapMs: number, kind: GroupKind): string {
  const span = relativeIt(gapMs)
  if (kind === "done") return `${span} fa`
  return kind === "waiting" ? `da ${span}` : span
}

/** Text on one line and without control characters (escape codes, bells), so it never moves the cursor. */
export function oneLine(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
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

/** Theme hues that already mean a state in this panel: waits for you, finished, failed. */
export const STATE_HUES: readonly string[] = ["orange", "green", "red"]

/**
 * One fixed theme hue per model family, so a model has the same colour in every theme; `slot` is the place
 * in the theme's categorical palette used when it has no such hue. Never a hue of STATE_HUES. Yellow has
 * no slot: see modelColour.
 */
export const MODEL_HUES: Record<ModelKey, { hue: string; slot?: number } | undefined> = {
  opus: { hue: "blue", slot: 0 },
  sonnet: { hue: "cyan", slot: 1 },
  haiku: { hue: "yellow" },
  fable: { hue: "purple", slot: 1 },
  other: undefined,
}

/** The yellow drawn when the theme has no yellow hue: the apple theme's own, on a dark and on a light background. */
export const CAUTION_YELLOW = { dark: "#ffd60a", light: "#a05a00" } as const

/**
 * The yellow of a caution: the middle of a scale, a slow reply, a label. OpenCode builds a theme's hues from
 * its state colours (accent, primary, secondary, success, warning, error, info), so `hue.yellow` exists only
 * when one of them is yellow. The apple theme has none: its warning colour is orange and means "waits for
 * you". There the yellow is CAUTION_YELLOW, picked by the text colour, since a theme's background can be
 * transparent: light text is drawn on a dark background.
 */
export function cautionYellow(theme: { hue?: Record<string, Record<number, unknown> | undefined>; text?: { base?: unknown } }): unknown {
  const own = theme.hue?.yellow?.[200]
  if (own !== undefined && own !== null) return own
  const { r, g, b } = (theme.text?.base ?? {}) as { r?: unknown; g?: unknown; b?: unknown }
  const known = typeof r === "number" && typeof g === "number" && typeof b === "number"
  const lightText = !known || 0.299 * r + 0.587 * g + 0.114 * b >= 0.5
  return lightText ? CAUTION_YELLOW.dark : CAUTION_YELLOW.light
}

/** The parts of the host theme a model colour is read from. */
export type ModelTheme = {
  hue?: Record<string, Record<number, unknown> | undefined>
  categorical?: (Record<number, unknown> | undefined)[]
  text: { base: unknown }
}

/**
 * The colour of a model label. Haiku is yellow, and the apple theme has no yellow hue: the fourth place of
 * its categorical palette is its warning orange, the colour of "Ti aspetta", so yellow never comes from there.
 */
export function modelColour(key: ModelKey, theme: ModelTheme): unknown {
  const pick = MODEL_HUES[key]
  if (!pick) return theme.text.base
  if (pick.hue === "yellow") return cautionYellow(theme)
  const slot = pick.slot === undefined ? undefined : theme.categorical?.[pick.slot]?.[200]
  return theme.hue?.[pick.hue]?.[200] ?? slot ?? theme.text.base
}

const DEFAULT_TITLE = /^(Child|New) session - /

/** One line, no control characters, no default OpenCode title, at most `max` characters. */
export function displayTitle(title: string | undefined, max: number): string {
  const text = oneLine(title ?? "")
  if (text === "" || DEFAULT_TITLE.test(text)) return "Subagente"
  return fit(text, max) // counts characters, so an emoji is never cut in half
}

/**
 * What an agent is doing, in Italian and without tool names, from one tool call: "legge agents-core.ts",
 * "esegue make", "cerca nei file". Undefined without a tool name.
 */
export function toolDetail(name: string | undefined, input: unknown): string | undefined {
  if (typeof name !== "string" || name === "") return undefined
  const data = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const text = (key: string) => (typeof data[key] === "string" ? (data[key] as string).trim() : "")
  const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? ""
  const onFile = (verb: string) => `${verb} ${base(text("path") || text("filePath")) || "un file"}`
  switch (name) {
    case "shell": {
      // Never the command line itself: it can carry a token or a password. The agent's own short
      // description if there is one, else only the program name, skipping VAR=value prefixes.
      const description = text("description").split("\n")[0].replace(/\s+/g, " ").trim()
      if (description !== "") return description
      const words = text("command").split(/\s+/).filter((word) => word !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
      const program = (words[0] === "sudo" || words[0] === "env" ? words[1] : words[0]) ?? ""
      return `esegue ${base(program) || "un comando"}`
    }
    case "read":
      return onFile("legge")
    case "edit":
      return onFile("modifica")
    case "write":
      return onFile("scrive")
    case "grep":
    case "glob":
      return "cerca nei file" // never the pattern: it can hold a pasted value
    case "websearch":
      return "cerca sul web" // never the query, for the same reason
    case "subagent":
      return text("description") || "avvia un subagente"
    case "webfetch": {
      try {
        return `apre ${new URL(text("url")).host}`
      } catch {
        return "apre una pagina"
      }
    }
    case "skill":
      return `usa la skill ${text("id") || text("name")}`.trimEnd()
    case "execute":
      return "esegue uno script"
    default:
      return "usa uno strumento" // an unknown tool is not named: the name is the host's word, not the owner's
  }
}

export function createRunTracker() {
  const runs = new Map<string, Run>()
  /** Permission and question requests still open, by request key: whose they are and when they were asked. */
  const asks = new Map<string, { sessionID: string; at: number }>()
  /** Latest write wins the place; past MAX_RUNS the least recently written run is dropped. */
  const put = (id: string, run: Run) => {
    runs.delete(id)
    runs.set(id, run)
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value as string) // oldest first
  }
  /** A run that starts or ends has no request open any more, whether or not its answer was seen. */
  const dropAsksOf = (sessionID: string) => {
    for (const [key, ask] of asks) if (ask.sessionID === sessionID) asks.delete(key)
  }
  return {
    started(id: string, at: number) {
      dropAsksOf(id)
      const modelId = runs.get(id)?.modelId
      put(id, modelId === undefined ? { startedAt: at } : { startedAt: at, modelId })
    },
    ended(id: string, outcome: Outcome, at: number) {
      dropAsksOf(id)
      const { tool: _tool, ...rest } = runs.get(id) ?? {}
      put(id, { ...rest, endedAt: at, outcome })
    },
    /** A permission or a question was asked. `requestKey` names the request; asking it again keeps the first time. */
    asked(sessionID: string, requestKey: string, at: number) {
      if (asks.has(requestKey)) return
      asks.set(requestKey, { sessionID, at })
      if (asks.size > MAX_RUNS) asks.delete(asks.keys().next().value as string) // oldest first
    },
    /** The request was answered or withdrawn. */
    answered(requestKey: string) {
      asks.delete(requestKey)
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
      dropAsksOf(id)
      runs.delete(id)
    },
    /** Every run, each with `waitingSince` set to the time of its oldest open request. */
    snapshot(): Record<string, Run> {
      const all: Record<string, Run> = Object.fromEntries(runs)
      for (const ask of asks.values()) {
        const since = all[ask.sessionID]?.waitingSince
        if (since === undefined || ask.at < since) all[ask.sessionID] = { ...all[ask.sessionID], waitingSince: ask.at }
      }
      return all
    },
  }
}

type Entry = { child: ChildInput; run: Run | undefined }

const usableWidth = (width: number): number => (Number.isFinite(width) && width >= 1 ? Math.floor(width) : DEFAULT_WIDTH)

/** What a row shows at this width: the model column goes first, then the time. */
export function rowLayout(width: number): { showModel: boolean; showTime: boolean } {
  const w = usableWidth(width)
  return { showModel: w >= MODEL_MIN_WIDTH, showTime: w >= TIME_MIN_WIDTH }
}

/** The moment a row's time counts from: the end for a finished agent, the request for a waiting one, else the start. */
function timedFrom({ child, run }: Entry, kind: GroupKind): number | undefined {
  if (kind === "done") return run?.endedAt ?? child.updatedAt
  if (kind === "waiting") return run?.waitingSince
  return run?.startedAt ?? child.createdAt
}

function makeRow(entry: Entry, kind: GroupKind, now: number, width: number): ViewRow {
  const { child, run } = entry
  const { showModel, showTime } = rowLayout(width)
  const model = shortModel(run?.modelId ?? child.modelId)
  const failed = kind === "done" && run?.outcome === "error"
  const since = timedFrom(entry, kind)
  const free = width - 2 - (showModel ? MODEL_COLUMN : 0)
  // A wait whose start was not seen (asked before this window opened) shows no time: never a wrong one.
  const wanted = showTime && since !== undefined ? rowTime(now - since, kind) : ""
  const time = free - wanted.length - NAME_GAP >= NAME_MIN ? wanted : ""
  const mark = failed ? "✗ " : undefined
  const lead = `${mark ? "" : "  "}${showModel ? model.label.padEnd(MODEL_COLUMN) : ""}`
  const room = Math.max(1, free - time.length)
  const title = fit(displayTitle(child.title, TITLE_MAX), time === "" ? room : Math.max(1, room - NAME_GAP))
  const name = time === "" ? title : title.padEnd(room)

  let detailText: string | undefined
  if (kind === "waiting") detailText = child.permissionPending ? "chiede un permesso" : "ha una domanda"
  else if (kind === "working") detailText = run?.tool === undefined ? undefined : oneLine(run.tool)
  const indent = showModel ? DETAIL_INDENT : COMPACT_INDENT
  const detailRoom = width - indent.length - 2
  const detail = detailText && detailRoom >= 1 ? `${indent}└ ${fit(detailText, detailRoom)}` : undefined

  return { id: child.id, mark, lead, name, time, detail, failed, modelKey: model.key }
}

const GROUPS: { kind: GroupKind; icon: string; title: string }[] = [
  { kind: "waiting", icon: "!", title: "Ti aspetta" },
  { kind: "working", icon: "", title: "Al lavoro" },
  { kind: "done", icon: "✓", title: "Finiti" },
]

const PANEL_TITLE = "Subagenti"

/** The one fact for the header: how many wait for you, else how many work, else nothing. */
export function headerState(waiting: number, working: number): HeaderState | undefined {
  if (waiting > 0) return { text: waiting === 1 ? "1 ti aspetta" : `${waiting} ti aspettano`, kind: "waiting" }
  if (working > 0) return { text: `${working} al lavoro`, kind: "working" }
  return undefined
}

/**
 * The whole sidebar as data. Order: waiting (longest wait first), working (oldest first), the last
 * MAX_FINISHED finished (newest first). At most MAX_ROWS rows: active rows win, finished fill what is left.
 */
export function buildView(children: ChildInput[], runs: Record<string, Run>, now: number, width: number): View {
  const w = usableWidth(width)
  const entries: Entry[] = children.map((child) => ({ child, run: runs[child.id] }))
  const startOf = (e: Entry) => e.run?.startedAt ?? e.child.createdAt
  const endOf = (e: Entry) => e.run?.endedAt ?? e.child.updatedAt

  const askedAt = (e: Entry) => e.run?.waitingSince ?? startOf(e)
  const waiting = entries.filter((e) => e.child.permissionPending || e.child.formPending).sort((a, b) => askedAt(a) - askedAt(b))
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
    title: fit(g.title, Math.max(1, w - 2)),
    rows: byKind[g.kind].map((e) => makeRow(e, g.kind, now, w)),
  }))

  const title = fit(PANEL_TITLE, w)
  const state = headerState(waiting.length, working.length)
  // The state sits on the right edge, with at least one blank before it, or is left out.
  const showState = state !== undefined && title === PANEL_TITLE && w - title.length >= state.text.length + 1
  const hidden = activeCount - shownActive
  return {
    empty: children.length === 0,
    header: showState ? { title, state: state.text.padStart(w - title.length), stateKind: state.kind } : { title, state: "" },
    groups,
    hidden,
    hiddenText: fit(`+${hidden} altri`, w),
  }
}

export type Scheduler = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

/** How long the panel waits to rebuild after an event, so a burst of events is one rebuild. */
export const REFRESH_BATCH_MS = 100

/**
 * Many `request` calls before the timer fires run `run` once. Events of every session (step starts, tool
 * calls) ask for a rebuild, so a busy subagent would otherwise rebuild the snapshot many times a second.
 */
export function createRefreshBatch(options: { run: () => void; scheduler: Scheduler }) {
  let handle: unknown
  let disposed = false
  return {
    request() {
      if (disposed || handle !== undefined) return
      handle = options.scheduler.set(() => {
        handle = undefined
        options.run()
      }, REFRESH_BATCH_MS)
    },
    /** Final: drops a waiting request, and a request after it sets no timer. */
    dispose() {
      disposed = true
      if (handle !== undefined) options.scheduler.clear(handle)
      handle = undefined
    },
  }
}

/**
 * Turns a stream of measured widths into few updates: the first real size is applied at once, later
 * ones are coalesced to one update per RESIZE_COALESCE_MS, and a size that is already shown does nothing.
 */
export function createWidthTracker(options: {
  initial: number
  onChange: (width: number) => void
  scheduler?: Scheduler
}) {
  const scheduler: Scheduler = options.scheduler ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  let shown = options.initial
  let latest = options.initial
  let measured = false
  let handle: unknown
  let disposed = false
  const flush = () => {
    handle = undefined
    if (latest !== shown) {
      shown = latest
      options.onChange(latest)
    }
  }
  return {
    report(raw: number) {
      if (disposed || !Number.isFinite(raw) || raw <= 0) return
      const next = Math.floor(raw)
      if (measured && next === latest) return
      latest = next
      if (!measured) {
        measured = true
        if (handle !== undefined) scheduler.clear(handle)
        flush()
        return
      }
      if (handle === undefined) handle = scheduler.set(flush, RESIZE_COALESCE_MS)
    },
    dispose() {
      disposed = true
      if (handle !== undefined) scheduler.clear(handle)
      handle = undefined
    },
  }
}
