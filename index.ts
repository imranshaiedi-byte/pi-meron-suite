import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodexUi } from "./src/codex-ui.js";
import { registerFooter } from "./src/footer.js";

export default function meronSuite(pi: ExtensionAPI): void {
  registerFooter(pi);
  registerCodexUi(pi);
}
