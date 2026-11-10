// TUI part of the token-rate plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Measures how fast the model streams a reply (output tokens divided by the time between the first and
// the last streamed text chunk), shows the last one under the prompt as "42 tok/s", and appends every
// measurement to a jsonl log. The measuring is in ./token-rate-core.ts (tested), see ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, Show, createSignal } from "solid-js"
import { mkdir, open } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRateTracker, formatRate, pickRate, type ThroughputMeasurement } from "./token-rate-core.ts"

function logPath(): string {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", "token-rate.jsonl")
}

export default Plugin.define({
  id: "local.token-rate",
  async setup(context) {
    if (process.env.TOKEN_RATE_DISABLED === "1") return

    const theme = context.theme
    const tracker = createRateTracker()
    const logging = process.env.TOKEN_RATE_LOG !== "off"
    const [bySession, setBySession] = createSignal<Record<string, number>>({})
    const [latest, setLatest] = createSignal<number | undefined>(undefined)

    const record = (measurement: ThroughputMeasurement) => {
      setBySession((current) => ({ ...current, [measurement.sessionID]: measurement.tokensPerSecond }))
      setLatest(measurement.tokensPerSecond)
      if (!logging) return
      const file = logPath()
      const line = `${JSON.stringify(measurement)}\n`
      void mkdir(join(file, ".."), { recursive: true, mode: 0o700 })
        .then(async () => {
          // O_NOFOLLOW: a symlink in place of the log is refused. chmod fixes an older 0644 file.
          const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
          const handle = await open(file, flags, 0o600)
          try {
            await handle.chmod(0o600)
            await handle.appendFile(line)
          } finally {
            await handle.close()
          }
        })
        .catch(() => {
          // the log is a bonus; the footer still works without it
        })
    }

    type Event<T> = { data: T; created?: number }
    const at = (event: { created?: number }) => (typeof event.created === "number" ? event.created : Date.now())

    const stops = [
      context.data.on("session.step.started", (event: Event<any>) => {
        tracker.stepStarted({
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          startedAt: typeof event.data.started === "number" ? event.data.started : at(event),
          providerID: String(event.data.model?.providerID ?? ""),
          modelID: String(event.data.model?.id ?? ""),
        })
      }),
      context.data.on("session.text.delta", (event: Event<any>) => {
        tracker.textDelta({
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          ordinal: Number(event.data.ordinal ?? 0),
          at: at(event),
        })
      }),
      context.data.on("session.step.ended", (event: Event<any>) => {
        const measurement = tracker.stepEnded({
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          outputTokens: Number(event.data.tokens?.output ?? 0),
        })
        if (measurement) record(measurement)
      }),
      context.data.on("session.step.failed", (event: Event<any>) => {
        tracker.stepFailed({ sessionID: event.data.sessionID, messageID: event.data.assistantMessageID })
      }),
    ]

    const viewedSessionID = (): string | undefined => {
      const route = context.ui.router.current() as { type?: string; sessionID?: string } | undefined
      return route?.type === "session" ? route.sessionID : undefined
    }
    const label = () => {
      const rate = pickRate(bySession(), viewedSessionID(), latest())
      return rate === undefined ? undefined : formatRate(rate)
    }

    // Appended to the status row, next to what other plugins (claude-usage) put there.
    const unregister = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <ErrorBoundary fallback={<text fg={theme.text.faint}>{"tok/s non disponibile"}</text>}>
          <Show when={label()}>{(text) => <text fg={theme.text.faint}>{`  ${text()}`}</text>}</Show>
        </ErrorBoundary>
      ),
    })

    return () => {
      stops.forEach((stop) => stop())
      unregister()
    }
  },
})
