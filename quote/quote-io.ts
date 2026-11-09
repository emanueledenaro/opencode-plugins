// The only file with disk access. It reaches one folder, <state>/opencode/quote-pending, nothing else.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { PENDING_TTL_MS, type PendingFs } from "./quote-core.ts"

const MAX_FILE_BYTES = 256 * 1024 // a real pending file is at most ~80 KB; bigger means junk

export const pendingDir = (): string =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "quote-pending")

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"

export const createPendingFs = (dir: string = pendingDir()): PendingFs => ({
  dir,
  read(path) {
    try {
      // O_NOFOLLOW: a symlink planted in the folder is refused, never followed.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return "{}" // parses as invalid, so the caller deletes it
        return readFileSync(fd, "utf8")
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  },
  write(path, data) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const info = lstatSync(dir)
    if (info.isSymbolicLink() || !info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
      throw new Error("quote-pending folder is not a plain folder owned by this user")
    chmodSync(dir, 0o700)
    const tmp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, data, { mode: 0o600, flag: "wx" }) // never follows or truncates an existing file
      renameSync(tmp, path)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // already gone
      }
      throw error
    }
  },
  remove(path) {
    try {
      unlinkSync(path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  },
})

/** Deletes pending files (and stray temp files) older than the expiry. Never throws. */
export const sweepExpired = (fs: PendingFs, now: number = Date.now()): void => {
  try {
    for (const name of readdirSync(fs.dir)) {
      if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue
      const path = join(fs.dir, name)
      try {
        if (now - statSync(path).mtimeMs >= PENDING_TTL_MS) unlinkSync(path)
      } catch {
        // skip this file
      }
    }
  } catch {
    // the folder does not exist yet
  }
}
