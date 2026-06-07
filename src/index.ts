import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolDisplayOverrides } from "./tool-overrides.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "./types.js";

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
  registerToolDisplayOverrides(pi, () => FIXED_TOOL_DISPLAY_CONFIG);
  
  // Add custom working indicator with subtle cyan accents
  pi.on("session_start", (event, ctx) => {
    if (ctx.ui && ctx.ui.setWorkingIndicator && ctx.ui.theme) {
      ctx.ui.setWorkingIndicator({
        frames: [
          ctx.ui.theme.fg("dim", "⠋"),
          ctx.ui.theme.fg("muted", "⠙"),
          ctx.ui.theme.fg("accent", "⠹"),
          ctx.ui.theme.fg("accent", "⠸"),
          ctx.ui.theme.fg("muted", "⠼"),
          ctx.ui.theme.fg("dim", "⠴"),
        ],
        intervalMs: 100,
      });
    }
  });
}
