// Pure logic of the notify plugin: which event deserves a notification, what it says, and the
// 20 second debounce. No OpenCode API and no I/O here; see notify-core.test.ts.

export const DEBOUNCE_MS = 20_000

export type Kind = "done" | "permission" | "form"
export type Notice = { title: string; message: string; sound: string }

/**
 * At most one delivered notification per `ms`. `ready` only asks; `commit` records a delivery.
 * A notification that was skipped (terminal focused) is never committed, so it does not use up the window.
 */
export function createGate(ms: number) {
  let last: number | undefined
  return {
    ready(now: number): boolean {
      if (last === undefined) return true
      if (now < last) return true
      return now - last >= ms
    },
    commit(now: number) {
      last = now
    },
  }
}

/** Remembers request ids so one permission or form notifies once, until it is answered. */
export function createSeen() {
  const keys = new Set<string>()
  return {
    first(key: string): boolean {
      if (keys.has(key)) return false
      keys.add(key)
      return true
    },
    release(key: string) {
      keys.delete(key)
    },
  }
}

/**
 * `session` is what OpenCode knows about the session the event belongs to (undefined if nothing).
 * Only the main (parentless) session announces that it finished; a child finishing is too noisy.
 * A permission or a form is always worth a ping, also from a child, because the child waits for you.
 */
export function noticeFor(kind: Kind, session: { parentID?: string } | undefined): Notice | undefined {
  if (kind === "done") {
    if (!session || session.parentID) return undefined
    return { title: "OpenCode", message: "ho finito", sound: "done" }
  }
  if (kind === "permission") return { title: "OpenCode", message: "serve un permesso", sound: "permission" }
  return { title: "OpenCode", message: "serve una risposta", sound: "question" }
}
