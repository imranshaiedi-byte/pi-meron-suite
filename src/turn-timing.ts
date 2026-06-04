import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

let turnStartTime: number | undefined;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function registerTurnTiming(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("meron-turn-timing", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(theme.fg("dim", content), 0, 0);
  });

  pi.on("agent_start", async () => {
    turnStartTime = Date.now();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!turnStartTime) return;
    const duration = formatDuration(Date.now() - turnStartTime);
    turnStartTime = undefined;

    pi.sendMessage({
      customType: "meron-turn-timing",
      content: `──── ${duration} ────`,
      display: true,
    }, { triggerTurn: false });
  });
}
