import { Container, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const TRANSPARENT_BG = "\x1b[49m";
const TRANSPARENT_RESET = `${RESET}${TRANSPARENT_BG}`;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const WRAP_MARK = "\uE000";
const PATCH_FLAG = Symbol.for("pi-meron-footer:claude-tool-container-style");
const ORIGINAL_RENDER = Symbol.for("pi-meron-footer:claude-tool-container-original-render");

// Glass UI: subtle vertical accent bar
const GLASS_BAR = "\x1b[38;2;80;80;80m│\x1b[0m\x1b[49m";
const TOOL_RULE = "\x1b[38;2;100;100;100m";
const GLASS_PREFIX_W = 2;

export interface RenderThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface ToolContextLike {
  state?: unknown;
  toolName?: string;
  toolCallId?: string;
  executionStarted?: boolean;
  isPartial?: boolean;
  isError?: boolean;
  argsComplete?: boolean;
  expanded?: boolean;
  cwd?: string;
  lastComponent?: unknown;
  invalidate?: () => void;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function isBlankLine(text: string): boolean {
  return stripAnsi(text).trim().length === 0;
}

function clampLineWidth(line: string, width: number): string {
  if (width <= 0) return "";
  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

function borderLine(width: number): string {
  return `${TOOL_RULE}${"─".repeat(Math.max(1, width))}${TRANSPARENT_RESET}`;
}

function isHorizontalRuleLine(text: string): boolean {
  return /^─+$/.test(stripAnsi(text).trim());
}

function isToolExecutionLike(value: unknown): value is { toolName: string; toolCallId: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.toolName === "string" && typeof candidate.toolCallId === "string";
}

function normalizeLeadingCheckGlyph(line: string): string {
  return line.replace(/^((?:\x1b\[[0-9;]*m|[ \t])*)[✓✔](?=\s)/, "$1●");
}

export function patchToolContainerStyle(): void {
  const proto = Container.prototype as unknown as Record<PropertyKey, unknown>;
  const currentRender = proto.render;
  if (typeof currentRender !== "function") return;

  const originalRender = typeof proto[ORIGINAL_RENDER] === "function" ? proto[ORIGINAL_RENDER] : currentRender;
  proto[ORIGINAL_RENDER] = originalRender;

  proto.render = function patchedContainerRender(this: unknown, width: number): string[] {
    const rendered = (originalRender as (this: unknown, width: number) => string[]).call(this, width);
    if (!Array.isArray(rendered) || rendered.length === 0 || !isToolExecutionLike(this)) return rendered;

    let start = 0;
    while (start < rendered.length && isBlankLine(rendered[start] ?? "")) start++;
    let end = rendered.length - 1;
    while (end >= start && isBlankLine(rendered[end] ?? "")) end--;

    // If /reload replaces an older patch, strip its old horizontal rules before
    // adding the current theme-matched rules.
    while (start <= end && isHorizontalRuleLine(rendered[start] ?? "")) start++;
    while (end >= start && isHorizontalRuleLine(rendered[end] ?? "")) end--;
    if (start > end) return rendered;

    const core = rendered.slice(start, end + 1).map((line) => clampLineWidth(normalizeLeadingCheckGlyph(line), width));
    const spacerLine = " ".repeat(Math.max(1, width));
    return [spacerLine, ...core];
  };

  proto[PATCH_FLAG] = true;
}

function getState(ctx: ToolContextLike | undefined): Record<string, unknown> | undefined {
  if (!ctx?.state || typeof ctx.state !== "object" || Array.isArray(ctx.state)) return undefined;
  return ctx.state as Record<string, unknown>;
}

export function syncToolStatus(ctx: ToolContextLike | undefined): void {
  const state = getState(ctx);
  if (!state) return;
  if (!ctx?.executionStarted || ctx?.isPartial) state._toolStatus = "pending";
  else state._toolStatus = ctx.isError ? "error" : "success";
}

export function setToolResultStatus(ctx: ToolContextLike | undefined, isError = false): void {
  const state = getState(ctx);
  if (state) state._toolStatus = isError ? "error" : "success";
}

function statusDot(ctx: ToolContextLike | undefined, theme: RenderThemeLike): string {
  const status = getState(ctx)?._toolStatus;
  if (status === "success") return `${theme.fg("success", "●")} `;
  if (status === "error") return `${theme.fg("error", "●")} `;
  return `${theme.fg("text", "●")} `;
}

export function toolHeader(tool: string, summary: string, theme: RenderThemeLike, ctx?: ToolContextLike): string {
  syncToolStatus(ctx);
  const label = theme.fg("toolTitle", theme.bold(tool));
  return summary ? `${statusDot(ctx, theme)}${label} ${WRAP_MARK}${theme.fg("accent", summary)}` : `${statusDot(ctx, theme)}${label}`;
}

function branchIndent(text: string, continued = false): string {
  const prefix = continued ? `${TOOL_RULE}│${TRANSPARENT_RESET}  ` : "   ";
  return `${prefix}${WRAP_MARK}${text}`;
}

function branchLead(text: string, continued = false): string {
  return `${TOOL_RULE}${continued ? "├─" : "└─"}${TRANSPARENT_RESET} ${WRAP_MARK}${text}`;
}

export function withBranch(content: string, continued = false): string {
  if (!content || !content.trim()) return "";
  const lines = content.split("\n");
  const first = lines[0] ?? "";
  if (lines.length === 1) return branchLead(first, continued);
  const rest = lines.slice(1).map((line) => branchIndent(line, continued));
  return `${branchLead(first, continued)}\n${rest.join("\n")}`;
}

export function withFinalBranchBlock(content: string): string {
  if (!content || !content.trim()) return "";
  const lines = content.split("\n");
  const first = lines[0] ?? "";
  if (lines.length === 1) return branchLead(first, false);
  const middle = lines.slice(1, -1).map((line) => branchIndent(line, true));
  const last = lines[lines.length - 1] ?? "";
  return [branchLead(first, true), ...middle, branchLead(last, false)].join("\n");
}

function padToWidth(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function markedContinuationPrefix(prefix: string): string {
  const plain = stripAnsi(prefix);
  const branchMatch = /^(\s*)(?:│  |├─ |└─ )/.exec(plain);
  if (branchMatch) return `${branchMatch[1]}${TOOL_RULE}│${TRANSPARENT_RESET}  `;
  return " ".repeat(visibleWidth(prefix));
}

function wrapMarkedLine(line: string, width: number): string[] {
  const markerIndex = line.indexOf(WRAP_MARK);
  if (markerIndex === -1) return wrapTextWithAnsi(line, width);
  const prefix = line.slice(0, markerIndex);
  const body = line.slice(markerIndex + WRAP_MARK.length);
  const prefixWidth = visibleWidth(prefix);
  const bodyWidth = Math.max(1, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(body, bodyWidth);
  const continuation = markedContinuationPrefix(prefix);
  return wrapped.map((part, index) => (index === 0 ? `${prefix}${part}` : `${continuation}${part}`));
}

export class ToolText extends Text {
  private value = "";
  private cachedValue?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(text = "") {
    super("", 0, 0);
    this.value = text;
  }

  setText(text: string): void {
    if (this.value === text) return;
    this.value = text;
    this.invalidate();
  }

  override invalidate(): void {
    this.cachedValue = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  override render(width: number): string[] {
    if (this.cachedLines && this.cachedValue === this.value && this.cachedWidth === width) return this.cachedLines;
    if (!this.value || this.value.trim() === "") {
      this.cachedValue = this.value;
      this.cachedWidth = width;
      this.cachedLines = [];
      return this.cachedLines;
    }
    const lines = this.value.replace(/\t/g, "   ").split("\n");
    const rendered = lines.flatMap((line) => wrapMarkedLine(line, Math.max(1, width))).map((line) => padToWidth(line, width));
    this.cachedValue = this.value;
    this.cachedWidth = width;
    this.cachedLines = rendered;
    return rendered;
  }
}

export function makeToolText(last: unknown, text: string): ToolText {
  const component = last instanceof ToolText ? last : new ToolText();
  component.setText(text);
  return component;
}
