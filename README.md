# pi-meron-ui

Pi extension that provides a clean padded status bar and the meron-custom theme.

## Features

### Tool Rows
Transparent tool rows with top/bottom borders when `toolBackground` is `border`/`outlines`.
Set `toolBackground` to `transparent` for no borders, or `default` for Pi's standard boxed backgrounds.

### Status Bar
Single-row padded footer (3-space left/right padding):

```
   ~/projects/foo • main    zai/glm-5.1 • off • 45.2%/128k
```

- **Left:** current directory + git branch
- **Right:** provider/model · thinking level · context usage %
- Color-coded context (warning >70%, error >90%)
- Session name shown alongside pwd when set

## Install

```bash
pi install git:github.com/imranshaiedi-byte/pi-meron-ui
```

## Theme

Includes these themes. Select one via `/settings` → Theme, or in `~/.pi/agent/settings.json`:

```json
{
  "theme": "meron-graphite"
}
```

| Theme | Feel |
|-------|------|
| `meron-custom` | Original custom palette |
| `meron-graphite` | Neutral graphite, high-legibility, restrained cyan accent |
| `meron-nord` | Cool blue/grey Nord-inspired palette |
| `meron-tokyo` | Vibrant Tokyo Night-inspired palette |
| `meron-soft` | Warm soft palette, no harsh blue, standard red/green diffs |
| `meron-flat` | Flat minimal — only errors, diffs, and accents are colored |

| Element | Color |
|---------|-------|
| Tool title | Blue #61afef |
| Tool success bg | Transparent/default terminal bg |
| Tool error bg | Transparent/default terminal bg |
| Tool pending bg | Transparent/default terminal bg |
| Diff added | Standard green #00ff00 |
| Diff removed | Standard red #ff0000 |
| User message bg | Subtle grey |

Thinking level borders follow a cool→warm progression:

| Level | Color | Hex |
|-------|-------|-----|
| off | Steel grey | #4b5263 |
| minimal | Blue | #61afef |
| low | Purple | #8b5cf6 |
| medium | Magenta | #c678dd |
| high | Amber | #e5a55b |
| xhigh | Red | #ef4444 |

## License

MIT
