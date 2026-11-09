// Server part of the quote plugin. One "prompt" hook: when the TUI left a pending quote for the
// session, it is attached to the message as a file named "Citazione" and the pending file is consumed.
// All the logic is in ./quote-core.ts (tested); the hook never throws and never blocks admission.
import { Plugin } from "@opencode/plugin"
import { applyQuoteToPrompt } from "./quote-core.ts"
import { createPendingFs } from "./quote-io.ts"

export default Plugin.define({
  id: "local.quote",
  async setup(ctx) {
    if (process.env.QUOTE_DISABLED === "1") return
    const fs = createPendingFs()
    const registration = await ctx.session.hook("prompt", (event) => {
      try {
        applyQuoteToPrompt(event, fs, Date.now())
      } catch {
        // leave the prompt untouched
      }
    })
    return () => {
      registration.dispose().catch(() => {})
    }
  },
})
