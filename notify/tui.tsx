// TUI part of the notify plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// A macOS notification and a short sound, only when the terminal is not focused, when the main session
// finishes a reply, a permission is asked or a form/question waits for you. At most one every 20 seconds.
// The rules are in ./notify-core.ts (tested), see ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { DEBOUNCE_MS, createGate, createSeen, noticeFor, type Kind } from "./notify-core.ts"

const VOLUME = 0.6

export default Plugin.define({
  id: "local.notify",
  async setup(context) {
    if (process.env.NOTIFY_DISABLED === "1") return

    const gate = createGate(DEBOUNCE_MS)
    const seenPermissions = createSeen()
    const seenForms = createSeen()
    let busy = false

    const debug = process.env.NOTIFY_DEBUG_FILE
    const trace = (line: string) => {
      if (!debug) return
      try {
        require("node:fs").appendFileSync(debug, `${new Date().toISOString()} ${line}\n`)
      } catch {
        // tracing is for tests only
      }
    }

    const deliver = async (kind: Kind, sessionID: string | undefined) => {
      const notice = noticeFor(kind, sessionID ? context.data.session.get(sessionID) : undefined)
      if (!notice) return trace(`${kind}: silent`)
      const now = Date.now()
      if (busy || !gate.ready(now)) return trace(`${kind}: debounced`)
      busy = true
      try {
        const result = await context.attention.notify({
          title: notice.title,
          message: notice.message,
          notification: { when: "blurred" },
          sound: { name: notice.sound, volume: VOLUME, when: "blurred" },
        })
        trace(`${kind}: result ${JSON.stringify(result)}`)
        // Only a notification that was really shown or played uses up the 20 second window.
        if (result.ok && !result.skipped && (result.notification === true || result.sound === true)) {
          gate.commit(now)
        }
      } catch (error) {
        trace(`${kind}: error ${String(error)}`)
      } finally {
        busy = false
      }
    }

    const sessionOf = (event: unknown) => (event as { data?: { sessionID?: string } } | undefined)?.data?.sessionID

    const stops = [
      context.data.on("session.execution.succeeded", (event) => void deliver("done", sessionOf(event))),
      context.data.on("permission.asked", (event) => {
        const data = (event as { data?: { id?: string; sessionID?: string } }).data
        if (!data?.id || !seenPermissions.first(data.id)) return
        void deliver("permission", data.sessionID)
      }),
      context.data.on("permission.replied", (event) => {
        const requestID = (event as { data?: { requestID?: string } }).data?.requestID
        if (requestID) seenPermissions.release(requestID)
      }),
      context.data.on("form.created", (event) => {
        const form = (event as { data?: { form?: { id?: string; sessionID?: string } } }).data?.form
        if (!form?.id || !seenForms.first(form.id)) return
        void deliver("form", form.sessionID)
      }),
      context.data.on("form.replied", (event) => {
        const id = (event as { data?: { id?: string } }).data?.id
        if (id) seenForms.release(id)
      }),
      context.data.on("form.cancelled", (event) => {
        const id = (event as { data?: { id?: string } }).data?.id
        if (id) seenForms.release(id)
      }),
    ]

    return () => stops.forEach((stop) => stop())
  },
})
