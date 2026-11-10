import { describe, expect, test } from "bun:test"
import {
  CHIP_PREVIEW_CHARS,
  CHIP_PREVIEW_WITH_COMMENT_CHARS,
  COMMENT_PREVIEW_CHARS,
  MAX_COMMENT_CHARS,
  MAX_QUOTES,
  MAX_QUOTE_CHARS,
  PENDING_TTL_MS,
  QUOTE_COMMENT_DESCRIPTION,
  QUOTE_DESCRIPTION,
  QUOTE_NAME,
  TRUNCATION_NOTE,
  addPending,
  applyQuoteToPrompt,
  attachmentDescription,
  attachmentName,
  buildQuoteDataUri,
  capQuote,
  capQuotes,
  chipSummary,
  clearPending,
  commentPreview,
  dialogPreview,
  formatAttachment,
  loadPending,
  normalizeComment,
  normalizeSelection,
  parsePending,
  pendingFileName,
  pendingRoom,
  removePending,
  rowSummary,
  sameList,
  selectionFresh,
  serializePending,
  type PendingFs,
  type PendingQuote,
} from "./quote-core"

const NOW = Date.parse("2026-11-10T12:00:00Z")
const DIR = "/state/quote-pending"
const SID = "ses_abc123XYZ"
const PATH = `${DIR}/ses_abc123XYZ.json`
const NOTE = "[citazione troncata]"

// An in-memory stand-in for the quote-pending folder. It records every path it is asked to touch.
const fakeFs = (initial: Record<string, string> = {}) => {
  const files = new Map(Object.entries(initial))
  const touched: string[] = []
  const fs: PendingFs & {
    files: Map<string, string>
    touched: string[]
    failRead?: boolean
    failRemove?: boolean
    failWrite?: boolean
  } = {
    dir: DIR,
    files,
    touched,
    read(path) {
      touched.push(path)
      if (fs.failRead) throw new Error("boom read")
      return files.get(path)
    },
    write(path, data) {
      touched.push(path)
      if (fs.failWrite) throw new Error("boom write")
      files.set(path, data)
    },
    remove(path) {
      touched.push(path)
      if (fs.failRemove) throw new Error("boom remove")
      files.delete(path)
    },
  }
  return fs
}

const decode = (uri: string) => {
  const prefix = "data:text/plain;base64,"
  expect(uri.startsWith(prefix)).toBe(true)
  return Buffer.from(uri.slice(prefix.length), "base64").toString("utf8")
}

const v1 = (text: string, createdAt: number) => JSON.stringify({ v: 1, text, createdAt })
const v2 = (quotes: unknown, createdAt: number) => JSON.stringify({ v: 2, quotes, createdAt })
const v3 = (quotes: unknown, createdAt: number = NOW) => JSON.stringify({ v: 3, quotes, createdAt })
const Q = (text: string, comment = ""): PendingQuote => ({ text, comment })
const many = (...items: (string | PendingQuote)[]): PendingQuote[] => items.map((item) => (typeof item === "string" ? Q(item) : item))
const ser = (items: (string | PendingQuote)[], now: number = NOW) => serializePending(many(...items), now)
const stored = (fs: ReturnType<typeof fakeFs>) => JSON.parse(fs.files.get(PATH) ?? "null")

describe("pendingFileName", () => {
  test("builds <sessionID>.json for a normal session ID", () => {
    expect(pendingFileName(SID)).toBe("ses_abc123XYZ.json")
  })
  test("rejects path tricks and odd characters", () => {
    for (const bad of ["../x", "ses_a/b", "ses_a\\b", "ses_..", "ses_a b", "ses_a\0b", "ses_", "", ".json", "ses_é"]) {
      expect(pendingFileName(bad)).toBeNull()
    }
  })
  test("rejects IDs that do not start with ses and very long IDs", () => {
    expect(pendingFileName("abc_123")).toBeNull()
    expect(pendingFileName("ses_" + "a".repeat(200))).toBeNull()
  })
  test("rejects non strings", () => {
    expect(pendingFileName(undefined)).toBeNull()
    expect(pendingFileName(42)).toBeNull()
    expect(pendingFileName({})).toBeNull()
    expect(pendingFileName({ toString: () => "ses_abc" })).toBeNull()
  })
})

describe("normalizeSelection", () => {
  test("keeps the text and trims trailing whitespace", () => {
    expect(normalizeSelection("ciao mondo \n\n")).toBe("ciao mondo")
  })
  test("keeps leading indentation of the first line", () => {
    expect(normalizeSelection("  indent\nsecond")).toBe("  indent\nsecond")
  })
  test("turns CRLF into LF", () => {
    expect(normalizeSelection("a\r\nb")).toBe("a\nb")
  })
  test("returns null for empty, blank or non string input", () => {
    expect(normalizeSelection("")).toBeNull()
    expect(normalizeSelection("  \n\t ")).toBeNull()
    expect(normalizeSelection(undefined)).toBeNull()
    expect(normalizeSelection(7)).toBeNull()
  })
})

describe("capQuote", () => {
  test("leaves a short quote alone", () => {
    expect(capQuote("abc")).toEqual({ text: "abc", truncated: false })
  })
  test("keeps exactly the limit untouched", () => {
    const text = "x".repeat(MAX_QUOTE_CHARS)
    expect(capQuote(text)).toEqual({ text, truncated: false })
  })
  test("cuts a longer quote to the limit and says so", () => {
    const result = capQuote("x".repeat(MAX_QUOTE_CHARS + 1))
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith("x".repeat(MAX_QUOTE_CHARS))).toBe(true)
    expect(result.text.length).toBeGreaterThan(MAX_QUOTE_CHARS)
    expect(result.text.endsWith("[citazione troncata]")).toBe(true)
  })
  test("never splits a surrogate pair at the cut", () => {
    const text = "x".repeat(MAX_QUOTE_CHARS - 1) + "😀" + "tail"
    const result = capQuote(text)
    expect(result.truncated).toBe(true)
    const body = result.text.replace(/\n\n\[citazione troncata\]$/, "")
    expect(body).toBe("x".repeat(MAX_QUOTE_CHARS - 1))
  })
})

describe("normalizeComment", () => {
  test("trims the comment", () => {
    expect(normalizeComment("  bel punto  ")).toBe("bel punto")
  })
  test("turns line breaks into single spaces", () => {
    expect(normalizeComment("uno\r\ndue\n\n  tre")).toBe("uno due tre")
  })
  test("blank and non string input give an empty comment", () => {
    expect(normalizeComment("")).toBe("")
    expect(normalizeComment("  \n ")).toBe("")
    expect(normalizeComment(undefined)).toBe("")
    expect(normalizeComment(5)).toBe("")
    expect(normalizeComment({ toString: () => "x" })).toBe("")
  })
  test("keeps exactly the maximum and cuts one more, without any note", () => {
    expect(MAX_COMMENT_CHARS).toBe(2000)
    expect(normalizeComment("c".repeat(2000))).toBe("c".repeat(2000))
    expect(normalizeComment("c".repeat(2001))).toBe("c".repeat(2000))
    expect(normalizeComment("c".repeat(5000))).toBe("c".repeat(2000))
  })
  test("never splits a surrogate pair at the cut", () => {
    expect(normalizeComment("c".repeat(1999) + "😀" + "x")).toBe("c".repeat(1999))
  })
})

describe("capQuotes (one budget shared by all quotes and comments)", () => {
  test("leaves quotes under the budget alone", () => {
    expect(capQuotes(many("uno", "due"))).toEqual({ quotes: many("uno", "due"), truncated: false })
  })
  test("an empty list stays empty", () => {
    expect(capQuotes([])).toEqual({ quotes: [], truncated: false })
  })
  test("keeps quotes that add up to exactly the budget", () => {
    const list = many("a".repeat(10_000), "b".repeat(10_000))
    expect(capQuotes(list)).toEqual({ quotes: list, truncated: false })
  })
  test("cuts the later quote when the total goes over, and says so", () => {
    const result = capQuotes(many("a".repeat(15_000), "b".repeat(10_000)))
    expect(result.truncated).toBe(true)
    expect(result.quotes[0]).toEqual(Q("a".repeat(15_000)))
    expect(result.quotes[1]).toEqual(Q(`${"b".repeat(5_000)}\n\n${NOTE}`))
  })
  test("quotes after the budget is used up keep their place with only the note", () => {
    const result = capQuotes(many("a".repeat(MAX_QUOTE_CHARS), "tre", "quattro"))
    expect(result.truncated).toBe(true)
    expect(result.quotes).toEqual(many("a".repeat(MAX_QUOTE_CHARS), NOTE, NOTE))
  })
  test("the first quote alone is cut at the budget like capQuote", () => {
    const result = capQuotes(many("z".repeat(MAX_QUOTE_CHARS + 5), "dopo"))
    expect(result.quotes).toEqual(many(capQuote("z".repeat(MAX_QUOTE_CHARS + 5)).text, NOTE))
  })
  test("never splits a surrogate pair at the shared cut", () => {
    const result = capQuotes(many("a".repeat(19_000), "b".repeat(999) + "😀" + "tail"))
    expect(result.quotes[1]).toEqual(Q(`${"b".repeat(999)}\n\n${NOTE}`))
  })
  test("applying it twice changes nothing", () => {
    const once = capQuotes(many("a".repeat(15_000), "b".repeat(10_000), "c"))
    expect(capQuotes(once.quotes).quotes).toEqual(once.quotes)
  })

  test("the comment counts against the budget", () => {
    const result = capQuotes([Q("a".repeat(15_000), "c".repeat(2_000)), Q("b".repeat(10_000))])
    expect(result.truncated).toBe(true)
    expect(result.quotes[0]).toEqual(Q("a".repeat(15_000), "c".repeat(2_000)))
    expect(result.quotes[1]).toEqual(Q(`${"b".repeat(3_000)}\n\n${NOTE}`))
  })
  test("a quote and comment that add up to exactly the budget are untouched", () => {
    const list = [Q("a".repeat(18_000), "c".repeat(2_000))]
    expect(capQuotes(list)).toEqual({ quotes: list, truncated: false })
  })
  test("one character over: the quote text is cut and the comment is kept whole", () => {
    const result = capQuotes([Q("a".repeat(18_001), "c".repeat(2_000))])
    expect(result.truncated).toBe(true)
    expect(result.quotes[0]).toEqual(Q(`${"a".repeat(18_000)}\n\n${NOTE}`, "c".repeat(2_000)))
  })
  test("a quote that is over only because of its comment keeps the comment", () => {
    const result = capQuotes([Q("a".repeat(19_000), "c".repeat(2_000))])
    expect(result.quotes[0]).toEqual(Q(`${"a".repeat(18_000)}\n\n${NOTE}`, "c".repeat(2_000)))
  })
  test("later quotes lose their comment once the budget is used up", () => {
    const result = capQuotes([Q("a".repeat(MAX_QUOTE_CHARS)), Q("x", "mio commento")])
    expect(result.quotes[1]).toEqual(Q(NOTE, ""))
  })
  test("when less budget is left than the comment, the comment is cut and the text is just the note", () => {
    const result = capQuotes([Q("a".repeat(19_999)), Q("x", "c".repeat(50))])
    expect(result.quotes[1]).toEqual(Q(NOTE, "c"))
  })
  test("never splits a surrogate pair when cutting a comment", () => {
    const result = capQuotes([Q("a".repeat(19_997)), Q("x", "😀😀")])
    expect(result.quotes[1]).toEqual(Q("x", "😀"))
  })
  test("applying it twice changes nothing, comments included", () => {
    const once = capQuotes([Q("a".repeat(19_000), "c".repeat(2_000)), Q("b", "d"), Q("e", "f")])
    expect(capQuotes(once.quotes).quotes).toEqual(once.quotes)
  })
})

describe("chipSummary", () => {
  test("short single line quote", () => {
    expect(chipSummary("ciao")).toEqual({ preview: "«ciao»", lines: 1, lineLabel: "" })
  })
  test("truncates the preview at the limit with an ellipsis", () => {
    const summary = chipSummary("a".repeat(CHIP_PREVIEW_CHARS + 20))
    expect(summary.preview).toBe(`«${"a".repeat(CHIP_PREVIEW_CHARS)}…»`)
  })
  test("does not add an ellipsis at exactly the limit", () => {
    expect(chipSummary("a".repeat(CHIP_PREVIEW_CHARS)).preview).toBe(`«${"a".repeat(CHIP_PREVIEW_CHARS)}»`)
  })
  test("collapses newlines and runs of spaces in the preview", () => {
    expect(chipSummary("uno\n  due\n\ntre").preview).toBe("«uno due tre»")
  })
  test("counts lines and labels them when more than one", () => {
    expect(chipSummary("a\nb\nc")).toEqual({ preview: "«a b c»", lines: 3, lineLabel: "3 righe" })
  })
  test("ignores trailing newlines when counting", () => {
    expect(chipSummary("a\nb\n\n").lines).toBe(2)
  })
  test("does not cut a surrogate pair in the preview", () => {
    const summary = chipSummary("a".repeat(CHIP_PREVIEW_CHARS - 1) + "😀😀")
    expect(summary.preview).toBe(`«${"a".repeat(CHIP_PREVIEW_CHARS - 1)}😀…»`)
  })
  test("takes a custom preview length", () => {
    expect(chipSummary("abcdefghij", 4).preview).toBe("«abcd…»")
    expect(chipSummary("abcd", 4).preview).toBe("«abcd»")
  })
})

describe("commentPreview", () => {
  test("is empty without a comment", () => {
    expect(commentPreview("")).toBe("")
  })
  test("shows a short comment as it is", () => {
    expect(commentPreview("bel punto")).toBe("bel punto")
  })
  test("shortens at the limit with an ellipsis, not before", () => {
    expect(COMMENT_PREVIEW_CHARS).toBe(30)
    expect(commentPreview("c".repeat(COMMENT_PREVIEW_CHARS))).toBe("c".repeat(COMMENT_PREVIEW_CHARS))
    expect(commentPreview("c".repeat(COMMENT_PREVIEW_CHARS + 1))).toBe(`${"c".repeat(COMMENT_PREVIEW_CHARS)}…`)
  })
  test("collapses whitespace and does not cut a surrogate pair", () => {
    expect(commentPreview("uno\n  due")).toBe("uno due")
    expect(commentPreview("c".repeat(COMMENT_PREVIEW_CHARS - 1) + "😀😀")).toBe(`${"c".repeat(COMMENT_PREVIEW_CHARS - 1)}😀…`)
  })
})

describe("rowSummary", () => {
  test("a quote without comment uses the long preview and has no comment text", () => {
    const row = rowSummary(Q("a".repeat(CHIP_PREVIEW_CHARS + 5)))
    expect(row.preview).toBe(`«${"a".repeat(CHIP_PREVIEW_CHARS)}…»`)
    expect(row.comment).toBe("")
  })
  test("a quote with a comment uses the shorter preview and the shortened comment", () => {
    expect(CHIP_PREVIEW_WITH_COMMENT_CHARS).toBeLessThan(CHIP_PREVIEW_CHARS)
    const row = rowSummary(Q("a".repeat(CHIP_PREVIEW_CHARS), "c".repeat(100)))
    expect(row.preview).toBe(`«${"a".repeat(CHIP_PREVIEW_WITH_COMMENT_CHARS)}…»`)
    expect(row.comment).toBe(`${"c".repeat(COMMENT_PREVIEW_CHARS)}…`)
  })
  test("carries the line label", () => {
    expect(rowSummary(Q("a\nb")).lineLabel).toBe("2 righe")
    expect(rowSummary(Q("a")).lineLabel).toBe("")
  })
})

describe("dialogPreview", () => {
  test("is the preview of the quote", () => {
    expect(dialogPreview("ciao")).toBe("«ciao»")
  })
  test("adds the line count in brackets for several lines", () => {
    expect(dialogPreview("a\nb\nc")).toBe("«a b c» (3 righe)")
  })
  test("uses the long preview length", () => {
    expect(dialogPreview("a".repeat(CHIP_PREVIEW_CHARS + 1))).toBe(`«${"a".repeat(CHIP_PREVIEW_CHARS)}…»`)
  })
})

describe("attachmentName", () => {
  test("a single quote is just Citazione", () => {
    expect(attachmentName(0, 1)).toBe("Citazione")
    expect(QUOTE_NAME).toBe("Citazione")
  })
  test("several quotes are numbered from 1 in order", () => {
    expect(attachmentName(0, 2)).toBe("Citazione 1")
    expect(attachmentName(1, 2)).toBe("Citazione 2")
    expect(attachmentName(4, 5)).toBe("Citazione 5")
  })
})

describe("formatAttachment", () => {
  test("without a comment it is just the quote text", () => {
    expect(formatAttachment(Q("riga uno\nriga due"))).toBe("riga uno\nriga due")
  })
  test("with a comment it labels both parts", () => {
    expect(formatAttachment(Q("il testo", "il mio parere"))).toBe("Commento:\nil mio parere\n\nTesto citato:\nil testo")
  })
  test("keeps the lines of a multi line quote", () => {
    expect(formatAttachment(Q("a\nb", "c"))).toBe("Commento:\nc\n\nTesto citato:\na\nb")
  })
})

describe("attachmentDescription", () => {
  test("says what the file holds, with and without a comment", () => {
    expect(QUOTE_DESCRIPTION).toBe("Testo citato dall'utente nella conversazione")
    expect(QUOTE_COMMENT_DESCRIPTION).toBe("Testo citato dall'utente e il suo commento su questo pezzo")
    expect(attachmentDescription(Q("t"))).toBe(QUOTE_DESCRIPTION)
    expect(attachmentDescription(Q("t", "c"))).toBe(QUOTE_COMMENT_DESCRIPTION)
  })
})

describe("buildQuoteDataUri", () => {
  test("is a text/plain base64 data URI that decodes to the quote", () => {
    expect(decode(buildQuoteDataUri(Q("ciao\nmondo")))).toBe("ciao\nmondo")
  })
  test("includes the comment in the labelled format", () => {
    expect(decode(buildQuoteDataUri(Q("testo", "commento")))).toBe("Commento:\ncommento\n\nTesto citato:\ntesto")
  })
  test("round trips unicode", () => {
    expect(decode(buildQuoteDataUri(Q("è così, 日本語 😀", "già 😀")))).toBe(
      "Commento:\ngià 😀\n\nTesto citato:\nè così, 日本語 😀",
    )
  })
  test("applies the size cap", () => {
    const text = decode(buildQuoteDataUri(Q("y".repeat(MAX_QUOTE_CHARS * 2))))
    expect(text.length).toBeLessThan(MAX_QUOTE_CHARS + 100)
    expect(text.endsWith("[citazione troncata]")).toBe(true)
  })
  test("applies the size cap and keeps the comment whole, before the quote", () => {
    const text = decode(buildQuoteDataUri(Q("y".repeat(MAX_QUOTE_CHARS * 2), "mio")))
    expect(text.startsWith("Commento:\nmio\n\nTesto citato:\n")).toBe(true)
    expect(text.endsWith(NOTE)).toBe(true)
  })
})

describe("serializePending and parsePending", () => {
  test("round trips a fresh list of quotes with comments and its time", () => {
    const list = [Q("uno", "primo"), Q("due")]
    const raw = serializePending(list, NOW)
    expect(parsePending(raw, NOW + 1000)).toEqual({ status: "ok", quotes: list, createdAt: NOW })
  })
  test("writes version 3", () => {
    expect(JSON.parse(ser(["a"])).v).toBe(3)
  })
  test("reads an old single quote file (v1) as a list of one without comment", () => {
    expect(parsePending(v1("vecchia", NOW), NOW + 1000)).toEqual({ status: "ok", quotes: [Q("vecchia")], createdAt: NOW })
  })
  test("reads a v2 file (list of strings) as quotes without comments", () => {
    expect(parsePending(v2(["uno", "due"], NOW), NOW + 1000)).toEqual({ status: "ok", quotes: many("uno", "due"), createdAt: NOW })
  })
  test("is expired at the TTL and after, still valid just before", () => {
    const raw = ser(["testo"])
    expect(parsePending(raw, NOW + PENDING_TTL_MS - 1).status).toBe("ok")
    expect(parsePending(raw, NOW + PENDING_TTL_MS).status).toBe("expired")
    expect(parsePending(raw, NOW + PENDING_TTL_MS * 5).status).toBe("expired")
  })
  test("v1 and v2 files expire like a v3 file", () => {
    expect(parsePending(v1("a", NOW), NOW + PENDING_TTL_MS).status).toBe("expired")
    expect(parsePending(v2(["a"], NOW), NOW + PENDING_TTL_MS).status).toBe("expired")
  })
  test("rejects a creation time far in the future", () => {
    expect(parsePending(ser(["testo"], NOW + 10 * 60_000), NOW).status).toBe("invalid")
    expect(parsePending(v1("testo", NOW + 10 * 60_000), NOW).status).toBe("invalid")
    expect(parsePending(v2(["testo"], NOW + 10 * 60_000), NOW).status).toBe("invalid")
  })
  test("tolerates a little clock skew", () => {
    expect(parsePending(ser(["testo"], NOW + 60_000), NOW).status).toBe("ok")
  })
  test("rejects garbage and unknown versions", () => {
    expect(parsePending("not json", NOW).status).toBe("invalid")
    expect(parsePending("null", NOW).status).toBe("invalid")
    expect(parsePending(JSON.stringify({ v: 4, quotes: [Q("a")], createdAt: NOW }), NOW).status).toBe("invalid")
    expect(parsePending(JSON.stringify({ v: 0, text: "a", createdAt: NOW }), NOW).status).toBe("invalid")
  })
  test("rejects bad v1 fields", () => {
    expect(parsePending(JSON.stringify({ v: 1, text: 5, createdAt: NOW }), NOW).status).toBe("invalid")
    expect(parsePending(JSON.stringify({ v: 1, text: "a", createdAt: "x" }), NOW).status).toBe("invalid")
    expect(parsePending(JSON.stringify({ v: 1, text: "  ", createdAt: NOW }), NOW).status).toBe("invalid")
  })
  test("rejects bad v2 fields", () => {
    const bad = (quotes: unknown, createdAt: unknown = NOW) =>
      parsePending(JSON.stringify({ v: 2, quotes, createdAt }), NOW).status
    expect(bad("a")).toBe("invalid")
    expect(bad([])).toBe("invalid")
    expect(bad([5])).toBe("invalid")
    expect(bad(["a", "  "])).toBe("invalid")
    expect(bad([{ text: "a", comment: "" }])).toBe("invalid")
    expect(bad(["a"], "x")).toBe("invalid")
    expect(bad(["a"], null)).toBe("invalid")
  })
  test("rejects bad v3 fields", () => {
    const bad = (quotes: unknown, createdAt: unknown = NOW) =>
      parsePending(JSON.stringify({ v: 3, quotes, createdAt }), NOW).status
    expect(bad("a")).toBe("invalid")
    expect(bad([])).toBe("invalid")
    expect(bad(["a"])).toBe("invalid")
    expect(bad([null])).toBe("invalid")
    expect(bad([{ text: 5, comment: "" }])).toBe("invalid")
    expect(bad([{ text: "  ", comment: "" }])).toBe("invalid")
    expect(bad([{ text: "a" }])).toBe("invalid")
    expect(bad([{ text: "a", comment: 5 }])).toBe("invalid")
    expect(bad([{ text: "a", comment: "x" }, { text: "b", comment: null }])).toBe("invalid")
    expect(bad([{ text: "a", comment: "" }], "x")).toBe("invalid")
    expect(bad([{ text: "a", comment: "" }], null)).toBe("invalid")
  })
  test("a v3 comment may be empty but not longer than the maximum", () => {
    const ok = (comment: string) => parsePending(v3([{ text: "a", comment }]), NOW).status
    expect(ok("")).toBe("ok")
    expect(ok("c".repeat(MAX_COMMENT_CHARS))).toBe("ok")
    expect(ok("c".repeat(MAX_COMMENT_CHARS + 1))).toBe("invalid")
  })
  test("accepts exactly the maximum number of quotes and refuses one more", () => {
    const five = Array.from({ length: MAX_QUOTES }, (_, i) => `q${i}`)
    expect(parsePending(ser(five), NOW).status).toBe("ok")
    expect(parsePending(ser([...five, "extra"]), NOW).status).toBe("invalid")
    expect(parsePending(v2([...five, "extra"], NOW), NOW).status).toBe("invalid")
  })
})

describe("selectionFresh", () => {
  test("is true inside the window and false after", () => {
    expect(selectionFresh({ text: "a", at: NOW }, NOW + 1000)).toBe(true)
    expect(selectionFresh({ text: "a", at: NOW }, NOW + 60_000)).toBe(false)
  })
  test("is false without a selection", () => {
    expect(selectionFresh(undefined, NOW)).toBe(false)
  })
})

describe("sameList", () => {
  test("equal lists, including both empty or missing", () => {
    expect(sameList(many("a", "b"), many("a", "b"))).toBe(true)
    expect(sameList([Q("a", "x")], [Q("a", "x")])).toBe(true)
    expect(sameList([], [])).toBe(true)
    expect(sameList(undefined, undefined)).toBe(true)
  })
  test("different length, content, order or missing side", () => {
    expect(sameList(many("a"), many("a", "b"))).toBe(false)
    expect(sameList(many("a", "b"), many("a", "c"))).toBe(false)
    expect(sameList(many("a", "b"), many("b", "a"))).toBe(false)
    expect(sameList(many("a"), undefined)).toBe(false)
    expect(sameList(undefined, many("a"))).toBe(false)
  })
  test("the same text with another comment is a different list", () => {
    expect(sameList([Q("a", "x")], [Q("a", "y")])).toBe(false)
    expect(sameList([Q("a", "x")], [Q("a")])).toBe(false)
  })
})

describe("pendingRoom", () => {
  test("is ok with nothing pending and reads only", () => {
    const fs = fakeFs()
    expect(pendingRoom(SID, fs, NOW)).toBe("ok")
    expect(fs.touched).toEqual([PATH])
  })
  test("is ok with room left, full at the maximum number of quotes", () => {
    expect(pendingRoom(SID, fakeFs({ [PATH]: ser(["1", "2", "3", "4"]) }), NOW)).toBe("ok")
    expect(pendingRoom(SID, fakeFs({ [PATH]: ser(["1", "2", "3", "4", "5"]) }), NOW)).toBe("full")
  })
  test("is limit once quotes and comments use up the shared budget", () => {
    expect(pendingRoom(SID, fakeFs({ [PATH]: ser(["a".repeat(MAX_QUOTE_CHARS - 1)]) }), NOW)).toBe("ok")
    expect(pendingRoom(SID, fakeFs({ [PATH]: ser(["a".repeat(MAX_QUOTE_CHARS)]) }), NOW)).toBe("limit")
    expect(pendingRoom(SID, fakeFs({ [PATH]: ser([Q("a".repeat(18_000), "c".repeat(2_000))]) }), NOW)).toBe("limit")
    expect(pendingRoom(SID, fakeFs({ [PATH]: ser([Q("a".repeat(18_000), "c".repeat(1_999))]) }), NOW)).toBe("ok")
  })
  test("an expired or corrupt file counts as empty", () => {
    expect(pendingRoom(SID, fakeFs({ [PATH]: ser(["1", "2", "3", "4", "5"]) }), NOW + PENDING_TTL_MS)).toBe("ok")
    expect(pendingRoom(SID, fakeFs({ [PATH]: "###" }), NOW)).toBe("ok")
  })
  test("reports an invalid ID without touching the folder, and an error when reading fails", () => {
    const fs = fakeFs()
    expect(pendingRoom("../evil", fs, NOW)).toBe("invalid")
    expect(fs.touched).toEqual([])
    const broken = fakeFs({ [PATH]: ser(["a"]) })
    broken.failRead = true
    expect(pendingRoom(SID, broken, NOW)).toBe("error")
  })
})

describe("addPending", () => {
  test("refuses a new quote once the shared character budget is used up", () => {
    const fs = fakeFs()
    expect(addPending(SID, "a".repeat(MAX_QUOTE_CHARS), "", fs, NOW).status).toBe("added")
    expect(addPending(SID, "altro", "", fs, NOW + 1000)).toEqual({ status: "limit" })
    expect(loadPending(SID, fs, NOW + 2000)).toHaveLength(1)
  })
  test("the comment counts towards the budget limit", () => {
    const fs = fakeFs()
    addPending(SID, "a".repeat(18_000), "c".repeat(2_000), fs, NOW)
    expect(addPending(SID, "altro", "", fs, NOW + 1000)).toEqual({ status: "limit" })
  })

  test("writes a v3 file with the first quote and its comment", () => {
    const fs = fakeFs()
    expect(addPending(SID, "uno", "bello", fs, NOW)).toEqual({ status: "added", quotes: [Q("uno", "bello")] })
    expect([...fs.files.keys()]).toEqual([PATH])
    expect(stored(fs)).toEqual({ v: 3, quotes: [{ text: "uno", comment: "bello" }], createdAt: NOW })
  })
  test("a quote saved without comment has an empty comment", () => {
    const fs = fakeFs()
    expect(addPending(SID, "uno", "", fs, NOW)).toEqual({ status: "added", quotes: [Q("uno")] })
    expect(stored(fs).quotes).toEqual([{ text: "uno", comment: "" }])
  })
  test("normalises the comment: one line, trimmed, at most the maximum", () => {
    const fs = fakeFs()
    addPending(SID, "uno", "  due\nrighe  ", fs, NOW)
    expect(stored(fs).quotes[0].comment).toBe("due righe")
    const long = fakeFs()
    addPending(SID, "uno", "c".repeat(3_000), long, NOW)
    expect(stored(long).quotes[0].comment).toBe("c".repeat(MAX_COMMENT_CHARS))
  })
  test("appends further quotes in the order added and renews the time", () => {
    const fs = fakeFs()
    addPending(SID, "uno", "a", fs, NOW)
    expect(addPending(SID, "due", "b", fs, NOW + 5000)).toEqual({ status: "added", quotes: [Q("uno", "a"), Q("due", "b")] })
    expect(stored(fs)).toEqual({
      v: 3,
      quotes: [{ text: "uno", comment: "a" }, { text: "due", comment: "b" }],
      createdAt: NOW + 5000,
    })
  })
  test("allows the fifth quote and refuses the sixth without touching the file", () => {
    const fs = fakeFs()
    for (let i = 1; i <= MAX_QUOTES; i++) expect(addPending(SID, `q${i}`, "", fs, NOW).status).toBe("added")
    const before = fs.files.get(PATH)
    const writes = fs.touched.length
    expect(addPending(SID, "q6", "", fs, NOW + 1000)).toEqual({ status: "full" })
    expect(fs.files.get(PATH)).toBe(before)
    expect(fs.touched.length).toBe(writes + 1) // one read, no write
  })
  test("adds to an old v1 file and rewrites it as v3", () => {
    const fs = fakeFs({ [PATH]: v1("vecchia", NOW) })
    expect(addPending(SID, "nuova", "c", fs, NOW + 1000)).toEqual({ status: "added", quotes: [Q("vecchia"), Q("nuova", "c")] })
    expect(stored(fs)).toEqual({
      v: 3,
      quotes: [{ text: "vecchia", comment: "" }, { text: "nuova", comment: "c" }],
      createdAt: NOW + 1000,
    })
  })
  test("adds to an old v2 file and rewrites it as v3", () => {
    const fs = fakeFs({ [PATH]: v2(["uno", "due"], NOW) })
    expect(addPending(SID, "tre", "", fs, NOW + 1000)).toEqual({ status: "added", quotes: many("uno", "due", "tre") })
    expect(stored(fs).v).toBe(3)
  })
  test("starts fresh when the old file is expired or corrupt", () => {
    const expired = fakeFs({ [PATH]: ser(["scaduta"]) })
    expect(addPending(SID, "nuova", "", expired, NOW + PENDING_TTL_MS)).toEqual({ status: "added", quotes: many("nuova") })
    const corrupt = fakeFs({ [PATH]: "###" })
    expect(addPending(SID, "nuova", "", corrupt, NOW)).toEqual({ status: "added", quotes: many("nuova") })
  })
  test("applies the shared size cap when writing", () => {
    const fs = fakeFs()
    addPending(SID, "a".repeat(15_000), "", fs, NOW)
    const result = addPending(SID, "b".repeat(15_000), "", fs, NOW)
    expect(result.status).toBe("added")
    expect(stored(fs).quotes[1]).toEqual({ text: `${"b".repeat(5_000)}\n\n${NOTE}`, comment: "" })
  })
  test("the shared size cap counts the comment and keeps it", () => {
    const fs = fakeFs()
    addPending(SID, "a".repeat(15_000), "", fs, NOW)
    addPending(SID, "b".repeat(15_000), "c".repeat(100), fs, NOW)
    expect(stored(fs).quotes[1]).toEqual({ text: `${"b".repeat(4_900)}\n\n${NOTE}`, comment: "c".repeat(100) })
  })
  test("normalises the selection before storing it", () => {
    const fs = fakeFs()
    addPending(SID, "riga\r\nfine  \n\n", "", fs, NOW)
    expect(stored(fs).quotes[0].text).toBe("riga\nfine")
  })
  test("refuses a bad session ID or blank text and touches nothing", () => {
    const fs = fakeFs()
    expect(addPending("../evil", "testo", "c", fs, NOW)).toEqual({ status: "invalid" })
    expect(addPending(SID, "   ", "c", fs, NOW)).toEqual({ status: "invalid" })
    expect(fs.touched).toEqual([])
  })
  test("reports an error and keeps the old file when the write fails", () => {
    const fs = fakeFs({ [PATH]: ser(["uno"]) })
    fs.failWrite = true
    expect(addPending(SID, "due", "", fs, NOW)).toEqual({ status: "error" })
    expect(stored(fs).quotes).toEqual([{ text: "uno", comment: "" }])
  })
  test("reports an error instead of overwriting when the old file cannot be read", () => {
    const fs = fakeFs({ [PATH]: ser(["uno"]) })
    fs.failRead = true
    expect(addPending(SID, "due", "", fs, NOW)).toEqual({ status: "error" })
    expect(stored(fs).quotes).toEqual([{ text: "uno", comment: "" }])
  })
})

describe("loadPending", () => {
  test("returns the list of a fresh pending file, comments included, and leaves the file", () => {
    const fs = fakeFs({ [PATH]: ser([Q("uno", "a"), "due"]) })
    expect(loadPending(SID, fs, NOW + 1000)).toEqual([Q("uno", "a"), Q("due")])
    expect(fs.files.has(PATH)).toBe(true)
  })
  test("reads old v1 and v2 files as quotes without comments", () => {
    expect(loadPending(SID, fakeFs({ [PATH]: v1("vecchia", NOW) }), NOW)).toEqual([Q("vecchia")])
    expect(loadPending(SID, fakeFs({ [PATH]: v2(["a", "b"], NOW) }), NOW)).toEqual(many("a", "b"))
  })
  test("returns undefined when missing, expired or corrupt", () => {
    expect(loadPending(SID, fakeFs(), NOW)).toBeUndefined()
    expect(loadPending(SID, fakeFs({ [PATH]: ser(["a"]) }), NOW + PENDING_TTL_MS)).toBeUndefined()
    expect(loadPending(SID, fakeFs({ [PATH]: "###" }), NOW)).toBeUndefined()
  })
  test("returns undefined for a bad ID without touching the folder", () => {
    const fs = fakeFs()
    expect(loadPending("../x", fs, NOW)).toBeUndefined()
    expect(fs.touched).toEqual([])
  })
  test("returns undefined instead of throwing when reading fails", () => {
    const fs = fakeFs({ [PATH]: ser(["a"]) })
    fs.failRead = true
    expect(loadPending(SID, fs, NOW)).toBeUndefined()
  })
})

describe("removePending", () => {
  test("removes nothing when the clicked quote is no longer at that index", () => {
    const fs = fakeFs()
    addPending(SID, "uno", "", fs, NOW)
    addPending(SID, "due", "", fs, NOW)
    expect(removePending(SID, 0, fs, NOW, Q("due"))).toEqual(many("uno", "due"))
    expect(removePending(SID, 1, fs, NOW, Q("due"))).toEqual(many("uno"))
  })
  test("the click guard also compares the comment", () => {
    const fs = fakeFs({ [PATH]: ser([Q("uno", "a"), Q("due", "b")]) })
    expect(removePending(SID, 1, fs, NOW, Q("due", "altro"))).toEqual([Q("uno", "a"), Q("due", "b")])
    expect(removePending(SID, 1, fs, NOW, Q("due", "b"))).toEqual([Q("uno", "a")])
  })

  const three = () => fakeFs({ [PATH]: ser([Q("uno", "a"), "due", Q("tre", "c")]) })

  test("removes the quote at an index, keeps the order, the comments and does not renew the time", () => {
    const fs = three()
    expect(removePending(SID, 1, fs, NOW + 9000)).toEqual([Q("uno", "a"), Q("tre", "c")])
    expect(stored(fs)).toEqual({
      v: 3,
      quotes: [{ text: "uno", comment: "a" }, { text: "tre", comment: "c" }],
      createdAt: NOW,
    })
  })
  test("removes the first quote", () => {
    const fs = three()
    expect(removePending(SID, 0, fs, NOW)).toEqual([Q("due"), Q("tre", "c")])
  })
  test('"last" removes the most recently added quote', () => {
    const fs = three()
    expect(removePending(SID, "last", fs, NOW)).toEqual([Q("uno", "a"), Q("due")])
  })
  test("removing the only quote deletes the file", () => {
    const fs = fakeFs({ [PATH]: ser(["solo"]) })
    expect(removePending(SID, 0, fs, NOW)).toEqual([])
    expect(fs.files.has(PATH)).toBe(false)
  })
  test("works on old v1 and v2 files", () => {
    const fs = fakeFs({ [PATH]: v1("vecchia", NOW) })
    expect(removePending(SID, "last", fs, NOW)).toEqual([])
    expect(fs.files.has(PATH)).toBe(false)
    const second = fakeFs({ [PATH]: v2(["a", "b"], NOW) })
    expect(removePending(SID, 0, second, NOW)).toEqual(many("b"))
    expect(stored(second).v).toBe(3)
  })
  test("an index out of range or not an integer changes nothing", () => {
    for (const bad of [3, -1, 1.5, Number.NaN, "x" as unknown as number]) {
      const fs = three()
      const before = fs.files.get(PATH)
      expect(removePending(SID, bad, fs, NOW)).toEqual([Q("uno", "a"), Q("due"), Q("tre", "c")])
      expect(fs.files.get(PATH)).toBe(before)
      expect(fs.touched).toEqual([PATH]) // read only, no write
    }
  })
  test("returns undefined when there is nothing pending, or it is expired or corrupt", () => {
    expect(removePending(SID, 0, fakeFs(), NOW)).toBeUndefined()
    expect(removePending(SID, 0, fakeFs({ [PATH]: ser(["a"]) }), NOW + PENDING_TTL_MS)).toBeUndefined()
    expect(removePending(SID, 0, fakeFs({ [PATH]: "###" }), NOW)).toBeUndefined()
  })
  test("refuses a bad session ID and touches nothing", () => {
    const fs = fakeFs()
    expect(removePending("../evil", 0, fs, NOW)).toBeUndefined()
    expect(fs.touched).toEqual([])
  })
  test("returns undefined and keeps the file when the write fails", () => {
    const fs = three()
    fs.failWrite = true
    expect(removePending(SID, 0, fs, NOW)).toBeUndefined()
    expect(stored(fs).quotes).toHaveLength(3)
  })
  test("returns undefined when deleting the last quote fails", () => {
    const fs = fakeFs({ [PATH]: ser(["solo"]) })
    fs.failRemove = true
    expect(removePending(SID, 0, fs, NOW)).toBeUndefined()
  })
})

describe("clearPending", () => {
  test("removes the file and ignores errors and bad IDs", () => {
    const fs = fakeFs({ [PATH]: "x" })
    clearPending(SID, fs)
    expect(fs.files.size).toBe(0)
    fs.failRemove = true
    expect(() => clearPending(SID, fs)).not.toThrow()
    const before = fs.touched.length
    clearPending("../evil", fs)
    expect(fs.touched.length).toBe(before)
  })
})

describe("applyQuoteToPrompt", () => {
  const eventFor = (sessionID: unknown, files?: unknown[]) => ({
    sessionID,
    messageID: "msg_1",
    prompt: { text: "il mio commento", ...(files ? { files } : {}) } as { text: string; files?: unknown[] },
    delivery: "steer",
  })
  type Attached = { uri: string; name: string; description: string }

  test("does nothing when no pending file exists", () => {
    const fs = fakeFs()
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    expect(event.prompt).toEqual({ text: "il mio commento" })
    expect(fs.touched).toEqual([PATH])
  })

  test("a single quote without comment is attached as Citazione with just its text", () => {
    const fs = fakeFs({ [PATH]: ser(["riga uno\nriga due"]) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW + 5000)
    const files = event.prompt.files as Attached[]
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toBe("Citazione")
    expect(files[0]!.description).toBe(QUOTE_DESCRIPTION)
    expect(decode(files[0]!.uri)).toBe("riga uno\nriga due")
    expect(fs.files.has(PATH)).toBe(false)
  })

  test("a single quote with a comment holds both parts and says so in the description", () => {
    const fs = fakeFs({ [PATH]: ser([Q("il testo", "il mio parere")]) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    const files = event.prompt.files as Attached[]
    expect(files.map((file) => file.name)).toEqual(["Citazione"])
    expect(decode(files[0]!.uri)).toBe("Commento:\nil mio parere\n\nTesto citato:\nil testo")
    expect(files[0]!.description).toBe(QUOTE_COMMENT_DESCRIPTION)
  })

  test("several quotes become Citazione 1, 2, 3 in the order added, each with its own comment", () => {
    const fs = fakeFs({ [PATH]: ser([Q("primo", "uno"), "secondo", Q("terzo", "tre")]) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    const files = event.prompt.files as Attached[]
    expect(files.map((file) => file.name)).toEqual(["Citazione 1", "Citazione 2", "Citazione 3"])
    expect(files.map((file) => decode(file.uri))).toEqual([
      "Commento:\nuno\n\nTesto citato:\nprimo",
      "secondo",
      "Commento:\ntre\n\nTesto citato:\nterzo",
    ])
    expect(files.map((file) => file.description)).toEqual([QUOTE_COMMENT_DESCRIPTION, QUOTE_DESCRIPTION, QUOTE_COMMENT_DESCRIPTION])
    expect(fs.files.has(PATH)).toBe(false)
  })

  test("an old v1 file is attached as one Citazione", () => {
    const fs = fakeFs({ [PATH]: v1("vecchia", NOW) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    const files = event.prompt.files as Attached[]
    expect(files.map((file) => file.name)).toEqual(["Citazione"])
    expect(decode(files[0]!.uri)).toBe("vecchia")
  })

  test("an old v2 file is attached as numbered quotes without comments", () => {
    const fs = fakeFs({ [PATH]: v2(["a", "b"], NOW) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    const files = event.prompt.files as Attached[]
    expect(files.map((file) => file.name)).toEqual(["Citazione 1", "Citazione 2"])
    expect(files.map((file) => decode(file.uri))).toEqual(["a", "b"])
  })

  test("the size cap is shared: later quotes are cut with the note", () => {
    const fs = fakeFs({ [PATH]: ser(["a".repeat(15_000), "b".repeat(15_000), "c"]) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    const texts = (event.prompt.files as Attached[]).map((file) => decode(file.uri))
    expect(texts[0]).toBe("a".repeat(15_000))
    expect(texts[1]).toBe(`${"b".repeat(5_000)}\n\n${NOTE}`)
    expect(texts[2]).toBe(NOTE)
    expect(TRUNCATION_NOTE).toBe(NOTE)
  })

  test("the shared size cap counts the comments and keeps them", () => {
    const fs = fakeFs({ [PATH]: ser([Q("a".repeat(15_000), "c".repeat(2_000)), Q("b".repeat(10_000), "dd")]) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    const texts = (event.prompt.files as Attached[]).map((file) => decode(file.uri))
    expect(texts[0]).toBe(`Commento:\n${"c".repeat(2_000)}\n\nTesto citato:\n${"a".repeat(15_000)}`)
    expect(texts[1]).toBe(`Commento:\ndd\n\nTesto citato:\n${"b".repeat(2_998)}\n\n${NOTE}`)
  })

  test("keeps existing files first and the prompt text", () => {
    const fs = fakeFs({ [PATH]: ser(["q1", "q2"]) })
    const event = eventFor(SID, [{ uri: "file:///a.md" }])
    applyQuoteToPrompt(event, fs, NOW)
    const files = event.prompt.files as { uri: string; name?: string }[]
    expect(files[0]!.uri).toBe("file:///a.md")
    expect(files.map((file) => file.name)).toEqual([undefined, "Citazione 1", "Citazione 2"])
    expect(event.prompt.text).toBe("il mio commento")
  })

  test("attaches only once", () => {
    const fs = fakeFs({ [PATH]: ser(["q"]) })
    applyQuoteToPrompt(eventFor(SID), fs, NOW)
    const second = eventFor(SID)
    applyQuoteToPrompt(second, fs, NOW)
    expect(second.prompt.files).toBeUndefined()
  })

  test("ignores and deletes an expired file", () => {
    const fs = fakeFs({ [PATH]: ser(["vecchia"]) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW + PENDING_TTL_MS + 1)
    expect(event.prompt.files).toBeUndefined()
    expect(fs.files.has(PATH)).toBe(false)
  })

  test("ignores and deletes a corrupt file", () => {
    const fs = fakeFs({ [PATH]: "{{{" })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    expect(event.prompt.files).toBeUndefined()
    expect(fs.files.has(PATH)).toBe(false)
  })

  test("never touches the folder for a bad session ID", () => {
    const fs = fakeFs()
    for (const bad of ["../etc/passwd", "", undefined, 3, "ses_a/../b"]) {
      applyQuoteToPrompt(eventFor(bad), fs, NOW)
    }
    expect(fs.touched).toEqual([])
  })

  test("reads only the file of the event's own session", () => {
    const other = `${DIR}/ses_other.json`
    const fs = fakeFs({ [other]: ser(["altra sessione"]) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    expect(event.prompt.files).toBeUndefined()
    expect(fs.files.has(other)).toBe(true)
    expect(fs.touched).toEqual([PATH])
  })

  test("never throws and leaves the prompt alone when reading fails", () => {
    const fs = fakeFs({ [PATH]: ser(["q"]) })
    fs.failRead = true
    const event = eventFor(SID)
    expect(() => applyQuoteToPrompt(event, fs, NOW)).not.toThrow()
    expect(event.prompt.files).toBeUndefined()
  })

  test("skips the attachments when the file cannot be consumed", () => {
    const fs = fakeFs({ [PATH]: ser(["q1", "q2"]) })
    fs.failRemove = true
    const event = eventFor(SID)
    expect(() => applyQuoteToPrompt(event, fs, NOW)).not.toThrow()
    expect(event.prompt.files).toBeUndefined()
  })

  test("never throws on malformed events", () => {
    const fs = fakeFs({ [PATH]: ser(["q"]) })
    for (const bad of [null, undefined, 5, "x", {}, { sessionID: SID }, { sessionID: SID, prompt: null }, { sessionID: SID, prompt: 4 }]) {
      expect(() => applyQuoteToPrompt(bad, fs, NOW)).not.toThrow()
    }
    expect(fs.files.has(PATH)).toBe(true)
  })

  test("does not log the quote text or the comments", () => {
    const logged: unknown[] = []
    const original = [console.log, console.error, console.warn, console.info]
    console.log = console.error = console.warn = console.info = (...args: unknown[]) => void logged.push(args)
    try {
      const fs = fakeFs({ [PATH]: ser([Q("segretissimo", "confidenziale"), "riservato"]) })
      applyQuoteToPrompt(eventFor(SID), fs, NOW)
      fs.failRead = true
      applyQuoteToPrompt(eventFor(SID), fs, NOW)
    } finally {
      ;[console.log, console.error, console.warn, console.info] = original
    }
    expect(JSON.stringify(logged)).not.toContain("segretissimo")
    expect(JSON.stringify(logged)).not.toContain("riservato")
    expect(JSON.stringify(logged)).not.toContain("confidenziale")
  })
})

describe("strict comment on read", () => {
  test("a hand-written v3 comment with a new line is refused", () => {
    const raw = JSON.stringify({ v: 3, quotes: [{ text: "x", comment: "a\nTesto citato:\nb" }], createdAt: NOW })
    expect(parsePending(raw, NOW).status).toBe("invalid")
  })
  test("an over-long text is refused", () => {
    const raw = JSON.stringify({ v: 3, quotes: [{ text: "x".repeat(MAX_QUOTE_CHARS + 100), comment: "" }], createdAt: NOW })
    expect(parsePending(raw, NOW).status).toBe("invalid")
  })
})

