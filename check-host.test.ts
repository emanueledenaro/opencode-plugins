import { describe, expect, test } from "bun:test"
import { HOST_NAMES, missingNames } from "./check-host"

// A stand-in for the OpenCode binary: every name in the form the bundle holds it.
const fakeBinary = (drop: string[] = []) =>
  [
    ...HOST_NAMES.quoted.filter((name) => !drop.includes(name)).map((name) => `x("${name}")`),
    ...HOST_NAMES.bare.filter((name) => !drop.includes(name)).map((name) => `api.${name}(`),
    `var S={default:a,${HOST_NAMES.sounds.filter((name) => !drop.includes(name)).map((name) => `${name}:b`).join(",")}};`,
  ].join(";")

describe("missingNames", () => {
  test("a binary with every name misses nothing", () => {
    expect(missingNames(fakeBinary())).toEqual([])
  })

  test("names an event, a slot and an API that are gone", () => {
    expect(missingNames(fakeBinary(["session.text.delta", "sidebar.content", "registerCodeBlockRenderer"]))).toEqual([
      "sidebar.content",
      "session.text.delta",
      "registerCodeBlockRenderer",
    ])
  })

  test("a quoted name counts only with its quotes, not inside a longer name", () => {
    const binary = fakeBinary(["form.created"]) + ';x("form.created.v2")'
    expect(missingNames(binary)).toEqual(["form.created"])
  })

  test("names a sound that is gone from the sound table", () => {
    expect(missingNames(fakeBinary(["error"]))).toEqual(["sound error"])
  })

  test("another object with a default key does not hide the sound table", () => {
    expect(missingNames(`${fakeBinary()};var M={default:m,done:n}`)).toEqual([])
  })

  test("with no full sound table, names what the closest one lacks", () => {
    const binary = `${fakeBinary(["question", "permission", "error", "done"])};var M={default:m,done:n}`
    expect(missingNames(binary)).toEqual(["sound question", "sound permission", "sound error"])
  })
})
