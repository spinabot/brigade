/**
 * Terminal animation gate — the ONE place that decides whether Brigade's
 * cosmetic animations (the brand video clip, loader spinners) run in the
 * current terminal.
 *
 * Why gate at all: Pi-TUI repaints animation frames by moving the hardware
 * cursor and rewriting rows. Terminals that support DEC mode 2026
 * (synchronized output) apply each repaint atomically — no tearing, no
 * viewport bounce. Terminals that DON'T (legacy Windows conhost/cmd, classic
 * xterm, older VTE builds, most multiplexers) draw every cursor move and row
 * clear as it arrives: at video frame rates that reads as flicker/"shaking",
 * and on slow consoles the write volume backs the event loop up until
 * keystrokes lag by seconds. Users read both as "Brigade is broken".
 *
 * Policy: animate ONLY where we positively recognise a terminal that handles
 * synchronized output well; hold a static frame everywhere else. A static
 * brand header is always correct — never janky.
 *
 * Overrides (checked first, in order):
 *   BRIGADE_NO_ANIM=1   force-disable (any value other than "" / "0")
 *   BRIGADE_ANIM=1      force-enable  (same truthiness rule)
 */

import { brand } from "./theme.js";

const isTruthy = (v: string | undefined): boolean => v !== undefined && v !== "" && v !== "0";

/**
 * Should cosmetic animations run in this terminal?
 *
 * `env` / `isTTY` are injectable for tests; production callers use the
 * defaults. The answer is intentionally NOT cached — it's a handful of env
 * reads, and tests / long-lived processes may legitimately see it change.
 */
export function terminalAnimationsEnabled(
	env: NodeJS.ProcessEnv = process.env,
	isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
	if (isTruthy(env.BRIGADE_NO_ANIM)) return false;
	if (isTruthy(env.BRIGADE_ANIM)) return true;
	// Piped / redirected output: frames would interleave into logs.
	if (!isTTY) return false;
	if (isTruthy(env.CI)) return false;
	if ((env.TERM ?? "").toLowerCase() === "dumb") return false;
	// Remote shells: every repaint crosses the network round-trip, so
	// frame-rate animation turns into lag + tearing even when the local
	// emulator is excellent.
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
	// Runtime probe first (DECRQM mode-2026 query at startup, see below) —
	// a terminal's own answer beats any env heuristic in BOTH directions:
	// "yes" animates unknown-but-capable terminals; "no" holds terminals
	// whose env LOOKS capable but whose installed version isn't (e.g.
	// Windows Terminal only shipped synchronized output in 1.23, Jan 2026 —
	// older builds honestly answer 0). Only when the terminal never answered
	// the query ("mute" fence result, timeout, or the probe never ran) does
	// the static allowlist decide.
	if (probedSyncOutput === "yes") return true;
	if (probedSyncOutput === "no") return false;
	return isKnownSmoothTerminal(env);
}

/**
 * Allowlist of terminals known to support DEC 2026 synchronized output (or
 * to repaint small regions smoothly regardless). Everything unrecognised —
 * bare conhost/cmd, classic xterm, unknown emulators, multiplexers that
 * don't pass 2026 through — gets the static frame.
 */
function isKnownSmoothTerminal(env: NodeJS.ProcessEnv): boolean {
	// Multiplexer guard: outer-terminal vars (KITTY_WINDOW_ID, TERM_PROGRAM,
	// WT_SESSION, …) inherit into tmux/screen sessions, but the mux is the
	// terminal we're actually talking to — and tmux only forwards
	// synchronized output to in-pane apps since 3.7 (screen never does).
	// Inside a mux, only a positive runtime probe (tmux ≥ 3.7 answers
	// DECRQM itself) may animate; the leaked env must not.
	const term = (env.TERM ?? "").toLowerCase();
	if (env.TMUX || term.startsWith("screen") || term.startsWith("tmux")) return false;
	// Windows Terminal — ships synchronized output in stable 1.23 (Jan 2026).
	// Older installs answer the runtime probe with "0" and get caught by the
	// probe-beats-allowlist rule above; this entry covers probe-mute paths.
	if (env.WT_SESSION) return true;
	// Kitty / Alacritty expose their own window-id vars.
	if (env.KITTY_WINDOW_ID || env.ALACRITTY_WINDOW_ID) return true;
	if (
		term.includes("kitty") ||
		term.includes("ghostty") ||
		term.startsWith("alacritty") ||
		term.startsWith("wezterm") ||
		term.startsWith("foot") ||
		term.startsWith("contour")
	) {
		return true;
	}
	const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
	// iTerm2 authored the synchronized-output spec; VS Code's xterm.js and
	// WezTerm/Ghostty implement it. (Apple_Terminal notably does NOT — it
	// stays excluded.)
	if (["iterm.app", "wezterm", "ghostty", "vscode"].includes(termProgram)) return true;
	// VTE-based emulators (GNOME Terminal, Tilix, …) gained synchronized
	// output in VTE 0.66; VTE_VERSION is e.g. "6603" for 0.66.3.
	const vte = Number.parseInt(env.VTE_VERSION ?? "", 10);
	if (Number.isFinite(vte) && vte >= 6600) return true;
	// Konsole ships synchronized output from KDE Gear 26.04 but is the one
	// mainstream terminal that never answers DECRQM — the probe can't see
	// it, so the version env var must (KONSOLE_VERSION is e.g. "260400").
	const konsole = Number.parseInt(env.KONSOLE_VERSION ?? "", 10);
	if (Number.isFinite(konsole) && konsole >= 260400) return true;
	return false;
}

/* ────────────────── runtime capability probe (DECRQM 2026) ────────────────── */
// The env allowlist above can't know every capable terminal. At CLI startup
// (BEFORE the TUI takes over stdin) we can simply ASK the terminal whether it
// supports synchronized output: DECRQM `CSI ? 2026 $ p` → the terminal
// replies with DECRPM `CSI ? 2026 ; Ps $ y`. This is the same battle-tested
// dance Bubble Tea v2 and Textual ship. A terminal that answers "supported"
// gets animations even though we've never heard of it — future emulators
// work on day one without a Brigade release.

// Result of the one-shot probe:
//   "yes"     — terminal reported synchronized output supported (DECRPM 1/2)
//   "no"      — terminal explicitly reported it unsupported (DECRPM 0/3/4)
//   "mute"    — terminal answered the DA1 fence but not DECRQM (doesn't
//               speak DECRQM at all — e.g. Konsole, tmux ≤ 3.6, conhost)
//   undefined — never probed / timed out → the allowlist alone decides
export type SyncOutputProbeResult = "yes" | "no" | "mute" | undefined;
let probedSyncOutput: SyncOutputProbeResult;
let probeRan = false;

/** Record a probe result. Exposed for the probe itself and for tests. */
export function recordSyncOutputProbe(result: SyncOutputProbeResult): void {
	probedSyncOutput = result;
}

/**
 * Parse a DECRPM reply for mode 2026 out of a raw input chunk.
 * `CSI ? 2026 ; Ps $ y` — Ps: 0 = unrecognised, 1 = set, 2 = reset,
 * 3 = permanently set, 4 = permanently reset. Only 1/2 mean usable support
 * (3 is undefined by the spec, 4 is how VTE says "recognised but never
 * available" — both are treated as "no", matching Neovim's tui.c).
 * Returns undefined when no DECRPM reply is present in the chunk.
 */
export function parseSyncOutputProbeReply(data: string): boolean | undefined {
	const m = /\x1b\[\?2026;(\d+)\$y/.exec(data);
	if (!m) return undefined;
	const ps = Number(m[1]);
	return ps === 1 || ps === 2;
}

/**
 * Is the runtime probe worth running? Only for unknown local TTY terminals:
 * explicit overrides, non-TTYs, CI, dumb, SSH, and allowlisted terminals all
 * already have their answer.
 */
export function shouldProbeTerminal(
	env: NodeJS.ProcessEnv = process.env,
	stdinIsTTY: boolean = Boolean(process.stdin.isTTY),
	stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
	if (isTruthy(env.BRIGADE_NO_ANIM) || isTruthy(env.BRIGADE_ANIM)) return false;
	if (!stdinIsTTY || !stdoutIsTTY) return false;
	if (isTruthy(env.CI)) return false;
	if ((env.TERM ?? "").toLowerCase() === "dumb") return false;
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
	// Apple Terminal implements neither mode 2026 nor DECRQM — Neovim skips
	// the query there as a courtesy and so do we (the DA1 fence would save
	// us anyway; skipping just sends zero bytes to a terminal we know).
	if ((env.TERM_PROGRAM ?? "").toLowerCase() === "apple_terminal") return false;
	// NOTE: allowlisted terminals are probed too, on purpose — a terminal
	// whose env looks capable but whose installed version answers "0"
	// (pre-1.23 Windows Terminal, pre-6.0 xterm.js) must land on "no", and
	// the probe is the only honest source for that. Local terminals answer
	// in single-digit milliseconds.
	return true;
}

/**
 * One-shot startup probe. Call BEFORE constructing the TUI (it briefly owns
 * stdin). Writes DECRQM for mode 2026 followed by DA1 (`CSI c`) as a
 * response FENCE: effectively every terminal answers DA1, and replies are
 * ordered, so once the DA1 answer arrives we know the DECRPM reply either
 * came already or never will — and both replies have been consumed, so no
 * escape bytes can leak into the TUI's input stream and type garbage into
 * the editor. Terminals that answer neither hit the timeout and the static
 * allowlist decides (fail-safe). Never throws.
 */
export async function probeTerminalAnimationSupport(timeoutMs = 500): Promise<void> {
	if (probeRan) return;
	probeRan = true;
	if (!shouldProbeTerminal()) return;
	const stdin = process.stdin;
	const wasRaw = (stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw === true;
	try {
		stdin.setRawMode?.(true);
	} catch {
		return;
	}
	probedSyncOutput = await new Promise<SyncOutputProbeResult>((resolve) => {
		let buf = "";
		let done = false;
		const cleanup = (): void => {
			clearTimeout(timer);
			stdin.removeListener("data", onData);
			try {
				stdin.setRawMode?.(wasRaw);
			} catch {
				/* restoring raw mode is best-effort */
			}
			stdin.pause();
		};
		const finish = (v: SyncOutputProbeResult): void => {
			if (done) return;
			done = true;
			cleanup();
			resolve(v);
		};
		const onData = (chunk: Buffer | string): void => {
			buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			// Resolve ONLY on the DA1 fence (CSI ? … c) — waiting for it even
			// after a DECRPM reply guarantees both responses are consumed, so
			// no escape bytes leak into the TUI's input stream.
			const fence = /\x1b\[\?[\d;]*c/.exec(buf);
			if (!fence) return;
			// Anything AFTER the fence is real user input typed during the
			// probe window — hand it back to the stream instead of eating it.
			const rest = buf.slice(fence.index + fence[0].length);
			const decrpm = parseSyncOutputProbeReply(buf.slice(0, fence.index + fence[0].length));
			finish(decrpm === undefined ? "mute" : decrpm ? "yes" : "no");
			if (rest.length > 0) stdin.unshift(Buffer.from(rest, "utf8"));
		};
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		timer.unref?.();
		stdin.on("data", onData);
		stdin.resume();
		process.stdout.write("\x1b[?2026$p\x1b[c");
	});
}

/**
 * Loader-spinner indicator override for the current terminal.
 *
 * Pi-TUI's Loader skips its setInterval entirely when the indicator has a
 * single frame (`frames.length <= 1` → no timer), so on gated terminals this
 * turns every spinner into a zero-cost static badge instead of ~12 repaints
 * a second. Returns `undefined` on capable terminals, which keeps the
 * default animated spinner. The dot is pre-coloured because Pi-TUI renders
 * custom indicator frames verbatim (it skips the spinner colour function).
 *
 * Usage: `new CancellableLoader(tui, amber, dim, "msg", loaderIndicator())`.
 */
export function loaderIndicator(): { frames: string[] } | undefined {
	if (terminalAnimationsEnabled()) return undefined;
	return { frames: [brand.amber("●")] };
}
