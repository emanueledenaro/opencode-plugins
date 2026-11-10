import { describe, expect, test } from "bun:test"
import {
  usageLevel,
  fableLevel,
  fableOverThreshold,
  createFableWatch,
  isFreshSnapshot,
  FABLE_TOAST,
  meter,
  footerLayout,
  footerText,
  iconTone,
  createClickGate,
  createHoverGate,
  hoverTone,
  FOOTER_ICON,
  dialogLayout,
  fitText,
  createWidthTracker,
  rowBudget,
  footerMessage,
  resetFit,
  FOOTER_MAX_CELLS,
  resetIt,
  updatedIt,
  type MonitorDeps,
  MAX_BACKOFF_MS,
  POLL_INTERVAL_MS,
  createUsageMonitor,
  failureMessage,
  formatDetail,
  formatDuration,
  formatFooter,
  formatShort,
  nextDelay,
  parseCache,
  parseCredentials,
  parseUsage,
  redact,
  serializeCache,
  weeklyOverThreshold,
} from "./claude-usage-core"

// Every token below is a made-up string, never a real credential.
const FAKE_TOKEN = "FAKE-ACCESS-TOKEN-for-tests-0001"
const NOW = Date.parse("2026-11-09T12:00:00Z")

const keychain = (expiresAt?: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken: FAKE_TOKEN, refreshToken: "FAKE-REFRESH", expiresAt } })

const usageBody = (five: number | null, week: number | null) => ({
  five_hour: five === null ? null : { utilization: five, resets_at: "2026-11-09T15:00:00+00:00" },
  seven_day: week === null ? null : { utilization: week, resets_at: "2026-11-12T09:00:00.5+00:00" },
  extra_usage: { is_enabled: false },
})

describe("parseCredentials", () => {
  test("returns the token when it has not expired", () => {
    expect(parseCredentials(keychain(NOW + 60_000), NOW)).toEqual({ ok: true, token: FAKE_TOKEN })
  })
  test("accepts a missing expiry", () => {
    expect(parseCredentials(keychain(undefined), NOW).ok).toBe(true)
  })
  test("reports login-expired instead of using an expired token", () => {
    expect(parseCredentials(keychain(NOW - 1), NOW)).toEqual({ ok: false, kind: "login-expired" })
  })
  test("reports no-login for missing, malformed or empty items", () => {
    expect(parseCredentials("not json", NOW)).toEqual({ ok: false, kind: "no-login" })
    expect(parseCredentials("{}", NOW)).toEqual({ ok: false, kind: "no-login" })
    expect(parseCredentials('{"claudeAiOauth":{"accessToken":""}}', NOW)).toEqual({ ok: false, kind: "no-login" })
  })
})

describe("parseUsage", () => {
  test("reads both windows with percent and reset time", () => {
    const snapshot = parseUsage(usageBody(23.4, 61), NOW)
    expect(snapshot?.fiveHour).toEqual({ percent: 23.4, resetsAt: Date.parse("2026-11-09T15:00:00Z") })
    expect(snapshot?.sevenDay?.percent).toBe(61)
    expect(snapshot?.fetchedAt).toBe(NOW)
  })
  test("a null five_hour window is allowed (nothing active)", () => {
    const snapshot = parseUsage(usageBody(null, 96), NOW)
    expect(snapshot?.fiveHour).toBeNull()
    expect(snapshot?.sevenDay?.percent).toBe(96)
  })
  test("accepts epoch seconds for the reset time", () => {
    const snapshot = parseUsage({ five_hour: { utilization: 5, resets_at: 1_794_268_800 } }, NOW)
    expect(snapshot?.fiveHour?.resetsAt).toBe(1_794_268_800_000)
  })
  test("returns null for garbage or when both windows are missing", () => {
    expect(parseUsage(null, NOW)).toBeNull()
    expect(parseUsage("x", NOW)).toBeNull()
    expect(parseUsage({}, NOW)).toBeNull()
    expect(parseUsage({ five_hour: { utilization: "high" } }, NOW)).toBeNull()
  })
})

// The shape found in the real response: limits[] has a weekly_scoped entry for the Fable model.
const fableEntry = (percent: unknown, extra: Record<string, unknown> = {}) => ({
  kind: "weekly_scoped",
  group: "weekly",
  percent,
  severity: "normal",
  resets_at: "2026-11-16T23:59:59.8+00:00",
  scope: { model: { id: null, display_name: "Fable" }, surface: null },
  is_active: false,
  ...extra,
})
const withLimits = (limits: unknown) => ({ ...usageBody(10, 20), limits })

describe("parseUsage: Fable weekly limit", () => {
  test("reads percent and reset time from the weekly_scoped Fable entry", () => {
    const limits = [{ kind: "weekly_all", percent: 20, scope: null, resets_at: "2026-11-12T09:00:00+00:00" }, fableEntry(12)]
    expect(parseUsage(withLimits(limits), NOW)?.fable).toEqual({ percent: 12, resetsAt: Date.parse("2026-11-16T23:59:59.8Z") })
  })
  test("absent: no limits field, an empty list or no Fable entry all give null, never a failure", () => {
    expect(parseUsage(usageBody(10, 20), NOW)?.fable).toBeNull()
    expect(parseUsage(withLimits([]), NOW)?.fable).toBeNull()
    expect(parseUsage(withLimits([{ kind: "weekly_all", percent: 20, scope: null }]), NOW)?.fable).toBeNull()
    expect(parseUsage(withLimits([fableEntry(5, { scope: { model: { display_name: "Opus" } } })]), NOW)?.fable).toBeNull()
    expect(parseUsage(withLimits([fableEntry(5, { kind: "weekly_all" })]), NOW)?.fable).toBeNull()
  })
  test("malformed: wrong types give null and leave the other windows intact", () => {
    for (const limits of ["x", 7, {}, [null], [3], [fableEntry("12")], [fableEntry(null)], [fableEntry(Number.NaN)], [fableEntry(5, { scope: null })]]) {
      const snapshot = parseUsage(withLimits(limits), NOW)
      expect(snapshot?.fable).toBeNull()
      expect(snapshot?.sevenDay?.percent).toBe(20)
    }
  })
  test("the name must be Fable: spaces and case are ignored, other names are not", () => {
    const named = (display_name: string) => parseUsage(withLimits([fableEntry(9, { scope: { model: { display_name } } })]), NOW)?.fable
    expect(named("  FABLE ")?.percent).toBe(9)
    expect(named("fable")?.percent).toBe(9)
    expect(named("Not Fable")).toBeNull()
    expect(named("Fableish")).toBeNull()
    expect(named("")).toBeNull()
  })
  test("with several valid Fable entries the highest percent wins, in any order", () => {
    expect(parseUsage(withLimits([fableEntry(10), fableEntry(70), fableEntry(30)]), NOW)?.fable?.percent).toBe(70)
    expect(parseUsage(withLimits([fableEntry(70), fableEntry(10)]), NOW)?.fable?.percent).toBe(70)
    expect(parseUsage(withLimits([fableEntry(10), fableEntry("bad"), fableEntry(20)]), NOW)?.fable?.percent).toBe(20)
  })
  test("a broken entry does not hide a good one after it", () => {
    expect(parseUsage(withLimits([fableEntry("bad"), fableEntry(33)]), NOW)?.fable?.percent).toBe(33)
  })
  test("the Fable limit alone does not make a snapshot", () => {
    expect(parseUsage({ limits: [fableEntry(50)] }, NOW)).toBeNull()
  })
})

describe("Fable thresholds", () => {
  test("green under 50%, yellow from 50%, red from 80%", () => {
    expect(fableLevel(0)).toBe("ok")
    expect(fableLevel(49.9)).toBe("ok")
    expect(fableLevel(50)).toBe("warn")
    expect(fableLevel(79.9)).toBe("warn")
    expect(fableLevel(80)).toBe("high")
    expect(fableLevel(100)).toBe("high")
  })
  test("the stop line is 80% included", () => {
    const at = (percent: number) => parseUsage(withLimits([fableEntry(percent)]), NOW)
    expect(fableOverThreshold(at(79.9))).toBe(false)
    expect(fableOverThreshold(at(80))).toBe(true)
    expect(fableOverThreshold(at(120))).toBe(true)
    expect(fableOverThreshold(parseUsage(usageBody(1, 2), NOW))).toBe(false)
    expect(fableOverThreshold(null)).toBe(false)
  })
})

describe("Fable toast", () => {
  const at = (percent: number | null) =>
    parseUsage(percent === null ? usageBody(1, 2) : withLimits([fableEntry(percent)]), NOW)
  test("fires once when Fable crosses 80%, not before and not again while it stays over", () => {
    const crossed = createFableWatch()
    expect(crossed(at(10))).toBe(false)
    expect(crossed(at(79))).toBe(false)
    expect(crossed(at(80))).toBe(true)
    expect(crossed(at(85))).toBe(false)
    expect(crossed(at(100))).toBe(false)
  })
  test("fires again after a drop under the line (a new week)", () => {
    const crossed = createFableWatch()
    expect(crossed(at(90))).toBe(true)
    expect(crossed(at(2))).toBe(false)
    expect(crossed(at(81))).toBe(true)
  })
  test("a missing Fable reading or no data never fires", () => {
    const crossed = createFableWatch()
    expect(crossed(at(null))).toBe(false)
    expect(crossed(null)).toBe(false)
  })
  test("a poll without the Fable entry does not re-arm the toast", () => {
    const crossed = createFableWatch()
    expect(crossed(at(90))).toBe(true)
    expect(crossed(at(null))).toBe(false)
    expect(crossed(null)).toBe(false)
    expect(crossed(at(90))).toBe(false) // still the same crossing
    expect(crossed(at(5))).toBe(false)
    expect(crossed(at(null))).toBe(false)
    expect(crossed(at(90))).toBe(true) // a real drop and a new crossing
  })
  test("cached numbers are not fresh, numbers fetched in this session are", () => {
    const started = NOW + 1000
    expect(isFreshSnapshot(parseUsage(usageBody(1, 2), NOW), started)).toBe(false) // read from the cache file
    expect(isFreshSnapshot(parseUsage(usageBody(1, 2), started - 1), started)).toBe(false)
    expect(isFreshSnapshot(parseUsage(usageBody(1, 2), started), started)).toBe(true)
    expect(isFreshSnapshot(parseUsage(usageBody(1, 2), started + 5000), started)).toBe(true)
    expect(isFreshSnapshot(null, started)).toBe(false)
  })
  test("the text is Italian and names the line", () => {
    expect(FABLE_TOAST).toBe("Fable all'80% settimanale: niente più Fable per gli agenti")
  })
})

describe("weekly threshold", () => {
  const week = (percent: number) => parseUsage(usageBody(1, percent), NOW)
  test("90% exactly is inside the reserve, above 90% is not", () => {
    expect(weeklyOverThreshold(week(90))).toBe(false)
    expect(weeklyOverThreshold(week(90.5))).toBe(true)
    expect(weeklyOverThreshold(week(96))).toBe(true)
    expect(weeklyOverThreshold(null)).toBe(false)
  })
  test("the footer says so clearly", () => {
    expect(formatShort(week(96))).toContain("WEEKLY OVER 90%")
    expect(formatShort(week(40))).not.toContain("WEEKLY")
  })
})

describe("formatting", () => {
  test("durations", () => {
    expect(formatDuration(5 * 60_000)).toBe("5m")
    expect(formatDuration(135 * 60_000)).toBe("2h15m")
    expect(formatDuration(50 * 3_600_000)).toBe("2d02h")
    expect(formatDuration(-1)).toBe("0m")
  })
  test("short form", () => {
    expect(formatShort(parseUsage(usageBody(23.4, 61), NOW))).toBe("5h 23%  wk 61%")
    expect(formatShort(parseUsage(usageBody(null, 61), NOW))).toBe("5h n/a  wk 61%")
    expect(formatShort(null)).toBe("usage unavailable")
  })
  test("detail lists percentages and reset times", () => {
    const monitorState = { snapshot: parseUsage(usageBody(23.4, 61), NOW), failure: null, consecutiveFailures: 0, nextAllowedAt: 0 }
    const text = formatDetail(monitorState, NOW)
    expect(text).toContain("5-hour window: 23%, resets in 3h00m")
    expect(text).toContain("Weekly window: 61%, resets in 2d21h")
  })
  test("failure messages", () => {
    expect(failureMessage({ kind: "login-expired" })).toBe("login expired, run claude")
    expect(failureMessage({ kind: "http", status: 500 })).toContain("http 500")
  })
})

describe("redact", () => {
  test("removes known secrets and token-looking strings", () => {
    expect(redact(`oops ${FAKE_TOKEN} here`, [FAKE_TOKEN])).not.toContain(FAKE_TOKEN)
    expect(redact("key sk-ant-oat01-abcDEF123_-xyz")).toBe("key [redacted]")
    expect(redact("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [redacted]")
  })
  test("truncates long text", () => {
    expect(redact("a".repeat(1000)).length).toBe(200)
  })
})

describe("nextDelay", () => {
  test("polls every 5 minutes when healthy", () => {
    expect(nextDelay(0)).toBe(POLL_INTERVAL_MS)
  })
  test("doubles on each failure up to one hour", () => {
    expect(nextDelay(1)).toBe(10 * 60_000)
    expect(nextDelay(2)).toBe(20 * 60_000)
    expect(nextDelay(10)).toBe(MAX_BACKOFF_MS)
  })
  test("honours Retry-After within 5 minutes and one hour", () => {
    expect(nextDelay(1, 30_000)).toBe(POLL_INTERVAL_MS)
    expect(nextDelay(1, 20 * 60_000)).toBe(20 * 60_000)
    expect(nextDelay(1, 99 * 3_600_000)).toBe(MAX_BACKOFF_MS)
  })
})

describe("cache", () => {
  test("round-trips numbers only", () => {
    const state = { snapshot: parseUsage(usageBody(10, 20), NOW), nextAllowedAt: NOW + 1 }
    const text = serializeCache(state)
    expect(parseCache(text)).toEqual({ version: 1, ...state })
  })
  test("round-trips the Fable window", () => {
    const state = { snapshot: parseUsage(withLimits([fableEntry(12)]), NOW), nextAllowedAt: NOW + 1 }
    expect(parseCache(serializeCache(state))?.snapshot?.fable).toEqual({ percent: 12, resetsAt: Date.parse("2026-11-16T23:59:59.8Z") })
  })
  test("old cache files without a fable field still load, with Fable null", () => {
    const old = JSON.stringify({
      version: 1,
      snapshot: { fetchedAt: NOW, fiveHour: { percent: 1, resetsAt: null }, sevenDay: { percent: 2, resetsAt: null } },
      nextAllowedAt: 0,
    })
    const loaded = parseCache(old)
    expect(loaded?.snapshot?.sevenDay?.percent).toBe(2)
    expect(loaded?.snapshot?.fable).toBeNull()
  })
  test("a malformed fable field in the cache becomes null, not a rejected file", () => {
    const bad = JSON.stringify({ version: 1, snapshot: { fetchedAt: NOW, fiveHour: null, sevenDay: null, fable: { percent: "x" } }, nextAllowedAt: 0 })
    expect(parseCache(bad)?.snapshot?.fable).toBeNull()
  })
  test("rejects other versions and garbage", () => {
    expect(parseCache('{"version":2}')).toBeNull()
    expect(parseCache("nope")).toBeNull()
    expect(parseCache('{"version":1,"snapshot":{"fetchedAt":"x"}}')).toBeNull()
  })
})

// --- monitor ---------------------------------------------------------------------------------

function harness(overrides: Partial<MonitorDeps> = {}) {
  let clock = NOW
  const calls = { keychain: 0, fetch: 0, tokensSeen: [] as string[] }
  const saved: string[] = []
  const deps: MonitorDeps = {
    now: () => clock,
    readCredentials: async () => {
      calls.keychain++
      return parseCredentials(keychain(NOW + 3_600_000), clock)
    },
    fetchUsage: async (token) => {
      calls.fetch++
      calls.tokensSeen.push(token)
      return { ok: true, body: usageBody(12, 34) }
    },
    loadCache: async () => null,
    saveCache: async (state) => void saved.push(serializeCache(state)),
    ...overrides,
  }
  return { monitor: createUsageMonitor(deps), calls, saved, advance: (ms: number) => (clock += ms) }
}

describe("monitor", () => {
  test("a successful poll publishes the numbers and reads the keychain fresh each time", async () => {
    const h = harness()
    expect(await h.monitor.refresh()).toBe("refreshed")
    expect(h.monitor.state.snapshot?.sevenDay?.percent).toBe(34)
    h.advance(POLL_INTERVAL_MS)
    await h.monitor.refresh()
    expect(h.calls.keychain).toBe(2)
    expect(h.calls.fetch).toBe(2)
  })

  test("the token never ends up in the state or in the cache file", async () => {
    const h = harness()
    await h.monitor.refresh()
    expect(h.calls.tokensSeen).toEqual([FAKE_TOKEN]) // it did reach the request...
    expect(JSON.stringify(h.monitor.state)).not.toContain("FAKE")
    expect(h.saved.length).toBeGreaterThan(0)
    for (const file of h.saved) expect(file).not.toContain("FAKE") // ...and nowhere else
  })

  test("the timer does not poll before 5 minutes", async () => {
    const h = harness()
    await h.monitor.refresh()
    h.advance(POLL_INTERVAL_MS - 1)
    expect(await h.monitor.refresh()).toBe("skipped")
    expect(h.calls.fetch).toBe(1)
  })

  test("a command may refresh early, but not twice within 30 seconds", async () => {
    const h = harness()
    await h.monitor.refresh()
    h.advance(10_000)
    expect(await h.monitor.refresh(true)).toBe("skipped")
    h.advance(25_000)
    expect(await h.monitor.refresh(true)).toBe("refreshed")
  })

  test("an expired login shows the message and makes no network call", async () => {
    const h = harness({ readCredentials: async () => ({ ok: false, kind: "login-expired" }) })
    expect(await h.monitor.refresh()).toBe("failed")
    expect(h.calls.fetch).toBe(0)
    expect(formatFooter(h.monitor.state)).toBe("login expired, run claude")
  })

  test("429 backs off for Retry-After and blocks even a manual refresh", async () => {
    const h = harness({
      fetchUsage: async () => ({ ok: false, failure: { kind: "rate-limited", status: 429, retryAfterMs: 20 * 60_000 } }),
    })
    await h.monitor.refresh()
    expect(h.monitor.state.nextAllowedAt).toBe(NOW + 20 * 60_000)
    h.advance(10 * 60_000)
    expect(await h.monitor.refresh(true)).toBe("skipped")
    expect(await h.monitor.refresh()).toBe("skipped")
  })

  test("repeated failures back off exponentially and a success resets it", async () => {
    let fail = true
    const h = harness({
      fetchUsage: async () => (fail ? { ok: false, failure: { kind: "http", status: 500 } } : { ok: true, body: usageBody(1, 2) }),
    })
    await h.monitor.refresh()
    expect(h.monitor.state.nextAllowedAt - NOW).toBe(10 * 60_000)
    h.advance(10 * 60_000)
    await h.monitor.refresh()
    expect(h.monitor.state.consecutiveFailures).toBe(2)
    fail = false
    h.advance(20 * 60_000)
    await h.monitor.refresh()
    expect(h.monitor.state.consecutiveFailures).toBe(0)
    expect(h.monitor.state.failure).toBeNull()
  })

  test("a failure keeps the last numbers and marks them stale", async () => {
    let fail = false
    const h = harness({
      fetchUsage: async () => (fail ? { ok: false, failure: { kind: "timeout" } } : { ok: true, body: usageBody(12, 34) }),
    })
    await h.monitor.refresh()
    fail = true
    h.advance(POLL_INTERVAL_MS)
    await h.monitor.refresh()
    expect(formatFooter(h.monitor.state)).toBe("5h 12%  wk 34% (stale)")
  })

  test("with no data at all the footer says usage unavailable", async () => {
    const h = harness({ fetchUsage: async () => ({ ok: false, failure: { kind: "network" } }) })
    await h.monitor.refresh()
    expect(formatFooter(h.monitor.state)).toBe("usage unavailable")
  })

  test("unexpected exceptions and bad bodies never escape", async () => {
    const thrower = harness({ fetchUsage: async () => { throw new Error(`boom ${FAKE_TOKEN}`) } })
    expect(await thrower.monitor.refresh()).toBe("failed")
    expect(JSON.stringify(thrower.monitor.state)).not.toContain("FAKE")
    const bad = harness({ fetchUsage: async () => ({ ok: true, body: { nothing: 1 } }) })
    expect(await bad.monitor.refresh()).toBe("failed")
    expect(bad.monitor.state.failure?.kind).toBe("bad-response")
  })

  test("a broken cache writer does not break a poll", async () => {
    const h = harness({ saveCache: async () => { throw new Error("disk full") } })
    expect(await h.monitor.refresh()).toBe("refreshed")
  })

  test("concurrent refreshes share one request", async () => {
    const h = harness()
    const [a, b] = await Promise.all([h.monitor.refresh(), h.monitor.refresh()])
    expect([a, b]).toEqual(["refreshed", "refreshed"])
    expect(h.calls.fetch).toBe(1)
  })

  test("hydrate shows cached numbers without a network call", async () => {
    const cached = parseUsage(usageBody(7, 8), NOW)
    const h = harness({ loadCache: async () => ({ version: 1, snapshot: cached, nextAllowedAt: NOW + 1000 }) })
    await h.monitor.hydrate()
    expect(h.monitor.state.snapshot?.sevenDay?.percent).toBe(8)
    expect(h.calls.fetch).toBe(0)
  })

  test("an expired login retries in 5 minutes, without the network back-off", async () => {
    let expired = true
    const h = harness({
      readCredentials: async () =>
        expired ? { ok: false, kind: "login-expired" } : parseCredentials(keychain(NOW + 3_600_000), NOW),
    })
    await h.monitor.refresh()
    await h.monitor.refresh(true) // a manual retry inside the gap is skipped, it must not count
    h.advance(POLL_INTERVAL_MS)
    await h.monitor.refresh()
    expect(h.monitor.state.consecutiveFailures).toBe(0)
    expect(h.monitor.state.nextAllowedAt).toBe(NOW + 2 * POLL_INTERVAL_MS)
    expired = false
    h.advance(POLL_INTERVAL_MS)
    expect(await h.monitor.refresh()).toBe("refreshed")
  })

  test("a cache with a far-future next time cannot stop polling for more than the max back-off", async () => {
    const cached = parseUsage(usageBody(7, 8), NOW)
    const h = harness({ loadCache: async () => ({ version: 1, snapshot: cached, nextAllowedAt: NOW + 365 * 86_400_000 }) })
    await h.monitor.hydrate()
    expect(h.monitor.state.nextAllowedAt).toBe(NOW + MAX_BACKOFF_MS)
  })

  test("a broken listener does not break the monitor", async () => {
    const h = harness()
    h.monitor.subscribe(() => { throw new Error("ui") })
    expect(await h.monitor.refresh()).toBe("refreshed")
  })
})

describe("look", () => {
  test("levels", () => {
    expect(usageLevel(0)).toBe("ok")
    expect(usageLevel(69)).toBe("ok")
    expect(usageLevel(70)).toBe("warn")
    expect(usageLevel(90)).toBe("warn")
    expect(usageLevel(91)).toBe("high")
  })
  test("meter", () => {
    expect(meter(0, 10)).toEqual({ filled: "", empty: "▱".repeat(10) })
    expect(meter(96, 10)).toEqual({ filled: "▰".repeat(10), empty: "" })
    expect(meter(23, 10)).toEqual({ filled: "▰▰", empty: "▱".repeat(8) })
    expect(meter(150, 5).filled).toBe("▰▰▰▰▰")
  })
  test("reset and update in Italian", () => {
    const now = new Date(2026, 10, 9, 23, 51).getTime()
    expect(resetIt({ percent: 96, resetsAt: new Date(2026, 10, 10, 1, 0).getTime() }, now)).toBe("si azzera tra 1 h 9 min, mar 01:00")
    expect(resetIt({ percent: 1, resetsAt: null }, now)).toBe("azzeramento non indicato")
    expect(updatedIt(now - 30_000, now)).toBe("aggiornato adesso")
    expect(updatedIt(now - 180_000, now)).toBe("aggiornato 3 min fa")
  })
})

const ROW = (layout: ReturnType<typeof footerLayout>) => (layout === null ? null : footerText(layout))

describe("footerLayout", () => {
  const both = { five: 23, week: 96, stale: false }

  test("full meters when there is room", () => {
    const layout = footerLayout(both, 60)!
    expect(footerText(layout)).toBe("5h ▰▱▱▱▱▱ 23%   sett ▰▰▰▰▰▰ 96%")
    expect(layout.width).toBe(31)
    expect(layout.icon).toBeUndefined()
    expect(FOOTER_MAX_CELLS).toBe(6)
  })

  test("the old marker is added only while there is room for it", () => {
    const stale = { ...both, stale: true }
    expect(ROW(footerLayout(stale, 42))).toBe("5h ▰▱▱▱▱▱ 23%   sett ▰▰▰▰▰▰ 96%  (vecchio)")
    expect(ROW(footerLayout(stale, 41))).toBe("5h ▰▱▱▱▱▱ 23%   sett ▰▰▰▰▰▰ 96%")
  })

  test("shorter bars come before the icon", () => {
    expect(ROW(footerLayout(both, 30))).toBe("5h ▰▱▱▱▱ 23%  sett ▰▰▰▰▰ 96%")
    expect(ROW(footerLayout(both, 26))).toBe("5h ▰▱▱▱ 23%  sett ▰▰▰▰ 96%")
    expect(ROW(footerLayout(both, 24))).toBe("5h ▰▱▱ 23%  sett ▰▰▰ 96%")
  })

  test("when the shortest bars do not fit, one icon; under 1 column, nothing", () => {
    expect(ROW(footerLayout(both, 23))).toBe(FOOTER_ICON)
    expect(footerLayout(both, 23)!.width).toBe(1)
    expect(ROW(footerLayout(both, 1))).toBe(FOOTER_ICON)
    expect(footerLayout(both, 0)).toBeNull()
    expect(footerLayout(both, -3)).toBeNull()
  })

  test("there is no text-only or single-window row any more", () => {
    for (let budget = 1; budget <= 80; budget++) {
      const row = ROW(footerLayout({ five: 23, week: 96, fable: 12, stale: false }, budget))!
      expect(row === FOOTER_ICON || row.includes("▰") || row.includes("▱")).toBe(true)
    }
  })

  test("a budget that is not a number counts as no limit", () => {
    expect(ROW(footerLayout(both, Number.NaN))).toBe("5h ▰▱▱▱▱▱ 23%   sett ▰▰▰▰▰▰ 96%")
  })
})

describe("footerLayout without a 5-hour window", () => {
  const noFive = { five: null, week: 96, stale: false }

  test("5h is not drawn at all, never as libero", () => {
    const layout = footerLayout(noFive, 60)!
    expect(footerText(layout)).toBe("sett ▰▰▰▰▰▰ 96%")
    expect(layout.parts.map((part) => part.window)).toEqual(["week"])
    for (let budget = 0; budget <= 80; budget++) {
      const row = ROW(footerLayout({ ...noFive, fable: 12 }, budget)) ?? ""
      expect(row).not.toContain("5h")
      expect(row).not.toContain("libero")
    }
  })
  test("the 5-hour window is still drawn when it is reported", () => {
    expect(ROW(footerLayout({ five: 0, week: 96, stale: false }, 60))).toBe("5h ▱▱▱▱▱▱ 0%   sett ▰▰▰▰▰▰ 96%")
  })
  test("a missing week still says libero, next to the 5-hour meter", () => {
    expect(ROW(footerLayout({ five: 23, week: null, stale: false }, 60))).toBe("5h ▰▱▱▱▱▱ 23%   sett libero")
    expect(ROW(footerLayout({ five: null, week: null, stale: false }, 60))).toBe("sett libero")
  })
  test("shrink order is the same: marker, full, shorter bars, icon", () => {
    const stale = { ...noFive, stale: true }
    expect(ROW(footerLayout(stale, 26))).toBe("sett ▰▰▰▰▰▰ 96%  (vecchio)")
    expect(ROW(footerLayout(stale, 25))).toBe("sett ▰▰▰▰▰▰ 96%")
    expect(ROW(footerLayout(noFive, 14))).toBe("sett ▰▰▰▰▰ 96%")
    expect(ROW(footerLayout(noFive, 12))).toBe("sett ▰▰▰ 96%")
    expect(ROW(footerLayout(noFive, 11))).toBe(FOOTER_ICON)
  })
})

describe("footerLayout with Fable", () => {
  const all = { five: 23, week: 96, fable: 12, stale: false }
  const FULL = "5h ▰▱▱▱▱▱ 23%   sett ▰▰▰▰▰▰ 96%"

  test("a third meter after sett, same bar style", () => {
    const layout = footerLayout(all, 80)!
    expect(footerText(layout)).toBe(`${FULL}   fable ▰▱▱▱▱▱ 12%`)
    expect(layout.parts.map((part) => part.window)).toEqual(["five", "week", "fable"])
    expect(layout.width).toBe(50)
  })
  test("no Fable reading (absent or null) means no third meter", () => {
    expect(ROW(footerLayout({ five: 23, week: 96, stale: false }, 80))).toBe(FULL)
    expect(ROW(footerLayout({ ...all, fable: null }, 80))).toBe(FULL)
  })
  test("every window stays while the bars get shorter; then the icon", () => {
    expect(ROW(footerLayout(all, 50))).toBe(`${FULL}   fable ▰▱▱▱▱▱ 12%`)
    expect(ROW(footerLayout(all, 49))).toBe("5h ▰▱▱▱▱ 23%  sett ▰▰▰▰▰ 96%  fable ▰▱▱▱▱ 12%")
    expect(ROW(footerLayout(all, 44))).toBe("5h ▰▱▱▱ 23%  sett ▰▰▰▰ 96%  fable ▱▱▱▱ 12%")
    expect(ROW(footerLayout(all, 39))).toBe("5h ▰▱▱ 23%  sett ▰▰▰ 96%  fable ▱▱▱ 12%")
    expect(ROW(footerLayout(all, 38))).toBe(FOOTER_ICON)
    expect(ROW(footerLayout(all, 1))).toBe(FOOTER_ICON)
  })
  test("the old marker goes before anything else", () => {
    const stale = { ...all, stale: true }
    expect(ROW(footerLayout(stale, 61))).toBe(`${FULL}   fable ▰▱▱▱▱▱ 12%  (vecchio)`)
    expect(ROW(footerLayout(stale, 60))).toBe(`${FULL}   fable ▰▱▱▱▱▱ 12%`)
    expect(ROW(footerLayout(stale, 49))).toBe("5h ▰▱▱▱▱ 23%  sett ▰▰▰▰▰ 96%  fable ▰▱▱▱▱ 12%")
  })
})

describe("iconTone", () => {
  const base = { five: 10, week: 10, fable: 10, stale: false }

  test("green when every window is green", () => {
    expect(iconTone(base)).toBe("ok")
  })
  test("each window alone can turn it red", () => {
    expect(iconTone({ ...base, five: 91 })).toBe("high")
    expect(iconTone({ ...base, week: 91 })).toBe("high")
    expect(iconTone({ ...base, fable: 80 })).toBe("high")
  })
  test("each window alone can turn it yellow", () => {
    expect(iconTone({ ...base, five: 70 })).toBe("warn")
    expect(iconTone({ ...base, week: 70 })).toBe("warn")
    expect(iconTone({ ...base, fable: 50 })).toBe("warn")
  })
  test("red beats yellow beats green", () => {
    expect(iconTone({ five: 10, week: 75, fable: 85, stale: false })).toBe("high")
    expect(iconTone({ five: 95, week: 75, fable: 10, stale: false })).toBe("high")
    expect(iconTone({ five: 10, week: 75, fable: 10, stale: false })).toBe("warn")
  })
  test("ties give that level", () => {
    expect(iconTone({ five: 75, week: 80, fable: 55, stale: false })).toBe("warn")
    expect(iconTone({ five: 95, week: 99, fable: 90, stale: false })).toBe("high")
  })
  test("Fable uses its own thresholds, not the weekly ones", () => {
    expect(iconTone({ five: null, week: 60, fable: 49, stale: false })).toBe("ok")
    expect(iconTone({ five: null, week: 60, fable: 50, stale: false })).toBe("warn")
    expect(iconTone({ five: null, week: 60, fable: 80, stale: false })).toBe("high")
    expect(iconTone({ five: null, week: 85, fable: null, stale: false })).toBe("warn")
  })
  test("a window that is not reported does not count", () => {
    expect(iconTone({ five: null, week: 10, stale: false })).toBe("ok")
    expect(iconTone({ five: null, week: 10, fable: null, stale: false })).toBe("ok")
  })
  test("old numbers are faint, unless one of them is red", () => {
    expect(iconTone({ five: 99, week: 99, fable: 99, stale: true })).toBe("high")
    expect(iconTone({ five: null, week: 75, fable: 10, stale: true })).toBe("faint")
    expect(iconTone({ five: null, week: 10, fable: 10, stale: true })).toBe("faint")
  })
  test("no numbers at all is faint", () => {
    expect(iconTone({ five: null, week: null, stale: false })).toBe("faint")
  })
  test("the icon layout carries the tone", () => {
    expect(footerLayout({ five: 10, week: 95, stale: false }, 5)!.icon).toBe("high")
    expect(footerLayout({ five: 10, week: 10, fable: 55, stale: false }, 5)!.icon).toBe("warn")
    expect(footerLayout({ five: 10, week: 10, stale: true }, 5)!.icon).toBe("faint")
  })
})

describe("footer widths, brute force", () => {
  const percents = [null, 0, 23, 100]
  const fables = [undefined, null, 0, 12, 100]
  test("never wider than the budget, and never wider when the budget shrinks", () => {
    for (const five of percents) {
      for (const week of percents) {
        for (const fable of fables) {
          for (const stale of [true, false]) {
            let last = Infinity
            for (let budget = 80; budget >= 0; budget--) {
              const layout = footerLayout({ five, week, fable, stale }, budget)
              const width = layout?.width ?? 0
              if (layout) {
                expect(width).toBeLessThanOrEqual(budget)
                expect(footerText(layout).length).toBe(width)
                expect(footerText(layout)).not.toContain("\n")
              }
              // From one column up there is always something to click; under that, nothing.
              expect(layout === null).toBe(budget < 1)
              expect(width).toBeLessThanOrEqual(last)
              last = width
            }
          }
        }
      }
    }
  })
})

describe("createClickGate", () => {
  const make = () => {
    let clicks = 0
    return { gate: createClickGate(() => clicks++), count: () => clicks }
  }

  test("a press and a release on the same cell is one click", () => {
    const { gate, count } = make()
    gate.down({ button: 0, x: 60, y: 26 })
    gate.up({ button: 0, x: 60, y: 26 })
    expect(count()).toBe(1)
  })
  test("a release alone is not a click (the press started elsewhere)", () => {
    const { gate, count } = make()
    gate.up({ button: 0, x: 60, y: 26 })
    expect(count()).toBe(0)
  })
  test("only the main button clicks", () => {
    const { gate, count } = make()
    gate.down({ button: 2, x: 60, y: 26 })
    gate.up({ button: 2, x: 60, y: 26 })
    gate.down({ button: 0, x: 60, y: 26 })
    gate.up({ button: 2, x: 60, y: 26 })
    gate.down({ button: 2, x: 60, y: 26 })
    gate.up({ button: 0, x: 60, y: 26 })
    expect(count()).toBe(0)
  })
  test("a drag across the footer (a text selection) is not a click", () => {
    const { gate, count } = make()
    gate.down({ button: 0, x: 60, y: 26 })
    gate.up({ button: 0, x: 75, y: 26 })
    gate.down({ button: 0, x: 60, y: 26 })
    gate.up({ button: 0, x: 60, y: 27 })
    expect(count()).toBe(0)
  })
  test("each click needs its own press, and cancel disarms", () => {
    const { gate, count } = make()
    gate.down()
    gate.up()
    gate.up()
    expect(count()).toBe(1)
    gate.down()
    gate.cancel()
    gate.up()
    expect(count()).toBe(1)
  })
  test("a position that is not reported counts as the same cell", () => {
    const { gate, count } = make()
    gate.down({ button: 0 })
    gate.up({ button: 0 })
    expect(count()).toBe(1)
  })
})

describe("dialogLayout", () => {
  test("bar of 20 cells when the dialog is wide", () => {
    expect(dialogLayout(80).cells).toBe(20)
    expect(dialogLayout(80).labelWidth).toBe(11)
  })
  test("the bar shrinks with the dialog and stops at 5", () => {
    expect(dialogLayout(30).cells).toBe(13)
    expect(dialogLayout(12).cells).toBe(5)
  })
  test("row width never passes the dialog width when it can help it", () => {
    for (let width = 24; width <= 90; width++) {
      const layout = dialogLayout(width)
      expect(layout.labelWidth + layout.cells + 6).toBeLessThanOrEqual(Math.max(width, 22))
    }
  })
})

describe("fitText", () => {
  test("keeps what fits, ends with an ellipsis otherwise", () => {
    expect(fitText("si azzera tra 1 h", 40)).toBe("si azzera tra 1 h")
    expect(fitText("si azzera tra 1 h 9 min", 10)).toBe("si azzera…")
    expect(fitText("abc", 0)).toBe("")
    expect(fitText("abc", 1)).toBe("…")
  })
  test("counts characters, not UTF-16 units", () => {
    expect(fitText("😀😀😀😀", 3)).toBe("😀😀…")
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
    const t = createWidthTracker({ initial: 60, onChange: (w) => seen.push(w), scheduler: fake().scheduler })
    t.report(75)
    expect(seen).toEqual([75])
  })

  test("a burst of sizes becomes one update with the last size", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 60, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(75)
    for (const w of [74, 73, 72, 71, 70]) t.report(w)
    expect(seen).toEqual([75])
    expect(f.jobs.length).toBe(1)
    expect(f.jobs[0]!.ms).toBe(50)
    f.jobs[0]!.fn()
    expect(seen).toEqual([75, 70])
  })

  test("the same size again does no work", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 60, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(75)
    t.report(75)
    t.report(75.4)
    expect(f.jobs.length).toBe(0)
    expect(seen).toEqual([75])
  })

  test("a burst that ends where it began changes nothing", () => {
    const seen: number[] = []
    const f = fake()
    const t = createWidthTracker({ initial: 60, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(75)
    t.report(50)
    t.report(75)
    f.jobs[0]?.fn()
    expect(seen).toEqual([75])
  })

  test("zero, negative and NaN are ignored", () => {
    const seen: number[] = []
    const t = createWidthTracker({ initial: 60, onChange: (w) => seen.push(w), scheduler: fake().scheduler })
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
    const t = createWidthTracker({ initial: 60, onChange: (w) => seen.push(w), scheduler: f.scheduler })
    t.report(75)
    t.report(70)
    t.dispose()
    expect(f.jobs.length).toBe(0)
    expect(seen).toEqual([75])
  })
})

describe("rowBudget", () => {
  test("my own width plus what the flexible neighbour can give up", () => {
    expect(rowBudget(31, 20, 12)).toBe(39)
    expect(rowBudget(31, 12, 12)).toBe(31)
  })
  test("goes below my own width when the neighbour is squeezed under its reserve", () => {
    expect(rowBudget(31, 0, 12)).toBe(19)
  })
  test("no flexible neighbour means no answer", () => {
    expect(rowBudget(31, undefined, 12)).toBeUndefined()
  })
  test("never less than 1", () => {
    expect(rowBudget(5, 0, 12)).toBe(1)
  })
})

describe("footerMessage", () => {
  test("the long wording when there is room", () => {
    expect(footerMessage("login", 60)).toBe("Claude: accesso scaduto, apri claude")
    expect(footerMessage("waiting", 60)).toBe("Claude: in attesa dei dati")
    expect(footerMessage("unavailable", 60)).toBe("Claude: uso non disponibile")
  })
  test("shorter wordings as the budget shrinks, nothing when none fits", () => {
    expect(footerMessage("login", 30)).toBe("Claude: accesso scaduto")
    expect(footerMessage("login", 20)).toBe("accesso scaduto")
    expect(footerMessage("login", 14)).toBeNull()
    expect(footerMessage("waiting", 17)).toBe("Claude: in attesa")
    expect(footerMessage("unavailable", 23)).toBe("Claude: non disponibile")
  })
  test("never wider than the budget", () => {
    for (const kind of ["login", "waiting", "unavailable"] as const) {
      for (let budget = 0; budget < 60; budget++) {
        const text = footerMessage(kind, budget)
        if (text !== null) expect(text.length).toBeLessThanOrEqual(budget)
      }
    }
  })
})

describe("resetFit", () => {
  const now = new Date(2026, 10, 9, 23, 51).getTime()
  const window = { percent: 96, resetsAt: new Date(2026, 10, 10, 1, 0).getTime() }
  test("the whole line when it fits", () => {
    expect(resetFit(window, now, 40)).toBe("si azzera tra 1 h 9 min, mar 01:00")
  })
  test("loses the clock, then the first words, then gets cut", () => {
    expect(resetFit(window, now, 33)).toBe("si azzera tra 1 h 9 min")
    expect(resetFit(window, now, 20)).toBe("tra 1 h 9 min")
    expect(resetFit(window, now, 8)).toBe("tra 1 h…")
  })
  test("texts without a clock are cut, never longer than the width", () => {
    expect(resetFit({ percent: 1, resetsAt: null }, now, 10)).toBe("azzeramen…")
    for (let width = 1; width < 50; width++) expect([...resetFit(window, now, width)].length).toBeLessThanOrEqual(width)
  })
})

describe("hoverTone", () => {
  test("without hover every tone is unchanged", () => {
    expect(hoverTone("faint", false)).toBe("faint")
    expect(hoverTone("muted", false)).toBe("muted")
    expect(hoverTone("base", false)).toBe("base")
  })
  test("with hover every tone is one step brighter and base stays base", () => {
    expect(hoverTone("faint", true)).toBe("muted")
    expect(hoverTone("muted", true)).toBe("base")
    expect(hoverTone("base", true)).toBe("base")
  })
})

describe("createHoverGate", () => {
  const make = () => {
    const seen: boolean[] = []
    return { gate: createHoverGate((hovered) => seen.push(hovered)), seen }
  }

  test("starts not hovered and says nothing", () => {
    const { gate, seen } = make()
    expect(gate.hovered).toBe(false)
    expect(seen).toEqual([])
  })
  test("enter turns it on, leave turns it off", () => {
    const { gate, seen } = make()
    gate.enter()
    expect(gate.hovered).toBe(true)
    gate.leave()
    expect(gate.hovered).toBe(false)
    expect(seen).toEqual([true, false])
  })
  test("reset turns it off (dialog opened, terminal blurred)", () => {
    const { gate, seen } = make()
    gate.enter()
    gate.reset()
    expect(gate.hovered).toBe(false)
    expect(seen).toEqual([true, false])
  })
  test("repeated enters, leaves and resets report nothing new", () => {
    const { gate, seen } = make()
    gate.leave()
    gate.reset()
    gate.enter()
    gate.enter()
    gate.enter()
    expect(seen).toEqual([true])
    gate.leave()
    gate.leave()
    gate.reset()
    expect(seen).toEqual([true, false])
  })
  test("moving between two children (out then over) ends hovered", () => {
    const { gate } = make()
    gate.enter()
    gate.leave()
    gate.enter()
    expect(gate.hovered).toBe(true)
  })
  test("it can turn on again after a reset (pointer moves over the item again)", () => {
    const { gate, seen } = make()
    gate.enter()
    gate.reset()
    gate.enter()
    expect(seen).toEqual([true, false, true])
  })
  test("two gates are independent (home and session footers)", () => {
    const a = make()
    const b = make()
    a.gate.enter()
    expect(b.gate.hovered).toBe(false)
    expect(b.seen).toEqual([])
  })
})
