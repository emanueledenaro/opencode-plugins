# notify

An OpenCode 2 plugin that pings you, only when the terminal is not focused, when OpenCode needs you. The text is in Italian.

## When it pings

| Event | Text | Sound |
| --- | --- | --- |
| The main session finishes a reply | `OpenCode: ho finito` | `done` |
| A permission is asked (any session, also a subagent) | `OpenCode: serve un permesso` | `permission` |
| A form or question waits for you (any session) | `OpenCode: serve una risposta` | `question` |

- A child session (background subagent) finishing is silent on purpose.
- At most one ping every 20 seconds. A ping that was not delivered (terminal focused) does not use up the 20 seconds.
- Each permission or question pings once, until it is answered.
- An interrupted or failed run is silent.

## Install

Needs OpenCode 2.2 or later.

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Add the `notify` folder to `plugin` in `~/.config/opencode/opencode.json` (absolute path):

```json
{ "plugin": ["/Users/you/opencode-plugins/notify"] }
```

Run `/reload`.

## How it works, and what it depends on

It calls `context.attention.notify` (documented) with `when: "blurred"` for both the notification and the sound. That API decides, not this plugin:

- The notification is sent to your terminal with a terminal escape code, not through macOS directly. It shows only if your terminal supports it. If it does not, you still get the sound.
- "Blurred" comes from the terminal's focus reports. If the terminal never reports focus (for example inside tmux without `focus-events on`), OpenCode answers `skipped: "focus_unknown"` and nothing is played.
- The sound uses `attention` in `cli.json` (`sound`, `volume`, `sounds`).

OpenCode also has a built-in notification plugin (`opencode.notifications`) that pings on a finished session, a permission and a question. If you use both you get two pings. Turn the built-in off with `"plugins": ["-opencode.notifications"]` in `cli.json` (or in `/plugins`), not with `attention`, which also silences this plugin. You then lose the built-in's "Session failed" toast.

Unlike the built-in one, this plugin pings when the main session finishes a reply even while background subagents still run, and it pings for permissions asked by subagents.

## Files

- `notify-core.ts`: pure logic (which event pings, the text, the 20 second gate).
- `tui.tsx`: the event listeners and the call to `attention.notify`.
- `index.ts`: an empty server part, so OpenCode loads the directory.
- `notify-core.test.ts`: `bun test`.

## Turn it off

- Set `NOTIFY_DISABLED=1` in the environment OpenCode starts with, or
- remove the `notify` entry from `plugin` in `opencode.json`.

For debugging, `NOTIFY_DEBUG_FILE=/some/file` appends one line per event with what `attention.notify` answered. It never writes session text.
