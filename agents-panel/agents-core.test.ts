import { describe, expect, test } from "bun:test"
import {
  MAX_FINISHED,
  MAX_ROWS,
  MODEL_HUES,
  SPINNER_FRAMES,
  STATE_HUES,
  buildView,
  createRefreshBatch,
  REFRESH_BATCH_MS,
  createRunTracker,
  createWidthTracker,
  displayTitle,
  fit,
  headerState,
  oneLine,
  relativeIt,
  rowLayout,
  rowTime,
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

/** Plain-text version of a view, the way the sidebar draws it (spinner frame 2 = "▗"). */
function lines(view: View): string[] {
  if (view.empty) return []
  const out = [view.header.title + view.header.state]
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

describe("relativeIt", () => {
  test("under a minute is '<1m', never seconds that change on every tick", () => {
    expect(relativeIt(0)).toBe("<1m")
    expect(relativeIt(40_000)).toBe("<1m")
    expect(relativeIt(59_999)).toBe("<1m")
  })

  test("minutes, then hours with minutes, then days with hours", () => {
    expect(relativeIt(60_000)).toBe("1m")
    expect(relativeIt(12 * MIN)).toBe("12m")
    expect(relativeIt(59 * MIN)).toBe("59m")
    expect(relativeIt(65 * MIN)).toBe("1h 5m")
    expect(relativeIt(23 * 60 * MIN + 59 * MIN)).toBe("23h 59m")
    expect(relativeIt(51 * 60 * MIN)).toBe("2g 3h")
  })

  test("a smaller unit that is 0 is left out", () => {
    expect(relativeIt(60 * MIN)).toBe("1h")
    expect(relativeIt(24 * 60 * MIN)).toBe("1g")
    expect(relativeIt(48 * 60 * MIN + 30 * MIN)).toBe("2g")
  })

  test("a negative gap (clock skew) or a value that is not a number reads as '<1m'", () => {
    expect(relativeIt(-5_000)).toBe("<1m")
    expect(relativeIt(Number.NaN)).toBe("<1m")
    expect(relativeIt(Number.POSITIVE_INFINITY)).toBe("<1m")
  })
})

describe("rowTime", () => {
  test("an agent at work shows how long it has run", () => {
    expect(rowTime(12 * MIN, "working")).toBe("12m")
  })
  test("a finished agent shows how long ago it ended", () => {
    expect(rowTime(3 * MIN, "done")).toBe("3m fa")
    expect(rowTime(40_000, "done")).toBe("<1m fa")
  })
  test("an agent that waits for you shows since when", () => {
    expect(rowTime(2 * MIN, "waiting")).toBe("da 2m")
    expect(rowTime(65 * MIN, "waiting")).toBe("da 1h 5m")
  })
})

describe("oneLine", () => {
  test("line breaks and runs of spaces become one space", () => {
    expect(oneLine("  uno\ndue\t\ttre  ")).toBe("uno due tre")
  })
  test("escape codes and other control characters are removed, so the text cannot move the cursor", () => {
    expect(oneLine("ok\u001b[2Jfine\u0007")).toBe("ok[2Jfine")
    expect(oneLine("a\u009bb\u007fc")).toBe("abc")
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
  test("a shell command shows the agent's description, else only the program, never the command line", () => {
    expect(toolDetail("shell", { command: "make check" })).toBe("esegue make")
    expect(toolDetail("shell", { command: "  bun   test\nsecond line" })).toBe("esegue bun")
    expect(toolDetail("shell", { command: 'TOKEN=x curl -H "Authorization: Bearer y" https://h' })).toBe("esegue curl")
    expect(toolDetail("shell", { command: "sudo /usr/bin/env A=1 ls" })).toBe("esegue env")
    expect(toolDetail("shell", { command: "export API_KEY=sk-ant-secret" })).toBe("esegue export")
    expect(toolDetail("shell", { command: "rm -rf x", description: "Clean build output" })).toBe("Clean build output")
  })
  test("file tools say what happens to which file, in Italian", () => {
    expect(toolDetail("read", { path: "/a/b/file.ts" })).toBe("legge file.ts")
    expect(toolDetail("edit", { path: "src/x.tsx" })).toBe("modifica x.tsx")
    expect(toolDetail("write", { path: "/tmp/out.txt" })).toBe("scrive out.txt")
  })
  test("search tools say where they search, never the pattern or the query", () => {
    expect(toolDetail("grep", { pattern: "foo.*bar" })).toBe("cerca nei file")
    expect(toolDetail("glob", { pattern: "**/*.ts" })).toBe("cerca nei file")
    expect(toolDetail("websearch", { query: "opencode plugins" })).toBe("cerca sul web")
  })
  test("a subagent shows its description, a page its host, a skill its id", () => {
    expect(toolDetail("subagent", { description: "Cerca i test" })).toBe("Cerca i test")
    expect(toolDetail("webfetch", { url: "https://example.com/a?b=1" })).toBe("apre example.com")
    expect(toolDetail("skill", { id: "tdd" })).toBe("usa la skill tdd")
  })
  test("when the input has nothing usable, the line still reads as a sentence", () => {
    expect(toolDetail("shell", {})).toBe("esegue un comando")
    expect(toolDetail("read", "not an object")).toBe("legge un file")
    expect(toolDetail("subagent", {})).toBe("avvia un subagente")
    expect(toolDetail("webfetch", { url: "not a url" })).toBe("apre una pagina")
    expect(toolDetail("skill", {})).toBe("usa la skill")
  })
  test("no tool name of the host is ever shown", () => {
    expect(toolDetail("execute", { code: "..." })).toBe("esegue uno script")
    expect(toolDetail("browse_click", { ref: "e12" })).toBe("usa uno strumento")
    // "subagent" is left out of the list: the Italian "subagente" is the owner's own word.
    const names = ["shell", "read", "edit", "write", "grep", "glob", "websearch", "webfetch", "execute", "browse_click"]
    for (const name of names) expect(toolDetail(name, {})).not.toContain(name)
  })
  test("no tool name gives nothing", () => {
    expect(toolDetail(undefined, { command: "ls" })).toBeUndefined()
    expect(toolDetail("", {})).toBeUndefined()
  })
})

describe("model colours", () => {
  test("no model takes a hue that means a state in this panel (orange waits for you, green done, red failed)", () => {
    expect(STATE_HUES).toEqual(["orange", "green", "red"])
    for (const pick of Object.values(MODEL_HUES)) if (pick) expect(STATE_HUES).not.toContain(pick.hue)
  })
  test("each known family has its own hue", () => {
    expect(MODEL_HUES.opus?.hue).toBe("blue")
    expect(MODEL_HUES.sonnet?.hue).toBe("cyan")
    expect(MODEL_HUES.haiku?.hue).toBe("yellow")
    expect(MODEL_HUES.fable?.hue).toBe("purple")
    expect(MODEL_HUES.other).toBeUndefined()
  })
})

describe("spinnerFrame", () => {
  test("four quadrant frames that wrap around (SF Mono and Menlo have no braille)", () => {
    expect(SPINNER_FRAMES).toEqual(["▘", "▝", "▗", "▖"])
    expect(spinnerFrame(0)).toBe("▘")
    expect(spinnerFrame(3)).toBe("▖")
    expect(spinnerFrame(4)).toBe("▘")
    expect(spinnerFrame(10)).toBe("▗")
  })
  test("a negative index does not break", () => {
    expect(spinnerFrame(-1)).toBe("▖")
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
  test("drops control characters from a title", () => {
    expect(displayTitle("rilettura\u001b[31m #103", 40)).toBe("rilettura[31m #103")
  })
  test("never cuts an emoji in half", () => {
    expect(displayTitle(`${"a".repeat(18)}😀bcd`, 20)).toBe(`${"a".repeat(18)}😀…`)
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

describe("createRunTracker, how long an agent has waited for you", () => {
  test("a request that was asked gives the run its waiting time", () => {
    const t = createRunTracker()
    t.started("ses_a", 100)
    t.asked("ses_a", "permission:p1", 400)
    expect(t.snapshot().ses_a).toEqual({ startedAt: 100, waitingSince: 400 })
  })

  test("the same request asked again keeps the first time", () => {
    const t = createRunTracker()
    t.asked("ses_a", "permission:p1", 400)
    t.asked("ses_a", "permission:p1", 900)
    expect(t.snapshot().ses_a?.waitingSince).toBe(400)
  })

  test("with two open requests the oldest one counts, and answering it moves on to the next", () => {
    const t = createRunTracker()
    t.asked("ses_a", "form:f1", 700)
    t.asked("ses_a", "permission:p1", 400)
    expect(t.snapshot().ses_a?.waitingSince).toBe(400)
    t.answered("permission:p1")
    expect(t.snapshot().ses_a?.waitingSince).toBe(700)
  })

  test("an answered request leaves no waiting time", () => {
    const t = createRunTracker()
    t.started("ses_a", 100)
    t.asked("ses_a", "permission:p1", 400)
    t.answered("permission:p1")
    expect(t.snapshot().ses_a).toEqual({ startedAt: 100 })
  })

  test("a request of one session never gives a waiting time to another", () => {
    const t = createRunTracker()
    t.started("ses_a", 100)
    t.started("ses_b", 100)
    t.asked("ses_a", "permission:p1", 400)
    expect(t.snapshot().ses_b).toEqual({ startedAt: 100 })
  })

  test("a run that starts, ends or is forgotten has no request open any more", () => {
    const started = createRunTracker()
    started.asked("ses_a", "permission:p1", 400)
    started.started("ses_a", 500)
    expect(started.snapshot().ses_a).toEqual({ startedAt: 500 })

    const ended = createRunTracker()
    ended.asked("ses_a", "permission:p1", 400)
    ended.ended("ses_a", "stopped", 500)
    expect(ended.snapshot().ses_a).toEqual({ endedAt: 500, outcome: "stopped" })

    const forgotten = createRunTracker()
    forgotten.asked("ses_a", "permission:p1", 400)
    forgotten.forget("ses_a")
    expect(forgotten.snapshot().ses_a).toBeUndefined()
  })

  test("a request seen before any run still gives a waiting time", () => {
    const t = createRunTracker()
    t.asked("ses_a", "form:f1", 400)
    expect(t.snapshot().ses_a).toEqual({ waitingSince: 400 })
    expect(t.get("ses_a")).toBeUndefined()
  })

  test("keeps at most 200 open requests, dropping the oldest", () => {
    const t = createRunTracker()
    for (let i = 0; i < 205; i++) t.asked(`ses_${i}`, `permission:p${i}`, i)
    expect(t.snapshot().ses_0).toBeUndefined()
    expect(t.snapshot().ses_4).toBeUndefined()
    expect(t.snapshot().ses_5).toEqual({ waitingSince: 5 })
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
    wait: { startedAt: NOW - 9 * MIN, waitingSince: NOW - 2 * MIN },
    w1: { startedAt: NOW - 12 * MIN, tool: "esegue make" },
    w2: { startedAt: NOW - 4 * MIN, tool: "legge agents-core.ts" },
    d2: { startedAt: NOW - 25 * MIN, endedAt: NOW - 20 * MIN, outcome: "error" as const },
  }

  test("draws exactly the layout at 34 columns", () => {
    expect(lines(buildView(children, runs, NOW, 34))).toEqual([
      "Subagenti             1 ti aspetta",
      "",
      "! Ti aspetta",
      "  Opus     rilettura #103    da 2m",
      "           └ chiede un permesso",
      "",
      "▗ Al lavoro",
      "  Sonnet   #90 allineamento    12m",
      "           └ esegue make",
      "  Sonnet   citazioni            4m",
      "           └ legge agents-core.ts",
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
    // "!" and not the warning sign: that one can draw two columns wide and push the row.
    expect(all.groups.map((g) => g.icon)).toEqual(["!", "", "✓"])
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

  test("a tool detail with a line break or an escape code stays one clean line", () => {
    const view = buildView(
      [child({ id: "x", running: true })],
      { x: { startedAt: NOW - MIN, tool: "Clean\nbuild\u001b[2J output" } },
      NOW,
      60,
    )
    expect(view.groups[0].rows[0].detail).toBe("           └ Clean build[2J output")
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

  test("times: a waiting agent shows how long it has waited for you, not how long it has run", () => {
    const view = buildView(
      [child({ id: "w", running: true, permissionPending: true, createdAt: NOW - 50 * MIN })],
      { w: { startedAt: NOW - 40 * MIN, waitingSince: NOW - 2 * MIN } },
      NOW,
      34,
    )
    expect(view.groups[0].rows[0].time).toBe("da 2m")
  })

  test("times: a wait whose start was not seen shows no time instead of a wrong one", () => {
    const row = buildView(
      [child({ id: "w", title: "rilettura", running: true, permissionPending: true, createdAt: NOW - 50 * MIN })],
      { w: { startedAt: NOW - 40 * MIN } },
      NOW,
      34,
    ).groups[0].rows[0]
    expect(row.time).toBe("")
    expect(row.name).toBe("rilettura")
  })

  test("the agent that has waited longest for you comes first, whenever its run started", () => {
    const view = buildView(
      [
        child({ id: "started_first", running: true, formPending: true }),
        child({ id: "asked_first", running: true, permissionPending: true }),
        child({ id: "unknown", running: true, permissionPending: true, createdAt: NOW - 8 * MIN }),
      ],
      {
        started_first: { startedAt: NOW - 30 * MIN, waitingSince: NOW - 1 * MIN },
        asked_first: { startedAt: NOW - 5 * MIN, waitingSince: NOW - 4 * MIN },
      },
      NOW,
      34,
    )
    // A wait with no known start sorts by when the agent started.
    expect(view.groups[0].rows.map((r) => r.id)).toEqual(["unknown", "asked_first", "started_first"])
    expect(view.groups[0].rows.map((r) => r.time)).toEqual(["", "da 4m", "da 1m"])
  })

  test("a time that would leave the name under 4 characters is left out", () => {
    const row = (width: number) =>
      buildView([child({ id: "f", title: "rilettura plugin", updatedAt: NOW - (23 * 60 + 59) * MIN })], {}, NOW, width).groups[0].rows[0]
    expect(row(34).time).toBe("23h 59m fa")
    expect(row(34).name).toBe("rilettura …  ")
    expect(row(27).time).toBe("23h 59m fa") // 27 - 11 - 10 - 2 = 4: the last width where it fits
    expect(row(26).time).toBe("")
    expect(row(26).name).toBe("rilettura plug…")
  })

  test("tracker times and outcome override the session timestamps", () => {
    const view = buildView(
      [child({ id: "a", running: true, createdAt: NOW - 999 * MIN }), child({ id: "b", updatedAt: NOW - 999 * MIN })],
      { a: { startedAt: NOW - 20_000 }, b: { endedAt: NOW - 45_000, outcome: "error" } },
      NOW,
      34,
    )
    expect(view.groups[0].rows[0].time.trim()).toBe("<1m")
    expect(view.groups[1].rows[0].time.trim()).toBe("<1m fa")
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
  test("the header says who waits for you first, right-aligned", () => {
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
    expect(view.header.title).toBe("Subagenti")
    expect(view.header.state).toBe("1 ti aspetta".padStart(25))
    expect(view.header.stateKind).toBe("waiting")
    expect(view.header.title.length + view.header.state.length).toBe(34)
  })

  test("with nobody waiting the header says how many are at work", () => {
    const view = buildView([child({ id: "r1", running: true }), child({ id: "r2", running: true }), child({ id: "d" })], {}, NOW, 34)
    expect(view.header.state.trim()).toBe("2 al lavoro")
    expect(view.header.stateKind).toBe("working")
  })

  test("with nothing active the header has no state", () => {
    const view = buildView([child({ id: "d" })], {}, NOW, 34)
    expect(view.header).toEqual({ title: "Subagenti", state: "" })
  })

  test("headerState: singular and plural, waiting before working, nothing when all are finished", () => {
    expect(headerState(1, 0)).toEqual({ text: "1 ti aspetta", kind: "waiting" })
    expect(headerState(2, 5)).toEqual({ text: "2 ti aspettano", kind: "waiting" })
    expect(headerState(0, 1)).toEqual({ text: "1 al lavoro", kind: "working" })
    expect(headerState(0, 3)).toEqual({ text: "3 al lavoro", kind: "working" })
    expect(headerState(0, 0)).toBeUndefined()
  })

  test("no children is the empty state, with no text to draw for it", () => {
    const view = buildView([], {}, NOW, 34)
    expect(view.empty).toBe(true)
    expect(view.groups).toEqual([])
    expect(lines(view)).toEqual([])
    expect(Object.keys(view).sort()).toEqual(["empty", "groups", "header", "hidden", "hiddenText"])
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


})

describe("rowLayout", () => {
  test("model column and time while there is room", () => {
    expect(rowLayout(34)).toEqual({ showModel: true, showTime: true })
    expect(rowLayout(24)).toEqual({ showModel: true, showTime: true })
  })
  test("the model column goes first, below 24", () => {
    expect(rowLayout(23)).toEqual({ showModel: false, showTime: true })
    expect(rowLayout(14)).toEqual({ showModel: false, showTime: true })
  })
  test("then the time, below 14", () => {
    expect(rowLayout(13)).toEqual({ showModel: false, showTime: false })
    expect(rowLayout(4)).toEqual({ showModel: false, showTime: false })
  })
  test("a width that is not a number counts as 34", () => {
    expect(rowLayout(Number.NaN)).toEqual({ showModel: true, showTime: true })
    expect(rowLayout(0)).toEqual({ showModel: true, showTime: true })
  })
})

describe("buildView, narrow and wide", () => {
  const kids: ChildInput[] = [
    child({ id: "wait", title: "rilettura #103", modelId: "claude-opus-5-5", running: true, permissionPending: true, createdAt: NOW - 2 * MIN }),
    child({ id: "w1", title: "#90 allineamento molto lungo", modelId: "claude-sonnet-5-5", running: true, createdAt: NOW - 12 * MIN }),
    child({ id: "d2", title: "#103 correzioni", modelId: "claude-sonnet-5-5", updatedAt: NOW - 20 * MIN }),
  ]
  const runs = {
    wait: { startedAt: NOW - 9 * MIN, waitingSince: NOW - 2 * MIN },
    w1: { startedAt: NOW - 12 * MIN, tool: "esegue bun test con la copertura" },
    d2: { startedAt: NOW - 25 * MIN, endedAt: NOW - 20 * MIN, outcome: "error" as const },
  }

  test("at 22 columns the model column is dropped and the name gets its room", () => {
    const out = lines(buildView(kids, runs, NOW, 22))
    expect(out).toContain("  rilettura #1…  da 2m")
    expect(out).toContain("  #90 allineamen…  12m")
    expect(out).toContain("✗ #103 correz…  20m fa")
  })

  test("at 22 columns the detail line is indented under the name", () => {
    const out = lines(buildView(kids, runs, NOW, 22))
    expect(out).toContain("  └ chiede un permesso")
    expect(out).toContain("  └ esegue bun test c…")
  })

  test("at 12 columns there is no time, only the name", () => {
    const out = lines(buildView(kids, runs, NOW, 12))
    expect(out).toContain("  rilettura…")
    expect(out).toContain("✗ #103 corr…")
  })

  test("a failed row without model column has an empty lead, the mark takes its place", () => {
    const row = buildView(kids, runs, NOW, 22).groups[2].rows[0]
    expect(row.mark).toBe("✗ ")
    expect(row.lead).toBe("")
  })

  test("a wide sidebar puts the time on the right edge and gives the name the extra room", () => {
    const out = lines(buildView(kids, runs, NOW, 60))
    expect(out).toContain("  Opus     " + "rilettura #103".padEnd(44) + "da 2m")
    expect(out).toContain("  Sonnet   " + "#90 allineamento molto lungo".padEnd(46) + "12m")
  })

  test("no drawn line is wider than the width, at any width from 4 to 80", () => {
    for (let width = 4; width <= 80; width++) {
      for (const line of lines(buildView(kids, runs, NOW, width))) {
        expect([...line].length).toBeLessThanOrEqual(width)
      }
    }
  })

  test("every row shows a time from 14 columns up, and is then exactly the width", () => {
    for (let width = 14; width <= 80; width++) {
      for (const group of buildView(kids, runs, NOW, width).groups)
        for (const row of group.rows) {
          expect(row.time).not.toBe("")
          expect([...`${row.mark ?? ""}${row.lead}${row.name}${row.time}`]).toHaveLength(width)
        }
    }
  })

  test("the header keeps its state on the right edge and gives it up when it does not fit", () => {
    expect(lines(buildView(kids, runs, NOW, 22))[0]).toBe("Subagenti 1 ti aspetta")
    expect(lines(buildView(kids, runs, NOW, 21))[0]).toBe("Subagenti")
    expect(lines(buildView(kids, runs, NOW, 6))[0]).toBe("Subag…")
  })

  test("group titles and the hidden count are cut to the width", () => {
    const small = buildView(kids, runs, NOW, 8)
    expect(small.groups.map((g) => g.title)).toEqual(["Ti as…", "Al la…", "Finiti"])
    const many = Array.from({ length: 13 }, (_, i) => child({ id: `r${i}`, running: true }))
    expect(buildView(many, {}, NOW, 6).hiddenText).toBe("+3 al…")
  })

  test("a width that is not usable falls back to 34 columns", () => {
    expect(lines(buildView(kids, runs, NOW, Number.NaN))).toEqual(lines(buildView(kids, runs, NOW, 34)))
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
    const t = createWidthTracker({ initial: 34, onChange: (w) => seen.push(w), scheduler: fake().scheduler })
    t.report(38)
    expect(seen).toEqual([38])
  })
  test("a burst of sizes becomes one update with the last size, 50 ms later", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 34, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(38)
    for (const w of [37, 36, 35, 30]) t.report(w)
    expect(seen).toEqual([38])
    expect(f.jobs).toHaveLength(1)
    expect(f.jobs[0]!.ms).toBe(50)
    f.jobs[0]!.fn()
    expect(seen).toEqual([38, 30])
  })
  test("the same size again does no work", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 34, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(38)
    t.report(38)
    t.report(38.6)
    expect(f.jobs).toHaveLength(0)
    expect(seen).toEqual([38])
  })
  test("a burst that ends where it began changes nothing", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 34, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(38)
    t.report(20)
    t.report(38)
    f.jobs[0]?.fn()
    expect(seen).toEqual([38])
  })
  test("zero, negative and NaN are ignored", () => {
    const seen: number[] = []
    const t = createWidthTracker({ initial: 34, onChange: (w) => seen.push(w), scheduler: fake().scheduler })
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
    const t = createWidthTracker({ initial: 34, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(38)
    t.report(30)
    t.dispose()
    expect(f.jobs).toHaveLength(0)
    expect(seen).toEqual([38])
  })
})

describe("createRefreshBatch", () => {
  const fakeTimers = () => {
    const pending: (() => void)[] = []
    const delays: number[] = []
    return {
      pending,
      delays,
      scheduler: {
        set: (fn: () => void, ms: number) => {
          delays.push(ms)
          return pending.push(fn)
        },
        clear: (handle: unknown) => void pending.splice(Number(handle) - 1, 1),
      },
      fire: () => pending.splice(0).forEach((fn) => fn()),
    }
  }
  test("many requests before the timer fires rebuild once", () => {
    const timers = fakeTimers()
    let rebuilds = 0
    const batch = createRefreshBatch({ run: () => rebuilds++, scheduler: timers.scheduler })
    batch.request()
    batch.request()
    batch.request()
    timers.fire()
    batch.request()
    timers.fire()
    expect(rebuilds).toBe(2)
  })
  test("waits 100 ms, so a burst of events is one rebuild", () => {
    const timers = fakeTimers()
    createRefreshBatch({ run: () => {}, scheduler: timers.scheduler }).request()
    expect([timers.delays, REFRESH_BATCH_MS]).toEqual([[100], 100])
  })
  test("a request after dispose sets no timer", () => {
    const timers = fakeTimers()
    const batch = createRefreshBatch({ run: () => {}, scheduler: timers.scheduler })
    batch.dispose()
    batch.request()
    expect(timers.pending).toHaveLength(0)
  })
  test("dispose drops a request that is still waiting", () => {
    const timers = fakeTimers()
    let rebuilds = 0
    const batch = createRefreshBatch({ run: () => rebuilds++, scheduler: timers.scheduler })
    batch.request()
    batch.dispose()
    timers.fire()
    expect(rebuilds).toBe(0)
  })
})
