export type ThroughputMeasurement = {
  timestamp: number
  sessionID: string
  messageID: string
  providerID: string
  modelID: string
  outputTokens: number
  timeToFirstTokenMs: number
  generationMs: number
  tokensPerSecond: number
}

type TextDelta = {
  sessionID: string
  messageID: string
  partID: string
  delta: string
  at: number
}

type CompletedMessage = {
  sessionID: string
  messageID: string
  createdAt: number
  outputTokens: number
  providerID: string
  modelID: string
}

export function createThroughputCollector() {
  const messages = new Map<string, { parts: Set<string>; firstDeltaAt?: number; lastDeltaAt?: number }>()

  function recordTextDelta(input: TextDelta) {
    if (!input.delta) return

    const key = `${input.sessionID}:${input.messageID}`
    const message = messages.get(key) ?? { parts: new Set<string>() }
    message.parts.add(input.partID)
    message.firstDeltaAt ??= input.at
    message.lastDeltaAt = input.at
    messages.set(key, message)
  }

  function completeMessage(input: CompletedMessage): ThroughputMeasurement | undefined {
    const key = `${input.sessionID}:${input.messageID}`
    const message = messages.get(key)
    messages.delete(key)

    if (!message || message.parts.size !== 1 || !message.firstDeltaAt || !message.lastDeltaAt || input.outputTokens <= 0) return

    const generationMs = message.lastDeltaAt - message.firstDeltaAt
    if (generationMs <= 0) return

    return {
      timestamp: message.lastDeltaAt,
      sessionID: input.sessionID,
      messageID: input.messageID,
      providerID: input.providerID,
      modelID: input.modelID,
      outputTokens: input.outputTokens,
      timeToFirstTokenMs: message.firstDeltaAt - input.createdAt,
      generationMs,
      tokensPerSecond: (input.outputTokens * 1_000) / generationMs,
    }
  }

  return { recordTextDelta, completeMessage }
}

// ---- V2 additions -----------------------------------------------------------------------------
// OpenCode 2 reports a reply as events: session.step.started, session.text.delta (one per streamed
// chunk), session.step.ended (with the token counts). The collector above is unchanged; this tracker
// feeds it from those events.

type StepStart = { sessionID: string; messageID: string; startedAt: number; providerID: string; modelID: string }

export function createRateTracker() {
  const collector = createThroughputCollector()
  const steps = new Map<string, StepStart>()
  const key = (sessionID: string, messageID: string) => `${sessionID}:${messageID}`

  return {
    stepStarted(input: StepStart) {
      steps.set(key(input.sessionID, input.messageID), input)
    },
    textDelta(input: { sessionID: string; messageID: string; ordinal: number; at: number }) {
      collector.recordTextDelta({
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: String(input.ordinal),
        delta: "x", // the collector only needs to know a chunk arrived
        at: input.at,
      })
    },
    stepEnded(input: { sessionID: string; messageID: string; outputTokens: number }): ThroughputMeasurement | undefined {
      const k = key(input.sessionID, input.messageID)
      const step = steps.get(k)
      steps.delete(k)
      const measurement = collector.completeMessage({
        sessionID: input.sessionID,
        messageID: input.messageID,
        createdAt: step?.startedAt ?? 0,
        outputTokens: input.outputTokens,
        providerID: step?.providerID ?? "",
        modelID: step?.modelID ?? "",
      })
      return step ? measurement : undefined
    },
    stepFailed(input: { sessionID: string; messageID: string }) {
      steps.delete(key(input.sessionID, input.messageID))
      // completing with no tokens drops the collected deltas without producing a measurement
      collector.completeMessage({
        sessionID: input.sessionID,
        messageID: input.messageID,
        createdAt: 0,
        outputTokens: 0,
        providerID: "",
        modelID: "",
      })
    },
  }
}

/** "42 tok/s" from 10 up, "9.9 tok/s" below; undefined when the value is not a usable rate. */
export function formatRate(tokensPerSecond: number): string | undefined {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return undefined
  return tokensPerSecond >= 10 ? `${Math.round(tokensPerSecond)} tok/s` : `${tokensPerSecond.toFixed(1)} tok/s`
}

/** The rate of the session being looked at, else the latest measured anywhere. */
export function pickRate(
  bySession: Record<string, number>,
  viewedSessionID: string | undefined,
  latest: number | undefined,
): number | undefined {
  if (viewedSessionID !== undefined && bySession[viewedSessionID] !== undefined) return bySession[viewedSessionID]
  return latest
}

/** Summary of the last `count` measurements in the log; a message logged twice counts once. */
export function summarize(measurements: ThroughputMeasurement[], count: number) {
  const seen = new Set<string>()
  const unique = measurements.filter((measurement) => {
    const id = `${measurement.sessionID}:${measurement.messageID}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  const recent = unique.slice(-count)
  if (!recent.length) return undefined
  const rates = recent.map((measurement) => measurement.tokensPerSecond)
  return {
    latest: recent.at(-1)!,
    sampleSize: recent.length,
    averageTokensPerSecond: rates.reduce((total, rate) => total + rate, 0) / rates.length,
    minimumTokensPerSecond: Math.min(...rates),
    maximumTokensPerSecond: Math.max(...rates),
  }
}
