# opencode-plugins

Small local plugins for OpenCode 2. Each folder is one plugin: point OpenCode at the folder and run `/reload`.

| Plugin | What it does |
| --- | --- |
| [claude-usage](claude-usage/) | Shows your Claude subscription usage (5-hour and weekly window) as coloured meters under the prompt, the week coloured by its pace, plus a `/claude-usage` dialog. Read only. |
| [ask-box](ask-box/) | Keeps the assistant's last `Serve da te:` block visible in the sidebar until you answer, with how long it has waited. Read only. |
| [plan-banner](plan-banner/) | Warns above the prompt when the assistant's last reply ran under the Plan agent. Read only. |
| [quote](quote/) | Highlight text in the chat, press `ctrl+y`, and it is attached as a quote to your next message, with your comment underneath. Italian interface. |
| [agents-panel](agents-panel/) | Sidebar list of the session's background subagents: who waits for you and since when, who works and on what, the last ones finished. Read only. |
| [apple-theme](apple-theme/) | Not a plugin: a colour theme with the macOS system colours, dark and light, with a transparent background. |
| [notify](notify/) | A notification and a short sound when the terminal is not focused and OpenCode finished a reply, stopped on an error, asks a permission or waits for an answer, with the name of the session it is about. At most one per 20 s in each window. |
| [token-rate](token-rate/) | Shows the last reply's output speed (`42 tok/s`) beside the other footer items, and logs each measurement. |
| [stato](stato/) | Fenced `stato` blocks in the chat get one theme colour per line, chosen by its first symbol: `✓` green, `✗` red, `≈` the warning colour (`◐` and `…` still work), `➜` the info colour. Reads only the block text. |

## One look

The interface text is Italian. What the plugins share:

- Times are spans, never clock times, in one format: `<1m`, `12m`, `1h 5m`, `2g 3h`. With a word for what they measure: `12m` at work, `3m fa` finished, `da 2m` waiting for you, `si azzera tra 5g 2h`.
- Orange (the theme's warning colour) means one thing in every panel: it waits for you. The `Ti aspetta` group, the `Serve da te` title, the Plan line, `accesso scaduto, apri claude`. Green is finished or on pace, red is failed or over budget. Yellow (the theme's yellow hue) is caution with nothing for you to do: the middle of the usage meters, a reply slower than usual; in agents-panel, where no state is yellow, it is the Haiku label. Where a colour says a state, a word or a number says it too (`● giallo · ritmo 50% · 15 sopra`). `copies.test.ts` counts the places that read the warning colour.
- One exception, outside the panels: in a `stato` block in the chat, `≈` (in progress) is drawn in the warning colour. That is the mark's own colour in my status replies and it does not ask for anything.
- A clock that shows minutes moves every 30 seconds, in every panel that has one.
- A sidebar block has a bold title in sentence case, like OpenCode's own blocks, with a short state on its right, and is not drawn when it has nothing to say.
- A panel that cannot be drawn says `<name>: non disponibile` in the faint colour: `Subagenti: non disponibile`, `Serve da te: non disponibile`, `Citazioni: non disponibile`, `Avviso Plan: non disponibile`, `tok/s: non disponibile`, `Claude: uso non disponibile`.

## Install a plugin

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Add the plugin folder to `plugin` in `~/.config/opencode/opencode.json`, with an absolute path:

```json
{ "plugin": ["/Users/you/opencode-plugins/claude-usage"] }
```

OpenCode 2 loads only directories as plugins, and reloads only the files inside the plugin folder. Each plugin's README says what it reads, what it sends and how to turn it off.

## OpenCode version

Last checked on OpenCode 2.3.2 (2026-11-18). After each OpenCode upgrade, run:

```sh
bun check-host.ts   # or: bun check-host.ts /path/to/opencode
```

It reads the installed binary (read only, default `~/.opencode/bin/opencode`) and names every slot, event, footer id, API or sound name the plugins use that is gone; it then exits 1 (2 when the binary cannot be read). The plugins go quiet on a missing name instead of failing, so this is the only warning.

## Tests

```sh
cd claude-usage && bun test   # same in agents-panel, ask-box, notify, plan-banner, quote, stato, token-rate
bun test ./check-host.test.ts ./copies.test.ts   # at the root
```

OpenCode reloads only the files inside a plugin folder, so `createWidthTracker` is copied into five plugins, `createResizeWatch` into two and `relativeIt` (the time format) into three. `copies.test.ts` fails when one copy differs from the others, and when a plugin's "cannot be drawn" line leaves the shared wording or the faint colour.
