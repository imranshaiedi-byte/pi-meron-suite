import { UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const TRANSPARENT_BG = "\x1b[49m";
const WHITE = "\x1b[38;2;255;255;255m";
const CHROME_RESET = `${RESET}${TRANSPARENT_BG}`;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const PATCH_OWNER = "pi-meron-suite:user-message-box";
const CONTENT_PAD = 1;

interface PatchableUserMessagePrototype {
  render(width: number): string[];
  __piMeronUserMessageOriginalRender?: (width: number) => string[];
  __piMeronUserMessagePatched?: boolean;
  __piMeronUserMessageOwner?: string;
}

function chrome(text: string): string {
  return `${WHITE}${text}${CHROME_RESET}`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function isBlankLine(text: string): boolean {
  return stripAnsi(text).trim().length === 0;
}

function padToWidth(line: string, width: number): string {
  const clamped = visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  return `${clamped}${" ".repeat(Math.max(0, width - visibleWidth(clamped)))}`;
}

function buildTopBorder(width: number): string {
  const title = " You ";
  const fixedWidth = 2 + visibleWidth(title) + 1; // ╭─, title, ╮
  const fill = "─".repeat(Math.max(0, width - fixedWidth));
  return chrome(`╭─${title}${fill}╮`);
}

function buildBottomBorder(width: number): string {
  const fillWidth = Math.max(0, width - 4);
  const fill = "─".repeat(fillWidth);
  return chrome(`╰─${fill}─╯`);
}

function wrapLine(line: string, contentWidth: number): string {
  const pad = " ".repeat(CONTENT_PAD);
  return `${chrome("│")}${pad}${padToWidth(line, contentWidth)}${pad}${chrome("│")}`;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && isBlankLine(lines[start] ?? "")) start++;
  let end = lines.length - 1;
  while (end >= start && isBlankLine(lines[end] ?? "")) end--;
  return start <= end ? lines.slice(start, end + 1) : [];
}

function patchUserMessagePrototype(): void {
  const proto = UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;
  if (typeof proto.render !== "function") return;

  if (proto.__piMeronUserMessagePatched && proto.__piMeronUserMessageOwner === PATCH_OWNER) {
    return;
  }

  if (!proto.__piMeronUserMessageOriginalRender) {
    proto.__piMeronUserMessageOriginalRender = proto.render;
  }

  const originalRender = proto.__piMeronUserMessageOriginalRender;
  proto.render = function renderWithMeronUserBox(this: unknown, width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth < 8) {
      return originalRender.call(this, safeWidth);
    }

    const contentWidth = Math.max(1, safeWidth - 2 - CONTENT_PAD * 2);
    const rendered = originalRender.call(this, contentWidth);
    const content = trimBlankEdges(Array.isArray(rendered) ? rendered : []);
    const body = content.length > 0 ? content : [""];

    return [
      "",
      buildTopBorder(safeWidth),
      ...body.map((line) => wrapLine(line, contentWidth)),
      buildBottomBorder(safeWidth),
    ];
  };

  proto.__piMeronUserMessagePatched = true;
  proto.__piMeronUserMessageOwner = PATCH_OWNER;
}

function restoreUserMessagePrototype(): void {
  const proto = UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;
  const original = proto.__piMeronUserMessageOriginalRender;
  if (typeof original === "function") {
    proto.render = original;
  }
  delete proto.__piMeronUserMessageOriginalRender;
  delete proto.__piMeronUserMessagePatched;
  delete proto.__piMeronUserMessageOwner;
}

export function registerUserMessageBox(pi: ExtensionAPI): void {
  patchUserMessagePrototype();

  pi.on("session_start", async () => {
    patchUserMessagePrototype();
  });

  pi.on("before_agent_start", async () => {
    patchUserMessagePrototype();
  });

  pi.on("session_shutdown", async (event: { reason?: string }) => {
    if (event?.reason === "reload") {
      restoreUserMessagePrototype();
    }
  });
}
