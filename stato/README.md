# stato

An OpenCode 2 plugin that colours status lines in a fenced block with the language `stato`. Each line takes the colour of its first symbol:

| Symbol | Meaning | Theme colour |
| --- | --- | --- |
| `✓` | done | success |
| `✗` | broken or blocked | error |
| `◐` | in progress | warning |
| `➜` | next step | info |

`…` (the old in-progress symbol) and the other spin frames `◓ ◑ ◒` count as in progress too, so older messages keep their colour. A line with any other first character, and an empty line, is drawn in the normal text colour. Leading spaces are skipped, so an indented line keeps its colour. Only the first symbol counts. Long lines wrap like normal text.

````
```stato
✓ tests pass
✗ build fails: DATABASE_URL is missing
◐ checking the rest
➜ open the pull request
```
````

## The spinning ◐

An in-progress line turns through `◐ ◓ ◑ ◒`, four frames per second, but only in a block that is in the **latest assistant reply** of the session on screen. Every other in-progress line, in older replies, shows a still `◐` in the same warning colour, so an old "in progress" does not keep turning after the work is done. A `…` line is drawn as `◐` too (still or spinning); the text of the message is not changed.

How it knows which reply a block is in: OpenCode hands a block renderer only the markdown token (the block text), with no message or part id. So the plugin reads the session's cached messages (`context.data.session.message.list`) and looks for the block text in the `stato` blocks of the assistant replies.

- The latest reply is the last visible assistant message that has text. A newer step with only tool calls does not stop the one before it, and a message you reverted (and everything after it) is ignored.
- A block spins only if its exact text is in the latest reply and in no older reply. If the same text is in an older reply too, the plugin cannot tell which one is on screen, so it stays still. It never spins "just in case".
- If there is no session on screen, or the messages cannot be read, the `◐` stays still.
- One shared timer (250 ms) serves every spinning block. It starts with the first one, stops by itself when the last one is gone, is cleared on `/reload` and when the plugin is cleaned up, and a tick never throws. Each tick looks at the messages once per session, not once per block.
- Cost: the tick sets the text of the spinning lines and OpenCode repaints. Measured in an idle OpenCode 2.2.6 TUI over 30 s windows, three alternations: about 1.7% of one core with a spinning block against about 0.7% without (see the pull request).

Colours come from the active theme (`context.theme.text.feedback.success|error|warning|info`), so they follow dark and light mode and any theme. With the apple theme in this repo, dark mode draws `#30d158`, `#ff453a`, `#ff9f0a` and `#64d2ff`, and light mode draws `#248a3d`, `#d70015`, `#c93400` and `#0071a4`. There are no colour values in the plugin.

## What it reads and sends

- Reads: the text of the `stato` block, the theme's colour tokens, and (only to decide which blocks spin) the text parts of the assistant messages already cached in the TUI for the session on screen.
- Sends: nothing. No network, no files read or written, no log of the block text.

## Safety

- The renderer never throws. If a block cannot be drawn (empty, over 500 lines, any error), OpenCode's default code-block rendering is used instead.
- The spinner timer is stopped when the plugin is cleaned up.
- The renderer is removed when the plugin is cleaned up, so `/reload` registers it once, not twice.

## Install

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Add the `stato` folder to `plugin` in `~/.config/opencode/opencode.json` (absolute path), then run `/reload`:

```json
{ "plugin": ["/Users/you/opencode-plugins/stato"] }
```

If you edit the plugin files, `/reload` picks them up.

## Turn it off

- For one run: start OpenCode with `STATO_DISABLED=1`. The plugin registers nothing and `stato` blocks look like any other code block.
- For good: remove the `stato` folder from `plugin` in `opencode.json` and run `/reload`.

## Tell the model to use it

The plugin only draws the block. To have the assistant write status replies in it, say so in your `AGENTS.md`, for example: "Put each status line in a ```stato block, starting with ✓ done, ✗ broken, ◐ in progress or ➜ next step."

## Files

- `stato-core.ts` pure logic: line meaning, block splitting, colour choice, spin frames, which blocks are in the latest reply.
- `stato-render.ts` the renderer, the shared spinner and the registration, with the OpenTUI classes passed in (tested with fakes).
- `tui.ts` TUI part: hands in the real OpenTUI classes, the route, the cached messages and the timer.
- `index.ts` server part, empty on purpose, so OpenCode loads the folder as a plugin.
- `stato-core.test.ts`, `stato-render.test.ts` tests: `bun test`.
