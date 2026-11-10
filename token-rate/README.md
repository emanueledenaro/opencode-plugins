# token-rate

An OpenCode 2 plugin that measures how fast the model streams a reply. It shows a small sparkline and the last speed under the prompt, and a `/velocita` dialog with today's numbers per model. It sits beside other status plugins such as claude-usage. The interface is in Italian.

## What it measures

Output tokens divided by the time between the first and the last streamed text chunk of the reply. Time to first token is not counted in the rate, but it is logged and shown in the dialog. A reply with two or more separate text blocks, or with a single chunk, gets no rate. The measuring code is the one from the old OpenCode 1 plugin (`createThroughputCollector`), and its tests are kept.

A reply that streams for less than 250 ms is a burst: the whole text arrived at once, so its rate means nothing. It is not shown and not logged.

OpenCode 2 reports a reply as events, which the plugin turns into the same inputs:

- `session.step.started`: start time and model.
- `session.text.delta`: one per streamed chunk, with the event time.
- `session.step.ended`: the token counts (`tokens.output`).
- `session.step.failed`: drops what was collected.

## The footer

```
▂▃▅▇▆ 42 tok/s
```

- The sparkline is the last 6 replies of the session you are viewing (or of the latest session measured anywhere, if yours has none). It is in the faint colour, the number after it in the muted colour.
- The number turns to the warning colour when it is under 60% of the median of that model's last 20 earlier replies (from the log and from this run). It needs at least 5 earlier replies, otherwise there is nothing fair to compare with. This is the only accent.
- While a reply streams, the sparkline becomes a small spinner of quadrant blocks (`▖ 126 tok/s`; SF Mono and Menlo have them, they have no braille) and the number is a live estimate, updated at most every 500 ms. The estimate counts about 4 characters per token, because real token counts only arrive when the reply ends. When it ends, the figure settles on the real one. The live number is never shown in the warning colour.
- Nothing is shown before the first measurement.

OpenCode's own message footer also shows a `tok/s`. That one includes the wait for the first token, so it reads a little lower.

### Fits any width

The footer row is shared with the path, claude-usage, the context figure and OpenCode's hints. The footer measures what the row has left and steps down:

1. sparkline and rate: `▂▃▅▇▆ 42 tok/s`
2. rate only: `42 tok/s`
3. nothing

It never wraps and never pushes a neighbour. It follows a live zoom of the terminal: resizes are measured on the row and on each item in it, a shrink applies at once, growth waits 60 ms so a burst of resizes lands as one change, and a width that has not changed does no work at all. Timers and listeners are removed when the plugin unloads.

What this relies on in OpenCode 2.2.6, checked in the binary: the prompt footer row has a gap of 2 between items, and its first item is stretched to fill the row. Idle it holds the working-directory path, which truncates itself: the footer counts only 12 cells of it as used, and tells the path box to take the whole cut when the row is too full (its `flexShrink` is raised, and put back on unload). Without that, flexbox would take cells from every item in proportion and claude-usage would lose a meter cell. While a reply streams, that first item holds OpenCode's own "esc interrupt" hint instead. The hint is never cut: the footer counts its full content width (the right-most edge of what is inside it), so on a narrow terminal the footer drops its sparkline, then its rate, before the hint loses a letter. It measures again when a reply starts or ends, because the first item changes then. If a later OpenCode changes the row, the footer measures wrongly and at worst hides itself; the numbers are not affected.

## /velocita

Type `/velocita`, or open it from the command palette (Ctrl+P, "Velocità del modello"). It shows:

- Today, per model (Opus, Sonnet, Haiku, Fable by name, any other model by a short id): the median tok/s, the median wait for the first word ("prima parola dopo 2,2 s"), the number of replies and a sparkline of the last 20 replies. At most 5 models, then "e altri N modelli".
- This session, the last 5 replies, newest first: model, speed, tokens, time. A slow reply is marked "lenta".

The dialog follows its width. As it gets narrower the sparkline gets shorter (6 cells at the least, then gone), headings are replaced by a shorter wording rather than cut mid-word ("Questa sessione, ultime risposte", then "Questa sessione", then "Sessione"), the wait wording shortens ("attesa 2,2 s, 12 risposte", then only "12 risposte"), and the session columns drop in this order: the "lenta" note, the tokens, the time. The rate and the model always stay.

Numbers use the Italian decimal comma and aligned columns.

## The log

Every measurement is appended as one JSON line to:

`$XDG_STATE_HOME/opencode/token-rate.jsonl` (default `~/.local/state/opencode/token-rate.jsonl`, the same file and format the old plugin wrote)

Fields: `timestamp`, `sessionID`, `messageID`, `providerID`, `modelID`, `outputTokens`, `timeToFirstTokenMs`, `generationMs`, `tokensPerSecond`. No prompt or reply text. The file grows by about 250 bytes per reply; delete it any time. Set `TOKEN_RATE_LOG=off` to stop writing it.

Reading is careful: the file is opened with `O_NOFOLLOW` (a symlink in its place is refused), only the last 1 MB is read (about 4000 replies, the first line of that tail is dropped as it may be cut), and it happens once at start for the colour rule and once each time the dialog opens, never per frame. A missing or unreadable log just means no history. A reply logged twice by two open windows counts once.

Summary of the last N measurements:

```sh
bun token-rate-report.ts --average 20
```

## Install

Needs OpenCode 2.2 or later.

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Add the `token-rate` folder to `plugin` in `~/.config/opencode/opencode.json` (absolute path), listed after claude-usage, and remove the old single-file `token-rate.ts` entry, which OpenCode 2 skips:

```json
{ "plugin": ["/Users/you/opencode-plugins/token-rate"] }
```

Run `/reload`.

Colours come from the active theme (`text.faint`, `text.muted`, `text.base`, `text.feedback.warning`), read at draw time, so a theme change shows on the next frame.

## Files

- `token-rate-core.ts`: pure logic (the collector, the event tracker, sparkline, colour rule, live estimate, footer steps, width settling, dialog rows and columns, Italian formatting, log parsing).
- `token-rate-log.ts`: the disk side: log path, append, tail read.
- `tui.tsx`: event listeners, the footer, the dialog, resize measuring.
- `token-rate-report.ts`: the log summary script.
- `index.ts`: an empty server part, so OpenCode loads the directory.
- `token-rate-core.test.ts`, `token-rate-log.test.ts`: `bun test`.

## Turn it off

- Set `TOKEN_RATE_DISABLED=1` in the environment OpenCode starts with, or
- remove the `token-rate` entry from `plugin` in `opencode.json`.
