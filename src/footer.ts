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

function calcTokenStats(ctx: any): { input: number; output: number; cacheRead: number; cacheWrite: number } {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			input += entry.message.usage?.input ?? 0;
			output += entry.message.usage?.output ?? 0;
			cacheRead += entry.message.usage?.cacheRead ?? 0;
			cacheWrite += entry.message.usage?.cacheWrite ?? 0;
		}
	}
	return { input, output, cacheRead, cacheWrite };
}

function renderCachePct(ctx: any, theme: Theme): string | null {
	const stats = calcTokenStats(ctx);
	const totalInput = stats.input + stats.cacheRead;
	if (totalInput === 0) return null;

	const hitRate = Math.round((stats.cacheRead / totalInput) * 100);
	return theme.fg("muted", "Cache:") + " " + theme.fg("accent", `${hitRate}%`);
}

function renderContextPct(ctx: any, theme: Theme): string | null {
	const stats = calcTokenStats(ctx);
	if (stats.input + stats.cacheRead === 0) return null;

	const usage = ctx.getContextUsage?.();
	const percent = typeof usage?.percent === "number" ? Math.round(usage.percent) : null;

	if (percent === null) {
		return theme.fg("muted", "Context:") + " " + theme.fg("dim", "?%");
	}

	const pctColor = percent > 90 ? "error" : percent > 70 ? "warning" : "accent";
	return theme.fg("muted", "Context:") + " " + theme.fg(pctColor, `${percent}%`);
}

function renderCost(ctx: any, theme: Theme): string | null {
	const stats = calcTokenStats(ctx);
	if (stats.input + stats.cacheRead === 0) return null;

	const cost = calcSessionCost(ctx);
	return theme.fg("text", `$${cost.toFixed(3)}`);
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

				// Build right side: model | thinking | Context: XX% | Cache: XX% | $cost
				const model = theme.fg("accent", modelLabel(ctx));
				const thinking = theme.fg("muted", pi.getThinkingLevel());
				const contextPct = renderContextPct(ctx, theme);
				const cachePct = renderCachePct(ctx, theme);
				const cost = renderCost(ctx, theme);
				const costSep = theme.fg("dim", " │ ");
				
				const stats = [contextPct, cachePct, cost].filter(Boolean);
				const statStr = stats.length > 0
					? pipe + stats.slice(0, -1).join(pipe) + costSep + stats[stats.length - 1]
					: "";
				
				const rightSide = `${model}${pipe}${thinking}${statStr}`;

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
