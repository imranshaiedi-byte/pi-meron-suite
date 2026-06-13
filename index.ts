import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolDisplayExtension from "./src/index.js";
import { registerFooter } from "./src/footer.js";
import { registerThinkingPulse } from "./src/thinking-pulse.js";

export default function meronSuite(pi: ExtensionAPI): void {
  toolDisplayExtension(pi);
  registerFooter(pi);
  registerThinkingPulse(pi);
}
