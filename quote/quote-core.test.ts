import { describe, expect, test } from "bun:test"
import {
  CHIP_PREVIEW_CHARS,
  MAX_QUOTES,
  MAX_QUOTE_CHARS,
  PENDING_TTL_MS,
  QUOTE_NAME,
  TRUNCATION_NOTE,
  addPending,
  applyQuoteToPrompt,
  attachmentName,
  buildQuoteDataUri,
  capQuote,
  capQuotes,
  chipSummary,
  clearPending,
  loadPending,
  normalizeSelection,
  parsePending,
  pendingFileName,
  removePending,
  sameList,
  selectionFresh,
  serializePending,
  type PendingFs,
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

describe("capQuotes (one budget shared by all quotes)", () => {
  test("leaves quotes under the budget alone", () => {
    expect(capQuotes(["uno", "due"])).toEqual({ quotes: ["uno", "due"], truncated: false })
  })
  test("an empty list stays empty", () => {
    expect(capQuotes([])).toEqual({ quotes: [], truncated: false })
  })
  test("keeps quotes that add up to exactly the budget", () => {
    const a = "a".repeat(10_000)
    const b = "b".repeat(10_000)
    expect(capQuotes([a, b])).toEqual({ quotes: [a, b], truncated: false })
  })
  test("cuts the later quote when the total goes over, and says so", () => {
    const result = capQuotes(["a".repeat(15_000), "b".repeat(10_000)])
    expect(result.truncated).toBe(true)
    expect(result.quotes[0]).toBe("a".repeat(15_000))
    expect(result.quotes[1]).toBe(`${"b".repeat(5_000)}\n\n${NOTE}`)
  })
  test("quotes after the budget is used up keep their place with only the note", () => {
    const result = capQuotes(["a".repeat(MAX_QUOTE_CHARS), "tre", "quattro"])
    expect(result.truncated).toBe(true)
    expect(result.quotes).toEqual(["a".repeat(MAX_QUOTE_CHARS), NOTE, NOTE])
  })
  test("the first quote alone is cut at the budget like capQuote", () => {
    const result = capQuotes(["z".repeat(MAX_QUOTE_CHARS + 5), "dopo"])
    expect(result.quotes).toEqual([capQuote("z".repeat(MAX_QUOTE_CHARS + 5)).text, NOTE])
  })
  test("never splits a surrogate pair at the shared cut", () => {
    const result = capQuotes(["a".repeat(19_000), "b".repeat(999) + "😀" + "tail"])
    expect(result.quotes[1]).toBe(`${"b".repeat(999)}\n\n${NOTE}`)
  })
  test("applying it twice changes nothing", () => {
    const once = capQuotes(["a".repeat(15_000), "b".repeat(10_000), "c"])
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

describe("buildQuoteDataUri", () => {
  test("is a text/plain base64 data URI that decodes to the quote", () => {
    expect(decode(buildQuoteDataUri("ciao\nmondo"))).toBe("ciao\nmondo")
  })
  test("round trips unicode", () => {
    expect(decode(buildQuoteDataUri("è così, 日本語 😀"))).toBe("è così, 日本語 😀")
  })
  test("applies the size cap", () => {
    const text = decode(buildQuoteDataUri("y".repeat(MAX_QUOTE_CHARS * 2)))
    expect(text.length).toBeLessThan(MAX_QUOTE_CHARS + 100)
    expect(text.endsWith("[citazione troncata]")).toBe(true)
  })
})

describe("serializePending and parsePending", () => {
  test("round trips a fresh list of quotes with its time", () => {
    const raw = serializePending(["uno", "due"], NOW)
    expect(parsePending(raw, NOW + 1000)).toEqual({ status: "ok", quotes: ["uno", "due"], createdAt: NOW })
  })
  test("writes version 2", () => {
    expect(JSON.parse(serializePending(["a"], NOW)).v).toBe(2)
  })
  test("reads an old single quote file (v1) as a list of one", () => {
    expect(parsePending(v1("vecchia", NOW), NOW + 1000)).toEqual({ status: "ok", quotes: ["vecchia"], createdAt: NOW })
  })
  test("is expired at the TTL and after, still valid just before", () => {
    const raw = serializePending(["testo"], NOW)
    expect(parsePending(raw, NOW + PENDING_TTL_MS - 1).status).toBe("ok")
    expect(parsePending(raw, NOW + PENDING_TTL_MS).status).toBe("expired")
    expect(parsePending(raw, NOW + PENDING_TTL_MS * 5).status).toBe("expired")
  })
  test("a v1 file expires like a v2 file", () => {
    expect(parsePending(v1("a", NOW), NOW + PENDING_TTL_MS).status).toBe("expired")
  })
  test("rejects a creation time far in the future", () => {
    expect(parsePending(serializePending(["testo"], NOW + 10 * 60_000), NOW).status).toBe("invalid")
    expect(parsePending(v1("testo", NOW + 10 * 60_000), NOW).status).toBe("invalid")
  })
  test("tolerates a little clock skew", () => {
    expect(parsePending(serializePending(["testo"], NOW + 60_000), NOW).status).toBe("ok")
  })
  test("rejects garbage and unknown versions", () => {
    expect(parsePending("not json", NOW).status).toBe("invalid")
    expect(parsePending("null", NOW).status).toBe("invalid")
    expect(parsePending(JSON.stringify({ v: 3, quotes: ["a"], createdAt: NOW }), NOW).status).toBe("invalid")
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
    expect(bad(["a"], "x")).toBe("invalid")
    expect(bad(["a"], null)).toBe("invalid")
  })
  test("accepts exactly the maximum number of quotes and refuses one more", () => {
    const five = Array.from({ length: MAX_QUOTES }, (_, i) => `q${i}`)
    expect(parsePending(serializePending(five, NOW), NOW).status).toBe("ok")
    expect(parsePending(serializePending([...five, "extra"], NOW), NOW).status).toBe("invalid")
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
    expect(sameList(["a", "b"], ["a", "b"])).toBe(true)
    expect(sameList([], [])).toBe(true)
    expect(sameList(undefined, undefined)).toBe(true)
  })
  test("different length, content, order or missing side", () => {
    expect(sameList(["a"], ["a", "b"])).toBe(false)
    expect(sameList(["a", "b"], ["a", "c"])).toBe(false)
    expect(sameList(["a", "b"], ["b", "a"])).toBe(false)
    expect(sameList(["a"], undefined)).toBe(false)
    expect(sameList(undefined, ["a"])).toBe(false)
  })
})

describe("addPending", () => {
  test("refuses a new quote once the shared character budget is used up", () => {
    const fs = fakeFs()
    expect(addPending(SID, "a".repeat(MAX_QUOTE_CHARS), fs, NOW).status).toBe("added")
    expect(addPending(SID, "altro", fs, NOW + 1000)).toEqual({ status: "limit" })
    expect(loadPending(SID, fs, NOW + 2000)).toHaveLength(1)
  })

  test("writes a v2 file with the first quote", () => {
    const fs = fakeFs()
    expect(addPending(SID, "uno", fs, NOW)).toEqual({ status: "added", quotes: ["uno"] })
    expect([...fs.files.keys()]).toEqual([PATH])
    expect(stored(fs)).toEqual({ v: 2, quotes: ["uno"], createdAt: NOW })
  })
  test("appends further quotes in the order added and renews the time", () => {
    const fs = fakeFs()
    addPending(SID, "uno", fs, NOW)
    expect(addPending(SID, "due", fs, NOW + 5000)).toEqual({ status: "added", quotes: ["uno", "due"] })
    expect(stored(fs)).toEqual({ v: 2, quotes: ["uno", "due"], createdAt: NOW + 5000 })
  })
  test("allows the fifth quote and refuses the sixth without touching the file", () => {
    const fs = fakeFs()
    for (let i = 1; i <= MAX_QUOTES; i++) expect(addPending(SID, `q${i}`, fs, NOW).status).toBe("added")
    const before = fs.files.get(PATH)
    const writes = fs.touched.length
    expect(addPending(SID, "q6", fs, NOW + 1000)).toEqual({ status: "full" })
    expect(fs.files.get(PATH)).toBe(before)
    expect(fs.touched.length).toBe(writes + 1) // one read, no write
  })
  test("adds to an old v1 file and rewrites it as v2", () => {
    const fs = fakeFs({ [PATH]: v1("vecchia", NOW) })
    expect(addPending(SID, "nuova", fs, NOW + 1000)).toEqual({ status: "added", quotes: ["vecchia", "nuova"] })
    expect(stored(fs)).toEqual({ v: 2, quotes: ["vecchia", "nuova"], createdAt: NOW + 1000 })
  })
  test("starts fresh when the old file is expired or corrupt", () => {
    const expired = fakeFs({ [PATH]: serializePending(["scaduta"], NOW) })
    expect(addPending(SID, "nuova", expired, NOW + PENDING_TTL_MS)).toEqual({ status: "added", quotes: ["nuova"] })
    const corrupt = fakeFs({ [PATH]: "###" })
    expect(addPending(SID, "nuova", corrupt, NOW)).toEqual({ status: "added", quotes: ["nuova"] })
  })
  test("applies the shared size cap when writing", () => {
    const fs = fakeFs()
    addPending(SID, "a".repeat(15_000), fs, NOW)
    const result = addPending(SID, "b".repeat(15_000), fs, NOW)
    expect(result.status).toBe("added")
    expect(stored(fs).quotes[1]).toBe(`${"b".repeat(5_000)}\n\n${NOTE}`)
  })
  test("normalises the selection before storing it", () => {
    const fs = fakeFs()
    addPending(SID, "riga\r\nfine  \n\n", fs, NOW)
    expect(stored(fs).quotes).toEqual(["riga\nfine"])
  })
  test("refuses a bad session ID or blank text and touches nothing", () => {
    const fs = fakeFs()
    expect(addPending("../evil", "testo", fs, NOW)).toEqual({ status: "invalid" })
    expect(addPending(SID, "   ", fs, NOW)).toEqual({ status: "invalid" })
    expect(fs.touched).toEqual([])
  })
  test("reports an error and keeps the old file when the write fails", () => {
    const fs = fakeFs({ [PATH]: serializePending(["uno"], NOW) })
    fs.failWrite = true
    expect(addPending(SID, "due", fs, NOW)).toEqual({ status: "error" })
    expect(stored(fs).quotes).toEqual(["uno"])
  })
  test("reports an error instead of overwriting when the old file cannot be read", () => {
    const fs = fakeFs({ [PATH]: serializePending(["uno"], NOW) })
    fs.failRead = true
    expect(addPending(SID, "due", fs, NOW)).toEqual({ status: "error" })
    expect(stored(fs).quotes).toEqual(["uno"])
  })
})

describe("loadPending", () => {
  test("returns the list of a fresh pending file and leaves the file", () => {
    const fs = fakeFs({ [PATH]: serializePending(["uno", "due"], NOW) })
    expect(loadPending(SID, fs, NOW + 1000)).toEqual(["uno", "due"])
    expect(fs.files.has(PATH)).toBe(true)
  })
  test("reads an old v1 file as a list of one", () => {
    expect(loadPending(SID, fakeFs({ [PATH]: v1("vecchia", NOW) }), NOW)).toEqual(["vecchia"])
  })
  test("returns undefined when missing, expired or corrupt", () => {
    expect(loadPending(SID, fakeFs(), NOW)).toBeUndefined()
    expect(loadPending(SID, fakeFs({ [PATH]: serializePending(["a"], NOW) }), NOW + PENDING_TTL_MS)).toBeUndefined()
    expect(loadPending(SID, fakeFs({ [PATH]: "###" }), NOW)).toBeUndefined()
  })
  test("returns undefined for a bad ID without touching the folder", () => {
    const fs = fakeFs()
    expect(loadPending("../x", fs, NOW)).toBeUndefined()
    expect(fs.touched).toEqual([])
  })
  test("returns undefined instead of throwing when reading fails", () => {
    const fs = fakeFs({ [PATH]: serializePending(["a"], NOW) })
    fs.failRead = true
    expect(loadPending(SID, fs, NOW)).toBeUndefined()
  })
})

describe("removePending", () => {
  test("removes nothing when the clicked quote is no longer at that index", () => {
    const fs = fakeFs()
    addPending(SID, "uno", fs, NOW)
    addPending(SID, "due", fs, NOW)
    expect(removePending(SID, 0, fs, NOW, "due")).toEqual(["uno", "due"])
    expect(removePending(SID, 1, fs, NOW, "due")).toEqual(["uno"])
  })

  const three = () => fakeFs({ [PATH]: serializePending(["uno", "due", "tre"], NOW) })

  test("removes the quote at an index, keeps the order and does not renew the time", () => {
    const fs = three()
    expect(removePending(SID, 1, fs, NOW + 9000)).toEqual(["uno", "tre"])
    expect(stored(fs)).toEqual({ v: 2, quotes: ["uno", "tre"], createdAt: NOW })
  })
  test("removes the first quote", () => {
    const fs = three()
    expect(removePending(SID, 0, fs, NOW)).toEqual(["due", "tre"])
  })
  test('"last" removes the most recently added quote', () => {
    const fs = three()
    expect(removePending(SID, "last", fs, NOW)).toEqual(["uno", "due"])
  })
  test("removing the only quote deletes the file", () => {
    const fs = fakeFs({ [PATH]: serializePending(["solo"], NOW) })
    expect(removePending(SID, 0, fs, NOW)).toEqual([])
    expect(fs.files.has(PATH)).toBe(false)
  })
  test("works on an old v1 file", () => {
    const fs = fakeFs({ [PATH]: v1("vecchia", NOW) })
    expect(removePending(SID, "last", fs, NOW)).toEqual([])
    expect(fs.files.has(PATH)).toBe(false)
  })
  test("an index out of range or not an integer changes nothing", () => {
    for (const bad of [3, -1, 1.5, Number.NaN, "x" as unknown as number]) {
      const fs = three()
      const before = fs.files.get(PATH)
      expect(removePending(SID, bad, fs, NOW)).toEqual(["uno", "due", "tre"])
      expect(fs.files.get(PATH)).toBe(before)
      expect(fs.touched).toEqual([PATH]) // read only, no write
    }
  })
  test("returns undefined when there is nothing pending, or it is expired or corrupt", () => {
    expect(removePending(SID, 0, fakeFs(), NOW)).toBeUndefined()
    expect(removePending(SID, 0, fakeFs({ [PATH]: serializePending(["a"], NOW) }), NOW + PENDING_TTL_MS)).toBeUndefined()
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
    expect(stored(fs).quotes).toEqual(["uno", "due", "tre"])
  })
  test("returns undefined when deleting the last quote fails", () => {
    const fs = fakeFs({ [PATH]: serializePending(["solo"], NOW) })
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

  test("a single quote is attached as Citazione and the file is consumed", () => {
    const fs = fakeFs({ [PATH]: serializePending(["riga uno\nriga due"], NOW) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW + 5000)
    const files = event.prompt.files as Attached[]
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toBe("Citazione")
    expect(typeof files[0]!.description).toBe("string")
    expect(decode(files[0]!.uri)).toBe("riga uno\nriga due")
    expect(fs.files.has(PATH)).toBe(false)
  })

  test("several quotes become Citazione 1, 2, 3 in the order added", () => {
    const fs = fakeFs({ [PATH]: serializePending(["primo", "secondo", "terzo"], NOW) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    const files = event.prompt.files as Attached[]
    expect(files.map((file) => file.name)).toEqual(["Citazione 1", "Citazione 2", "Citazione 3"])
    expect(files.map((file) => decode(file.uri))).toEqual(["primo", "secondo", "terzo"])
    expect(files.every((file) => file.description.length > 0)).toBe(true)
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

  test("the size cap is shared: later quotes are cut with the note", () => {
    const fs = fakeFs({ [PATH]: serializePending(["a".repeat(15_000), "b".repeat(15_000), "c"], NOW) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    const texts = (event.prompt.files as Attached[]).map((file) => decode(file.uri))
    expect(texts[0]).toBe("a".repeat(15_000))
    expect(texts[1]).toBe(`${"b".repeat(5_000)}\n\n${NOTE}`)
    expect(texts[2]).toBe(NOTE)
    expect(TRUNCATION_NOTE).toBe(NOTE)
  })

  test("keeps existing files first and the prompt text", () => {
    const fs = fakeFs({ [PATH]: serializePending(["q1", "q2"], NOW) })
    const event = eventFor(SID, [{ uri: "file:///a.md" }])
    applyQuoteToPrompt(event, fs, NOW)
    const files = event.prompt.files as { uri: string; name?: string }[]
    expect(files[0]!.uri).toBe("file:///a.md")
    expect(files.map((file) => file.name)).toEqual([undefined, "Citazione 1", "Citazione 2"])
    expect(event.prompt.text).toBe("il mio commento")
  })

  test("attaches only once", () => {
    const fs = fakeFs({ [PATH]: serializePending(["q"], NOW) })
    applyQuoteToPrompt(eventFor(SID), fs, NOW)
    const second = eventFor(SID)
    applyQuoteToPrompt(second, fs, NOW)
    expect(second.prompt.files).toBeUndefined()
  })

  test("ignores and deletes an expired file", () => {
    const fs = fakeFs({ [PATH]: serializePending(["vecchia"], NOW) })
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
    const fs = fakeFs({ [other]: serializePending(["altra sessione"], NOW) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    expect(event.prompt.files).toBeUndefined()
    expect(fs.files.has(other)).toBe(true)
    expect(fs.touched).toEqual([PATH])
  })

  test("never throws and leaves the prompt alone when reading fails", () => {
    const fs = fakeFs({ [PATH]: serializePending(["q"], NOW) })
    fs.failRead = true
    const event = eventFor(SID)
    expect(() => applyQuoteToPrompt(event, fs, NOW)).not.toThrow()
    expect(event.prompt.files).toBeUndefined()
  })

  test("skips the attachments when the file cannot be consumed", () => {
    const fs = fakeFs({ [PATH]: serializePending(["q1", "q2"], NOW) })
    fs.failRemove = true
    const event = eventFor(SID)
    expect(() => applyQuoteToPrompt(event, fs, NOW)).not.toThrow()
    expect(event.prompt.files).toBeUndefined()
  })

  test("never throws on malformed events", () => {
    const fs = fakeFs({ [PATH]: serializePending(["q"], NOW) })
    for (const bad of [null, undefined, 5, "x", {}, { sessionID: SID }, { sessionID: SID, prompt: null }, { sessionID: SID, prompt: 4 }]) {
      expect(() => applyQuoteToPrompt(bad, fs, NOW)).not.toThrow()
    }
    expect(fs.files.has(PATH)).toBe(true)
  })

  test("does not log the quote text", () => {
    const logged: unknown[] = []
    const original = [console.log, console.error, console.warn, console.info]
    console.log = console.error = console.warn = console.info = (...args: unknown[]) => void logged.push(args)
    try {
      const fs = fakeFs({ [PATH]: serializePending(["segretissimo", "riservato"], NOW) })
      applyQuoteToPrompt(eventFor(SID), fs, NOW)
      fs.failRead = true
      applyQuoteToPrompt(eventFor(SID), fs, NOW)
    } finally {
      ;[console.log, console.error, console.warn, console.info] = original
    }
    expect(JSON.stringify(logged)).not.toContain("segretissimo")
    expect(JSON.stringify(logged)).not.toContain("riservato")
  })
})
