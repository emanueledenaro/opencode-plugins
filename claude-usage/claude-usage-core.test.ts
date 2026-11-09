import { describe, expect, test } from "bun:test"
import {
  usageLevel,
  meter,
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
