# claude-usage

A read-only OpenCode 2 plugin that shows how much of your Claude subscription you have used: the 5-hour window and the weekly window, each with a percentage and a reset time. The interface text is in Italian.

## What you see

- Under the prompt, always: a small coloured meter per window, `sett ▰▰▰▰▰▰ 96%   fable ▰▱▱▱▱▱ 12%`, with a 5-hour meter in front when the plan has that window: `5h ▰▰▱▱▱▱ 23%   sett ▰▰▰▰▰▰ 96%`. Green under 70%, yellow from 70%, red above 90% (Fable has its own lines, below). A window the API does not report is not drawn: Ultra plans have no 5-hour window, so the footer starts at `sett` (there is no `5h libero`). The item measures the room it has in the footer row (not the terminal width) and re-measures when the window or the sidebar changes. When the room shrinks it drops the `(vecchio)` marker first, then shortens the bars (6, 5, 4, 3 cells) with every window kept, Fable included. When even the 3-cell bars do not fit, the whole item becomes one icon, `◉`, coloured with the worst level among the windows shown: red beats yellow beats green, each window by its own thresholds. If the numbers are old (the last refresh failed) the icon is faint. With no room for even one column the item shows nothing. It never wraps onto a second line and never gets wider as the room shrinks.
- Click the meters or the icon (left button) to open the same dialog as `/claude-usage`, with a refresh. A click is a press and a release on the same cell, so dragging across the footer to select text, or a release that started somewhere else, does nothing. The footer is not focusable: the prompt keeps the keyboard focus.
- Above 90% weekly, one warning toast the first time it crosses.
- When the plan reports a Fable limit, a third meter follows `sett`: `fable ▰▱▱▱▱▱ 12%`, the separate weekly Fable limit. Green under 50%, yellow from 50%, red from 80%. The 80% is this plugin's own stop line (my rule that agents stop using Fable there), not a limit set by Anthropic. One warning toast says so the first time it crosses (`Fable all'80% settimanale: niente più Fable per gli agenti`), and again only after Fable has dropped back under 80%. A poll that does not report Fable at all does not count as a drop. Toasts (this one and the 90% weekly one) only come from numbers fetched in the current session: after `/reload` or in a new window the cached numbers show in the footer but do not toast again. When the plan reports no Fable limit the meter is not drawn and nothing is shown as an error. Fable is never dropped to make room: it is the number that decides whether agents may use Fable, so it is part of the icon colour too.
- `/claude-usage` (alias `/usage`, also in the Ctrl+P palette, or a click on the footer) refreshes and opens a dialog with the windows (5 hours, week and, when reported, Fable), when each one resets, and the last error if there was one.
- `(vecchio)` after the meters (or a faint icon; a red icon stays red even when old) means the last refresh failed and the numbers are old. `accesso scaduto, apri claude` means the Claude Code login has expired.

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

The 5-hour and weekly windows are the top-level `five_hour` and `seven_day` objects (`utilization`, `resets_at`). The Fable window is an entry of the `limits` array with `kind: "weekly_scoped"` and `scope.model.display_name` equal to "Fable" (spaces and case ignored); if there are several, the highest `percent` wins; its `percent` and `resets_at` are used. `percent` is the share of the Fable limit itself (the 50% of the week set aside for Fable), not of the whole week. The response also has `weekly_scoped_shares[].used_percent_of_weekly` and `allowance_percent_of_weekly`, which the plugin does not read. The `limits` field is as undocumented as the endpoint: if it is missing, malformed or has no Fable entry, the Fable meter is simply absent.

Anthropic can change or remove this endpoint at any time. The footer then says the data is unavailable and nothing else breaks.

## Safety rules (in code and tests)

- Read only. The token is read from the keychain on each poll, kept in memory for one request, then dropped. It is never written, refreshed, logged or shown. The refresh token in the same keychain item is never kept.
- An expired token is never refreshed. The footer asks you to open `claude`, and the plugin checks again in 5 minutes.
- One host, `api.anthropic.com`. 10 second timeout, redirects refused, error bodies never read or shown.
- At most one poll every 5 minutes per OpenCode window, plus `/claude-usage` (not twice within 30 s, not during a 429 back-off). Failures back off 10, 20, 40, then 60 minutes; a 429 honours `Retry-After`.
- Only the numbers are cached, in `~/.local/state/opencode/claude-usage.json` (mode 0600). Delete it any time. Cache files written before the Fable meter existed still load (Fable is just absent until the next poll).
- No model call and no prompt.

macOS may ask once whether `security` can read the `Claude Code-credentials` item.

## Files

- `claude-usage-core.ts`: pure logic (parsing, formatting, thresholds, back-off, the polling state machine).
- `claude-usage.ts`: the only file with I/O (keychain, the one request, the cache file).
- `tui.tsx`: footer meters and icon, click handling, `/claude-usage` dialog, toast. Render errors are written to `/tmp/claude-usage-render-error.txt`.
- `index.ts`: an empty server part, so OpenCode loads the directory.
- `claude-usage-core.test.ts`: `bun test`, fake tokens only.

Theme note for OpenCode plugin authors: `theme.text.base`, `text.muted` and `text.faint` are colours, but `theme.text.feedback.error|warning|success|info` are objects. Use `.base` on them.

## Turn it off

- Set `CLAUDE_USAGE_DISABLED=1` in the environment OpenCode starts with, or
- remove the `claude-usage` entry from `plugin` in `opencode.json`.
