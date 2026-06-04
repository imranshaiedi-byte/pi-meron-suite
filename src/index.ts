import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolDisplayOverrides } from "./tool-overrides.js";
import { registerThinkingLabeling } from "./thinking-label.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "./types.js";
import { registerSessionTracker } from "./session-tracker.js";
import { registerWidgets, injectTurnSeparator } from "./widgets.js";
import { registerTurnSeparatorRenderer } from "./turn-separator.js";
import { registerSessionDiffCommand } from "./session-diff.js";

const FIXED_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
  ...DEFAULT_TOOL_DISPLAY_CONFIG,
  registerToolOverrides: {
    read: true,
    grep: true,
    find: true,
    ls: true,
    bash: true,
    edit: true,
    write: true,
  },
  showTruncationHints: false,
  showRtkCompactionHints: false,
};

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  // Feature 2: Tool result cards
  registerToolDisplayOverrides(pi, () => FIXED_TOOL_DISPLAY_CONFIG);

  // Feature 1: Thinking labeling
  registerThinkingLabeling(pi);

  // Session tracking
  registerSessionTracker(pi);

  // Widgets and status indicators
  registerWidgets(pi);

  // Turn separator
  registerTurnSeparatorRenderer(pi);
  pi.on("agent_end", async (_event, ctx) => {
    injectTurnSeparator(pi, ctx);
  });

  // Session diff command
  registerSessionDiffCommand(pi);
}
