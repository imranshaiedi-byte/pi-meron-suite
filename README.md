# pi-meron-suite

A comprehensive pi extension suite providing footer/status bar, tool display overrides, a persistent todo manager, and a structured `ask_user_question` tool — all with clean meron-style rendering.

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

### Todo Manager
Persistent task tree with:
- Create, update, list, get, delete, clear actions
- Dependencies via `blockedBy`
- Subtasks via `parentId` (up to 3 levels deep)
- Live overlay widget above the editor
- Meron-style rendering with status glyphs

### ask_user_question
Structured questionnaire tool with:
- Up to 4 questions with 2-4 options each
- Single-select and multi-select questions
- "Type something." for custom answers
- "Chat about this" to abandon the questionnaire
- Side-by-side preview panes for visual comparisons
- Tab navigation between questions
- Review screen before submission
- Compact result summary after submission

## Installation

```bash
git:github.com/imranshaiedi-byte/pi-meron-suite
```

Then restart your pi session.

## Usage

The extension loads automatically on session start. The `ask_user_question` tool is available for the agent to use whenever structured clarification is needed.

The `/todos` and `/todo` commands show the current task tree.

## Theme

Includes the `grayscale-v5` theme for consistent styling.

## License

MIT
