import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFooter } from "./src/footer.js";

const MERON_THEME = "meron";

export default function meronSuite(pi: ExtensionAPI): void {
  registerFooter(pi);

  // Editor border color is driven by theme tokens (thinking* / bashMode).
  // The meron theme sets those to truecolor #ffffff, so Pi's own
  // updateEditorBorderColor() keeps the border pure white — no property hacks.
  //
  // Apply as a Theme instance (not by name) so we don't rewrite settings.json.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (ctx.ui.theme?.name === MERON_THEME) return;

    const meron = ctx.ui.getTheme(MERON_THEME);
    if (!meron) return;

    const result = ctx.ui.setTheme(meron);
    if (!result.success) {
      ctx.ui.notify(`Meron theme failed to load: ${result.error ?? "unknown error"}`, "error");
    }
  });
}
