// Pure logic of the ask-box plugin: find the last "Serve da te:" block in the assistant's replies,
// clean it and cap it. No I/O and no OpenCode imports, so it is tested with plain objects.
// The message shapes are the ones OpenCode 2.2.6 returns from data.session.message.list():
//   { type: "user", text }  { type: "assistant", content: [{ type: "text", text }, ...] }
// plus other types (idle, synthetic, agent-switched) that this plugin ignores.

export const MAX_ASK_LINES = 8
export const MARKER = "Serve da te"

export type Turn = { role: "user" | "assistant"; text: string }

// "Serve da te" at the start of a line, optionally wrapped in markdown (#, >, a bullet, **, __, `) and followed by ":".
// Groups: 1 opener (** __ `), 2 closer before the colon, 3 the opener's own closer right after the colon (only if a
// space or the end follows, or when no other closer follows on the line, so "Serve da te: **b** c" keeps its bold
// and "**Serve da te:**x" drops it), 4 the text.
const MARKER_LINE = /^[\s>#-]*(?:[*+]\s+)?(\*\*|__|`)?[*_`]*serve da te\s*([*_`]*)\s*:(\1(?=\s|$)|\1(?!.*\1))?\s*(.*)$/i
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*+])\s+/

export function stripMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = line.replace(/^(\s*)[*+]\s+/, "$1- ")
      out = out.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*>\s?/, "")
      out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      out = out.replace(/(\*\*|__)(.+?)\1/g, "$2")
      out = out.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, "$1$2")
      out = out.replace(/`([^`]*)`/g, "$1")
      return out
    })
    .join("\n")
}

function countOf(text: string, marker: string): number {
  return text.split(marker).length - 1
}

// Removes the closer of a markdown span that opened on the marker line. It is the closer at the end of the first
// line when that line has an odd number of them (the other ones pair up), else the one at the end of the last
// line when the whole block has an odd number (the span runs over several lines).
function dropClosingMarker(block: string[], closer: string): void {
  const last = block.length - 1
  if (last < 0) return
  if (block[0]!.endsWith(closer) && countOf(block[0]!, closer) % 2 === 1) {
    block[0] = block[0]!.slice(0, -closer.length).trimEnd()
    return
  }
  if (block[last]!.endsWith(closer) && countOf(block.join("\n"), closer) % 2 === 1) {
    block[last] = block[last]!.slice(0, -closer.length).trimEnd()
  }
}

export function extractAsk(text: string): string | null {
  const lines = text.split("\n") // a trailing "\r" is removed by trim() below
  let start = -1
  for (let index = lines.length - 1; index >= 0; index--) {
    if (MARKER_LINE.test(lines[index]!)) {
      start = index
      break
    }
  }
  if (start === -1) return null

  const block: string[] = []
  const match = MARKER_LINE.exec(lines[start]!)
  const first = match?.[4]?.trim() ?? ""
  if (first !== "") block.push(first)
  // The opener ("**", "__", a backtick) was not closed around the marker: "**Serve da te: x.**".
  const opener = match?.[1]
  const closer = opener && !match?.[2] && !match?.[3] ? opener : undefined

  let gap = false
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!
    if (line.trim() === "") {
      gap = true
      continue
    }
    if (gap && !LIST_ITEM.test(line)) break
    block.push(line.trim())
  }
  if (closer !== undefined) dropClosingMarker(block, closer)
  const cleaned = stripMarkdown(block.join("\n")).trim()
  return cleaned === "" ? null : cleaned
}

// Word wrap that mimics a terminal text box: explicit line breaks stay, long words are split.
export function wrapLines(text: string, width: number): string[] {
  const size = Math.max(1, Math.floor(width))
  const out: string[] = []
  for (const source of text.split("\n")) {
    if (source === "") {
      out.push("")
      continue
    }
    let current = ""
    for (const word of source.split(/\s+/).filter(Boolean)) {
      let rest = word
      while (rest.length > size) {
        if (current !== "") {
          out.push(current)
          current = ""
        }
        out.push(rest.slice(0, size))
        rest = rest.slice(size)
      }
      if (current === "") current = rest
      else if (current.length + 1 + rest.length <= size) current += ` ${rest}`
      else {
        out.push(current)
        current = rest
      }
    }
    if (current !== "") out.push(current)
  }
  return out
}

// At most `maxLines` lines once wrapped at `width`; a cut ends with an ellipsis that still fits.
export function capAsk(text: string, width: number, maxLines: number = MAX_ASK_LINES): string {
  const lines = wrapLines(text, width)
  if (lines.length <= maxLines) return lines.join("\n")
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1]!
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, width - 1)).trimEnd()}…`
  return kept.join("\n")
}

// About this many characters are shown whatever the sidebar width, so a narrow sidebar gets more lines.
const ASK_CHARS = 288
export const MAX_ASK_LINES_NARROW = 12
export const RESIZE_COALESCE_MS = 50

export function askLineCap(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return MAX_ASK_LINES
  return Math.min(MAX_ASK_LINES_NARROW, Math.max(MAX_ASK_LINES, Math.ceil(ASK_CHARS / width)))
}

// The ask as the box shows it: wrapped at the measured width, capped at the cap for that width.
export function askText(text: string, width: number): string {
  return capAsk(text, width, askLineCap(width))
}

export type Scheduler = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

// Turns a stream of measured widths into few updates: the first real size is applied at once, later ones
// are coalesced to one update per RESIZE_COALESCE_MS, and a size that is already shown does nothing.
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

export function toTurns(messages: unknown): Turn[] {
  if (!Array.isArray(messages)) return []
  const turns: Turn[] = []
  for (const item of messages) {
    if (typeof item !== "object" || item === null) continue
    const message = item as { type?: unknown; text?: unknown; content?: unknown }
    if (message.type === "user") {
      // a message with only files has no text but is still the owner answering
      turns.push({ role: "user", text: typeof message.text === "string" ? message.text : "" })
    } else if (message.type === "assistant" && Array.isArray(message.content)) {
      const parts = message.content.flatMap((part: unknown) => {
        const piece = part as { type?: unknown; text?: unknown } | null
        return piece?.type === "text" && typeof piece.text === "string" ? [piece.text] : []
      })
      turns.push({ role: "assistant", text: parts.join("\n") })
    }
  }
  return turns
}

// Index where the visible list ends: OpenCode hides the reverted message and everything after it.
export function visibleEnd(messages: unknown[], revertID?: unknown): number {
  if (typeof revertID !== "string") return messages.length
  for (let index = messages.length - 1; index >= 0; index--) {
    if ((messages[index] as { id?: unknown } | null)?.id === revertID) return index
  }
  return messages.length
}

// The ask to show: the "Serve da te" block of the latest completed assistant reply, and only if the owner has not
// written since. A latest reply without a block hides the box, an older request is never kept.
// Walks backwards and stops at the first user message, so long sessions cost the same as short ones.
// A reply still streaming is skipped, so its text is not read on every token and the box does not flicker: the
// decision stays on the last completed reply until the new one is done. A message with no text (only tools or
// reasoning) is not a reply and is skipped too.
export function currentAsk(messages: unknown, revertID?: unknown): string | null {
  return currentRequest(messages, revertID)?.text ?? null
}

/** `askedAt`: when the reply that asks was completed, in milliseconds, if OpenCode says so. */
export type Request = { text: string; askedAt?: number }

// currentAsk's text together with the time it was asked, so the box can say how long it has waited.
export function currentRequest(messages: unknown, revertID?: unknown): Request | null {
  if (!Array.isArray(messages)) return null
  for (let index = visibleEnd(messages, revertID) - 1; index >= 0; index--) {
    const item = messages[index] as
      | { type?: unknown; content?: unknown; time?: { completed?: unknown } | null }
      | null
    if (typeof item !== "object" || item === null) continue
    if (item.type === "user") return null
    if (item.type !== "assistant" || !Array.isArray(item.content)) continue
    if (item.time && typeof item.time === "object" && !item.time.completed) continue
    const parts = item.content.flatMap((part: unknown) => {
      const piece = part as { type?: unknown; text?: unknown } | null
      return piece?.type === "text" && typeof piece.text === "string" ? [piece.text] : []
    })
    if (parts.length === 0) continue
    const text = extractAsk(parts.join("\n"))
    if (text === null) return null
    const completed = item.time?.completed
    return typeof completed === "number" && Number.isFinite(completed) ? { text, askedAt: completed } : { text }
  }
  return null
}

// True when two requests would draw the same box, so a list that changed elsewhere redraws nothing.
export function sameRequest(a: Request | null | undefined, b: Request | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.text === b.text && a.askedAt === b.askedAt
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

// The header of the box: the title and, on the right edge, how long the request has waited ("da 12m").
// The age is left out when its time is not known or when it does not fit beside the title with a blank.
export function askHeader(askedAt: number | undefined, now: number, width: number): { title: string; age: string } {
  const age = askedAt === undefined ? "" : `da ${relativeIt(now - askedAt)}`
  const fits = Number.isFinite(width) && MARKER.length + 1 + age.length <= width
  return { title: MARKER, age: fits ? age : "" }
}
