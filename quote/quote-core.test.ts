import { describe, expect, test } from "bun:test"
import {
  CHIP_PREVIEW_CHARS,
  MAX_QUOTE_CHARS,
  PENDING_TTL_MS,
  QUOTE_NAME,
  applyQuoteToPrompt,
  buildQuoteDataUri,
  capQuote,
  chipSummary,
  clearPending,
  loadPending,
  normalizeSelection,
  parsePending,
  pendingFileName,
  savePending,
  selectionFresh,
  serializePending,
  type PendingFs,
} from "./quote-core"

const NOW = Date.parse("2026-11-10T12:00:00Z")
const DIR = "/state/quote-pending"
const SID = "ses_abc123XYZ"

// An in-memory stand-in for the quote-pending folder. It records every path it is asked to touch.
const fakeFs = (initial: Record<string, string> = {}) => {
  const files = new Map(Object.entries(initial))
  const touched: string[] = []
  const fs: PendingFs & { files: Map<string, string>; touched: string[]; failRead?: boolean; failRemove?: boolean } = {
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

describe("chipSummary", () => {
  test("short single line quote", () => {
    expect(chipSummary("ciao")).toEqual({ preview: '"ciao"', lines: 1, lineLabel: "" })
  })
  test("truncates the preview at the limit with an ellipsis", () => {
    const summary = chipSummary("a".repeat(CHIP_PREVIEW_CHARS + 20))
    expect(summary.preview).toBe(`"${"a".repeat(CHIP_PREVIEW_CHARS)}…"`)
  })
  test("does not add an ellipsis at exactly the limit", () => {
    expect(chipSummary("a".repeat(CHIP_PREVIEW_CHARS)).preview).toBe(`"${"a".repeat(CHIP_PREVIEW_CHARS)}"`)
  })
  test("collapses newlines and runs of spaces in the preview", () => {
    expect(chipSummary("uno\n  due\n\ntre").preview).toBe('"uno due tre"')
  })
  test("counts lines and labels them when more than one", () => {
    expect(chipSummary("a\nb\nc")).toEqual({ preview: '"a b c"', lines: 3, lineLabel: "3 righe" })
  })
  test("ignores trailing newlines when counting", () => {
    expect(chipSummary("a\nb\n\n").lines).toBe(2)
  })
  test("does not cut a surrogate pair in the preview", () => {
    const summary = chipSummary("a".repeat(CHIP_PREVIEW_CHARS - 1) + "😀😀")
    expect(summary.preview).toBe(`"${"a".repeat(CHIP_PREVIEW_CHARS - 1)}😀…"`)
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
  test("round trips a fresh quote", () => {
    const raw = serializePending("testo", NOW)
    expect(parsePending(raw, NOW + 1000)).toEqual({ status: "ok", text: "testo" })
  })
  test("is expired at the TTL and after, still valid just before", () => {
    const raw = serializePending("testo", NOW)
    expect(parsePending(raw, NOW + PENDING_TTL_MS - 1).status).toBe("ok")
    expect(parsePending(raw, NOW + PENDING_TTL_MS).status).toBe("expired")
    expect(parsePending(raw, NOW + PENDING_TTL_MS * 5).status).toBe("expired")
  })
  test("rejects a creation time far in the future", () => {
    const raw = serializePending("testo", NOW + 10 * 60_000)
    expect(parsePending(raw, NOW).status).toBe("invalid")
  })
  test("tolerates a little clock skew", () => {
    const raw = serializePending("testo", NOW + 60_000)
    expect(parsePending(raw, NOW).status).toBe("ok")
  })
  test("rejects garbage, wrong version, wrong types and empty text", () => {
    expect(parsePending("not json", NOW).status).toBe("invalid")
    expect(parsePending("null", NOW).status).toBe("invalid")
    expect(parsePending(JSON.stringify({ v: 2, text: "a", createdAt: NOW }), NOW).status).toBe("invalid")
    expect(parsePending(JSON.stringify({ v: 1, text: 5, createdAt: NOW }), NOW).status).toBe("invalid")
    expect(parsePending(JSON.stringify({ v: 1, text: "a", createdAt: "x" }), NOW).status).toBe("invalid")
    expect(parsePending(JSON.stringify({ v: 1, text: "  ", createdAt: NOW }), NOW).status).toBe("invalid")
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

describe("savePending and clearPending", () => {
  test("writes one file named after the session", () => {
    const fs = fakeFs()
    expect(savePending(SID, "testo", fs, NOW)).toBe(true)
    expect([...fs.files.keys()]).toEqual([`${DIR}/ses_abc123XYZ.json`])
    expect(parsePending(fs.files.get(`${DIR}/ses_abc123XYZ.json`)!, NOW)).toEqual({ status: "ok", text: "testo" })
  })
  test("replaces the previous quote of the same session", () => {
    const fs = fakeFs()
    savePending(SID, "uno", fs, NOW)
    savePending(SID, "due", fs, NOW)
    expect(fs.files.size).toBe(1)
    expect(parsePending([...fs.files.values()][0]!, NOW)).toEqual({ status: "ok", text: "due" })
  })
  test("caps the stored text", () => {
    const fs = fakeFs()
    savePending(SID, "z".repeat(MAX_QUOTE_CHARS * 3), fs, NOW)
    const parsed = parsePending([...fs.files.values()][0]!, NOW)
    expect(parsed.status === "ok" && parsed.text.length < MAX_QUOTE_CHARS + 100).toBe(true)
  })
  test("refuses a bad session ID or blank text and touches nothing", () => {
    const fs = fakeFs()
    expect(savePending("../evil", "testo", fs, NOW)).toBe(false)
    expect(savePending(SID, "   ", fs, NOW)).toBe(false)
    expect(fs.touched).toEqual([])
  })
  test("returns false instead of throwing when the write fails", () => {
    const fs = fakeFs()
    fs.write = () => {
      throw new Error("disk full")
    }
    expect(savePending(SID, "testo", fs, NOW)).toBe(false)
  })
  test("clearPending removes the file and ignores errors and bad IDs", () => {
    const fs = fakeFs({ [`${DIR}/ses_abc123XYZ.json`]: "x" })
    clearPending(SID, fs)
    expect(fs.files.size).toBe(0)
    fs.failRemove = true
    expect(() => clearPending(SID, fs)).not.toThrow()
    const before = fs.touched.length
    clearPending("../evil", fs)
    expect(fs.touched.length).toBe(before)
  })
})

describe("loadPending", () => {
  const path = `${DIR}/ses_abc123XYZ.json`
  test("returns the text of a fresh pending quote and leaves the file", () => {
    const fs = fakeFs({ [path]: serializePending("citata", NOW) })
    expect(loadPending(SID, fs, NOW + 1000)).toBe("citata")
    expect(fs.files.has(path)).toBe(true)
  })
  test("returns undefined when missing, expired or corrupt", () => {
    expect(loadPending(SID, fakeFs(), NOW)).toBeUndefined()
    expect(loadPending(SID, fakeFs({ [path]: serializePending("a", NOW) }), NOW + PENDING_TTL_MS)).toBeUndefined()
    expect(loadPending(SID, fakeFs({ [path]: "###" }), NOW)).toBeUndefined()
  })
  test("returns undefined for a bad ID without touching the folder", () => {
    const fs = fakeFs()
    expect(loadPending("../x", fs, NOW)).toBeUndefined()
    expect(fs.touched).toEqual([])
  })
  test("returns undefined instead of throwing when reading fails", () => {
    const fs = fakeFs({ [path]: serializePending("a", NOW) })
    fs.failRead = true
    expect(loadPending(SID, fs, NOW)).toBeUndefined()
  })
})

describe("applyQuoteToPrompt", () => {
  const path = `${DIR}/ses_abc123XYZ.json`
  const eventFor = (sessionID: unknown, files?: unknown[]) => ({
    sessionID,
    messageID: "msg_1",
    prompt: { text: "il mio commento", ...(files ? { files } : {}) } as { text: string; files?: unknown[] },
    delivery: "steer",
  })

  test("does nothing when no pending file exists", () => {
    const fs = fakeFs()
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    expect(event.prompt).toEqual({ text: "il mio commento" })
    expect(fs.touched).toEqual([path])
  })

  test("attaches the quote as Citazione and consumes the file", () => {
    const fs = fakeFs({ [path]: serializePending("riga uno\nriga due", NOW) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW + 5000)
    const files = event.prompt.files as { uri: string; name: string; description: string }[]
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toBe(QUOTE_NAME)
    expect(QUOTE_NAME).toBe("Citazione")
    expect(typeof files[0]!.description).toBe("string")
    expect(decode(files[0]!.uri)).toBe("riga uno\nriga due")
    expect(fs.files.has(path)).toBe(false)
  })

  test("keeps existing files and the prompt text", () => {
    const fs = fakeFs({ [path]: serializePending("q", NOW) })
    const event = eventFor(SID, [{ uri: "file:///a.md" }])
    applyQuoteToPrompt(event, fs, NOW)
    expect((event.prompt.files as { uri: string }[])[0]!.uri).toBe("file:///a.md")
    expect(event.prompt.files).toHaveLength(2)
    expect(event.prompt.text).toBe("il mio commento")
  })

  test("attaches only once", () => {
    const fs = fakeFs({ [path]: serializePending("q", NOW) })
    applyQuoteToPrompt(eventFor(SID), fs, NOW)
    const second = eventFor(SID)
    applyQuoteToPrompt(second, fs, NOW)
    expect(second.prompt.files).toBeUndefined()
  })

  test("ignores and deletes an expired file", () => {
    const fs = fakeFs({ [path]: serializePending("vecchia", NOW) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW + PENDING_TTL_MS + 1)
    expect(event.prompt.files).toBeUndefined()
    expect(fs.files.has(path)).toBe(false)
  })

  test("ignores and deletes a corrupt file", () => {
    const fs = fakeFs({ [path]: "{{{" })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    expect(event.prompt.files).toBeUndefined()
    expect(fs.files.has(path)).toBe(false)
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
    const fs = fakeFs({ [other]: serializePending("altra sessione", NOW) })
    const event = eventFor(SID)
    applyQuoteToPrompt(event, fs, NOW)
    expect(event.prompt.files).toBeUndefined()
    expect(fs.files.has(other)).toBe(true)
    expect(fs.touched).toEqual([path])
  })

  test("never throws and leaves the prompt alone when reading fails", () => {
    const fs = fakeFs({ [path]: serializePending("q", NOW) })
    fs.failRead = true
    const event = eventFor(SID)
    expect(() => applyQuoteToPrompt(event, fs, NOW)).not.toThrow()
    expect(event.prompt.files).toBeUndefined()
  })

  test("skips the attachment when the file cannot be consumed", () => {
    const fs = fakeFs({ [path]: serializePending("q", NOW) })
    fs.failRemove = true
    const event = eventFor(SID)
    expect(() => applyQuoteToPrompt(event, fs, NOW)).not.toThrow()
    expect(event.prompt.files).toBeUndefined()
  })

  test("never throws on malformed events", () => {
    const fs = fakeFs({ [path]: serializePending("q", NOW) })
    for (const bad of [null, undefined, 5, "x", {}, { sessionID: SID }, { sessionID: SID, prompt: null }, { sessionID: SID, prompt: 4 }]) {
      expect(() => applyQuoteToPrompt(bad, fs, NOW)).not.toThrow()
    }
    expect(fs.files.has(path)).toBe(true)
  })

  test("does not log the quote text", () => {
    const logged: unknown[] = []
    const original = [console.log, console.error, console.warn, console.info]
    console.log = console.error = console.warn = console.info = (...args: unknown[]) => void logged.push(args)
    try {
      const fs = fakeFs({ [path]: serializePending("segretissimo", NOW) })
      applyQuoteToPrompt(eventFor(SID), fs, NOW)
      fs.failRead = true
      applyQuoteToPrompt(eventFor(SID), fs, NOW)
    } finally {
      ;[console.log, console.error, console.warn, console.info] = original
    }
    expect(JSON.stringify(logged)).not.toContain("segretissimo")
  })
})
