# agents-panel

A read-only OpenCode 2 plugin that lists the background subagents (child sessions) of the session you are looking at, in the sidebar. The interface text is in Italian.

## What you see

Under the other sidebar blocks, only when the session has child sessions:

```
Subagenti, 2 in corso
Cerca i test rotti
  in corso, da 3 min
Serve un permesso
  in attesa di permesso, da 40 s
Compito breve
  finito, 12 s fa
Prova che fallisce
  errore, 2 min fa
```

- Running agents first (newest start first), then the last 5 finished ones (newest end first). Every running or waiting agent is always shown.
- States: `in corso`, `in attesa di permesso`, `in attesa di risposta` (a form or question), `finito`, `errore`, `fermato` (interrupted).
- Time: `da 3 min` for something still running, `3 min fa` for something finished. It refreshes every 5 seconds.
- Click a row to open that child session.
- A child session with no title shows as `Subagente`.

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
- The events `session.execution.started|succeeded|failed|interrupted` give exact start and end times and tell an error from a normal end. OpenCode itself keeps no "failed" state, only `running` and `idle`, so an error is known only for runs this TUI saw. A child that failed before this TUI started reads as `finito`.

## Files

- `agents-core.ts`: pure logic (rows, order, states, Italian times).
- `tui.tsx`: the sidebar block and the event listeners. Cleans up its timer and listeners on reload.
- `index.ts`: an empty server part, so OpenCode loads the directory.
- `agents-core.test.ts`: `bun test`.

## Turn it off

- Set `AGENTS_PANEL_DISABLED=1` in the environment OpenCode starts with, or
- remove the `agents-panel` entry from `plugin` in `opencode.json`.
