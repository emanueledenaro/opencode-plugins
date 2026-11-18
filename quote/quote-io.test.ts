import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPendingFs, folderStamp } from "./quote-io"

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "quote-io-"))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

// The folder's times are set back by hand before each change, so the test does not rely on the clock moving.
const age = (dir: string) => utimesSync(dir, new Date(1_000_000), new Date(1_000_000))

describe("folderStamp", () => {
  test("is undefined while the folder does not exist", () => {
    expect(folderStamp(createPendingFs(join(root, "missing")))).toBeUndefined()
  })

  test("changes when a pending file is written or removed", () => {
    const fs = createPendingFs(join(root, "pending"))
    fs.write(join(fs.dir, "a.json"), "{}")
    age(fs.dir)
    const before = folderStamp(fs)
    fs.write(join(fs.dir, "b.json"), "{}")
    const afterWrite = folderStamp(fs)
    age(fs.dir)
    fs.remove(join(fs.dir, "a.json"))
    expect([before, afterWrite === before, folderStamp(fs) === before]).toEqual([1_000_000, false, false])
  })
})

describe("read", () => {
  test("a pipe in place of a pending file reads as junk at once instead of hanging the screen", () => {
    const fs = createPendingFs(join(root, "with-pipe"))
    fs.write(join(fs.dir, "ses_a.json"), "{}")
    const pipe = join(fs.dir, "ses_pipe.json")
    expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0)
    expect([fs.read(pipe), statSync(pipe).isFIFO()]).toEqual(["{}", true])
  })
})
