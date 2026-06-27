# pi-meron-suite

A pi extension providing a clean footer/status bar with the grayscale theme.

## Features

### Footer
Clean padded footer/status bar showing:
- Current working directory, session name, and git branch
- Model provider/id, thinking level, context usage, session cost, and cache hit rate

### Theme
Includes the `grayscale` theme for consistent styling. The UI is grayscale, while diffs keep standard green additions and red removals.

## Installation

```bash
git:github.com/imranshaiedi-byte/pi-meron-suite
```

Then restart your pi session.

## Usage

The extension loads automatically on session start.

To use the theme, select `grayscale` in `/settings` or set:

```json
{
  "theme": "grayscale"
}
```

## License

MIT
