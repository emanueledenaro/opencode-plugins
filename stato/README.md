# stato

An OpenCode 2 plugin that colours status lines in a fenced block with the language `stato`. Each line takes the colour of its first symbol:

| Symbol | Meaning | Theme colour |
| --- | --- | --- |
| `✓` | done | success |
| `✗` | broken or blocked | error |
| `…` | in progress | warning |
| `➜` | next step | info |

A line with any other first character, and an empty line, is drawn in the normal text colour. Leading spaces are skipped, so an indented line keeps its colour. Only the first symbol counts. Long lines wrap like normal text.

````
```stato
✓ tests pass
✗ build fails: DATABASE_URL is missing
… checking the rest
➜ open the pull request
```
````

Colours come from the active theme (`context.theme.text.feedback.success|error|warning|info`), so they follow dark and light mode and any theme. With the apple theme in this repo, dark mode draws `#30d158`, `#ff453a`, `#ff9f0a` and `#64d2ff`, and light mode draws `#248a3d`, `#d70015`, `#c93400` and `#0071a4`. There are no colour values in the plugin.

## What it reads and sends

- Reads: only the text of the `stato` block, and the theme's colour tokens.
- Sends: nothing. No network, no files read or written, no log of the block text.

## Safety

- The renderer never throws. If a block cannot be drawn (empty, over 500 lines, any error), OpenCode's default code-block rendering is used instead.
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

The plugin only draws the block. To have the assistant write status replies in it, say so in your `AGENTS.md`, for example: "Put each status line in a ```stato block, starting with ✓ done, ✗ broken, … in progress or ➜ next step."

## Files

- `stato-core.ts` pure logic: line meaning, block splitting, colour choice.
- `stato-render.ts` the renderer and its registration, with the OpenTUI classes passed in (tested with fakes).
- `tui.ts` TUI part: hands in the real OpenTUI classes.
- `index.ts` server part, empty on purpose, so OpenCode loads the folder as a plugin.
- `stato-core.test.ts`, `stato-render.test.ts` tests: `bun test`.
