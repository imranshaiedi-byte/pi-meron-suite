import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BASH_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BASH_SPINNER_INTERVAL_MS = 80;
const BASH_COMMAND_COLLAPSED_WIDTH = 160;
const BASH_SPINNER_STATE_KEY = "__piToolDisplayBashSpinner";

interface BashCallArgs {
	command?: string;
	timeout?: number;
}

interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BashSpinnerState {
	frameIndex: number;
	startedAt?: number;
	timer?: ReturnType<typeof setInterval>;
}

interface BashSpinnerStateCarrier {
	[BASH_SPINNER_STATE_KEY]?: BashSpinnerState;
}

interface BashCallRenderContextLike {
	executionStarted: boolean;
	isPartial: boolean;
	expanded?: boolean;
	invalidate(): void;
	lastComponent?: unknown;
	state?: unknown;
}

function toStateCarrier(value: unknown): BashSpinnerStateCarrier | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return value as BashSpinnerStateCarrier;
}

function getOrCreateSpinnerState(value: unknown): BashSpinnerState | undefined {
	const carrier = toStateCarrier(value);
	if (!carrier) {
		return undefined;
	}

	const existing = carrier[BASH_SPINNER_STATE_KEY];
	if (existing) {
		return existing;
	}

	const created: BashSpinnerState = { frameIndex: 0 };
	carrier[BASH_SPINNER_STATE_KEY] = created;
	return created;
}

function stopSpinner(state: BashSpinnerState | undefined): void {
	if (!state?.timer) {
		if (state) {
			state.frameIndex = 0;
			state.startedAt = undefined;
		}
		return;
	}

	clearInterval(state.timer);
	state.timer = undefined;
	state.frameIndex = 0;
	state.startedAt = undefined;
}

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}

	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m ${seconds}s`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes}m`;
}

function formatCommandForCollapsedDisplay(command: string | undefined, expanded: boolean, theme: BashCallRenderTheme): string {
	const rawCommand = typeof command === "string" && command.trim().length > 0
		? command.trim()
		: "...";

	if (expanded || rawCommand === "...") {
		return theme.fg("accent", rawCommand);
	}

	const lines = rawCommand.split(/\r?\n/);
	const compactCommand = lines
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(" && ");
	const commandDisplay = visibleWidth(compactCommand) > BASH_COMMAND_COLLAPSED_WIDTH
		? truncateToWidth(compactCommand, BASH_COMMAND_COLLAPSED_WIDTH, "...")
		: compactCommand;

	const wasCollapsed = lines.length > 1 || visibleWidth(compactCommand) > BASH_COMMAND_COLLAPSED_WIDTH;
	if (!wasCollapsed) {
		return theme.fg("accent", commandDisplay);
	}

	const hints: string[] = [];
	if (lines.length > 1) hints.push(`${lines.length} lines`);
	if (rawCommand.length > BASH_COMMAND_COLLAPSED_WIDTH) hints.push(`${rawCommand.length} chars`);
	return `${theme.fg("accent", commandDisplay)}${theme.fg("muted", ` (${hints.join(" • ")} • Ctrl+O to expand)`)}`;
}

function buildBashCallText(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	expanded: boolean,
	spinnerFrame?: string,
	elapsedMs?: number,
): string {
	const commandDisplay = formatCommandForCollapsedDisplay(args.command, expanded, theme);
	const timeoutSuffix = args.timeout
		? theme.fg("muted", ` (timeout ${args.timeout}s)`)
		: "";
	const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
	const elapsedSuffix =
		spinnerFrame && elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";

	return `${spinnerPrefix}${theme.fg("toolTitle", theme.bold("$"))} ${commandDisplay}${timeoutSuffix}${elapsedSuffix}`;
}

export function renderBashCall(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const spinnerState = getOrCreateSpinnerState(context.state);
	const shouldSpin = context.executionStarted && context.isPartial;

	if (shouldSpin && spinnerState) {
		spinnerState.startedAt ??= Date.now();
		if (!spinnerState.timer) {
			spinnerState.timer = setInterval(() => {
				spinnerState.frameIndex = (spinnerState.frameIndex + 1) % BASH_SPINNER_FRAMES.length;
				text.setText(
					buildBashCallText(
						args,
						theme,
						context.expanded === true,
						BASH_SPINNER_FRAMES[spinnerState.frameIndex],
						Date.now() - (spinnerState.startedAt ?? Date.now()),
					),
				);
				context.invalidate();
			}, BASH_SPINNER_INTERVAL_MS);
		}
	}

	if (!shouldSpin) {
		stopSpinner(spinnerState);
	}

	const spinnerFrame = shouldSpin && spinnerState ? BASH_SPINNER_FRAMES[spinnerState.frameIndex] : undefined;
	const elapsedMs = shouldSpin && spinnerState?.startedAt !== undefined
		? Date.now() - spinnerState.startedAt
		: undefined;
	text.setText(buildBashCallText(args, theme, context.expanded === true, spinnerFrame, elapsedMs));
	return text;
}
