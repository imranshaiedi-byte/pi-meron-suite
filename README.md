# pi-meron-suite

A pi extension providing a clean status/footer bar with pure-white chrome.

## Features

### Footer
Status line showing:
- Current working directory, session name, git branch (left side)
- Model, thinking level, context usage, cache hit rate, and session cost (right side)
- Responsive layout: collapses to two rows on narrow terminals
- Colored via Pi's theme API (`theme.fg("text", ...)`) — true pure white `#ffffff`

### Theme (`meron`)
Ships a Pi theme that sets pure white (`#ffffff`) for:
- Main text (footer)
- Editor borders at every thinking level
- Bash-mode border

Pi's normal border-color updates keep working — no ANSI hacks or property overrides.

## Installation

```bash
git:github.com/imranshaiedi-byte/pi-meron-suite
```

Then restart your pi session or run `/reload`.

The extension activates the `meron` theme on session start. You can switch themes anytime via `/settings`.

## Usage

The extension loads automatically on session start. The footer appears at the bottom of the TUI with session and model info.

## License

MIT
