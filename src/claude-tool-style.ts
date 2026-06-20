import { Container, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const TRANSPARENT_BG = "\x1b[49m";
const TRANSPARENT_RESET = `${RESET}${TRANSPARENT_BG}`;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const WRAP_MARK = "\uE000";
const PATCH_FLAG = Symbol.for("pi-meron-suite:claude-tool-container-style");
const ORIGINAL_RENDER = Symbol.for("pi-meron-suite:claude-tool-container-original-render");

// Tool chrome is intentionally hardcoded white so grayscale-v5 stays truly grayscale.
const TOOL_RULE = "\x1b[38;2;255;255;255m";

// Tools that collapse to a single bare line (no panel border) when not expanded.
const SINGLE_LINE_TOOLS = new Set(["read", "bash", "grep", "find", "ls", "edit", "write"]);
// Expanded gutter must align with collapsed output. Collapsed lines still pass
// through the old Box's single left pad before their own " │ " gutter, so the
// effective visible prefix is "  │ ".
const SINGLE_LINE_TOOL_GUTTER = "  │ ";
const SINGLE_LINE_TOOL_GUTTER_PATTERN = /^│\s+●\s/;

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

function isHorizontalRuleLine(text: string): boolean {
  return /^─+$/.test(stripAnsi(text).trim());
}

function isSingleLineToolLine(text: string): boolean {
  return SINGLE_LINE_TOOL_GUTTER_PATTERN.test(stripAnsi(text).trimStart());
}

function spaceBeforeToolBlocks(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const out: string[] = [];
  for (const line of lines) {
    const isToolLine = isSingleLineToolLine(line);
    const prev = out[out.length - 1];
    const prevIsToolLine = prev !== undefined && isSingleLineToolLine(prev);
    const prevIsBlank = prev === undefined || isBlankLine(prev);
    if (isToolLine && !prevIsToolLine && !prevIsBlank) {
      out.push("");
    }
    out.push(line);
  }
  return out;
}

function isToolExecutionLike(value: unknown): value is { toolName: string; toolCallId: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.toolName === "string" && typeof candidate.toolCallId === "string";
}

// AssistantMessageComponent (extends Container) is the only block carrying a
// string `hiddenThinkingLabel`. We detect it to strip the "Thinking..." line.
function isAssistantMessageLike(
  value: unknown,
): value is { hideThinkingBlock?: unknown; hiddenThinkingLabel: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { hiddenThinkingLabel?: unknown }).hiddenThinkingLabel === "string"
  );
}

// Remove the hidden-thinking placeholder line and collapse the leftover blanks
// down to a single separator line.
function stripHiddenThinkingLabel(
  self: { hideThinkingBlock?: unknown; hiddenThinkingLabel: string },
  lines: string[],
): string[] {
  const label = self.hiddenThinkingLabel.trim();
  if (self.hideThinkingBlock !== true || !label || !Array.isArray(lines)) return lines;
  const kept = lines.filter((line) => stripAnsi(line).trim() !== label);
  if (kept.length === lines.length) return lines;
  const collapsed: string[] = [];
  for (const line of kept) {
    const blank = isBlankLine(line);
    if (blank && collapsed.length > 0 && collapsed[collapsed.length - 1] === "") continue;
    collapsed.push(blank ? "" : line);
  }
  let end = collapsed.length - 1;
  while (end >= 0 && collapsed[end] === "") end--;
  const trimmed = collapsed.slice(0, end + 1);
  return trimmed.length > 0 ? trimmed : [""];
}

function normalizeLeadingCheckGlyph(line: string): string {
  return line.replace(/^((?:\x1b\[[0-9;]*m|[ \t])*)[✓✔](?=\s)/, "$1●");
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function displayToolName(toolName: string): string {
  const normalized = toolName.toLowerCase();
  const labels: Record<string, string> = {
    ask_user_question: "Ask",
    web_search: "Search",
    web_fetch: "Fetch",
  };
  return labels[normalized] ?? capitalize(toolName.replace(/_/g, " "));
}

function normalizePanelLine(toolName: string, line: string): string {
  const normalizedTool = toolName.toLowerCase();
  const plain = stripAnsi(line).trimStart();
  const leading = line.slice(0, line.length - line.trimStart().length);

  if (normalizedTool === "web_search" && plain.startsWith("WebSearch ")) {
    return `${leading || " "}${plain.slice("WebSearch ".length)}`;
  }
  if (normalizedTool === "web_fetch" && plain.startsWith("WebFetch ")) {
    return `${leading || " "}${plain.slice("WebFetch ".length)}`;
  }
  return line;
}

function getStatus(container: any): string {
  if (container.state && typeof container.state === "object" && "_toolStatus" in container.state) {
    return container.state._toolStatus as string;
  }
  return "pending";
}

function toolChrome(text: string): string {
  return `${TOOL_RULE}${text}${TRANSPARENT_RESET}`;
}

function buildTopBorder(toolName: string, _status: string, width: number): string {
  const badge = ` ${displayToolName(toolName)} `;
  const badgeWidth = visibleWidth(badge);
  const fixedVisibleWidth = 2 + badgeWidth + 1 + 2; // ╭─, badge, ●, ─╮
  const fillVisibleWidth = Math.max(0, width - fixedVisibleWidth);
  const fill = "─".repeat(fillVisibleWidth);

  return toolChrome(`╭─${badge}${fill}●─╮`);
}

function buildBottomBorder(width: number): string {
  const fillWidth = Math.max(0, width - 4);
  const fill = "─".repeat(fillWidth);
  return toolChrome(`╰─${fill}─╯`);
}

function wrapLineWithBorders(line: string, innerWidth: number): string {
  const paddedLine = padToWidth(line, innerWidth);
  return `${toolChrome("│")}${paddedLine}${toolChrome("│")}`;
}

export function patchToolContainerStyle(): void {
  const proto = Container.prototype as unknown as Record<PropertyKey, unknown>;
  const currentRender = proto.render;
  if (typeof currentRender !== "function") return;

  const originalRender = typeof proto[ORIGINAL_RENDER] === "function" ? proto[ORIGINAL_RENDER] : currentRender;
  proto[ORIGINAL_RENDER] = originalRender;

  proto.render = function patchedContainerRender(this: unknown, width: number): string[] {
    // Assistant message with hidden thinking: drop the "Thinking..." placeholder.
    if (isAssistantMessageLike(this)) {
      const lines = (originalRender as (this: unknown, width: number) => string[]).call(this, width);
      return spaceBeforeToolBlocks(stripHiddenThinkingLabel(this, lines));
    }

    // Not a tool execution, use original render
    if (!isToolExecutionLike(this)) {
      const lines = (originalRender as (this: unknown, width: number) => string[]).call(this, width);
      return spaceBeforeToolBlocks(lines);
    }

    // Built-in tool overrides render as guttered blocks (collapsed = one line,
    // expanded = same gutter with body underneath), never as boxed panels.
    const toolNameLower = String((this as { toolName?: unknown }).toolName ?? "").toLowerCase();
    const collapsed = (this as { expanded?: unknown }).expanded !== true;
    if (SINGLE_LINE_TOOLS.has(toolNameLower)) {
      const bare = (originalRender as (this: unknown, width: number) => string[]).call(this, width);
      if (!Array.isArray(bare) || bare.length === 0) return [];
      let s = 0;
      while (s < bare.length && isBlankLine(bare[s] ?? "")) s++;
      let e = bare.length - 1;
      while (e >= s && isBlankLine(bare[e] ?? "")) e--;
      while (s <= e && isHorizontalRuleLine(bare[s] ?? "")) s++;
      while (e >= s && isHorizontalRuleLine(bare[e] ?? "")) e--;
      if (s > e) return [];

      const body = bare.slice(s, e + 1).map((line) => normalizeLeadingCheckGlyph(line));
      if (collapsed) {
        return body.map((line) => clampLineWidth(line, width));
      }

      const innerWidth = Math.max(1, width - visibleWidth(SINGLE_LINE_TOOL_GUTTER));
      const lines: string[] = [];
      for (const line of body) {
        const content = isBlankLine(line)
          ? ""
          // Strip only the old Box's single left pad before applying our gutter
          // so expanded headers align with collapsed lines while preserving body
          // continuation indentation.
          : clampLineWidth(line.replace(/^ /, ""), innerWidth);
        lines.push(`${SINGLE_LINE_TOOL_GUTTER}${content}`);
      }
      return lines;
    }

    // Tool execution: render content at reduced width for panel borders
    const innerWidth = Math.max(1, width - 2);
    const rendered = (originalRender as (this: unknown, width: number) => string[]).call(this, innerWidth);
    
    if (!Array.isArray(rendered) || rendered.length === 0) {
      return [
        buildTopBorder(this.toolName, getStatus(this), width),
        buildBottomBorder(width)
      ];
    }

    // Trim blank lines and horizontal rules
    let start = 0;
    while (start < rendered.length && isBlankLine(rendered[start] ?? "")) start++;
    let end = rendered.length - 1;
    while (end >= start && isBlankLine(rendered[end] ?? "")) end--;
    while (start <= end && isHorizontalRuleLine(rendered[start] ?? "")) start++;
    while (end >= start && isHorizontalRuleLine(rendered[end] ?? "")) end--;
    
    if (start > end) {
      // Empty content, show empty panel
      return [
        buildTopBorder(this.toolName, getStatus(this), width),
        buildBottomBorder(width)
      ];
    }

    const core = rendered.slice(start, end + 1).map((line) => {
      const normalized = normalizePanelLine(this.toolName, normalizeLeadingCheckGlyph(line));
      const clamped = clampLineWidth(normalized, innerWidth);
      return wrapLineWithBorders(clamped, innerWidth);
    });

    return [
      buildTopBorder(this.toolName, getStatus(this), width),
      ...core,
      buildBottomBorder(width)
    ];
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
  if (status === "pending") return `${theme.fg("dim", "●")} `;
  return `${theme.fg("muted", "●")} `;
}

export function toolHeader(_tool: string, summary: string, theme: RenderThemeLike, ctx?: ToolContextLike): string {
  syncToolStatus(ctx);
  // Tool name is already shown in the panel border; keep the inner line focused on the action/target.
  return summary ? `${statusDot(ctx, theme)}${WRAP_MARK}${theme.fg("accent", summary)}` : `${statusDot(ctx, theme)}`;
}

function branchIndent(text: string, continued = false): string {
  const prefix = continued ? `${toolChrome("│")}  ` : "   ";
  return `${prefix}${WRAP_MARK}${text}`;
}

function branchLead(text: string, continued = false): string {
  return `${toolChrome(continued ? "├─" : "└─")} ${WRAP_MARK}${text}`;
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
  if (branchMatch) return `${branchMatch[1]}${toolChrome("│")}  `;
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
