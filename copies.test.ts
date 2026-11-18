// OpenCode reloads only the files inside a plugin folder, so a helper two plugins need is copied into each.
// These tests keep the copies identical: change one, change all of them. They also keep one wording and one
// colour for the line a plugin shows when its panel cannot be drawn.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** The text of `export function <name>(` up to the closing brace at the start of a line, or undefined. */
const functionText = (file: string, name: string): string | undefined => {
  const text = readFileSync(join(import.meta.dir, file), "utf8")
  const start = text.indexOf(`export function ${name}(`)
  const end = text.indexOf("\n}\n", start)
  return start === -1 || end === -1 ? undefined : text.slice(start, end + 2)
}

const expectSameCopies = (name: string, files: string[]) => {
  const copies = Object.fromEntries(files.map((file) => [file, functionText(file, name)]))
  expect(copies[files[0]!]).toBeString()
  expect(copies).toEqual(Object.fromEntries(files.map((file) => [file, copies[files[0]!]])))
}

describe("copied helpers stay identical", () => {
  test("createWidthTracker", () => {
    expectSameCopies("createWidthTracker", [
      "quote/quote-core.ts",
      "claude-usage/claude-usage-core.ts",
      "agents-panel/agents-core.ts",
      "plan-banner/plan-banner-core.ts",
      "ask-box/ask-box-core.ts",
    ])
  })

  test("createResizeWatch", () => {
    expectSameCopies("createResizeWatch", ["token-rate/token-rate-core.ts", "claude-usage/claude-usage-core.ts"])
  })

  // One time format in every panel: "<1m", "12m", "1h 5m", "2g 3h".
  test("relativeIt", () => {
    expectSameCopies("relativeIt", ["agents-panel/agents-core.ts", "claude-usage/claude-usage-core.ts", "ask-box/ask-box-core.ts"])
  })
})

/** Every `<ErrorBoundary fallback={...}>` of a tui file: the text it shows and the colour expression of that text. */
const fallbacks = (file: string): { text: string; colour: string }[] => {
  const source = readFileSync(join(import.meta.dir, file), "utf8")
  return [...source.matchAll(/<ErrorBoundary fallback=\{.*?<text fg=\{([^}]+)\}[^>]*>\{"([^"]+)"\}<\/text>/g)].map(
    ([, colour, text]) => ({ text: text!, colour: colour! }),
  )
}

describe("a panel that cannot be drawn says so the same way in every plugin", () => {
  // The first line of each plugin is the one drawn in its slot, the second (if any) the one of its dialog.
  const expected: Record<string, string[]> = {
    "agents-panel/tui.tsx": ["Subagenti: non disponibile"],
    "ask-box/tui.tsx": ["Serve da te: non disponibile"],
    "plan-banner/tui.tsx": ["Avviso Plan: non disponibile"],
    "quote/tui.tsx": ["Citazioni: non disponibile"],
    "claude-usage/tui.tsx": ["Claude: uso non disponibile", "Uso non disponibile."],
    "token-rate/tui.tsx": ["tok/s: non disponibile", "Velocità non disponibile."],
  }

  test("the wording is '<name>: non disponibile' in a slot and '<Name> non disponibile.' in a dialog", () => {
    for (const [file, texts] of Object.entries(expected)) {
      expect({ file, texts: fallbacks(file).map((each) => each.text) }).toEqual({ file, texts })
      expect(texts[0]).toMatch(/^[^:]+: (uso )?non disponibile$/)
      if (texts[1] !== undefined) expect(texts[1]).toMatch(/^\S+ non disponibile\.$/)
    }
  })

  test("the line is faint: the warning colour means 'waits for you' and is never used for it", () => {
    for (const file of Object.keys(expected)) {
      for (const each of fallbacks(file)) {
        expect({ file, colour: each.colour }).toEqual({ file, colour: expect.stringContaining("faint") })
        expect(each.colour).not.toContain("warning")
      }
    }
  })
})
