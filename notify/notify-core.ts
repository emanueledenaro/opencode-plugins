// Pure logic of the notify plugin: which event deserves a notification, what it says, the 20 second
// debounce and the queue that holds a blocked permission or question ping until the debounce ends.
// No OpenCode API and no I/O here: attention.notify, the clock and the timers come in from tui.tsx.

export const DEBOUNCE_MS = 20_000

export type Kind = "done" | "failed" | "permission" | "form"
export type Notice = { title: string; message: string; sound: string }
/** The fields of the attention.notify answer the plugin reads. */
export type NotifyResult = { ok?: boolean; skipped?: unknown; notification?: unknown; sound?: unknown }
/** One ping to send. `requestID` is the permission or form id (none for a finished reply); `cancel` uses it. */
export type Ping = { kind: Kind; notice: Notice; requestID?: string }
export type Scheduler = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

/**
 * At most one delivered notification per `ms`. `ready` and `waitMs` only ask; `commit` records a delivery.
 * A notification that was skipped (terminal focused) is never committed, so it does not use up the window.
 */
export function createGate(ms: number) {
  let last: number | undefined
  /** Milliseconds until the gate opens, 0 when it is open. A clock that went backwards opens it. */
  const waitMs = (now: number): number => (last === undefined || now < last ? 0 : Math.max(0, last + ms - now))
  return {
    waitMs,
    ready: (now: number): boolean => waitMs(now) === 0,
    commit(now: number) {
      last = now
    },
  }
}

/** Only a notification that was really shown or played uses up the 20 second window. */
const wasDelivered = (result: NotifyResult): boolean =>
  result.ok === true && !result.skipped && (result.notification === true || result.sound === true)

/**
 * Sends pings through `notify`, at most one delivered per gate window and one call at a time. A "done" ping
 * that meets a closed gate is dropped. A permission or form ping waits for the gate instead, because the host
 * announces each request once and nothing else would ping for it; when the gate opens, the latest request
 * still waiting is sent and stands for all of them. `cancel` withdraws a request that was answered.
 */
export function createNotifier(options: {
  gate: ReturnType<typeof createGate>
  notify: (notice: Notice) => Promise<NotifyResult>
  now: () => number
  scheduler: Scheduler
  trace?: (line: string) => void
}) {
  const { gate, notify, now, scheduler } = options
  const trace = options.trace ?? (() => {})
  const waiting = new Map<string, Ping>()
  let busy = false
  let timer: unknown
  let disposed = false

  const stopTimer = () => {
    if (timer !== undefined) scheduler.clear(timer)
    timer = undefined
  }

  const deliver = async (ping: Ping) => {
    const startedAt = now()
    busy = true
    try {
      const result = await notify(ping.notice)
      trace(`${ping.kind}: result ${JSON.stringify(result)}`)
      if (wasDelivered(result)) gate.commit(startedAt)
    } catch (error) {
      trace(`${ping.kind}: error ${String(error)}`)
    } finally {
      busy = false
      sendWaiting()
    }
  }

  // Sends the latest waiting request when the gate is open, or sets one timer for when it opens.
  const sendWaiting = () => {
    stopTimer()
    if (busy || waiting.size === 0) return
    const wait = gate.waitMs(now())
    if (wait > 0) {
      timer = scheduler.set(sendWaiting, wait)
      return
    }
    const latest = [...waiting.values()].at(-1)!
    waiting.clear()
    void deliver(latest)
  }

  const keyOf = (kind: Kind, requestID: string) => `${kind}:${requestID}`

  return {
    send(ping: Ping) {
      if (disposed) return
      if (!busy && gate.ready(now())) return void deliver(ping)
      // Only a request someone must answer is worth the wait; a finished reply is old news 20 seconds later.
      if (ping.requestID === undefined) return trace(`${ping.kind}: debounced`)
      const key = keyOf(ping.kind, ping.requestID)
      waiting.delete(key) // a repeated request moves to the end, so it counts as the latest
      waiting.set(key, ping)
      trace(`${ping.kind}: queued`)
      sendWaiting()
    },
    cancel(kind: Kind, requestID: string) {
      if (waiting.delete(keyOf(kind, requestID))) sendWaiting()
    },
    /** Final: clears the timer and the waiting requests, and nothing is sent after it. */
    dispose() {
      disposed = true
      stopTimer()
      waiting.clear()
    },
  }
}

/** Remembers request ids so one permission or form notifies once, until it is answered. */
export function createSeen() {
  const keys = new Set<string>()
  return {
    /** Records the key; false when it was already recorded and not released since. */
    claim(key: string): boolean {
      if (keys.has(key)) return false
      keys.add(key)
      return true
    },
    release(key: string) {
      keys.delete(key)
    },
  }
}

// The sound names are OpenCode's attention sounds (2.3.0: default, question, permission, error, done, subagent_done).
const NOTICES: Record<Kind, Notice> = {
  done: { title: "OpenCode", message: "ho finito", sound: "done" },
  failed: { title: "OpenCode", message: "mi sono fermato per un errore", sound: "error" },
  permission: { title: "OpenCode", message: "serve un permesso", sound: "permission" },
  form: { title: "OpenCode", message: "serve una risposta", sound: "question" },
}

/** Only the main (parentless) session announces that it finished or failed; a child doing so is too noisy. */
const MAIN_SESSION_ONLY: ReadonlySet<Kind> = new Set<Kind>(["done", "failed"])

/**
 * `session` is what OpenCode knows about the session the event belongs to (undefined if nothing).
 * A permission or a form is always worth a ping, also from a child, because the child waits for you.
 */
export function noticeFor(kind: Kind, session: { parentID?: string } | undefined): Notice | undefined {
  if (MAIN_SESSION_ONLY.has(kind) && (!session || session.parentID)) return undefined
  return { ...NOTICES[kind] }
}
