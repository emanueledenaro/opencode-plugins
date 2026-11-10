// Pure logic of the stato plugin: which meaning a line has, and which theme token draws it.
// Nothing here touches OpenTUI, the disk or the network, so all of it is tested with `bun test`.

export type StatoKind = "done" | "broken" | "progress" | "next" | "plain"

// The in-progress symbol, and the four frames it spins through (a calm 4 frames per second, one turn per second).
export const PROGRESS_SYMBOL = "◐"
export const SPIN_FRAMES = ["◐", "◓", "◑", "◒"] as const
export const SPIN_INTERVAL_MS = 250

// First symbol of a line -> meaning. The four symbols of the status replies. `…` is the old in-progress symbol,
// still recognised so old messages keep their colour; the other spin frames are accepted in case one is copied back.
const SYMBOLS: Record<string, StatoKind | undefined> = {
  "✓": "done",
  "✗": "broken",
  "…": "progress",
  "◐": "progress",
  "◓": "progress",
  "◑": "progress",
  "◒": "progress",
  "➜": "next",
}

// A block longer than this is left to the default renderer: one text row per line gets heavy.
export const MAX_LINES = 500

export type StatoLine = { text: string; kind: StatoKind }

// Meaning of one line. Leading spaces and tabs are skipped, so an indented line keeps its colour.
export function statoKind(line: unknown): StatoKind {
  if (typeof line !== "string") return "plain"
  const first = Array.from(line.trimStart())[0]
  if (first === undefined) return "plain"
  return SYMBOLS[first] ?? "plain"
}

// Splits the block text into lines with their meaning. One final newline does not make an extra empty line.
// Returns null when there is nothing to draw or the block is too long: the caller then uses the default render.
export function statoLines(text: unknown): StatoLine[] | null {
  if (typeof text !== "string") return null
  const body = text.replace(/\r\n?/g, "\n").replace(/\n$/, "")
  if (body === "") return null
  const lines = body.split("\n")
  if (lines.length > MAX_LINES) return null
  return lines.map((line) => ({ text: line, kind: statoKind(line) }))
}

// The slice of the theme this plugin reads: only the semantic text colours.
export type StatoTheme = {
  text?: {
    base?: unknown
    feedback?: Partial<Record<"success" | "error" | "warning" | "info", { base?: unknown } | undefined>>
  }
}

const FEEDBACK = { done: "success", broken: "error", progress: "warning", next: "info" } as const

// Colour token for a meaning, taken from the theme. A missing token falls back to the plain text colour.
// Returns undefined only when the theme has no text colour at all (the caller then sets no colour).
export function colourFor(kind: StatoKind, theme: StatoTheme | undefined): unknown {
  const text = theme?.text
  if (kind === "plain") return text?.base
  return text?.feedback?.[FEEDBACK[kind]]?.base ?? text?.base
}

// Text drawn for a line. An empty line becomes one space so the row keeps its height.
export function rowText(line: string): string {
  return line === "" ? " " : line
}

// Frame shown at a given time. It depends only on the clock, so every spinner on screen turns in step.
export function spinFrame(nowMs: number): string {
  const step = Math.floor(nowMs / SPIN_INTERVAL_MS)
  return SPIN_FRAMES[((step % SPIN_FRAMES.length) + SPIN_FRAMES.length) % SPIN_FRAMES.length]!
}

// Text drawn for a line. An in-progress line shows `frame` in place of its own symbol (`…`, `◐` or another frame);
// any other line is drawn as written. Indentation and the rest of the line are kept.
export function lineText(line: StatoLine, frame: string = PROGRESS_SYMBOL): string {
  if (line.kind !== "progress") return rowText(line.text)
  const indent = line.text.length - line.text.trimStart().length
  const symbol = Array.from(line.text.slice(indent))[0]!
  return line.text.slice(0, indent) + frame + line.text.slice(indent + symbol.length)
}

// ---- Which blocks belong to the latest assistant reply ----
// The renderer is handed only the markdown token (no message or part id), so the block is matched to the session's
// messages by its text. A block spins only if its text is in a `stato` block of the latest reply AND in none of the
// older replies: when the same text appears in both, it is unknown which one is on screen, and it stays still.

// Same text on both sides of a comparison: line endings and trailing blank space do not count.
export function blockKey(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\s+$/, "")
}

// Bodies of the ```stato fences in a markdown text (an unclosed fence runs to the end: the reply is still streaming).
// A stato example inside a longer fence of another language is not a block.
export function statoBlocks(markdown: unknown): string[] {
  if (typeof markdown !== "string") return []
  const blocks: string[] = []
  let fence: { mark: string; size: number; stato: boolean; body: string[] } | null = null
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence === null) {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (!open || (open[1]![0] === "`" && open[2]!.includes("`"))) continue
      const language = open[2]!.trim().split(/\s+/)[0]!.toLowerCase()
      fence = { mark: open[1]![0]!, size: open[1]!.length, stato: language === "stato", body: [] }
      continue
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
    if (close && close[1]![0] === fence.mark && close[1]!.length >= fence.size) {
      if (fence.stato) blocks.push(blockKey(fence.body.join("\n")))
      fence = null
    } else fence.body.push(line)
  }
  if (fence?.stato) blocks.push(blockKey(fence.body.join("\n")))
  return blocks
}

export type ReplyBlocks = { latest: ReadonlySet<string>; older: ReadonlySet<string> }

const NO_BLOCKS: ReplyBlocks = { latest: new Set(), older: new Set() }

// Message text parts of an assistant message; null when it is not an assistant message.
function assistantTexts(message: unknown): string[] | null {
  const item = message as { type?: unknown; content?: unknown } | null
  if (typeof item !== "object" || item === null || item.type !== "assistant" || !Array.isArray(item.content)) return null
  return item.content.flatMap((part: unknown) => {
    const piece = part as { type?: unknown; text?: unknown } | null
    return piece?.type === "text" && typeof piece.text === "string" ? [piece.text] : []
  })
}

// The stato blocks of the latest reply and of the older ones. The latest reply is the last visible assistant message
// that has text: a newer step with only tool calls does not end the spinner of the one before it. `revertID` hides
// that message and everything after it, like the session view does. `cache` keeps the blocks of older messages
// (they no longer change), so a long session is not parsed again on every tick; the latest message is always read fresh.
export function replyBlocks(messages: unknown, revertID?: unknown, cache?: WeakMap<object, Set<string>>): ReplyBlocks {
  if (!Array.isArray(messages)) return NO_BLOCKS
  let end = messages.length
  if (typeof revertID === "string") {
    const at = messages.findIndex((item) => (item as { id?: unknown } | null)?.id === revertID)
    if (at >= 0) end = at
  }
  let latestAt = -1
  for (let index = end - 1; index >= 0; index--) {
    if ((assistantTexts(messages[index])?.length ?? 0) > 0) {
      latestAt = index
      break
    }
  }
  if (latestAt < 0) return NO_BLOCKS
  const older = new Set<string>()
  for (let index = 0; index < latestAt; index++) {
    const message = messages[index]
    const texts = assistantTexts(message)
    if (!texts || texts.length === 0) continue
    let blocks = cache?.get(message as object)
    if (!blocks) {
      blocks = new Set(texts.flatMap(statoBlocks))
      cache?.set(message as object, blocks)
    }
    for (const block of blocks) older.add(block)
  }
  const latest = new Set((assistantTexts(messages[latestAt]) ?? []).flatMap(statoBlocks))
  return { latest, older }
}

// True when a block with this text should spin: it is in the latest reply and cannot be from an older one.
export function spinsIn(blocks: ReplyBlocks, blockText: unknown): boolean {
  if (typeof blockText !== "string") return false
  const key = blockKey(blockText)
  return blocks.latest.has(key) && !blocks.older.has(key)
}
