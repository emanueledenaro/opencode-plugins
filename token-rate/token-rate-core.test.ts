import { describe, expect, test } from "bun:test"
import {
  buildFooterView,
  buildSpeedDialog,
  createLiveRate,
  fitText,
  contentWidth,
  createWidthSettler,
  dialogSparkCells,
  fitFooter,
  footerRoom,
  footerWidth,
  visibleColumns,
  createRateTracker,
  createThroughputCollector,
  dedupeMeasurements,
  formatModelDetail,
  formatNumberIt,
  formatRate,
  formatRateIt,
  formatSecondsIt,
  isUsableMeasurement,
  median,
  modelLabel,
  padColumns,
  parseLogText,
  pickRate,
  sparkline,
  speedTone,
  spinnerFrame,
  startOfLocalDay,
  summarize,
  type ThroughputMeasurement,
} from "./token-rate-core"

describe("createThroughputCollector", () => {
  test("calculates throughput from the first and last streamed text deltas", () => {
    const collector = createThroughputCollector()

    collector.recordTextDelta({
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
      delta: "Hello",
      at: 1_020,
    })
    collector.recordTextDelta({
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
      delta: " world",
      at: 2_020,
    })

    expect(
      collector.completeMessage({
        sessionID: "ses_1",
        messageID: "msg_1",
        createdAt: 1_000,
        outputTokens: 30,
        providerID: "openai",
        modelID: "gpt-5.6-terra",
      }),
    ).toEqual({
      timestamp: 2_020,
      sessionID: "ses_1",
      messageID: "msg_1",
      providerID: "openai",
      modelID: "gpt-5.6-terra",
      outputTokens: 30,
      timeToFirstTokenMs: 20,
      generationMs: 1_000,
      tokensPerSecond: 30,
    })
  })

  test("does not report a rate for a response with multiple text parts", () => {
    const collector = createThroughputCollector()

    collector.recordTextDelta({ sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", delta: "First", at: 1_000 })
    collector.recordTextDelta({ sessionID: "ses_1", messageID: "msg_1", partID: "prt_2", delta: "Second", at: 2_000 })

    expect(
      collector.completeMessage({
        sessionID: "ses_1",
        messageID: "msg_1",
        createdAt: 900,
        outputTokens: 30,
        providerID: "openai",
        modelID: "gpt-5.6-terra",
      }),
    ).toBeUndefined()
  })
})

describe("createRateTracker", () => {
  const started = { sessionID: "ses_1", messageID: "msg_1", startedAt: 1_000, providerID: "anthropic", modelID: "claude-x" }

  test("turns a step's start, text deltas and end into one measurement", () => {
    const tracker = createRateTracker()
    tracker.stepStarted(started)
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 1_500 })
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 2_500 })

    expect(tracker.stepEnded({ sessionID: "ses_1", messageID: "msg_1", outputTokens: 50 })).toEqual({
      timestamp: 2_500,
      sessionID: "ses_1",
      messageID: "msg_1",
      providerID: "anthropic",
      modelID: "claude-x",
      outputTokens: 50,
      timeToFirstTokenMs: 500,
      generationMs: 1_000,
      tokensPerSecond: 50,
    })
  })

  test("a step can only end once: a second end without a new start gives no rate", () => {
    const tracker = createRateTracker()
    tracker.stepStarted(started)
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 1_500 })
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 2_500 })
    expect(tracker.stepEnded({ sessionID: "ses_1", messageID: "msg_1", outputTokens: 50 })).toBeDefined()
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 3_000 })
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 4_000 })
    expect(tracker.stepEnded({ sessionID: "ses_1", messageID: "msg_1", outputTokens: 50 })).toBeUndefined()
  })

  test("two text blocks in one step give no rate, like the old plugin", () => {
    const tracker = createRateTracker()
    tracker.stepStarted(started)
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 1_500 })
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 1, at: 2_500 })
    expect(tracker.stepEnded({ sessionID: "ses_1", messageID: "msg_1", outputTokens: 50 })).toBeUndefined()
  })

  test("a step that ends without a recorded start gives no rate", () => {
    const tracker = createRateTracker()
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 1_500 })
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 2_500 })
    expect(tracker.stepEnded({ sessionID: "ses_1", messageID: "msg_1", outputTokens: 50 })).toBeUndefined()
  })

  test("a failed step forgets its start: later deltas alone give no rate", () => {
    const tracker = createRateTracker()
    tracker.stepStarted(started)
    tracker.stepFailed({ sessionID: "ses_1", messageID: "msg_1" })
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 1_500 })
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 2_500 })
    expect(tracker.stepEnded({ sessionID: "ses_1", messageID: "msg_1", outputTokens: 50 })).toBeUndefined()
  })

  test("a failed step forgets its deltas: a retry with the same id is measured on its own", () => {
    const tracker = createRateTracker()
    tracker.stepStarted(started)
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 1_500 })
    tracker.stepFailed({ sessionID: "ses_1", messageID: "msg_1" })
    tracker.stepStarted({ ...started, startedAt: 10_000 })
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 10_100 })
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 11_100 })
    expect(tracker.stepEnded({ sessionID: "ses_1", messageID: "msg_1", outputTokens: 20 })?.generationMs).toBe(1_000)
  })

  test("a message with a single text delta (no time span) gives no rate", () => {
    const tracker = createRateTracker()
    tracker.stepStarted(started)
    tracker.textDelta({ sessionID: "ses_1", messageID: "msg_1", ordinal: 0, at: 1_500 })
    expect(tracker.stepEnded({ sessionID: "ses_1", messageID: "msg_1", outputTokens: 50 })).toBeUndefined()
  })

  test("the same message id in two sessions is kept apart", () => {
    const tracker = createRateTracker()
    tracker.stepStarted({ ...started, sessionID: "ses_a" })
    tracker.stepStarted({ ...started, sessionID: "ses_b" })
    tracker.textDelta({ sessionID: "ses_a", messageID: "msg_1", ordinal: 0, at: 1_000 })
    tracker.textDelta({ sessionID: "ses_a", messageID: "msg_1", ordinal: 0, at: 2_000 })
    tracker.textDelta({ sessionID: "ses_b", messageID: "msg_1", ordinal: 0, at: 1_000 })
    tracker.textDelta({ sessionID: "ses_b", messageID: "msg_1", ordinal: 0, at: 5_000 })
    expect(tracker.stepEnded({ sessionID: "ses_a", messageID: "msg_1", outputTokens: 40 })?.tokensPerSecond).toBe(40)
    expect(tracker.stepEnded({ sessionID: "ses_b", messageID: "msg_1", outputTokens: 40 })?.tokensPerSecond).toBe(10)
  })
})

describe("formatRate", () => {
  test("rounds to a whole number from 10 up and keeps one decimal below", () => {
    expect(formatRate(10)).toBe("10 tok/s")
    expect(formatRate(42.4)).toBe("42 tok/s")
    expect(formatRate(42.5)).toBe("43 tok/s")
    expect(formatRate(9.94)).toBe("9.9 tok/s")
    expect(formatRate(0.55)).toBe("0.6 tok/s")
  })

  test("returns nothing for a value that is not a usable rate", () => {
    expect(formatRate(0)).toBeUndefined()
    expect(formatRate(-3)).toBeUndefined()
    expect(formatRate(Number.NaN)).toBeUndefined()
    expect(formatRate(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

describe("pickRate", () => {
  const rates = { ses_a: 30, ses_b: 70 }

  test("prefers the session being looked at", () => {
    expect(pickRate(rates, "ses_a", 70)).toBe(30)
  })

  test("falls back to the latest rate overall when the viewed session has none", () => {
    expect(pickRate(rates, "ses_x", 70)).toBe(70)
    expect(pickRate(rates, undefined, 70)).toBe(70)
  })

  test("is undefined when nothing was measured yet", () => {
    expect(pickRate({}, "ses_a", undefined)).toBeUndefined()
  })
})

describe("summarize", () => {
  const m = (messageID: string, tokensPerSecond: number) =>
    ({
      timestamp: 1,
      sessionID: "ses_1",
      messageID,
      providerID: "p",
      modelID: "m",
      outputTokens: 10,
      timeToFirstTokenMs: 1,
      generationMs: 1,
      tokensPerSecond,
    }) as const

  test("averages the last N measurements and reports min and max", () => {
    const result = summarize([m("a", 10), m("b", 20), m("c", 60)], 2)
    expect(result?.sampleSize).toBe(2)
    expect(result?.averageTokensPerSecond).toBe(40)
    expect(result?.minimumTokensPerSecond).toBe(20)
    expect(result?.maximumTokensPerSecond).toBe(60)
    expect(result?.latest.messageID).toBe("c")
  })

  test("counts a message once even if two TUI windows logged it", () => {
    const result = summarize([m("a", 10), m("a", 10), m("b", 30)], 10)
    expect(result?.sampleSize).toBe(2)
    expect(result?.averageTokensPerSecond).toBe(20)
  })

  test("is undefined for an empty log", () => {
    expect(summarize([], 1)).toBeUndefined()
  })
})


// ---- redesign: sparkline, colour rule, live rate, burst filter, dialog rows, Italian numbers --------

let counter = 0
const meas = (overrides: Partial<ThroughputMeasurement> = {}): ThroughputMeasurement => ({
  timestamp: 1_000,
  sessionID: "ses_1",
  messageID: `msg_${++counter}`,
  providerID: "claude-agent",
  modelID: "opus",
  outputTokens: 100,
  timeToFirstTokenMs: 2_000,
  generationMs: 1_000,
  tokensPerSecond: 100,
  ...overrides,
})
const withRate = (rate: number, overrides: Partial<ThroughputMeasurement> = {}) => meas({ tokensPerSecond: rate, ...overrides })

describe("sparkline", () => {
  test("maps the lowest value to the lowest block and the highest to the full block", () => {
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe("▁▂▃▄▅▆▇█")
  })
  test("draws a flat series as a calm middle line", () => {
    expect(sparkline([40, 40, 40])).toBe("▄▄▄")
  })
  test("is empty for no values", () => {
    expect(sparkline([])).toBe("")
  })
  test("keeps only the last cells and scales on those", () => {
    expect(sparkline([1, 100, 1, 2, 3], 3)).toBe("▁▅█")
  })
  test("drops values that are not numbers", () => {
    expect(sparkline([1, Number.NaN, 8])).toBe("▁█")
  })
})

describe("median", () => {
  test("takes the middle of an odd list", () => {
    expect(median([5, 1, 3])).toBe(3)
  })
  test("averages the two middle values of an even list", () => {
    expect(median([1, 2, 3, 10])).toBe(2.5)
  })
  test("is undefined for an empty list", () => {
    expect(median([])).toBeUndefined()
  })
  test("does not reorder the list it is given", () => {
    const values = [3, 1, 2]
    median(values)
    expect(values).toEqual([3, 1, 2])
  })
})

describe("isUsableMeasurement", () => {
  test("rejects a burst shorter than 250 ms", () => {
    expect(isUsableMeasurement(meas({ generationMs: 249 }))).toBe(false)
  })
  test("accepts exactly 250 ms", () => {
    expect(isUsableMeasurement(meas({ generationMs: 250 }))).toBe(true)
  })
  test("rejects a rate that is not a positive number", () => {
    expect(isUsableMeasurement(meas({ tokensPerSecond: Number.NaN }))).toBe(false)
    expect(isUsableMeasurement(meas({ tokensPerSecond: 0 }))).toBe(false)
  })
})

describe("speedTone", () => {
  const steady = [100, 100, 100, 100, 100]
  test("is slow below 60% of the model's own median", () => {
    expect(speedTone(59, steady)).toBe("slow")
  })
  test("is normal at exactly 60%", () => {
    expect(speedTone(60, steady)).toBe("normal")
  })
  test("is normal at the median", () => {
    expect(speedTone(100, steady)).toBe("normal")
  })
  test("stays normal while there are fewer than 5 earlier replies to compare with", () => {
    expect(speedTone(1, [100, 100, 100, 100])).toBe("normal")
  })
  test("uses the median, not the mean: one huge outlier does not make a normal reply look slow", () => {
    expect(speedTone(100, [100, 100, 100, 1, 1_000])).toBe("normal")
  })
  test("uses the median, not the mean: one tiny outlier does not hide a slow reply", () => {
    expect(speedTone(59, [100, 100, 100, 100, 1_000_000])).toBe("slow")
  })
})

describe("Italian number format", () => {
  test("uses a decimal comma", () => {
    expect(formatNumberIt(9.94, 1)).toBe("9,9")
  })
  test("rounds to whole numbers when asked for none", () => {
    expect(formatNumberIt(42.4, 0)).toBe("42")
  })
  test.each([
    [42.4, "42 tok/s"],
    [10, "10 tok/s"],
    [9.94, "9,9 tok/s"],
    [9.96, "10 tok/s"],
    [0.55, "0,6 tok/s"],
  ])("formatRateIt(%p) is %p", (value, expected) => {
    expect(formatRateIt(value)).toBe(expected)
  })
  test("formatRateIt gives nothing for an unusable rate", () => {
    expect(formatRateIt(0)).toBeUndefined()
    expect(formatRateIt(Number.NaN)).toBeUndefined()
  })
  test.each([
    [2_200, "2,2 s"],
    [9_960, "10 s"],
    [12_400, "12 s"],
    [65_000, "1 min 5 s"],
    [119_700, "2 min"],
  ])("formatSecondsIt(%p) is %p", (value, expected) => {
    expect(formatSecondsIt(value)).toBe(expected)
  })
  test("formatSecondsIt gives nothing for a negative or missing time", () => {
    expect(formatSecondsIt(-1)).toBeUndefined()
    expect(formatSecondsIt(Number.NaN)).toBeUndefined()
  })
})

describe("createLiveRate", () => {
  const delta = (live: ReturnType<typeof createLiveRate>, at: number, chars = 40, messageID = "msg_a", sessionID = "ses_a") =>
    live.delta({ sessionID, messageID, chars, at })

  test("gives nothing until 250 ms of streaming have passed", () => {
    const live = createLiveRate()
    expect(delta(live, 1_000)).toBeUndefined()
    expect(delta(live, 1_200)).toBeUndefined()
  })
  test("estimates tokens as 4 characters each: 120 characters in 250 ms is 120 tok/s", () => {
    const live = createLiveRate()
    delta(live, 1_000)
    delta(live, 1_100)
    expect(delta(live, 1_250)).toEqual({ rate: 120, frame: 0 })
  })
  test("updates at most every 500 ms", () => {
    const live = createLiveRate()
    delta(live, 1_000)
    delta(live, 1_100)
    delta(live, 1_250)
    expect(delta(live, 1_500)).toBeUndefined()
    expect(delta(live, 1_749)).toBeUndefined()
    expect(delta(live, 1_750)).toBeDefined()
  })
  test("counts the characters of the skipped chunks too", () => {
    const live = createLiveRate()
    for (const at of [1_000, 1_100, 1_250, 1_500, 1_749]) delta(live, at)
    expect(delta(live, 1_750)).toEqual({ rate: 80, frame: 1 })
  })
  test("keeps replies apart: one reply's update does not throttle another", () => {
    const live = createLiveRate()
    delta(live, 1_000)
    delta(live, 1_250)
    delta(live, 1_000, 40, "msg_b", "ses_b")
    expect(delta(live, 1_250, 40, "msg_b", "ses_b")).toBeDefined()
  })
  test("starts fresh after a reply ends", () => {
    const live = createLiveRate()
    delta(live, 1_000)
    delta(live, 1_300)
    live.end({ sessionID: "ses_a", messageID: "msg_a" })
    expect(delta(live, 1_900)).toBeUndefined()
  })
  test("endSession drops every reply of that session and starts them fresh", () => {
    const live = createLiveRate()
    delta(live, 1_000, 40, "msg_a")
    delta(live, 1_300, 40, "msg_a")
    delta(live, 1_000, 40, "msg_b")
    delta(live, 1_300, 40, "msg_b")
    live.endSession("ses_a")
    expect(delta(live, 1_900, 40, "msg_a")).toBeUndefined()
    expect(delta(live, 1_900, 40, "msg_b")).toBeUndefined()
  })
  test("endSession leaves the replies of other sessions alone", () => {
    const live = createLiveRate()
    delta(live, 1_000, 40, "msg_a", "ses_a")
    delta(live, 1_000, 40, "msg_b", "ses_b")
    live.endSession("ses_a")
    expect(delta(live, 1_300, 40, "msg_b", "ses_b")).toBeDefined()
  })
  test("endSession does not touch a session whose id only starts the same", () => {
    const live = createLiveRate()
    delta(live, 1_000, 40, "msg_a", "ses_a")
    delta(live, 1_000, 40, "msg_a", "ses_ab")
    live.endSession("ses_a")
    expect(delta(live, 1_300, 40, "msg_a", "ses_ab")).toBeDefined()
  })
  test("ignores an empty chunk when starting the clock", () => {
    const live = createLiveRate()
    delta(live, 1_000, 0)
    expect(delta(live, 1_300)).toBeUndefined()
  })
})

describe("spinnerFrame", () => {
  test.each([
    [0, "▘"],
    [1, "▝"],
    [2, "▗"],
    [3, "▖"],
    [4, "▘"],
    [-1, "▖"],
  ])("frame %p is %p", (n, expected) => {
    expect(spinnerFrame(n)).toBe(expected)
  })
  // SF Mono and Menlo have the quadrant blocks (U+2596 to U+259F); they have no braille.
  test("every frame is one quadrant block, a character the common terminal fonts have", () => {
    const frames = [0, 1, 2, 3].map(spinnerFrame)
    expect(frames.every((frame) => frame.length === 1 && frame >= "\u2596" && frame <= "\u259f")).toBe(true)
  })
})

describe("modelLabel", () => {
  test.each([
    ["opus", "Opus"],
    ["claude-opus-4-5", "Opus"],
    ["SONNET", "Sonnet"],
    ["claude-haiku-5-5", "Haiku"],
    ["claude-fable-5-2", "Fable"],
    ["gpt-5.6-luna", "gpt-5.6-luna"],
    ["openrouter/anthropic/x-model", "x-model"],
    ["deepseek-v4-flash-free-extended", "deepseek-v4-fla…"],
    ["", "modello"],
  ])("%p is shown as %p", (id, expected) => {
    expect(modelLabel(id)).toBe(expected)
  })
})

describe("parseLogText", () => {
  const line = (id: string) => JSON.stringify(meas({ messageID: id }))
  test("reads one measurement per line", () => {
    expect(parseLogText(`${line("a")}\n${line("b")}\n`, false).map((x) => x.messageID)).toEqual(["a", "b"])
  })
  test("drops the first line when the text starts in the middle of the file, even if it parses", () => {
    expect(parseLogText(`${line("a")}\n${line("b")}\n`, true).map((x) => x.messageID)).toEqual(["b"])
  })
  test("keeps the first line when the text starts at the beginning", () => {
    expect(parseLogText(`${line("a")}\n`, false)).toHaveLength(1)
  })
  test("skips lines that are not JSON", () => {
    expect(parseLogText(`nope\n${line("b")}\n`, false)).toHaveLength(1)
  })
  test("skips lines with missing or wrong fields", () => {
    const bad = JSON.stringify({ ...meas({ messageID: "x" }), tokensPerSecond: "fast" })
    expect(parseLogText(`${bad}\n`, false)).toEqual([])
  })
})

describe("startOfLocalDay", () => {
  // bun test runs in UTC, which would hide a UTC/local mix-up: use a zone far from it.
  const inZone = (zone: string, run: () => void) => {
    const before = process.env.TZ
    process.env.TZ = zone
    try {
      run()
    } finally {
      process.env.TZ = before ?? "UTC"
    }
  }
  test("is local midnight in Rome", () => {
    inZone("Europe/Rome", () => {
      expect(startOfLocalDay(new Date(2026, 10, 10, 15, 30).getTime())).toBe(new Date(2026, 10, 10).getTime())
    })
  })
  test("is local midnight in Auckland, where the local date runs ahead of UTC", () => {
    inZone("Pacific/Auckland", () => {
      expect(startOfLocalDay(new Date(2026, 10, 10, 1, 30).getTime())).toBe(new Date(2026, 10, 10).getTime())
    })
  })
})

describe("dedupeMeasurements", () => {
  test("keeps the first of a message logged twice and the order", () => {
    const a = meas({ messageID: "dup" })
    const b = meas()
    expect(dedupeMeasurements([a, b, { ...a }])).toEqual([a, b])
  })
  test("tells apart the same message id in two sessions", () => {
    expect(dedupeMeasurements([meas({ messageID: "same", sessionID: "x" }), meas({ messageID: "same", sessionID: "y" })])).toHaveLength(2)
  })
})

describe("buildFooterView", () => {
  const none: ThroughputMeasurement[] = []
  test("shows nothing before the first measurement", () => {
    expect(buildFooterView({ recent: none, seed: none, viewedSessionID: "ses_1" })).toBeUndefined()
  })
  test("draws the sparkline of the viewed session and the last rate", () => {
    const recent = [withRate(50), withRate(60), withRate(70)]
    expect(buildFooterView({ recent, seed: none, viewedSessionID: "ses_1" })).toEqual({
      lead: "▁▅█",
      rateText: "70 tok/s",
      tone: "normal",
      live: false,
    })
  })
  test("uses the viewed session even when another one replied later", () => {
    const recent = [withRate(30, { sessionID: "ses_a" }), withRate(90, { sessionID: "ses_b" })]
    expect(buildFooterView({ recent, seed: none, viewedSessionID: "ses_a" })?.rateText).toBe("30 tok/s")
  })
  test("falls back to the latest replies anywhere when the viewed session has none", () => {
    const recent = [withRate(30, { sessionID: "ses_a" }), withRate(90, { sessionID: "ses_b" })]
    expect(buildFooterView({ recent, seed: none, viewedSessionID: "ses_x" })?.rateText).toBe("90 tok/s")
  })
  test("falls back to the latest replies anywhere when no session is open", () => {
    expect(buildFooterView({ recent: [withRate(44)], seed: none, viewedSessionID: undefined })?.rateText).toBe("44 tok/s")
  })
  test("draws at most the last 6 replies", () => {
    const recent = [1, 2, 3, 4, 5, 6, 7, 8].map((rate) => withRate(rate * 10))
    expect(buildFooterView({ recent, seed: none, viewedSessionID: "ses_1" })?.lead).toHaveLength(6)
  })
  test("leaves out a burst shorter than 250 ms", () => {
    const recent = [withRate(50), withRate(5_000, { generationMs: 100 })]
    expect(buildFooterView({ recent, seed: none, viewedSessionID: "ses_1" })?.rateText).toBe("50 tok/s")
  })
  test("shows nothing when the only measurement is a burst", () => {
    expect(buildFooterView({ recent: [withRate(5_000, { generationMs: 100 })], seed: none, viewedSessionID: "ses_1" })).toBeUndefined()
  })
  test("marks a reply under 60% of the model's median from the log as slow", () => {
    const seed = [100, 100, 100, 100, 100].map((rate) => withRate(rate))
    expect(buildFooterView({ recent: [withRate(59)], seed, viewedSessionID: "ses_1" })?.tone).toBe("slow")
  })
  test("keeps a reply at 60% normal", () => {
    const seed = [100, 100, 100, 100, 100].map((rate) => withRate(rate))
    expect(buildFooterView({ recent: [withRate(60)], seed, viewedSessionID: "ses_1" })?.tone).toBe("normal")
  })
  test("compares with the same model only", () => {
    const seed = [100, 100, 100, 100, 100].map((rate) => withRate(rate, { modelID: "haiku" }))
    expect(buildFooterView({ recent: [withRate(10, { modelID: "opus" })], seed, viewedSessionID: "ses_1" })?.tone).toBe("normal")
  })
  test("does not count the reply itself in its own median", () => {
    const last = withRate(10)
    const recent = [100, 100, 100, 100, last.tokensPerSecond].map((rate, index) => (index === 4 ? last : withRate(rate)))
    expect(buildFooterView({ recent, seed: none, viewedSessionID: "ses_1" })?.tone).toBe("normal")
  })
  test("takes the median from this run's replies too, not only the log", () => {
    const recent = [100, 100, 100, 100, 100, 59].map((rate) => withRate(rate))
    expect(buildFooterView({ recent, seed: none, viewedSessionID: "ses_1" })?.tone).toBe("slow")
  })
  test("bursts do not raise the median the reply is compared with", () => {
    const seed = [
      ...[100, 100, 100, 100, 100].map((rate) => withRate(rate)),
      ...[5_000, 5_000, 5_000, 5_000, 5_000].map((rate) => withRate(rate, { generationMs: 100 })),
    ]
    expect(buildFooterView({ recent: [withRate(60)], seed, viewedSessionID: "ses_1" })?.tone).toBe("normal")
  })
  test("counts a reply twice in memory once", () => {
    const one = withRate(70)
    expect(buildFooterView({ recent: [one, { ...one }], seed: none, viewedSessionID: "ses_1" })?.lead).toHaveLength(1)
  })
  test("counts a seeded reply that is also in memory once", () => {
    const shared = [100, 100, 100, 100].map((rate) => withRate(rate))
    const last = withRate(10)
    expect(buildFooterView({ recent: [...shared, last], seed: [...shared, last], viewedSessionID: "ses_1" })?.tone).toBe("normal")
  })
  test("while streaming, swaps the sparkline for the spinner and shows the live rate", () => {
    const recent = [withRate(50), withRate(60)]
    expect(buildFooterView({ recent, seed: none, viewedSessionID: "ses_1", live: { rate: 33.3, frame: 2 } })).toEqual({
      lead: "▗",
      rateText: "33 tok/s",
      tone: "normal",
      live: true,
    })
  })
  test("the live rate is never coloured as slow", () => {
    const seed = [100, 100, 100, 100, 100].map((rate) => withRate(rate))
    expect(buildFooterView({ recent: [withRate(100)], seed, viewedSessionID: "ses_1", live: { rate: 5, frame: 0 } })?.tone).toBe("normal")
  })
  test("while streaming with no earlier reply, still shows the live rate", () => {
    expect(buildFooterView({ recent: none, seed: none, viewedSessionID: "ses_1", live: { rate: 20, frame: 0 } })?.live).toBe(true)
  })
  test("a live sample without a usable rate falls back to the settled view", () => {
    expect(buildFooterView({ recent: [withRate(50)], seed: none, viewedSessionID: "ses_1", live: { rate: 0, frame: 0 } })?.live).toBe(false)
  })
})

describe("buildSpeedDialog", () => {
  const now = new Date(2026, 10, 10, 15, 0).getTime()
  const today = new Date(2026, 10, 10, 9, 0).getTime()
  const yesterday = new Date(2026, 10, 9, 23, 0).getTime()
  const at = (hours: number) => new Date(2026, 10, 10, hours, 0).getTime()
  const build = (measurements: ThroughputMeasurement[], sessionID?: string) => buildSpeedDialog({ measurements, sessionID, now })

  test("has nothing to show for an empty log", () => {
    expect(build([])).toEqual({ models: [], hiddenModels: 0, session: [] })
  })
  test("counts today's replies only", () => {
    const rows = build([withRate(50, { timestamp: yesterday }), withRate(60, { timestamp: today })]).models
    expect(rows[0]?.replies).toBe(1)
  })
  test("takes the median rate of today's replies", () => {
    const rows = build([10, 90, 30].map((rate, i) => withRate(rate, { timestamp: at(8 + i) }))).models
    expect(rows[0]?.medianRate).toBe(30)
  })
  test("takes the median wait for the first token", () => {
    const rows = build([1_000, 5_000, 2_000].map((wait, i) => meas({ timestamp: at(8 + i), timeToFirstTokenMs: wait }))).models
    expect(rows[0]?.medianWaitMs).toBe(2_000)
  })
  test("merges the same Claude family from different ids under one label", () => {
    const rows = build([meas({ timestamp: today, modelID: "opus" }), meas({ timestamp: today, modelID: "claude-opus-4-5" })]).models
    expect(rows.map((row) => [row.label, row.replies])).toEqual([["Opus", 2]])
  })
  test("keeps other models apart by their own id", () => {
    const rows = build([meas({ timestamp: today, modelID: "gpt-a" }), meas({ timestamp: today, modelID: "gpt-b" })]).models
    expect(rows.map((row) => row.label).sort()).toEqual(["gpt-a", "gpt-b"])
  })
  test("lists Opus, Sonnet, Haiku, Fable first and the rest by number of replies", () => {
    const one = (modelID: string) => meas({ timestamp: today, modelID })
    const rows = build([one("fable"), one("haiku"), one("other"), one("zeta"), one("zeta"), one("sonnet"), one("opus")]).models
    expect(rows.map((row) => row.label)).toEqual(["Opus", "Sonnet", "Haiku", "Fable", "zeta"])
  })
  test("breaks a tie between other models by name", () => {
    const one = (modelID: string) => meas({ timestamp: today, modelID })
    const rows = build([one("beta"), one("alpha")]).models
    expect(rows.map((row) => row.label)).toEqual(["alpha", "beta"])
  })
  test("draws a sparkline of at most the last 20 replies of the model", () => {
    const rows = build(Array.from({ length: 25 }, (_, i) => withRate(10 + i, { timestamp: at(1) + i }))).models
    expect(rows[0]?.spark).toHaveLength(20)
  })
  test("orders the sparkline by time even if the log lines are out of order", () => {
    const rows = build([withRate(80, { timestamp: at(10) }), withRate(10, { timestamp: at(9) })]).models
    expect(rows[0]?.spark).toBe("▁█")
  })
  test("leaves out bursts from the count", () => {
    const rows = build([withRate(50, { timestamp: today }), withRate(5_000, { timestamp: today, generationMs: 100 })]).models
    expect(rows[0]?.replies).toBe(1)
  })
  test("counts a reply logged twice once", () => {
    const one = meas({ timestamp: today })
    expect(build([one, { ...one }]).models[0]?.replies).toBe(1)
  })
  test("shows 5 models at most and says how many are left out", () => {
    const rows = build(["a", "b", "c", "d", "e", "f", "g"].map((id) => meas({ timestamp: today, modelID: id })))
    expect([rows.models.length, rows.hiddenModels]).toEqual([5, 2])
  })
  test("lists the last 5 replies of the session, newest first", () => {
    const measurements = Array.from({ length: 7 }, (_, i) => withRate(10 + i, { timestamp: at(1 + i), messageID: `m${i}` }))
    expect(build(measurements, "ses_1").session.map((row) => row.rate)).toEqual([16, 15, 14, 13, 12])
  })
  test("takes the session's replies from any day", () => {
    expect(build([withRate(40, { timestamp: yesterday })], "ses_1").session).toHaveLength(1)
  })
  test("leaves other sessions out of the session list", () => {
    expect(build([withRate(40, { timestamp: today, sessionID: "ses_other" })], "ses_1").session).toEqual([])
  })
  test("without a session id, uses the session of the latest reply", () => {
    const rows = build([withRate(40, { timestamp: at(8), sessionID: "old" }), withRate(70, { timestamp: at(9), sessionID: "new" })])
    expect(rows.session.map((row) => row.rate)).toEqual([70])
  })
  test("flags a session reply under 60% of the model's earlier median as slow", () => {
    const history = [100, 100, 100, 100, 100].map((rate, i) => withRate(rate, { timestamp: at(1 + i), sessionID: "other" }))
    const rows = build([...history, withRate(59, { timestamp: at(8) })], "ses_1").session
    expect(rows[0]?.slow).toBe(true)
  })
  test("does not flag a normal session reply", () => {
    const history = [100, 100, 100, 100, 100].map((rate, i) => withRate(rate, { timestamp: at(1 + i), sessionID: "other" }))
    const rows = build([...history, withRate(80, { timestamp: at(8) })], "ses_1").session
    expect(rows[0]?.slow).toBe(false)
  })
  test("carries the label, tokens and writing time of a session reply", () => {
    const row = build([meas({ timestamp: today, modelID: "claude-sonnet-5-5", outputTokens: 580, generationMs: 4_700, tokensPerSecond: 123 })], "ses_1").session[0]
    expect([row?.label, row?.outputTokens, row?.generationMs]).toEqual(["Sonnet", 580, 4_700])
  })
})

describe("formatModelDetail", () => {
  const row = { label: "Opus", medianRate: 100, medianWaitMs: 2_200, replies: 12, spark: "", rates: [] as number[] }
  test("says when the first word comes and how many replies", () => {
    expect(formatModelDetail(row)).toBe("prima parola dopo 2,2 s, 12 risposte")
  })
  test("uses the singular for one reply", () => {
    expect(formatModelDetail({ ...row, replies: 1 })).toBe("prima parola dopo 2,2 s, 1 risposta")
  })
})

describe("padColumns", () => {
  test("pads every column to its widest cell, left or right", () => {
    expect(padColumns([["a", "1"], ["bbb", "22"]], ["left", "right"])).toEqual([["a  ", " 1"], ["bbb", "22"]])
  })
  test("does not pad the last left-aligned column", () => {
    expect(padColumns([["a", "x"], ["bb", "yyy"]], ["left", "left"])).toEqual([["a ", "x"], ["bb", "yyy"]])
  })
})


// ---- responsive width: footer steps, room, resize bursts, dialog columns ----------------------------

describe("footerWidth", () => {
  const view = { lead: "▂▃▅▇▆", rateText: "42 tok/s", tone: "normal" as const, live: false }
  test("the full footer is 2 cells of padding, the sparkline, a space and the rate", () => {
    expect(footerWidth(view, "full")).toBe(16)
  })
  test("the rate-only footer is 2 cells of padding and the rate", () => {
    expect(footerWidth(view, "rate")).toBe(10)
  })
  test("follows the length of the lead: a one-cell spinner makes it shorter", () => {
    expect(footerWidth({ ...view, lead: "▗" }, "full")).toBe(12)
  })
  test("follows the length of the rate text", () => {
    expect(footerWidth({ ...view, rateText: "126 tok/s" }, "rate")).toBe(11)
  })
})

describe("fitFooter", () => {
  const view = { lead: "▂▃▅▇▆", rateText: "42 tok/s", tone: "slow" as const, live: true }
  test("keeps the sparkline and the rate when the room is exactly the full width", () => {
    expect(fitFooter(view, 16)).toEqual(view)
  })
  test("drops the sparkline, keeps the rate, one cell below the full width", () => {
    expect(fitFooter(view, 15)).toEqual({ ...view, lead: "" })
  })
  test("keeps the rate alone when the room is exactly the rate-only width", () => {
    expect(fitFooter(view, 10)).toEqual({ ...view, lead: "" })
  })
  test("shows nothing one cell below the rate-only width", () => {
    expect(fitFooter(view, 9)).toBeUndefined()
  })
  test("shows nothing with no room at all", () => {
    expect(fitFooter(view, 0)).toBeUndefined()
  })
  test("shows nothing when there is no view", () => {
    expect(fitFooter(undefined, 100)).toBeUndefined()
  })
  test("a view that has no lead needs no room for one", () => {
    expect(fitFooter({ ...view, lead: "" }, 10)).toEqual({ ...view, lead: "" })
  })
  test("a view that has no lead still needs room for its rate", () => {
    expect(fitFooter({ ...view, lead: "" }, 9)).toBeUndefined()
  })
})

describe("footerRoom", () => {
  test("is what the row has left after the siblings, one gap of 2 for each and a spare cell", () => {
    expect(footerRoom({ rowWidth: 94, siblingWidths: [17, 22, 16, 15] })).toBe(15)
  })
  test("does not count a sibling that takes no space, nor a gap for it", () => {
    expect(footerRoom({ rowWidth: 94, siblingWidths: [17, 0, 22, 16, 15] })).toBe(15)
  })
  test("is never negative", () => {
    expect(footerRoom({ rowWidth: 20, siblingWidths: [17, 22] })).toBe(0)
  })
  test("grows with the row", () => {
    expect(footerRoom({ rowWidth: 120, siblingWidths: [17, 22, 16, 15] })).toBe(41)
  })
  test("is all of the row but the spare cell when nothing else is there", () => {
    expect(footerRoom({ rowWidth: 50, siblingWidths: [] })).toBe(49)
  })

  describe("with a flexible item (the working-directory path, which truncates itself)", () => {
    test("counts only the first 12 cells of that item", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [34, 31, 8, 15], flexibleIndex: 0 })).toBe(94 - (12 + 31 + 8 + 15) - 8 - 1)
    })
    test("counts a first item narrower than 12 as it is", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [5, 31, 8, 15], flexibleIndex: 0 })).toBe(94 - (5 + 31 + 8 + 15) - 8 - 1)
    })
    test("counts a first item of exactly 12 as 12", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [12, 31, 8, 15], flexibleIndex: 0 })).toBe(94 - (12 + 31 + 8 + 15) - 8 - 1)
    })
    test("counts a first item of 13 as 12", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [13, 31, 8, 15], flexibleIndex: 0 })).toBe(94 - (12 + 31 + 8 + 15) - 8 - 1)
    })
    test("leaves the other items at their full width", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [34, 40, 8, 15], flexibleIndex: 0 })).toBe(94 - (12 + 40 + 8 + 15) - 8 - 1)
    })
    test("a first item that takes no space is not counted, nor is its gap", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [0, 31, 8, 15], flexibleIndex: 0 })).toBe(94 - (31 + 8 + 15) - 6 - 1)
    })
    test("shortens the item at the given index, not the first", () => {
      expect(footerRoom({ rowWidth: 120, siblingWidths: [34, 31, 30, 15], flexibleIndex: 2 })).toBe(120 - (34 + 31 + 12 + 15) - 8 - 1)
    })
    test("a first item that is not flexible (OpenCode's interrupt hint while a reply streams) counts in full", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [23, 31, 8, 15], flexibleIndex: undefined })).toBe(94 - (23 + 31 + 8 + 15) - 8 - 1)
    })
    test("an index past the items shortens nothing", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [34, 31, 8, 15], flexibleIndex: 9 })).toBe(0)
    })
    test("counts the given floor instead of 12 for a flexible item", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [60, 31, 8, 15], flexibleIndex: 0, flexibleFloor: 23 })).toBe(94 - (23 + 31 + 8 + 15) - 8 - 1)
    })
    test("a floor wider than the item counts the item as it is", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [20, 31, 8, 15], flexibleIndex: 0, flexibleFloor: 23 })).toBe(94 - (20 + 31 + 8 + 15) - 8 - 1)
    })
    test("does not shorten the first item unless asked to", () => {
      expect(footerRoom({ rowWidth: 94, siblingWidths: [34, 31, 8, 15] })).toBe(0)
    })
  })
})

describe("createWidthSettler", () => {
  function setup() {
    const scheduled: { fn: () => void; ms: number; id: number; live: boolean }[] = []
    const settled: number[] = []
    const settler = createWidthSettler({
      delayMs: 60,
      schedule: (fn, ms) => {
        const entry = { fn, ms, id: scheduled.length, live: true }
        scheduled.push(entry)
        return entry.id
      },
      cancel: (id) => {
        scheduled[id as number]!.live = false
      },
      onSettle: (width) => settled.push(width),
    })
    const fire = () => scheduled.filter((entry) => entry.live).forEach((entry) => ((entry.live = false), entry.fn()))
    return { settler, scheduled, settled, fire }
  }

  test("applies the first width at once", () => {
    const { settler, settled } = setup()
    settler.observe(80)
    expect(settled).toEqual([80])
  })
  test("does nothing when the width has not changed", () => {
    const { settler, settled, scheduled } = setup()
    settler.observe(80)
    settler.observe(80)
    expect([settled, scheduled.length]).toEqual([[80], 0])
  })
  test("waits 60 ms before growing", () => {
    const { settler, settled, scheduled } = setup()
    settler.observe(80)
    settler.observe(100)
    expect([settled, scheduled.map((entry) => entry.ms)]).toEqual([[80], [60]])
  })
  test("grows once the wait is over", () => {
    const { settler, settled, fire } = setup()
    settler.observe(80)
    settler.observe(100)
    fire()
    expect(settled).toEqual([80, 100])
  })
  test("a burst of growing widths becomes one timer and the last width", () => {
    const { settler, settled, scheduled, fire } = setup()
    settler.observe(80)
    settler.observe(90)
    settler.observe(95)
    settler.observe(100)
    fire()
    expect([settled, scheduled.length]).toEqual([[80, 100], 1])
  })
  test("shrinks at once, before any timer runs", () => {
    const { settler, settled } = setup()
    settler.observe(80)
    settler.observe(70)
    expect(settled).toEqual([80, 70])
  })
  test("a shrink drops the growth that was waiting", () => {
    const { settler, settled, fire } = setup()
    settler.observe(80)
    settler.observe(100)
    settler.observe(70)
    fire()
    expect(settled).toEqual([80, 70])
  })
  test("a shrink cancels the timer of the growth that was waiting", () => {
    const { settler, scheduled } = setup()
    settler.observe(80)
    settler.observe(100)
    settler.observe(70)
    expect(scheduled[0]?.live).toBe(false)
  })
  test("coming back to the applied width cancels the growth that was waiting", () => {
    const { settler, settled, fire } = setup()
    settler.observe(80)
    settler.observe(100)
    settler.observe(80)
    fire()
    expect(settled).toEqual([80])
  })
  test("after dispose, a waiting growth never lands", () => {
    const { settler, settled, fire } = setup()
    settler.observe(80)
    settler.observe(100)
    settler.dispose()
    fire()
    expect(settled).toEqual([80])
  })
  test("dispose cancels the timer of a waiting growth", () => {
    const { settler, scheduled } = setup()
    settler.observe(80)
    settler.observe(100)
    settler.dispose()
    expect(scheduled[0]?.live).toBe(false)
  })
  test("a timer that fires anyway after dispose is ignored", () => {
    const { settler, settled, scheduled } = setup()
    settler.observe(80)
    settler.observe(100)
    settler.dispose()
    scheduled[0]!.fn()
    expect(settled).toEqual([80])
  })
  test("after dispose, new widths are ignored", () => {
    const { settler, settled } = setup()
    settler.observe(80)
    settler.dispose()
    settler.observe(60)
    expect(settled).toEqual([80])
  })
})

describe("visibleColumns", () => {
  const widths = [6, 9, 10, 8] // label, rate, tokens, time
  const priority = [1, 0, 3, 2] // rate first, then label, time, tokens
  test("keeps every column when they all fit with a gap of 2 between them", () => {
    expect(visibleColumns(widths, priority, 39, 2)).toEqual([true, true, true, true])
  })
  test("drops the least important column first", () => {
    expect(visibleColumns(widths, priority, 38, 2)).toEqual([true, true, false, true])
  })
  test("then the next least important", () => {
    expect(visibleColumns(widths, priority, 20, 2)).toEqual([true, true, false, false])
  })
  test("keeps the rate alone when only it fits", () => {
    expect(visibleColumns(widths, priority, 10, 2)).toEqual([false, true, false, false])
  })
  test("shows no column when not even the most important fits", () => {
    expect(visibleColumns(widths, priority, 8, 2)).toEqual([false, false, false, false])
  })
  test("stops at the first column that does not fit instead of skipping to a smaller one", () => {
    expect(visibleColumns([20, 9, 3], [1, 0, 2], 20, 2)).toEqual([false, true, false])
  })
})

describe("dialogSparkCells", () => {
  test("uses 20 cells when there is room", () => {
    expect(dialogSparkCells(80, 30)).toBe(20)
  })
  test("uses what is left of the width after the fixed part", () => {
    expect(dialogSparkCells(45, 30)).toBe(15)
  })
  test("draws 6 cells at the least", () => {
    expect(dialogSparkCells(36, 30)).toBe(6)
  })
  test("draws nothing rather than a stub of fewer than 6 cells", () => {
    expect(dialogSparkCells(35, 30)).toBe(0)
  })
  test("draws nothing when the width is smaller than the fixed part", () => {
    expect(dialogSparkCells(10, 30)).toBe(0)
  })
})

describe("formatModelDetail with a room", () => {
  const row = { label: "Opus", medianRate: 100, medianWaitMs: 2_200, replies: 12, spark: "", rates: [] as number[] }
  test("is the full sentence when the room is exactly its length", () => {
    expect(formatModelDetail(row, 36)).toBe("prima parola dopo 2,2 s, 12 risposte")
  })
  test("is the shorter wording one cell below that", () => {
    expect(formatModelDetail(row, 35)).toBe("attesa 2,2 s, 12 risposte")
  })
  test("keeps the shorter wording at exactly its length", () => {
    expect(formatModelDetail(row, 25)).toBe("attesa 2,2 s, 12 risposte")
  })
  test("is only the number of replies below that", () => {
    expect(formatModelDetail(row, 24)).toBe("12 risposte")
  })
  test("uses the singular in the short wordings too", () => {
    expect(formatModelDetail({ ...row, replies: 1 }, 23)).toBe("1 risposta")
  })
  test("is empty when even the replies do not fit", () => {
    expect(formatModelDetail(row, 10)).toBe("")
  })
})

describe("buildSpeedDialog rates", () => {
  const now = new Date(2026, 10, 10, 15, 0).getTime()
  const at = (hours: number) => new Date(2026, 10, 10, hours, 0).getTime()
  test("hands the UI the model's last 20 rates in time order, to draw as many cells as fit", () => {
    const measurements = Array.from({ length: 25 }, (_, i) => withRate(10 + i, { timestamp: at(1) + i * 1_000 }))
    const rates = buildSpeedDialog({ measurements: measurements.reverse(), sessionID: undefined, now }).models[0]?.rates
    expect(rates).toEqual(Array.from({ length: 20 }, (_, i) => 15 + i))
  })
})

describe("fitText", () => {
  const options = ["Questa sessione, ultime risposte", "Questa sessione", "Sessione"]
  test("is the first wording when its length is exactly the room", () => {
    expect(fitText(options, 32)).toBe("Questa sessione, ultime risposte")
  })
  test("is the next wording one cell below that", () => {
    expect(fitText(options, 31)).toBe("Questa sessione")
  })
  test("keeps the second wording at exactly its length", () => {
    expect(fitText(options, 15)).toBe("Questa sessione")
  })
  test("is the last wording at exactly its length", () => {
    expect(fitText(options, 14)).toBe("Sessione")
  })
  test("is empty when not even the last wording fits, rather than a word cut in two", () => {
    expect(fitText(options, 7)).toBe("")
  })
  test("is empty with no wordings", () => {
    expect(fitText([], 40)).toBe("")
  })
  test("takes the first wording that fits even if a later one is longer", () => {
    expect(fitText(["abcdef", "abc", "abcd"], 4)).toBe("abc")
  })
})

describe("contentWidth", () => {
  const box = (x: number, width: number, children: { x: number; width: number; children: any[] }[] = []) => ({ x, width, children })
  test("is the width of a box with nothing inside", () => {
    expect(contentWidth(box(2, 40))).toBe(40)
  })
  test("ignores the width a container was stretched to and counts what is inside it", () => {
    // OpenCode's \"esc interrupt\" item: stretched to 94 cells, a spinner of 8 and a text of 13 inside
    expect(contentWidth(box(2, 94, [box(3, 8), box(12, 13)]))).toBe(23)
  })
  test("looks through nested containers", () => {
    expect(contentWidth(box(2, 94, [box(2, 94, [box(3, 8), box(12, 13)])]))).toBe(23)
  })
  test("takes the right-most edge, not the last child", () => {
    expect(contentWidth(box(0, 50, [box(10, 20), box(0, 5)]))).toBe(30)
  })
  test("counts from the container's own start", () => {
    expect(contentWidth(box(10, 50, [box(12, 4)]))).toBe(6)
  })
  test("is never negative", () => {
    expect(contentWidth(box(10, 50, [box(2, 3)]))).toBe(0)
  })
})
