# claude-usage

A read-only OpenCode 2 plugin that shows how much of your Claude subscription you have used: the 5-hour window and the weekly window, each with a percentage and a reset time. The interface text is in Italian.

## What you see

- Under the prompt, always: a small coloured meter per window, `sett ▰▰▰▰▰▰ 96%   fable ▰▱▱▱▱▱ 12%`, with a 5-hour meter in front when the plan has that window: `5h ▰▰▱▱▱▱ 23%   sett ▰▰▰▰▰▰ 96%`. The week is coloured by its pace, the 5-hour window by its percent (green under 70%, yellow from 70%, red from 90%), Fable by its own lines; all three are described below. Every line is judged on the whole number that is drawn, so a colour never disagrees with the number beside it: 89.6 is drawn `90%` and is red. Yellow is the theme's yellow hue, not its warning colour, which is orange in the apple theme and is kept for what waits for you (below); a theme with no hues falls back to its warning colour. A window the API does not report is not drawn: Ultra plans have no 5-hour window, so the footer starts at `sett` (there is no `5h libero`). The item measures the room it has in the footer row (not the terminal width) and re-measures when the window, the sidebar or a neighbour in the row changes size (it listens to their resize events; there is no polling). When the room shrinks it drops the `(vecchio)` marker first, then shortens the bars (6, 5, 4, 3 cells) with every window kept, Fable included. When even the 3-cell bars do not fit, the whole item becomes one icon, `◉`, coloured with the worst level among the windows shown: red beats yellow beats green, each window by its own rule (the week by its pace). If the numbers are old (the last refresh failed) the icon is faint, unless it is red: a red icon stays red. With no room for even one column the item shows nothing. It never wraps onto a second line and never gets wider as the room shrinks.
- The colour of `sett` is the week's pace, not its percent alone: how much is used against how much of the week has gone. Days gone = 7 minus the days until the reset, counted as at least half a day; pace = days gone / 7 × 100; margin = percent used minus pace. Green up to 10 points ahead of the pace, yellow up to 25, red above 25 or from 90% used (the 10% reserve). The three numbers are the whole ones the dialog shows (percent, pace, margin), so `10 sopra` is always green and `11 sopra` always yellow. So 59% used 1.8 days into the week is red (pace 26%, 33 ahead), and the same 59% five days in is green. This is the pace rule of my `model-mix` budget. The plugin knows the percent and the reset time only, so its colour can differ from a coordinator's own count both ways: banked resets are not counted, which makes it stricter; work still running is not counted, which makes it more lenient. The reserve is fixed at 10% (red from 90%), the value in my plan line; the plugin does not read that line. When the API gives no reset time the percent alone decides (the 70% and 90% lines).
- Old numbers keep their colour. The pace is judged at the moment the numbers were read, not at today's clock: while refreshes fail the percent stands still, and against the clock a red would drift to yellow and then green with no new data. A 59% read 1.8 days in is still red two days later, also in a footer too narrow for `(vecchio)`.
- Click the meters or the icon (left button) to open the same dialog as `/claude-usage`, with a refresh. A click is a press and a release on the same cell, so dragging across the footer to select text, or a release that started somewhere else, does nothing. The footer is not focusable: the prompt keeps the keyboard focus.
- While the mouse is over the footer item it lights up (labels one step brighter, the theme's own hover fill behind it, no change in width) and goes back when the mouse leaves, the terminal loses focus or the dialog opens; a terminal sends no event when the mouse leaves its window, so the highlight can stay until the next mouse move or a focus change.
- From 90% weekly, one warning toast the first time it gets there.
- When the plan reports a Fable limit, a third meter follows `sett`: `fable ▰▱▱▱▱▱ 12%`, the separate weekly Fable limit. Green under 50%, yellow from 50%, red from 80%. The 80% is this plugin's own stop line (my rule that agents stop using Fable there), not a limit set by Anthropic. One warning toast says so the first time it crosses (`Fable all'80% settimanale: niente più Fable per gli agenti`), and again only after Fable has dropped back under 80%. A poll that does not report Fable at all does not count as a drop. Toasts (this one and the 90% weekly one) only come from numbers fetched in the current session: after `/reload` or in a new window the cached numbers show in the footer but do not toast again. When the plan reports no Fable limit the meter is not drawn and nothing is shown as an error. Fable is never dropped to make room: it is the number that decides whether agents may use Fable, so it is part of the icon colour too.
- `/claude-usage` (alias `/usage`, also in the Ctrl+P palette, or a click on the footer) refreshes and opens a dialog with the windows (5 hours, week and, when reported, Fable), when each one resets, the week's colour in words, and the last error if there was one:

  ```
  Abbonamento Claude

  5 ore      nessuna finestra attiva

  Settimana  ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱   59%
             si azzera tra 5g 2h (sabato)
             ● rosso · ritmo 26% · 33 sopra

  Fable      ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱   36%
             si azzera tra 5g 2h (sabato)

  aggiornato 3m fa
  Non aggiornato: troppe richieste, riprovo tra 12m

  esc per chiudere
  ```

  - The reset is a time span, never a clock time: `si azzera tra 1h 9m`, and from a day up also the day, `si azzera tra 5g 2h (sabato)`. Under a minute: `si azzera tra poco`. Times are written `<1m`, `12m`, `1h 5m`, `2g 3h`, as in the other plugins. When the dialog is narrow the day goes first, then `si azzera`.
  - The line under the week says its colour in words, so the colour never stands alone: `● verde · ritmo 50% · 20 sotto`, `● giallo · ritmo 50% · 15 sopra`, `● rosso · ritmo 26% · 33 sopra`, `● verde · ritmo 50% · in pari`. From 90% used it says `● rosso · nella riserva del 10%`, and in the last 12 hours of the week `● verde · ultime ore, il resto scade`. When the numbers are 10 minutes old or more (the limit my budget rule gives a reading), the line ends with their age, because the judgement is as old as they are: `● rosso · ritmo 26% · 33 sopra · 2g 3h fa`. A dialog too narrow for it drops the age first.
  - `aggiornato adesso` or `aggiornato 3m fa` is the age of the numbers. `Non aggiornato: …` appears when the last refresh failed, with the reason and the next attempt: `troppe richieste, riprovo tra 12m`, `rete non raggiungibile, riprovo tra 5m`, `dati non disponibili, riprovo tra 5m`; under a minute `riprovo tra poco`. `accesso scaduto, apri claude` has no retry time: it waits for you, so it is the only one drawn in orange, in the dialog as in the footer. A failure that retries by itself is grey.
- `(vecchio)` after the meters (or a faint icon; a red icon stays red even when old) means the last refresh failed and the numbers are old. `accesso scaduto, apri claude` means the Claude Code login has expired.

## Install

macOS only (the token is read from the macOS keychain). Needs OpenCode 2 (the root README says which version was last checked) and a Claude Code login (`claude` signed in with a Pro, Max or Ultra plan).

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Then add the `claude-usage` folder to `plugin` in `~/.config/opencode/opencode.json` (absolute path):

```json
{ "plugin": ["/Users/you/opencode-plugins/claude-usage"] }
```

Run `/reload` in OpenCode. OpenCode 2 loads only directories as plugins, and it reloads only the files inside the plugin directory, so keep every file here.

## Where the data comes from

The source is undocumented. Claude Code's documented one (the statusline `rate_limits` fields) exists only inside a running Claude Code session, and the `claude` CLI has no usage command. So the plugin calls the endpoint Claude Code's own `/usage` screen uses:

- `GET https://api.anthropic.com/api/oauth/usage` with header `anthropic-beta: oauth-2025-04-20`
- Authorization: the OAuth access token of your Claude Code login, from the keychain item `Claude Code-credentials` (`claudeAiOauth.accessToken`).

The 5-hour and weekly windows are the top-level `five_hour` and `seven_day` objects (`utilization`, `resets_at`). The Fable window is an entry of the `limits` array with `kind: "weekly_scoped"` and `scope.model.display_name` equal to "Fable" (spaces and case ignored); if there are several, the highest `percent` wins; its `percent` and `resets_at` are used. `percent` is the share of the Fable limit itself (the 50% of the week set aside for Fable), not of the whole week. The response also has `weekly_scoped_shares[].used_percent_of_weekly` and `allowance_percent_of_weekly`, which the plugin does not read. The `limits` field is as undocumented as the endpoint: if it is missing, malformed or has no Fable entry, the Fable meter is simply absent.

Anthropic can change or remove this endpoint at any time. The footer then says the data is unavailable and nothing else breaks.

## Safety rules (in code and tests)

- Read only. The token is read from the keychain on each poll, kept in memory for one request, then dropped. It is never written, refreshed, logged or shown. The refresh token in the same keychain item is never kept.
- An expired token is never refreshed. The footer asks you to open `claude`, and the plugin checks again in 5 minutes, also when the server refuses the token (401 or 403).
- One host, `api.anthropic.com`. 10 second timeout, redirects refused, error bodies never read or shown.
- At most one poll every 5 minutes per OpenCode window, plus `/claude-usage` (not twice within 30 s, not during a 429 back-off). Failures back off 10, 20, 40, then 60 minutes; a 429 honours `Retry-After`. A 429 back-off is kept in the cache file and read before every poll, so it holds after `/reload` and in every OpenCode window.
- Only the numbers and the next-attempt time (and, during a 429 back-off, its end) are cached, in `~/.local/state/opencode/claude-usage.json` (mode 0600). Delete it any time. A symlink or a pipe in its place is refused, never followed or waited on, so a bad file there cannot stop the footer. Cache files written before the Fable meter existed still load (Fable is just absent until the next poll).
- No model call and no prompt.

macOS may ask once whether `security` can read the `Claude Code-credentials` item.

## Files

- `claude-usage-core.ts`: pure logic (parsing, formatting, thresholds, back-off, the polling state machine).
- `claude-usage.ts`: the only file with I/O (keychain, the one request, the cache file, the render error file).
- `tui.tsx`: footer meters and icon, click handling, `/claude-usage` dialog, toast. Render errors are written by `claude-usage.ts` to `~/.local/state/opencode/claude-usage-render-error.txt` (mode 0600, a symlink in its place is refused).
- `index.ts`: an empty server part, so OpenCode loads the directory.
- `claude-usage-core.test.ts`: `bun test`, fake tokens only. `claude-usage-cache.test.ts`: the cache file, and `claude-usage-io.test.ts`: the render error file, both in a temp folder.

Theme note for OpenCode plugin authors: `theme.text.base`, `text.muted` and `text.faint` are colours, but `theme.text.feedback.error|warning|success|info` are objects. Use `.base` on them.

## Turn it off

- Set `CLAUDE_USAGE_DISABLED=1` in the environment OpenCode starts with, or
- remove the `claude-usage` entry from `plugin` in `opencode.json`.
