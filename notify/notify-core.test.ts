import { describe, expect, test } from "bun:test"
import { DEBOUNCE_MS, createGate, createNotifier, createSeen, noticeFor, type Kind, type NotifyResult } from "./notify-core"

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

describe("createSeen", () => {
  test("a key is accepted once until it is released", () => {
    const seen = createSeen()
    expect(seen.first("per_1")).toBe(true)
    expect(seen.first("per_1")).toBe(false)
    seen.release("per_1")
    expect(seen.first("per_1")).toBe(true)
  })

  test("keys are independent", () => {
    const seen = createSeen()
    expect(seen.first("a")).toBe(true)
    expect(seen.first("b")).toBe(true)
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
    return { notifier, sent, advanceTo, send, answerWith: (next: () => Promise<NotifyResult>) => void (answer = next) }
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

  test("a finished reply inside the 20 seconds stays silent", async () => {
    const { sent, advanceTo, send } = setup()
    await send("done")
    await advanceTo(5_000)
    await send("done")
    await advanceTo(30_000)
    expect(sent).toEqual([{ message: "ho finito", at: 0 }])
  })
})
