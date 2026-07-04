import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { registerFooter } from "./src/footer.js";

const WHITE_BORDER = (s: string) => `\x1b[37m${s}\x1b[0m`;

export default function meronSuite(pi: ExtensionAPI): void {
  registerFooter(pi);

  // Force editor border to pure white (instead of thinking-level colors)
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new CustomEditor(tui, theme, keybindings);
      // Lock borderColor to pure white — ignore any later changes
      // from updateEditorBorderColor() (thinking level / bash mode)
      Object.defineProperty(editor, "borderColor", {
        get: () => WHITE_BORDER,
        set: () => {},
        configurable: true,
        enumerable: true,
      });
      return editor;
    });
  });
}
