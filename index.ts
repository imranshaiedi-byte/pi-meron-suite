/**
 * Meron UI Extension
 *
 * Combines compact/collapsed built-in tool rendering with a padded single-row
 * footer that shows pwd, git branch, model, thinking level, and context usage.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BASH_CMD_COLLAPSE = 120;
const LEFT_PAD = 3;
const RIGHT_PAD = 3;
const ELLIPSIS = "…";
const ASCII_ELLIPSIS = "...";

const TOOL_NAMES = ["read", "bash", "write", "grep", "find", "ls"] as const;
type CompactToolName = (typeof TOOL_NAMES)[number];
type BuiltInToolName = CompactToolName | "edit";

type Theme = {
	fg: (name: string, value: string) => string;
	bg: (name: string, value: string) => string;
	bold: (value: string) => string;
};

type ToolDefinition = {
	name: BuiltInToolName | string;
	label?: string;
	description: string;
	parameters: unknown;
	execute: (...args: any[]) => unknown;
	renderResult?: (...args: any[]) => unknown;
};

type FooterData = {
	getGitBranch: () => string | null;
	onBranchChange: (listener: () => void) => () => void;
};

// ═══════════════════════════════════════════════════════════════════════════════
// Tool rendering
// ═══════════════════════════════════════════════════════════════════════════════

function firstLine(value: unknown): string {
	return String(value ?? "").split("\n", 1)[0] ?? "";
}

function truncateChars(value: string, maxChars: number): string {
	return value.length > maxChars
		? `${value.slice(0, Math.max(0, maxChars - 1))}${ELLIPSIS}`
		: value;
}

function renderToolParams(toolName: string, args: any, theme: Theme): string {
	switch (toolName) {
		case "bash": {
			let params = theme.fg("muted", truncateChars(firstLine(args.command), BASH_CMD_COLLAPSE));
			if (args.timeout) params += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			return params;
		}
		case "read": {
			let params = theme.fg("accent", args.path ?? "");
			if (args.offset) params += theme.fg("dim", ` offset=${args.offset}`);
			if (args.limit) params += theme.fg("dim", ` limit=${args.limit}`);
			return params;
		}
		case "write":
		case "edit":
			return theme.fg("accent", args.path ?? "");
		case "grep": {
			let params = theme.fg("accent", args.pattern ?? "");
			if (args.path) params += ` ${theme.fg("muted", args.path)}`;
			if (args.glob) params += ` ${theme.fg("dim", args.glob)}`;
			return params;
		}
		case "find": {
			let params = theme.fg("accent", args.pattern ?? "");
			if (args.path) params += ` ${theme.fg("muted", args.path)}`;
			return params;
		}
		case "ls":
			return theme.fg("accent", args.path ?? ".");
		default:
			return theme.fg("dim", JSON.stringify(args));
	}
}

function reusableText(component: unknown): Text {
	return component instanceof Text ? component : new Text("", 0, 0);
}

function makeRenderCall(toolName: string) {
	return (args: any, theme: Theme, context?: any) => {
		const text = reusableText(context?.lastComponent);
		text.setText(`${theme.fg("toolTitle", theme.bold(toolName))} ${renderToolParams(toolName, args, theme)}`);
		return text;
	};
}

function renderSimpleDiff(diffText: string, theme: Theme): string {
	return diffText
		.split("\n")
		.map((line) => {
			const clean = line.replace(/\t/g, "   ");
			if (clean.startsWith("+")) return theme.fg("toolDiffAdded", clean);
			if (clean.startsWith("-")) return theme.fg("toolDiffRemoved", clean);
			return theme.fg("toolDiffContext", clean);
		})
		.join("\n");
}

function firstTextContent(result: any): string {
	const content = result?.content?.find((item: any) => item.type === "text");
	return content?.type === "text" ? content.text : "";
}

function makeRenderResult(toolName: string, originalRenderResult?: ToolDefinition["renderResult"]) {
	return (result: any, options: any, theme: Theme, context: any) => {
		const text = reusableText(context?.lastComponent);

		if (options.isPartial) {
			text.setText(theme.fg("dim", "Running..."));
			return text;
		}

		if (!options.expanded) {
			text.setText("");
			return text;
		}

		if (toolName === "edit") {
			const diff = result?.details?.diff;
			if (typeof diff === "string" && diff.trim()) {
				text.setText(`\n${renderSimpleDiff(diff, theme)}`);
				return text;
			}
		}

		if (originalRenderResult) {
			return originalRenderResult(result, options, theme, context);
		}

		const output = firstTextContent(result);
		text.setText(output ? `\n${theme.fg("toolOutput", output)}` : "");
		return text;
	};
}

function successBox(theme: Theme): Box {
	return new Box(1, 1, (value: string) => theme.bg("toolSuccessBg", value));
}

function registerCompactTool(pi: ExtensionAPI, tool: ToolDefinition): void {
	pi.registerTool({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: tool.execute,
		renderCall: makeRenderCall(tool.name),
		renderResult: makeRenderResult(tool.name, tool.renderResult),
	});
}

function registerEditTool(pi: ExtensionAPI, tool: ToolDefinition): void {
	pi.registerTool({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: tool.execute,
		renderShell: "self",
		renderCall(args: any, theme: Theme) {
			const box = successBox(theme);
			box.addChild(new Text(`${theme.fg("toolTitle", theme.bold("edit "))}${theme.fg("accent", args.path ?? "")}`, 0, 0));
			return box;
		},
		renderResult(result: any, options: any, theme: Theme) {
			if (options.isPartial) {
				const box = new Box(1, 1, (value: string) => theme.bg("toolPendingBg", value));
				box.addChild(new Text(theme.fg("dim", "Running..."), 0, 0));
				return box;
			}

			const box = successBox(theme);
			if (!options.expanded) return box;

			const diff = result?.details?.diff;
			if (typeof diff === "string" && diff.trim()) {
				box.addChild(new Text(`\n${renderSimpleDiff(diff, theme)}`, 0, 0));
			}
			return box;
		},
	});
}

// ═══════════════════════════════════════════════════════════════════════════════
// Footer rendering
// ═══════════════════════════════════════════════════════════════════════════════

function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "?";
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function padLine(line: string, width: number, innerWidth: number): string {
	if (width <= 0) return "";

	const lineWidth = visibleWidth(line);
	if (lineWidth <= innerWidth) {
		return `${" ".repeat(LEFT_PAD)}${line}${" ".repeat(Math.max(0, width - LEFT_PAD - lineWidth))}`;
	}

	return truncateToWidth(line, width, ASCII_ELLIPSIS);
}

function twoColumnLine(left: string, right: string, width: number, innerWidth: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);

	if (leftWidth + rightWidth + 2 <= innerWidth) {
		return padLine(`${left}${" ".repeat(innerWidth - leftWidth - rightWidth)}${right}`, width, innerWidth);
	}

	const rightWidthAvailable = Math.max(0, innerWidth - leftWidth - 2);
	if (rightWidthAvailable > 0) {
		const truncatedRight = truncateToWidth(right, rightWidthAvailable, "");
		const gap = " ".repeat(Math.max(0, innerWidth - leftWidth - visibleWidth(truncatedRight)));
		return padLine(`${left}${gap}${truncatedRight}`, width, innerWidth);
	}

	return padLine(truncateToWidth(left, innerWidth, ASCII_ELLIPSIS), width, innerWidth);
}

function compactCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function renderContextUsage(ctx: any, theme: Theme): string {
	const usage = ctx.getContextUsage?.();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = typeof usage?.percent === "number" ? usage.percent : null;
	const display = percent === null
		? `?/${formatTokens(contextWindow)}`
		: `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;

	if (percent !== null && percent > 90) return theme.fg("error", display);
	if (percent !== null && percent > 70) return theme.fg("warning", display);
	return display;
}

function modelLabel(ctx: any): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
}

function setPaddedFooter(pi: ExtensionAPI, ctx: any): void {
	ctx.ui.setFooter((tui: any, theme: Theme, footerData: FooterData) => ({
		dispose: footerData.onBranchChange(() => tui.requestRender()),
		invalidate() {},
		render(width: number): string[] {
			const innerWidth = Math.max(0, width - LEFT_PAD - RIGHT_PAD);

			let leftSide = compactCwd(ctx.sessionManager.getCwd());
			const sessionName = ctx.sessionManager.getSessionName();
			if (sessionName) leftSide += ` • ${sessionName}`;

			const branch = footerData.getGitBranch();
			if (branch) leftSide += ` • ${branch}`;

			const rightSide = [modelLabel(ctx), pi.getThinkingLevel(), renderContextUsage(ctx, theme)].join(" • ");

			return [
				twoColumnLine(theme.fg("text", leftSide), theme.fg("text", rightSide), width, innerWidth),
				"",
			];
		},
	}));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════════

export default function meronUi(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const tools: Record<BuiltInToolName, ToolDefinition> = {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		write: createWriteTool(cwd),
		edit: createEditTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};

	for (const name of TOOL_NAMES) registerCompactTool(pi, tools[name]);
	registerEditTool(pi, tools.edit);

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setToolsExpanded(false);
		setPaddedFooter(pi, ctx);
	});
}
