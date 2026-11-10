# agents-panel

A read-only OpenCode 2 plugin that lists the background subagents (child sessions) of the session you are looking at, in the sidebar. The interface text is in Italian.

## What you see

Under the other sidebar blocks, always. The interface text is in Italian.

```
SUBAGENTI                           3

⚠ Ti aspetta
  Opus     rilettura #103         2m
           └ chiede un permesso

⠹ Al lavoro
  Sonnet   #90 allineamento      12m
           └ make
  Sonnet   citazioni              4m
           └ bun

✓ Finiti
  Opus     rilettura plugin   3m fa
✗ Sonnet   #103 correzioni   20m fa
```

- Header: the number of agents that wait for you or work. Groups appear only when they have rows: `Ti aspetta` (a permission or a question is pending), `Al lavoro` (running, with a spinner), `Finiti` (the last 3; an error gets a red cross).
- Each row: model (Opus, Sonnet, Haiku, Fable, else the first word of the model id) in a fixed colour per model, the task name cut with `…` to fit, and the time on the right. It refreshes every 5 seconds.
- The line under a row: `chiede un permesso` or `ha una domanda` for a waiting agent, the latest tool call for a running one: the agent's short description of a shell call, or only the program name (`make`, `bun`), never the command line, which can hold a token; file tools show the file name; search tools show only their name.
- At most 10 rows. Waiting and running agents come first and are never hidden by finished ones; if they alone are more than 10, a line `+N altri` counts the rest.
- Click a row to open that child session. With no children the block shows `Nessun subagente`.
- The text adapts to the sidebar width. Colours come from the active theme.

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
- `data.session.permission.list(id)` and `form.list(id)` tell if a child is waiting for you.
- The events `session.execution.started|succeeded|failed|interrupted` give exact start and end times and tell an error from a normal end. OpenCode itself keeps no "failed" state, only `running` and `idle`, so an error is known only for runs this TUI saw. A child that failed before this TUI started reads as finished.
- `session.step.started` gives the model of a child, and `session.tool.input.started` plus `session.tool.called` give its latest tool call. No message of a child is ever read.

## Files

- `agents-core.ts`: pure logic (layout, alignment, truncation, groups, row cap, times).
- `tui.tsx`: the sidebar block and the event listeners. One shared spinner timer that runs only while something works. Cleans up its timers and listeners on reload.
- `index.ts`: an empty server part, so OpenCode loads the directory.
- `agents-core.test.ts`: `bun test`.

## Turn it off

- Set `AGENTS_PANEL_DISABLED=1` in the environment OpenCode starts with, or
- remove the `agents-panel` entry from `plugin` in `opencode.json`.
