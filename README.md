# pi-meron-suite

A pi extension providing Codex-style TUI rendering, a clean status/footer bar, and coherent dark themes.

## Features

### Codex-style TUI
- Re-skins tool calls into Codex-like transcript rows (`• Running`, `• Read`, `• Edited`, `└` output previews)
- Compact output previews with expand hints for longer results
- Diff summaries for `edit`/`write`-style file changes
- Codex-inspired startup header, working indicator, and footer/status line
- Renderer patch is visual-only: it does not replace built-in tool execution

### Footer
Codex-style footer/status line showing:
- Shortcut hint
- Model, thinking level, git branch
- Context usage, cache hit rate, and session cost when available

### Themes
Includes cohesive dark themes for consistent styling. Diffs keep standard green additions and red removals.

- `codex-dark` — Codex/GitHub-dark inspired palette for the Codex-style renderer
- `dark-vibrant` — existing high-saturation dark theme
- `midnight-slate` — recommended calm blue/slate theme for long coding sessions
- `carbon-mint` — charcoal monochrome base with a restrained mint accent
- `ember-night` — warm dark theme with amber/orange emphasis
- `graphite-ui` — useful grayscale dark theme with clear brightness hierarchy
- `one-dark` — Atom One Dark inspired theme using the classic One Dark palette

## Installation

```bash
git:github.com/imranshaiedi-byte/pi-meron-suite
```

Then restart your pi session or run `/reload`.

## Usage

The extension loads automatically on session start.

For the closest Codex-like look, select the theme in `/settings` or set:

```json
{
  "theme": "codex-dark"
}
```

## Notes

pi does not currently expose a public renderer-only hook for all built-in tool rows. This suite patches pi's TUI `ToolExecutionComponent` renderer lookup at runtime so execution remains untouched while rendering changes.

## License

MIT
