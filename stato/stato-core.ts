// Pure logic of the stato plugin: which meaning a line has, and which theme token draws it.
// Nothing here touches OpenTUI, the disk or the network, so all of it is tested with `bun test`.

export type StatoKind = "done" | "broken" | "progress" | "next" | "plain"

// The in-progress symbol that is drawn (U+2248, one column wide).
export const PROGRESS_SYMBOL = "≈"

// First symbol of a line -> meaning. The four symbols of the status replies. `◐` and `…` are earlier in-progress
// symbols, still recognised so old messages keep their colour.
const SYMBOLS: Record<string, StatoKind | undefined> = {
  "✓": "done",
  "✗": "broken",
  [PROGRESS_SYMBOL]: "progress",
  "◐": "progress",
  "…": "progress",
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

// Text drawn for a line: an in-progress line shows `≈` in place of its own symbol (`◐` or `…` in older messages), with the
// indentation and the rest of the line kept; any other line is drawn as written.
export function lineText(line: StatoLine): string {
  if (line.kind !== "progress") return rowText(line.text)
  const indent = line.text.length - line.text.trimStart().length
  const symbol = Array.from(line.text.slice(indent))[0]!
  return line.text.slice(0, indent) + PROGRESS_SYMBOL + line.text.slice(indent + symbol.length)
}
