# plan-banner

A read-only OpenCode 2 plugin that shows a one-line warning above the prompt while the assistant's last reply in the session ran under the `plan` agent. The interface text is in Italian.

## What you see

```
La mia ultima risposta era in Plan: per farmi lavorare premi Shift+Tab e scrivimi.
```

The sentence follows the width of the prompt: the full text, then shorter wordings (`Plan: premi Shift+Tab`), then just `Plan`, and nothing when even that does not fit. The key comes from the binding of the `agent.cycle` command (`context.keymap.shortcuts("agent.cycle")`), so it follows your keymap. If it cannot be read, it says `Shift+Tab`. The line disappears once a reply arrives under another agent. Nothing is shown when the last reply came from any agent other than `plan`.

## Why it says "last reply"

OpenCode 2.2.6 does not give plugins the agent currently selected in the prompt. The session's own `agent` only changes when a message is sent. The one thing a plugin can confirm is the `agent` field on each assistant message in `context.data.session.message.list(sessionID)`. So the banner states only that: the agent of the last reply.

What this means in practice:

- After you press Shift+Tab to leave Plan, the banner stays until the next reply arrives under the new agent. It is still true (the last reply was in Plan), but the prompt may already say Build.
- After you switch to Plan, the banner does not appear until the first Plan reply.

## Install

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Add the `plan-banner` folder to `plugin` in `~/.config/opencode/opencode.json` (absolute path):

```json
{ "plugin": ["/Users/you/opencode-plugins/plan-banner"] }
```

Run `/reload` in OpenCode. OpenCode 2.2 loads only directories as plugins and reloads only the files inside the plugin directory, so keep every file here.

## What it reads

Only `context.data.session.message.list(sessionID)` (the `agent` field of assistant messages) and the shortcut list of `agent.cycle`. It writes nothing, sends nothing, makes no network request and no model call.

## Files

- `plan-banner-core.ts`: pure logic (last reply agent, show or not, key label, text).
- `plan-banner-core.test.ts`: `bun test`.
- `tui.tsx`: the `session.composer.top` slot.
- `index.ts`: an empty server part, so OpenCode loads the directory.

## Turn it off

- Set `PLAN_BANNER_DISABLED=1` in the environment OpenCode starts with, or
- remove the `plan-banner` entry from `plugin` in `opencode.json`.
