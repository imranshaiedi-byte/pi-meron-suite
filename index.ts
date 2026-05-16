/**
 * Collapse Tools + Padded Status Bar Extension
 *
 * Combined extension that:
 * 1. Shows tool calls with parameters but hides output by default (Ctrl+O to expand).
 *    Long bash commands are truncated when collapsed.
 * 2. Renders a custom padded status bar with 3-space left/right padding and a blank
 *    line at the bottom, showing pwd, git branch, model, context usage, and token stats.
 *
 * Based on:
 * - collapse-tools (https://github.com/xRyul/pi-collapse-tools)
 * - padded-status-bar
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

// ─── Collapse Tools settings ────────────────────────────────────────────────
const BASH_CMD_COLLAPSE = 120;

type BuiltInToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
const DEFAULT_TOOL_NAMES: BuiltInToolName[] = ["read", "bash", "write", "grep", "find", "ls"];

// ─── Padded Status Bar settings ─────────────────────────────────────────────
const LEFT_PAD = 3;
const RIGHT_PAD = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// Collapse Tools helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeRenderCall(toolName: string) {
	return (args: any, theme: any) => {
		const title = theme.fg("toolTitle", theme.bold(toolName));
		let params = "";

		switch (toolName) {
			case "bash": {
				const cmd = (args.command ?? "").split("\n")[0] ?? "";
				const truncated =
					cmd.length > BASH_CMD_COLLAPSE
						? cmd.slice(0, BASH_CMD_COLLAPSE) + "…"
						: cmd;
				params = theme.fg("muted", truncated);
				if (args.timeout)
					params += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
				break;
			}
			case "read":
				params = theme.fg("accent", args.path ?? "");
				if (args.offset) params += theme.fg("dim", ` offset=${args.offset}`);
				if (args.limit) params += theme.fg("dim", ` limit=${args.limit}`);
				break;
			case "write":
				params = theme.fg("accent", args.path ?? "");
				break;
			case "edit":
				params = theme.fg("accent", args.path ?? "");
				break;
			case "grep":
				params = theme.fg("accent", args.pattern ?? "");
				if (args.path) params += " " + theme.fg("muted", args.path);
				if (args.glob) params += " " + theme.fg("dim", args.glob);
				break;
			case "find":
				params = theme.fg("accent", args.pattern ?? "");
				if (args.path) params += " " + theme.fg("muted", args.path);
				break;
			case "ls":
				params = theme.fg("accent", args.path ?? ".");
				break;
			default:
				params = theme.fg("dim", JSON.stringify(args));
		}

		return new Text(`${title} ${params}`, 0, 0);
	};
}

function renderSimpleDiff(diffText: string, theme: any): string {
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

function makeRenderResult(toolName: string, originalRenderResult?: any) {
	return (result: any, options: any, theme: any, context: any) => {
		const { expanded, isPartial } = options;

		if (isPartial) {
			return new Text(theme.fg("dim", "Running..."), 0, 0);
		}

		if (!expanded) {
			return new Text("", 0, 0);
		}

		if (toolName === "edit") {
			const diff = result.details?.diff;
			if (typeof diff === "string" && diff.trim().length > 0) {
				return new Text("\n" + renderSimpleDiff(diff, theme), 0, 0);
			}
		}

		if (originalRenderResult) {
			return originalRenderResult(result, options, theme, context);
		}

		const content = result.content?.find((c: any) => c.type === "text");
		const text = content?.type === "text" ? content.text : "";
		return new Text(
			text ? "\n" + theme.fg("toolOutput", text) : "",
			0,
			0,
		);
	};
}

// ═══════════════════════════════════════════════════════════════════════════════
// Padded Status Bar helpers
// ═══════════════════════════════════════════════════════════════════════════════

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function padLine(line: string, width: number, innerWidth: number): string {
	const lineVis = visibleWidth(line);
	if (lineVis <= innerWidth) {
		return " ".repeat(LEFT_PAD) + line + " ".repeat(width - LEFT_PAD - lineVis);
	}
	return truncateToWidth(line, width, "...");
}

function twoColumnLine(
	left: string,
	right: string,
	width: number,
	innerWidth: number,
): string {
	const leftW = visibleWidth(left);
	const rightW = visibleWidth(right);
	if (leftW + rightW + 2 <= innerWidth) {
		const gap = " ".repeat(innerWidth - leftW - rightW);
		return padLine(left + gap + right, width, innerWidth);
	}
	// Truncate right to fit
	const availForRight = Math.max(0, innerWidth - leftW - 2);
	if (availForRight > 0) {
		const truncated = truncateToWidth(right, availForRight, "");
		const gap = " ".repeat(
			Math.max(0, innerWidth - leftW - visibleWidth(truncated)),
		);
		return padLine(left + gap + truncated, width, innerWidth);
	}
	return padLine(truncateToWidth(left, innerWidth, "..."), width, innerWidth);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// ── Register collapsed tool renderers ────────────────────────────────────

	const factories: Record<BuiltInToolName, () => any> = {
		read: () => createReadTool(cwd),
		bash: () => createBashTool(cwd),
		write: () => createWriteTool(cwd),
		edit: () => createEditTool(cwd),
		grep: () => createGrepTool(cwd),
		find: () => createFindTool(cwd),
		ls: () => createLsTool(cwd),
	};

	for (const name of DEFAULT_TOOL_NAMES) {
		const tool = factories[name]();
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

	// Edit uses renderShell: "self" for its own background handling
	const editTool = createEditTool(cwd);
	pi.registerTool({
		name: editTool.name,
		label: editTool.label,
		description: editTool.description,
		parameters: editTool.parameters,
		execute: editTool.execute,
		renderShell: "self",
		renderCall(args: any, theme: any) {
			const title = theme.fg("toolTitle", theme.bold("edit "));
			const path = theme.fg("accent", args.path ?? "");
			const box = new Box(1, 1, (s: string) => theme.bg("toolSuccessBg", s));
			box.addChild(new Text(`${title}${path}`, 0, 0));
			return box;
		},
		renderResult(result: any, options: any, theme: any) {
			const { expanded, isPartial } = options;
			if (isPartial) {
				const box = new Box(1, 1, (s: string) => theme.bg("toolPendingBg", s));
				box.addChild(new Text(theme.fg("dim", "Running..."), 0, 0));
				return box;
			}
			if (!expanded) {
				const box = new Box(1, 1, (s: string) => theme.bg("toolSuccessBg", s));
				return box;
			}
			const diff = result.details?.diff;
			if (typeof diff === "string" && diff.trim().length > 0) {
				const box = new Box(1, 1, (s: string) => theme.bg("toolSuccessBg", s));
				box.addChild(new Text("\n" + renderSimpleDiff(diff, theme), 0, 0));
				return box;
			}
			return new Box(1, 1, (s: string) => theme.bg("toolSuccessBg", s));
		},
	});

	// ── On session start: enable collapse + set padded footer ───────────────

	pi.on("session_start", async (_event, ctx) => {
		// Collapse tools
		if (ctx.hasUI) ctx.ui.setToolsExpanded(false);

		// Padded status bar footer
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const innerWidth = Math.max(0, width - LEFT_PAD - RIGHT_PAD);

					// ── Pwd line ──
					let pwd = ctx.sessionManager.getCwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// ── Context usage ──
					const contextUsage = ctx.getContextUsage();
					const contextWindow =
						contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent =
						contextUsage?.percent !== null
							? contextPercentValue.toFixed(1)
							: "?";

					// Context percentage with color
					const contextDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}`
							: `${contextPercent}%/${formatTokens(contextWindow)}`;
					let contextStr: string;
					if (contextPercentValue > 90) {
						contextStr = theme.fg("error", contextDisplay);
					} else if (contextPercentValue > 70) {
						contextStr = theme.fg("warning", contextDisplay);
					} else {
						contextStr = contextDisplay;
					}
					const statsLeft = contextStr;

					// ── Single row: left = pwd • branch, right = model • thinking • context ──
					let leftSide = pwd;
					if (branch) leftSide = `${leftSide} • ${branch}`;

					let rightParts: string[] = [];
					rightParts.push(ctx.model
						? `${ctx.model.provider}/${ctx.model.id}`
						: "no-model");
					rightParts.push(pi.getThinkingLevel());
					rightParts.push(statsLeft);
					const rightSide = rightParts.join(" • ");

					const lines: string[] = [];
					lines.push(
						twoColumnLine(
							theme.fg("dim", leftSide),
							theme.fg("dim", rightSide),
							width,
							innerWidth,
						),
					);

					// 1 line padding at the bottom
					lines.push("");

					return lines;
				},
			};
		});
	});
}
