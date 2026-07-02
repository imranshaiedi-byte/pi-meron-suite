import {
	type ExtensionAPI,
	type Theme,
	ToolExecutionComponent,
	VERSION,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	renderDiff,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

/**
 * Codex-style TUI skin.
 *
 * pi does not expose a renderer-only hook for built-in tools, so this module patches
 * ToolExecutionComponent's renderer lookup at runtime. This leaves tool execution untouched
 * while replacing the visual shell with Codex-like transcript rows:
 *
 *   • Running npm test
 *   │ --watch=false
 *   └ output preview
 */

type ToolRenderer = {
	renderCall?: (args: any, theme: Theme, context: any) => Component;
	renderResult?: (result: any, options: any, theme: Theme, context: any) => Component;
};

type CodexPatchState = {
	installed: boolean;
	enabled: boolean;
	renderers: Record<string, ToolRenderer>;
	originalGetCallRenderer?: (this: any) => any;
	originalGetResultRenderer?: (this: any) => any;
	originalGetRenderShell?: (this: any) => any;
};

const PATCH_KEY = Symbol.for("pi-meron-suite.codex-tool-rendering");
const EMPTY_COMPONENT: Component = { render: () => [], invalidate() {} };
const TOOL_OUTPUT_MAX_LINES = 5;
const DIFF_OUTPUT_MAX_LINES = 10;

function getPatchState(): CodexPatchState {
	const globalWithPatch = globalThis as typeof globalThis & { [PATCH_KEY]?: CodexPatchState };
	globalWithPatch[PATCH_KEY] ??= {
		installed: false,
		enabled: false,
		renderers: {},
	};
	return globalWithPatch[PATCH_KEY]!;
}

class CodexLines implements Component {
	constructor(private readonly build: (width: number) => string[]) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		return this.build(width).map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}
}

class CodexHeader implements Component {
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: any,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		if (width < 8) return [];
		const inner = Math.max(1, width - 4);
		const cwd = compactPath(this.ctx.sessionManager.getCwd?.() ?? this.ctx.cwd);
		const model = this.ctx.model ? `${this.ctx.model.provider}/${this.ctx.model.id}` : "no model";
		const thinking = this.pi.getThinkingLevel?.() ?? "off";
		const rows = [
			`${this.theme.fg("accent", ">_")} ${this.theme.bold("OpenAI Codex style for pi")} ${this.theme.fg("dim", `v${VERSION}`)}`,
			"",
			`${this.theme.fg("muted", "model:")}     ${model} ${this.theme.fg("dim", thinking)}   ${this.theme.fg("dim", "/model to change")}`,
			`${this.theme.fg("muted", "directory:")} ${cwd}`,
		];

		const top = this.theme.fg("borderMuted", `┌${"─".repeat(inner + 2)}┐`);
		const bottom = this.theme.fg("borderMuted", `└${"─".repeat(inner + 2)}┘`);
		const body = rows.map((row) => {
			const clipped = truncateToWidth(row, inner, "...");
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
			return `${this.theme.fg("borderMuted", "│ ")}${clipped}${pad}${this.theme.fg("borderMuted", " │")}`;
		});
		return ["", top, ...body, bottom, ""];
	}

	invalidate(): void {}
}

function installCodexToolRenderingPatch(): CodexPatchState {
	const state = getPatchState();
	state.renderers = CODEX_TOOL_RENDERERS;
	state.enabled = true;

	if (state.installed) return state;

	const proto = ToolExecutionComponent.prototype as any;
	if (
		typeof proto.getCallRenderer !== "function" ||
		typeof proto.getResultRenderer !== "function" ||
		typeof proto.getRenderShell !== "function"
	) {
		return state;
	}

	state.originalGetCallRenderer = proto.getCallRenderer;
	state.originalGetResultRenderer = proto.getResultRenderer;
	state.originalGetRenderShell = proto.getRenderShell;

	proto.getCallRenderer = function patchedGetCallRenderer(this: any) {
		const current = getPatchState();
		if (!current.enabled) return current.originalGetCallRenderer?.call(this);

		const codexRenderer = current.renderers[this.toolName]?.renderCall;
		if (codexRenderer) return codexRenderer;

		const original = current.originalGetCallRenderer?.call(this);
		if (original) return original;

		const toolName = this.toolName;
		return (args: any, theme: Theme, context: any) => renderGenericToolCall(toolName, args, theme, context);
	};

	proto.getResultRenderer = function patchedGetResultRenderer(this: any) {
		const current = getPatchState();
		if (!current.enabled) return current.originalGetResultRenderer?.call(this);

		const codexRenderer = current.renderers[this.toolName]?.renderResult;
		if (codexRenderer) return codexRenderer;

		const original = current.originalGetResultRenderer?.call(this);
		if (original) return original;

		return (result: any, options: any, theme: Theme, context: any) =>
			renderGenericToolResult(result, options, theme, context);
	};

	proto.getRenderShell = function patchedGetRenderShell(this: any) {
		const current = getPatchState();
		if (!current.enabled) return current.originalGetRenderShell?.call(this) ?? "default";

		if (current.renderers[this.toolName]) return "self";

		const originalCall = current.originalGetCallRenderer?.call(this);
		const originalResult = current.originalGetResultRenderer?.call(this);
		if (!originalCall && !originalResult) return "self";

		return current.originalGetRenderShell?.call(this) ?? "default";
	};

	state.installed = true;
	return state;
}

function setupCodexChrome(pi: ExtensionAPI, ctx: any): void {
	if (ctx.mode !== "tui") return;

	ctx.ui.setHeader((_tui: any, theme: Theme) => new CodexHeader(pi, ctx, theme));
	ctx.ui.setWorkingIndicator({ frames: ["•", "∙", "·", "∙"], intervalMs: 160 });
	ctx.ui.setHiddenThinkingLabel?.("thinking");

	ctx.ui.setFooter((tui: any, theme: Theme, footerData: any) => {
		const dispose = footerData.onBranchChange?.(() => tui.requestRender()) ?? (() => {});
		return {
			dispose,
			invalidate() {},
			render(width: number): string[] {
				const branch = footerData.getGitBranch?.();
				const model = ctx.model ? `${ctx.model.id}` : "no-model";
				const thinking = pi.getThinkingLevel?.() ?? "off";
				const context = renderContextPct(ctx);
				const cache = renderCachePct(ctx);
				const cost = renderCost(ctx);

				const left = theme.fg("dim", "? for shortcuts");
				const right = [
					model,
					thinking,
					branch ? ` ${branch}` : undefined,
					context,
					cache,
					cost,
				]
					.filter(Boolean)
					.join(theme.fg("dim", " · "));

				const rightStyled = theme.fg("dim", right);
				const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(rightStyled) - 2));
				return [truncateToWidth(` ${left}${gap}${rightStyled} `, width, "")];
			},
		};
	});
}

function kindForContext(context: any): "pending" | "success" | "error" {
	if (context.isPartial) return "pending";
	return context.isError ? "error" : "success";
}

function bullet(theme: Theme, kind: "pending" | "success" | "error"): string {
	if (kind === "success") return theme.fg("success", theme.bold("•"));
	if (kind === "error") return theme.fg("error", theme.bold("•"));
	return theme.fg("dim", "•");
}

function statusLabel(theme: Theme, label: string): string {
	return theme.bold(label);
}

function headerComponent(
	label: string,
	detailLines: string[],
	theme: Theme,
	context: any,
	options: { maxContinuationLines?: number } = {},
): Component {
	const kind = kindForContext(context);
	const maxContinuationLines = context.expanded ? undefined : options.maxContinuationLines;
	return new CodexLines((width) => {
		const firstPrefix = `${bullet(theme, kind)} ${statusLabel(theme, label)} `;
		const continuationPrefix = theme.fg("dim", "  │ ");
		const rawLines = detailLines.length > 0 ? detailLines : [theme.fg("toolOutput", "...")];
		const lines: string[] = [];

		for (let i = 0; i < rawLines.length; i++) {
			const prefix = i === 0 ? firstPrefix : continuationPrefix;
			lines.push(...wrapPrefixed(rawLines[i] ?? "", width, prefix, continuationPrefix));
		}

		if (maxContinuationLines !== undefined && lines.length > 1 + maxContinuationLines) {
			const omitted = lines.length - (1 + maxContinuationLines);
			return [
				...lines.slice(0, 1 + maxContinuationLines),
				`${continuationPrefix}${theme.fg("dim", `… +${omitted} lines`)}`,
			];
		}

		return lines;
	});
}

function wrapPrefixed(text: string, width: number, initialPrefix: string, subsequentPrefix: string): string[] {
	const wrapWidth = Math.max(1, width - visibleWidth(initialPrefix));
	const wrapped = wrapTextWithAnsi(text, wrapWidth);
	const segments = wrapped.length > 0 ? wrapped : [""];
	return segments.map((segment, index) => `${index === 0 ? initialPrefix : subsequentPrefix}${segment}`);
}

function outputComponent(
	result: any,
	options: any,
	theme: Theme,
	context: any,
	config: {
		showWhenCollapsed?: boolean;
		showNoOutput?: boolean;
		language?: string;
		maxLines?: number;
	} = {},
): Component {
	if (!options.expanded && !context.isError && config.showWhenCollapsed === false) {
		return EMPTY_COMPONENT;
	}

	return new CodexLines((width) => {
		const text = textFromResult(result).trimEnd();
		const showNoOutput = config.showNoOutput ?? false;
		if (!text && !showNoOutput) return [];

		let lines = text
			? highlightedOutputLines(text, config.language, options.expanded, theme)
			: [theme.fg("dim", "(no output)")];

		if (!options.expanded) {
			lines = limitMiddle(lines, config.maxLines ?? TOOL_OUTPUT_MAX_LINES, theme);
		}

		return prefixOutputLines(lines, width, theme);
	});
}

function diffComponent(args: any, result: any, options: any, theme: Theme, context: any): Component {
	if (context.isError) {
		return outputComponent(result, { ...options, expanded: true }, theme, context, { showNoOutput: true });
	}

	return new CodexLines((width) => {
		const details = result?.details ?? {};
		const diffText = typeof details.diff === "string" ? details.diff : typeof details.patch === "string" ? details.patch : "";
		if (!diffText) return [];

		const path = compactPath(stringArg(args?.path) ?? stringArg(args?.file_path) ?? "file");
		const counts = countDiffLines(diffText);
		const summary = `${theme.fg("dim", "  └ ")}${theme.fg("accent", path)} ${formatDiffCounts(counts, theme)}`;
		let diffLines = renderDiff(diffText).split("\n").filter((line) => line.length > 0);
		if (!options.expanded) {
			diffLines = limitMiddle(diffLines, DIFF_OUTPUT_MAX_LINES, theme);
		}
		return [summary, ...prefixDiffLines(diffLines, width, theme)];
	});
}

function prefixOutputLines(lines: string[], width: number, theme: Theme): string[] {
	const firstPrefix = theme.fg("dim", "  └ ");
	const nextPrefix = theme.fg("dim", "    ");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		out.push(...wrapPrefixed(lines[i] ?? "", width, i === 0 ? firstPrefix : nextPrefix, nextPrefix));
	}
	return out;
}

function prefixDiffLines(lines: string[], width: number, theme: Theme): string[] {
	const prefix = theme.fg("dim", "    ");
	const out: string[] = [];
	for (const line of lines) {
		out.push(...wrapPrefixed(line, width, prefix, prefix));
	}
	return out;
}

function highlightedOutputLines(text: string, language: string | undefined, expanded: boolean, theme: Theme): string[] {
	if (language && expanded) {
		return highlightCode(text, language);
	}
	return text.split("\n").map((line) => theme.fg("dim", line));
}

function limitMiddle(lines: string[], maxLines: number, theme: Theme): string[] {
	if (lines.length <= maxLines) return lines;
	if (maxLines <= 1) {
		return [theme.fg("dim", `… +${lines.length} lines (${keyHint("app.tools.expand", "to expand")})`)];
	}
	const head = Math.ceil((maxLines - 1) / 2);
	const tail = maxLines - 1 - head;
	const omitted = lines.length - head - tail;
	return [
		...lines.slice(0, head),
		theme.fg("dim", `… +${omitted} lines (${keyHint("app.tools.expand", "to expand")})`),
		...lines.slice(lines.length - tail),
	];
}

function textFromResult(result: any): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	return content
		.filter((item: any) => item?.type === "text")
		.map((item: any) => String(item.text ?? ""))
		.join("\n")
		.replace(/\r/g, "");
}

function stringArg(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function compactPath(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return path;
	const normalizedPath = path.replace(/\\/g, "/");
	const normalizedHome = home.replace(/\\/g, "/");
	return normalizedPath.startsWith(normalizedHome) ? `~${normalizedPath.slice(normalizedHome.length)}` : path;
}

function lineCount(text: string | undefined): number {
	if (!text) return 0;
	return text.replace(/\n$/, "").split(/\r\n|\r|\n/).length;
}

function countDiffLines(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function formatDiffCounts(counts: { added: number; removed: number }, theme: Theme): string {
	return `(${theme.fg("success", `+${counts.added}`)} ${theme.fg("error", `-${counts.removed}`)})`;
}

function rangeSuffix(args: any, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const start = Number.isFinite(args?.offset) ? args.offset : 1;
	const end = Number.isFinite(args?.limit) ? start + args.limit - 1 : undefined;
	return theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
}

function renderContextPct(ctx: any): string | undefined {
	const usage = ctx.getContextUsage?.();
	if (typeof usage?.percent !== "number") return undefined;
	return `Context ${Math.round(usage.percent)}%`;
}

function calcTokenStats(ctx: any): { input: number; cacheRead: number; cacheWrite: number; output: number } {
	let input = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let output = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			input += entry.message.usage?.input ?? 0;
			cacheRead += entry.message.usage?.cacheRead ?? 0;
			cacheWrite += entry.message.usage?.cacheWrite ?? 0;
			output += entry.message.usage?.output ?? 0;
		}
	}
	return { input, cacheRead, cacheWrite, output };
}

function renderCachePct(ctx: any): string | undefined {
	const stats = calcTokenStats(ctx);
	const totalInput = stats.input + stats.cacheRead;
	if (totalInput <= 0) return undefined;
	return `Cache ${Math.round((stats.cacheRead / totalInput) * 100)}%`;
}

function renderCost(ctx: any): string | undefined {
	let cost = 0;
	let hasUsage = false;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const value = entry.message.usage?.cost?.total;
			if (typeof value === "number") {
				cost += value;
				hasUsage = true;
			}
		}
	}
	return hasUsage ? `$${cost.toFixed(3)}` : undefined;
}

function renderGenericToolCall(toolName: string, args: any, theme: Theme, context: any): Component {
	const label = context.isPartial ? "Tool" : context.isError ? "Tool failed" : "Tool";
	let detail = theme.fg("accent", toolName);
	if (args && Object.keys(args).length > 0) {
		const encoded = JSON.stringify(args);
		detail += theme.fg("dim", ` ${encoded}`);
	}
	return headerComponent(label, [detail], theme, context, { maxContinuationLines: 2 });
}

function renderGenericToolResult(result: any, options: any, theme: Theme, context: any): Component {
	return outputComponent(result, options, theme, context, { showWhenCollapsed: true, showNoOutput: false });
}

const CODEX_TOOL_RENDERERS: Record<string, ToolRenderer> = {
	bash: {
		renderCall(args, theme, context) {
			const command = stringArg(args?.command) ?? "";
			const timeout = args?.timeout ? theme.fg("dim", ` (timeout ${args.timeout}s)`) : "";
			const label = context.isPartial ? "Running" : context.isError ? "Failed" : "Ran";
			const highlighted = highlightCode(command || "...", "bash");
			if (timeout && highlighted.length > 0) highlighted[0] += timeout;
			return headerComponent(label, highlighted, theme, context, { maxContinuationLines: 2 });
		},
		renderResult(result, options, theme, context) {
			return outputComponent(result, options, theme, context, { showWhenCollapsed: true, showNoOutput: !options.isPartial });
		},
	},

	read: {
		renderCall(args, theme, context) {
			const rawPath = stringArg(args?.path) ?? stringArg(args?.file_path);
			const path = rawPath ? compactPath(rawPath) : "...";
			const label = context.isPartial ? "Reading" : context.isError ? "Read failed" : "Read";
			return headerComponent(label, [`${theme.fg("accent", path)}${rangeSuffix(args, theme)}`], theme, context);
		},
		renderResult(result, options, theme, context) {
			const rawPath = stringArg(context.args?.path) ?? stringArg(context.args?.file_path);
			const language = rawPath ? getLanguageFromPath(rawPath) : undefined;
			return outputComponent(result, options, theme, context, {
				showWhenCollapsed: context.isError,
				showNoOutput: false,
				language,
				maxLines: TOOL_OUTPUT_MAX_LINES,
			});
		},
	},

	grep: {
		renderCall(args, theme, context) {
			const pattern = stringArg(args?.pattern) ?? "...";
			const path = stringArg(args?.path);
			const glob = stringArg(args?.glob);
			let detail = theme.fg("accent", pattern);
			if (path) detail += `${theme.fg("dim", " in ")}${theme.fg("accent", compactPath(path))}`;
			if (glob) detail += theme.fg("dim", ` (${glob})`);
			const label = context.isPartial ? "Searching" : context.isError ? "Search failed" : "Search";
			return headerComponent(label, [detail], theme, context);
		},
		renderResult(result, options, theme, context) {
			return outputComponent(result, options, theme, context, { showWhenCollapsed: true, showNoOutput: false });
		},
	},

	find: {
		renderCall(args, theme, context) {
			const pattern = stringArg(args?.pattern) ?? "...";
			const path = stringArg(args?.path);
			let detail = theme.fg("accent", pattern);
			if (path) detail += `${theme.fg("dim", " in ")}${theme.fg("accent", compactPath(path))}`;
			const label = context.isPartial ? "Searching" : context.isError ? "Search failed" : "Search";
			return headerComponent(label, [detail], theme, context);
		},
		renderResult(result, options, theme, context) {
			return outputComponent(result, options, theme, context, { showWhenCollapsed: true, showNoOutput: false });
		},
	},

	ls: {
		renderCall(args, theme, context) {
			const path = compactPath(stringArg(args?.path) ?? ".");
			const label = context.isPartial ? "Listing" : context.isError ? "List failed" : "List";
			return headerComponent(label, [theme.fg("accent", path)], theme, context);
		},
		renderResult(result, options, theme, context) {
			return outputComponent(result, options, theme, context, { showWhenCollapsed: true, showNoOutput: false });
		},
	},

	write: {
		renderCall(args, theme, context) {
			const path = compactPath(stringArg(args?.path) ?? stringArg(args?.file_path) ?? "file");
			const lines = lineCount(stringArg(args?.content));
			const label = context.isPartial ? "Writing" : context.isError ? "Write failed" : "Wrote";
			const detail = `${theme.fg("accent", path)} ${formatDiffCounts({ added: lines, removed: 0 }, theme)}`;
			return headerComponent(label, [detail], theme, context);
		},
		renderResult(result, options, theme, context) {
			if (!context.isError) return EMPTY_COMPONENT;
			return outputComponent(result, options, theme, context, { showWhenCollapsed: true, showNoOutput: true });
		},
	},

	edit: {
		renderCall(args, theme, context) {
			const path = compactPath(stringArg(args?.path) ?? stringArg(args?.file_path) ?? "file");
			const editCount = Array.isArray(args?.edits) ? args.edits.length : undefined;
			const suffix = editCount && editCount > 1 ? theme.fg("dim", ` (${editCount} edits)`) : "";
			const label = context.isPartial ? "Editing" : context.isError ? "Edit failed" : "Edited";
			return headerComponent(label, [`${theme.fg("accent", path)}${suffix}`], theme, context);
		},
		renderResult(result, options, theme, context) {
			return diffComponent(context.args, result, options, theme, context);
		},
	},
};

export function registerCodexUi(pi: ExtensionAPI): void {
	const patchState = installCodexToolRenderingPatch();

	pi.on("session_start", async (_event, ctx) => {
		patchState.enabled = true;
		setupCodexChrome(pi, ctx);
	});

	pi.on("session_shutdown", async () => {
		patchState.enabled = false;
	});
}
