/**
 * Footer Extension
 *
 * Adds a clean padded footer/status bar for pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LEFT_PAD = 3;
const RIGHT_PAD = 3;
const ASCII_ELLIPSIS = "...";

type Theme = {
	fg: (name: string, value: string) => string;
};

type FooterData = {
	getGitBranch: () => string | null;
	onBranchChange: (listener: () => void) => () => void;
};

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

	const leftBudget = Math.max(1, innerWidth - rightWidth - 2);
	if (leftBudget > 8) {
		const truncatedLeft = truncateToWidth(left, leftBudget, ASCII_ELLIPSIS);
		const gap = " ".repeat(Math.max(2, innerWidth - visibleWidth(truncatedLeft) - rightWidth));
		return padLine(`${truncatedLeft}${gap}${right}`, width, innerWidth);
	}

	return padLine(truncateToWidth(left, innerWidth, ASCII_ELLIPSIS), width, innerWidth);
}

function responsiveFooterLines(left: string, right: string, width: number, innerWidth: number): string[] {
	if (innerWidth <= 0) return [""];

	if (visibleWidth(left) + visibleWidth(right) + 2 <= innerWidth) {
		return [twoColumnLine(left, right, width, innerWidth), ""];
	}

	// Narrow layout: use two rows instead of allowing the right side to disappear.
	return [
		padLine(left, width, innerWidth),
		padLine(right, width, innerWidth),
		"",
	];
}

function compactCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function calcSessionCost(ctx: any): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			total += entry.message.usage?.cost?.total ?? 0;
		}
	}
	return total;
}

function renderCost(ctx: any): string {
	const cost = calcSessionCost(ctx);
	return `$${cost.toFixed(3)}`;
}

function renderContextBar(ctx: any, theme: Theme): string {
	const usage = ctx.getContextUsage?.();
	const percent = typeof usage?.percent === "number" ? usage.percent : null;
	
	if (percent === null) {
		return theme.fg("muted", "Context:") + " " + theme.fg("dim", "[??????????]") + " " + theme.fg("dim", "?%");
	}
	
	const width = 10;
	const filled = Math.round((percent / 100) * width);
	const empty = width - filled;
	const barColor = percent > 90 ? "error" : percent > 70 ? "warning" : "accent";
	
	const bar = `[${theme.fg(barColor, "█".repeat(filled))}${theme.fg("dim", "░".repeat(empty))}]`;
	const label = theme.fg("muted", "Context:");
	const pct = `${Math.round(percent)}%`;
	
	return `${label} ${bar} ${pct}`;
}

function modelLabel(ctx: any): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
}

function setPaddedFooter(pi: ExtensionAPI, ctx: any): void {
	ctx.ui.setFooter((tui: any, theme: Theme, footerData: FooterData) => {
		const disposers = [footerData.onBranchChange(() => tui.requestRender())];
		return {
			dispose: () => {
				for (const dispose of disposers) dispose();
			},
			invalidate() {},
			render(width: number): string[] {
				const innerWidth = Math.max(0, width - LEFT_PAD - RIGHT_PAD);

				// Build left side: cwd | session | branch
				const pipe = theme.fg("dim", " | ");
				const cwd = theme.fg("text", compactCwd(ctx.sessionManager.getCwd()));
				
				let leftSide = cwd;
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) {
					leftSide += pipe + theme.fg("muted", sessionName);
				}

				const branch = footerData.getGitBranch();
				if (branch) {
					leftSide += pipe + theme.fg("accent", branch);
				}

				// Build right side: model | thinking | Context: [bar] XX% │ $cost
				const model = theme.fg("accent", modelLabel(ctx));
				const thinking = theme.fg("muted", pi.getThinkingLevel());
				const contextBar = renderContextBar(ctx, theme);
				const cost = theme.fg("text", renderCost(ctx));
				const costSep = theme.fg("dim", " │ ");
				
				const rightSide = `${model}${pipe}${thinking}${pipe}${contextBar}${costSep}${cost}`;

				return responsiveFooterLines(
					leftSide,
					rightSide,
					width,
					innerWidth,
				);
			},
		};
	});
}

export function registerFooter(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setPaddedFooter(pi, ctx);
	});
}
