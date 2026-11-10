import { describe, expect, test } from "bun:test"
import { MAX_LINES, PROGRESS_SYMBOL, colourFor, lineText, rowText, statoKind, statoLines } from "./stato-core"

describe("statoKind", () => {
  test("each of the four symbols has its own meaning", () => {
    expect(statoKind("✓ fatto")).toBe("done")
    expect(statoKind("✗ rotto")).toBe("broken")
    expect(statoKind("≈ in corso")).toBe("progress")
    expect(statoKind("➜ prossimo")).toBe("next")
  })
  test("the earlier in-progress symbols ◐ and … still count", () => {
    expect(statoKind("◐ in corso")).toBe("progress")
    expect(statoKind("… in corso")).toBe("progress")
    expect(statoKind("  … in corso")).toBe("progress")
  })
  test("similar-looking symbols are not in progress", () => {
    expect(statoKind("~ circa")).toBe("plain")
    expect(statoKind("≠ diverso")).toBe("plain")
  })
  test("the symbol alone on the line counts", () => {
    expect(statoKind("✓")).toBe("done")
    expect(statoKind("➜")).toBe("next")
  })
  test("leading spaces and tabs are skipped", () => {
    expect(statoKind("   ✗ rotto")).toBe("broken")
    expect(statoKind("\t≈ in corso")).toBe("progress")
  })
  test("only the first symbol decides", () => {
    expect(statoKind("✓ fatto ✗ non rotto")).toBe("done")
    expect(statoKind("riga con ✓ in mezzo")).toBe("plain")
  })
  test("an unknown first character is plain", () => {
    expect(statoKind("? dubbio")).toBe("plain")
    expect(statoKind("- elenco")).toBe("plain")
    expect(statoKind("✔ altro segno")).toBe("plain")
    expect(statoKind("... tre punti ascii")).toBe("plain")
  })
  test("an empty or blank line is plain", () => {
    expect(statoKind("")).toBe("plain")
    expect(statoKind("   ")).toBe("plain")
  })
  test("anything that is not a string is plain", () => {
    expect(statoKind(undefined)).toBe("plain")
    expect(statoKind(null)).toBe("plain")
    expect(statoKind(42)).toBe("plain")
  })
})

describe("statoLines", () => {
  test("splits into lines and gives each its meaning", () => {
    expect(statoLines("✓ a\n✗ b\nc")).toEqual([
      { text: "✓ a", kind: "done" },
      { text: "✗ b", kind: "broken" },
      { text: "c", kind: "plain" },
    ])
  })
  test("CRLF and lone CR are line breaks", () => {
    expect(statoLines("✓ a\r\n✗ b\r… c")?.map((line) => line.kind)).toEqual(["done", "broken", "progress"])
  })
  test("one final newline does not add an empty line", () => {
    expect(statoLines("✓ a\n")).toHaveLength(1)
  })
  test("empty lines inside the block are kept as plain lines", () => {
    expect(statoLines("✓ a\n\n✗ b")?.map((line) => line.kind)).toEqual(["done", "plain", "broken"])
  })
  test("a second trailing newline is one kept empty line", () => {
    expect(statoLines("✓ a\n\n")).toEqual([
      { text: "✓ a", kind: "done" },
      { text: "", kind: "plain" },
    ])
  })
  test("an empty block gives null so the default render is used", () => {
    expect(statoLines("")).toBeNull()
    expect(statoLines("\n")).toBeNull()
  })
  test("a block with exactly MAX_LINES lines is drawn, one more is not", () => {
    expect(statoLines(Array.from({ length: MAX_LINES }, () => "✓ a").join("\n"))).toHaveLength(MAX_LINES)
    expect(statoLines(Array.from({ length: MAX_LINES + 1 }, () => "✓ a").join("\n"))).toBeNull()
  })
  test("anything that is not a string gives null", () => {
    expect(statoLines(undefined)).toBeNull()
    expect(statoLines({})).toBeNull()
  })
})

// A theme shaped like the one OpenCode passes: every token has a distinct value so a mix-up shows.
const theme = {
  text: {
    base: "BASE",
    feedback: {
      success: { base: "OK" },
      error: { base: "ERR" },
      warning: { base: "WARN" },
      info: { base: "INFO" },
    },
  },
}

describe("colourFor", () => {
  test("each meaning reads its own feedback token", () => {
    expect(colourFor("done", theme)).toBe("OK")
    expect(colourFor("broken", theme)).toBe("ERR")
    expect(colourFor("progress", theme)).toBe("WARN")
    expect(colourFor("next", theme)).toBe("INFO")
  })
  test("plain uses the default text colour", () => {
    expect(colourFor("plain", theme)).toBe("BASE")
  })
  test("a missing feedback token falls back to the text colour", () => {
    expect(colourFor("done", { text: { base: "BASE", feedback: { error: { base: "ERR" } } } })).toBe("BASE")
    expect(colourFor("next", { text: { base: "BASE" } })).toBe("BASE")
  })
  test("a theme without text colours gives undefined, and never throws", () => {
    expect(colourFor("done", {})).toBeUndefined()
    expect(colourFor("plain", undefined)).toBeUndefined()
  })
})

describe("rowText", () => {
  test("an empty line becomes one space so the row keeps its height", () => {
    expect(rowText("")).toBe(" ")
  })
  test("other lines are left as they are, indentation included", () => {
    expect(rowText("  ✓ a")).toBe("  ✓ a")
  })
})

describe("lineText", () => {
  const line = (text: string) => ({ text, kind: statoKind(text) })
  test("the in-progress symbol is ≈ (U+2248)", () => {
    expect(PROGRESS_SYMBOL).toBe("≈")
    expect(PROGRESS_SYMBOL.codePointAt(0)).toBe(0x2248)
  })
  test("a … line is drawn with ≈ in its place", () => {
    expect(lineText(line("… controllo"))).toBe("≈ controllo")
  })
  test("a ◐ line is drawn with ≈ in its place", () => {
    expect(lineText(line("◐ controllo"))).toBe("≈ controllo")
  })
  test("a ≈ line is drawn as written", () => {
    expect(lineText(line("≈ controllo"))).toBe("≈ controllo")
  })
  test("indentation and the rest of the line are kept, a later … or ◐ stays", () => {
    expect(lineText(line("  \t… a … b ◐"))).toBe("  \t≈ a … b ◐")
  })
  test("a symbol alone on the line is replaced", () => {
    expect(lineText(line("…"))).toBe("≈")
    expect(lineText(line("◐"))).toBe("≈")
  })
  test("other lines are drawn as written, empty ones as one space", () => {
    expect(lineText(line("✓ fatto"))).toBe("✓ fatto")
    expect(lineText(line("testo … libero"))).toBe("testo … libero")
    expect(lineText(line("➜ poi …"))).toBe("➜ poi …")
    expect(lineText(line(""))).toBe(" ")
  })
})
