export type ThroughputMeasurement = {
  timestamp: number
  sessionID: string
  messageID: string
  providerID: string
  modelID: string
  outputTokens: number
  timeToFirstTokenMs: number
  generationMs: number
  tokensPerSecond: number
}

type TextDelta = {
  sessionID: string
  messageID: string
  partID: string
  delta: string
  at: number
}

type CompletedMessage = {
  sessionID: string
  messageID: string
  createdAt: number
  outputTokens: number
  providerID: string
  modelID: string
}

export function createThroughputCollector() {
  const messages = new Map<string, { parts: Set<string>; firstDeltaAt?: number; lastDeltaAt?: number }>()

  function recordTextDelta(input: TextDelta) {
    if (!input.delta) return

    const key = `${input.sessionID}:${input.messageID}`
    const message = messages.get(key) ?? { parts: new Set<string>() }
    message.parts.add(input.partID)
    message.firstDeltaAt ??= input.at
    message.lastDeltaAt = input.at
    messages.set(key, message)
  }

  function completeMessage(input: CompletedMessage): ThroughputMeasurement | undefined {
    const key = `${input.sessionID}:${input.messageID}`
    const message = messages.get(key)
    messages.delete(key)

    if (!message || message.parts.size !== 1 || !message.firstDeltaAt || !message.lastDeltaAt || input.outputTokens <= 0) return

    const generationMs = message.lastDeltaAt - message.firstDeltaAt
    if (generationMs <= 0) return

    return {
      timestamp: message.lastDeltaAt,
      sessionID: input.sessionID,
      messageID: input.messageID,
      providerID: input.providerID,
      modelID: input.modelID,
      outputTokens: input.outputTokens,
      timeToFirstTokenMs: message.firstDeltaAt - input.createdAt,
      generationMs,
      tokensPerSecond: (input.outputTokens * 1_000) / generationMs,
    }
  }

  return { recordTextDelta, completeMessage }
}

// ---- V2 additions -----------------------------------------------------------------------------
// OpenCode 2 reports a reply as events: session.step.started, session.text.delta (one per streamed
// chunk), session.step.ended (with the token counts). The collector above is unchanged; this tracker
// feeds it from those events.

type StepStart = { sessionID: string; messageID: string; startedAt: number; providerID: string; modelID: string }

export function createRateTracker() {
  const collector = createThroughputCollector()
  const steps = new Map<string, StepStart>()
  const key = (sessionID: string, messageID: string) => `${sessionID}:${messageID}`

  return {
    stepStarted(input: StepStart) {
      steps.set(key(input.sessionID, input.messageID), input)
    },
    textDelta(input: { sessionID: string; messageID: string; ordinal: number; at: number }) {
      collector.recordTextDelta({
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: String(input.ordinal),
        delta: "x", // the collector only needs to know a chunk arrived
        at: input.at,
      })
    },
    stepEnded(input: { sessionID: string; messageID: string; outputTokens: number }): ThroughputMeasurement | undefined {
      const k = key(input.sessionID, input.messageID)
      const step = steps.get(k)
      steps.delete(k)
      const measurement = collector.completeMessage({
        sessionID: input.sessionID,
        messageID: input.messageID,
        createdAt: step?.startedAt ?? 0,
        outputTokens: input.outputTokens,
        providerID: step?.providerID ?? "",
        modelID: step?.modelID ?? "",
      })
      return step ? measurement : undefined
    },
    stepFailed(input: { sessionID: string; messageID: string }) {
      steps.delete(key(input.sessionID, input.messageID))
      // completing with no tokens drops the collected deltas without producing a measurement
      collector.completeMessage({
        sessionID: input.sessionID,
        messageID: input.messageID,
        createdAt: 0,
        outputTokens: 0,
        providerID: "",
        modelID: "",
      })
    },
  }
}

/** "42 tok/s" from 10 up, "9.9 tok/s" below; undefined when the value is not a usable rate. */
export function formatRate(tokensPerSecond: number): string | undefined {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return undefined
  return tokensPerSecond >= 10 ? `${Math.round(tokensPerSecond)} tok/s` : `${tokensPerSecond.toFixed(1)} tok/s`
}

/** The rate of the session being looked at, else the latest measured anywhere. */
export function pickRate(
  bySession: Record<string, number>,
  viewedSessionID: string | undefined,
  latest: number | undefined,
): number | undefined {
  if (viewedSessionID !== undefined && bySession[viewedSessionID] !== undefined) return bySession[viewedSessionID]
  return latest
}

/** Drops a message that was logged twice (two open windows); keeps the first and the order. */
export function dedupeMeasurements(measurements: ThroughputMeasurement[]): ThroughputMeasurement[] {
  const seen = new Set<string>()
  return measurements.filter((measurement) => {
    const id = `${measurement.sessionID}:${measurement.messageID}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** Summary of the last `count` measurements in the log; a message logged twice counts once. */
export function summarize(measurements: ThroughputMeasurement[], count: number) {
  const recent = dedupeMeasurements(measurements).slice(-count)
  if (!recent.length) return undefined
  const rates = recent.map((measurement) => measurement.tokensPerSecond)
  return {
    latest: recent.at(-1)!,
    sampleSize: recent.length,
    averageTokensPerSecond: rates.reduce((total, rate) => total + rate, 0) / rates.length,
    minimumTokensPerSecond: Math.min(...rates),
    maximumTokensPerSecond: Math.max(...rates),
  }
}

// ---- Redesign: sparkline, colour rule, live rate, dialog rows, Italian numbers ----------------------
// Everything below is pure (no clock, no disk, no UI) so it can be tested.

/** A reply shorter than this is a burst (the whole text arrived at once): its rate means nothing. */
export const MIN_GENERATION_MS = 250
/** The footer draws this many replies. */
export const FOOTER_REPLIES = 6
/** The dialog draws this many replies per model. */
export const DIALOG_REPLIES = 20
export const MAX_MODEL_ROWS = 5
export const SESSION_ROWS = 5
/** Slower than this share of the model's own median counts as slow. */
export const SLOW_SHARE = 0.6
/** Fewer earlier replies than this and there is no fair median to compare with. */
export const MIN_BASELINE = 5
const BASELINE_REPLIES = 20
const LIVE_INTERVAL_MS = 500
const CHARS_PER_TOKEN = 4

export function isUsableMeasurement(measurement: ThroughputMeasurement): boolean {
  return (
    measurement.generationMs >= MIN_GENERATION_MS &&
    Number.isFinite(measurement.tokensPerSecond) &&
    measurement.tokensPerSecond > 0
  )
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const BLOCKS = "▁▂▃▄▅▆▇█"

/** One block per value, scaled between the lowest and the highest of the last `cells` values. */
export function sparkline(values: number[], cells = values.length): string {
  const window = values.filter((value) => Number.isFinite(value)).slice(-cells)
  if (!window.length) return ""
  const low = Math.min(...window)
  const high = Math.max(...window)
  if (high === low) return "▄".repeat(window.length)
  return window.map((value) => BLOCKS[Math.round(((value - low) / (high - low)) * (BLOCKS.length - 1))]).join("")
}

/** "slow" when the rate is under 60% of the median of the model's earlier replies, else "normal". */
export function speedTone(rate: number, earlierRates: number[]): "slow" | "normal" {
  if (earlierRates.length < MIN_BASELINE) return "normal"
  const typical = median(earlierRates)!
  return rate < typical * SLOW_SHARE ? "slow" : "normal"
}

/** The model's earlier usable replies (the reply itself left out), as rates, newest last. */
function earlierRates(all: ThroughputMeasurement[], reply: ThroughputMeasurement): number[] {
  return dedupeMeasurements(all)
    .filter(
      (other) =>
        isUsableMeasurement(other) &&
        other.modelID === reply.modelID &&
        !(other.sessionID === reply.sessionID && other.messageID === reply.messageID),
    )
    .slice(-BASELINE_REPLIES)
    .map((other) => other.tokensPerSecond)
}

// ---- Italian numbers and times ----

export function formatNumberIt(value: number, decimals: number): string {
  return value.toFixed(decimals).replace(".", ",")
}

/** "42 tok/s", "9,9 tok/s"; undefined when the value is not a usable rate. */
export function formatRateIt(tokensPerSecond: number): string | undefined {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return undefined
  const oneDecimal = Math.round(tokensPerSecond * 10) / 10
  return oneDecimal >= 10 ? `${Math.round(tokensPerSecond)} tok/s` : `${formatNumberIt(oneDecimal, 1)} tok/s`
}

/** "2,2 s", "12 s", "1 min 5 s". */
export function formatSecondsIt(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined
  const tenths = Math.round(ms / 100) / 10
  if (tenths < 10) return `${formatNumberIt(tenths, 1)} s`
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds} s`
  const rest = seconds % 60
  return `${Math.floor(seconds / 60)} min${rest ? ` ${rest} s` : ""}`
}

// ---- Live rate while a reply streams ----

// Quadrant blocks: SF Mono and Menlo have them, they have no braille patterns.
const SPINNER = ["▘", "▝", "▗", "▖"]

export function spinnerFrame(frame: number): string {
  return SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length]!
}

export type LiveSample = { rate: number; frame: number }

/**
 * Estimates the rate of a reply that is still streaming from the text length (4 characters per
 * token) and hands out a new sample at most every 500 ms, never before 250 ms of streaming.
 * The settled figure comes from the real token count when the reply ends.
 */
export function createLiveRate(options: { intervalMs?: number; minMs?: number } = {}) {
  const intervalMs = options.intervalMs ?? LIVE_INTERVAL_MS
  const minMs = options.minMs ?? MIN_GENERATION_MS
  const replies = new Map<string, { firstAt: number; chars: number; lastSampleAt?: number; samples: number }>()
  const key = (sessionID: string, messageID: string) => `${sessionID}:${messageID}`

  return {
    delta(input: { sessionID: string; messageID: string; chars: number; at: number }): LiveSample | undefined {
      if (!(input.chars > 0)) return undefined
      const k = key(input.sessionID, input.messageID)
      const reply = replies.get(k) ?? { firstAt: input.at, chars: 0, samples: 0 }
      reply.chars += input.chars
      replies.set(k, reply)

      const elapsed = input.at - reply.firstAt
      if (elapsed < minMs) return undefined
      if (reply.lastSampleAt !== undefined && input.at - reply.lastSampleAt < intervalMs) return undefined
      reply.lastSampleAt = input.at
      return { rate: (reply.chars / CHARS_PER_TOKEN) * 1_000 / elapsed, frame: reply.samples++ }
    },
    end(input: { sessionID: string; messageID: string }) {
      replies.delete(key(input.sessionID, input.messageID))
    },
    /** A whole execution ended (done, failed or interrupted): forget every reply of that session. */
    endSession(sessionID: string) {
      const prefix = `${sessionID}:`
      for (const k of [...replies.keys()]) if (k.startsWith(prefix)) replies.delete(k)
    },
  }
}

// ---- Models ----

const FAMILIES = ["Opus", "Sonnet", "Haiku", "Fable"]
const SHORT_ID_CELLS = 16

/** Opus, Sonnet, Haiku, Fable by name, else the model id without its path, cut to 16 cells. */
export function modelLabel(modelID: string): string {
  const lower = modelID.toLowerCase()
  const family = FAMILIES.find((name) => lower.includes(name.toLowerCase()))
  if (family) return family
  const id = modelID.split("/").at(-1) ?? ""
  if (!id) return "modello"
  return id.length > SHORT_ID_CELLS ? `${id.slice(0, SHORT_ID_CELLS - 1)}…` : id
}

// ---- Footer ----

export type FooterView = { lead: string; rateText: string; tone: "slow" | "normal"; live: boolean }

/**
 * What the footer shows: the sparkline of the last 6 replies of the viewed session (else of the
 * latest anywhere) and the last rate, or the spinner and the live rate while a reply streams.
 * `recent` is what this run measured; `seed` is the log, used only for the model's median.
 */
export function buildFooterView(input: {
  recent: ThroughputMeasurement[]
  seed: ThroughputMeasurement[]
  viewedSessionID: string | undefined
  live?: LiveSample
}): FooterView | undefined {
  const liveText = input.live ? formatRateIt(input.live.rate) : undefined
  if (input.live && liveText) {
    return { lead: spinnerFrame(input.live.frame), rateText: liveText, tone: "normal", live: true }
  }

  const usable = dedupeMeasurements(input.recent).filter(isUsableMeasurement)
  const ofViewed = usable.filter((measurement) => measurement.sessionID === input.viewedSessionID)
  const pool = ofViewed.length ? ofViewed : usable
  const last = pool.at(-1)
  const rateText = last ? formatRateIt(last.tokensPerSecond) : undefined
  if (!last || !rateText) return undefined

  const lead = sparkline(
    pool.map((measurement) => measurement.tokensPerSecond),
    FOOTER_REPLIES,
  )
  const tone = speedTone(last.tokensPerSecond, earlierRates([...input.seed, ...input.recent], last))
  return { lead, rateText, tone, live: false }
}

// ---- Log text ----

function isMeasurement(value: unknown): value is ThroughputMeasurement {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  const text = ["sessionID", "messageID", "providerID", "modelID"].every((field) => typeof record[field] === "string")
  const numbers = ["timestamp", "outputTokens", "timeToFirstTokenMs", "generationMs", "tokensPerSecond"].every(
    (field) => typeof record[field] === "number" && Number.isFinite(record[field]),
  )
  return text && numbers
}

/** Measurements from jsonl text. `partial` means the text starts mid-file, so the first line may be cut. */
export function parseLogText(text: string, partial: boolean): ThroughputMeasurement[] {
  const lines = text.split("\n")
  if (partial) lines.shift()
  const found: ThroughputMeasurement[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isMeasurement(value)) found.push(value)
    } catch {
      // a damaged line is skipped
    }
  }
  return found
}

// ---- Dialog ----

export function startOfLocalDay(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

export type ModelRow = {
  label: string
  medianRate: number
  medianWaitMs: number
  replies: number
  /** the sparkline at its widest (20 cells) */
  spark: string
  /** the last 20 rates in time order, for a sparkline of fewer cells */
  rates: number[]
}
export type SessionRow = { label: string; rate: number; outputTokens: number; generationMs: number; slow: boolean }

/** Today's numbers per model and the last 5 replies of one session. */
export function buildSpeedDialog(input: { measurements: ThroughputMeasurement[]; sessionID?: string; now: number }) {
  const usable = dedupeMeasurements(input.measurements).filter(isUsableMeasurement)
  const dayStart = startOfLocalDay(input.now)

  const groups = new Map<string, ThroughputMeasurement[]>()
  for (const measurement of usable.filter((item) => item.timestamp >= dayStart)) {
    const label = modelLabel(measurement.modelID)
    groups.set(label, [...(groups.get(label) ?? []), measurement])
  }
  const rank = (label: string) => {
    const index = FAMILIES.indexOf(label)
    return index === -1 ? FAMILIES.length : index
  }
  const rows: ModelRow[] = [...groups.entries()]
    .sort(([a, listA], [b, listB]) => rank(a) - rank(b) || listB.length - listA.length || a.localeCompare(b))
    .map(([label, list]) => {
      const byTime = [...list].sort((a, b) => a.timestamp - b.timestamp)
      return {
        label,
        medianRate: median(byTime.map((item) => item.tokensPerSecond))!,
        medianWaitMs: median(byTime.map((item) => Math.max(0, item.timeToFirstTokenMs)))!,
        replies: byTime.length,
        spark: sparkline(
          byTime.map((item) => item.tokensPerSecond),
          DIALOG_REPLIES,
        ),
        rates: byTime.map((item) => item.tokensPerSecond).slice(-DIALOG_REPLIES),
      }
    })

  const sessionID = input.sessionID ?? usable.at(-1)?.sessionID
  const session: SessionRow[] = usable
    .filter((item) => item.sessionID === sessionID)
    .slice(-SESSION_ROWS)
    .reverse()
    .map((item) => ({
      label: modelLabel(item.modelID),
      rate: item.tokensPerSecond,
      outputTokens: item.outputTokens,
      generationMs: item.generationMs,
      slow: speedTone(item.tokensPerSecond, earlierRates(usable, item)) === "slow",
    }))

  return { models: rows.slice(0, MAX_MODEL_ROWS), hiddenModels: Math.max(0, rows.length - MAX_MODEL_ROWS), session }
}

/**
 * "prima parola dopo 2,2 s, 12 risposte"; in a narrow room "attesa 2,2 s, 12 risposte", then only
 * "12 risposte", then nothing.
 */
export function formatModelDetail(row: ModelRow, room = Number.POSITIVE_INFINITY): string {
  const replies = `${row.replies} ${row.replies === 1 ? "risposta" : "risposte"}`
  const wait = formatSecondsIt(row.medianWaitMs) ?? "n/d"
  for (const text of [`prima parola dopo ${wait}, ${replies}`, `attesa ${wait}, ${replies}`, replies]) {
    if (text.length <= room) return text
  }
  return ""
}

/** Pads every column to its widest cell. The last column is left alone when it is left-aligned. */
export function padColumns(rows: string[][], align: ("left" | "right")[]): string[][] {
  const widths = align.map((_, column) => Math.max(0, ...rows.map((row) => (row[column] ?? "").length)))
  return rows.map((row) =>
    row.map((cell, column) => {
      if (align[column] === "right") return cell.padStart(widths[column]!)
      return column === align.length - 1 ? cell : cell.padEnd(widths[column]!)
    }),
  )
}

// ---- Responsive width ---------------------------------------------------------------------------
// The footer row is shared with other plugins and OpenCode's own hints. The footer takes only the room
// that is left and steps down: sparkline and rate, then the rate alone, then nothing.

/** Cells of padding in front of the footer text. */
const FOOTER_PADDING = 2
/** The gap OpenCode 2.2.6 puts between the items of the prompt footer row. */
export const FOOTER_ROW_GAP = 2
/** One cell kept free so that a rounding in the layout never squeezes a neighbour. */
const FOOTER_SPARE_CELLS = 1

export type FooterFit = FooterView

/** Cells the footer needs: "full" is padding, sparkline, a space and the rate; "rate" is padding and the rate. */
export function footerWidth(view: FooterView, step: "full" | "rate"): number {
  return step === "full"
    ? FOOTER_PADDING + view.lead.length + 1 + view.rateText.length
    : FOOTER_PADDING + view.rateText.length
}

/** The view that fits in `room` cells: whole, without its lead, or nothing. */
export function fitFooter(view: FooterView | undefined, room: number): FooterFit | undefined {
  if (!view) return undefined
  if (view.lead !== "" && room >= footerWidth(view, "full")) return view
  if (room < footerWidth(view, "rate")) return undefined
  return view.lead === "" ? view : { ...view, lead: "" }
}

/** How much of a flexible first item (the path, which truncates itself) is counted as used. */
export const FLEXIBLE_FIRST_FLOOR = 12

/**
 * Cells left in the footer row for the footer: the row, less its other items and one gap for each.
 * The item at `flexibleIndex` (the working-directory path, which truncates itself) counts only up to
 * 12 cells. Every other item counts in full: OpenCode's own hints must never be cut.
 */
export function footerRoom(input: {
  rowWidth: number
  siblingWidths: number[]
  flexibleIndex?: number
  /** cells the flexible item keeps (default 12); OpenCode's own hint passes its content width */
  flexibleFloor?: number
}): number {
  const floor = input.flexibleFloor ?? FLEXIBLE_FIRST_FLOOR
  const widths = input.siblingWidths.map((width, index) => (index === input.flexibleIndex ? Math.min(width, floor) : width))
  const present = widths.filter((width) => width > 0)
  const used = present.reduce((total, width) => total + width, 0) + present.length * FOOTER_ROW_GAP
  return Math.max(0, input.rowWidth - used - FOOTER_SPARE_CELLS)
}

/**
 * Turns a stream of measured widths into settled ones. The first width and any shrink apply at once
 * (nothing may be pushed while we wait); growth waits `delayMs` so a burst of resizes (a zoom
 * step in the terminal) lands as one change. Seeing the applied width again does no work.
 */
export function createWidthSettler(options: {
  delayMs: number
  schedule: (fn: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
  onSettle: (width: number) => void
}) {
  let applied: number | undefined
  let pending: number | undefined
  let timer: unknown
  let disposed = false

  const clear = () => {
    if (timer !== undefined) options.cancel(timer)
    timer = undefined
    pending = undefined
  }
  const apply = (width: number) => {
    applied = width
    options.onSettle(width)
  }

  return {
    observe(width: number) {
      if (disposed) return
      if (applied === undefined || width < applied) {
        clear()
        apply(width)
        return
      }
      if (width === applied) {
        clear()
        return
      }
      pending = width
      if (timer !== undefined) return
      timer = options.schedule(() => {
        timer = undefined
        const next = pending
        pending = undefined
        if (!disposed && next !== undefined && next !== applied) apply(next)
      }, options.delayMs)
    },
    dispose() {
      disposed = true
      clear()
    },
  }
}

/** Which columns fit: added in order of importance (`priority` lists column indexes) until one does not. */
export function visibleColumns(widths: number[], priority: number[], available: number, gap: number): boolean[] {
  const shown = widths.map(() => false)
  let used = 0
  let count = 0
  for (const column of priority) {
    const next = used + widths[column]! + (count > 0 ? gap : 0)
    if (next > available) break
    shown[column] = true
    used = next
    count++
  }
  return shown
}

const MIN_SPARK_CELLS = 6

/** Sparkline cells that fit beside the fixed part of a dialog row: up to 20, or none below 6. */
export function dialogSparkCells(width: number, fixedCells: number): number {
  const room = Math.min(DIALOG_REPLIES, width - fixedCells)
  return room >= MIN_SPARK_CELLS ? room : 0
}

/** The first wording that fits in `room` cells, or nothing: a heading is shortened, never cut mid-word. */
export function fitText(wordings: string[], room: number): string {
  return wordings.find((text) => text.length <= room) ?? ""
}

export type LayoutBox = { x: number; width: number; children: LayoutBox[] }

/**
 * The cells a box's content needs. A container may have been stretched to fill the row, so its own width
 * says nothing: it is the right-most edge of what is inside, counted from the container's own start.
 */
export function contentWidth(box: LayoutBox): number {
  const right = (node: LayoutBox): number =>
    node.children.length ? Math.max(...node.children.map(right)) : node.x + node.width
  return box.children.length ? Math.max(0, right(box) - box.x) : box.width
}
