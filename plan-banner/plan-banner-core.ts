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
