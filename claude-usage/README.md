# claude-usage

A read-only OpenCode 2 plugin that shows how much of your Claude subscription you have used: the 5-hour window and the weekly window, each with a percentage and a reset time. The interface text is in Italian.

## What you see

- Under the prompt, always: two small coloured meters, `5h ▰▰▱▱▱▱ 23%   sett ▰▰▰▰▰▰ 96%`. Green under 70%, yellow from 70%, red above 90%. `libero` means no 5-hour window is open.
- Above 90% weekly, one warning toast the first time it crosses.
- `/claude-usage` (alias `/usage`, also in the Ctrl+P palette) refreshes and opens a dialog with both windows, when each one resets, and the last error if there was one.
- `(vecchio)` after the meters means the last refresh failed and the numbers are old. `accesso scaduto, apri claude` means the Claude Code login has expired.

## Install

macOS only (the token is read from the macOS keychain). Needs OpenCode 2.2 or later and a Claude Code login (`claude` signed in with a Pro, Max or Ultra plan).

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Then add the `claude-usage` folder to `plugin` in `~/.config/opencode/opencode.json` (absolute path):

```json
{ "plugin": ["/Users/you/opencode-plugins/claude-usage"] }
```

Run `/reload` in OpenCode. OpenCode 2.2 loads only directories as plugins, and it reloads only the files inside the plugin directory, so keep every file here.

## Where the data comes from

The source is undocumented. Claude Code's documented one (the statusline `rate_limits` fields) exists only inside a running Claude Code session, and the `claude` CLI has no usage command. So the plugin calls the endpoint Claude Code's own `/usage` screen uses:

- `GET https://api.anthropic.com/api/oauth/usage` with header `anthropic-beta: oauth-2025-04-20`
- Authorization: the OAuth access token of your Claude Code login, from the keychain item `Claude Code-credentials` (`claudeAiOauth.accessToken`).

Anthropic can change or remove this endpoint at any time. The footer then says the data is unavailable and nothing else breaks.

## Safety rules (in code and tests)

- Read only. The token is read from the keychain on each poll, kept in memory for one request, then dropped. It is never written, refreshed, logged or shown. The refresh token in the same keychain item is never kept.
- An expired token is never refreshed. The footer asks you to open `claude`, and the plugin checks again in 5 minutes.
- One host, `api.anthropic.com`. 10 second timeout, redirects refused, error bodies never read or shown.
- At most one poll every 5 minutes per OpenCode window, plus `/claude-usage` (not twice within 30 s, not during a 429 back-off). Failures back off 10, 20, 40, then 60 minutes; a 429 honours `Retry-After`.
- Only the numbers are cached, in `~/.local/state/opencode/claude-usage.json` (mode 0600). Delete it any time.
- No model call and no prompt.

macOS may ask once whether `security` can read the `Claude Code-credentials` item.

## Files

- `claude-usage-core.ts`: pure logic (parsing, formatting, thresholds, back-off, the polling state machine).
- `claude-usage.ts`: the only file with I/O (keychain, the one request, the cache file).
- `tui.tsx`: footer meters, `/claude-usage` dialog, toast. Render errors are written to `/tmp/claude-usage-render-error.txt`.
- `index.ts`: an empty server part, so OpenCode loads the directory.
- `claude-usage-core.test.ts`: `bun test`, fake tokens only.

Theme note for OpenCode plugin authors: `theme.text.base`, `text.muted` and `text.faint` are colours, but `theme.text.feedback.error|warning|success|info` are objects. Use `.base` on them.

## Turn it off

- Set `CLAUDE_USAGE_DISABLED=1` in the environment OpenCode starts with, or
- remove the `claude-usage` entry from `plugin` in `opencode.json`.
