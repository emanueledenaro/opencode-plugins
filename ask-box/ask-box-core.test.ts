import { describe, expect, test } from "bun:test"
import {
  MAX_ASK_LINES,
  askLineCap,
  askText,
  createWidthTracker,
  capAsk,
  currentAsk,
  extractAsk,
  stripMarkdown,
  toTurns,
  wrapLines,
  visibleEnd,
} from "./ask-box-core"

// Message shapes copied from what OpenCode 2.2.6 returns from data.session.message.list().
const user = (text: string) => ({ id: "m", type: "user", text, files: [], agents: [] })
const assistant = (...texts: string[]) => ({
  id: "m",
  type: "assistant",
  agent: "build",
  content: texts.map((text) => ({ type: "text", text })),
  finish: "stop",
})
const idle = { id: "m", type: "idle", outcome: "succeeded" }
const synthetic = { id: "m", type: "synthetic", text: "<system-reminder>x</system-reminder>" }
const switched = { id: "m", type: "agent-switched", agent: "plan", previous: "build" }

describe("extractAsk", () => {
  test("takes the text after the marker on the same line", () => {
    expect(extractAsk("Fatto.\n\nServe da te: scegli A o B?")).toBe("scegli A o B?")
  })
  test("bold marker followed by a numbered list", () => {
    expect(extractAsk("Ecco.\n\n**Serve da te:**\n1. Versione corta?\n2. Anche i test?")).toBe("1. Versione corta?\n2. Anche i test?")
  })
  test("bold marker with the colon outside the bold", () => {
    expect(extractAsk("**Serve da te**: ok o no?")).toBe("ok o no?")
  })
  test("same line text plus a list below", () => {
    expect(extractAsk("Serve da te: scegli\n1. A\n2. B")).toBe("scegli\n1. A\n2. B")
  })
  test("the last marker wins", () => {
    expect(extractAsk("Serve da te: vecchia\n\ntesto\n\nServe da te: nuova")).toBe("nuova")
  })
  test("no marker gives null", () => {
    expect(extractAsk("Tutto a posto, niente da chiedere.")).toBeNull()
  })
  test("a marker with nothing after it gives null", () => {
    expect(extractAsk("Fatto.\nServe da te:")).toBeNull()
  })
  test("the marker is case insensitive", () => {
    expect(extractAsk("serve da te: risposta")).toBe("risposta")
  })
  test("the marker must start the line", () => {
    expect(extractAsk("Ti ripeto che serve da te: niente")).toBeNull()
  })
  test("a paragraph after a blank line is not part of the block", () => {
    expect(extractAsk("Serve da te: x\n\nGrazie per la pazienza.")).toBe("x")
  })
  test("a list after a blank line is part of the block", () => {
    expect(extractAsk("Serve da te:\n\n1. a\n2. b")).toBe("1. a\n2. b")
  })
  test("a wrapped continuation line without a blank is part of the block", () => {
    expect(extractAsk("Serve da te: scegli tra\nle due opzioni")).toBe("scegli tra\nle due opzioni")
  })
  test("a heading or quote prefix before the marker is accepted", () => {
    expect(extractAsk("## Serve da te:\n1. x")).toBe("1. x")
    expect(extractAsk("> Serve da te: y")).toBe("y")
  })
  test("CRLF line endings", () => {
    expect(extractAsk("Serve da te:\r\n1. a\r\n2. b\r\n")).toBe("1. a\n2. b")
  })
  test("markdown inside the block is stripped", () => {
    expect(extractAsk("Serve da te: **scegli** `A` o [B](http://x.example)")).toBe("scegli A o B")
  })
})

describe("bold around the marker line", () => {
  test("whole line in bold: the trailing closer is dropped", () => {
    expect(extractAsk("**Serve da te: niente per ora.**")).toBe("niente per ora.")
  })
  test("bold on the label only: text is kept as written", () => {
    expect(extractAsk("**Serve da te:** scegli A o B")).toBe("scegli A o B")
  })
  test("bold on the label with the colon outside, text ending in a bold word", () => {
    expect(extractAsk("**Serve da te**: scegli **A**")).toBe("scegli A")
  })
  test("a real bold in the middle of the text stays", () => {
    expect(extractAsk("Serve da te: a **b** c")).toBe("a b c")
    expect(extractAsk("Serve da te: **b** c")).toBe("b c")
    expect(extractAsk("**Serve da te: a **b** c**")).toBe("a b c")
    expect(extractAsk("Serve da te:**b** c")).toBe("b c")
  })
  test("bold across two lines", () => {
    expect(extractAsk("**Serve da te: scegli\nA o B?**")).toBe("scegli\nA o B?")
  })
  test("a paired bold at the end of the first line is not taken for the closer of a multi-line bold", () => {
    expect(extractAsk("**Serve da te: scegli **A**\nB**")).toBe("scegli A\nB")
  })
  test("underscores and backticks work like asterisks", () => {
    expect(extractAsk("__Serve da te: niente.__")).toBe("niente.")
    expect(extractAsk("`Serve da te: niente.`")).toBe("niente.")
  })
  test("bold line followed by a list", () => {
    expect(extractAsk("**Serve da te: scegli:**\n1. A\n2. B")).toBe("scegli:\n1. A\n2. B")
  })
})

describe("stripMarkdown", () => {
  test("bold, italic, code and links", () => {
    expect(stripMarkdown("**a** __b__ *c* `d` [e](http://x.example)")).toBe("a b c d e")
  })
  test("star and plus bullets become dashes, numbers stay", () => {
    expect(stripMarkdown("* uno\n+ due\n3. tre")).toBe("- uno\n- due\n3. tre")
  })
  test("plain text is untouched", () => {
    expect(stripMarkdown("2 * 3 = 6")).toBe("2 * 3 = 6")
  })
})

describe("wrapLines and capAsk", () => {
  test("wrapLines breaks on words at the width", () => {
    expect(wrapLines("uno due tre quattro", 8)).toEqual(["uno due", "tre", "quattro"])
  })
  test("wrapLines keeps a line that fits the width exactly", () => {
    expect(wrapLines("abc def", 7)).toEqual(["abc def"])
  })
  test("wrapLines breaks a word longer than the width", () => {
    expect(wrapLines("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
  })
  test("wrapLines keeps explicit line breaks", () => {
    expect(wrapLines("a\n\nb", 10)).toEqual(["a", "", "b"])
  })
  test("short text is returned unchanged", () => {
    expect(capAsk("scegli A o B?", 30)).toBe("scegli A o B?")
  })
  test("text over the line limit is cut to exactly the limit with an ellipsis", () => {
    const text = Array.from({ length: 20 }, (_, i) => `riga ${i + 1}`).join("\n")
    const out = capAsk(text, 30)
    const lines = out.split("\n")
    expect(lines).toHaveLength(MAX_ASK_LINES)
    expect(lines[MAX_ASK_LINES - 1]!.endsWith("…")).toBe(true)
    expect(lines[0]).toBe("riga 1")
  })
  test("a long single paragraph counts its wrapped lines", () => {
    const text = "parola ".repeat(60).trim()
    const out = capAsk(text, 20)
    expect(out.split("\n").length).toBeLessThanOrEqual(MAX_ASK_LINES)
    expect(out.endsWith("…")).toBe(true)
  })
  test("exactly the limit is not cut", () => {
    const text = Array.from({ length: MAX_ASK_LINES }, (_, i) => `r${i}`).join("\n")
    expect(capAsk(text, 30)).toBe(text)
  })
  test("the ellipsis never makes the last line longer than the width", () => {
    const text = Array.from({ length: 12 }, () => "x".repeat(10)).join("\n")
    const last = capAsk(text, 10).split("\n").at(-1)!
    expect(last.length).toBeLessThanOrEqual(10)
  })
})

describe("toTurns", () => {
  test("keeps user text and joins assistant text parts", () => {
    expect(toTurns([user("ciao"), assistant("a", "b")])).toEqual([
      { role: "user", text: "ciao" },
      { role: "assistant", text: "a\nb" },
    ])
  })
  test("ignores idle, synthetic and agent-switched messages", () => {
    expect(toTurns([idle, synthetic, switched])).toEqual([])
  })
  test("ignores non text parts of an assistant message", () => {
    const msg = {
      type: "assistant",
      content: [{ type: "tool", name: "read" }, { type: "reasoning", text: "Serve da te: pensiero" }, { type: "text", text: "ok" }],
    }
    expect(toTurns([msg])).toEqual([{ role: "assistant", text: "ok" }])
  })
  test("anything that is not a list gives no turns", () => {
    expect(toTurns(undefined)).toEqual([])
    expect(toTurns({})).toEqual([])
    expect(toTurns([null, 3, "x"])).toEqual([])
  })
})

describe("currentAsk", () => {
  test("shows the ask of the last assistant message", () => {
    expect(currentAsk([user("uno"), assistant("Fatto.\n\nServe da te: scegli A o B?"), idle])).toBe("scegli A o B?")
  })
  test("hides it once the owner sends a new message", () => {
    expect(currentAsk([user("uno"), assistant("Serve da te: scegli"), idle, user("A")])).toBeNull()
  })
  test("a user message without text (files only) still hides it", () => {
    expect(currentAsk([user("uno"), assistant("Serve da te: scegli"), { type: "user", files: [{}] }])).toBeNull()
  })
  test("shows it again if the next answer asks again", () => {
    expect(currentAsk([user("uno"), assistant("Serve da te: a"), user("A"), assistant("Serve da te: b")])).toBe("b")
  })
  test("synthetic and agent-switched messages do not hide it", () => {
    expect(currentAsk([user("uno"), assistant("Serve da te: scegli"), switched, synthetic, idle])).toBe("scegli")
  })
  test("a later assistant reply without an ask hides the earlier ask", () => {
    expect(currentAsk([user("uno"), assistant("Serve da te: scegli"), assistant("Sto ancora lavorando.")])).toBeNull()
  })
  test("a later message with no text (only tools) does not hide the ask", () => {
    const tools = { type: "assistant", content: [{ type: "tool", name: "read" }] }
    expect(currentAsk([user("uno"), assistant("Serve da te: scegli"), tools])).toBe("scegli")
  })
  test("the latest ask after the last user message wins", () => {
    expect(currentAsk([user("uno"), assistant("Serve da te: prima"), assistant("Serve da te: dopo")])).toBe("dopo")
  })
  test("an ask before the last user message is never shown", () => {
    expect(currentAsk([assistant("Serve da te: vecchia"), user("risposta"), assistant("Fatto.")])).toBeNull()
  })
  test("no messages or no ask gives null", () => {
    expect(currentAsk(undefined)).toBeNull()
    expect(currentAsk([])).toBeNull()
    expect(currentAsk([user("uno"), assistant("Tutto fatto.")])).toBeNull()
  })
  test("an ask with no user message at all is shown", () => {
    expect(currentAsk([assistant("Serve da te: ciao")])).toBe("ciao")
  })
})

describe("currentAsk on long, streaming and reverted sessions", () => {
  const ask = (n: number, extra: object = {}) => ({ type: "assistant", content: [{ type: "text", text: `Serve da te: domanda ${n}` }], ...extra })
  test("skips a reply that is still streaming", () => {
    const messages = [ask(1, { time: { completed: 1 } }), ask(2, { time: { created: 2 } })]
    expect(currentAsk(messages)).toBe("domanda 1")
  })
  test("a streaming reply without an ask does not hide the ask of the last completed one", () => {
    const streaming = { type: "assistant", content: [{ type: "text", text: "Sto scrivendo" }], time: { created: 2 } }
    expect(currentAsk([ask(1, { time: { completed: 1 } }), streaming])).toBe("domanda 1")
  })
  test("once it completes without an ask, the box is gone", () => {
    const done = { type: "assistant", content: [{ type: "text", text: "Fatto." }], time: { created: 2, completed: 3 } }
    expect(currentAsk([ask(1, { time: { completed: 1 } }), done])).toBeNull()
  })
  test("ignores the reverted message and everything after it", () => {
    const messages = [ask(1, { id: "m1" }), { type: "user", text: "ok", id: "m2" }, ask(3, { id: "m3" })]
    expect(currentAsk(messages, "m2")).toBe("domanda 1")
    expect(visibleEnd(messages, "m2")).toBe(1)
    expect(visibleEnd(messages, "nope")).toBe(3)
  })
  test("stops at the last user message without reading older replies", () => {
    const poisoned = { type: "assistant", get content(): unknown { throw new Error("read an old reply") } }
    expect(currentAsk([poisoned, { type: "user", text: "ciao" }, ask(2)])).toBe("domanda 2")
  })
})

describe("askLineCap", () => {
  test("8 lines in a normal sidebar, more when it is narrow so the text shown stays about the same", () => {
    expect(askLineCap(42)).toBe(8)
    expect(askLineCap(36)).toBe(8)
    expect(askLineCap(32)).toBe(9)
    expect(askLineCap(24)).toBe(12)
  })
  test("rounds up, so the shown text is never less than 288 characters", () => {
    expect(askLineCap(30)).toBe(10)
    expect(askLineCap(25)).toBe(12)
  })
  test("never below 8 and never above 12", () => {
    expect(askLineCap(200)).toBe(8)
    expect(askLineCap(3)).toBe(12)
  })
  test("a width that is not usable gives the default", () => {
    expect(askLineCap(0)).toBe(MAX_ASK_LINES)
    expect(askLineCap(Number.NaN)).toBe(MAX_ASK_LINES)
    expect(askLineCap(-5)).toBe(MAX_ASK_LINES)
  })
})

describe("capAsk with a line limit", () => {
  const long = Array.from({ length: 30 }, (_, i) => `riga numero ${i}`).join("\n")
  test("the limit is the third argument", () => {
    expect(capAsk(long, 40, 3).split("\n")).toHaveLength(3)
    expect(capAsk(long, 40, 3).endsWith("…")).toBe(true)
  })
  test("the default is still MAX_ASK_LINES", () => {
    expect(capAsk(long, 40).split("\n")).toHaveLength(MAX_ASK_LINES)
  })
})

describe("askText", () => {
  test("wraps at the measured width and caps at the cap for that width", () => {
    const text = Array.from({ length: 40 }, (_, i) => `punto ${i} della lista`).join("\n")
    expect(askText(text, 36).split("\n")).toHaveLength(8)
    expect(askText(text, 24).split("\n")).toHaveLength(12)
  })
  test("no line is wider than the width", () => {
    const text = "Conferma se devo usare la modalità lunga con tutti i dettagli del progetto e dei file coinvolti"
    for (let width = 5; width <= 60; width++) {
      for (const line of askText(text, width).split("\n")) expect([...line].length).toBeLessThanOrEqual(width)
    }
  })
})

describe("createWidthTracker", () => {
  const fake = () => {
    const jobs: { fn: () => void; ms: number; id: number }[] = []
    let id = 0
    return {
      jobs,
      scheduler: {
        set: (fn: () => void, ms: number) => {
          jobs.push({ fn, ms, id: ++id })
          return id
        },
        clear: (handle: unknown) => {
          const at = jobs.findIndex((job) => job.id === handle)
          if (at >= 0) jobs.splice(at, 1)
        },
      },
    }
  }
  test("the first measurement is applied at once", () => {
    const seen: number[] = []
    const t = createWidthTracker({ initial: 32, onChange: (w) => seen.push(w), scheduler: fake().scheduler })
    t.report(40)
    expect(seen).toEqual([40])
  })
  test("a burst of sizes becomes one update with the last size, 50 ms later", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 32, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(40)
    for (const w of [39, 38, 37, 36]) t.report(w)
    expect(seen).toEqual([40])
    expect(f.jobs).toHaveLength(1)
    expect(f.jobs[0]!.ms).toBe(50)
    f.jobs[0]!.fn()
    expect(seen).toEqual([40, 36])
  })
  test("the same size again does no work", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 32, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(40)
    t.report(40)
    t.report(40.6)
    expect(f.jobs).toHaveLength(0)
    expect(seen).toEqual([40])
  })
  test("a burst that ends where it began changes nothing", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 32, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(40)
    t.report(20)
    t.report(40)
    f.jobs[0]?.fn()
    expect(seen).toEqual([40])
  })
  test("zero, negative and NaN are ignored", () => {
    const seen: number[] = []
    const t = createWidthTracker({ initial: 32, onChange: (w) => seen.push(w), scheduler: fake().scheduler })
    t.report(0)
    t.report(-3)
    t.report(Number.NaN)
    expect(seen).toEqual([])
  })
  test("a report after dispose starts nothing", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 80, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(60)
    t.dispose()
    t.report(30)
    expect(f.jobs).toHaveLength(0)
    expect(seen).toEqual([60])
  })
  test("dispose cancels the pending update", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 32, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(40)
    t.report(30)
    t.dispose()
    expect(f.jobs).toHaveLength(0)
    expect(seen).toEqual([40])
  })
})
