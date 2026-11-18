// OpenCode reloads only the files inside a plugin folder, so a helper two plugins need is copied into each.
// These tests keep the copies identical: change one, change all of them. They also keep what the plugins
// share in their look: one wording and one colour for a panel that cannot be drawn, one meaning for the
// theme's warning colour, one pace for a clock that shows minutes.
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

/** The lines of code (not comments) of a file. */
const codeLines = (file: string): string[] =>
  readFileSync(join(import.meta.dir, file), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))

describe("the theme's warning colour means one thing: it waits for you", () => {
  // In the owner's theme the warning colour is orange. A caution level (the middle of a scale, a slow
  // reply) is the theme's yellow hue, with the warning colour only as the fallback of a theme without hues.
  // The number is how many lines of each tui file read the warning colour directly, and what for.
  const direct: Record<string, number> = {
    "agents-panel/tui.tsx": 1, // groupColour("waiting"): the "Ti aspetta" group and "1 ti aspetta" in the header
    "ask-box/tui.tsx": 1, // the "Serve da te" title
    "plan-banner/tui.tsx": 1, // the Plan line: your next message runs under Plan until you switch
    "claude-usage/tui.tsx": 1, // waitsForYou(): "accesso scaduto, apri claude" in the footer and the dialog
    "token-rate/tui.tsx": 0,
    "quote/tui.tsx": 0,
    "notify/tui.tsx": 0,
  }

  test("no tui file draws it for anything else", () => {
    const found = Object.fromEntries(
      Object.keys(direct).map((file) => [
        file,
        codeLines(file).filter((line) => /feedback\??\.warning/.test(line) && !/\bhue\b/.test(line)).length,
      ]),
    )
    expect(found).toEqual(direct)
  })

  test("a caution level takes the yellow hue first", () => {
    const tokenRate = codeLines("token-rate/tui.tsx").filter((line) => /feedback\??\.warning/.test(line))
    expect(tokenRate).toEqual(["return pick(theme.hue?.yellow?.[200]) ?? pick(theme.text?.feedback?.warning) ?? pick(theme.text?.base)"])
    expect(functionText("claude-usage/claude-usage-core.ts", "levelColour")).toContain("theme.hue?.[look.hue]?.[200]")
    expect(codeLines("claude-usage/tui.tsx")).toContain("const colour = (level: Level) => levelColour(level, theme as unknown as LevelTheme)")
  })
})

describe("a clock that shows minutes moves twice a minute", () => {
  // Every tick redraws the rows that read it. Times are written in minutes ("12m", "da 2m"), so a faster
  // clock redraws the same text.
  test("in every plugin that has one", () => {
    const clocks = {
      "agents-panel/tui.tsx": "CLOCK_MS",
      "ask-box/tui.tsx": "CLOCK_MS",
      "claude-usage/tui.tsx": "TICK_MS",
    }
    for (const [file, name] of Object.entries(clocks)) {
      const lines = codeLines(file)
      const value = lines.flatMap((line) => line.match(new RegExp(`^const ${name} = ([0-9_]+)`))?.[1] ?? [])
      expect({ file, value }).toEqual({ file, value: ["30_000"] })
      // The constant is the one the timer runs on, not a leftover.
      const used = lines.some((line) => line.includes(name) && /setInterval\(|Math\.min\(/.test(line))
      expect({ file, used }).toEqual({ file, used: true })
    }
  })
})
