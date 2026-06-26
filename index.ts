import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFooter } from "./src/footer.js";

export default function meronSuite(pi: ExtensionAPI): void {
  registerFooter(pi);
}
