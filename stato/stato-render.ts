// The renderer and its registration, with the OpenTUI classes passed in. That keeps this file free of
// OpenTUI imports, so the fallbacks and the unregister logic are tested with plain fakes (see the test file).
// ./tui.ts is the only place that hands in the real classes.
import { colourFor, rowText, statoLines, type StatoTheme } from "./stato-core.ts"

export const LANGUAGE = "stato"

export type Box = { add(child: unknown): unknown; destroyRecursively(): void }

export type RenderDeps = {
  makeBox(): Box
  makeText(content: string, fg: unknown): unknown
  theme(): StatoTheme | undefined
}

// What the host passes as the second argument: only defaultRender is used.
export type RenderHelpers = { defaultRender(): unknown }

export type MarkdownApi = {
  registerCodeBlockRenderer(language: string, render: (token: never, helpers: never) => unknown): () => void
}

// Builds the renderer function. It never throws: on any error the partly built box is destroyed and the
// default render is used, and if even that fails it returns undefined, which the host also treats as "default".
export function createStatoRenderer(deps: RenderDeps) {
  return (token: unknown, helpers: unknown): unknown => {
    let box: Box | undefined
    try {
      const lines = statoLines((token as { text?: unknown } | undefined)?.text)
      if (lines === null) return (helpers as RenderHelpers).defaultRender()
      // The theme is read on every call, so a theme change shows in the next render.
      const theme = deps.theme()
      box = deps.makeBox()
      for (const line of lines) box.add(deps.makeText(rowText(line.text), colourFor(line.kind, theme)))
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
  try {
    unregister = markdown?.registerCodeBlockRenderer(LANGUAGE, createStatoRenderer(deps) as never)
  } catch {
    unregister = undefined
  }
  return () => {
    const done = unregister
    unregister = undefined
    try {
      done?.()
    } catch {
      // the host is shutting down
    }
  }
}
