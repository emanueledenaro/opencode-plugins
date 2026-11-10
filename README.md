# opencode-plugins

Small local plugins for OpenCode 2. Each folder is one plugin: point OpenCode at the folder and run `/reload`.

| Plugin | What it does |
| --- | --- |
| [claude-usage](claude-usage/) | Shows your Claude subscription usage (5-hour and weekly window) as coloured meters under the prompt, plus a `/claude-usage` dialog. Read only. |
| [ask-box](ask-box/) | Keeps the assistant's last `Serve da te:` block visible in the sidebar until you answer. Read only. |
| [plan-banner](plan-banner/) | Warns above the prompt when the assistant's last reply ran under the Plan agent. Read only. |
| [quote](quote/) | Highlight text in the chat, press `ctrl+y`, and it is attached as a quote to your next message, with your comment underneath. Italian interface. |
| [agents-panel](agents-panel/) | Sidebar list of the session's background subagents: title, state (running, finished, error, waiting for permission) and how long ago. Read only. |
| [apple-theme](apple-theme/) | Not a plugin: a colour theme with the macOS system colours, dark and light, with a transparent background. |
| [notify](notify/) | A notification and a short sound when the terminal is not focused and OpenCode finished a reply, asks a permission or waits for an answer. At most one per 20 s. |
| [token-rate](token-rate/) | Shows the last reply's output speed (`42 tok/s`) beside the other footer items, and logs each measurement. |
| [stato](stato/) | Fenced `stato` blocks in the chat get one theme colour per line, chosen by its first symbol: `✓` green, `✗` red, `◐` the warning colour (it spins in the latest reply), `➜` the info colour. Reads the block text and the cached messages of the session on screen. |

## Install a plugin

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Add the plugin folder to `plugin` in `~/.config/opencode/opencode.json`, with an absolute path:

```json
{ "plugin": ["/Users/you/opencode-plugins/claude-usage"] }
```

OpenCode 2.2 loads only directories as plugins, and reloads only the files inside the plugin folder. Each plugin's README says what it reads, what it sends and how to turn it off.

## Tests

```sh
cd claude-usage && bun test   # same in agents-panel, ask-box, notify, plan-banner, quote, stato, token-rate
```
