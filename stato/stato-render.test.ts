import { describe, expect, test } from "bun:test"
import { LANGUAGE, createSpinner, createStatoRenderer, registerStato, type RenderDeps, type SpinDeps } from "./stato-render"

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

// ---- The spinner ----
// A fake host for the spinner: a manual clock and timer, a set of destroyed boxes, a session whose latest reply
// holds `latest` block texts, and a record of every content change.
function spinFakes(options: { session?: string | undefined; latest?: Set<string> } = {}) {
  const state = {
    now: 0,
    session: "session" in options ? options.session : ("s1" as string | undefined),
    latest: options.latest ?? new Set<string>(),
    destroyed: new Set<unknown>(),
    timers: 0,
    stopped: 0,
    run: undefined as (() => void) | undefined,
    ms: 0,
    checks: [] as string[],
    set: [] as { node: unknown; content: string }[],
  }
  const spin: SpinDeps = {
    session: () => state.session,
    replyCheck: (sessionID) => {
      state.checks.push(sessionID)
      return (text) => state.latest.has(text)
    },
    setContent: (node, content) => {
      ;(node as { content: string }).content = content
      state.set.push({ node, content })
    },
    isAlive: (node) => !state.destroyed.has(node),
    every: (run, ms) => {
      state.timers++
      state.run = run
      state.ms = ms
      return () => {
        state.stopped++
        state.run = undefined
      }
    },
    now: () => state.now,
  }
  const { deps, made } = fakes({ spin })
  const markdown = fakeMarkdown()
  const stop = registerStato(markdown.api as never, deps)
  const render = markdown.registry.get("stato") as (token: unknown, helpers: unknown) => { children: { content: string }[] }
  const tick = (ms: number) => {
    state.now += ms
    state.run?.()
  }
  const draw = (text: string) => render({ text }, helpers)
  return { state, made, stop, markdown, tick, draw }
}

describe("spinner", () => {
  test("a block in the latest reply starts on the current frame and turns once per tick, in step", () => {
    const { state, tick, draw } = spinFakes({ latest: new Set(["◐ a\n✓ b"]) })
    state.now = 0
    const box = draw("◐ a\n✓ b")
    expect(box.children.map((child) => child.content)).toEqual(["◐ a", "✓ b"])
    expect(state.ms).toBe(250)
    const seen: string[] = []
    for (let step = 0; step < 5; step++) {
      tick(250)
      seen.push(box.children[0]!.content)
    }
    expect(seen).toEqual(["◓ a", "◑ a", "◒ a", "◐ a", "◓ a"])
    expect(box.children[1]!.content).toBe("✓ b")
  })
  test("a block drawn mid-stream starts on the frame already showing, not on a reset ◐", () => {
    const { state, draw } = spinFakes({ latest: new Set(["… a"]) })
    state.now = 500
    expect(draw("… a").children[0]!.content).toBe("◑ a")
  })
  test("an old `…` line spins as ◐ ◓ ◑ ◒ too", () => {
    const { state, tick, draw } = spinFakes({ latest: new Set(["… a"]) })
    const box = draw("… a")
    tick(250)
    expect(box.children[0]!.content).toBe("◓ a")
    expect(state.set).toHaveLength(1)
  })
  test("a block that is not in the latest reply stays on a still ◐ and sets no content", () => {
    const { state, tick, draw } = spinFakes({ latest: new Set(["◐ altro"]) })
    state.now = 750
    const box = draw("… a")
    tick(250)
    tick(250)
    expect(box.children[0]!.content).toBe("◐ a")
    expect(state.set).toHaveLength(0)
  })
  test("when a newer reply arrives, the older block goes back to ◐ on the next tick", () => {
    const { state, tick, draw } = spinFakes({ latest: new Set(["◐ a"]) })
    const box = draw("◐ a")
    tick(250)
    expect(box.children[0]!.content).toBe("◓ a")
    state.latest = new Set(["◐ nuovo"])
    tick(250)
    expect(box.children[0]!.content).toBe("◐ a")
    tick(250)
    tick(250)
    expect(box.children[0]!.content).toBe("◐ a")
  })
  test("two blocks in two replies: only the one in the latest reply turns", () => {
    const { state, tick, draw } = spinFakes({ latest: new Set(["◐ nuovo"]) })
    const old = draw("◐ vecchio")
    const fresh = draw("◐ nuovo")
    tick(250)
    expect(old.children[0]!.content).toBe("◐ vecchio")
    expect(fresh.children[0]!.content).toBe("◓ nuovo")
    expect(state.timers).toBe(1)
  })
  test("one shared timer for every spinning block, and one message lookup per session per tick", () => {
    const { state, tick, draw } = spinFakes({ latest: new Set(["◐ a", "◐ b", "◐ c"]) })
    draw("◐ a")
    draw("◐ b")
    draw("◐ c")
    expect(state.timers).toBe(1)
    state.checks.length = 0
    tick(250)
    expect(state.checks).toEqual(["s1"])
  })
  test("blocks of different sessions are looked up in their own session", () => {
    const { state, tick, draw } = spinFakes({ latest: new Set(["◐ a"]) })
    draw("◐ a")
    state.session = "s2"
    draw("◐ a")
    state.checks.length = 0
    tick(250)
    expect(state.checks.sort()).toEqual(["s1", "s2"])
  })
  test("blocks without an in-progress line, or without a session on screen, never start the timer", () => {
    const quiet = spinFakes({ latest: new Set(["✓ a"]) })
    quiet.draw("✓ a")
    expect(quiet.state.timers).toBe(0)
    const none = spinFakes({ session: undefined, latest: new Set(["◐ a"]) })
    expect(none.draw("◐ a").children[0]!.content).toBe("◐ a")
    expect(none.state.timers).toBe(0)
  })
  test("the timer stops itself when the last spinning block is destroyed", () => {
    const { state, tick, draw, made } = spinFakes({ latest: new Set(["◐ a", "◐ b"]) })
    draw("◐ a")
    draw("◐ b")
    state.destroyed.add(made.boxes[0]!)
    tick(250)
    expect(state.stopped).toBe(0)
    state.destroyed.add(made.boxes[1]!)
    tick(250)
    expect(state.stopped).toBe(1)
    expect(state.run).toBeUndefined()
  })
  test("a destroyed block is no longer updated", () => {
    const { state, tick, draw, made } = spinFakes({ latest: new Set(["◐ a"]) })
    const box = draw("◐ a")
    state.destroyed.add(made.boxes[0]!)
    tick(250)
    expect(box.children[0]!.content).toBe("◐ a")
    expect(state.set).toHaveLength(0)
  })
  test("a block drawn again while streaming replaces the old one: the old box is dropped, one timer remains", () => {
    const { state, tick, draw, made } = spinFakes({ latest: new Set(["◐ a", "◐ a\n◐ b"]) })
    draw("◐ a")
    state.destroyed.add(made.boxes[0]!)
    const second = draw("◐ a\n◐ b")
    tick(250)
    expect(second.children.map((child) => child.content)).toEqual(["◓ a", "◓ b"])
    expect(made.boxes[0]!.children[0]).toEqual({ content: "◐ a", fg: "WARN" })
    expect(state.timers).toBe(1)
  })
  test("the timer starts again for a block drawn after it stopped", () => {
    const { state, tick, draw, made } = spinFakes({ latest: new Set(["◐ a"]) })
    draw("◐ a")
    state.destroyed.add(made.boxes[0]!)
    tick(250)
    draw("◐ a")
    expect(state.timers).toBe(2)
    expect(state.run).toBeDefined()
  })
  test("cleanup (and so /reload) stops the timer and forgets every block", () => {
    const { state, stop, draw } = spinFakes({ latest: new Set(["◐ a"]) })
    draw("◐ a")
    stop()
    expect(state.stopped).toBe(1)
    expect(state.run).toBeUndefined()
    stop()
    expect(state.stopped).toBe(1)
  })
  test("a block with trailing blank lines is matched to the reply text without them", () => {
    const { state, draw } = spinFakes({ latest: new Set(["◐ a"]) })
    state.now = 250
    expect(draw("◐ a\n\n").children[0]!.content).toBe("◓ a")
  })
  test("stop() empties the spinner, so a block added before it is not updated after it", () => {
    const calls: string[] = []
    const spinner = createSpinner({
      session: () => "s1",
      replyCheck: () => () => true,
      setContent: (_node, content) => calls.push(content),
      isAlive: () => true,
      every: () => () => undefined,
      now: () => 250,
    })
    spinner.add({ box: {} as never, sessionID: "s1", key: "◐ a", rows: [{ node: {}, line: { text: "◐ a", kind: "progress" } }], frame: "◐" })
    expect(spinner.size()).toBe(1)
    spinner.stop()
    expect(spinner.size()).toBe(0)
  })
  test("a tick that fails never throws, drops that block and the timer stops when none is left", () => {
    const { state, draw } = spinFakes({ latest: new Set(["◐ a"]) })
    draw("◐ a")
    state.latest = undefined as never
    expect(() => state.run!()).not.toThrow()
    expect(state.stopped).toBe(1)
  })
  test("when the message lookup fails at draw time the block stays on a still ◐ and is still drawn", () => {
    const { deps } = fakes()
    const spinner = createSpinner({
      session: () => "s1",
      replyCheck: () => {
        throw new Error("no data")
      },
      setContent: () => undefined,
      isAlive: () => true,
      every: () => () => undefined,
      now: () => 0,
    })
    expect(spinner.startFrame("s1", "◐ a")).toBe("◐")
    expect(createStatoRenderer(deps, spinner)({ text: "◐ a" }, helpers)).toBeDefined()
  })
  test("when the session lookup throws at draw time the block is drawn still", () => {
    const { deps, made } = fakes({
      spin: {
        session: () => {
          throw new Error("no route")
        },
        replyCheck: () => () => true,
        setContent: () => undefined,
        isAlive: () => true,
        every: () => () => undefined,
        now: () => 0,
      },
    })
    const markdown = fakeMarkdown()
    registerStato(markdown.api as never, deps)
    const render = markdown.registry.get("stato") as (token: unknown, helpers: unknown) => unknown
    expect(render({ text: "… a" }, helpers)).toBe(made.boxes[0]!)
    expect(made.boxes[0]!.children[0]).toEqual({ content: "◐ a", fg: "WARN" })
  })
  test("without the spin dependency a progress line is a still ◐", () => {
    const { deps } = fakes()
    const markdown = fakeMarkdown()
    registerStato(markdown.api as never, deps)
    const box = (markdown.registry.get("stato") as Function)({ text: "… a" }, helpers) as { children: unknown[] }
    expect(box.children[0]).toEqual({ content: "◐ a", fg: "WARN" })
  })
})
