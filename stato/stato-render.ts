// The renderer and its registration, with the OpenTUI classes passed in. That keeps this file free of
// OpenTUI imports, so the fallbacks and the unregister logic are tested with plain fakes (see the test file).
// ./tui.ts is the only place that hands in the real classes.
import {
  PROGRESS_SYMBOL,
  SPIN_INTERVAL_MS,
  blockKey,
  colourFor,
  lineText,
  spinFrame,
  statoLines,
  type StatoLine,
  type StatoTheme,
} from "./stato-core.ts"

export const LANGUAGE = "stato"

export type Box = { add(child: unknown): unknown; destroyRecursively(): void }

// What the spinner needs from the host. Leave `spin` out and in-progress lines are drawn as a still `◐`.
export type SpinDeps = {
  // Session on screen at the moment a block is drawn (undefined when none: the block stays still).
  session(): string | undefined
  // Takes a fresh look at that session's messages; the returned function says whether a block text is in the
  // latest reply. Called at most once per session per tick.
  replyCheck(sessionID: string): (blockText: string) => boolean
  setContent(node: unknown, content: string): void
  isAlive(node: unknown): boolean
  // Starts a repeating timer and returns the function that stops it.
  every(run: () => void, ms: number): () => void
  now(): number
}

export type RenderDeps = {
  makeBox(): Box
  makeText(content: string, fg: unknown): unknown
  theme(): StatoTheme | undefined
  spin?: SpinDeps
}

type SpinRow = { node: unknown; line: StatoLine }
type SpinBlock = { box: Box; sessionID: string; key: string; rows: SpinRow[]; frame: string }

export type Spinner = {
  add(block: SpinBlock): void
  // The frame a new block starts with: the current one if it is in the latest reply, otherwise the still symbol.
  startFrame(sessionID: string, key: string): string
  stop(): void
  size(): number
}

// One shared timer for every spinning block. It runs only while there is a block to turn: it starts with the
// first one, and stops by itself when the last one is destroyed. A tick never throws.
export function createSpinner(deps: SpinDeps): Spinner {
  const blocks = new Set<SpinBlock>()
  let stopTimer: (() => void) | undefined

  const halt = () => {
    const stop = stopTimer
    stopTimer = undefined
    try {
      stop?.()
    } catch {
      // already stopped
    }
  }

  const tick = () => {
    try {
      const checks = new Map<string, (blockText: string) => boolean>()
      const now = deps.now()
      for (const block of [...blocks]) {
        try {
          if (!deps.isAlive(block.box)) {
            blocks.delete(block)
            continue
          }
          let check = checks.get(block.sessionID)
          if (!check) {
            check = deps.replyCheck(block.sessionID)
            checks.set(block.sessionID, check)
          }
          const frame = check(block.key) ? spinFrame(now) : PROGRESS_SYMBOL
          if (frame === block.frame) continue
          block.frame = frame
          for (const row of block.rows) deps.setContent(row.node, lineText(row.line, frame))
        } catch {
          blocks.delete(block)
        }
      }
    } finally {
      if (blocks.size === 0) halt()
    }
  }

  return {
    add(block) {
      blocks.add(block)
      if (!stopTimer) stopTimer = deps.every(tick, SPIN_INTERVAL_MS)
    },
    startFrame(sessionID, key) {
      try {
        return deps.replyCheck(sessionID)(key) ? spinFrame(deps.now()) : PROGRESS_SYMBOL
      } catch {
        return PROGRESS_SYMBOL
      }
    },
    stop() {
      blocks.clear()
      halt()
    },
    size: () => blocks.size,
  }
}

// What the host passes as the second argument: only defaultRender is used.
export type RenderHelpers = { defaultRender(): unknown }

export type MarkdownApi = {
  registerCodeBlockRenderer(language: string, render: (token: never, helpers: never) => unknown): () => void
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

// Builds the renderer function. It never throws: on any error the partly built box is destroyed and the
// default render is used, and if even that fails it returns undefined, which the host also treats as "default".
export function createStatoRenderer(deps: RenderDeps, spinner?: Spinner) {
  return (token: unknown, helpers: unknown): unknown => {
    let box: Box | undefined
    try {
      const lines = statoLines((token as { text?: unknown } | undefined)?.text)
      if (lines === null) return (helpers as RenderHelpers).defaultRender()
      // The theme is read on every call, so a theme change shows in the next render.
      const theme = deps.theme()
      box = deps.makeBox()
      // Only a block that has an in-progress line, and a session to look it up in, can spin.
      const sessionID = spinner && lines.some((line) => line.kind === "progress") ? safe(() => deps.spin?.session()) : undefined
      const key = blockKey(lines.map((line) => line.text).join("\n"))
      const frame = spinner && sessionID ? spinner.startFrame(sessionID, key) : PROGRESS_SYMBOL
      const rows: SpinRow[] = []
      for (const line of lines) {
        const node = deps.makeText(lineText(line, frame), colourFor(line.kind, theme))
        if (line.kind === "progress") rows.push({ node, line })
        box.add(node)
      }
      if (spinner && sessionID) spinner.add({ box, sessionID, key, rows, frame })
      return box
    } catch {
      try {
        box?.destroyRecursively()
      } catch {
        // already gone
      }
      try {
        return (helpers as RenderHelpers).defaultRender()
      } catch {
        return undefined
      }
    }
  }
}

// Registers the renderer and returns the function that removes it. Calling that function twice is safe.
// If the host refuses (the language is already taken, or the API is missing) nothing is registered and the
// returned function does nothing: the block keeps the default look.
export function registerStato(markdown: MarkdownApi | undefined, deps: RenderDeps): () => void {
  let unregister: (() => void) | undefined
  const spinner = deps.spin ? createSpinner(deps.spin) : undefined
  try {
    unregister = markdown?.registerCodeBlockRenderer(LANGUAGE, createStatoRenderer(deps, spinner) as never)
  } catch {
    unregister = undefined
  }
  return () => {
    const done = unregister
    unregister = undefined
    spinner?.stop()
    try {
      done?.()
    } catch {
      // the host is shutting down
    }
  }
}
