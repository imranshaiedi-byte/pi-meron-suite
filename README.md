# pi-meron-footer

Pi package that provides a clean padded status bar footer, compact fixed tool rendering, and a lightweight todo tracker for agent plans.

## Features

### Meron footer

Single-row padded footer (3-space left/right padding):

```text
   ~/projects/foo • main    zai/glm-5.1 • off • 45.2%/128k
```

- **Left:** current directory + session name + git branch
- **Right:** provider/model · thinking level · context usage %
- Color-coded context (warning >70%, error >90%)

### Todo tracker

Inspired by `@juicesharp/rpiv-todo`, this package adds a session-scoped `todo` tool, `/todos` and `/todo` commands, plus a compact live overlay above the editor.

- Agent-facing `todo` tool with create/update/list/get/delete/clear actions.
- Task states: `pending`, `in_progress`, `completed`, `deleted` tombstones.
- Dependency support via `blockedBy`, `addBlockedBy`, and `removeBlockedBy`.
- Completed tasks stay visible briefly, then fall away on the next agent turn.
- Footer badge appears when open todos exist: `todo:2`.
- State replays from the active session branch and survives reloads.

Overlay example:

```text
● Todos (1/3)
├─ ◐ #2 Add todo overlay (rendering widget)
├─ ○ #3 Wire footer badge ⛓ #2
└─ ✓ #1 Research rpiv-todo
```

Slash commands:

```bash
/todos
/todo
/todo clear
```

### Tool display

- `edit` and `write`: diff rendering.
- All other tool results: one-line summary while collapsed.
- Press `Ctrl+O` to expand and show all output lines.
- Long or multiline bash commands are collapsed too, with `Ctrl+O` showing the full command.

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
