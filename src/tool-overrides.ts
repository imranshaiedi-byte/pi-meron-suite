import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ReadToolDetails,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  makeToolText,
  patchToolContainerStyle,
  setToolResultStatus,
  syncToolStatus,
  toolHeader,
  withBranch,
} from "./claude-tool-style.js";
import { logToolDisplayDebug } from "./debug-logger.js";
import {
  compactOutputLines,
  countNonEmptyLines,
  extractTextOutput,
  isLikelyQuietCommand,
  pluralize,
  previewLines,
  sanitizeAnsiForThemedOutput,
  shortenPath,
  splitLines,
} from "./render-utils.js";
import { renderEditDiffResult, renderWriteDiffResult } from "./diff-renderer.js";
import {
  buildPendingEditPreviewData,
  buildPendingWritePreviewData,
  readWorkspaceUtf8File,
  type PendingDiffPreviewData,
} from "./pending-diff-preview.js";
import {
  buildPromptSnippetFromDescription,
  extractPromptMetadata,
  getTextField,
  isMcpToolCandidate,
  MCP_PROXY_PROMPT_GUIDELINES,
  MCP_PROXY_PROMPT_SNIPPET,
  toRecord,
} from "./tool-metadata.js";
import type {
  BuiltInToolOverrideName,
  ToolDisplayConfig,
} from "./types.js";
import {
  countWriteContentLines,
  getWriteContentSizeBytes,
  shouldRenderWriteCallSummary,
} from "./write-display-utils.js";

type RuntimeToolDefinition = Record<string, unknown>;

type BuiltInTools = Record<BuiltInToolOverrideName, RuntimeToolDefinition>;

type ConfigGetter = () => ToolDisplayConfig;

interface RenderTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
  getBgAnsi?(color: string): string;
}

interface RtkCompactionInfo {
  applied: boolean;
  techniques: string[];
  truncated: boolean;
  originalLineCount?: number;
  compactedLineCount?: number;
}

interface ToolRenderContextLike {
  args?: unknown;
  toolCallId?: string;
  state?: unknown;
  isError?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
}

export interface WriteExecutionMeta {
  previousContent?: string;
  fileExistedBeforeWrite: boolean;
}

interface PendingDiffPreviewState {
  key?: string;
  data?: PendingDiffPreviewData;
}

const RTK_COMPACTION_LABEL = "compacted by RTK";
export const WRITE_EXECUTION_META_LIMIT = 100;
const WRITE_EXECUTION_META_STATE_KEY = "__piToolDisplayWriteExecutionMeta";
const EDIT_PENDING_PREVIEW_STATE_KEY = "__piToolDisplayEditPendingPreview";
const WRITE_PENDING_PREVIEW_STATE_KEY = "__piToolDisplayWritePendingPreview";

function registerRuntimeTool(pi: ExtensionAPI, tool: RuntimeToolDefinition): void {
  pi.registerTool(tool as unknown as ToolDefinition);
}

function getToolPrepareArguments(tool: unknown): unknown {
  const prepareArguments = toRecord(tool).prepareArguments;
  return typeof prepareArguments === "function" ? prepareArguments : undefined;
}

function cloneToolParameters<T>(parameters: T, seen = new WeakMap<object, unknown>()): T {
  if (parameters === null || typeof parameters !== "object") {
    return parameters;
  }

  if (seen.has(parameters)) {
    return seen.get(parameters) as T;
  }

  const clone = Array.isArray(parameters)
    ? []
    : Object.create(Object.getPrototypeOf(parameters));
  seen.set(parameters, clone);

  for (const key of Reflect.ownKeys(parameters)) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    if (!descriptor) {
      continue;
    }

    if ("value" in descriptor) {
      descriptor.value = cloneToolParameters(descriptor.value, seen);
    }

    Object.defineProperty(clone, key, descriptor);
  }

  return clone as T;
}

async function getBuiltInTools(cwd: string): Promise<BuiltInTools> {
  const tools = await import("@earendil-works/pi-coding-agent") as Record<string, unknown>;
  const createReadTool = tools.createReadTool as (cwd: string) => RuntimeToolDefinition;
  const createGrepTool = tools.createGrepTool as (cwd: string) => RuntimeToolDefinition;
  const createFindTool = tools.createFindTool as (cwd: string) => RuntimeToolDefinition;
  const createLsTool = tools.createLsTool as (cwd: string) => RuntimeToolDefinition;
  const createBashTool = tools.createBashTool as (cwd: string) => RuntimeToolDefinition;
  const createEditTool = tools.createEditTool as (cwd: string) => RuntimeToolDefinition;
  const createWriteTool = tools.createWriteTool as (cwd: string) => RuntimeToolDefinition;

  if (
    typeof createReadTool !== "function" ||
    typeof createGrepTool !== "function" ||
    typeof createFindTool !== "function" ||
    typeof createLsTool !== "function" ||
    typeof createBashTool !== "function" ||
    typeof createEditTool !== "function" ||
    typeof createWriteTool !== "function"
  ) {
    throw new Error("Pi built-in tool factories were not available.");
  }

  return {
    read: createReadTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
  };
}

async function executeBuiltInTool(
  tool: RuntimeToolDefinition,
  toolCallId: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
): Promise<unknown> {
  const execute = tool.execute;
  if (typeof execute !== "function") {
    throw new Error("Wrapped built-in tool is missing execute().");
  }
  return await Promise.resolve(execute.call(tool, toolCallId, params, signal, onUpdate, ctx));
}

function formatSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const precision = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function captureExistingWriteContent(
  cwd: string,
  rawPath: unknown,
): { existed: boolean; content?: string } {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { existed: false };
  }

  const existing = readWorkspaceUtf8File(cwd, rawPath);
  return {
    existed: existing.exists,
    content: existing.content,
  };
}

function formatExpandHint(theme: RenderTheme): string {
  return theme.fg("muted", " • Ctrl+O to expand");
}

function styledText(context: ToolRenderContextLike | undefined, text: string): Text {
  return makeToolText((context as { lastComponent?: unknown } | undefined)?.lastComponent, text);
}

function branchText(context: ToolRenderContextLike | undefined, text: string): Text {
  return styledText(context, withBranch(text));
}

function buildPreviewText(
  lines: string[],
  maxLines: number,
  theme: RenderTheme,
  expanded: boolean,
): string {
  if (lines.length === 0) {
    return theme.fg("muted", "↳ (no output)");
  }

  const { shown, remaining } = previewLines(lines, maxLines);
  let text = shown
    .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
    .join("\n");
  if (remaining > 0) {
    const hint = expanded ? "" : " • Ctrl+O to expand";
    text += `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
  }
  return text;
}

function prepareOutputLines(
  rawText: string,
  options: ToolRenderResultOptions,
): string[] {
  return compactOutputLines(splitLines(rawText), {
    expanded: options.expanded,
    maxCollapsedConsecutiveEmptyLines: 1,
  });
}

function formatBashNoOutputLine(
  command: string | undefined,
  theme: RenderTheme,
): string {
  if (isLikelyQuietCommand(command)) {
    return theme.fg("muted", "Command completed (no output)");
  }
  return theme.fg("muted", "(no output)");
}

function truncateEndToWidth(text: string, width: number): string {
  return visibleWidth(text) <= width ? text : truncateToWidth(text, width, "...");
}

function formatCollapsedBashCommand(
  command: string,
  theme: RenderTheme,
): string {
  const rawCommand = command.trim();
  if (!rawCommand) {
    return "...";
  }

  const commandLines = rawCommand
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const flattened = rawCommand.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ").trim();
  const display = truncateEndToWidth(flattened, 88);
  const hints: string[] = [];

  if (commandLines.length > 1) {
    hints.push(`${commandLines.length} lines`);
  } else if (visibleWidth(flattened) > visibleWidth(display)) {
    hints.push("truncated");
  }

  return hints.length > 0
    ? `${display}${theme.fg("muted", ` (${hints.join(" • ")} • Ctrl+O)`)}`
    : display;
}

function truncationHint(
  details: { truncation?: { truncated?: boolean } } | undefined,
): string {
  return details?.truncation?.truncated ? " • truncated" : "";
}

function countTextLines(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  return splitLines(value).length;
}

function getStringField(value: unknown, field: string): string | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "string" ? raw : undefined;
}

function getNumericField(value: unknown, field: string): number | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function getToolPathArg(value: unknown): string | undefined {
  return getStringField(value, "file_path") ?? getStringField(value, "path");
}

function getToolContentArg(value: unknown): string | undefined {
  return getStringField(value, "content");
}

function getEditLineCount(value: unknown): number {
  const record = toRecord(value);
  const edits = Array.isArray(record.edits) ? record.edits : [];
  if (edits.length > 0) {
    return edits.reduce((total, edit) => {
      return total + countTextLines(getStringField(edit, "newText"));
    }, 0);
  }

  return countTextLines(record.newText);
}

function isToolError(
  result: unknown,
  context?: ToolRenderContextLike,
): boolean {
  return context?.isError === true || toRecord(result).isError === true;
}

function toStateCarrier(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function renderCollapsedSummary(
  context: ToolRenderContextLike | undefined,
  _config: ToolDisplayConfig,
  summary: string,
  _theme: RenderTheme,
): Text {
  return branchText(context, summary);
}

export function recordWriteExecutionMeta(
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
  toolCallId: string,
  meta: WriteExecutionMeta,
): void {
  pendingMetaByToolCallId.delete(toolCallId);
  pendingMetaByToolCallId.set(toolCallId, meta);

  while (pendingMetaByToolCallId.size > WRITE_EXECUTION_META_LIMIT) {
    const oldestToolCallId = pendingMetaByToolCallId.keys().next().value;
    if (oldestToolCallId === undefined) {
      return;
    }
    pendingMetaByToolCallId.delete(oldestToolCallId);
  }
}

export function clearWriteExecutionMeta(
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): void {
  pendingMetaByToolCallId.clear();
}

export function getWriteExecutionMeta(
  context: ToolRenderContextLike | undefined,
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): WriteExecutionMeta | undefined {
  if (!context) {
    return undefined;
  }

  const carrier = toStateCarrier(context.state);
  const existing = carrier
    ? toRecord(carrier[WRITE_EXECUTION_META_STATE_KEY])
    : undefined;
  if (existing && Object.keys(existing).length > 0) {
    return existing as unknown as WriteExecutionMeta;
  }

  if (!context.toolCallId) {
    return undefined;
  }

  const pending = pendingMetaByToolCallId.get(context.toolCallId);
  if (!pending) {
    return undefined;
  }

  if (carrier) {
    const storedMeta: WriteExecutionMeta = { ...pending };
    carrier[WRITE_EXECUTION_META_STATE_KEY] = storedMeta;
    pendingMetaByToolCallId.delete(context.toolCallId);
    return storedMeta;
  }

  return pending;
}

function getPendingDiffPreviewState(
  context: ToolRenderContextLike | undefined,
  stateKey: string,
): PendingDiffPreviewState | undefined {
  const carrier = toStateCarrier(context?.state);
  if (!carrier) {
    return undefined;
  }

  const current = carrier[stateKey];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as PendingDiffPreviewState;
  }

  const next: PendingDiffPreviewState = {};
  carrier[stateKey] = next;
  return next;
}

function resolvePendingDiffPreview(
  context: ToolRenderContextLike | undefined,
  stateKey: string,
  previewKey: string | undefined,
  compute: () => PendingDiffPreviewData | undefined,
): PendingDiffPreviewData | undefined {
  const previewState = getPendingDiffPreviewState(context, stateKey);
  if (!previewState) {
    return compute();
  }

  if (previewState.key !== previewKey) {
    previewState.key = previewKey;
    previewState.data = previewKey ? compute() : undefined;
  }

  return previewState.data;
}

function buildPendingDiffCallComponent(
  summaryText: string,
  previewData: PendingDiffPreviewData | undefined,
  context: ToolRenderContextLike | undefined,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): Text | Container {
  if (!context?.isPartial || !previewData) {
    return new Text(summaryText, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(summaryText, 0, 0));
  container.addChild(new Spacer(1));

  if (previewData.notice || typeof previewData.nextContent !== "string") {
    container.addChild(new Text(theme.fg("warning", previewData.notice || "Preview unavailable."), 0, 0));
    return container;
  }

  container.addChild(
    renderWriteDiffResult(
      previewData.nextContent,
      {
        expanded: context.expanded === true,
        filePath: previewData.filePath,
        previousContent: previewData.previousContent,
        fileExistedBeforeWrite: previewData.fileExistedBeforeWrite,
        headerLabel: previewData.headerLabel,
      },
      config,
      theme,
      "",
    ),
  );
  return container;
}

function formatLineCountSuffix(
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")})`);
}

function formatWriteCallSuffix(
  lineCount: number,
  sizeBytes: number,
  theme: RenderTheme,
): string {
  return theme.fg(
    "muted",
    ` (${lineCount} ${pluralize(lineCount, "line")} • ${formatSize(sizeBytes)})`,
  );
}

function formatInProgressLineCount(
  action: string,
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("warning", `${action}...`) + formatLineCountSuffix(lineCount, theme);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getRtkCompactionInfo(details: unknown): RtkCompactionInfo | undefined {
  const detailRecord = toRecord(details);
  const metadataRecord = toRecord(detailRecord.metadata);
  const topLevel = toRecord(detailRecord.rtkCompaction);
  const nested = toRecord(metadataRecord.rtkCompaction);

  const source =
    Object.keys(topLevel).length > 0
      ? topLevel
      : Object.keys(nested).length > 0
        ? nested
        : undefined;

  if (!source) {
    return undefined;
  }

  const techniques = toStringArray(source.techniques);
  const info: RtkCompactionInfo = {
    applied: source.applied === true,
    techniques,
    truncated: source.truncated === true,
    originalLineCount: normalizePositiveInteger(source.originalLineCount),
    compactedLineCount: normalizePositiveInteger(source.compactedLineCount),
  };

  if (
    !info.applied &&
    info.techniques.length === 0 &&
    !info.truncated &&
    info.originalLineCount === undefined &&
    info.compactedLineCount === undefined
  ) {
    return undefined;
  }

  return info;
}

function formatRtkTechniqueList(techniques: string[]): string {
  if (techniques.length === 0) {
    return "";
  }

  const visible = techniques.slice(0, 3).join(", ");
  const hidden = techniques.length - 3;
  return hidden > 0 ? `${visible}, +${hidden} more` : visible;
}

function formatRtkSummarySuffix(
  details: unknown,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): string {
  if (!config.showRtkCompactionHints) {
    return "";
  }

  const info = getRtkCompactionInfo(details);
  if (!info?.applied) {
    return "";
  }

  const segments: string[] = [RTK_COMPACTION_LABEL];

  const techniqueText = formatRtkTechniqueList(info.techniques);
  if (techniqueText) {
    segments.push(techniqueText);
  }
  if (info.truncated) {
    segments.push("RTK removed content");
  }

  if (segments.length === 0) {
    return "";
  }

  return theme.fg("warning", ` • ${segments.join(" • ")}`);
}

function formatRtkPreviewHint(
  details: unknown,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): string {
  if (!config.showRtkCompactionHints) {
    return "";
  }

  const info = getRtkCompactionInfo(details);
  if (!info?.applied) {
    return "";
  }

  const hints: string[] = [];
  const techniqueText = formatRtkTechniqueList(info.techniques);
  if (techniqueText) {
    hints.push(`${RTK_COMPACTION_LABEL}: ${techniqueText}`);
  } else {
    hints.push(`${RTK_COMPACTION_LABEL} applied`);
  }

  if (
    info.originalLineCount !== undefined &&
    info.compactedLineCount !== undefined &&
    info.originalLineCount > info.compactedLineCount
  ) {
    hints.push(`${info.compactedLineCount}/${info.originalLineCount} lines kept`);
  }

  if (info.truncated) {
    hints.push("RTK removed content");
  }

  return hints.length > 0
    ? `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`
    : "";
}

function formatReadSummary(
  lines: string[],
  details: ReadToolDetails | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  let summary = theme.fg(
    "muted",
    `${lineCount} ${pluralize(lineCount, "line")} loaded`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatSearchSummary(
  lines: string[],
  unitLabel: string,
  details: { truncation?: { truncated?: boolean } } | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
  pluralLabel?: string,
): string {
  const count = countNonEmptyLines(lines);
  let summary = theme.fg(
    "muted",
    `${count} ${pluralize(count, unitLabel, pluralLabel)} returned`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatBashSummary(
  lines: string[],
  _details: BashToolDetails | undefined,
  theme: RenderTheme,
  _showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  return theme.fg(
    "muted",
    `${lineCount} ${pluralize(lineCount, "line")} returned`,
  );
}

function formatBashTruncationHints(
  details: BashToolDetails | undefined,
  theme: RenderTheme,
): string {
  if (!details) {
    return "";
  }

  const hints: string[] = [];
  if (details.truncation?.truncated) {
    hints.push("output truncated");
  }
  if (details.fullOutputPath) {
    hints.push(`full output: ${details.fullOutputPath}`);
  }
  if (hints.length === 0) {
    return "";
  }
  return `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
}

function renderBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
  context?: ToolRenderContextLike,
): Text {
  if (options.isPartial && !options.expanded) {
    return styledText(context, "");
  }

  const lines = prepareOutputLines(rawOutput, options);
  if (!options.expanded) {
    let summary = lines.length === 0
      ? formatBashNoOutputLine(getStringField(context?.args, "command"), theme)
      : formatBashSummary(lines, details, theme, config.showTruncationHints);
    if (config.showTruncationHints) {
      summary += formatBashTruncationHints(details, theme).replace(/^\n/, " • ");
    }
    if (lines.length > 0) {
      summary += formatExpandHint(theme);
    }
    return renderCollapsedSummary(context, config, summary, theme);
  }

  let preview = buildPreviewText(lines, lines.length, theme, true);
  if (config.showTruncationHints) {
    preview += formatBashTruncationHints(details, theme);
  }
  return branchText(context, preview);
}

function renderBashErrorResult(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
  context?: ToolRenderContextLike,
): Text {
  const lines = prepareOutputLines(rawOutput, options);
  let text = theme.fg("error", "Command failed");

  if (!options.expanded) {
    let summary = theme.fg("error", "failed");
    if (lines.length > 0) {
      summary += theme.fg("muted", ` • ${lines.length} ${pluralize(lines.length, "line")} returned`);
      summary += formatExpandHint(theme);
    }
    if (config.showTruncationHints) {
      summary += formatBashTruncationHints(details, theme).replace(/^\n/, " • ");
    }
    return renderCollapsedSummary(context, config, summary, theme);
  }

  if (lines.length > 0) {
    text += `\n${lines
      .map((line) => theme.fg("error", sanitizeAnsiForThemedOutput(line)))
      .join("\n")}`;
  }

  if (config.showTruncationHints) {
    text += formatBashTruncationHints(details, theme);
  }

  return branchText(context, text);
}

function renderSearchResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  unitLabel: string,
  details: GrepToolDetails | FindToolDetails | LsToolDetails | undefined,
  pluralLabel?: string,
  context?: ToolRenderContextLike,
): Text {
  if (options.isPartial) {
    return styledText(context, "");
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);

  if (!options.expanded) {
    let summary = formatSearchSummary(
      lines,
      unitLabel,
      details,
      theme,
      config.showTruncationHints,
      pluralLabel,
    );
    summary += formatExpandHint(theme);
    summary += formatRtkSummarySuffix(details, config, theme);
    return renderCollapsedSummary(context, config, summary, theme);
  }

  let preview = buildPreviewText(lines, lines.length, theme, true);
  if (config.showTruncationHints && details?.truncation?.truncated) {
    preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
  }
  preview += formatRtkPreviewHint(details, config, theme);
  return branchText(context, preview);
}

function resolveMcpProxyCallTarget(args: Record<string, unknown>): string {
  const tool = getTextField(args, "tool");
  const connect = getTextField(args, "connect");
  const describe = getTextField(args, "describe");
  const search = getTextField(args, "search");
  const server = getTextField(args, "server");

  if (tool) {
    return server ? `call ${server}:${tool}` : `call ${tool}`;
  }
  if (connect) {
    return `connect ${connect}`;
  }
  if (describe) {
    return server ? `describe ${describe} @${server}` : `describe ${describe}`;
  }
  if (search) {
    return server ? `search "${search}" @${server}` : `search "${search}"`;
  }
  if (server) {
    return `tools ${server}`;
  }
  return "status";
}

function formatMcpCallLine(
  toolName: string,
  toolLabel: string,
  args: Record<string, unknown>,
  theme: RenderTheme,
): Text {
  const argCount = Object.keys(args).length;
  const argSuffix =
    argCount === 0
      ? theme.fg("muted", " (no args)")
      : theme.fg("muted", ` (${argCount} ${pluralize(argCount, "arg")})`);
  const target =
    toolName === "mcp"
      ? resolveMcpProxyCallTarget(args)
      : toolLabel.startsWith("MCP ")
        ? toolLabel.slice("MCP ".length)
        : toolLabel;

  return new Text(
    `${theme.fg("toolTitle", theme.bold("MCP"))} ${theme.fg("accent", target)}${argSuffix}`,
    0,
    0,
  );
}

function getMcpTruncationDetails(details: unknown): {
  truncated: boolean;
  fullOutputPath?: string;
} {
  const detailRecord = toRecord(details);
  const truncation = toRecord(detailRecord.truncation);

  const fullOutputPath =
    typeof truncation.fullOutputPath === "string"
      ? truncation.fullOutputPath
      : typeof detailRecord.fullOutputPath === "string"
        ? detailRecord.fullOutputPath
        : undefined;

  return {
    truncated: truncation.truncated === true,
    fullOutputPath,
  };
}

function renderMcpResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "running..."), 0, 0);
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);
  const truncation = getMcpTruncationDetails(result.details);

  if (!options.expanded) {
    const lineCount = countNonEmptyLines(lines);
    let summary = theme.fg(
      "muted",
      `${lineCount} ${pluralize(lineCount, "line")} returned`,
    );
    summary += formatExpandHint(theme);
    if (config.showTruncationHints && truncation.truncated) {
      summary += theme.fg("warning", " • truncated");
    }
    summary += formatRtkSummarySuffix(result.details, config, theme);
    return new Text(summary, 0, 0);
  }

  let preview = buildPreviewText(lines, lines.length, theme, true);
  if (
    config.showTruncationHints &&
    (truncation.truncated || truncation.fullOutputPath)
  ) {
    const hints: string[] = [];
    if (truncation.truncated) {
      hints.push("truncated by backend limits");
    }
    if (truncation.fullOutputPath) {
      hints.push(`full output: ${truncation.fullOutputPath}`);
    }
    preview += `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
  }

  preview += formatRtkPreviewHint(result.details, config, theme);
  return new Text(preview, 0, 0);
}

export function registerToolDisplayOverrides(
  pi: ExtensionAPI,
  getConfig: ConfigGetter,
): void {
  patchToolContainerStyle();
  const writeExecutionMetaByToolCallId = new Map<string, WriteExecutionMeta>();
  let registeredBuiltIns = false;

  const registerBuiltInToolOverrides = async (): Promise<void> => {
    if (registeredBuiltIns) {
      return;
    }

    let bootstrapTools: BuiltInTools;
    try {
      bootstrapTools = await getBuiltInTools(process.cwd());
    } catch (error) {
      logToolDisplayDebug("Built-in tool override initialization failed.", error);
      return;
    }
    registeredBuiltIns = true;
  const builtInPromptMetadata = {
    read: extractPromptMetadata(bootstrapTools.read),
    grep: extractPromptMetadata(bootstrapTools.grep),
    find: extractPromptMetadata(bootstrapTools.find),
    ls: extractPromptMetadata(bootstrapTools.ls),
    bash: extractPromptMetadata(bootstrapTools.bash),
    edit: extractPromptMetadata(bootstrapTools.edit),
    write: extractPromptMetadata(bootstrapTools.write),
  };
  const clonedParameters = {
    read: cloneToolParameters(bootstrapTools.read.parameters),
    grep: cloneToolParameters(bootstrapTools.grep.parameters),
    find: cloneToolParameters(bootstrapTools.find.parameters),
    ls: cloneToolParameters(bootstrapTools.ls.parameters),
    bash: cloneToolParameters(bootstrapTools.bash.parameters),
    edit: cloneToolParameters(bootstrapTools.edit.parameters),
    write: cloneToolParameters(bootstrapTools.write.parameters),
  };
  const registerIfOwned = (
    toolName: BuiltInToolOverrideName,
    register: () => void,
  ): void => {
    if (getConfig().registerToolOverrides[toolName]) {
      register();
    }
  };

  registerIfOwned("read", () => {
    registerRuntimeTool(pi, {
      name: "read",
      label: "read",
      description: bootstrapTools.read.description,
      ...builtInPromptMetadata.read,
      parameters: clonedParameters.read,
      prepareArguments: getToolPrepareArguments(bootstrapTools.read),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return executeBuiltInTool(bootstrapTools.read, toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall(args, theme, context) {
        const path = shortenPath(getToolPathArg(args));
        const offset = getNumericField(args, "offset");
        const limit = getNumericField(args, "limit");
        let suffix = "";
        if (offset !== undefined || limit !== undefined) {
          const parts: string[] = [];
          if (offset !== undefined) parts.push(`offset=${offset}`);
          if (limit !== undefined) parts.push(`limit=${limit}`);
          suffix = ` ${theme.fg("muted", `(${parts.join(", ")})`)}`;
        }
        return styledText(context, toolHeader("Read", `${path || "..."}${suffix}`, theme, context));
      },
      renderResult(result, options, theme, context) {
        if (options.isPartial) {
          return styledText(context, "");
        }
        setToolResultStatus(context, context?.isError === true);
        const config = getConfig();
        const details = result.details as ReadToolDetails | undefined;
        const rawOutput = extractTextOutput(result);
        const lines = prepareOutputLines(rawOutput, options);

        if (!options.expanded) {
          const summaryLines = compactOutputLines(splitLines(rawOutput), {
            expanded: true,
          });
          let summary = formatReadSummary(
            summaryLines,
            details,
            theme,
            config.showTruncationHints,
          );
          summary += formatExpandHint(theme);
          summary += formatRtkSummarySuffix(result.details, config, theme);
          return renderCollapsedSummary(context, config, summary, theme);
        }

        let preview = buildPreviewText(lines, lines.length, theme, true);
        if (config.showTruncationHints && details?.truncation?.truncated) {
          preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
        }
        preview += formatRtkPreviewHint(result.details, config, theme);
        return branchText(context, preview);
      },
    });
  });

  registerIfOwned("grep", () => {
    registerRuntimeTool(pi, {
      name: "grep",
    label: "grep",
    description: bootstrapTools.grep.description,
    ...builtInPromptMetadata.grep,
    parameters: clonedParameters.grep,
    prepareArguments: getToolPrepareArguments(bootstrapTools.grep),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeBuiltInTool(bootstrapTools.grep, toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const scope = shortenPath(args.path || ".");
      const globSuffix = args.glob ? ` (${args.glob})` : "";
      const limitSuffix = args.limit !== undefined ? ` limit ${args.limit}` : "";
      return styledText(context, toolHeader("Grep", `"${args.pattern}" in ${scope}${globSuffix}${limitSuffix}`, theme, context));
    },
    renderResult(result, options, theme, context) {
      if (!options.isPartial) setToolResultStatus(context, context?.isError === true);
      const config = getConfig();
      const details = result.details as GrepToolDetails | undefined;
      return renderSearchResult(
        result,
        options,
        config,
        theme,
        "match",
        details,
        "matches",
        context,
      );
    },
    });
  });

  registerIfOwned("find", () => {
    registerRuntimeTool(pi, {
      name: "find",
    label: "find",
    description: bootstrapTools.find.description,
    ...builtInPromptMetadata.find,
    parameters: clonedParameters.find,
    prepareArguments: getToolPrepareArguments(bootstrapTools.find),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeBuiltInTool(bootstrapTools.find, toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const scope = shortenPath(args.path || ".");
      const limitSuffix = args.limit !== undefined ? ` (limit ${args.limit})` : "";
      return styledText(context, toolHeader("Find", `"${args.pattern}" in ${scope}${limitSuffix}`, theme, context));
    },
    renderResult(result, options, theme, context) {
      if (!options.isPartial) setToolResultStatus(context, context?.isError === true);
      const config = getConfig();
      const details = result.details as FindToolDetails | undefined;
      return renderSearchResult(
        result,
        options,
        config,
        theme,
        "result",
        details,
        undefined,
        context,
      );
    },
    });
  });

  registerIfOwned("ls", () => {
    registerRuntimeTool(pi, {
      name: "ls",
    label: "ls",
    description: bootstrapTools.ls.description,
    ...builtInPromptMetadata.ls,
    parameters: clonedParameters.ls,
    prepareArguments: getToolPrepareArguments(bootstrapTools.ls),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeBuiltInTool(bootstrapTools.ls, toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const scope = shortenPath(args.path || ".");
      const limitSuffix = args.limit !== undefined ? ` (limit ${args.limit})` : "";
      return styledText(context, toolHeader("List", `${scope}${limitSuffix}`, theme, context));
    },
    renderResult(result, options, theme, context) {
      if (!options.isPartial) setToolResultStatus(context, context?.isError === true);
      const config = getConfig();
      const details = result.details as LsToolDetails | undefined;
      return renderSearchResult(
        result,
        options,
        config,
        theme,
        "entry",
        details,
        "entries",
        context,
      );
    },
    });
  });

  registerIfOwned("edit", () => {
    registerRuntimeTool(pi, {
      name: "edit",
    label: "edit",
    description: bootstrapTools.edit.description,
    ...builtInPromptMetadata.edit,
    parameters: clonedParameters.edit,
    renderShell: "default",
    prepareArguments: getToolPrepareArguments(bootstrapTools.edit),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeBuiltInTool(bootstrapTools.edit, toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const path = shortenPath(getToolPathArg(args));
      const lineCount = getEditLineCount(args);
      syncToolStatus(context);
      const summaryText = toolHeader("Edit", `${path || "..."}${formatLineCountSuffix(lineCount, theme)}`, theme, context);
      if (!context.argsComplete || !context.isPartial) {
        return styledText(context, summaryText);
      }

      const previewKey = JSON.stringify({ path: getToolPathArg(args) ?? null, edits: toRecord(args).edits ?? null, oldText: getStringField(args, "oldText") ?? null, newText: getStringField(args, "newText") ?? null });
      const previewData = resolvePendingDiffPreview(
        context,
        EDIT_PENDING_PREVIEW_STATE_KEY,
        previewKey,
        () => buildPendingEditPreviewData(args, context.cwd),
      );
      return buildPendingDiffCallComponent(summaryText, previewData, context, getConfig(), theme);
    },
    renderResult(result, options, theme, context) {
      const lineCount = getEditLineCount(context?.args);
      if (options.isPartial) {
        return branchText(context, formatInProgressLineCount("Editing", lineCount, theme));
      }

      const fallbackText = extractTextOutput(result);
      if (isToolError(result, context)) {
        const error = fallbackText || "Edit failed.";
        setToolResultStatus(context, true);
        return branchText(context, theme.fg("error", error));
      }
      setToolResultStatus(context, false);

      const config = getConfig();
      const details = result.details as EditToolDetails | undefined;
      return renderEditDiffResult(
        details,
        { expanded: options.expanded, filePath: getToolPathArg(context?.args) },
        config,
        theme,
        fallbackText,
      );
    },
    });
  });

  registerIfOwned("write", () => {
    registerRuntimeTool(pi, {
      name: "write",
    label: "write",
    description: bootstrapTools.write.description,
    ...builtInPromptMetadata.write,
    parameters: clonedParameters.write,
    prepareArguments: getToolPrepareArguments(bootstrapTools.write),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const previous = captureExistingWriteContent(ctx.cwd, params.path);
      recordWriteExecutionMeta(writeExecutionMetaByToolCallId, toolCallId, {
        fileExistedBeforeWrite: previous.existed,
        previousContent: previous.content,
      });

      return executeBuiltInTool(bootstrapTools.write, toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const content = getToolContentArg(args);
      const lineCount = countWriteContentLines(content);
      const sizeBytes = getWriteContentSizeBytes(content);
      const path = shortenPath(getToolPathArg(args));
      const suffix = shouldRenderWriteCallSummary({
        hasContent: content !== undefined,
        hasDetailedResultHeader: false,
      })
        ? formatWriteCallSuffix(lineCount, sizeBytes, theme)
        : "";
      syncToolStatus(context);
      const summaryText = toolHeader("Write", `${path || "..."}${suffix}`, theme, context);
      if (!context.argsComplete || !context.isPartial) {
        return styledText(context, summaryText);
      }

      const previewKey = JSON.stringify({ path: getToolPathArg(args) ?? null, content: content ?? null });
      const previewData = resolvePendingDiffPreview(
        context,
        WRITE_PENDING_PREVIEW_STATE_KEY,
        previewKey,
        () => buildPendingWritePreviewData(args, context.cwd),
      );
      return buildPendingDiffCallComponent(summaryText, previewData, context, getConfig(), theme);
    },
    renderResult(result, options, theme, context) {
      const content = getToolContentArg(context?.args);
      const lineCount = countWriteContentLines(content);
      if (options.isPartial) {
        return branchText(context, formatInProgressLineCount("Writing", lineCount, theme));
      }

      const fallbackText = extractTextOutput(result);
      if (isToolError(result, context)) {
        const error = fallbackText || "Write failed.";
        setToolResultStatus(context, true);
        return branchText(context, theme.fg("error", error));
      }
      setToolResultStatus(context, false);

      const config = getConfig();
      const executionMeta = getWriteExecutionMeta(
        context,
        writeExecutionMetaByToolCallId,
      );
      return renderWriteDiffResult(
        content,
        {
          expanded: options.expanded,
          filePath: getToolPathArg(context?.args),
          previousContent: executionMeta?.previousContent,
          fileExistedBeforeWrite: executionMeta?.fileExistedBeforeWrite ?? false,
        },
        config,
        theme,
        fallbackText,
      );
    },
    });
  });

  registerIfOwned("bash", () => {
    registerRuntimeTool(pi, {
      name: "bash",
    label: "bash",
    description: bootstrapTools.bash.description,
    ...builtInPromptMetadata.bash,
    parameters: clonedParameters.bash,
    prepareArguments: getToolPrepareArguments(bootstrapTools.bash),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeBuiltInTool(bootstrapTools.bash, toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const command = getStringField(args, "command") ?? "";
      const flattened = command.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ").trim();
      if (context?.expanded) {
        const header = toolHeader("Bash", "", theme, context).replace(/\s+$/, "");
        const lines = command.split("\n");
        if (lines.length <= 1) {
          return styledText(context, `${header} ${flattened}`);
        }
        const TOOL_RULE = "\x1b[38;5;238m";
        const RESET = "\x1b[0m";
        const TRANSPARENT_BG = "\x1b[49m";
        const TR = `${RESET}${TRANSPARENT_BG}`;
        const pipe = `${TOOL_RULE}│${TR}`;
        const tee = `${TOOL_RULE}├─${TR}`;
        const branchLines = lines.map((l, i) =>
          i < lines.length - 1 ? `${pipe}  ${l}` : `${tee} ${l}`
        );
        return styledText(context, `${header}\n${branchLines.join("\n")}`);
      }
      return styledText(context, toolHeader("Bash", formatCollapsedBashCommand(command, theme), theme, context));
    },
    renderResult(result, options, theme, context) {
      const config = getConfig();
      const details = result.details as BashToolDetails | undefined;
      const rawOutput = extractTextOutput(result);

      if (options.isPartial) {
        return renderBashLivePreview(rawOutput, options, config, theme, details, context);
      }

      if (isToolError(result, context)) {
        setToolResultStatus(context, true);
        return renderBashErrorResult(rawOutput, options, config, theme, details, context);
      }

      const lines = prepareOutputLines(rawOutput, options);

      if (!options.expanded) {
        setToolResultStatus(context, false);
        let summary = lines.length === 0
          ? formatBashNoOutputLine(getStringField(context?.args, "command"), theme)
          : formatBashSummary(lines, details, theme, config.showTruncationHints);
        if (config.showTruncationHints) {
          summary += formatBashTruncationHints(details, theme).replace(/^\n/, " • ");
        }
        if (lines.length > 0) {
          summary += formatExpandHint(theme);
        }
        return renderCollapsedSummary(context, config, summary, theme);
      }

      if (lines.length === 0) {
        let text = formatBashNoOutputLine(getStringField(context?.args, "command"), theme);
        if (config.showTruncationHints) {
          text += formatBashTruncationHints(details, theme).replace(/^\n/, " • ");
        }
        setToolResultStatus(context, false);
        return branchText(context, text);
      }

      let text = buildPreviewText(lines, lines.length, theme, true);
      if (config.showTruncationHints) {
        text += formatBashTruncationHints(details, theme);
      }
      setToolResultStatus(context, false);
      return branchText(context, text);
    },
    });
  });

  };

  const wrappedMcpToolNames = new Set<string>();

  const registerMcpToolOverrides = (): void => {
    let allTools: unknown[] = [];
    try {
      allTools = pi.getAllTools();
    } catch (error) {
      logToolDisplayDebug("MCP tool override discovery failed.", error);
      return;
    }

    for (const candidate of allTools) {
      if (!isMcpToolCandidate(candidate)) {
        continue;
      }

      const toolName = getTextField(candidate, "name");
      if (!toolName || wrappedMcpToolNames.has(toolName)) {
        continue;
      }

      const toolRecord = toRecord(candidate);
      const executeCandidate = toolRecord.execute;
      if (typeof executeCandidate !== "function") {
        continue;
      }

      const executeDelegate = executeCandidate as (...args: unknown[]) => unknown;
      const prepareArgumentsDelegate =
        typeof toolRecord.prepareArguments === "function"
          ? (toolRecord.prepareArguments as (args: unknown) => unknown)
          : undefined;
      const toolLabel =
        getTextField(candidate, "label") ||
        (toolName === "mcp" ? "MCP Proxy" : `MCP ${toolName}`);
      const toolDescription =
        getTextField(candidate, "description") || "MCP tool";
      const parameters = toRecord(toolRecord.parameters);

      const promptMetadata =
        toolName === "mcp"
          ? {
              promptSnippet: MCP_PROXY_PROMPT_SNIPPET,
              promptGuidelines: [...MCP_PROXY_PROMPT_GUIDELINES],
            }
          : {
              promptSnippet: buildPromptSnippetFromDescription(
                toolDescription,
                `Call MCP tool '${toolName}'.`,
              ),
            };

      registerRuntimeTool(pi, {
        name: toolName,
        label: toolLabel,
        description: toolDescription,
        ...promptMetadata,
        parameters,
        prepareArguments: prepareArgumentsDelegate,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          return await Promise.resolve(
            executeDelegate(toolCallId, params, signal, onUpdate, ctx),
          );
        },
        renderCall(args, theme) {
          return formatMcpCallLine(toolName, toolLabel, toRecord(args), theme);
        },
        renderResult(result, options, theme) {
          return renderMcpResult(result, options, getConfig(), theme);
        },
      });

      wrappedMcpToolNames.add(toolName);
    }
  };

  pi.on("session_start", async () => {
    clearWriteExecutionMeta(writeExecutionMetaByToolCallId);
    await registerBuiltInToolOverrides();
    registerMcpToolOverrides();
  });
  pi.on("before_agent_start", async () => {
    clearWriteExecutionMeta(writeExecutionMetaByToolCallId);
    await registerBuiltInToolOverrides();
    registerMcpToolOverrides();
  });
}
