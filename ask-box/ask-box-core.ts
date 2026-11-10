// Pure logic of the ask-box plugin: find the last "Serve da te:" block in the assistant's replies,
// clean it and cap it. No I/O and no OpenCode imports, so it is tested with plain objects.
// The message shapes are the ones OpenCode 2.2.6 returns from data.session.message.list():
//   { type: "user", text }  { type: "assistant", content: [{ type: "text", text }, ...] }
// plus other types (idle, synthetic, agent-switched) that this plugin ignores.

export const MAX_ASK_LINES = 8
export const MARKER = "Serve da te"

export type Turn = { role: "user" | "assistant"; text: string }

// "Serve da te" at the start of a line, optionally wrapped in markdown (#, >, **, `) and followed by ":".
const MARKER_LINE = /^[\s>#*_`-]*serve da te\s*[*_`]*\s*:(?:\*\*|__|`)?\s*(.*)$/i
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
  const first = MARKER_LINE.exec(lines[start]!)?.[1]?.trim() ?? ""
  if (first !== "") block.push(first)

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

// At most MAX_ASK_LINES lines once wrapped at `width`; a cut ends with an ellipsis that still fits.
export function capAsk(text: string, width: number): string {
  const lines = wrapLines(text, width)
  if (lines.length <= MAX_ASK_LINES) return lines.join("\n")
  const kept = lines.slice(0, MAX_ASK_LINES)
  const last = kept[MAX_ASK_LINES - 1]!
  kept[MAX_ASK_LINES - 1] = `${last.slice(0, Math.max(0, width - 1)).trimEnd()}…`
  return kept.join("\n")
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

// The ask to show: the latest one in an assistant reply that came after the owner's last message.
// Walks backwards and stops at the first user message, so long sessions cost the same as short ones.
// A reply still streaming is skipped, so its text is not read on every token.
export function currentAsk(messages: unknown, revertID?: unknown): string | null {
  if (!Array.isArray(messages)) return null
  for (let index = visibleEnd(messages, revertID) - 1; index >= 0; index--) {
    const item = messages[index] as
      | { type?: unknown; content?: unknown; time?: { completed?: unknown } | null }
      | null
    if (typeof item !== "object" || item === null) continue
    if (item.type === "user") return null
    if (item.type !== "assistant" || !Array.isArray(item.content)) continue
    if (item.time && typeof item.time === "object" && !item.time.completed) continue
    const text = item.content
      .flatMap((part: unknown) => {
        const piece = part as { type?: unknown; text?: unknown } | null
        return piece?.type === "text" && typeof piece.text === "string" ? [piece.text] : []
      })
      .join("\n")
    const ask = extractAsk(text)
    if (ask !== null) return ask
  }
  return null
}
