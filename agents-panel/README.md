# agents-panel

A read-only OpenCode 2 plugin that lists the background subagents (child sessions) of the session you are looking at, in the sidebar. The interface text is in Italian.

## What you see

Under the other sidebar blocks, only while the session has subagents. A session with none shows nothing.

```
Subagenti             1 ti aspetta

! Ti aspetta
  Opus     rilettura #103    da 2m
           └ chiede un permesso

▗ Al lavoro
  Sonnet   #90 allineamento    12m
           └ esegue make
  Sonnet   citazioni            4m
           └ legge agents-core.ts

✓ Finiti
  Opus     rilettura plugin  3m fa
✗ Sonnet   #103 correzioni  20m fa
```

- Header: `Subagenti` in bold, like the titles of OpenCode's own sidebar blocks, and on the right the one fact that matters now: `1 ti aspetta` or `2 ti aspettano` in the "waits for you" colour, else `2 al lavoro` in grey, else nothing.
- Groups appear only when they have rows: `Ti aspetta` (a permission or a question is pending), `Al lavoro` (running, with a spinner), `Finiti` (the last 3; an error gets a red cross).
- Each row: model (Opus, Sonnet, Haiku, Fable, else the first word of the model id), the task name cut with `…` to fit, and the time on the right.
- The time says what it measures. `12m`: at work for 12 minutes. `3m fa`: finished 3 minutes ago. `da 2m`: has waited for you for 2 minutes, counted from the moment the permission or the question was asked, not from the start of the run. The agent that has waited longest comes first. A request asked before this window opened has no known start, so its row shows no time.
- Times are written `<1m`, `12m`, `1h 5m`, `2g 3h`, as in the other plugins. A time that would leave the name fewer than 4 characters is left out.
- The line under a row: `chiede un permesso` or `ha una domanda` for a waiting agent, what a running one is doing, in Italian: `legge file.ts`, `modifica file.ts`, `scrive file.ts`, `cerca nei file`, `cerca sul web`, `apre example.com`, `usa la skill tdd`, `esegue make`, `esegue uno script`, `usa uno strumento`. A shell call shows the agent's own short description if it gave one, else only the program name, never the command line, which can hold a token. A search never shows its pattern or query.
- At most 10 rows. Waiting and running agents come first and are never hidden by finished ones; if they alone are more than 10, a line `+N altri` counts the rest.
- Click a row to open that child session.
- The text adapts to the measured sidebar width, also after a resize: below 24 columns the model column goes (the name takes the model colour), below 14 the time goes too. Lines are always cut with `…`, never wrapped.
- Colours come from the active theme, one meaning each: orange waits for you, green finished, red failed. A model has a fixed hue of its own (Opus blue, Sonnet cyan, Haiku yellow, Fable purple), never one of those three. If the panel cannot be drawn it shows `Subagenti: non disponibile` in the faint colour.

## Install

Needs OpenCode 2.2 or later.

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Add the `agents-panel` folder to `plugin` in `~/.config/opencode/opencode.json` (absolute path):

```json
{ "plugin": ["/Users/you/opencode-plugins/agents-panel"] }
```

Run `/reload`. OpenCode 2.2 loads only directories as plugins, so keep every file in this folder.

## Where the data comes from

All of it is already in OpenCode's TUI data store, through the documented plugin API. Nothing is read from disk and nothing is sent anywhere.

- `data.session.family(sessionID)`, `get(id)` and `status(id)` give the child sessions, their title, `time.created`, `time.idle` and `running` or `idle`.
- `data.session.permission.list(id)` and `form.list(id)` tell if a child is waiting for you. The events `permission.asked`, `permission.replied`, `form.created`, `form.replied` and `form.cancelled` tell since when.
- The events `session.execution.started|succeeded|failed|interrupted` give exact start and end times and tell an error from a normal end. OpenCode itself keeps no "failed" state, only `running` and `idle`, so an error is known only for runs this TUI saw. A child that failed before this TUI started reads as finished.
- `session.step.started` gives the model of a child, and `session.tool.input.started` plus `session.tool.called` give its latest tool call. No message of a child is ever read.

## Files

- `agents-core.ts`: pure logic (layout, alignment, truncation, groups, row cap, times, the wording of a tool call, the model hues).
- `tui.tsx`: the sidebar block and the event listeners. One shared spinner timer that runs only while something works. Cleans up its timers and listeners on reload.
- `index.ts`: an empty server part, so OpenCode loads the directory.
- `agents-core.test.ts`: `bun test`.

## Turn it off

- Set `AGENTS_PANEL_DISABLED=1` in the environment OpenCode starts with, or
- remove the `agents-panel` entry from `plugin` in `opencode.json`.
