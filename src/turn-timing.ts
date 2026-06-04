import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerTurnTiming(_pi: ExtensionAPI): void {
  // Turn timing disabled — sendMessage causes agent loops,
  // widgets don't show in conversation. Revisit if Pi adds a
  // non-triggering conversation injection API.
}
