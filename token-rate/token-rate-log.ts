// The disk side of token-rate: where the jsonl log is, how a measurement is appended, and how the
// tail of the log is read for the /velocita dialog and the colour rule. Nothing else touches the file.
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseLogText, type ThroughputMeasurement } from "./token-rate-core.ts"

/** Only the last megabyte of the log is read: about 4000 replies, never the whole file. */
export const READ_LIMIT_BYTES = 1_048_576

/** Past this size the log moves to `token-rate.jsonl.1` and a new file starts (one old file is kept). */
export const ROTATE_BYTES = 4 * READ_LIMIT_BYTES

export function logPath(): string {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", "token-rate.jsonl")
}

/**
 * Appends one line. O_NOFOLLOW: a symlink in place of the log is refused. O_NONBLOCK and the isFile check:
 * a pipe in its place is left alone. chmod fixes an older 0644 file. A log over `rotateAt` bytes is first
 * renamed to `<file>.1` (replacing an older one), so the new file starts empty and 0600.
 */
export async function appendMeasurement(
  measurement: ThroughputMeasurement,
  file = logPath(),
  rotateAt = ROTATE_BYTES,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await rotateIfBig(file, rotateAt)
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const handle = await open(file, flags, 0o600)
  try {
    if (!(await handle.stat()).isFile()) return
    await handle.chmod(0o600)
    await handle.appendFile(`${JSON.stringify(measurement)}\n`)
  } finally {
    await handle.close()
  }
}

async function rotateIfBig(file: string, rotateAt: number): Promise<void> {
  const info = await lstat(file).catch(() => undefined)
  if (!info?.isFile() || info.size <= rotateAt) return
  const old = `${file}.1`
  await rename(file, old)
  await chmod(old, 0o600).catch(() => {})
}

/**
 * The measurements in the last `limit` bytes of the log, oldest first. A missing file, a symlink,
 * a pipe or anything unreadable gives an empty list: the log is a bonus.
 */
export async function readMeasurements(file = logPath(), limit = READ_LIMIT_BYTES): Promise<ThroughputMeasurement[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    // O_NONBLOCK so that opening a pipe in its place cannot hang; the isFile check refuses it after.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile()) return []
    const length = Math.min(info.size, limit)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, info.size - length)
    return parseLogText(buffer.toString("utf8", 0, bytesRead), info.size > length)
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => {})
  }
}
