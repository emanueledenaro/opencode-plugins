import { describe, expect, test } from "bun:test"
import {
  DEBOUNCE_MS,
  NAME_MAX,
  createGate,
  createNotifier,
  createSeen,
  noticeFor,
  sessionName,
  type Kind,
  type NotifyResult,
} from "./notify-core"

describe("createGate", () => {
  test("lets the first notification through and blocks the ones inside 20 seconds", () => {
    const gate = createGate(DEBOUNCE_MS)
    expect(DEBOUNCE_MS).toBe(20_000)
    expect(gate.ready(1_000)).toBe(true)
    gate.commit(1_000)
    expect(gate.ready(1_001)).toBe(false)
    expect(gate.ready(20_999)).toBe(false)
  })

  test("opens again exactly 20 seconds after the last delivered notification", () => {
    const gate = createGate(DEBOUNCE_MS)
    gate.commit(1_000)
    expect(gate.ready(21_000)).toBe(true)
  })

  test("a blocked attempt does not push the window forward", () => {
    const gate = createGate(DEBOUNCE_MS)
    gate.commit(0)
    expect(gate.ready(15_000)).toBe(false) // asked, but nothing was committed
    expect(gate.ready(20_000)).toBe(true)
  })

  test("without a commit the gate stays open (a skipped notification costs nothing)", () => {
    const gate = createGate(DEBOUNCE_MS)
    expect(gate.ready(0)).toBe(true)
    expect(gate.ready(1)).toBe(true)
  })

  test("a clock that goes backwards does not lock the gate for good", () => {
    const gate = createGate(DEBOUNCE_MS)
    gate.commit(100_000)
    expect(gate.ready(50_000)).toBe(true)
  })
})

describe("noticeFor", () => {
  test("a finished reply of the main session says 'ho finito'", () => {
    expect(noticeFor("done", { parentID: undefined })).toEqual({
      title: "OpenCode",
      message: "ho finito",
      sound: "done",
    })
  })

  test("a finished child session is silent", () => {
    expect(noticeFor("done", { parentID: "ses_parent" })).toBeUndefined()
  })

  test("a finished session we know nothing about is silent", () => {
    expect(noticeFor("done", undefined)).toBeUndefined()
  })

  test("a failed run of the main session pings with the error sound", () => {
    expect(noticeFor("failed", { parentID: undefined })).toEqual({
      title: "OpenCode",
      message: "mi sono fermato per un errore",
      sound: "error",
    })
  })

  test("a failed child session, or one we know nothing about, is silent", () => {
    expect(noticeFor("failed", { parentID: "ses_parent" })).toBeUndefined()
    expect(noticeFor("failed", undefined)).toBeUndefined()
  })

  test("a permission request always notifies, also from a child session", () => {
    const notice = { title: "OpenCode", message: "serve un permesso", sound: "permission" }
    expect(noticeFor("permission", { parentID: undefined })).toEqual(notice)
    expect(noticeFor("permission", { parentID: "ses_parent" })).toEqual(notice)
    expect(noticeFor("permission", undefined)).toEqual(notice)
  })

  test("a form or question always notifies, also from a child session", () => {
    const notice = { title: "OpenCode", message: "serve una risposta", sound: "question" }
    expect(noticeFor("form", { parentID: undefined })).toEqual(notice)
    expect(noticeFor("form", { parentID: "ses_parent" })).toEqual(notice)
    expect(noticeFor("form", undefined)).toEqual(notice)
  })
})

describe("noticeFor, which session the ping is about", () => {
  test("a permission from a subagent names that subagent", () => {
    expect(noticeFor("permission", { parentID: "ses_parent", title: "rilettura #103" })).toEqual({
      title: "OpenCode",
      message: "serve un permesso · rilettura #103",
      sound: "permission",
    })
  })

  test("every kind of ping carries the name after its text", () => {
    const main = { parentID: undefined, title: "Plugin UX" }
    expect(noticeFor("done", main)?.message).toBe("ho finito · Plugin UX")
    expect(noticeFor("failed", main)?.message).toBe("mi sono fermato per un errore · Plugin UX")
    expect(noticeFor("form", main)?.message).toBe("serve una risposta · Plugin UX")
  })

  test("a session with no real title pings with the plain text", () => {
    for (const title of [undefined, "", "   ", "New session - 2026-11-18T10:00:00.000Z", "Child session - 2026-11-18T10:00:00.000Z"]) {
      expect(noticeFor("permission", { parentID: "ses_parent", title })?.message).toBe("serve un permesso")
    }
  })

  test("named false leaves the name out", () => {
    expect(noticeFor("permission", { parentID: "ses_parent", title: "rilettura #103" }, false)?.message).toBe("serve un permesso")
  })

  test("a named child that finishes is still silent", () => {
    expect(noticeFor("done", { parentID: "ses_parent", title: "rilettura #103" })).toBeUndefined()
  })
})

describe("sessionName", () => {
  test("a title is put on one line", () => {
    expect(sessionName("  rilettura\n#103\t ")).toBe("rilettura #103")
  })

  test("control characters are removed, so a title cannot end or rewrite the terminal's escape code", () => {
    expect(sessionName("a\u001b]9;falso\u0007b")).toBe("a]9;falsob")
    expect(sessionName("a\u009cb\u007fc\u0000d")).toBe("abcd")
  })

  test("a long title is cut at 40 characters with an ellipsis", () => {
    expect(NAME_MAX).toBe(40)
    expect(sessionName("a".repeat(40))).toBe("a".repeat(40))
    expect(sessionName("a".repeat(41))).toBe(`${"a".repeat(39)}…`)
  })

  test("the cut never splits an emoji", () => {
    expect(sessionName(`${"a".repeat(38)}😀bcd`)).toBe(`${"a".repeat(38)}😀…`)
  })

  test("something that is not a string is no name", () => {
    expect(sessionName(undefined)).toBeUndefined()
    expect(sessionName(42)).toBeUndefined()
    expect(sessionName("\u0007\u001b")).toBeUndefined()
  })
})

describe("createSeen", () => {
  test("a key is claimed once until it is released", () => {
    const seen = createSeen()
    expect(seen.claim("per_1")).toBe(true)
    expect(seen.claim("per_1")).toBe(false)
    seen.release("per_1")
    expect(seen.claim("per_1")).toBe(true)
  })

  test("keys are independent", () => {
    const seen = createSeen()
    expect(seen.claim("a")).toBe(true)
    expect(seen.claim("b")).toBe(true)
  })
})

describe("createGate waitMs", () => {
  test("says how long until the gate opens again", () => {
    const gate = createGate(DEBOUNCE_MS)
    gate.commit(1_000)
    expect(gate.waitMs(6_000)).toBe(15_000)
    expect(gate.waitMs(21_000)).toBe(0)
  })
})

describe("createNotifier", () => {
  const SHOWN: NotifyResult = { ok: true, notification: true, sound: true }

  // A fake clock with its own timers, and an attention.notify stand-in that records what it was asked when.
  const setup = () => {
    let clock = 0
    const timers: { fn: () => void; at: number; cleared: boolean }[] = []
    const sent: { message: string; at: number }[] = []
    let answer: () => Promise<NotifyResult> = async () => SHOWN
    const notifier = createNotifier({
      gate: createGate(DEBOUNCE_MS),
      now: () => clock,
      scheduler: {
        set: (fn, ms) => {
          const timer = { fn, at: clock + ms, cleared: false }
          timers.push(timer)
          return timer
        },
        clear: (handle) => void ((handle as { cleared: boolean }).cleared = true),
      },
      notify: (notice) => {
        sent.push({ message: notice.message, at: clock })
        return answer()
      },
    })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    // Lets pending awaits finish, then fires every timer due by `to` in time order, the new ones included.
    const advanceTo = async (to: number) => {
      await settle()
      for (;;) {
        const due = timers.filter((t) => !t.cleared && t.at <= to).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        clock = due.at
        due.cleared = true
        due.fn()
        await settle()
      }
      clock = to
    }
    const send = async (kind: Kind, requestID?: string) => {
      notifier.send({ kind, notice: noticeFor(kind, { parentID: undefined })!, requestID })
      await settle()
    }
    const liveTimers = () => timers.filter((t) => !t.cleared).length
    return { notifier, sent, advanceTo, send, liveTimers, answerWith: (next: () => Promise<NotifyResult>) => void (answer = next) }
  }

  test("a permission asked inside the 20 seconds pings when they end", async () => {
    const { sent, advanceTo, send } = setup()
    await send("done")
    await advanceTo(5_000)
    await send("permission", "per_1")
    await advanceTo(30_000)
    expect(sent).toEqual([
      { message: "ho finito", at: 0 },
      { message: "serve un permesso", at: 20_000 },
    ])
  })

  test("a question asked while another ping is still being sent pings 20 seconds after that one", async () => {
    const { sent, advanceTo, send, answerWith } = setup()
    let finish: (result: NotifyResult) => void = () => {}
    answerWith(() => new Promise((resolve) => (finish = resolve)))
    await send("done")
    await send("form", "frm_1")
    answerWith(async () => SHOWN)
    finish(SHOWN)
    await advanceTo(30_000)
    expect(sent).toEqual([
      { message: "ho finito", at: 0 },
      { message: "serve una risposta", at: 20_000 },
    ])
  })

  test("a permission answered before the gate opens never pings", async () => {
    const { notifier, sent, advanceTo, send } = setup()
    await send("done")
    await advanceTo(5_000)
    await send("permission", "per_1")
    await advanceTo(10_000)
    notifier.cancel("permission", "per_1")
    await advanceTo(30_000)
    expect(sent).toEqual([{ message: "ho finito", at: 0 }])
  })

  test("two requests that wait: only the latest pings when the 20 seconds end", async () => {
    const { sent, advanceTo, send } = setup()
    await send("done")
    await advanceTo(5_000)
    await send("permission", "per_1")
    await advanceTo(6_000)
    await send("form", "frm_1")
    await advanceTo(30_000)
    expect(sent).toEqual([
      { message: "ho finito", at: 0 },
      { message: "serve una risposta", at: 20_000 },
    ])
  })

  test("a ping that was not shown does not use up the 20 seconds: a waiting request goes at once", async () => {
    const { sent, advanceTo, send, answerWith } = setup()
    let finish: (result: NotifyResult) => void = () => {}
    answerWith(() => new Promise((resolve) => (finish = resolve)))
    await send("done")
    await advanceTo(1_000)
    await send("permission", "per_1")
    answerWith(async () => SHOWN)
    finish({ ok: true, skipped: "focused" })
    await advanceTo(1_000)
    expect(sent).toEqual([
      { message: "ho finito", at: 0 },
      { message: "serve un permesso", at: 1_000 },
    ])
  })

  test("dispose clears the timer of a waiting request", async () => {
    const { notifier, sent, advanceTo, send, liveTimers } = setup()
    await send("done")
    await advanceTo(5_000)
    await send("permission", "per_1")
    notifier.dispose()
    const left = liveTimers()
    await advanceTo(30_000)
    expect([left, sent]).toEqual([0, [{ message: "ho finito", at: 0 }]])
  })

  test("after dispose nothing pings: not a request left behind a ping in flight, not a new one", async () => {
    const { notifier, sent, advanceTo, send, answerWith } = setup()
    let finish: (result: NotifyResult) => void = () => {}
    answerWith(() => new Promise((resolve) => (finish = resolve)))
    await send("done")
    await advanceTo(5_000)
    await send("permission", "per_1")
    notifier.dispose()
    answerWith(async () => SHOWN)
    finish(SHOWN)
    await advanceTo(25_000)
    await send("form", "frm_1")
    await advanceTo(60_000)
    expect(sent).toEqual([{ message: "ho finito", at: 0 }])
  })

  test("a finished reply inside the 20 seconds stays silent", async () => {
    const { sent, advanceTo, send } = setup()
    await send("done")
    await advanceTo(5_000)
    await send("done")
    await advanceTo(30_000)
    expect(sent).toEqual([{ message: "ho finito", at: 0 }])
  })
})
