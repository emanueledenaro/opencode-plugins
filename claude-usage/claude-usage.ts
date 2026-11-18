// Live wiring for the claude-usage plugin: the only file that touches the keychain, the network
// and the disk. READ ONLY: it never refreshes, writes, copies or caches the OAuth token.
//
// Data source: GET https://api.anthropic.com/api/oauth/usage. This endpoint is UNDOCUMENTED
// (it is what Claude Code's /usage uses). The documented alternative, the statusline
// `rate_limits` fields, only exists inside a running Claude Code session, so a separate
// program cannot read it. If Anthropic changes or closes the endpoint the plugin shows
// "usage unavailable" and nothing else breaks.
import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  type CacheFile,
  type Credentials,
  type FetchResult,
  createUsageMonitor,
  parseCache,
  parseCredentials,
  serializeCache,
} from "./claude-usage-core"

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage" // the only host we call
export const KEYCHAIN_SERVICE = "Claude Code-credentials"
export const REQUEST_TIMEOUT_MS = 10_000
export const CACHE_PATH = join(homedir(), ".local", "state", "opencode", "claude-usage.json")
const CACHE_READ_LIMIT = 64 * 1024 // a real cache file is a few hundred bytes

// Reads the keychain item on every call. The returned token lives in memory only.
function readKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: REQUEST_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      // On error we return null and drop the error: it carries the command line, not the secret,
      // but there is nothing in it worth showing.
      (error, stdout) => resolve(error ? null : String(stdout)),
    )
  })
}

async function readCredentials(): Promise<Credentials> {
  if (process.platform !== "darwin") return { ok: false, kind: "no-login" }
  const raw = await readKeychain()
  if (raw === null) return { ok: false, kind: "no-login" }
  return parseCredentials(raw, Date.now())
}

async function fetchUsage(token: string): Promise<FetchResult> {
  try {
    const response = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error", // never follow a redirect to another host with the token attached
    })
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"))
      await response.body?.cancel() // the body is never read, let alone shown
      return {
        ok: false,
        failure: {
          kind: "rate-limited",
          status: 429,
          retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
        },
      }
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      return { ok: false, failure: { kind: "login-expired", status: response.status } }
    }
    if (!response.ok) {
      await response.body?.cancel()
      return { ok: false, failure: { kind: "http", status: response.status } }
    }
    try {
      return { ok: true, body: await response.json() }
    } catch {
      return { ok: false, failure: { kind: "bad-response" } }
    }
  } catch (error) {
    const name = (error as { name?: string } | null)?.name
    return { ok: false, failure: { kind: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" } }
  }
}

/**
 * The cached numbers, or null. Runs before every network attempt, so it must never hang: O_NONBLOCK and the
 * isFile check refuse a pipe in its place, O_NOFOLLOW refuses a symlink, and only a small file is read.
 */
export async function loadCache(file = CACHE_PATH): Promise<CacheFile | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || info.size > CACHE_READ_LIMIT) return null
    return parseCache(await handle.readFile("utf8"))
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

// Only the usage numbers, the next-attempt time and, during a 429 back-off, its end are written.
// The temp file is created new ("wx"): a symlink or a pipe already at that path makes the save fail at once
// instead of being followed or waited on, and is removed so the next save works.
export async function saveCache(state: Parameters<typeof serializeCache>[0], file = CACHE_PATH): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temp, serializeCache(state), { mode: 0o600, flag: "wx" })
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export function createLiveMonitor() {
  return createUsageMonitor({
    now: () => Date.now(),
    readCredentials,
    fetchUsage,
    loadCache: () => loadCache(),
    saveCache: (state) => saveCache(state),
  })
}

// Disable switch: CLAUDE_USAGE_DISABLED=1 in the environment, or remove the plugin entry.
export function isDisabled(): boolean {
  return process.env.CLAUDE_USAGE_DISABLED === "1"
}
