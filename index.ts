import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolDisplayExtension from "./src/index.js";
import { registerMeronFooter } from "./src/meron-footer.js";

export default function meronFooter(pi: ExtensionAPI): void {
	toolDisplayExtension(pi);
	registerMeronFooter(pi);
}
