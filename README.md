# opencode-plugins

Small local plugins for OpenCode 2. Each folder is one plugin: point OpenCode at the folder and run `/reload`.

| Plugin | What it does |
| --- | --- |
| [claude-usage](claude-usage/) | Shows your Claude subscription usage (5-hour and weekly window) as coloured meters under the prompt, plus a `/claude-usage` dialog. Read only. |

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
cd claude-usage && bun test
```
