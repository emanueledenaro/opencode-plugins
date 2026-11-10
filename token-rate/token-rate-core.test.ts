import { describe, expect, test } from "bun:test"
import { createRateTracker, createThroughputCollector, formatRate, pickRate, summarize } from "./token-rate-core"

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
