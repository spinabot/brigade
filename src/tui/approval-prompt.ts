/**
 * ApprovalPrompt — inline TUI card the user picks Y / A / P / N from when
 * a gated tool call (today: `bash`) needs operator consent.
 *
 * Rendered as a single Component inside the connect-mode TUI; takes focus
 * when displayed, swaps focus back to the editor when resolved. Two
 * states:
 *
 *   1. `"menu"`    — four-letter shortcut row (Y/A/P/N) for the four
 *                    operator decisions.
 *   2. `"pattern"` — operator picked "P" (Allow pattern); we collect a
 *                    regex string with Pi-TUI's `Input` then resolve.
 *
 * Visual style mirrors the user's mock:
 *
 *   ┌─ Brigade wants to run ────────────────────────────────┐
 *   │  node -e "console.log(0.06 * 100000000)"              │
 *   │                                                       │
 *   │  [Y] Allow once   [A] Allow always                    │
 *   │  [P] Allow pattern…   [N] Deny                        │
 *   └───────────────────────────────────────────────────────┘
 *
 * Brigade brand: amber accent on the action letters; dim on the labels.
 *
 * Why a custom Component and not a `SelectList`: the operator picks via a
 * single letter, not arrow keys. SelectList works fine but requires
 * Up/Down + Enter; single-key dispatch is the muscle-memory pattern other
 * AI CLIs use (Claude Code, Cursor agent mode). One keystroke decides.
 */

import {
	type Component,
	decodeKittyPrintable,
	Input,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@mariozechner/pi-tui";

import { brand } from "../ui/theme.js";

export type ApprovalDecisionKind =
	| "allow-once"
	| "allow-always"
	| "allow-pattern"
	| "allow-session"
	| "deny";

export interface ApprovalRenderRequest {
	id: string;
	command: string;
	toolName: string;
	cwd?: string;
	/** Sub-agent attribution (Primitive #6). When `subagentDepth > 0` the title
	 *  switches to "Sub-agent wants to run" (with the optional label when set). */
	subagentLabel?: string;
	subagentDepth?: number;
	/** Parent run id (Primitive #6). Carried for audit/correlation; not rendered
	 *  in the title today, but available to logging or extension consumers. */
	parentRunId?: string;
}

export interface ApprovalResolution {
	decision: ApprovalDecisionKind;
	pattern?: string;
}

export interface ApprovalPromptOptions {
	tui: TUI;
	request: ApprovalRenderRequest;
	onResolve: (resolution: ApprovalResolution) => void;
	/** Called when the operator cancels via Esc (treated as deny). */
	onCancel?: () => void;
}

const DEFAULT_TITLE = " Brigade wants to run ";

/**
 * Sanitise a sub-agent label for safe embedding in the title string. A label
 * containing a literal `"` (e.g. `bad"label`) would otherwise unbalance the
 * surrounding quotes and corrupt the rendered box border. We strip the danger:
 * collapse runs of whitespace, drop control chars + raw quotes, truncate to
 * a sensible width. The model isn't supposed to send unsafe labels, but the
 * approval prompt is operator-facing and we don't trust input we render.
 */
function sanitizeSubagentLabel(raw: string): string {
	const stripped = raw
		.replace(/["\r\n\t]/g, " ")
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (stripped.length <= 48) return stripped;
	return `${stripped.slice(0, 45)}…`;
}

/**
 * Derive the prompt title from the request. Top-level (operator-driven) calls
 * show the default "Brigade wants to run …". Sub-agent calls (Primitive #6)
 * surface attribution so the operator knows whose action they are approving:
 * `Sub-agent "audit auth flow" wants to run …` when a label is supplied,
 * `Sub-agent (depth 1) wants to run …` when only depth is known.
 *
 * Defensive against non-number `subagentDepth` (e.g. a string serialised
 * across the wire) — only `typeof === "number" && > 0` flips into sub-agent
 * mode; everything else falls back to the default attribution.
 */
function deriveTitle(request: ApprovalRenderRequest): string {
	const isSubagent = typeof request.subagentDepth === "number" && request.subagentDepth > 0;
	if (!isSubagent) return DEFAULT_TITLE;
	const rawLabel = request.subagentLabel?.trim();
	if (rawLabel) {
		const safe = sanitizeSubagentLabel(rawLabel);
		if (safe.length > 0) return ` Sub-agent "${safe}" wants to run `;
	}
	return ` Sub-agent (depth ${request.subagentDepth}) wants to run `;
}

export class ApprovalPrompt implements Component {
	private state: "menu" | "pattern" = "menu";
	private patternInput: Input | null = null;
	private resolved = false;
	/** Last rendered width — captured so `pattern` mode can re-frame the input. */
	private lastWidth = 80;

	constructor(private readonly opts: ApprovalPromptOptions) {}

	invalidate(): void {
		// Stateless renderer — nothing to invalidate. Required by the
		// Component interface.
	}

	render(width: number): string[] {
		// NEVER widen beyond the real terminal width: pi-tui hard-throws (and
		// the throw kills the whole TUI process) on any rendered line wider
		// than the terminal. The old `Math.max(40, …)` floor forced exactly
		// that on narrow terminals, and `drawTitleLine` overflowed by 2 at
		// EVERY width (only visible-as-a-crash below 102 cols).
		this.lastWidth = Math.min(width, 100);
		if (this.state === "pattern") return this.renderPatternState();
		return this.renderMenuState();
	}

	private renderMenuState(): string[] {
		const w = this.lastWidth;
		const inner = Math.max(0, w - 4); // 2 for "│ " + 2 for " │"
		const titleLine = drawTitleLine(w, deriveTitle(this.opts.request));
		const cmdLine = boxLine(inner, truncateForBox(this.opts.request.command, inner));
		const spacer = boxLine(inner, "");
		const row1 = boxLine(
			inner,
			`${brand.amber("[Y]")} ${brand.dim("Allow once")}   ${brand.amber("[A]")} ${brand.dim("Allow always")}`,
		);
		const row2 = boxLine(
			inner,
			`${brand.amber("[P]")} ${brand.dim("Allow pattern…")}   ${brand.amber("[N]")} ${brand.dim("Deny")}`,
		);
		const row3 = boxLine(
			inner,
			`${brand.amber("[S]")} ${brand.dim("Allow all this session (skips prompts; safety guards still apply)")}`,
		);
		const bottom = drawHorizLine(w, "└", "┘");
		const hint = fitToWidth(`   ${brand.dim("Esc = deny · single keystroke resolves")}`, w);
		return [titleLine, cmdLine, spacer, row1, row2, row3, bottom, hint];
	}

	private renderPatternState(): string[] {
		const w = this.lastWidth;
		const inner = Math.max(0, w - 4);
		const titleLine = drawTitleLine(w, " Approve matching pattern ");
		const helpLine = boxLine(
			inner,
			`${brand.dim("Regex matched against the FULL command. e.g.")} ${brand.amber("^git status$")}`,
		);
		const helpLine2 = boxLine(
			inner,
			`${brand.dim("Cancel with Esc · Enter to confirm")}`,
		);
		const bottom = drawHorizLine(w, "└", "┘");
		const inputBlock = this.patternInput?.render(inner) ?? [];
		const framedInput = inputBlock.map((line) => {
			const fitted = fitToWidth(line, inner);
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
			return `${brand.dim("│ ")}${fitted}${pad}${brand.dim(" │")}`;
		});
		return [titleLine, helpLine, helpLine2, ...framedInput, bottom];
	}

	handleInput(keyData: string): void {
		if (this.resolved) return;
		if (this.state === "pattern") {
			this.handlePatternInput(keyData);
			return;
		}
		// MENU state — single-letter dispatch + Esc. On kitty-protocol
		// terminals `keyData` is a CSI-u sequence (e.g. `\x1b[121u` for 'y');
		// on legacy terminals (classic Windows console, many SSH/tmux setups)
		// it is the RAW character byte. Decode both — the kitty-only decode
		// silently swallowed Y/A/P/N on legacy input, leaving the operator
		// unable to approve anything (observed in production on Windows
		// PowerShell; only Esc worked because `matchesKey` handles legacy
		// `\x1b`). The editor's Input component accepts raw printables, so
		// the prompt must too or typing works everywhere except the one
		// keystroke that gates tool execution.
		if (matchesKey(keyData, "escape")) {
			this.opts.onCancel?.();
			this.resolve({ decision: "deny" });
			return;
		}
		const ch = decodeKittyPrintable(keyData) ?? decodeLegacyPrintable(keyData);
		if (!ch) return;
		switch (ch.toLowerCase()) {
			case "y":
				this.resolve({ decision: "allow-once" });
				return;
			case "a":
				this.resolve({ decision: "allow-always" });
				return;
			case "s":
				this.resolve({ decision: "allow-session" });
				return;
			case "p":
				this.enterPatternMode();
				return;
			case "n":
				this.resolve({ decision: "deny" });
				return;
		}
	}

	private handlePatternInput(keyData: string): void {
		const input = this.patternInput;
		if (!input) return;
		// Esc → back to deny.
		if (matchesKey(keyData, "escape")) {
			this.resolve({ decision: "deny" });
			return;
		}
		// Forward everything else to the Input. Submission handled via
		// the input's `onSubmit` we registered in `enterPatternMode`.
		input.handleInput(keyData);
	}

	private enterPatternMode(): void {
		this.state = "pattern";
		const input = new Input();
		input.onSubmit = (value: string): void => {
			const pattern = value.trim();
			if (!pattern) {
				// Empty pattern → treat as "allow-once" so the operator
				// isn't trapped (they intended to allow at least this call).
				this.resolve({ decision: "allow-once" });
				return;
			}
			this.resolve({ decision: "allow-pattern", pattern });
		};
		input.onEscape = (): void => {
			this.resolve({ decision: "deny" });
		};
		this.patternInput = input;
		this.opts.tui.setFocus(input);
		this.opts.tui.requestRender();
	}

	private resolve(resolution: ApprovalResolution): void {
		if (this.resolved) return;
		this.resolved = true;
		this.opts.onResolve(resolution);
	}
}

/* ─────────────────────────── helpers ─────────────────────────── */

/**
 * Legacy-terminal printable decode: a single raw character byte ≥ 0x20
 * (and not DEL). Escape sequences can never false-positive here — they are
 * multi-byte strings starting with `\x1b` (0x1b < 0x20). Inert on kitty
 * terminals, where printables always arrive as CSI-u sequences.
 */
function decodeLegacyPrintable(data: string): string | undefined {
	if (data.length !== 1) return undefined;
	const code = data.codePointAt(0) ?? 0;
	if (code < 0x20 || code === 0x7f) return undefined;
	return data;
}

/** ANSI-aware "make this line ≤ maxVisible cols" — pass-through when it fits. */
function fitToWidth(line: string, maxVisible: number): string {
	if (maxVisible <= 0) return "";
	if (visibleWidth(line) <= maxVisible) return line;
	return truncateToWidth(line, maxVisible);
}

function drawTitleLine(width: number, title: string): string {
	// Frame budget: "┌─" (2) + title + dashes (≥1) + "┐" (1). The sum MUST
	// equal `width` exactly — pi-tui throws on any over-wide line and that
	// throw takes the whole TUI process down. The previous arithmetic
	// (`width - titleLen - 1`) summed to width + 2 on every render; it only
	// presented as a crash on terminals narrower than the 100-col cap + 2.
	// Long sub-agent titles are truncated so the frame never gives up its
	// trailing dash + corner.
	if (width < 4) return brand.dim("─".repeat(Math.max(0, width)));
	const titleBudget = width - 4;
	const fitted = fitToWidth(title, titleBudget);
	const remaining = Math.max(1, width - 3 - visibleWidth(fitted));
	return `${brand.dim("┌─")}${brand.amber(fitted)}${brand.dim("─".repeat(remaining))}${brand.dim("┐")}`;
}

function drawHorizLine(width: number, left: string, right: string): string {
	if (width < 2) return brand.dim("─".repeat(Math.max(0, width)));
	const inner = "─".repeat(Math.max(0, width - 2));
	return brand.dim(`${left}${inner}${right}`);
}

function boxLine(innerWidth: number, content: string): string {
	const fitted = fitToWidth(content, innerWidth);
	const pad = Math.max(0, innerWidth - visibleWidth(fitted));
	return `${brand.dim("│ ")}${fitted}${" ".repeat(pad)}${brand.dim(" │")}`;
}

/**
 * Truncate a multi-line / long command string to fit one box line. We
 * intentionally don't word-wrap — the box should show one canonical line
 * (the command); the agent's reasoning context already shows the full
 * thing. Newlines flatten to space, ANSI-free, truncate with ellipsis.
 */
function truncateForBox(raw: string, maxVisible: number): string {
	const flat = raw.replace(/[\r\n]+/g, " ").trim();
	if (visibleWidth(flat) <= maxVisible) return flat;
	const cap = Math.max(8, maxVisible - 1);
	return `${flat.slice(0, cap)}…`;
}
