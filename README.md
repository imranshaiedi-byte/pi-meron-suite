# pi-meron-ui

Pi extension that combines collapsed tool outputs with a clean padded status bar.

## Features

### Collapse Tools
- Tool calls show command/parameters but hide output by default
- Press `Ctrl+O` to expand and view full tool output
- Long bash commands are truncated when collapsed
- Handles all built-in tools: read, bash, write, edit, grep, find, ls

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

### Via pi install (recommended)

```bash
pi install git:github.com/imranshaiedi-byte/pi-meron-ui
```

### Manual

```bash
cp index.ts ~/.pi/agent/extensions/pi-meron-ui.ts
```

Then `/reload` in pi or restart.

## License

MIT
