# pi-meron-suite

A pi extension providing a clean footer/status bar with coherent dark themes.

## Features

### Footer
Clean padded footer/status bar showing:
- Current working directory, session name, and git branch
- Model provider/id, thinking level, context usage, session cost, and cache hit rate

### Themes
Includes cohesive dark themes for consistent styling. Diffs keep standard green additions and red removals.

- `dark-vibrant` — existing high-saturation dark theme
- `midnight-slate` — recommended calm blue/slate theme for long coding sessions
- `carbon-mint` — charcoal monochrome base with a restrained mint accent
- `ember-night` — warm dark theme with amber/orange emphasis

## Installation

```bash
git:github.com/imranshaiedi-byte/pi-meron-suite
```

Then restart your pi session.

## Usage

The extension loads automatically on session start.

To use a theme, select it in `/settings` or set:

```json
{
  "theme": "midnight-slate"
}
```

## License

MIT
