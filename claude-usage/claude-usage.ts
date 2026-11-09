// Live wiring for the claude-usage plugin: the only file that touches the keychain, the network
// and the disk. READ ONLY: it never refreshes, writes, copies or caches the OAuth token.
//
// Data source: GET https://api.anthropic.com/api/oauth/usage. This endpoint is UNDOCUMENTED
// (it is what Claude Code's /usage uses). The documented alternative, the statusline
// `rate_limits` fields, only exists inside a running Claude Code session, so a separate
// program cannot read it. If Anthropic changes or closes the endpoint the plugin shows
// "usage unavailable" and nothing else breaks.
import { execFile } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
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

async function loadCache(): Promise<CacheFile | null> {
  try {
    return parseCache(await readFile(CACHE_PATH, "utf8"))
  } catch {
    return null
  }
}

// Only the usage numbers and the next-attempt time are written.
async function saveCache(state: Parameters<typeof serializeCache>[0]): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true })
  const temp = `${CACHE_PATH}.${process.pid}.tmp`
  await writeFile(temp, serializeCache(state), { mode: 0o600 })
  await rename(temp, CACHE_PATH)
}

export function createLiveMonitor() {
  return createUsageMonitor({
    now: () => Date.now(),
    readCredentials,
    fetchUsage,
    loadCache,
    saveCache,
  })
}

// Disable switch: CLAUDE_USAGE_DISABLED=1 in the environment, or remove the plugin entry.
export function isDisabled(): boolean {
  return process.env.CLAUDE_USAGE_DISABLED === "1"
}
