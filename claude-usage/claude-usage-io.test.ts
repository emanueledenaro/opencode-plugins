import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CACHE_PATH, RENDER_ERROR_PATH, reportRenderError } from "./claude-usage"

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-usage-io-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("reportRenderError", () => {
  test("sits next to the cache, not in /tmp", () => {
    expect(RENDER_ERROR_PATH).toBe(join(CACHE_PATH, "..", "claude-usage-render-error.txt"))
  })

  test("writes where and the message to a private file, creating the folder", () => {
    const file = join(dir, "new", "render-error.txt")
    reportRenderError("footer", new Error("boom"), file)
    expect(readFileSync(file, "utf8")).toContain(" footer\nboom\n")
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("replaces an older, wider file with the new error only", () => {
    const file = join(dir, "old.txt")
    writeFileSync(file, "an older and much longer error text\n".repeat(4), { mode: 0o644 })
    reportRenderError("dialog", "short", file)
    expect(readFileSync(file, "utf8")).toEndWith(" dialog\nshort\n")
    expect(readFileSync(file, "utf8")).not.toContain("older")
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("refuses a symlink in its place and leaves the target alone", () => {
    const real = join(dir, "real.txt")
    const link = join(dir, "link.txt")
    writeFileSync(real, "untouched", { mode: 0o644 })
    symlinkSync(real, link)
    reportRenderError("footer", new Error("boom"), link)
    expect(readFileSync(real, "utf8")).toBe("untouched")
    expect(statSync(real).mode & 0o777).toBe(0o644)
  })

  test("leaves a pipe in its place alone: no chmod, no write", () => {
    const file = join(dir, "pipe.txt")
    expect(Bun.spawnSync(["mkfifo", "-m", "644", file]).exitCode).toBe(0)
    const reader = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      reportRenderError("footer", new Error("boom"), file)
      expect(statSync(file).mode & 0o777).toBe(0o644)
    } finally {
      closeSync(reader)
    }
  })
})
