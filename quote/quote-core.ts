// Pure logic of the quote plugin. No I/O here: the pending folder is reached through the PendingFs
// the caller passes in, so everything is testable and the hook cannot touch anything else.

export const MAX_QUOTE_CHARS = 20_000
export const PENDING_TTL_MS = 60 * 60 * 1000
export const MAX_QUOTES = 5
export const MAX_COMMENT_CHARS = 2000
export const CHIP_PREVIEW_CHARS = 80
// A row with a comment must also fit the comment, so its quote preview is shorter.
export const COMMENT_MAX_CHARS = 80 // ceiling only; the box gives a comment what the width allows
export const RESIZE_COALESCE_MS = 50
export const NO_COMMENT = "senza commento"
export const QUOTE_NAME = "Citazione"
export const QUOTE_DESCRIPTION = "Testo citato dall'utente nella conversazione"
export const QUOTE_COMMENT_DESCRIPTION = "Testo citato dall'utente e il suo commento su questo pezzo"
export const SELECTION_WINDOW_MS = 6_000
export const TRUNCATION_NOTE = "[citazione troncata]"

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{1,100}$/
const PENDING_VERSION = 3

/** The slice of the file system the plugin uses. `dir` is the only folder it may touch. */
export interface PendingFs {
  dir: string
  read(path: string): string | undefined
  write(path: string, data: string): void
  remove(path: string): void
}

export interface Selection {
  text: string
  at: number
}

/** One pending quote: the cited text and the user's comment on it ("" when there is none). */
export interface PendingQuote {
  text: string
  comment: string
}

export type PendingParse = { status: "ok"; quotes: PendingQuote[]; createdAt: number } | { status: "expired" | "invalid" }

export type AddResult = { status: "added"; quotes: PendingQuote[] } | { status: "full" | "limit" | "invalid" | "error" }

export type Room = "ok" | "full" | "limit" | "invalid" | "error"

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

/** `<sessionID>.json`, or null when the ID could escape the folder or is not an OpenCode session ID. */
export const pendingFileName = (sessionID: unknown): string | null =>
  typeof sessionID === "string" && SESSION_ID_PATTERN.test(sessionID) ? `${sessionID}.json` : null

const pathFor = (fs: PendingFs, name: string) => `${fs.dir}/${name}`

/** The selected text as a quote: LF line ends, no trailing blanks, null when nothing is left. */
export const normalizeSelection = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null
  const text = raw.replace(/\r\n?/g, "\n").trimEnd()
  return text.trim() === "" ? null : text
}

/** The comment as stored: one line, trimmed, at most MAX_COMMENT_CHARS. "" when there is nothing. */
export const normalizeComment = (raw: unknown): string => {
  if (typeof raw !== "string") return ""
  const flat = raw.replace(/\s*[\r\n]+\s*/g, " ").trim()
  return flat.length <= MAX_COMMENT_CHARS ? flat : cutAt(flat, MAX_COMMENT_CHARS)
}

const cutAt = (text: string, budget: number): string => {
  let end = budget
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1 // never inside a surrogate pair
  return text.slice(0, end)
}

/**
 * One character budget (MAX_QUOTE_CHARS) shared by all the quotes and their comments, in order. The quote
 * that crosses it is cut and ends with the note; its comment is kept whole when it can be, because it is the
 * user's own words. Quotes after it keep their place and hold only the note.
 */
export const capQuotes = (quotes: readonly PendingQuote[]): { quotes: PendingQuote[]; truncated: boolean } => {
  let remaining = MAX_QUOTE_CHARS
  let truncated = false
  const capped = quotes.map((quote) => {
    const cost = quote.text.length + quote.comment.length
    if (cost <= remaining) {
      remaining -= cost
      return quote
    }
    truncated = true
    const comment = cutAt(quote.comment, Math.min(quote.comment.length, remaining))
    const body = cutAt(quote.text, remaining - comment.length)
    remaining = 0
    // The note says the quote was cut, so it is added only when the text itself lost something.
    if (body.length === quote.text.length) return { text: quote.text, comment }
    return { text: body === "" ? TRUNCATION_NOTE : `${body}\n\n${TRUNCATION_NOTE}`, comment }
  })
  return { quotes: capped, truncated }
}

/** One quote text against the whole budget. */
export const capQuote = (text: string): { text: string; truncated: boolean } => {
  const result = capQuotes([{ text, comment: "" }])
  return { text: result.quotes[0]?.text ?? "", truncated: result.truncated }
}

/** What the chip shows: the first characters in quotes, and a line count when there are several lines. */
export const chipSummary = (
  text: string,
  max: number = CHIP_PREVIEW_CHARS,
): { preview: string; lines: number; lineLabel: string } => {
  const lines = text.replace(/\n+$/, "").split("\n").length
  const flat = text.replace(/\s+/g, " ").trim()
  let preview = flat
  let cut = false
  if (flat.length > max) {
    let end = max
    if (isHighSurrogate(flat.charCodeAt(end - 1))) end += 1
    preview = flat.slice(0, end)
    cut = true
  }
  return { preview: `«${preview}${cut ? "…" : ""}»`, lines, lineLabel: lines > 1 ? `${lines} righe` : "" }
}

const chars = (text: string): string[] => [...text]
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()
/** `text` cut to `width` characters (not UTF-16 units), ending with an ellipsis when it was longer. */
const cutText = (text: string, width: number): string => {
  if (width <= 0) return ""
  const all = chars(text)
  return all.length <= width ? text : `${all.slice(0, width - 1).join("")}…`
}
/** At most `max` characters; longer text keeps `max` and ends with an ellipsis. */
const ceiling = (text: string, max: number): string => {
  const all = chars(text)
  return all.length <= max ? text : `${all.slice(0, max).join("")}…`
}

const ROW_PREFIX = 3 // "1  "
const ROW_GAP = 2
const MIN_PREVIEW = 8
const MIN_COMMENT = 10
const COMMENT_SHARE = 0.4

export type RowLayout = { preview: string; lineLabel: string; comment: string; placeholder: boolean }

/**
 * What one row of the box shows in `inner` columns (the row starts with a 3 column number). It gives up,
 * in order: the line label, then room of the comment and the preview (each cut with an ellipsis), then
 * the comment altogether. Never wider than `inner` (for 6 columns or more).
 */
export const rowLayout = (quote: PendingQuote, inner: number): RowLayout => {
  const room = Number.isNaN(inner) ? Infinity : Math.max(1, Math.floor(inner) - ROW_PREFIX)
  const flat = ceiling(oneLine(quote.text), CHIP_PREVIEW_CHARS)
  const preview = `«${flat}»`
  const lineLabel = chipSummary(quote.text).lineLabel
  const placeholder = quote.comment.trim() === ""
  const comment = placeholder ? NO_COMMENT : ceiling(oneLine(quote.comment), COMMENT_MAX_CHARS)
  const P = chars(preview).length
  const C = chars(comment).length
  const L = lineLabel === "" ? 0 : ROW_GAP + chars(lineLabel).length
  const fitPreview = (width: number): string =>
    P <= width ? preview : width - 2 < 1 ? cutText(preview, width) : `«${cutText(flat, width - 2)}»`

  if (P + L + ROW_GAP + C <= room) return { preview, lineLabel, comment, placeholder }

  let commentBudget = Math.min(C, Math.max(MIN_COMMENT, Math.floor(COMMENT_SHARE * (room - ROW_GAP))))
  const previewBudget = Math.min(P, room - ROW_GAP - commentBudget)
  if (previewBudget >= Math.min(P, MIN_PREVIEW)) {
    commentBudget = Math.min(C, commentBudget + (room - ROW_GAP - previewBudget - commentBudget))
    return { preview: fitPreview(previewBudget), lineLabel: "", comment: cutText(comment, commentBudget), placeholder }
  }
  return { preview: fitPreview(room), lineLabel: "", comment: "", placeholder: false }
}

/** The key hints under the rows: the longest wording that fits `width`, or null when none does. */
export const hintLine = (removeKey: string, sendKey: string, width: number): string | null => {
  const room = Number.isNaN(width) ? Infinity : width
  const wordings = [
    `clic su una riga per togliere, ${removeKey} toglie l'ultima, ${sendKey} invia solo le citazioni`,
    `clic toglie, ${removeKey} toglie l'ultima, ${sendKey} invia`,
    `${removeKey} toglie l'ultima, ${sendKey} invia`,
    `${sendKey} invia`,
  ]
  return wordings.find((text) => text.length <= room) ?? null
}

/** The title of the box: the counter ("3 di 5") only when it fits next to the name; the name is cut last. */
export const titleLine = (count: number, inner: number): { name: string; counter: string } => {
  const name = count === 1 ? "Citazione" : "Citazioni"
  const counter = count > 1 ? `  ${count} di ${MAX_QUOTES}` : ""
  const room = Number.isNaN(inner) ? Infinity : inner
  if (name.length + counter.length <= room) return { name, counter }
  return { name: cutText(name, room), counter: "" }
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

/** The line shown in the comment dialog: the quote preview, with the line count in brackets if several. */
export const dialogPreview = (text: string): string => {
  const summary = chipSummary(text)
  return summary.lineLabel === "" ? summary.preview : `${summary.preview} (${summary.lineLabel})`
}

/** "Citazione" for a single quote, "Citazione 1", "Citazione 2", ... when there are several. */
export const attachmentName = (index: number, total: number): string =>
  total <= 1 ? QUOTE_NAME : `${QUOTE_NAME} ${index + 1}`

/**
 * The attachment content: just the quote, or the comment first and then the quote. The comment is one
 * line and comes first, so text inside the quote can never pose as the user's comment.
 */
export const formatAttachment = (quote: PendingQuote): string =>
  quote.comment === "" ? quote.text : `Commento:\n${quote.comment}\n\nTesto citato:\n${quote.text}`

export const attachmentDescription = (quote: PendingQuote): string =>
  quote.comment === "" ? QUOTE_DESCRIPTION : QUOTE_COMMENT_DESCRIPTION

export const buildQuoteDataUri = (quote: PendingQuote): string =>
  `data:text/plain;base64,${Buffer.from(formatAttachment(capQuotes([quote]).quotes[0] ?? quote), "utf8").toString("base64")}`

export const serializePending = (quotes: readonly PendingQuote[], now: number): string =>
  JSON.stringify({ v: PENDING_VERSION, quotes, createdAt: now })

const isQuoteText = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

const asPendingQuote = (value: unknown): PendingQuote | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { text, comment } = value as Record<string, unknown>
  if (!isQuoteText(text) || text.length > MAX_QUOTE_CHARS + TRUNCATION_NOTE.length + 2) return undefined
  // Only a comment the plugin itself could have written: one line, trimmed, within the cap.
  if (typeof comment !== "string" || comment !== normalizeComment(comment)) return undefined
  return { text, comment }
}

/** Reads version 3 (quotes with comments) and the old versions: v2 (a list of texts), v1 (one text). */
export const parsePending = (raw: string, now: number): PendingParse => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { status: "invalid" }
  }
  if (typeof value !== "object" || value === null) return { status: "invalid" }
  const record = value as Record<string, unknown>

  let quotes: PendingQuote[]
  if (record.v === 1) {
    if (!isQuoteText(record.text)) return { status: "invalid" }
    quotes = [{ text: record.text, comment: "" }]
  } else if (record.v === 2) {
    const list = record.quotes
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_QUOTES || !list.every(isQuoteText))
      return { status: "invalid" }
    quotes = list.map((text) => ({ text, comment: "" }))
  } else if (record.v === PENDING_VERSION) {
    const list = record.quotes
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_QUOTES) return { status: "invalid" }
    const parsed = list.map(asPendingQuote)
    if (parsed.some((quote) => quote === undefined)) return { status: "invalid" }
    quotes = parsed as PendingQuote[]
  } else {
    return { status: "invalid" }
  }

  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return { status: "invalid" }
  if (record.createdAt > now + MAX_FUTURE_SKEW_MS) return { status: "invalid" }
  if (now - record.createdAt >= PENDING_TTL_MS) return { status: "expired" }
  return { status: "ok", quotes, createdAt: record.createdAt }
}

/** True while a finished selection can still be turned into a quote by the key. */
export const selectionFresh = (selection: Selection | undefined, now: number): boolean =>
  selection !== undefined && now - selection.at < SELECTION_WINDOW_MS

/** True when both lists hold the same quotes and comments in the same order (or both are missing). */
export const sameList = (a: readonly PendingQuote[] | undefined, b: readonly PendingQuote[] | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b
  return a.length === b.length && a.every((quote, index) => quote.text === b[index]!.text && quote.comment === b[index]!.comment)
}

const usedChars = (quotes: readonly PendingQuote[]) =>
  quotes.reduce((total, quote) => total + quote.text.length + quote.comment.length, 0)

const roomFor = (current: readonly PendingQuote[]): Room => {
  if (current.length >= MAX_QUOTES) return "full"
  // The shared character budget is used up: a new quote would be only the truncation note.
  if (usedChars(current) >= MAX_QUOTE_CHARS) return "limit"
  return "ok"
}

/** The quotes the file holds now; an expired or corrupt file counts as empty. Throws when it cannot be read. */
const readCurrent = (fs: PendingFs, path: string, now: number): PendingQuote[] => {
  const raw = fs.read(path)
  const parsed = raw === undefined ? undefined : parsePending(raw, now)
  return parsed?.status === "ok" ? parsed.quotes : []
}

/** Whether one more quote fits ("ok"), asked before the comment dialog so nobody types for nothing. Read only. */
export const pendingRoom = (sessionID: unknown, fs: PendingFs, now: number): Room => {
  const name = pendingFileName(sessionID)
  if (name === null) return "invalid"
  try {
    return roomFor(readCurrent(fs, pathFor(fs, name), now))
  } catch {
    return "error"
  }
}

/**
 * Adds one quote with its comment to the session's pending list (at most MAX_QUOTES) and renews the expiry.
 * An expired or corrupt old file starts a fresh list; an old file that cannot be read is left alone ("error").
 */
export const addPending = (sessionID: unknown, text: string, comment: unknown, fs: PendingFs, now: number): AddResult => {
  const name = pendingFileName(sessionID)
  const quote = normalizeSelection(text)
  if (name === null || quote === null) return { status: "invalid" }
  try {
    const path = pathFor(fs, name)
    const current = readCurrent(fs, path, now)
    const room = roomFor(current)
    if (room !== "ok") return { status: room }
    const next = capQuotes([...current, { text: quote, comment: normalizeComment(comment) }]).quotes
    fs.write(path, serializePending(next, now))
    return { status: "added", quotes: next }
  } catch {
    return { status: "error" }
  }
}

/** The pending quotes of a session as the file holds them now, or undefined. Read only. */
export const loadPending = (sessionID: unknown, fs: PendingFs, now: number): PendingQuote[] | undefined => {
  const name = pendingFileName(sessionID)
  if (name === null) return undefined
  try {
    const raw = fs.read(pathFor(fs, name))
    if (raw === undefined) return undefined
    const parsed = parsePending(raw, now)
    return parsed.status === "ok" ? parsed.quotes : undefined
  } catch {
    return undefined
  }
}

/**
 * Removes one quote (by index, or "last" for the most recently added) and returns what is left. The expiry
 * is not renewed. Removing the only quote deletes the file. Undefined when nothing could be done.
 * With `expected`, the quote is removed only if it is still the one the user clicked.
 */
export const removePending = (
  sessionID: unknown,
  which: number | "last",
  fs: PendingFs,
  now: number,
  expected?: PendingQuote,
): PendingQuote[] | undefined => {
  const name = pendingFileName(sessionID)
  if (name === null) return undefined
  try {
    const path = pathFor(fs, name)
    const raw = fs.read(path)
    if (raw === undefined) return undefined
    const parsed = parsePending(raw, now)
    if (parsed.status !== "ok") return undefined
    const index = which === "last" ? parsed.quotes.length - 1 : which
    if (!Number.isInteger(index) || index < 0 || index >= parsed.quotes.length) return parsed.quotes
    // The box can lag the file by a second: remove only the quote the user clicked.
    if (expected !== undefined && !sameList([parsed.quotes[index]!], [expected])) return parsed.quotes
    const next = parsed.quotes.filter((_, position) => position !== index)
    if (next.length === 0) {
      fs.remove(path)
      return []
    }
    fs.write(path, serializePending(next, parsed.createdAt))
    return next
  } catch {
    return undefined
  }
}

export const clearPending = (sessionID: unknown, fs: PendingFs): void => {
  const name = pendingFileName(sessionID)
  if (name === null) return
  try {
    fs.remove(pathFor(fs, name))
  } catch {
    // Nothing to clear, or the folder is gone: either way there is no pending quote to leave behind.
  }
}

/**
 * The body of the server "prompt" hook. It looks at one file only (the event's own session), attaches
 * the quotes as files named "Citazione" (or "Citazione 1", "Citazione 2", ...), each with its comment, and
 * consumes the file. It never throws and never logs: on any problem the prompt is left exactly as it came.
 */
export const applyQuoteToPrompt = (event: unknown, fs: PendingFs, now: number): void => {
  try {
    if (typeof event !== "object" || event === null) return
    const { sessionID, prompt } = event as { sessionID?: unknown; prompt?: unknown }
    if (typeof prompt !== "object" || prompt === null) return
    const name = pendingFileName(sessionID)
    if (name === null) return
    const path = pathFor(fs, name)

    const raw = fs.read(path)
    if (raw === undefined) return
    const parsed = parsePending(raw, now)
    if (parsed.status !== "ok") {
      fs.remove(path)
      return
    }

    const quotes = capQuotes(parsed.quotes).quotes
    const entries = quotes.map((quote, index) => ({
      uri: buildQuoteDataUri(quote),
      name: attachmentName(index, quotes.length),
      description: attachmentDescription(quote),
    }))
    const target = prompt as { files?: unknown[] }
    const files = Array.isArray(target.files) ? target.files : []
    fs.remove(path) // consume first: if this fails the prompt stays untouched
    target.files = [...files, ...entries]
  } catch {
    // Skip the attachment, never block the prompt.
  }
}
