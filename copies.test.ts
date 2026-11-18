// OpenCode reloads only the files inside a plugin folder, so a helper two plugins need is copied into each.
// These tests keep the copies identical: change one, change all of them.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** The text of `export function <name>(` up to the closing brace at the start of a line, or undefined. */
const functionText = (file: string, name: string): string | undefined => {
  const text = readFileSync(join(import.meta.dir, file), "utf8")
  const start = text.indexOf(`export function ${name}(`)
  const end = text.indexOf("\n}\n", start)
  return start === -1 || end === -1 ? undefined : text.slice(start, end + 2)
}

const expectSameCopies = (name: string, files: string[]) => {
  const copies = Object.fromEntries(files.map((file) => [file, functionText(file, name)]))
  expect(copies[files[0]!]).toBeString()
  expect(copies).toEqual(Object.fromEntries(files.map((file) => [file, copies[files[0]!]])))
}

describe("copied helpers stay identical", () => {
  test("createWidthTracker", () => {
    expectSameCopies("createWidthTracker", [
      "quote/quote-core.ts",
      "claude-usage/claude-usage-core.ts",
      "agents-panel/agents-core.ts",
      "plan-banner/plan-banner-core.ts",
      "ask-box/ask-box-core.ts",
    ])
  })

  test("createResizeWatch", () => {
    expectSameCopies("createResizeWatch", ["token-rate/token-rate-core.ts", "claude-usage/claude-usage-core.ts"])
  })
})
