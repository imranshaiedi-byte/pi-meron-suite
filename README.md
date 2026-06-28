# pi-meron-suite

A pi extension providing a clean footer/status bar with grayscale themes.

## Features

### Footer
Clean padded footer/status bar showing:
- Current working directory, session name, and git branch
- Model provider/id, thinking level, context usage, session cost, and cache hit rate

### Themes
Includes grayscale themes for consistent styling. The UI is grayscale, while diffs keep standard green additions and red removals.

- `grayscale` — balanced monochrome baseline
- `grayscale-brutal` — sharper, darker, higher-contrast variant
- `grayscale-best` — recommended UX-tuned variant with clear Pi component separation

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
  "theme": "grayscale-best"
}
```

## License

MIT
