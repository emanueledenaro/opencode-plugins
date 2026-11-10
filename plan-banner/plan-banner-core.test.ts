import { describe, expect, test } from "bun:test"
import { FALLBACK_KEY, bannerText, keyLabel, lastReplyAgent, shouldShowBanner,
  bannerLine,
  createWidthTracker,
} from "./plan-banner-core"

// Message shapes copied from what OpenCode 2.2.6 returns from data.session.message.list().
const user = { id: "m", type: "user", text: "x", files: [], agents: [] }
const reply = (agent: string) => ({ id: "m", type: "assistant", agent, content: [{ type: "text", text: "ok" }], finish: "stop" })
const idle = { id: "m", type: "idle", outcome: "succeeded" }
const switched = (agent: string, previous: string) => ({ id: "m", type: "agent-switched", agent, previous })
const synthetic = { id: "m", type: "synthetic", text: "<system-reminder>You are in Plan mode</system-reminder>" }

describe("lastReplyAgent", () => {
  test("is the agent of the last assistant message", () => {
    expect(lastReplyAgent([user, reply("build"), idle, user, reply("plan"), idle])).toBe("plan")
  })
  test("a later reply under another agent replaces it", () => {
    expect(lastReplyAgent([user, reply("plan"), idle, switched("build", "plan"), user, reply("build"), idle])).toBe("build")
  })
  test("an agent-switched item alone does not change it", () => {
    expect(lastReplyAgent([user, reply("plan"), idle, switched("build", "plan")])).toBe("plan")
  })
  test("synthetic and idle items are skipped", () => {
    expect(lastReplyAgent([user, reply("plan"), synthetic, idle])).toBe("plan")
  })
  test("no assistant message gives null", () => {
    expect(lastReplyAgent([user, idle])).toBeNull()
    expect(lastReplyAgent([])).toBeNull()
  })
  test("an assistant message without an agent field gives null", () => {
    expect(lastReplyAgent([user, { type: "assistant", content: [] }])).toBeNull()
  })
  test("a last reply without an agent field does not fall back to an older plan reply", () => {
    expect(lastReplyAgent([reply("plan"), { type: "assistant", content: [] }])).toBeNull()
    expect(shouldShowBanner([reply("plan"), { type: "assistant", content: [] }])).toBe(false)
  })
  test("anything that is not a list gives null", () => {
    expect(lastReplyAgent(undefined)).toBeNull()
    expect(lastReplyAgent({})).toBeNull()
    expect(lastReplyAgent([null, 4, "plan"])).toBeNull()
  })
})

describe("shouldShowBanner", () => {
  test("true when the last reply ran under plan", () => {
    expect(shouldShowBanner([user, reply("plan")])).toBe(true)
  })
  test("false when the last reply ran under build", () => {
    expect(shouldShowBanner([user, reply("build")])).toBe(false)
  })
  test("false when plan was earlier but the last reply was build", () => {
    expect(shouldShowBanner([user, reply("plan"), user, reply("build")])).toBe(false)
  })
  test("false with no reply yet, even if the session just switched to plan", () => {
    expect(shouldShowBanner([switched("plan", "build"), synthetic, user])).toBe(false)
  })
  test("only the exact id plan counts", () => {
    expect(shouldShowBanner([reply("planner")])).toBe(false)
    expect(shouldShowBanner([reply("Plan")])).toBe(false)
  })
})

describe("keyLabel", () => {
  test("formats the first shortcut", () => {
    expect(keyLabel(["shift+tab"])).toBe("Shift+Tab")
    expect(keyLabel(["ctrl+x"])).toBe("Ctrl+X")
  })
  test("uses only the first of several shortcuts", () => {
    expect(keyLabel(["shift+tab", "ctrl+j"])).toBe("Shift+Tab")
  })
  test("falls back when there is no usable shortcut", () => {
    expect(keyLabel([])).toBe(FALLBACK_KEY)
    expect(keyLabel(undefined)).toBe(FALLBACK_KEY)
    expect(keyLabel([""])).toBe(FALLBACK_KEY)
    expect(keyLabel([42])).toBe(FALLBACK_KEY)
    expect(keyLabel("shift+tab")).toBe(FALLBACK_KEY)
  })
  test("the fallback is Shift+Tab", () => {
    expect(FALLBACK_KEY).toBe("Shift+Tab")
  })
})

describe("bannerText", () => {
  test("is the agreed Italian sentence with the key", () => {
    expect(bannerText("Shift+Tab")).toBe("La mia ultima risposta era in Plan: per farmi lavorare premi Shift+Tab e scrivimi.")
  })
})

describe("revert", () => {
  test("a reverted plan reply no longer shows the banner", () => {
    const messages = [
      { type: "assistant", agent: "build", id: "a1" },
      { type: "user", text: "x", id: "u2" },
      { type: "assistant", agent: "plan", id: "a3" },
    ]
    expect(shouldShowBanner(messages)).toBe(true)
    expect(shouldShowBanner(messages, "u2")).toBe(false)
    expect(shouldShowBanner(messages, "missing")).toBe(true)
  })
})

describe("bannerLine", () => {
  const KEY = "Shift+Tab"
  test("the full sentence when it fits", () => {
    const full = bannerText(KEY)
    expect(bannerLine(KEY, full.length)).toBe(full)
    expect(bannerLine(KEY, 200)).toBe(full)
  })
  test("shorter wordings as the width shrinks", () => {
    expect(bannerLine(KEY, 70)).toBe("Ultima risposta in Plan: premi Shift+Tab per farmi lavorare.")
    expect(bannerLine(KEY, 45)).toBe("Ultima risposta in Plan: premi Shift+Tab.")
    expect(bannerLine(KEY, 30)).toBe("Plan: premi Shift+Tab")
    expect(bannerLine(KEY, 15)).toBe("Plan")
  })
  test("nothing when even the shortest does not fit", () => {
    expect(bannerLine(KEY, 3)).toBeNull()
    expect(bannerLine(KEY, 0)).toBeNull()
  })
  test("never wider than the width, at every width", () => {
    for (let width = 0; width <= 120; width++) {
      const line = bannerLine(KEY, width)
      if (line !== null) expect(line.length).toBeLessThanOrEqual(width)
    }
  })
  test("a width that is not a number counts as no limit", () => {
    expect(bannerLine(KEY, Number.NaN)).toBe(bannerText(KEY))
  })
  test("the key is the one given", () => {
    expect(bannerLine("Ctrl+P", 30)).toBe("Plan: premi Ctrl+P")
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
    const t = createWidthTracker({ initial: 80, onChange: (w) => seen.push(w), scheduler: fake().scheduler })
    t.report(60)
    expect(seen).toEqual([60])
  })
  test("a burst of sizes becomes one update with the last size, 50 ms later", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 80, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(60)
    for (const w of [59, 58, 57, 56]) t.report(w)
    expect(seen).toEqual([60])
    expect(f.jobs).toHaveLength(1)
    expect(f.jobs[0]!.ms).toBe(50)
    f.jobs[0]!.fn()
    expect(seen).toEqual([60, 56])
  })
  test("the same size again does no work", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 80, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(60)
    t.report(60)
    t.report(60.6)
    expect(f.jobs).toHaveLength(0)
    expect(seen).toEqual([60])
  })
  test("a burst that ends where it began changes nothing", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 80, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(60)
    t.report(20)
    t.report(60)
    f.jobs[0]?.fn()
    expect(seen).toEqual([60])
  })
  test("zero, negative and NaN are ignored", () => {
    const seen: number[] = []
    const t = createWidthTracker({ initial: 80, onChange: (w) => seen.push(w), scheduler: fake().scheduler })
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
    const t = createWidthTracker({ initial: 80, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(60)
    t.report(30)
    t.dispose()
    expect(f.jobs).toHaveLength(0)
    expect(seen).toEqual([60])
  })
})
