import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, chmodSync, closeSync, constants, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendMeasurement, readMeasurements, ROTATE_BYTES, READ_LIMIT_BYTES } from "./token-rate-log"
import type { ThroughputMeasurement } from "./token-rate-core"

const meas = (messageID: string): ThroughputMeasurement => ({
  timestamp: 1,
  sessionID: "ses_1",
  messageID,
  providerID: "p",
  modelID: "opus",
  outputTokens: 10,
  timeToFirstTokenMs: 100,
  generationMs: 500,
  tokensPerSecond: 20,
})
const line = (id: string) => `${JSON.stringify(meas(id))}\n`

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "token-rate-log-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("readMeasurements", () => {
  test("reads a small log whole", async () => {
    const file = join(dir, "small.jsonl")
    writeFileSync(file, line("a") + line("b"))
    expect((await readMeasurements(file)).map((m) => m.messageID)).toEqual(["a", "b"])
  })

  test("reads only the tail when the file is bigger than the limit, without a cut line", async () => {
    const file = join(dir, "big.jsonl")
    const lines = Array.from({ length: 50 }, (_, i) => line(`m${i}`))
    writeFileSync(file, lines.join(""))
    const limit = lines[0]!.length * 3 + 10 // room for three lines and a piece of a fourth
    const ids = (await readMeasurements(file, limit)).map((m) => m.messageID)
    expect(ids).toEqual(["m47", "m48", "m49"])
  })

  test("gives nothing for a missing file", async () => {
    expect(await readMeasurements(join(dir, "missing.jsonl"))).toEqual([])
  })

  test("refuses a symlink in place of the log", async () => {
    const real = join(dir, "real.jsonl")
    writeFileSync(real, line("a"))
    const link = join(dir, "link.jsonl")
    symlinkSync(real, link)
    expect(await readMeasurements(link)).toEqual([])
  })

  test("refuses a directory in place of the log", async () => {
    const folder = join(dir, "folder.jsonl")
    mkdirSync(folder)
    expect(await readMeasurements(folder)).toEqual([])
  })
})

describe("appendMeasurement", () => {
  test("appends one line per measurement and keeps the file private", async () => {
    const file = join(dir, "state", "nested", "log.jsonl")
    await appendMeasurement(meas("a"), file)
    await appendMeasurement(meas("b"), file)
    expect((await readMeasurements(file)).map((m) => m.messageID)).toEqual(["a", "b"])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("refuses a symlink in place of the log", async () => {
    const real = join(dir, "target.jsonl")
    writeFileSync(real, "")
    const link = join(dir, "append-link.jsonl")
    symlinkSync(real, link)
    await expect(appendMeasurement(meas("a"), link)).rejects.toThrow()
  })

  test("rotates to .1 once the file is over the limit, and starts a private new file", async () => {
    const file = join(dir, "rotate", "log.jsonl")
    mkdirSync(join(dir, "rotate"))
    writeFileSync(file, "x".repeat(101))
    chmodSync(file, 0o644)
    await appendMeasurement(meas("new"), file, 100)
    expect(readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(101))
    expect((await readMeasurements(file)).map((m) => m.messageID)).toEqual(["new"])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(`${file}.1`).mode & 0o777).toBe(0o600)
  })

  test("does not rotate a file exactly at the limit", async () => {
    const file = join(dir, "norotate", "log.jsonl")
    mkdirSync(join(dir, "norotate"))
    writeFileSync(file, "x".repeat(100))
    await appendMeasurement(meas("new"), file, 100)
    expect(existsSync(`${file}.1`)).toBe(false)
    expect(readFileSync(file, "utf8").startsWith("x".repeat(100))).toBe(true)
  })

  test("replaces an older .1 when it rotates again", async () => {
    const file = join(dir, "rotate2", "log.jsonl")
    mkdirSync(join(dir, "rotate2"))
    writeFileSync(`${file}.1`, "old")
    writeFileSync(file, "y".repeat(101))
    await appendMeasurement(meas("new"), file, 100)
    expect(readFileSync(`${file}.1`, "utf8")).toBe("y".repeat(101))
  })

  test("a symlink in place of a big log is refused, not rotated away", async () => {
    mkdirSync(join(dir, "rotlink"))
    const real = join(dir, "rotlink", "real.jsonl")
    writeFileSync(real, "z".repeat(101))
    const link = join(dir, "rotlink", "log.jsonl")
    symlinkSync(real, link)
    await expect(appendMeasurement(meas("a"), link, 100)).rejects.toThrow()
    expect(existsSync(`${link}.1`)).toBe(false)
    expect(readFileSync(real, "utf8")).toBe("z".repeat(101))
  })

  test("a pipe with nobody reading fails at once instead of hanging", async () => {
    const file = join(dir, "pipe-alone.jsonl")
    expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0)
    await expect(appendMeasurement(meas("a"), file)).rejects.toThrow()
  })

  test("rotates by default at four times the read limit", () => {
    expect(ROTATE_BYTES).toBe(4 * READ_LIMIT_BYTES)
  })

  test("leaves a pipe in place of the log alone: no chmod, no write", async () => {
    const file = join(dir, "pipe.jsonl")
    expect(Bun.spawnSync(["mkfifo", "-m", "644", file]).exitCode).toBe(0)
    const reader = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      await appendMeasurement(meas("a"), file)
      expect(statSync(file).mode & 0o777).toBe(0o644)
    } finally {
      closeSync(reader)
    }
  })
})
