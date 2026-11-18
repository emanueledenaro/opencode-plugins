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
  createResizeWatch,
  createWidthTracker,
  rowBudget,
  footerMessage,
  resetFit,
  FOOTER_MAX_CELLS,
  resetIt,
  updatedIt,
  failureIt,
  needsYou,
  staleIt,
  paceIt,
  weekLevel,
  weekPace,
  PACE_HIGH_MARGIN,
  PACE_WARN_MARGIN,
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
  LEVEL_COLOURS,
  OLD_READING_MS,
  formatPercent,
  inReserve,
  CAUTION_YELLOW,
  cautionYellow,
  levelColour,
  readingPaceFit,
  readingPaceIt,
  readingWeekLevel,
  shownPercent,
  type LevelTheme,
  type UsageSnapshot,
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
    expect(fableLevel(49)).toBe("ok")
    expect(fableLevel(50)).toBe("warn")
    expect(fableLevel(79)).toBe("warn")
    expect(fableLevel(80)).toBe("high")
    expect(fableLevel(100)).toBe("high")
  })
  test("the lines are judged on the number that is drawn: 79.5 is drawn 80% and is red", () => {
    expect([formatPercent(49.4), fableLevel(49.4)]).toEqual(["49%", "ok"])
    expect([formatPercent(49.5), fableLevel(49.5)]).toEqual(["50%", "warn"])
    expect([formatPercent(79.4), fableLevel(79.4)]).toEqual(["79%", "warn"])
    expect([formatPercent(79.5), fableLevel(79.5)]).toEqual(["80%", "high"])
  })
  test("the stop line is 80% included", () => {
    const at = (percent: number) => parseUsage(withLimits([fableEntry(percent)]), NOW)
    expect(fableOverThreshold(at(79.4))).toBe(false)
    expect(fableOverThreshold(at(79.5))).toBe(true) // drawn "80%"
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
  test("the reserve starts at 90% as drawn: one line for the toast, the colour and the words", () => {
    expect(weeklyOverThreshold(week(89.4))).toBe(false)
    expect(weeklyOverThreshold(week(89.5))).toBe(true) // drawn "90%"
    expect(weeklyOverThreshold(week(90))).toBe(true)
    expect(weeklyOverThreshold(week(96))).toBe(true)
    expect(weeklyOverThreshold(null)).toBe(false)
    for (const percent of [89.4, 89.5, 90, 90.4, 96]) {
      const inside = inReserve(percent)
      expect({ percent, toast: weeklyOverThreshold(week(percent)) }).toEqual({ percent, toast: inside })
      expect({ percent, red: usageLevel(percent) === "high" }).toEqual({ percent, red: inside })
      expect({ percent, said: paceIt({ percent, resetsAt: null }, NOW) !== undefined }).toEqual({ percent, said: inside })
      const paced = weekPace({ percent, resetsAt: NOW + 3 * 24 * 60 * 60_000 }, NOW)
      expect({ percent, reserve: paced?.reason === "reserve" }).toEqual({ percent, reserve: inside })
    }
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

  test("a login the server refuses retries in 5 minutes, without the network back-off", async () => {
    const h = harness({ fetchUsage: async () => ({ ok: false, failure: { kind: "login-expired", status: 401 } }) })
    await h.monitor.refresh()
    expect(h.monitor.state.nextAllowedAt - NOW).toBe(POLL_INTERVAL_MS)
  })
})

describe("monitor: a 429 back-off is shared through the cache file", () => {
  // One cache file for several monitors, as two OpenCode windows (or one before and after /reload) have.
  const sharedCache = (): Pick<MonitorDeps, "loadCache" | "saveCache"> => {
    let file: string | null = null
    return {
      loadCache: async () => (file === null ? null : parseCache(file)),
      saveCache: async (state) => void (file = serializeCache(state)),
    }
  }
  const rateLimited = async () =>
    ({ ok: false, failure: { kind: "rate-limited", status: 429, retryAfterMs: 30 * 60_000 } }) as const

  test("after /reload, /usage still waits for the back-off", async () => {
    const cache = sharedCache()
    await harness({ ...cache, fetchUsage: rateLimited }).monitor.refresh()
    const reloaded = harness(cache)
    reloaded.advance(60_000)
    await reloaded.monitor.hydrate()
    expect([await reloaded.monitor.refresh(true), reloaded.calls.fetch]).toEqual(["skipped", 0])
  })

  test("a network failure is not shared: the file has no back-off end and another window's /usage still goes", async () => {
    const cache = sharedCache()
    await harness({ ...cache, fetchUsage: async () => ({ ok: false, failure: { kind: "network" } }) }).monitor.refresh()
    const saved = await cache.loadCache()
    const other = harness(cache)
    other.advance(60_000)
    expect([saved?.rateLimitedUntil, await other.monitor.refresh(true)]).toEqual([undefined, "refreshed"])
  })

  test("a window that is already open sees another window's 429 before its next poll", async () => {
    const cache = sharedCache()
    const open = harness(cache)
    await open.monitor.refresh()
    const other = harness({ ...cache, fetchUsage: rateLimited })
    other.advance(60_000)
    await other.monitor.refresh()
    open.advance(POLL_INTERVAL_MS)
    expect([await open.monitor.refresh(), open.calls.fetch]).toEqual(["skipped", 1])
  })
})

describe("look", () => {
  test("levels", () => {
    expect(usageLevel(0)).toBe("ok")
    expect(usageLevel(69)).toBe("ok")
    expect(usageLevel(70)).toBe("warn")
    expect(usageLevel(89)).toBe("warn")
    expect(usageLevel(90)).toBe("high")
    expect(usageLevel(91)).toBe("high")
  })
  test("a level is judged on the number that is drawn, so the two never disagree", () => {
    expect([formatPercent(69.4), usageLevel(69.4)]).toEqual(["69%", "ok"])
    expect([formatPercent(69.5), usageLevel(69.5)]).toEqual(["70%", "warn"])
    expect([formatPercent(89.4), usageLevel(89.4)]).toEqual(["89%", "warn"])
    expect([formatPercent(89.5), usageLevel(89.5)]).toEqual(["90%", "high"])
    expect([shownPercent(59.4), shownPercent(59.5), shownPercent(59.6)]).toEqual([59, 60, 60])
  })
  // The apple theme as OpenCode 2.3.2 gives it to a plugin, read from a running TUI: a hue exists only for
  // a colour one of the theme's state tokens has, so there is no hue.yellow and hue.orange is the warning colour.
  const rgb = (r: number, g: number, b: number) => ({ r: r / 255, g: g / 255, b: b / 255 })
  const ORANGE = rgb(255, 159, 10)
  const apple = (text = rgb(240, 237, 230)): LevelTheme => ({
    hue: { orange: { 200: ORANGE }, green: { 200: "green" }, red: { 200: "red" } },
    text: { base: text, feedback: { success: { base: "green" }, warning: { base: ORANGE }, error: { base: "red" } } },
  })
  test("the word beside the dot names the colour that is drawn, and no level takes the warning colour", () => {
    expect(LEVEL_COLOURS).toEqual({
      ok: { word: "verde", feedback: "success" },
      warn: { word: "giallo" },
      high: { word: "rosso", feedback: "error" },
    })
  })
  test("levelColour: giallo is yellow in the apple theme, never its warning orange, which means 'waits for you'", () => {
    expect(levelColour("warn", apple())).toBe("#ffd60a")
    expect(levelColour("warn", apple())).not.toBe(ORANGE)
    expect(levelColour("ok", apple())).toBe("green")
    expect(levelColour("high", apple())).toBe("red")
  })
  test("levelColour: a theme with no feedback colours draws green and red as plain text, yellow still yellow", () => {
    const bare: LevelTheme = { text: { base: "text" } }
    expect([levelColour("ok", bare), levelColour("warn", bare), levelColour("high", bare)]).toEqual(["text", "#ffd60a", "text"])
  })
  test("cautionYellow: the apple theme's yellow for a dark background, its darker one under dark text", () => {
    expect(CAUTION_YELLOW).toEqual({ dark: "#ffd60a", light: "#a05a00" })
    expect(cautionYellow(apple())).toBe("#ffd60a")
    expect(cautionYellow(apple(rgb(29, 29, 31)))).toBe("#a05a00") // the text of the apple theme's light mode
    expect(cautionYellow(apple(rgb(128, 128, 128)))).toBe("#ffd60a")
    expect(cautionYellow(apple(rgb(127, 127, 127)))).toBe("#a05a00")
    // Green weighs most in how light a colour looks: pure green text is light, pure blue text is dark.
    expect([cautionYellow(apple(rgb(0, 255, 0))), cautionYellow(apple(rgb(0, 0, 255)))]).toEqual(["#ffd60a", "#a05a00"])
  })
  test("cautionYellow: a theme that has a yellow hue gives its own; an unreadable text colour counts as light", () => {
    expect(cautionYellow({ hue: { yellow: { 200: "own" } }, text: { base: rgb(29, 29, 31) } })).toBe("own")
    expect(cautionYellow({ hue: { yellow: {} }, text: { base: rgb(29, 29, 31) } })).toBe("#a05a00")
    expect(cautionYellow({ text: { base: "#1d1d1f" } })).toBe("#ffd60a")
    expect(cautionYellow({ text: { base: { r: 0, g: 0 } } })).toBe("#ffd60a")
    expect(cautionYellow({})).toBe("#ffd60a")
  })
  test("meter", () => {
    expect(meter(0, 10)).toEqual({ filled: "", empty: "▱".repeat(10) })
    expect(meter(96, 10)).toEqual({ filled: "▰".repeat(10), empty: "" })
    expect(meter(23, 10)).toEqual({ filled: "▰▰", empty: "▱".repeat(8) })
    expect(meter(150, 5).filled).toBe("▰▰▰▰▰")
  })
  test("the reset is a time span in the shared format, never a clock time", () => {
    const now = new Date(2026, 10, 9, 23, 51).getTime()
    const soon = resetIt({ percent: 96, resetsAt: new Date(2026, 10, 10, 1, 0).getTime() }, now)
    expect(soon).toBe("si azzera tra 1h 9m")
    expect(soon).not.toMatch(/\d:\d/)
  })
  test("a reset a day or more away also names its day, in full", () => {
    const now = new Date(2026, 10, 9, 21, 59).getTime() // a Monday
    expect(resetIt({ percent: 59, resetsAt: new Date(2026, 10, 14, 23, 59).getTime() }, now)).toBe("si azzera tra 5g 2h (sabato)")
    expect(resetIt({ percent: 59, resetsAt: new Date(2026, 10, 10, 21, 59).getTime() }, now)).toBe("si azzera tra 1g (martedì)")
    expect(resetIt({ percent: 59, resetsAt: new Date(2026, 10, 10, 21, 58).getTime() }, now)).toBe("si azzera tra 23h 59m")
  })
  test("a reset with no time, one under a minute away and one already due", () => {
    const now = new Date(2026, 10, 9, 23, 51).getTime()
    expect(resetIt({ percent: 1, resetsAt: null }, now)).toBe("azzeramento non indicato")
    expect(resetIt({ percent: 1, resetsAt: now + 59_000 }, now)).toBe("si azzera tra poco")
    expect(resetIt({ percent: 1, resetsAt: now }, now)).toBe("si sta azzerando")
  })
  test("the age of the numbers uses the same format", () => {
    const now = new Date(2026, 10, 9, 23, 51).getTime()
    expect(updatedIt(now - 30_000, now)).toBe("aggiornato adesso")
    expect(updatedIt(now - 180_000, now)).toBe("aggiornato 3m fa")
    expect(updatedIt(now - 65 * 60_000, now)).toBe("aggiornato 1h 5m fa")
  })
})

describe("failureIt, why the numbers are old and when the next attempt is", () => {
  const MIN = 60_000
  test("says when it tries again, from a minute up", () => {
    expect(failureIt({ kind: "rate-limited", status: 429 }, 12 * MIN)).toBe("troppe richieste, riprovo tra 12m")
    expect(failureIt({ kind: "network" }, 5 * MIN)).toBe("rete non raggiungibile, riprovo tra 5m")
    expect(failureIt({ kind: "timeout" }, 65 * MIN)).toBe("rete non raggiungibile, riprovo tra 1h 5m")
    expect(failureIt({ kind: "bad-response" }, 5 * MIN)).toBe("dati non disponibili, riprovo tra 5m")
  })
  test("under a minute, or with no known time, it gives no number", () => {
    expect(failureIt({ kind: "rate-limited" }, 59_000)).toBe("troppe richieste, riprovo tra poco")
    expect(failureIt({ kind: "rate-limited" })).toBe("troppe richieste, riprovo tra poco")
    expect(failureIt({ kind: "network" }, -5_000)).toBe("rete non raggiungibile")
    expect(failureIt({ kind: "network" })).toBe("rete non raggiungibile")
  })
  test("a login problem names what you do, never a retry", () => {
    expect(failureIt({ kind: "login-expired" }, 5 * MIN)).toBe("accesso scaduto, apri claude")
    expect(failureIt({ kind: "no-login" }, 5 * MIN)).toBe("accesso scaduto, apri claude")
  })
  test("only a login problem waits for you; every other failure retries by itself", () => {
    expect(needsYou({ kind: "login-expired" })).toBe(true)
    expect(needsYou({ kind: "no-login" })).toBe(true)
    for (const kind of ["rate-limited", "network", "timeout", "bad-response"] as const) expect(needsYou({ kind })).toBe(false)
    expect(needsYou(null)).toBe(false)
  })
  test("the dialog line is short enough for its default width", () => {
    const line = staleIt({ kind: "rate-limited", status: 429 }, 59 * MIN)
    expect(line).toBe("Non aggiornato: troppe richieste, riprovo tra 59m")
    expect(line.length).toBeLessThanOrEqual(52)
  })
})

describe("the week is coloured by its pace", () => {
  const DAY = 24 * 60 * 60_000
  const NOW = new Date(2026, 10, 18, 12, 0).getTime()
  /** A weekly window `daysIn` days old with `percent` used. */
  const week = (percent: number, daysIn: number) => ({ percent, resetsAt: NOW + (7 - daysIn) * DAY })

  test("59% used 1.8 days into the week is red: the percent alone would have said green", () => {
    expect(usageLevel(59)).toBe("ok")
    expect(weekPace(week(59, 1.8), NOW)).toEqual({ level: "high", reason: "pace", pace: 26, margin: 33 })
    expect(weekLevel(week(59, 1.8), NOW)).toBe("high")
  })

  test("the same 59% five days in is green: it is behind the pace", () => {
    expect(weekLevel(week(59, 5), NOW)).toBe("ok")
    expect(weekPace(week(59, 5), NOW)?.margin).toBe(-12)
  })

  test("green up to 10 points ahead, yellow up to 25, red above", () => {
    expect([PACE_WARN_MARGIN, PACE_HIGH_MARGIN]).toEqual([10, 25])
    // 3.5 days in the pace is exactly 50%.
    expect(weekLevel(week(60, 3.5), NOW)).toBe("ok")
    expect(weekLevel(week(60.5, 3.5), NOW)).toBe("warn")
    expect(weekLevel(week(75, 3.5), NOW)).toBe("warn")
    expect(weekLevel(week(75.5, 3.5), NOW)).toBe("high")
  })

  test("the level is judged on the whole numbers that are shown: 10.4 ahead reads '10 sopra' and is green", () => {
    expect(paceIt(week(60.4, 3.5), NOW)).toBe("● verde · ritmo 50% · 10 sopra")
    expect(paceIt(week(60.5, 3.5), NOW)).toBe("● giallo · ritmo 50% · 11 sopra")
    expect(paceIt(week(75.4, 3.5), NOW)).toBe("● giallo · ritmo 50% · 25 sopra")
    expect(paceIt(week(75.5, 3.5), NOW)).toBe("● rosso · ritmo 50% · 26 sopra")
    // The pace is rounded too: 2.48 days in it is 35.4%, drawn 35%; 45.4% used is drawn 45%, so 10 ahead.
    expect(paceIt(week(45.4, 2.48), NOW)).toBe("● verde · ritmo 35% · 10 sopra")
    expect(weekPace(week(45.4, 2.48), NOW)).toEqual({ level: "ok", reason: "pace", pace: 35, margin: 10 })
  })

  test("the same words never come in two colours, whatever the percent and the day", () => {
    const colours = new Map<string, Set<string>>()
    for (let tenths = 0; tenths <= 1000; tenths += 3) {
      for (let day = 0.05; day < 6.5; day += 0.07) {
        const [dot, ...rest] = (paceIt(week(tenths / 10, day), NOW) ?? "").split(" · ")
        const words = rest.join(" · ")
        colours.set(words, (colours.get(words) ?? new Set()).add(dot ?? ""))
      }
    }
    expect(colours.size).toBeGreaterThan(100)
    expect([...colours].filter(([, dots]) => dots.size > 1).map(([words, dots]) => `${words}: ${[...dots].join(", ")}`)).toEqual([])
  })

  test("the margin shown is the percent shown minus the pace shown", () => {
    for (let tenths = 0; tenths < 895; tenths += 7) {
      for (let day = 0.6; day < 6.4; day += 0.13) {
        const pace = weekPace(week(tenths / 10, day), NOW)!
        expect(pace.margin).toBe(Number.parseInt(formatPercent(tenths / 10)) - pace.pace)
        expect(Number.isInteger(pace.pace)).toBe(true)
      }
    }
  })

  test("the first hours of a week count as half a day, so a little use is not judged against a pace near 0", () => {
    const hourIn = week(17, 1 / 24)
    expect(weekPace(hourIn, NOW)?.pace).toBe(7) // half a day of seven: 7.14%, drawn 7%
    expect(weekLevel(hourIn, NOW)).toBe("ok")
    expect(weekLevel(week(18, 1 / 24), NOW)).toBe("warn")
  })

  test("a reset more than a week away still counts as half a day gone", () => {
    expect(weekPace({ percent: 5, resetsAt: NOW + 9 * DAY }, NOW)?.pace).toBe(7)
  })

  test("inside the reserve it is red whatever the pace", () => {
    expect(weekLevel(week(89.4, 6.9), NOW)).toBe("ok")
    expect(weekPace(week(89.5, 6.9), NOW)).toMatchObject({ level: "high", reason: "reserve" }) // drawn "90%"
    expect(weekPace(week(90, 6.9), NOW)).toMatchObject({ level: "high", reason: "reserve" })
    expect(weekPace(week(97, 3), NOW)).toMatchObject({ level: "high", reason: "reserve" })
  })

  test("the last 12 hours are green outside the reserve, and say why", () => {
    const lastHours = { percent: 80, resetsAt: NOW + 12 * 60 * 60_000 }
    expect(weekPace(lastHours, NOW)).toMatchObject({ level: "ok", reason: "last-hours" })
    expect(weekPace({ percent: 80, resetsAt: NOW + 12 * 60 * 60_000 + 60_000 }, NOW)?.reason).toBe("pace")
    expect(weekPace({ percent: 95, resetsAt: NOW + 60_000 }, NOW)).toMatchObject({ level: "high", reason: "reserve" })
  })

  test("without a reset time, or with one already past, the percent alone decides", () => {
    expect(weekPace({ percent: 59, resetsAt: null }, NOW)).toBeNull()
    expect(weekPace({ percent: 59, resetsAt: NOW - 1 }, NOW)).toBeNull()
    expect(weekLevel({ percent: 59, resetsAt: null }, NOW)).toBe("ok")
    expect(weekLevel({ percent: 70, resetsAt: null }, NOW)).toBe("warn")
    expect(weekLevel({ percent: 91, resetsAt: NOW - 1 }, NOW)).toBe("high")
    expect(weekLevel({ percent: 90, resetsAt: null }, NOW)).toBe("high")
  })

  test("paceIt says the colour in words, with the pace and how far from it", () => {
    expect(paceIt(week(59, 1.8), NOW)).toBe("● rosso · ritmo 26% · 33 sopra")
    expect(paceIt(week(65, 3.5), NOW)).toBe("● giallo · ritmo 50% · 15 sopra")
    expect(paceIt(week(30, 3.5), NOW)).toBe("● verde · ritmo 50% · 20 sotto")
    expect(paceIt(week(50.4, 3.5), NOW)).toBe("● verde · ritmo 50% · in pari")
  })

  test("paceIt names the reserve and the last hours in place of the pace", () => {
    expect(paceIt(week(93, 6), NOW)).toBe("● rosso · nella riserva del 10%")
    expect(paceIt({ percent: 80, resetsAt: NOW + 60 * 60_000 }, NOW)).toBe("● verde · ultime ore, il resto scade")
  })

  test("paceIt without a reset time says only the reserve, else nothing", () => {
    expect(paceIt({ percent: 59, resetsAt: null }, NOW)).toBeUndefined()
    expect(paceIt({ percent: 91, resetsAt: null }, NOW)).toBe("● rosso · nella riserva del 10%")
    expect(paceIt({ percent: 90, resetsAt: null }, NOW)).toBe("● rosso · nella riserva del 10%")
    expect(paceIt({ percent: 89, resetsAt: null }, NOW)).toBeUndefined()
  })

  test("the footer draws the week in its pace colour and the other windows by their own lines", () => {
    const layout = footerLayout({ five: 23, week: 59, fable: 36, stale: false, weekLevel: "high" }, 200)
    expect(layout?.parts.map((part) => [part.window, part.level])).toEqual([["five", "ok"], ["week", "high"], ["fable", "ok"]])
    const byPercent = footerLayout({ five: 95, week: 75, fable: 50, stale: false }, 200)
    expect(byPercent?.parts.map((part) => part.level)).toEqual(["high", "warn", "warn"])
  })

  test("a window with no number has no colour", () => {
    expect(footerLayout({ five: null, week: null, stale: false }, 200)?.parts.map((part) => part.level)).toEqual([undefined])
  })

  test("the one-character icon takes the pace colour of the week too", () => {
    expect(iconTone({ five: null, week: 59, fable: 36, stale: false })).toBe("ok")
    expect(iconTone({ five: null, week: 59, fable: 36, stale: false, weekLevel: "high" })).toBe("high")
    expect(iconTone({ five: null, week: 75, fable: 10, stale: false, weekLevel: "ok" })).toBe("ok")
    expect(footerLayout({ five: null, week: 59, fable: 36, stale: false, weekLevel: "high" }, 1)?.icon).toBe("high")
  })
})

describe("an old reading is judged at the time it was read", () => {
  const MIN = 60_000
  const DAY = 24 * 60 * MIN
  // Long ago on purpose: judged against the real clock these weeks are over, so nothing here passes by luck.
  const READ = new Date(2025, 0, 15, 12, 0).getTime()
  /** Numbers read at READ, `daysIn` days into the week. */
  const reading = (percent: number, daysIn: number): UsageSnapshot => ({
    fetchedAt: READ,
    fiveHour: null,
    sevenDay: { percent, resetsAt: READ + (7 - daysIn) * DAY },
    fable: null,
  })

  test("a red reading is still red a day later and two days later, when no refresh came", () => {
    const stale = reading(59, 1.8)
    // Against today's clock the same numbers would drift to yellow and then to green with no new data.
    expect([0, 1, 2].map((days) => weekLevel(stale.sevenDay!, READ + days * DAY))).toEqual(["high", "warn", "ok"])
    expect(readingWeekLevel(stale)).toBe("high")
    expect(readingPaceIt(stale, READ)).toBe("● rosso · ritmo 26% · 33 sopra")
    expect(readingPaceIt(stale, READ + DAY)).toBe("● rosso · ritmo 26% · 33 sopra · 1g fa")
    expect(readingPaceIt(stale, READ + 2 * DAY + 3 * 60 * MIN)).toBe("● rosso · ritmo 26% · 33 sopra · 2g 3h fa")
  })

  test("the footer and the one-character icon keep that red beside old numbers", () => {
    const stale = reading(59, 1.8)
    const input = { five: null, week: 59, stale: true, weekLevel: readingWeekLevel(stale) }
    expect(footerLayout(input, 200)?.parts.map((part) => part.level)).toEqual(["high"])
    expect(footerLayout(input, 14)?.marker).toBe(false) // too narrow for "(vecchio)": the colour is all that is left
    expect(footerLayout(input, 14)?.parts.map((part) => part.level)).toEqual(["high"])
    expect(iconTone(input)).toBe("high")
  })

  test("the age is said from 10 minutes, the budget rule's limit for a reading that still counts", () => {
    expect(OLD_READING_MS).toBe(10 * MIN)
    const fresh = reading(65, 3.5)
    expect(readingPaceIt(fresh, READ + 10 * MIN - 1)).toBe("● giallo · ritmo 50% · 15 sopra")
    expect(readingPaceIt(fresh, READ + 10 * MIN)).toBe("● giallo · ritmo 50% · 15 sopra · 10m fa")
    expect(readingPaceIt(fresh, READ - 5 * MIN)).toBe("● giallo · ritmo 50% · 15 sopra") // clock skew
  })

  test("the reserve and the last hours of an old reading say their age too", () => {
    expect(readingPaceIt(reading(93, 6), READ + 60 * MIN)).toBe("● rosso · nella riserva del 10% · 1h fa")
    expect(readingPaceIt(reading(80, 6.9), READ + 60 * MIN)).toBe("● verde · ultime ore, il resto scade · 1h fa")
  })

  test("a reading with no week, or no reading, has no colour and no line", () => {
    const noWeek: UsageSnapshot = { fetchedAt: READ, fiveHour: { percent: 10, resetsAt: null }, sevenDay: null, fable: null }
    expect(readingWeekLevel(noWeek)).toBeUndefined()
    expect(readingWeekLevel(null)).toBeUndefined()
    expect(readingPaceIt(noWeek, READ + DAY)).toBeUndefined()
    expect(readingPaceFit(noWeek, READ + DAY, 40)).toBeUndefined()
  })

  test("readingPaceFit: a narrow dialog loses the age first, then the line is cut", () => {
    const stale = reading(59, 1.8)
    const now = READ + 2 * DAY + 3 * 60 * MIN
    expect(readingPaceFit(stale, now, 41)).toBe("● rosso · ritmo 26% · 33 sopra · 2g 3h fa")
    expect(readingPaceFit(stale, now, 40)).toBe("● rosso · ritmo 26% · 33 sopra")
    expect(readingPaceFit(stale, now, 30)).toBe("● rosso · ritmo 26% · 33 sopra")
    expect(readingPaceFit(stale, now, 29)).toBe("● rosso · ritmo 26% · 33 sop…")
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

describe("createResizeWatch", () => {
  // A stand-in for an OpenTUI node: it records its resize listeners (a listener added twice counts twice,
  // as on an EventEmitter) and can fire them.
  const fakeNode = () => {
    const listeners: (() => void)[] = []
    return {
      get listeners() {
        return { size: listeners.length }
      },
      on: (event: string, fn: () => void) => void (event === "resize" && listeners.push(fn)),
      off: (event: string, fn: () => void) => {
        const at = event === "resize" ? listeners.indexOf(fn) : -1
        if (at !== -1) listeners.splice(at, 1)
      },
      resize: () => [...listeners].forEach((fn) => fn()),
    }
  }

  test("a resize of any followed node calls back; following again adds no second listener", () => {
    let calls = 0
    const row = fakeNode()
    const path = fakeNode()
    const watch = createResizeWatch(() => calls++)
    watch.follow([row, path])
    watch.follow([row, path])
    row.resize()
    path.resize()
    expect([calls, row.listeners.size, path.listeners.size]).toEqual([2, 1, 1])
  })

  test("a node that left the row is let go, a new one is followed", () => {
    let calls = 0
    const gone = fakeNode()
    const fresh = fakeNode()
    const watch = createResizeWatch(() => calls++)
    watch.follow([gone])
    watch.follow([fresh, { width: 3 }, null])
    gone.resize()
    fresh.resize()
    expect([calls, gone.listeners.size, fresh.listeners.size]).toEqual([1, 0, 1])
  })

  test("dispose lets go of every node", () => {
    const row = fakeNode()
    const watch = createResizeWatch(() => {})
    watch.follow([row])
    watch.dispose()
    expect(row.listeners.size).toBe(0)
  })

  test("follow after dispose adds nothing: a measure queued before cleanup cannot listen again", () => {
    const row = fakeNode()
    const watch = createResizeWatch(() => {})
    watch.follow([row])
    watch.dispose()
    watch.follow([row])
    expect(row.listeners.size).toBe(0)
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
  const weekly = { percent: 59, resetsAt: new Date(2026, 10, 14, 23, 59).getTime() + 2 * 60 * 60_000 }
  test("the whole line when it fits", () => {
    expect(resetFit(window, now, 40)).toBe("si azzera tra 1h 9m")
    expect(resetFit(weekly, now, 30)).toBe("si azzera tra 5g 2h (domenica)")
  })
  test("loses the day, then the first words, then gets cut", () => {
    expect(resetFit(weekly, now, 29)).toBe("si azzera tra 5g 2h")
    expect(resetFit(weekly, now, 19)).toBe("si azzera tra 5g 2h")
    expect(resetFit(weekly, now, 18)).toBe("tra 5g 2h")
    expect(resetFit(weekly, now, 6)).toBe("tra 5…")
  })
  test("texts without a day are cut, never longer than the width", () => {
    expect(resetFit({ percent: 1, resetsAt: null }, now, 10)).toBe("azzeramen…")
    for (const each of [window, weekly])
      for (let width = 1; width < 50; width++) expect([...resetFit(each, now, width)].length).toBeLessThanOrEqual(width)
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
