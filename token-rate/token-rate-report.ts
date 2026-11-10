// Prints a summary of the token-rate log: bun token-rate-report.ts [--average COUNT]
// Reads the same file the plugin writes (see logPath in tui.tsx): $XDG_STATE_HOME or ~/.local/state, then opencode/token-rate.jsonl.
import { homedir } from "node:os"
import { join } from "node:path"
import { summarize, type ThroughputMeasurement } from "./token-rate-core.ts"

const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
const logPath = join(state, "opencode", "token-rate.jsonl")
const count = Number.parseInt(Bun.argv[3] ?? "1", 10)

if (!Number.isSafeInteger(count) || count < 1) throw new Error("Usage: bun token-rate-report.ts [--average COUNT]")

async function main() {
  const measurements = (await Bun.file(logPath).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ThroughputMeasurement)

  const summary = summarize(measurements, count)
  if (!summary) throw new Error("No token throughput measurements have been recorded yet.")
  console.log(JSON.stringify(summary, null, 2))
}

void main()
