import { describe, expect, test } from "bun:test"
import {
  MAX_FINISHED,
  agoIt,
  buildRows,
  createRunTracker,
  displayTitle,
  runningForIt,
  stateIt,
  type ChildInput,
} from "./agents-core"

const NOW = 1_000_000_000

const child = (over: Partial<ChildInput> & { id: string }): ChildInput => ({
  title: `Compito ${over.id}`,
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  running: false,
  permissionPending: false,
  formPending: false,
  ...over,
})

describe("agoIt", () => {
  test("says 'ora' under 5 seconds, then seconds, minutes, hours, days", () => {
    expect(agoIt(0)).toBe("ora")
    expect(agoIt(4_999)).toBe("ora")
    expect(agoIt(5_000)).toBe("5 s fa")
    expect(agoIt(59_000)).toBe("59 s fa")
    expect(agoIt(60_000)).toBe("1 min fa")
    expect(agoIt(59 * 60_000)).toBe("59 min fa")
    expect(agoIt(60 * 60_000)).toBe("1 h fa")
    expect(agoIt(23 * 3_600_000)).toBe("23 h fa")
    expect(agoIt(24 * 3_600_000)).toBe("1 g fa")
  })

  test("a negative gap (clock skew) counts as 'ora'", () => {
    expect(agoIt(-30_000)).toBe("ora")
  })
})

describe("runningForIt", () => {
  test("uses 'da' for a running agent", () => {
    expect(runningForIt(2_000)).toBe("da poco")
    expect(runningForIt(12_000)).toBe("da 12 s")
    expect(runningForIt(3 * 60_000)).toBe("da 3 min")
    expect(runningForIt(2 * 3_600_000)).toBe("da 2 h")
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

describe("stateIt", () => {
  test("waiting for a permission wins over running", () => {
    expect(stateIt("running", true, false)).toBe("in attesa di permesso")
  })
  test("waiting for an answer wins over running, but permission wins over answer", () => {
    expect(stateIt("running", false, true)).toBe("in attesa di risposta")
    expect(stateIt("running", true, true)).toBe("in attesa di permesso")
  })
  test("plain states", () => {
    expect(stateIt("running", false, false)).toBe("in corso")
    expect(stateIt("done", false, false)).toBe("finito")
    expect(stateIt("error", false, false)).toBe("errore")
    expect(stateIt("stopped", false, false)).toBe("fermato")
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
})

describe("buildRows", () => {
  test("running agents come first, newest start first; then finished, newest end first", () => {
    const rows = buildRows(
      [
        child({ id: "fin_old", running: false, updatedAt: NOW - 600_000 }),
        child({ id: "run_old", running: true, createdAt: NOW - 120_000 }),
        child({ id: "fin_new", running: false, updatedAt: NOW - 30_000 }),
        child({ id: "run_new", running: true, createdAt: NOW - 10_000 }),
      ],
      {},
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual(["run_new", "run_old", "fin_new", "fin_old"])
  })

  test("keeps only the last 5 finished and every running one", () => {
    const finished = Array.from({ length: 8 }, (_, i) =>
      child({ id: `fin_${i}`, running: false, updatedAt: NOW - (i + 1) * 1_000 }),
    )
    const running = Array.from({ length: 7 }, (_, i) => child({ id: `run_${i}`, running: true }))
    const rows = buildRows([...finished, ...running], {}, NOW)
    expect(MAX_FINISHED).toBe(5)
    expect(rows.filter((r) => r.state !== "in corso")).toHaveLength(5)
    expect(rows.filter((r) => r.state === "in corso")).toHaveLength(7)
    expect(rows.filter((r) => r.state !== "in corso").map((r) => r.id)).toEqual([
      "fin_0",
      "fin_1",
      "fin_2",
      "fin_3",
      "fin_4",
    ])
  })

  test("a waiting agent counts as running for ordering and is not cut by the finished limit", () => {
    const rows = buildRows(
      [
        child({ id: "wait", running: true, permissionPending: true, createdAt: NOW - 5_000 }),
        ...Array.from({ length: 6 }, (_, i) => child({ id: `fin_${i}`, running: false, updatedAt: NOW - i * 1_000 })),
      ],
      {},
      NOW,
    )
    expect(rows[0]).toMatchObject({ id: "wait", state: "in attesa di permesso", kind: "active" })
    expect(rows).toHaveLength(6)
  })

  test("a pending permission on an idle agent still shows as waiting", () => {
    const rows = buildRows([child({ id: "x", running: false, permissionPending: true })], {}, NOW)
    expect(rows[0]).toMatchObject({ state: "in attesa di permesso", kind: "active" })
  })

  test("running row shows time since start, finished row shows time since end", () => {
    const rows = buildRows(
      [
        child({ id: "r", running: true, createdAt: NOW - 3 * 60_000 }),
        child({ id: "f", running: false, updatedAt: NOW - 2 * 3_600_000 }),
      ],
      {},
      NOW,
    )
    expect(rows.find((r) => r.id === "r")?.when).toBe("da 3 min")
    expect(rows.find((r) => r.id === "f")?.when).toBe("2 h fa")
  })

  test("tracker times and outcome override the session timestamps", () => {
    const runs = {
      a: { startedAt: NOW - 20_000 },
      b: { startedAt: NOW - 90_000, endedAt: NOW - 45_000, outcome: "error" as const },
    }
    const rows = buildRows(
      [child({ id: "a", running: true, createdAt: NOW - 999_000 }), child({ id: "b", running: false, updatedAt: NOW - 999_000 })],
      runs,
      NOW,
    )
    expect(rows.find((r) => r.id === "a")?.when).toBe("da 20 s")
    expect(rows.find((r) => r.id === "b")).toMatchObject({ state: "errore", when: "45 s fa" })
  })

  test("a finished agent with no tracked outcome reads as 'finito'", () => {
    const rows = buildRows([child({ id: "z", running: false })], {}, NOW)
    expect(rows[0]).toMatchObject({ state: "finito", kind: "finished" })
  })

  test("a stale tracker outcome does not override a running agent", () => {
    const rows = buildRows(
      [child({ id: "r", running: true })],
      { r: { startedAt: NOW - 1_000, endedAt: NOW - 500, outcome: "error" } },
      NOW,
    )
    expect(rows[0]).toMatchObject({ state: "in corso", kind: "active" })
  })

  test("returns an empty list for no children", () => {
    expect(buildRows([], {}, NOW)).toEqual([])
  })
})
