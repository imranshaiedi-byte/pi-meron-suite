# pi-meron-footer

Pi package that provides a clean padded status bar footer plus compact tool rendering.

## Features

### Meron footer

Single-row padded footer (3-space left/right padding):

```text
   ~/projects/foo • main    zai/glm-5.1 • off • 45.2%/128k
```

- **Left:** current directory + session name + git branch
- **Right:** provider/model · thinking level · context usage %
- Color-coded context (warning >70%, error >90%)

### Compact tool display

Ported from [`pi-tool-display`](https://github.com/MasuRii/pi-tool-display):

- Compact rendering for `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`
- Collapsed bash output previews
- Edit/write diff rendering
- `/tool-display` settings command

Extra in this fork:

- Long or multiline **bash commands themselves** collapse in the TUI, not just their output.
- Press `Ctrl+O` to expand and see the full command/output.

## Install

```bash
pi install git:github.com/imranshaiedi-byte/pi-meron-footer
```

## License

MIT
