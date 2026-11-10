import { describe, expect, test } from "bun:test"
import {
  MAX_FINISHED,
  MAX_ROWS,
  SPINNER_FRAMES,
  buildView,
  clockIt,
  createRunTracker,
  displayTitle,
  fit,
  shortModel,
  spinnerFrame,
  toolDetail,
  type ChildInput,
  type View,
} from "./agents-core"

const NOW = 1_000_000_000
const MIN = 60_000

const child = (over: Partial<ChildInput> & { id: string }): ChildInput => ({
  title: `Compito ${over.id}`,
  createdAt: NOW - MIN,
  updatedAt: NOW - MIN,
  running: false,
  permissionPending: false,
  formPending: false,
  ...over,
})

/** Plain-text version of a view, the way the sidebar draws it (spinner frame 2 = "⠹"). */
function lines(view: View): string[] {
  if (view.empty) return [view.emptyText]
  const out = [view.header.title + view.header.count]
  for (const group of view.groups) {
    out.push("")
    out.push(`${group.kind === "working" ? spinnerFrame(2) : group.icon} ${group.title}`)
    for (const row of group.rows) {
      out.push(`${row.mark ?? ""}${row.lead}${row.name}${row.time}`)
      if (row.detail) out.push(row.detail)
    }
  }
  if (view.hidden > 0) out.push(view.hiddenText)
  return out
}

describe("clockIt", () => {
  test("seconds, minutes, hours, days, compact", () => {
    expect(clockIt(0, false)).toBe("0s")
    expect(clockIt(40_000, false)).toBe("40s")
    expect(clockIt(59_999, false)).toBe("59s")
    expect(clockIt(60_000, false)).toBe("1m")
    expect(clockIt(12 * MIN, false)).toBe("12m")
    expect(clockIt(59 * MIN, false)).toBe("59m")
    expect(clockIt(60 * MIN, false)).toBe("1h")
    expect(clockIt(23 * 60 * MIN, false)).toBe("23h")
    expect(clockIt(24 * 60 * MIN, false)).toBe("1g")
  })

  test("a finished time gets ' fa'", () => {
    expect(clockIt(3 * MIN, true)).toBe("3m fa")
    expect(clockIt(40_000, true)).toBe("40s fa")
  })

  test("a negative gap (clock skew) reads as 0s", () => {
    expect(clockIt(-5_000, false)).toBe("0s")
  })
})

describe("fit", () => {
  test("keeps text that fits, cuts longer text with an ellipsis, never exceeds the width", () => {
    expect(fit("abc", 3)).toBe("abc")
    expect(fit("abcd", 3)).toBe("ab…")
    expect(fit("abcdef", 4)).toHaveLength(4)
  })
  test("zero or negative width gives an empty string", () => {
    expect(fit("abc", 0)).toBe("")
    expect(fit("abc", -2)).toBe("")
  })
  test("width 1 gives just the ellipsis", () => {
    expect(fit("abc", 1)).toBe("…")
  })
})

describe("shortModel", () => {
  test("the four known families get a fixed label and key", () => {
    expect(shortModel("claude-opus-5-5")).toEqual({ label: "Opus", key: "opus" })
    expect(shortModel("claude-sonnet-5-5")).toEqual({ label: "Sonnet", key: "sonnet" })
    expect(shortModel("claude-haiku-5-5")).toEqual({ label: "Haiku", key: "haiku" })
    expect(shortModel("claude-fable-5-2")).toEqual({ label: "Fable", key: "fable" })
  })
  test("matching ignores case and a provider prefix", () => {
    expect(shortModel("anthropic/Claude-OPUS-4")).toEqual({ label: "Opus", key: "opus" })
  })
  test("another model is shortened to its first word, at most 8 letters", () => {
    expect(shortModel("gpt-5.6-terra")).toEqual({ label: "Gpt", key: "other" })
    expect(shortModel("openai/gemini-2.5-pro")).toEqual({ label: "Gemini", key: "other" })
    expect(shortModel("deepseekcoderlarge")).toEqual({ label: "Deepseek", key: "other" })
  })
  test("no model is 'Agente'", () => {
    expect(shortModel(undefined)).toEqual({ label: "Agente", key: "other" })
    expect(shortModel("")).toEqual({ label: "Agente", key: "other" })
  })
})

describe("toolDetail", () => {
  test("a shell command is shown as typed, first line, spaces collapsed", () => {
    expect(toolDetail("shell", { command: "make check" })).toBe("make")
    expect(toolDetail("shell", { command: "  bun   test\nsecond line" })).toBe("bun")
    expect(toolDetail("shell", { command: 'TOKEN=x curl -H "Authorization: Bearer y" https://h' })).toBe("curl")
    expect(toolDetail("shell", { command: "sudo /usr/bin/env A=1 ls" })).toBe("env")
    expect(toolDetail("shell", { command: "export API_KEY=sk-ant-secret" })).toBe("export")
    expect(toolDetail("shell", { command: "rm -rf x", description: "Clean build output" })).toBe("Clean build output")
  })
  test("file tools show the tool and the file name", () => {
    expect(toolDetail("read", { path: "/a/b/file.ts" })).toBe("read file.ts")
    expect(toolDetail("edit", { path: "src/x.tsx" })).toBe("edit x.tsx")
    expect(toolDetail("write", { path: "/tmp/out.txt" })).toBe("write out.txt")
  })
  test("search tools show the pattern or query", () => {
    expect(toolDetail("grep", { pattern: "foo.*bar" })).toBe("grep")
    expect(toolDetail("glob", { pattern: "**/*.ts" })).toBe("glob")
    expect(toolDetail("websearch", { query: "opencode plugins" })).toBe("websearch")
  })
  test("a subagent shows its description, webfetch the host, skill its id", () => {
    expect(toolDetail("subagent", { description: "Cerca i test" })).toBe("Cerca i test")
    expect(toolDetail("webfetch", { url: "https://example.com/a?b=1" })).toBe("webfetch example.com")
    expect(toolDetail("skill", { id: "tdd" })).toBe("skill tdd")
  })
  test("when the input has nothing usable, the tool name is shown", () => {
    expect(toolDetail("shell", {})).toBe("shell")
    expect(toolDetail("execute", { code: "..." })).toBe("execute")
    expect(toolDetail("read", "not an object")).toBe("read")
  })
  test("no tool name gives nothing", () => {
    expect(toolDetail(undefined, { command: "ls" })).toBeUndefined()
    expect(toolDetail("", {})).toBeUndefined()
  })
})

describe("spinnerFrame", () => {
  test("ten braille frames that wrap around", () => {
    expect(SPINNER_FRAMES).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"])
    expect(spinnerFrame(0)).toBe("⠋")
    expect(spinnerFrame(9)).toBe("⠏")
    expect(spinnerFrame(10)).toBe("⠋")
    expect(spinnerFrame(22)).toBe("⠹")
  })
  test("a negative index does not break", () => {
    expect(spinnerFrame(-1)).toBe("⠏")
  })
})

describe("displayTitle", () => {
  test("keeps a real title and shortens a long one with an ellipsis", () => {
    expect(displayTitle("Cerca i test rotti", 40)).toBe("Cerca i test rotti")
    expect(displayTitle("a".repeat(50), 20)).toBe(`${"a".repeat(19)}…`)
  })
  test("replaces an empty or default OpenCode title with 'Subagente'", () => {
    expect(displayTitle(undefined, 40)).toBe("Subagente")
    expect(displayTitle("   ", 40)).toBe("Subagente")
    expect(displayTitle("Child session - 2026-11-10T10:00:00.000Z", 40)).toBe("Subagente")
    expect(displayTitle("New session - 2026-11-10T10:00:00.000Z", 40)).toBe("Subagente")
  })
  test("collapses line breaks so the row stays on one line", () => {
    expect(displayTitle("uno\ndue\n\ntre", 40)).toBe("uno due tre")
  })
})

describe("createRunTracker", () => {
  test("remembers when a run started and how it ended", () => {
    const t = createRunTracker()
    t.started("ses_a", 100)
    expect(t.get("ses_a")).toEqual({ startedAt: 100 })
    t.ended("ses_a", "done", 500)
    expect(t.get("ses_a")).toEqual({ startedAt: 100, endedAt: 500, outcome: "done" })
  })

  test("a new run clears the previous end", () => {
    const t = createRunTracker()
    t.started("ses_a", 100)
    t.ended("ses_a", "error", 200)
    t.started("ses_a", 300)
    expect(t.get("ses_a")).toEqual({ startedAt: 300 })
  })

  test("an end without a start is kept without a start time", () => {
    const t = createRunTracker()
    t.ended("ses_b", "stopped", 900)
    expect(t.get("ses_b")).toEqual({ endedAt: 900, outcome: "stopped" })
  })

  test("forget drops one session", () => {
    const t = createRunTracker()
    t.started("ses_a", 1)
    t.forget("ses_a")
    expect(t.get("ses_a")).toBeUndefined()
  })

  test("keeps at most 200 started runs, dropping the oldest", () => {
    const t = createRunTracker()
    for (let i = 0; i < 205; i++) t.started(`ses_${i}`, i)
    expect(t.get("ses_0")).toBeUndefined()
    expect(t.get("ses_4")).toBeUndefined()
    expect(t.get("ses_5")).toEqual({ startedAt: 5 })
    expect(t.get("ses_204")).toEqual({ startedAt: 204 })
  })

  test("remembers the model and the latest tool detail of a run", () => {
    const t = createRunTracker()
    t.started("ses_a", 100)
    t.model("ses_a", "claude-opus-5-5")
    t.tool("ses_a", "make check")
    expect(t.get("ses_a")).toEqual({ startedAt: 100, modelId: "claude-opus-5-5", tool: "make check" })
    t.tool("ses_a", "bun test")
    expect(t.get("ses_a")?.tool).toBe("bun test")
  })

  test("a new run keeps the model but drops the old tool detail and the old end", () => {
    const t = createRunTracker()
    t.started("ses_a", 100)
    t.model("ses_a", "claude-opus-5-5")
    t.tool("ses_a", "make check")
    t.ended("ses_a", "done", 200)
    t.started("ses_a", 300)
    expect(t.get("ses_a")).toEqual({ startedAt: 300, modelId: "claude-opus-5-5" })
  })

  test("finishing a run clears its tool detail", () => {
    const t = createRunTracker()
    t.started("ses_a", 100)
    t.tool("ses_a", "make check")
    t.ended("ses_a", "done", 200)
    expect(t.get("ses_a")?.tool).toBeUndefined()
  })

  test("model and tool also work before any start and stay inside the 200 cap", () => {
    const t = createRunTracker()
    for (let i = 0; i < 205; i++) t.model(`ses_${i}`, "m")
    expect(t.get("ses_0")).toBeUndefined()
    expect(t.get("ses_204")).toEqual({ modelId: "m" })
  })
})

describe("buildView, the approved mockup", () => {
  const children: ChildInput[] = [
    child({ id: "wait", title: "rilettura #103", modelId: "claude-opus-5-5", running: true, permissionPending: true, createdAt: NOW - 2 * MIN }),
    child({ id: "w1", title: "#90 allineamento", modelId: "claude-sonnet-5-5", running: true, createdAt: NOW - 12 * MIN }),
    child({ id: "w2", title: "citazioni", modelId: "claude-sonnet-5-5", running: true, createdAt: NOW - 4 * MIN }),
    child({ id: "d1", title: "rilettura plugin", modelId: "claude-opus-5-5", updatedAt: NOW - 3 * MIN }),
    child({ id: "d2", title: "#103 correzioni", modelId: "claude-sonnet-5-5", updatedAt: NOW - 20 * MIN }),
  ]
  const runs = {
    w1: { startedAt: NOW - 12 * MIN, tool: "make check" },
    w2: { startedAt: NOW - 4 * MIN, tool: "bun test" },
    d2: { startedAt: NOW - 25 * MIN, endedAt: NOW - 20 * MIN, outcome: "error" as const },
  }

  test("draws exactly the approved layout at 34 columns", () => {
    expect(lines(buildView(children, runs, NOW, 34))).toEqual([
      "SUBAGENTI" + "3".padStart(25),
      "",
      "⚠ Ti aspetta",
      "  Opus     rilettura #103       2m",
      "           └ chiede un permesso",
      "",
      "⠹ Al lavoro",
      "  Sonnet   #90 allineamento    12m",
      "           └ make check",
      "  Sonnet   citazioni            4m",
      "           └ bun test",
      "",
      "✓ Finiti",
      "  Opus     rilettura plugin  3m fa",
      "✗ Sonnet   #103 correzioni  20m fa",
    ])
  })

  test("every drawn line is at most the width", () => {
    for (const width of [24, 30, 34, 48]) {
      for (const line of lines(buildView(children, runs, NOW, width))) {
        expect([...line].length).toBeLessThanOrEqual(width)
      }
    }
  })

  test("rows with a time are exactly the width, so the time sits on the right edge", () => {
    for (const width of [24, 34, 48]) {
      const view = buildView(children, runs, NOW, width)
      for (const group of view.groups)
        for (const row of group.rows) expect([...`${row.mark ?? ""}${row.lead}${row.name}${row.time}`]).toHaveLength(width)
    }
  })

  test("a narrow sidebar cuts the name with an ellipsis but keeps model and time", () => {
    const out = lines(buildView(children, runs, NOW, 26))
    expect(out).toContain("  Sonnet   #90 allin…  12m")
    expect(out).toContain("  Sonnet   citazioni    4m")
  })
})

describe("buildView, groups and order", () => {
  test("working rows keep the oldest first, finished rows the newest first", () => {
    const view = buildView(
      [
        child({ id: "new", running: true, createdAt: NOW - 1 * MIN }),
        child({ id: "old", running: true, createdAt: NOW - 9 * MIN }),
        child({ id: "f_old", updatedAt: NOW - 30 * MIN }),
        child({ id: "f_new", updatedAt: NOW - 2 * MIN }),
      ],
      {},
      NOW,
      34,
    )
    expect(view.groups.map((g) => g.kind)).toEqual(["working", "done"])
    expect(view.groups[0].rows.map((r) => r.id)).toEqual(["old", "new"])
    expect(view.groups[1].rows.map((r) => r.id)).toEqual(["f_new", "f_old"])
  })

  test("groups come in the order waiting, working, done, and empty groups are left out", () => {
    const all = buildView(
      [
        child({ id: "d" }),
        child({ id: "r", running: true }),
        child({ id: "w", running: true, permissionPending: true }),
      ],
      {},
      NOW,
      34,
    )
    expect(all.groups.map((g) => g.kind)).toEqual(["waiting", "working", "done"])
    expect(all.groups.map((g) => g.title)).toEqual(["Ti aspetta", "Al lavoro", "Finiti"])
    expect(all.groups.map((g) => g.icon)).toEqual(["⚠", "", "✓"])
    const onlyDone = buildView([child({ id: "d" })], {}, NOW, 34)
    expect(onlyDone.groups.map((g) => g.kind)).toEqual(["done"])
  })

  test("a form waiting reads 'ha una domanda', a permission 'chiede un permesso', permission wins", () => {
    const rows = (over: Partial<ChildInput>) =>
      buildView([child({ id: "x", running: true, ...over })], {}, NOW, 40).groups[0].rows[0]
    expect(rows({ formPending: true }).detail).toBe("           └ ha una domanda")
    expect(rows({ permissionPending: true }).detail).toBe("           └ chiede un permesso")
    expect(rows({ permissionPending: true, formPending: true }).detail).toBe("           └ chiede un permesso")
  })

  test("an idle child with a pending permission still counts as waiting", () => {
    const view = buildView([child({ id: "x", running: false, permissionPending: true })], {}, NOW, 34)
    expect(view.groups[0].kind).toBe("waiting")
  })

  test("a waiting row has no tool detail, only the waiting text", () => {
    const view = buildView(
      [child({ id: "x", running: true, permissionPending: true })],
      { x: { startedAt: NOW - MIN, tool: "make check" } },
      NOW,
      40,
    )
    expect(view.groups[0].rows[0].detail).toContain("chiede un permesso")
  })

  test("a running row without a known tool has no detail line", () => {
    const view = buildView([child({ id: "x", running: true })], {}, NOW, 34)
    expect(view.groups[0].rows[0].detail).toBeUndefined()
  })

  test("the tool detail is cut to fit the width", () => {
    const view = buildView(
      [child({ id: "x", running: true })],
      { x: { startedAt: NOW - MIN, tool: "a very long shell command that does not fit" } },
      NOW,
      34,
    )
    const detail = view.groups[0].rows[0].detail ?? ""
    expect([...detail].length).toBeLessThanOrEqual(34)
    expect(detail.endsWith("…")).toBe(true)
    expect(detail.startsWith("           └ ")).toBe(true)
  })

  test("a finished row has no detail line", () => {
    const view = buildView([child({ id: "x" })], { x: { tool: "make check" } }, NOW, 34)
    expect(view.groups[0].rows[0].detail).toBeUndefined()
  })

  test("only an error gets the cross; a normal or stopped end does not", () => {
    const rows = (outcome: "done" | "error" | "stopped") =>
      buildView([child({ id: "x" })], { x: { endedAt: NOW - MIN, outcome } }, NOW, 34).groups[0].rows[0]
    expect(rows("error").mark).toBe("✗ ")
    expect(rows("done").mark).toBeUndefined()
    expect(rows("stopped").mark).toBeUndefined()
    expect(rows("error").failed).toBe(true)
    expect(rows("done").failed).toBe(false)
  })

  test("the model comes from the tracker first, then from the session", () => {
    const view = buildView(
      [
        child({ id: "a", running: true, modelId: "claude-sonnet-5-5" }),
        child({ id: "b", running: true, modelId: "claude-sonnet-5-5", createdAt: NOW - 2 * MIN }),
        child({ id: "c", running: true, createdAt: NOW - 3 * MIN }),
      ],
      { b: { startedAt: NOW - 2 * MIN, modelId: "claude-haiku-5-5" } },
      NOW,
      40,
    )
    const byId = Object.fromEntries(view.groups[0].rows.map((r) => [r.id, r.modelKey]))
    expect(byId).toEqual({ a: "sonnet", b: "haiku", c: "other" })
  })

  test("times: working shows the time since start, finished the time since the end plus 'fa'", () => {
    const view = buildView(
      [child({ id: "r", running: true, createdAt: NOW - 3 * MIN }), child({ id: "f", updatedAt: NOW - 2 * 60 * MIN })],
      {},
      NOW,
      34,
    )
    expect(view.groups[0].rows[0].time.trim()).toBe("3m")
    expect(view.groups[1].rows[0].time.trim()).toBe("2h fa")
  })

  test("tracker times and outcome override the session timestamps", () => {
    const view = buildView(
      [child({ id: "a", running: true, createdAt: NOW - 999 * MIN }), child({ id: "b", updatedAt: NOW - 999 * MIN })],
      { a: { startedAt: NOW - 20_000 }, b: { endedAt: NOW - 45_000, outcome: "error" } },
      NOW,
      34,
    )
    expect(view.groups[0].rows[0].time.trim()).toBe("20s")
    expect(view.groups[1].rows[0].time.trim()).toBe("45s fa")
    expect(view.groups[1].rows[0].failed).toBe(true)
  })

  test("a stale tracker outcome does not make a running child look finished", () => {
    const view = buildView(
      [child({ id: "r", running: true })],
      { r: { startedAt: NOW - 1_000, endedAt: NOW - 500, outcome: "error" } },
      NOW,
      34,
    )
    expect(view.groups[0].kind).toBe("working")
    expect(view.groups[0].rows[0].mark).toBeUndefined()
  })

  test("a child with no title is called 'Subagente'", () => {
    const view = buildView([child({ id: "x", title: undefined, running: true })], {}, NOW, 34)
    expect(view.groups[0].rows[0].name.trim()).toBe("Subagente")
  })
})

describe("buildView, header, empty state and the row cap", () => {
  test("the header counts the waiting and working children, right-aligned", () => {
    const view = buildView(
      [
        child({ id: "w", running: true, permissionPending: true }),
        child({ id: "r1", running: true }),
        child({ id: "r2", running: true }),
        child({ id: "d" }),
      ],
      {},
      NOW,
      34,
    )
    expect(view.header.title).toBe("SUBAGENTI")
    expect(view.header.count).toBe("3".padStart(25))
    expect(view.header.title.length + view.header.count.length).toBe(34)
  })

  test("with nothing active the header has no count", () => {
    const view = buildView([child({ id: "d" })], {}, NOW, 34)
    expect(view.header.count).toBe("")
  })

  test("no children is the empty state", () => {
    const view = buildView([], {}, NOW, 34)
    expect(view.empty).toBe(true)
    expect(view.emptyText).toBe("Nessun subagente")
    expect(view.groups).toEqual([])
  })

  test("some children is not the empty state", () => {
    expect(buildView([child({ id: "d" })], {}, NOW, 34).empty).toBe(false)
  })

  test("shows only the last 3 finished", () => {
    expect(MAX_FINISHED).toBe(3)
    const many = Array.from({ length: 6 }, (_, i) => child({ id: `f${i}`, updatedAt: NOW - (i + 1) * MIN }))
    const view = buildView(many, {}, NOW, 34)
    expect(view.groups[0].rows.map((r) => r.id)).toEqual(["f0", "f1", "f2"])
    expect(view.hidden).toBe(0)
  })

  test("never more than 10 rows: active rows first, then finished fill what is left", () => {
    expect(MAX_ROWS).toBe(10)
    const running = Array.from({ length: 8 }, (_, i) => child({ id: `r${i}`, running: true, createdAt: NOW - (i + 1) * MIN }))
    const done = Array.from({ length: 3 }, (_, i) => child({ id: `f${i}`, updatedAt: NOW - (i + 1) * MIN }))
    const view = buildView([...running, ...done], {}, NOW, 34)
    const total = view.groups.reduce((n, g) => n + g.rows.length, 0)
    expect(total).toBe(10)
    expect(view.groups.find((g) => g.kind === "done")?.rows).toHaveLength(2)
    expect(view.hidden).toBe(0)
  })

  test("too many active rows are cut at 10 and the rest is counted", () => {
    const running = Array.from({ length: 13 }, (_, i) => child({ id: `r${i}`, running: true, createdAt: NOW - (i + 1) * MIN }))
    const view = buildView([...running, child({ id: "f" })], {}, NOW, 34)
    const total = view.groups.reduce((n, g) => n + g.rows.length, 0)
    expect(total).toBe(10)
    expect(view.groups.some((g) => g.kind === "done")).toBe(false)
    expect(view.hidden).toBe(3)
    expect(view.hiddenText).toBe("+3 altri")
  })

  test("waiting rows are never cut in favour of working rows", () => {
    const waiting = Array.from({ length: 4 }, (_, i) => child({ id: `w${i}`, running: true, permissionPending: true }))
    const running = Array.from({ length: 9 }, (_, i) => child({ id: `r${i}`, running: true }))
    const view = buildView([...running, ...waiting], {}, NOW, 34)
    expect(view.groups[0].kind).toBe("waiting")
    expect(view.groups[0].rows).toHaveLength(4)
    expect(view.groups[1].rows).toHaveLength(6)
    expect(view.hidden).toBe(3)
  })

  test("a width below 24 is treated as 24 so nothing overflows", () => {
    const view = buildView([child({ id: "r", running: true, title: "x".repeat(60) })], {}, NOW, 5)
    const row = view.groups[0].rows[0]
    expect([...`${row.mark ?? ""}${row.lead}${row.name}${row.time}`]).toHaveLength(24)
  })
})
