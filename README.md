# pi-meron-footer

Pi package that provides a clean padded status bar footer plus compact fixed tool rendering.

## Features

### Meron footer

Single-row padded footer (3-space left/right padding):

```text
   ~/projects/foo • main    zai/glm-5.1 • off • 45.2%/128k
```

- **Left:** current directory + session name + git branch
- **Right:** provider/model · thinking level · context usage %
- Color-coded context (warning >70%, error >90%)
- Responsive fallback on narrow terminals: full → compact model label → usage-only.

### Tool display

- `edit` and `write`: diff rendering.
- All other tool results: one-line summary while collapsed.
- Press `Ctrl+O` to expand and show all output lines.
- Long or multiline bash commands are collapsed too, with `Ctrl+O` showing the full command.
- Bash summaries now detect common test/lint/build outputs (when recognizable).
- Pending diff previews now skip likely binary files and support configurable max read size via `PI_MERON_PREVIEW_READ_LIMIT_BYTES`.

Collapsed result summary:

```text
────────────────────────────────────────
● Bash npm test
└─ 42 lines returned • Ctrl+O to expand
────────────────────────────────────────
```

## Install

```bash
pi install git:github.com/imranshaiedi-byte/pi-meron-footer
```

## License

MIT
