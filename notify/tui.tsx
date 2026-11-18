// TUI part of the notify plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// A macOS notification and a short sound, only when the terminal is not focused, when the main session
// finishes a reply, a permission is asked or a form/question waits for you. At most one every 20 seconds;
// a permission or question that meets the 20 seconds pings when they end.
// The rules are in ./notify-core.ts (tested), see ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { DEBOUNCE_MS, createGate, createNotifier, createSeen, noticeFor, type Kind } from "./notify-core.ts"

const VOLUME = 0.6

export default Plugin.define({
  id: "local.notify",
  async setup(context) {
    if (process.env.NOTIFY_DISABLED === "1") return

    const seenPermissions = createSeen()
    const seenForms = createSeen()

    const debug = process.env.NOTIFY_DEBUG_FILE
    const trace = (line: string) => {
      if (!debug) return
      try {
        require("node:fs").appendFileSync(debug, `${new Date().toISOString()} ${line}\n`)
      } catch {
        // tracing is for tests only
      }
    }

    const notifier = createNotifier({
      gate: createGate(DEBOUNCE_MS),
      now: Date.now,
      scheduler: {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      notify: (notice) =>
        context.attention.notify({
          title: notice.title,
          message: notice.message,
          notification: { when: "blurred" },
          sound: { name: notice.sound, volume: VOLUME, when: "blurred" },
        }),
      trace,
    })

    const send = (kind: Kind, sessionID: string | undefined, requestID?: string) => {
      const notice = noticeFor(kind, sessionID ? context.data.session.get(sessionID) : undefined)
      if (!notice) return trace(`${kind}: silent`)
      notifier.send({ kind, notice, requestID })
    }

    const sessionOf = (event: unknown) => (event as { data?: { sessionID?: string } } | undefined)?.data?.sessionID

    const formAnswered = (event: unknown) => {
      const id = (event as { data?: { id?: string } }).data?.id
      if (!id) return
      seenForms.release(id)
      notifier.cancel("form", id)
    }

    const stops = [
      context.data.on("session.execution.succeeded", (event) => send("done", sessionOf(event))),
      context.data.on("permission.asked", (event) => {
        const data = (event as { data?: { id?: string; sessionID?: string } }).data
        if (!data?.id || !seenPermissions.first(data.id)) return
        send("permission", data.sessionID, data.id)
      }),
      context.data.on("permission.replied", (event) => {
        const requestID = (event as { data?: { requestID?: string } }).data?.requestID
        if (!requestID) return
        seenPermissions.release(requestID)
        notifier.cancel("permission", requestID)
      }),
      context.data.on("form.created", (event) => {
        const form = (event as { data?: { form?: { id?: string; sessionID?: string } } }).data?.form
        if (!form?.id || !seenForms.first(form.id)) return
        send("form", form.sessionID, form.id)
      }),
      context.data.on("form.replied", formAnswered),
      context.data.on("form.cancelled", formAnswered),
    ]

    return () => {
      stops.forEach((stop) => stop())
      notifier.dispose()
    }
  },
})
