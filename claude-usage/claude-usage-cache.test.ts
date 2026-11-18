import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadCache, saveCache } from "./claude-usage"
import { serializeCache } from "./claude-usage-core"

const STATE = { snapshot: null, failure: null, consecutiveFailures: 0, nextAllowedAt: 123 }
const CACHE_TEXT = serializeCache(STATE)

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-usage-cache-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const mkfifo = (path: string) => expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0)

describe("loadCache", () => {
  test("reads back what saveCache wrote, in a private file", async () => {
    const file = join(dir, "round-trip.json")
    await saveCache(STATE, file)
    expect([(await loadCache(file))?.nextAllowedAt, statSync(file).mode & 0o777]).toEqual([123, 0o600])
  })

  test("a pipe in place of the cache gives no numbers at once instead of hanging", async () => {
    const file = join(dir, "pipe.json")
    mkfifo(file)
    expect(await loadCache(file)).toBeNull()
  })

  test("a pipe with cache text waiting in it is still not read", async () => {
    const file = join(dir, "pipe-with-data.json")
    mkfifo(file)
    // The writer is closed after writing, so a read gets the text and then the end, as from a file.
    const reader = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
    const writer = openSync(file, constants.O_WRONLY | constants.O_NONBLOCK)
    writeSync(writer, CACHE_TEXT)
    closeSync(writer)
    try {
      expect(await loadCache(file)).toBeNull()
    } finally {
      closeSync(reader)
    }
  })

  test("a file far bigger than a cache is not read", async () => {
    const file = join(dir, "big.json")
    writeFileSync(file, CACHE_TEXT + " ".repeat(70 * 1024))
    expect(await loadCache(file)).toBeNull()
  })

  test("a symlink in place of the cache is refused, not followed", async () => {
    const real = join(dir, "real.json")
    const link = join(dir, "link.json")
    writeFileSync(real, CACHE_TEXT)
    symlinkSync(real, link)
    expect(await loadCache(link)).toBeNull()
  })
})

describe("saveCache", () => {
  test("a pipe at the temp path fails at once instead of hanging, and the next save works", async () => {
    const file = join(dir, "after-pipe.json")
    mkfifo(`${file}.${process.pid}.tmp`)
    await expect(saveCache(STATE, file)).rejects.toThrow()
    await saveCache(STATE, file)
    expect(readFileSync(file, "utf8")).toBe(CACHE_TEXT)
  })

  test("a symlink at the temp path is not followed: its target stays as it was", async () => {
    const file = join(dir, "after-link.json")
    const target = join(dir, "target.txt")
    writeFileSync(target, "untouched")
    symlinkSync(target, `${file}.${process.pid}.tmp`)
    await saveCache(STATE, file).catch(() => {})
    expect([readFileSync(target, "utf8"), existsSync(`${file}.${process.pid}.tmp`)]).toEqual(["untouched", false])
  })
})
