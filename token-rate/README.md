# token-rate

An OpenCode 2 plugin that measures how fast the model streams a reply and shows the last speed under the prompt, for example `42 tok/s`, in a faint colour. It sits beside other status plugins such as claude-usage.

## What it measures

Output tokens divided by the time between the first and the last streamed text chunk of the reply. Time to first token is not counted. A reply with two or more separate text blocks, or with a single chunk, gets no rate. The measuring code is the one from the old OpenCode 1 plugin, kept unchanged (`createThroughputCollector`), and its tests are kept.

OpenCode 2 reports a reply as events, which the plugin turns into the same inputs:

- `session.step.started`: start time and model.
- `session.text.delta`: one per streamed chunk, with the event time.
- `session.step.ended`: the token counts (`tokens.output`).
- `session.step.failed`: drops what was collected.

## What you see

`42 tok/s` (one decimal below 10, `9.9 tok/s`) at the end of the status row under the prompt (list it after claude-usage in `plugin`). It shows the rate of the session you are viewing, or the latest one measured anywhere if that session has none yet. Nothing is shown before the first measurement.

OpenCode's own message footer also shows a `tok/s`. That one includes the wait for the first token, so it reads a little lower.

## The log

Every measurement is appended as one JSON line to:

`$XDG_STATE_HOME/opencode/token-rate.jsonl` (default `~/.local/state/opencode/token-rate.jsonl`, the same file the old plugin wrote)

Fields: `timestamp`, `sessionID`, `messageID`, `providerID`, `modelID`, `outputTokens`, `timeToFirstTokenMs`, `generationMs`, `tokensPerSecond`. No prompt or reply text. The file grows by about 250 bytes per reply; delete it any time. Set `TOKEN_RATE_LOG=off` to stop writing it.

Summary of the last N measurements (a reply logged twice by two open windows counts once):

```sh
bun token-rate-report.ts --average 20
```

## Install

Needs OpenCode 2.2 or later.

```sh
git clone https://github.com/emanueledenaro/opencode-plugins ~/opencode-plugins
```

Add the `token-rate` folder to `plugin` in `~/.config/opencode/opencode.json` (absolute path), and remove the old single-file `token-rate.ts` entry, which OpenCode 2 skips:

```json
{ "plugin": ["/Users/you/opencode-plugins/token-rate"] }
```

Run `/reload`.

## Files

- `token-rate-core.ts`: pure logic (the collector, the event tracker, formatting, the summary).
- `tui.tsx`: event listeners, the footer text, the log.
- `token-rate-report.ts`: the log summary script.
- `index.ts`: an empty server part, so OpenCode loads the directory.
- `token-rate-core.test.ts`: `bun test`.

## Turn it off

- Set `TOKEN_RATE_DISABLED=1` in the environment OpenCode starts with, or
- remove the `token-rate` entry from `plugin` in `opencode.json`.
