// Pure logic of the quote plugin. No I/O here: the pending folder is reached through the PendingFs
// the caller passes in, so everything is testable and the hook cannot touch anything else.

export const MAX_QUOTE_CHARS = 20_000
export const PENDING_TTL_MS = 60 * 60 * 1000
export const MAX_QUOTES = 5
export const CHIP_PREVIEW_CHARS = 80
export const QUOTE_NAME = "Citazione"
export const QUOTE_DESCRIPTION = "Testo citato dall'utente nella conversazione"
export const SELECTION_WINDOW_MS = 6_000
export const TRUNCATION_NOTE = "[citazione troncata]"

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{1,100}$/
const PENDING_VERSION = 2

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

export type PendingParse = { status: "ok"; quotes: string[]; createdAt: number } | { status: "expired" | "invalid" }

export type AddResult = { status: "added"; quotes: string[] } | { status: "full" | "limit" | "invalid" | "error" }

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

const cutAt = (text: string, budget: number): string => {
  let end = budget
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1 // never inside a surrogate pair
  return text.slice(0, end)
}

/**
 * One character budget (MAX_QUOTE_CHARS) shared by all the quotes, in order. The quote that crosses it is
 * cut and ends with the note; quotes after it keep their place and hold only the note.
 */
export const capQuotes = (quotes: readonly string[]): { quotes: string[]; truncated: boolean } => {
  let remaining = MAX_QUOTE_CHARS
  let truncated = false
  const capped = quotes.map((quote) => {
    if (quote.length <= remaining) {
      remaining -= quote.length
      return quote
    }
    truncated = true
    const body = cutAt(quote, remaining)
    remaining = 0
    return body === "" ? TRUNCATION_NOTE : `${body}\n\n${TRUNCATION_NOTE}`
  })
  return { quotes: capped, truncated }
}

/** One quote against the whole budget. */
export const capQuote = (text: string): { text: string; truncated: boolean } => {
  const result = capQuotes([text])
  return { text: result.quotes[0] ?? "", truncated: result.truncated }
}

/** What the chip shows: the first characters in quotes, and a line count when there are several lines. */
export const chipSummary = (text: string): { preview: string; lines: number; lineLabel: string } => {
  const lines = text.replace(/\n+$/, "").split("\n").length
  const flat = text.replace(/\s+/g, " ").trim()
  let preview = flat
  let cut = false
  if (flat.length > CHIP_PREVIEW_CHARS) {
    let end = CHIP_PREVIEW_CHARS
    if (isHighSurrogate(flat.charCodeAt(end - 1))) end += 1
    preview = flat.slice(0, end)
    cut = true
  }
  return { preview: `«${preview}${cut ? "…" : ""}»`, lines, lineLabel: lines > 1 ? `${lines} righe` : "" }
}

/** "Citazione" for a single quote, "Citazione 1", "Citazione 2", ... when there are several. */
export const attachmentName = (index: number, total: number): string =>
  total <= 1 ? QUOTE_NAME : `${QUOTE_NAME} ${index + 1}`

export const buildQuoteDataUri = (text: string): string =>
  `data:text/plain;base64,${Buffer.from(capQuote(text).text, "utf8").toString("base64")}`

export const serializePending = (quotes: readonly string[], now: number): string =>
  JSON.stringify({ v: PENDING_VERSION, quotes, createdAt: now })

const isQuoteText = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

/** Reads version 2 (a list of quotes) and the old version 1 (one quote, read as a list of one). */
export const parsePending = (raw: string, now: number): PendingParse => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { status: "invalid" }
  }
  if (typeof value !== "object" || value === null) return { status: "invalid" }
  const record = value as Record<string, unknown>

  let quotes: string[]
  if (record.v === 1) {
    if (!isQuoteText(record.text)) return { status: "invalid" }
    quotes = [record.text]
  } else if (record.v === PENDING_VERSION) {
    const list = record.quotes
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_QUOTES || !list.every(isQuoteText))
      return { status: "invalid" }
    quotes = list
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

/** True when both lists hold the same quotes in the same order (or both are missing). */
export const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b
  return a.length === b.length && a.every((quote, index) => quote === b[index])
}

/**
 * Adds one quote to the session's pending list (at most MAX_QUOTES) and renews the expiry. An expired or
 * corrupt old file starts a fresh list; an old file that cannot be read is left alone ("error").
 */
export const addPending = (sessionID: unknown, text: string, fs: PendingFs, now: number): AddResult => {
  const name = pendingFileName(sessionID)
  const quote = normalizeSelection(text)
  if (name === null || quote === null) return { status: "invalid" }
  try {
    const path = pathFor(fs, name)
    const raw = fs.read(path)
    const parsed = raw === undefined ? undefined : parsePending(raw, now)
    const current = parsed?.status === "ok" ? parsed.quotes : []
    if (current.length >= MAX_QUOTES) return { status: "full" }
    // The shared character budget is used up: a new quote would be only the truncation note.
    if (current.reduce((total, q) => total + q.length, 0) >= MAX_QUOTE_CHARS) return { status: "limit" }
    const next = capQuotes([...current, quote]).quotes
    fs.write(path, serializePending(next, now))
    return { status: "added", quotes: next }
  } catch {
    return { status: "error" }
  }
}

/** The pending quotes of a session as the file holds them now, or undefined. Read only. */
export const loadPending = (sessionID: unknown, fs: PendingFs, now: number): string[] | undefined => {
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
 */
export const removePending = (
  sessionID: unknown,
  which: number | "last",
  fs: PendingFs,
  now: number,
  expected?: string,
): string[] | undefined => {
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
    if (expected !== undefined && parsed.quotes[index] !== expected) return parsed.quotes
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
 * the quotes as files named "Citazione" (or "Citazione 1", "Citazione 2", ...) and consumes the file. It never throws and never logs: on any
 * problem the prompt is left exactly as it came.
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
    const entries = quotes.map((text, index) => ({
      uri: buildQuoteDataUri(text),
      name: attachmentName(index, quotes.length),
      description: QUOTE_DESCRIPTION,
    }))
    const target = prompt as { files?: unknown[] }
    const files = Array.isArray(target.files) ? target.files : []
    fs.remove(path) // consume first: if this fails the prompt stays untouched
    target.files = [...files, ...entries]
  } catch {
    // Skip the attachment, never block the prompt.
  }
}
