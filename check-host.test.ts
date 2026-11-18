import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

describe("bun check-host.ts", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "check-host-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // Runs the script on a fake binary, the way the README says to run it after an upgrade.
  const runOn = (binary: string) => {
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "check-host.ts"), binary])
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
  }
  const fakeFile = (name: string, text: string) => {
    const file = join(dir, name)
    writeFileSync(file, text)
    return file
  }

  test("exits 0 when every name is there", () => {
    const run = runOn(fakeFile("all", fakeBinary()))
    expect([run.code, run.out.startsWith("ok: all 26 names found")]).toEqual([0, true])
  })

  test("exits 1 and names what is missing", () => {
    const run = runOn(fakeFile("old", fakeBinary(["session.text.delta"])))
    expect([run.code, run.err.trim().split("\n").slice(1)]).toEqual([1, ["  session.text.delta"]])
  })

  test("exits 2 with one plain line when the binary cannot be read", () => {
    const run = runOn(join(dir, "no-such-binary"))
    expect([run.code, run.err.trim()]).toEqual([2, `cannot read ${join(dir, "no-such-binary")}: ENOENT`])
  })
})
