/**
 * Pin-down tests for the terminal animation gate.
 *
 * The gate decides whether cosmetic animations (brand video clip, loader
 * spinners) run. The rules under test, in precedence order:
 *
 *   1. BRIGADE_NO_ANIM truthy  → off, no matter what
 *   2. BRIGADE_ANIM truthy     → on, no matter what (explicit operator ask)
 *   3. not a TTY / CI / TERM=dumb / SSH → off
 *   4. otherwise: ON only for terminals on the known-smooth allowlist
 *      (DEC 2026 synchronized output); everything unrecognised is OFF.
 *
 * "Unrecognised → off" is the load-bearing default: an animated header on a
 * terminal that can't repaint atomically reads as flicker/"shaking" and can
 * wedge slow consoles — a static header is always correct.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	loaderIndicator,
	parseSyncOutputProbeReply,
	recordSyncOutputProbe,
	shouldProbeTerminal,
	terminalAnimationsEnabled,
} from "./animations.js";

// Convenience: every call passes isTTY=true unless the test is about TTY.
const enabled = (env: NodeJS.ProcessEnv, isTTY = true): boolean => terminalAnimationsEnabled(env, isTTY);

describe("terminalAnimationsEnabled — overrides", () => {
	it("BRIGADE_NO_ANIM force-disables even on a smooth terminal", () => {
		assert.equal(enabled({ BRIGADE_NO_ANIM: "1", WT_SESSION: "x" }), false);
	});

	it("BRIGADE_NO_ANIM wins over BRIGADE_ANIM when both are set", () => {
		assert.equal(enabled({ BRIGADE_NO_ANIM: "1", BRIGADE_ANIM: "1", WT_SESSION: "x" }), false);
	});

	it('BRIGADE_NO_ANIM="0" and "" are treated as unset', () => {
		assert.equal(enabled({ BRIGADE_NO_ANIM: "0", WT_SESSION: "x" }), true);
		assert.equal(enabled({ BRIGADE_NO_ANIM: "", WT_SESSION: "x" }), true);
	});

	it("BRIGADE_ANIM force-enables on an unrecognised terminal, even without a TTY", () => {
		assert.equal(enabled({ BRIGADE_ANIM: "1", TERM: "xterm-256color" }), true);
		assert.equal(enabled({ BRIGADE_ANIM: "1" }, false), true);
	});
});

describe("terminalAnimationsEnabled — environment suppressors", () => {
	it("off when stdout is not a TTY (piped / redirected)", () => {
		assert.equal(enabled({ WT_SESSION: "x" }, false), false);
	});

	it("off under CI", () => {
		assert.equal(enabled({ CI: "true", WT_SESSION: "x" }), false);
	});

	it("off for TERM=dumb", () => {
		assert.equal(enabled({ TERM: "dumb", WT_SESSION: "x" }), false);
	});

	it("off over SSH regardless of the local emulator", () => {
		assert.equal(enabled({ SSH_CONNECTION: "10.0.0.1 22", WT_SESSION: "x" }), false);
		assert.equal(enabled({ SSH_CLIENT: "10.0.0.1", TERM: "xterm-kitty" }), false);
		assert.equal(enabled({ SSH_TTY: "/dev/pts/0", TERM_PROGRAM: "iTerm.app" }), false);
	});
});

describe("terminalAnimationsEnabled — known-smooth allowlist", () => {
	it("Windows Terminal via WT_SESSION", () => {
		assert.equal(enabled({ WT_SESSION: "guid" }), true);
	});

	it("kitty / alacritty via their window-id vars", () => {
		assert.equal(enabled({ KITTY_WINDOW_ID: "1" }), true);
		assert.equal(enabled({ ALACRITTY_WINDOW_ID: "1" }), true);
	});

	it("recognised TERM values", () => {
		assert.equal(enabled({ TERM: "xterm-kitty" }), true);
		assert.equal(enabled({ TERM: "xterm-ghostty" }), true);
		assert.equal(enabled({ TERM: "alacritty" }), true);
		assert.equal(enabled({ TERM: "wezterm" }), true);
		assert.equal(enabled({ TERM: "foot-extra" }), true);
		assert.equal(enabled({ TERM: "contour" }), true);
	});

	it("recognised TERM_PROGRAM values (case-insensitive)", () => {
		assert.equal(enabled({ TERM_PROGRAM: "iTerm.app" }), true);
		assert.equal(enabled({ TERM_PROGRAM: "WezTerm" }), true);
		assert.equal(enabled({ TERM_PROGRAM: "ghostty" }), true);
		assert.equal(enabled({ TERM_PROGRAM: "vscode" }), true);
	});

	it("Apple Terminal is NOT on the allowlist (no synchronized output)", () => {
		assert.equal(enabled({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }), false);
	});

	it("VTE >= 0.66 qualifies; older VTE does not", () => {
		assert.equal(enabled({ VTE_VERSION: "6603" }), true);
		assert.equal(enabled({ VTE_VERSION: "7802" }), true);
		assert.equal(enabled({ VTE_VERSION: "5202" }), false);
	});

	it("Konsole >= 26.04 qualifies via KONSOLE_VERSION (it never answers DECRQM)", () => {
		assert.equal(enabled({ KONSOLE_VERSION: "260400" }), true);
		assert.equal(enabled({ KONSOLE_VERSION: "230804" }), false);
	});

	it("multiplexers block leaked outer-terminal vars — tmux/screen stay static", () => {
		assert.equal(enabled({ TMUX: "/tmp/tmux-1000/default,123,0", KITTY_WINDOW_ID: "1" }), false);
		assert.equal(enabled({ TERM: "screen-256color", TERM_PROGRAM: "iTerm.app" }), false);
		assert.equal(enabled({ TERM: "tmux-256color", WT_SESSION: "guid" }), false);
	});

	it("bare conhost (empty env) is off — the exact 'shakes like hell' case", () => {
		assert.equal(enabled({}), false);
	});

	it("classic xterm / unknown emulators / multiplexers are off", () => {
		assert.equal(enabled({ TERM: "xterm-256color" }), false);
		assert.equal(enabled({ TERM: "screen-256color" }), false);
		assert.equal(enabled({ TERM: "tmux-256color" }), false);
	});
});

describe("parseSyncOutputProbeReply — DECRPM for mode 2026", () => {
	const ESC = "\x1b";

	it("Ps 1 (set) / 2 (reset) mean usable support", () => {
		assert.equal(parseSyncOutputProbeReply(`${ESC}[?2026;1$y`), true);
		assert.equal(parseSyncOutputProbeReply(`${ESC}[?2026;2$y`), true);
	});

	it("Ps 0 / 3 / 4 → unsupported (3 is spec-undefined; 4 is VTE's honest no)", () => {
		assert.equal(parseSyncOutputProbeReply(`${ESC}[?2026;0$y`), false);
		assert.equal(parseSyncOutputProbeReply(`${ESC}[?2026;3$y`), false);
		assert.equal(parseSyncOutputProbeReply(`${ESC}[?2026;4$y`), false);
	});

	it("finds the reply inside a buffer with other responses around it", () => {
		const buf = `garbage${ESC}[?2026;2$y${ESC}[?61;4;6;22c`;
		assert.equal(parseSyncOutputProbeReply(buf), true);
	});

	it("returns undefined when no DECRPM reply is present (e.g. DA1 only)", () => {
		assert.equal(parseSyncOutputProbeReply(`${ESC}[?61;4c`), undefined);
		assert.equal(parseSyncOutputProbeReply(""), undefined);
	});
});

describe("shouldProbeTerminal — probe only unknown local TTY terminals", () => {
	it("skips when an explicit override already decided", () => {
		assert.equal(shouldProbeTerminal({ BRIGADE_NO_ANIM: "1", TERM: "xterm-256color" }, true, true), false);
		assert.equal(shouldProbeTerminal({ BRIGADE_ANIM: "1", TERM: "xterm-256color" }, true, true), false);
	});

	it("skips without a TTY on both ends", () => {
		assert.equal(shouldProbeTerminal({ TERM: "xterm-256color" }, false, true), false);
		assert.equal(shouldProbeTerminal({ TERM: "xterm-256color" }, true, false), false);
	});

	it("skips CI / dumb / SSH (the gate already blocks them)", () => {
		assert.equal(shouldProbeTerminal({ CI: "1", TERM: "xterm-256color" }, true, true), false);
		assert.equal(shouldProbeTerminal({ TERM: "dumb" }, true, true), false);
		assert.equal(shouldProbeTerminal({ SSH_TTY: "/dev/pts/0", TERM: "xterm-256color" }, true, true), false);
	});

	it("probes allowlisted terminals too — installed versions can honestly answer no", () => {
		assert.equal(shouldProbeTerminal({ WT_SESSION: "guid" }, true, true), true);
		assert.equal(shouldProbeTerminal({ TERM: "xterm-kitty" }, true, true), true);
	});

	it("skips Apple Terminal (implements neither 2026 nor DECRQM — Neovim's courtesy)", () => {
		assert.equal(shouldProbeTerminal({ TERM_PROGRAM: "Apple_Terminal" }, true, true), false);
	});

	it("probes an unknown local TTY terminal", () => {
		assert.equal(shouldProbeTerminal({ TERM: "xterm-256color" }, true, true), true);
		assert.equal(shouldProbeTerminal({}, true, true), true);
	});
});

describe("gate honours the recorded probe result", () => {
	it('probe "yes" upgrades an unknown terminal to animated', () => {
		try {
			recordSyncOutputProbe("yes");
			assert.equal(terminalAnimationsEnabled({ TERM: "xterm-256color" }, true), true);
		} finally {
			recordSyncOutputProbe(undefined);
		}
		assert.equal(terminalAnimationsEnabled({ TERM: "xterm-256color" }, true), false);
	});

	it('probe "no" overrides the allowlist — an old Windows Terminal stays static', () => {
		try {
			recordSyncOutputProbe("no");
			assert.equal(terminalAnimationsEnabled({ WT_SESSION: "guid" }, true), false);
			assert.equal(terminalAnimationsEnabled({ TERM_PROGRAM: "vscode" }, true), false);
		} finally {
			recordSyncOutputProbe(undefined);
		}
	});

	it('probe "mute" / absent falls back to the allowlist (Konsole-class terminals)', () => {
		try {
			recordSyncOutputProbe("mute");
			assert.equal(terminalAnimationsEnabled({ TERM: "xterm-256color" }, true), false);
			assert.equal(terminalAnimationsEnabled({ WT_SESSION: "guid" }, true), true);
			assert.equal(terminalAnimationsEnabled({ KONSOLE_VERSION: "260400" }, true), true);
		} finally {
			recordSyncOutputProbe(undefined);
		}
	});

	it('BRIGADE_NO_ANIM still beats a probe "yes"', () => {
		try {
			recordSyncOutputProbe("yes");
			assert.equal(terminalAnimationsEnabled({ BRIGADE_NO_ANIM: "1", TERM: "xterm-256color" }, true), false);
		} finally {
			recordSyncOutputProbe(undefined);
		}
	});
});

describe("loaderIndicator", () => {
	// loaderIndicator reads process.env directly — pin the override vars for
	// the duration of each assertion and restore afterwards.
	const withEnv = (vars: Record<string, string | undefined>, fn: () => void): void => {
		const saved: Record<string, string | undefined> = {};
		for (const k of Object.keys(vars)) {
			saved[k] = process.env[k];
			const v = vars[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			fn();
		} finally {
			for (const k of Object.keys(saved)) {
				const v = saved[k];
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	};

	it("returns a single static frame when animations are gated off", () => {
		withEnv({ BRIGADE_NO_ANIM: "1", BRIGADE_ANIM: undefined }, () => {
			const indicator = loaderIndicator();
			assert.ok(indicator, "expected a static indicator override");
			assert.equal(indicator.frames.length, 1);
			assert.ok(indicator.frames[0]!.includes("●"));
		});
	});

	it("returns undefined (default spinner) when animations are on", () => {
		withEnv({ BRIGADE_ANIM: "1", BRIGADE_NO_ANIM: undefined }, () => {
			assert.equal(loaderIndicator(), undefined);
		});
	});
});
