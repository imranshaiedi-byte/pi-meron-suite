/**
 * Meron Footer Extension
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

export function registerMeronFooter(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setPaddedFooter(pi, ctx);
	});
}
