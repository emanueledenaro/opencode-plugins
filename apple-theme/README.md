# apple-theme

An OpenCode 2 colour theme with the macOS system colours, in a dark and a light version.

- Text in a soft pearl white on dark, near black on light. Secondary text in Apple greys.
- Apple blue as the main colour; Apple green, orange and red for success, warning and error.
- Bold text in Apple orange, inline code in Apple cyan, so the one action and the keys to press stand out in a reply. Diff blocks show added lines green and removed lines red.
- Transparent main background, so your terminal's background (and its blur, if it has one) shows through. Prompt box, sidebar and dialogs keep a solid grey, so the sections stay clearly visible.

## Install

```sh
mkdir -p ~/.config/opencode/themes
cp apple.json ~/.config/opencode/themes/apple.json
```

Then in `~/.config/opencode/cli.json`:

```json
{ "theme": { "name": "apple", "mode": "system" } }
```

`system` follows your terminal's light or dark mode. Use `dark` or `light` to lock one.

## Notes

- The file uses the same format as OpenCode's built-in themes (`defs` plus `theme` with a `dark` and `light` value per token).
- The big "opencode" logo on the home screen keeps OpenCode's own colours.
- Looks best in a terminal with a matching palette, for example Ghostty with `theme = light:Apple System Colors Light,dark:Apple System Colors`.
