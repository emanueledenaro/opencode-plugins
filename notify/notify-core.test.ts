import { describe, expect, test } from "bun:test"
import { DEBOUNCE_MS, createGate, createSeen, noticeFor } from "./notify-core"

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
