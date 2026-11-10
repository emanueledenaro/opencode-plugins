// Prints a summary of the token-rate log: bun token-rate-report.ts [--average COUNT]
// Reads the same file the plugin writes (see logPath in token-rate-log.ts), the last megabyte of it.
import { summarize } from "./token-rate-core.ts"
import { readMeasurements } from "./token-rate-log.ts"

const count = Number.parseInt(Bun.argv[3] ?? "1", 10)

if (!Number.isSafeInteger(count) || count < 1) throw new Error("Usage: bun token-rate-report.ts [--average COUNT]")

async function main() {
  const summary = summarize(await readMeasurements(), count)
  if (!summary) throw new Error("No token throughput measurements have been recorded yet.")
  console.log(JSON.stringify(summary, null, 2))
}

void main()
