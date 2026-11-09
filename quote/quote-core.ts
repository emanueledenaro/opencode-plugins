// Pure logic of the quote plugin. No I/O here: the pending folder is reached through the PendingFs
// the caller passes in, so everything is testable and the hook cannot touch anything else.

export const MAX_QUOTE_CHARS = 20_000
export const PENDING_TTL_MS = 60 * 60 * 1000
export const CHIP_PREVIEW_CHARS = 80
export const QUOTE_NAME = "Citazione"
export const QUOTE_DESCRIPTION = "Testo citato dall'utente nella conversazione"
export const SELECTION_WINDOW_MS = 6_000
export const TRUNCATION_NOTE = "[citazione troncata]"

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{1,100}$/
const PENDING_VERSION = 1

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

export type PendingParse = { status: "ok"; text: string } | { status: "expired" | "invalid" }

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

/** Cuts the quote at MAX_QUOTE_CHARS, never inside a surrogate pair, and appends a note when it cut. */
export const capQuote = (text: string): { text: string; truncated: boolean } => {
  if (text.length <= MAX_QUOTE_CHARS) return { text, truncated: false }
  let end = MAX_QUOTE_CHARS
  if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1
  return { text: `${text.slice(0, end)}\n\n${TRUNCATION_NOTE}`, truncated: true }
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
  return { preview: `"${preview}${cut ? "…" : ""}"`, lines, lineLabel: lines > 1 ? `${lines} righe` : "" }
}

export const buildQuoteDataUri = (text: string): string =>
  `data:text/plain;base64,${Buffer.from(capQuote(text).text, "utf8").toString("base64")}`

export const serializePending = (text: string, now: number): string =>
  JSON.stringify({ v: PENDING_VERSION, text, createdAt: now })

export const parsePending = (raw: string, now: number): PendingParse => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { status: "invalid" }
  }
  if (typeof value !== "object" || value === null) return { status: "invalid" }
  const record = value as Record<string, unknown>
  if (record.v !== PENDING_VERSION) return { status: "invalid" }
  if (typeof record.text !== "string" || record.text.trim() === "") return { status: "invalid" }
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return { status: "invalid" }
  if (record.createdAt > now + MAX_FUTURE_SKEW_MS) return { status: "invalid" }
  if (now - record.createdAt >= PENDING_TTL_MS) return { status: "expired" }
  return { status: "ok", text: record.text }
}

/** True while a finished selection can still be turned into a quote by the key. */
export const selectionFresh = (selection: Selection | undefined, now: number): boolean =>
  selection !== undefined && now - selection.at < SELECTION_WINDOW_MS

/** Writes the pending quote of one session (replacing the old one). False when nothing was written. */
export const savePending = (sessionID: unknown, text: string, fs: PendingFs, now: number): boolean => {
  const name = pendingFileName(sessionID)
  const quote = normalizeSelection(text)
  if (name === null || quote === null) return false
  try {
    fs.write(pathFor(fs, name), serializePending(capQuote(quote).text, now))
    return true
  } catch {
    return false
  }
}

/** The pending quote of a session as the file holds it now, or undefined. Read only. */
export const loadPending = (sessionID: unknown, fs: PendingFs, now: number): string | undefined => {
  const name = pendingFileName(sessionID)
  if (name === null) return undefined
  try {
    const raw = fs.read(pathFor(fs, name))
    if (raw === undefined) return undefined
    const parsed = parsePending(raw, now)
    return parsed.status === "ok" ? parsed.text : undefined
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
 * the quote as a file named "Citazione" and consumes the file. It never throws and never logs: on any
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

    const entry = { uri: buildQuoteDataUri(parsed.text), name: QUOTE_NAME, description: QUOTE_DESCRIPTION }
    const target = prompt as { files?: unknown[] }
    const files = Array.isArray(target.files) ? target.files : []
    fs.remove(path) // consume first: if this fails the prompt stays untouched
    target.files = [...files, entry]
  } catch {
    // Skip the attachment, never block the prompt.
  }
}
