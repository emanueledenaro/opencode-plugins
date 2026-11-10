import { describe, expect, test } from "bun:test"
import { LANGUAGE, createStatoRenderer, registerStato, type RenderDeps } from "./stato-render"

const theme = {
  text: {
    base: "BASE",
    feedback: { success: { base: "OK" }, error: { base: "ERR" }, warning: { base: "WARN" }, info: { base: "INFO" } },
  },
}

// Fake OpenTUI: a box that remembers its children and whether it was destroyed.
function fakes(overrides: Partial<RenderDeps> = {}) {
  const made = { boxes: [] as { children: unknown[]; destroyed: boolean }[] }
  const deps: RenderDeps = {
    makeBox: () => {
      const box = {
        children: [] as unknown[],
        destroyed: false,
        add(child: unknown) {
          this.children.push(child)
        },
        destroyRecursively() {
          this.destroyed = true
        },
      }
      made.boxes.push(box)
      return box
    },
    makeText: (content, fg) => ({ content, fg }),
    theme: () => theme,
    ...overrides,
  }
  return { deps, made }
}

const DEFAULT = { default: true }
const helpers = { defaultRender: () => DEFAULT }

describe("createStatoRenderer", () => {
  test("draws one row per line, in the colour of its first symbol", () => {
    const { deps, made } = fakes()
    const result = createStatoRenderer(deps)({ text: "✓ a\n✗ b\n… c\n➜ d\ne\n" }, helpers)
    expect(result).toBe(made.boxes[0]!)
    expect(made.boxes[0]!.children).toEqual([
      { content: "✓ a", fg: "OK" },
      { content: "✗ b", fg: "ERR" },
      { content: "◐ c", fg: "WARN" },
      { content: "➜ d", fg: "INFO" },
      { content: "e", fg: "BASE" },
    ])
  })
  test("a ◐ line and a … line are both drawn with ◐ in the warning colour", () => {
    const { deps, made } = fakes()
    createStatoRenderer(deps)({ text: "◐ nuovo\n  … vecchio" }, helpers)
    expect(made.boxes[0]!.children).toEqual([
      { content: "◐ nuovo", fg: "WARN" },
      { content: "  ◐ vecchio", fg: "WARN" },
    ])
  })
  test("an empty line becomes a one-space row", () => {
    const { deps, made } = fakes()
    createStatoRenderer(deps)({ text: "✓ a\n\n✗ b" }, helpers)
    expect(made.boxes[0]!.children[1]).toEqual({ content: " ", fg: "BASE" })
  })
  test("the theme is read at every render, so a theme change shows", () => {
    let current: unknown = theme
    const { deps, made } = fakes({ theme: () => current as never })
    const render = createStatoRenderer(deps)
    render({ text: "✓ a" }, helpers)
    current = { text: { base: "B2", feedback: { success: { base: "OK2" } } } }
    render({ text: "✓ a" }, helpers)
    expect(made.boxes[0]!.children[0]).toEqual({ content: "✓ a", fg: "OK" })
    expect(made.boxes[1]!.children[0]).toEqual({ content: "✓ a", fg: "OK2" })
  })
  test("an empty block uses the default render and builds nothing", () => {
    const { deps, made } = fakes()
    expect(createStatoRenderer(deps)({ text: "" }, helpers)).toBe(DEFAULT)
    expect(made.boxes).toHaveLength(0)
  })
  test("a token without text uses the default render", () => {
    const { deps } = fakes()
    expect(createStatoRenderer(deps)({}, helpers)).toBe(DEFAULT)
    expect(createStatoRenderer(deps)(undefined, helpers)).toBe(DEFAULT)
  })
  test("when drawing a row throws, the half-built box is destroyed and the default render is used", () => {
    const { deps, made } = fakes({
      makeText: (content) => {
        if (content.startsWith("✗")) throw new Error("boom")
        return { content }
      },
    })
    expect(createStatoRenderer(deps)({ text: "✓ a\n✗ b" }, helpers)).toBe(DEFAULT)
    expect(made.boxes[0]!.destroyed).toBe(true)
  })
  test("when the theme read throws, the default render is used", () => {
    const { deps } = fakes({
      theme: () => {
        throw new Error("no theme")
      },
    })
    expect(createStatoRenderer(deps)({ text: "✓ a" }, helpers)).toBe(DEFAULT)
  })
  test("when the box cannot be made, the default render is used", () => {
    const { deps } = fakes({
      makeBox: () => {
        throw new Error("no renderer")
      },
    })
    expect(createStatoRenderer(deps)({ text: "✓ a" }, helpers)).toBe(DEFAULT)
  })
  test("when destroying the box also throws, the default render is still used", () => {
    const { deps } = fakes({
      makeBox: () => ({
        add() {
          throw new Error("add failed")
        },
        destroyRecursively() {
          throw new Error("destroy failed")
        },
      }),
    })
    expect(createStatoRenderer(deps)({ text: "✓ a" }, helpers)).toBe(DEFAULT)
  })
  test("when the default render throws too, it returns undefined and does not throw", () => {
    const { deps } = fakes({ makeBox: () => { throw new Error("x") } })
    const broken = {
      defaultRender: () => {
        throw new Error("default failed")
      },
    }
    expect(createStatoRenderer(deps)({ text: "✓ a" }, broken)).toBeUndefined()
    expect(createStatoRenderer(deps)({ text: "" }, broken)).toBeUndefined()
  })
})

// A registry that behaves like the host: a second registration for a language throws until it is removed.
function fakeMarkdown() {
  const registry = new Map<string, unknown>()
  return {
    registry,
    api: {
      registerCodeBlockRenderer(language: string, render: unknown) {
        if (registry.has(language)) throw new Error(`Markdown code-block renderer already registered: ${language}`)
        registry.set(language, render)
        return () => {
          registry.delete(language)
        }
      },
    },
  }
}

describe("registerStato", () => {
  test("registers the stato language", () => {
    const { deps } = fakes()
    const markdown = fakeMarkdown()
    registerStato(markdown.api as never, deps)
    expect([...markdown.registry.keys()]).toEqual([LANGUAGE])
    expect(LANGUAGE).toBe("stato")
  })
  test("the returned function unregisters it", () => {
    const { deps } = fakes()
    const markdown = fakeMarkdown()
    const stop = registerStato(markdown.api as never, deps)
    stop()
    expect(markdown.registry.size).toBe(0)
  })
  test("a reload (cleanup, then setup) registers it once", () => {
    const { deps } = fakes()
    const markdown = fakeMarkdown()
    registerStato(markdown.api as never, deps)()
    registerStato(markdown.api as never, deps)
    expect(markdown.registry.size).toBe(1)
  })
  test("cleanup twice is safe and a second cleanup does not remove a newer registration", () => {
    const { deps } = fakes()
    const markdown = fakeMarkdown()
    const first = registerStato(markdown.api as never, deps)
    first()
    registerStato(markdown.api as never, deps)
    first()
    expect(markdown.registry.size).toBe(1)
  })
  test("when the host refuses, nothing throws and the cleanup does not remove the other registration", () => {
    const { deps } = fakes()
    const markdown = fakeMarkdown()
    const other = () => undefined
    markdown.registry.set("stato", other)
    const stop = registerStato(markdown.api as never, deps)
    stop()
    expect(markdown.registry.get("stato")).toBe(other)
  })
  test("without a markdown API it does nothing and does not throw", () => {
    const { deps } = fakes()
    expect(() => registerStato(undefined, deps)()).not.toThrow()
  })
  test("a cleanup that throws in the host does not throw here", () => {
    const { deps } = fakes()
    const api = {
      registerCodeBlockRenderer: () => () => {
        throw new Error("host closing")
      },
    }
    expect(() => registerStato(api as never, deps)()).not.toThrow()
  })
  test("the registered function is the renderer", () => {
    const { deps, made } = fakes()
    const markdown = fakeMarkdown()
    registerStato(markdown.api as never, deps)
    const render = markdown.registry.get("stato") as (token: unknown, helpers: unknown) => unknown
    expect(render({ text: "✓ a" }, helpers)).toBe(made.boxes[0]!)
  })
})
