# ask-box

A read-only OpenCode 2 plugin that keeps the last thing the assistant asked you visible in the sidebar. The interface text is in Italian.

## What you see

When an assistant reply contains a line that starts with `Serve da te:` (optionally in bold, optionally followed by a numbered list), the sidebar shows a block titled `Serve da te` with that text: markdown removed, wrapped at the measured sidebar width, at most 8 lines in a normal sidebar and up to 12 in a very narrow one so the shown text stays about the same (a cut ends with `…`).

The block disappears as soon as you send a new message after that reply. If the next reply has a new `Serve da te:` line, it shows again. The last `Serve da te:` in a reply wins. Text that comes after a blank line and is not a list is not part of the block.

It does nothing unless your assistant writes that line. It only matches the exact words `Serve da te`.

## Install

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Add the `ask-box` folder to `plugin` in `~/.config/opencode/opencode.json` (absolute path):

```json
{ "plugin": ["/Users/you/opencode-plugins/ask-box"] }
```

Run `/reload` in OpenCode. OpenCode 2.2 loads only directories as plugins and reloads only the files inside the plugin directory, so keep every file here.

## What it reads

Only `context.data.session.message.list(sessionID)` for the session on screen: your messages (to know when you answered) and the text parts of assistant messages. It writes nothing, sends nothing, makes no network request and no model call.

## Limits

- It lives in the sidebar. If your terminal is too narrow for the sidebar, or you hid it, you do not see it.
- A message you queued while the assistant was still working counts once OpenCode delivers it, not when you press Enter.
- A message with only attachments also counts as an answer.

## Files

- `ask-box-core.ts`: pure logic (find the block, strip markdown, wrap, cap, decide whether to show).
- `ask-box-core.test.ts`: `bun test`.
- `tui.tsx`: the sidebar slot.
- `index.ts`: an empty server part, so OpenCode loads the directory.

## Turn it off

- Set `ASK_BOX_DISABLED=1` in the environment OpenCode starts with, or
- remove the `ask-box` entry from `plugin` in `opencode.json`.
