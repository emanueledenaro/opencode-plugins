// Pure logic of the plan-banner plugin. No I/O and no OpenCode imports.
//
// What the plugin can know: the TUI does not expose the agent selected in the prompt (checked on
// OpenCode 2.2.6), and the session's own agent changes only when a message is sent. What message.list()
// does give is each assistant message's `agent` field, so the banner talks about the LAST REPLY,
// never about the agent selected right now.

export const PLAN_AGENT = "plan"
export const FALLBACK_KEY = "Shift+Tab"

// The agent id of the last assistant message, or null if there is none or it has no agent field.
export function lastReplyAgent(messages: unknown, revertID?: unknown): string | null {
  if (!Array.isArray(messages)) return null
  let end = messages.length
  if (typeof revertID === "string") {
    // OpenCode hides the reverted message and everything after it.
    for (let index = messages.length - 1; index >= 0; index--) {
      if ((messages[index] as { id?: unknown } | null)?.id === revertID) {
        end = index
        break
      }
    }
  }
  for (let index = end - 1; index >= 0; index--) {
    const item = messages[index] as { type?: unknown; agent?: unknown } | null
    if (typeof item !== "object" || item === null || item.type !== "assistant") continue
    return typeof item.agent === "string" ? item.agent : null
  }
  return null
}

export function shouldShowBanner(messages: unknown, revertID?: unknown): boolean {
  return lastReplyAgent(messages, revertID) === PLAN_AGENT
}

// "shift+tab" becomes "Shift+Tab". Anything unusable gives the fallback.
export function keyLabel(shortcuts: unknown): string {
  if (!Array.isArray(shortcuts)) return FALLBACK_KEY
  const first = shortcuts[0]
  if (typeof first !== "string" || first.trim() === "") return FALLBACK_KEY
  return first
    .trim()
    .split("+")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("+")
}

export function bannerText(key: string): string {
  return `La mia ultima risposta era in Plan: per farmi lavorare premi ${key} e scrivimi.`
}

export const RESIZE_COALESCE_MS = 50

// The banner for `width` columns: the longest wording that fits, or null when even "Plan" does not.
// A width that is not a number counts as no limit.
export function bannerLine(key: string, width: number): string | null {
  const room = Number.isNaN(width) ? Infinity : width
  const wordings = [
    bannerText(key),
    `Ultima risposta in Plan: premi ${key} per farmi lavorare.`,
    `Ultima risposta in Plan: premi ${key}.`,
    `Plan: premi ${key}`,
    "Plan",
  ]
  return wordings.find((text) => text.length <= room) ?? null
}

export type Scheduler = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

// Turns a stream of measured widths into few updates: the first real size is applied at once, later ones
// are coalesced to one update per `delayMs`, and a size that is already shown does nothing.
export function createWidthTracker(options: {
  initial: number
  onChange: (width: number) => void
  delayMs?: number
  scheduler?: Scheduler
}) {
  const delay = options.delayMs ?? RESIZE_COALESCE_MS
  const scheduler: Scheduler = options.scheduler ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  let shown = options.initial
  let latest = options.initial
  let measured = false
  let handle: unknown
  let disposed = false
  const flush = () => {
    handle = undefined
    if (latest !== shown) {
      shown = latest
      options.onChange(latest)
    }
  }
  return {
    report(raw: number) {
      if (disposed || !Number.isFinite(raw) || raw <= 0) return
      const next = Math.floor(raw)
      if (measured && next === latest) return
      latest = next
      if (!measured) {
        measured = true
        if (handle !== undefined) scheduler.clear(handle)
        flush()
        return
      }
      if (handle === undefined) handle = scheduler.set(flush, delay)
    },
    dispose() {
      disposed = true
      if (handle !== undefined) scheduler.clear(handle)
      handle = undefined
    },
  }
}
