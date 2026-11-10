// Pure logic for the claude-usage plugin: parsing, formatting, thresholds, back-off and the
// polling state machine. No I/O here: the keychain, the network, the clock and the cache file
// are all injected, so every rule below is testable without a token.

export const POLL_INTERVAL_MS = 5 * 60_000
export const MAX_BACKOFF_MS = 60 * 60_000
export const MIN_MANUAL_GAP_MS = 30_000
export const WEEKLY_THRESHOLD_PERCENT = 90 // red and a toast above this weekly percentage
export const FABLE_WARN_PERCENT = 50 // the Fable meter turns yellow from here
export const FABLE_STOP_PERCENT = 80 // red and a toast from here: agents must stop using Fable

export type UsageWindow = { percent: number; resetsAt: number | null }
export type UsageSnapshot = {
  fetchedAt: number
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  // The separate weekly Fable limit (Max and Ultra plans). null = not reported, never an error.
  fable: UsageWindow | null
}

export type FailureKind =
  | "no-login" // keychain item missing or unreadable
  | "login-expired" // access token expired; we never refresh it
  | "rate-limited" // HTTP 429
  | "http" // any other non-2xx
  | "timeout"
  | "network"
  | "bad-response"

export type Failure = { kind: FailureKind; status?: number; retryAfterMs?: number }

export type Credentials =
  | { ok: true; token: string }
  | { ok: false; kind: "no-login" | "login-expired" }

// --- credentials ---------------------------------------------------------------------------

// `raw` is the keychain item (JSON). The token goes back to the caller and nowhere else.
export function parseCredentials(raw: string, now: number): Credentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, kind: "no-login" }
  }
  const oauth = (parsed as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null)
    ?.claudeAiOauth
  const token = oauth?.accessToken
  if (typeof token !== "string" || token.length === 0) return { ok: false, kind: "no-login" }
  const expiresAt = oauth?.expiresAt
  if (typeof expiresAt === "number" && expiresAt <= now) return { ok: false, kind: "login-expired" }
  return { ok: true, token }
}

// --- usage response ------------------------------------------------------------------------

function toWindow(raw: unknown): UsageWindow | null {
  if (typeof raw !== "object" || raw === null) return null
  const { utilization, resets_at } = raw as { utilization?: unknown; resets_at?: unknown }
  return makeWindow(utilization, resets_at)
}

function makeWindow(utilization: unknown, resets_at: unknown): UsageWindow | null {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null
  let resetsAt: number | null = null
  if (typeof resets_at === "string") {
    const time = Date.parse(resets_at)
    resetsAt = Number.isNaN(time) ? null : time
  } else if (typeof resets_at === "number" && Number.isFinite(resets_at)) {
    resetsAt = resets_at < 1e11 ? resets_at * 1000 : resets_at // seconds or milliseconds
  }
  return { percent: Math.max(0, utilization), resetsAt }
}

// The Fable weekly limit is an entry of `limits` (undocumented):
//   { kind: "weekly_scoped", percent: 2, resets_at: "...", scope: { model: { display_name: "Fable" } } }
// `percent` is the share of the Fable limit itself (0 to 100), not of the whole week.
// If several valid Fable entries exist, the one with the highest percent wins.
function parseFable(limits: unknown): UsageWindow | null {
  if (!Array.isArray(limits)) return null
  let best: UsageWindow | null = null
  for (const entry of limits) {
    if (typeof entry !== "object" || entry === null) continue
    const { kind, percent, resets_at, scope } = entry as {
      kind?: unknown
      percent?: unknown
      resets_at?: unknown
      scope?: { model?: { display_name?: unknown } | null } | null
    }
    const name = scope?.model?.display_name
    if (kind !== "weekly_scoped" || typeof name !== "string" || name.trim().toLowerCase() !== "fable") continue
    const window = makeWindow(percent, resets_at)
    if (window && (best === null || window.percent > best.percent)) best = window
  }
  return best
}

// Response of GET /api/oauth/usage (undocumented). Returns null when neither window is present.
export function parseUsage(body: unknown, now: number): UsageSnapshot | null {
  if (typeof body !== "object" || body === null) return null
  const { five_hour, seven_day, limits } = body as { five_hour?: unknown; seven_day?: unknown; limits?: unknown }
  const fiveHour = toWindow(five_hour)
  const sevenDay = toWindow(seven_day)
  if (!fiveHour && !sevenDay) return null
  return { fetchedAt: now, fiveHour, sevenDay, fable: parseFable(limits) }
}

// --- thresholds and formatting -------------------------------------------------------------

export function weeklyOverThreshold(snapshot: UsageSnapshot | null): boolean {
  return (snapshot?.sevenDay?.percent ?? 0) > WEEKLY_THRESHOLD_PERCENT
}

// From 80% the agents must stop using Fable.
export function fableOverThreshold(snapshot: UsageSnapshot | null): boolean {
  return (snapshot?.fable?.percent ?? 0) >= FABLE_STOP_PERCENT
}

/** True when the numbers were fetched at or after `startedAt`, not just read from the cache file. */
export function isFreshSnapshot(snapshot: UsageSnapshot | null, startedAt: number): boolean {
  return snapshot !== null && snapshot.fetchedAt >= startedAt
}

export const FABLE_TOAST = `Fable all'${FABLE_STOP_PERCENT}% settimanale: niente più Fable per gli agenti`

/**
 * Says true once each time Fable goes from under the stop line to over it, and again only after it
 * has gone back under (a new week). Starts as "under", so a first reading already over also fires once.
 * A reading with no Fable entry says nothing and keeps what it knew, so a poll that lacks the entry
 * does not make the next one look like a new crossing.
 */
export function createFableWatch() {
  let wasOver = false
  return (snapshot: UsageSnapshot | null): boolean => {
    if (snapshot?.fable == null) return false
    const over = fableOverThreshold(snapshot)
    const crossed = over && !wasOver
    wasOver = over
    return crossed
  }
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function formatClock(at: number): string {
  const date = new Date(at)
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  return `${DAYS[date.getDay()]} ${hh}:${mm}`
}

export function formatReset(window: UsageWindow, now: number): string {
  if (window.resetsAt === null) return "reset unknown"
  if (window.resetsAt <= now) return "resetting"
  return `resets in ${formatDuration(window.resetsAt - now)} (${formatClock(window.resetsAt)})`
}

export function formatWindowLine(label: string, window: UsageWindow | null, now: number): string {
  if (!window) return `${label}: none reported`
  return `${label}: ${formatPercent(window.percent)}, ${formatReset(window, now)}`
}

// One line for a footer.
export function formatShort(snapshot: UsageSnapshot | null): string {
  if (!snapshot) return "usage unavailable"
  const five = snapshot.fiveHour ? `5h ${formatPercent(snapshot.fiveHour.percent)}` : "5h n/a"
  const week = snapshot.sevenDay ? `wk ${formatPercent(snapshot.sevenDay.percent)}` : "wk n/a"
  const warning = weeklyOverThreshold(snapshot) ? `  WEEKLY OVER ${WEEKLY_THRESHOLD_PERCENT}%` : ""
  return `${five}  ${week}${warning}`
}

// What the footer shows for the current monitor state.
export function formatFooter(state: MonitorState): string {
  if (state.failure?.kind === "login-expired") return "login expired, run claude"
  if (!state.snapshot) return "usage unavailable"
  return `${formatShort(state.snapshot)}${state.failure ? " (stale)" : ""}`
}

export function failureMessage(failure: Failure): string {
  switch (failure.kind) {
    case "no-login":
      return "usage unavailable: no Claude login found, run claude"
    case "login-expired":
      return "login expired, run claude"
    case "rate-limited":
      return "usage unavailable: rate limited, backing off"
    case "http":
      return `usage unavailable: http ${failure.status ?? "error"}`
    case "timeout":
      return "usage unavailable: timeout"
    case "network":
      return "usage unavailable: network error"
    case "bad-response":
      return "usage unavailable: unexpected response"
  }
}

// Multi-line text for the /claude-usage command.
export function formatDetail(state: MonitorState, now: number): string {
  const lines: string[] = []
  if (state.snapshot) {
    lines.push(formatWindowLine("5-hour window", state.snapshot.fiveHour, now))
    lines.push(formatWindowLine("Weekly window", state.snapshot.sevenDay, now))
    lines.push(`Updated ${formatDuration(now - state.snapshot.fetchedAt)} ago`)
    if (weeklyOverThreshold(state.snapshot)) {
      lines.push(
        `Weekly usage is above ${WEEKLY_THRESHOLD_PERCENT}%: you are inside your 10% reserve.`,
      )
    }
  } else {
    lines.push("usage unavailable")
  }
  if (state.failure) {
    lines.push(`Last refresh failed: ${failureMessage(state.failure)}`)
    if (state.nextAllowedAt > now) {
      lines.push(`Next attempt in ${formatDuration(state.nextAllowedAt - now)}`)
    }
  }
  return lines.join("\n")
}

// --- redaction -----------------------------------------------------------------------------

// Defence in depth: nothing in this plugin prints a response body or a token, but anything
// that reaches a log or a toast goes through here first.
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]")
  }
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 200)
}

// --- back-off ------------------------------------------------------------------------------

export function nextDelay(consecutiveFailures: number, retryAfterMs?: number): number {
  if (consecutiveFailures <= 0) return POLL_INTERVAL_MS
  const exponential = Math.min(POLL_INTERVAL_MS * 2 ** consecutiveFailures, MAX_BACKOFF_MS)
  if (retryAfterMs === undefined) return exponential
  return Math.min(Math.max(retryAfterMs, POLL_INTERVAL_MS), MAX_BACKOFF_MS)
}

// --- cache (numbers only) --------------------------------------------------------------------

export type CacheFile = { version: 1; snapshot: UsageSnapshot | null; nextAllowedAt: number }

function validWindow(raw: unknown): UsageWindow | null {
  if (typeof raw !== "object" || raw === null) return null
  const { percent, resetsAt } = raw as { percent?: unknown; resetsAt?: unknown }
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null
  if (resetsAt !== null && (typeof resetsAt !== "number" || !Number.isFinite(resetsAt))) return null
  return { percent, resetsAt: resetsAt as number | null }
}

export function serializeCache(state: Pick<MonitorState, "snapshot" | "nextAllowedAt">): string {
  const file: CacheFile = { version: 1, snapshot: state.snapshot, nextAllowedAt: state.nextAllowedAt }
  return JSON.stringify(file)
}

export function parseCache(text: string): CacheFile | null {
  try {
    const raw = JSON.parse(text) as { version?: unknown; snapshot?: unknown; nextAllowedAt?: unknown }
    if (raw.version !== 1) return null
    const nextAllowedAt = typeof raw.nextAllowedAt === "number" ? raw.nextAllowedAt : 0
    if (raw.snapshot === null) return { version: 1, snapshot: null, nextAllowedAt }
    const snap = raw.snapshot as { fetchedAt?: unknown; fiveHour?: unknown; sevenDay?: unknown; fable?: unknown }
    if (typeof snap?.fetchedAt !== "number") return null
    return {
      version: 1,
      snapshot: {
        fetchedAt: snap.fetchedAt,
        fiveHour: validWindow(snap.fiveHour),
        sevenDay: validWindow(snap.sevenDay),
        fable: validWindow(snap.fable), // old cache files have no fable field: null
      },
      nextAllowedAt,
    }
  } catch {
    return null
  }
}

// --- monitor (state machine) -----------------------------------------------------------------

export type MonitorState = {
  snapshot: UsageSnapshot | null
  failure: Failure | null
  consecutiveFailures: number
  nextAllowedAt: number // no network attempt before this time
}

export type FetchResult =
  | { ok: true; body: unknown }
  | { ok: false; failure: Failure }

export type MonitorDeps = {
  now: () => number
  // Reads the keychain item fresh; the monitor never keeps what it returns.
  readCredentials: () => Promise<Credentials>
  // Performs the single GET. Gets the token for the duration of the call only.
  fetchUsage: (token: string) => Promise<FetchResult>
  loadCache: () => Promise<CacheFile | null>
  saveCache: (state: MonitorState) => Promise<void>
}

export type RefreshOutcome = "refreshed" | "failed" | "skipped"

export function createUsageMonitor(deps: MonitorDeps) {
  let state: MonitorState = { snapshot: null, failure: null, consecutiveFailures: 0, nextAllowedAt: 0 }
  let inFlight: Promise<RefreshOutcome> | null = null
  let lastAttemptAt = 0
  const listeners = new Set<(state: MonitorState) => void>()

  const publish = (next: MonitorState) => {
    state = next
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // a broken listener must not break the monitor
      }
    }
  }

  const fail = (failure: Failure): RefreshOutcome => {
    const consecutiveFailures = state.consecutiveFailures + 1
    const delay = nextDelay(consecutiveFailures, failure.retryAfterMs)
    publish({ ...state, failure, consecutiveFailures, nextAllowedAt: deps.now() + delay })
    return "failed"
  }

  const attempt = async (): Promise<RefreshOutcome> => {
    lastAttemptAt = deps.now()
    try {
      const credentials = await deps.readCredentials()
      if (!credentials.ok) {
        // A local check, not a network failure: retry at the normal interval, no back-off, so the
        // footer recovers within 5 minutes after Claude Code refreshes its login.
        publish({ ...state, failure: { kind: credentials.kind }, nextAllowedAt: deps.now() + POLL_INTERVAL_MS })
        return "failed"
      }
      const result = await deps.fetchUsage(credentials.token)
      if (!result.ok) return fail(result.failure)
      const snapshot = parseUsage(result.body, deps.now())
      if (!snapshot) return fail({ kind: "bad-response" })
      publish({ snapshot, failure: null, consecutiveFailures: 0, nextAllowedAt: deps.now() + POLL_INTERVAL_MS })
      return "refreshed"
    } catch {
      return fail({ kind: "network" })
    } finally {
      try {
        await deps.saveCache(state)
      } catch {
        // cache is best effort
      }
    }
  }

  return {
    get state(): MonitorState {
      return state
    },
    subscribe(listener: (state: MonitorState) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // Loads cached numbers so the footer shows something right away. Does no network call.
    async hydrate(): Promise<void> {
      try {
        const cache = await deps.loadCache()
        if (cache && !state.snapshot) {
          publish({ ...state, snapshot: cache.snapshot, nextAllowedAt: Math.max(state.nextAllowedAt, Math.min(cache.nextAllowedAt, deps.now() + MAX_BACKOFF_MS)) })
        }
      } catch {
        // ignore
      }
    },
    // Called by the timer (manual = false) and by the command (manual = true).
    async refresh(manual = false): Promise<RefreshOutcome> {
      if (inFlight) return inFlight
      const now = deps.now()
      if (now < state.nextAllowedAt) {
        // The timer always waits for the back-off. A command may go earlier, but never during
        // a 429 back-off and never twice within the minimum gap.
        const rateLimited = state.failure?.kind === "rate-limited"
        const tooSoon = now - lastAttemptAt < MIN_MANUAL_GAP_MS
        if (!manual || rateLimited || tooSoon) return "skipped"
      }
      inFlight = attempt().finally(() => {
        inFlight = null
      })
      return inFlight
    },
  }
}

// --- look (used by the TUI) ------------------------------------------------------------------

export type Level = "ok" | "warn" | "high"

// Green under 70%, yellow from 70%, red above the reserve line.
export function usageLevel(percent: number): Level {
  if (percent > WEEKLY_THRESHOLD_PERCENT) return "high"
  if (percent >= 70) return "warn"
  return "ok"
}

// Fable has its own lines: green under 50%, yellow from 50%, red from 80%.
export function fableLevel(percent: number): Level {
  if (percent >= FABLE_STOP_PERCENT) return "high"
  if (percent >= FABLE_WARN_PERCENT) return "warn"
  return "ok"
}

// A bar of `cells` cells: how many are filled and how many are empty.
export function meter(percent: number, cells: number): { filled: string; empty: string } {
  const clamped = Math.min(100, Math.max(0, percent))
  const full = Math.round((clamped / 100) * cells)
  return { filled: "▰".repeat(full), empty: "▱".repeat(cells - full) }
}

const GIORNI = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"]

function durataIt(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days} g ${hours % 24} h` : `${days} g`
}

// "si azzera tra 1 h 9 min, mar 01:00"
export function resetIt(window: UsageWindow, now: number): string {
  if (window.resetsAt === null) return "azzeramento non indicato"
  if (window.resetsAt <= now) return "si sta azzerando"
  const d = new Date(window.resetsAt)
  const clock = `${GIORNI[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  return `si azzera tra ${durataIt(window.resetsAt - now)}, ${clock}`
}

export function updatedIt(fetchedAt: number, now: number): string {
  const ms = now - fetchedAt
  return ms < 60_000 ? "aggiornato adesso" : `aggiornato ${durataIt(ms)} fa`
}

// Italian one-liner for a failure, shown in the footer and the dialog.
export function failureIt(failure: Failure): string {
  switch (failure.kind) {
    case "no-login":
    case "login-expired":
      return "accesso scaduto, apri claude"
    case "rate-limited":
      return "troppe richieste, riprovo tra poco"
    case "timeout":
    case "network":
      return "rete non raggiungibile"
    default:
      return "dati non disponibili"
  }
}

// --- size (used by the TUI) ----------------------------------------------------------------

export const FOOTER_MAX_CELLS = 6
export const DIALOG_MAX_CELLS = 20
const DIALOG_MIN_CELLS = 5
const DIALOG_LABEL_WIDTH = 11
const DIALOG_RESERVED = DIALOG_LABEL_WIDTH + 6 // label, then "  " and a 4 character percentage
const STALE_MARKER = "  (vecchio)"
export const RESIZE_COALESCE_MS = 50

export type FooterPart = {
  window: "five" | "week" | "fable"
  label: "5h" | "sett" | "fable"
  percent: number | null
  cells: number
}
// `icon` is set only for the one-character fallback: its colour (a level, or "faint" when the numbers
// are old or there is nothing to judge).
export type IconTone = Level | "faint"
export type FooterLayout = { parts: FooterPart[]; gap: number; marker: boolean; width: number; icon?: IconTone }

export const FOOTER_ICON = "◉"

const partText = (part: FooterPart): string => {
  if (part.percent === null) return `${part.label} libero`
  const bar = meter(part.percent, part.cells)
  return `${part.label} ${bar.filled}${bar.empty} ${formatPercent(part.percent)}`
}

/** The footer as one plain string; the TUI draws the same pieces with colours. */
export function footerText(layout: FooterLayout): string {
  if (layout.icon !== undefined) return FOOTER_ICON
  return layout.parts.map(partText).join(" ".repeat(layout.gap)) + (layout.marker ? STALE_MARKER : "")
}

// `fable` is optional: absent or null means the plan reports no Fable limit, and the meter is not drawn.
// `five` null means the plan reports no 5-hour window: it is not drawn either. `week` null still says "libero".
type FooterInput = { five: number | null; week: number | null; stale: boolean; fable?: number | null }

function build(input: FooterInput, cells: number, gap: number, marker: boolean): FooterLayout {
  const parts: FooterPart[] = []
  // No 5-hour window reported (Ultra never has one): the meter is not drawn, not shown as "libero".
  if (input.five !== null) parts.push({ window: "five", label: "5h", percent: input.five, cells })
  parts.push({ window: "week", label: "sett", percent: input.week, cells })
  if (input.fable != null) parts.push({ window: "fable", label: "fable", percent: input.fable, cells })
  const layout: FooterLayout = { parts, gap, marker: marker && input.stale, width: 0 }
  layout.width = footerText(layout).length
  return layout
}

const SEVERITY: Record<Level, number> = { ok: 0, warn: 1, high: 2 }

/**
 * The colour of the one-character icon: the worst level among the windows that are shown (red beats
 * yellow beats green, each window by its own thresholds, Fable included). Old numbers (stale) and no
 * numbers at all give "faint": the icon then says "there is something here, but do not trust it".
 */
export function iconTone(input: FooterInput): IconTone {
  if (input.stale) return "faint"
  const levels: Level[] = []
  if (input.five !== null) levels.push(usageLevel(input.five))
  if (input.week !== null) levels.push(usageLevel(input.week))
  if (input.fable != null) levels.push(fableLevel(input.fable))
  if (levels.length === 0) return "faint"
  return levels.reduce((worst, level) => (SEVERITY[level] > SEVERITY[worst] ? level : worst))
}

/**
 * The footer item for `budget` columns. It tries, in order: full bars with the old marker, full bars,
 * then bars of 5, 4 and 3 cells, always with every window that is reported (Fable included); when even
 * the shortest bars do not fit, a single "◉" coloured by the worst level (see iconTone), and with
 * a budget under 1, nothing (null). The icon is clickable like the bars, so the numbers are one click
 * away. It never returns something wider than the budget, and a smaller budget never gives a wider one.
 */
export function footerLayout(input: FooterInput, budget: number): FooterLayout | null {
  const room = Number.isNaN(budget) ? Infinity : budget
  const attempts: [number, number, boolean][] = [
    [FOOTER_MAX_CELLS, 3, true],
    [FOOTER_MAX_CELLS, 3, false],
    [5, 2, false],
    [4, 2, false],
    [3, 2, false],
  ]
  for (const [cells, gap, marker] of attempts) {
    const layout = build(input, cells, gap, marker)
    if (layout.width <= room) return layout
  }
  const icon: FooterLayout = { parts: [], gap: 0, marker: false, width: FOOTER_ICON.length, icon: iconTone(input) }
  return icon.width <= room ? icon : null
}

export type MousePoint = { button?: number; x?: number; y?: number }

/**
 * Turns a mouse press and release on the footer into one click. The press arms it and the release fires
 * it, only for the main (left) button and only on the same cell: a release that did not start on the
 * footer (a drag from elsewhere), a drag across the footer text (a text selection), or another button
 * does nothing. A missing position counts as the same cell.
 */
export function createClickGate(onClick: () => void) {
  let armed: MousePoint | null = null
  const left = (point: MousePoint) => (point.button ?? 0) === 0
  return {
    down(point: MousePoint = {}) {
      armed = left(point) ? point : null
    },
    up(point: MousePoint = {}) {
      const start = armed
      armed = null
      if (!start || !left(point)) return
      if (start.x !== point.x || start.y !== point.y) return
      onClick()
    },
    cancel() {
      armed = null
    },
  }
}

/** Bar length and label width for a dialog whose usable width is `width`. */
export function dialogLayout(width: number): { cells: number; labelWidth: number } {
  const cells = Math.min(DIALOG_MAX_CELLS, Math.max(DIALOG_MIN_CELLS, Math.floor(width) - DIALOG_RESERVED))
  return { cells, labelWidth: DIALOG_LABEL_WIDTH }
}

/** Cuts text to `width` characters (not UTF-16 units), ending with "…" when it was longer. */
export function fitText(text: string, width: number): string {
  if (width <= 0) return ""
  const chars = [...text]
  if (chars.length <= width) return text
  return `${chars.slice(0, width - 1).join("")}…`
}

export type Scheduler = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

/**
 * Turns a stream of measured widths into few updates: the first real size is applied at once, later
 * ones are coalesced to one update per `delayMs`, and a size that is already shown does nothing.
 */
export function createWidthTracker(options: {
  initial: number
  onChange: (width: number) => void
  delayMs?: number
  scheduler?: Scheduler
}) {
  const delay = options.delayMs ?? RESIZE_COALESCE_MS
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
      if (handle === undefined) handle = scheduler.set(flush, delay)
    },
    dispose() {
      disposed = true
      if (handle !== undefined) scheduler.clear(handle)
      handle = undefined
    },
  }
}

/**
 * Columns my footer item may use: its own width plus what the flexible neighbour (the path) has above
 * `reserve`. Undefined when there is no such neighbour to measure. At least 1.
 */
export function rowBudget(ownWidth: number, neighbourWidth: number | undefined, reserve: number): number | undefined {
  if (neighbourWidth === undefined) return undefined
  return Math.max(1, Math.floor(ownWidth + neighbourWidth - reserve))
}

const MESSAGES = {
  login: ["Claude: accesso scaduto, apri claude", "Claude: accesso scaduto", "accesso scaduto"],
  waiting: ["Claude: in attesa dei dati", "Claude: in attesa", "in attesa"],
  unavailable: ["Claude: uso non disponibile", "Claude: non disponibile", "non disponibile"],
} as const

/** A status line for the footer: the longest wording that fits, or null when none does. */
export function footerMessage(kind: keyof typeof MESSAGES, budget: number): string | null {
  const room = Number.isNaN(budget) ? Infinity : budget
  return MESSAGES[kind].find((text) => text.length <= room) ?? null
}

/** The reset line for `width` columns: whole, then without the clock, then without "si azzera", then cut. */
export function resetFit(window: UsageWindow, now: number, width: number): string {
  const full = resetIt(window, now)
  if (full.length <= width) return full
  const noClock = full.replace(/, [a-z]{3} \d\d:\d\d$/, "")
  if (noClock.length <= width) return noClock
  return fitText(noClock.replace(/^si azzera /, ""), width)
}
