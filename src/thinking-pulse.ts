/**
 * Thinking Pulse Extension
 *
 * When a thinking block is collapsed, pi shows a static "Thinking..." label.
 * That gives no feedback about whether reasoning tokens are still streaming,
 * so a live model can look stuck.
 *
 * This turns the collapsed label into a live indicator while reasoning tokens
 * arrive:
 *
 *     ⠹ Thinking… ≈1,284 tokens
 *
 * - A braille spinner animates only while thinking is actively streaming.
 * - A running token estimate (chars / 4) ticks up so you can watch tokens
 *   flow in. If the number stalls, the model is paused.
 * - When thinking ends (or text/tool-calls begin), the label reverts to pi's
 *   default "Thinking...".
 * - Only affects the collapsed view — expanded thinking is untouched.
 *
 * Drives ctx.ui.setHiddenThinkingLabel(), gated on the assistantMessageEvent
 * type from the message_update event.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 130;
// Rough chars-per-token estimate, for the display approximation only.
const CHARS_PER_TOKEN = 4;

type Ui = {
  setHiddenThinkingLabel?: (label?: string) => void;
} | undefined;

export function registerThinkingPulse(pi: ExtensionAPI): void {
  let thinkingActive = false;
  // AssistantMessage.content holds the thinking blocks, but the broader
  // AgentMessage union also permits string content, which a structural type
  // would reject. message_update only ever sets this to an assistant message,
  // so reading .content[].thinking is safe.
  let lastMessage: any = undefined;
  let interval: ReturnType<typeof setInterval> | null = null;
  let frameIdx = 0;
  let uiRef: Ui = undefined;

  function charCount(): number {
    let n = 0;
    const content = lastMessage?.content;
    if (!Array.isArray(content)) return n;
    for (const c of content) {
      if (c?.type === "thinking" && typeof c.thinking === "string") {
        n += c.thinking.length;
      }
    }
    return n;
  }

  function paint(): void {
    if (!thinkingActive) return;
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length]!;
    frameIdx++;
    const chars = charCount();
    const label =
      chars > 0
        ? `${frame} Thinking… ≈${Math.round(chars / CHARS_PER_TOKEN).toLocaleString()} tokens`
        : `${frame} Thinking…`;
    // No inline colors: AssistantMessageComponent wraps the label in the
    // thinkingText color + italic, so plain text matches the default look.
    uiRef?.setHiddenThinkingLabel?.(label);
  }

  function start(): void {
    if (interval) return; // already spinning
    thinkingActive = true;
    frameIdx = 0;
    paint(); // first frame immediately, no 130ms gap
    interval = setInterval(paint, FRAME_MS);
  }

  function stopTimer(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    thinkingActive = false;
  }

  function reset(): void {
    stopTimer();
    uiRef?.setHiddenThinkingLabel?.(); // restore pi's default label
  }

  pi.on("message_update", (event, ctx) => {
    if (!ctx.hasUI) return;
    uiRef = ctx.ui;
    lastMessage = event.message;

    const type = event.assistantMessageEvent?.type;
    if (type === "thinking_start" || type === "thinking_delta") {
      thinkingActive = true;
      start();
    } else if (
      type === "thinking_end" ||
      type === "text_start" ||
      type === "toolcall_start"
    ) {
      reset();
    }
  });

  // Safety nets so a spinner never outlives the response
  // (covers aborts, errors, and multi-turn loops).
  pi.on("message_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    reset();
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    reset();
  });

  // Clear any timer across reload / new session / resume / fork / quit.
  pi.on("session_shutdown", stopTimer);
  pi.on("session_start", stopTimer);
}
