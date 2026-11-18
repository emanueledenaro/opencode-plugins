// Checks that the installed OpenCode still has every name these plugins depend on: the slots they draw in,
// the events they listen to, the footer id token-rate looks for, the APIs stato and plan-banner call and the
// sound names notify plays. The plugins read events as `any` and go quiet when a name is gone, so run this
// after each OpenCode upgrade:
//
//   bun check-host.ts [path to the opencode binary, default ~/.opencode/bin/opencode]
//
// Read only: it reads the binary and prints what is missing. It exits 1 when a name is missing.
import { homedir } from "node:os"
import { join } from "node:path"

export const HOST_NAMES = {
  /** Found with their quotes, as the bundle holds string literals. */
  quoted: [
    // slots
    "prompt.footer.status",
    "sidebar.content",
    "session.composer.top",
    // events
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.step.started",
    "session.step.ended",
    "session.step.failed",
    "session.text.delta",
    "session.tool.called",
    "session.tool.input.started",
    "session.deleted",
    "permission.asked",
    "permission.replied",
    "form.created",
    "form.replied",
    "form.cancelled",
    // the path item in the footer row (token-rate), the agent switch key (plan-banner)
    "prompt.footer.location",
    "agent.cycle",
  ],
  /** Method names, found as they are. */
  bare: ["registerCodeBlockRenderer"],
  /** Keys of attention's sound table, an object literal like {default:a,question:b,...} (notify). */
  sounds: ["question", "permission", "error", "done"],
} as const

const SOUND_TABLE = /\{default:[\w$]+(?:,[a-z_]+:[\w$]+)+\}/g
const TABLE_KEY = /[{,]([a-z_]+):/g

/** The sounds missing from the sound table that has the most of them; all of them when there is none. */
function missingSounds(binary: string, sounds: readonly string[]): string[] {
  let best = [...sounds]
  for (const [table] of binary.matchAll(SOUND_TABLE)) {
    const keys = new Set([...table.matchAll(TABLE_KEY)].map((match) => match[1]))
    const missing = sounds.filter((sound) => !keys.has(sound))
    if (missing.length < best.length) best = missing
  }
  return best
}

/** Every name of HOST_NAMES that `binary` (the OpenCode executable read as latin1 text) does not hold. */
export function missingNames(binary: string): string[] {
  return [
    ...HOST_NAMES.quoted.filter((name) => !binary.includes(`"${name}"`)),
    ...HOST_NAMES.bare.filter((name) => !binary.includes(name)),
    ...missingSounds(binary, HOST_NAMES.sounds).map((sound) => `sound ${sound}`),
  ]
}

if (import.meta.main) {
  const path = process.argv[2] ?? join(homedir(), ".opencode", "bin", "opencode")
  const binary = Buffer.from(await Bun.file(path).arrayBuffer()).toString("latin1")
  const missing = missingNames(binary)
  const total = HOST_NAMES.quoted.length + HOST_NAMES.bare.length + HOST_NAMES.sounds.length
  if (missing.length === 0) {
    console.log(`ok: all ${total} names found in ${path}`)
  } else {
    console.error(`missing in ${path}:\n${missing.map((name) => `  ${name}`).join("\n")}`)
    process.exit(1)
  }
}
