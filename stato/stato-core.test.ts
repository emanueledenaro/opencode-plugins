import { describe, expect, test } from "bun:test"
import {
  MAX_LINES,
  PROGRESS_SYMBOL,
  SPIN_FRAMES,
  SPIN_INTERVAL_MS,
  blockKey,
  colourFor,
  lineText,
  replyBlocks,
  rowText,
  spinFrame,
  spinsIn,
  statoBlocks,
  statoKind,
  statoLines,
} from "./stato-core"

describe("statoKind", () => {
  test("each of the four symbols has its own meaning", () => {
    expect(statoKind("✓ fatto")).toBe("done")
    expect(statoKind("✗ rotto")).toBe("broken")
    expect(statoKind("◐ in corso")).toBe("progress")
    expect(statoKind("➜ prossimo")).toBe("next")
  })
  test("the old in-progress symbol still counts, and so does every spin frame", () => {
    expect(statoKind("… in corso")).toBe("progress")
    for (const frame of SPIN_FRAMES) expect(statoKind(`${frame} in corso`)).toBe("progress")
  })
  test("the symbol alone on the line counts", () => {
    expect(statoKind("✓")).toBe("done")
    expect(statoKind("➜")).toBe("next")
  })
  test("leading spaces and tabs are skipped", () => {
    expect(statoKind("   ✗ rotto")).toBe("broken")
    expect(statoKind("\t◐ in corso")).toBe("progress")
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

describe("spinFrame", () => {
  test("goes through the four frames in order, one per interval", () => {
    expect(SPIN_FRAMES).toEqual(["◐", "◓", "◑", "◒"])
    expect([0, 1, 2, 3, 4].map((step) => spinFrame(step * SPIN_INTERVAL_MS))).toEqual(["◐", "◓", "◑", "◒", "◐"])
  })
  test("stays on one frame for the whole interval and changes at its end", () => {
    expect(spinFrame(0)).toBe(spinFrame(SPIN_INTERVAL_MS - 1))
    expect(spinFrame(SPIN_INTERVAL_MS - 1)).not.toBe(spinFrame(SPIN_INTERVAL_MS))
  })
  test("is about four frames per second", () => {
    expect(SPIN_INTERVAL_MS).toBe(250)
  })
  test("works for a huge clock value", () => {
    expect(SPIN_FRAMES).toContain(spinFrame(1_788_000_000_000))
  })
})

describe("lineText", () => {
  const line = (text: string) => ({ text, kind: statoKind(text) })
  test("the old symbol is shown as the still symbol", () => {
    expect(lineText(line("… controllo"))).toBe("◐ controllo")
    expect(PROGRESS_SYMBOL).toBe("◐")
  })
  test("an in-progress line takes the frame it is given", () => {
    expect(lineText(line("◐ controllo"), "◒")).toBe("◒ controllo")
    expect(lineText(line("… controllo"), "◑")).toBe("◑ controllo")
  })
  test("indentation and the rest of the line are kept", () => {
    expect(lineText(line("  \t… a … b ✓"), "◓")).toBe("  \t◓ a … b ✓")
  })
  test("a frame already on the line is replaced, not added", () => {
    expect(lineText(line("◓"), "◐")).toBe("◐")
  })
  test("other lines are drawn as written, empty ones as one space", () => {
    expect(lineText(line("✓ fatto"), "◓")).toBe("✓ fatto")
    expect(lineText(line("testo … libero"), "◓")).toBe("testo … libero")
    expect(lineText(line(""), "◓")).toBe(" ")
  })
})

describe("blockKey", () => {
  test("line endings and trailing blank space do not count", () => {
    expect(blockKey("◐ a\r\n✓ b\r\n\n")).toBe("◐ a\n✓ b")
    expect(blockKey("◐ a   ")).toBe("◐ a")
  })
  test("leading space and inner lines are kept", () => {
    expect(blockKey("  ◐ a\n\n✓ b")).toBe("  ◐ a\n\n✓ b")
  })
})

describe("statoBlocks", () => {
  test("takes the body of each stato fence", () => {
    expect(statoBlocks("Ecco.\n\n```stato\n✓ a\n◐ b\n```\n\ntesto\n\n```stato\n➜ c\n```\n")).toEqual(["✓ a\n◐ b", "➜ c"])
  })
  test("other languages and plain fences are not stato blocks", () => {
    expect(statoBlocks("```ts\n◐ a\n```\n```\n◐ b\n```\n```statoish\n◐ c\n```")).toEqual([])
  })
  test("the language is matched in any case and ignores words after it", () => {
    expect(statoBlocks("```Stato extra\n◐ a\n```")).toEqual(["◐ a"])
  })
  test("tilde fences and indented fences work", () => {
    expect(statoBlocks("~~~stato\n◐ a\n~~~")).toEqual(["◐ a"])
    expect(statoBlocks("   ```stato\n◐ a\n   ```")).toEqual(["◐ a"])
  })
  test("an unclosed fence runs to the end of the text (still streaming)", () => {
    expect(statoBlocks("```stato\n✓ a\n◐ b")).toEqual(["✓ a\n◐ b"])
  })
  test("a closing fence must be as long as the opening one and of the same kind", () => {
    expect(statoBlocks("````stato\n◐ a\n```\n◐ b\n````")).toEqual(["◐ a\n```\n◐ b"])
    expect(statoBlocks("```stato\n◐ a\n~~~\n◐ b\n```")).toEqual(["◐ a\n~~~\n◐ b"])
  })
  test("a stato example inside a fence of another language is not a block", () => {
    expect(statoBlocks("````md\n```stato\n◐ a\n```\n````")).toEqual([])
  })
  test("an empty fence is an empty block", () => {
    expect(statoBlocks("```stato\n```")).toEqual([""])
  })
  test("CRLF text works", () => {
    expect(statoBlocks("```stato\r\n◐ a\r\n```\r\n")).toEqual(["◐ a"])
  })
  test("anything that is not a string gives no blocks", () => {
    expect(statoBlocks(undefined)).toEqual([])
    expect(statoBlocks(42)).toEqual([])
  })
})

// Messages shaped like data.session.message.list() in OpenCode 2.2.6 (same shapes as the ask-box tests).
const stato = (body: string) => "```stato\n" + body + "\n```"
const reply = (id: string, ...texts: string[]) => ({
  id,
  type: "assistant",
  content: texts.map((text) => ({ type: "text", text })),
})
const tools = (id: string) => ({ id, type: "assistant", content: [{ type: "tool", name: "bash" }] })
const asked = (id: string) => ({ id, type: "user", text: "ciao" })

describe("replyBlocks and spinsIn", () => {
  const spin = (messages: unknown, text: string, revertID?: string) => spinsIn(replyBlocks(messages, revertID), text)

  test("a block in the latest reply spins", () => {
    expect(spin([asked("u"), reply("a", stato("◐ a"))], "◐ a")).toBe(true)
  })
  test("a block in an older reply does not spin once a newer reply has text", () => {
    const messages = [reply("a1", stato("◐ vecchio")), asked("u"), reply("a2", stato("◐ nuovo"))]
    expect(spin(messages, "◐ vecchio")).toBe(false)
    expect(spin(messages, "◐ nuovo")).toBe(true)
  })
  test("a newer reply with no text (only tool calls) does not stop the one before it", () => {
    const messages = [reply("a1", stato("◐ lavoro")), tools("a2")]
    expect(spin(messages, "◐ lavoro")).toBe(true)
  })
  test("a user message after the reply does not stop it: the latest assistant reply is still that one", () => {
    expect(spin([reply("a1", stato("◐ lavoro")), asked("u")], "◐ lavoro")).toBe(true)
  })
  test("the text must match: a block that is in no reply is still", () => {
    expect(spin([reply("a", stato("◐ a"))], "◐ altro")).toBe(false)
  })
  test("the same text in an older reply is ambiguous, so it stays still", () => {
    const messages = [reply("a1", stato("◐ controllo")), reply("a2", stato("◐ controllo"))]
    expect(spin(messages, "◐ controllo")).toBe(false)
  })
  test("the same text twice in the latest reply spins", () => {
    expect(spin([reply("a", stato("◐ x"), stato("◐ x"))], "◐ x")).toBe(true)
  })
  test("blocks are found in every text part of the latest reply", () => {
    const messages = [reply("a", "prima\n" + stato("✓ a"), "poi\n" + stato("◐ b"))]
    expect(spin(messages, "◐ b")).toBe(true)
    expect(spin(messages, "✓ a")).toBe(true)
  })
  test("only text parts count, not tool or reasoning parts", () => {
    const messages = [{ id: "a", type: "assistant", content: [{ type: "reasoning", text: stato("◐ r") }, { type: "text", text: "ok" }] }]
    expect(spin(messages, "◐ r")).toBe(false)
  })
  test("a reverted reply and everything after it are not on screen", () => {
    const messages = [reply("a1", stato("◐ uno")), asked("u"), reply("a2", stato("◐ due"))]
    expect(spin(messages, "◐ uno", "u")).toBe(true)
    expect(spin(messages, "◐ due", "u")).toBe(false)
  })
  test("an unknown revert id hides nothing", () => {
    expect(spin([reply("a", stato("◐ a"))], "◐ a", "nope")).toBe(true)
  })
  test("line endings and a trailing newline do not break the match", () => {
    expect(spin([reply("a", "```stato\r\n◐ a\r\n```")], "◐ a\n")).toBe(true)
  })
  test("no messages, no assistant reply, or garbage give no spinner and never throw", () => {
    expect(spin([], "◐ a")).toBe(false)
    expect(spin([asked("u")], "◐ a")).toBe(false)
    expect(spin(undefined, "◐ a")).toBe(false)
    expect(spin([null, 3, { type: "assistant" }, { type: "assistant", content: "x" }], "◐ a")).toBe(false)
    expect(spinsIn(replyBlocks([reply("a", stato("◐ a"))]), undefined)).toBe(false)
  })
  test("the cache gives the same answer and older messages are parsed once", () => {
    const old = reply("a1", stato("◐ vecchio"))
    const messages = [old, reply("a2", stato("◐ nuovo"))]
    const cache = new WeakMap<object, Set<string>>()
    expect(spinsIn(replyBlocks(messages, undefined, cache), "◐ vecchio")).toBe(false)
    expect(cache.has(old)).toBe(true)
    // a streaming latest reply is never cached: its new text is seen on the next call
    const latest = messages[1] as { content: { type: string; text: string }[] }
    latest.content[0]!.text = stato("◐ nuovo\n✓ altro")
    expect(spinsIn(replyBlocks(messages, undefined, cache), "◐ nuovo\n✓ altro")).toBe(true)
    expect(cache.has(latest)).toBe(false)
  })
})
