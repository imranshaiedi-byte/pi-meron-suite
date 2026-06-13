# pi-meron-suite

A pi extension suite providing footer/status bar and tool display overrides with clean meron-style rendering.

## Features

### Footer
Clean padded footer/status bar showing:
- Current working directory, session name, and git branch
- Model provider/id, thinking level, context usage, session cost, and cache hit rate bar

### Tool Display Overrides
Compact, human-readable rendering for built-in tools:
- `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`
- Status dots, branch-style summaries, and diff previews
- Clean headers like `● **Read** src/file.ts (42 lines loaded)` instead of raw tool names

### Thinking Pulse
A live indicator for collapsed thinking blocks.

When reasoning tokens are streaming and thinking is collapsed, the static
`Thinking...` label is replaced with a spinner and a running token estimate:

```
⠹ Thinking… ≈1,284 tokens
```

- A braille spinner animates only while thinking is actively streaming.
- The token estimate ticks up so you can watch tokens flow in. If it stalls,
  the model is paused.
- When thinking ends (or text/tool-calls begin), the label reverts to the
  default `Thinking...`.
- Only affects the collapsed view — expanded thinking is untouched.

## Installation

```bash
git:github.com/imranshaiedi-byte/pi-meron-suite
```

Then restart your pi session.

## Usage

The extension loads automatically on session start.

## Theme

Includes the `grayscale-v5` theme for consistent styling.

## License

MIT
