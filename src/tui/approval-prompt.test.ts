/**
 * ApprovalPrompt width-safety regression tests.
 *
 * Production crash (2026-06-11, operator field report, twice): the moment a
 * permission box appeared on a ~83-column terminal, pi-tui's overflow guard
 * threw `Rendered line N exceeds terminal width (85 > 83)` and the throw
 * took the ENTIRE TUI process down (crash dump showed line `[43] (w=85)`
 * = the box's `┌─ Brigade wants to run ─…─┐` top border).
 *
 * Root causes pinned here:
 *   - `drawTitleLine` summed to `width + 2` on EVERY render (the two corner
 *     glyphs were never subtracted from the dash fill) — only presenting as
 *     a crash on terminals narrower than the 100-col cap + 2.
 *   - `render()` floored the working width at 40, forcing overflow on any
 *     terminal narrower than that.
 *   - `boxLine` padded but never truncated over-wide content (the pattern
 *     state's regex help line overflowed anything under ~62 cols).
 *
 * Contract: for ANY terminal width, every rendered line's visible width
 * must be ≤ that width. pi-tui kills the process otherwise — there is no
 * soft-failure mode to fall back on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleWidth, type TUI } from "@mariozechner/pi-tui";

import { ApprovalPrompt, type ApprovalRenderRequest } from "./approval-prompt.js";

function fakeTui(): TUI {
	return {
		setFocus: () => {},
		requestRender: () => {},
	} as unknown as TUI;
}

function makeRequest(overrides: Partial<ApprovalRenderRequest> = {}): ApprovalRenderRequest {
	return {
		id: "req-1",
		toolName: "bash",
		command:
			'find /c/Users/SmartSystems/.brigade -path "*/skills/*" -type f 2>/dev/null; find /c -name "SKILL.md"',
		...overrides,
	};
}

function maxLineWidth(lines: string[]): number {
	return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

test("menu render never exceeds the terminal width (83-col crash repro)", () => {
	const prompt = new ApprovalPrompt({
		tui: fakeTui(),
		request: makeRequest(),
		onResolve: () => {},
	});
	// 83 is the exact production crash width (old title border rendered 85).
	for (const width of [83, 120, 100, 80, 60, 40, 24, 12]) {
		const lines = prompt.render(width);
		assert.ok(lines.length > 0, `width ${width}: no lines rendered`);
		const widest = maxLineWidth(lines);
		assert.ok(
			widest <= width,
			`width ${width}: widest rendered line is ${widest} (pi-tui would kill the TUI)`,
		);
	}
});

test("title text survives at normal widths", () => {
	const prompt = new ApprovalPrompt({
		tui: fakeTui(),
		request: makeRequest(),
		onResolve: () => {},
	});
	const lines = prompt.render(83);
	assert.ok(
		lines[0]?.includes("Brigade wants to run"),
		"top border should still carry the title at 83 cols",
	);
});

test("long sub-agent label title truncates instead of overflowing", () => {
	const prompt = new ApprovalPrompt({
		tui: fakeTui(),
		request: makeRequest({
			subagentDepth: 1,
			subagentLabel:
				"audit the entire authentication flow end to end across every provider and report",
		}),
		onResolve: () => {},
	});
	for (const width of [83, 50, 30, 16]) {
		const widest = maxLineWidth(prompt.render(width));
		assert.ok(widest <= width, `width ${width}: widest line is ${widest}`);
	}
});

test("legacy-terminal keystrokes resolve the prompt (Y/A/N as raw bytes)", () => {
	// Production failure: on terminals without the kitty keyboard protocol
	// (classic Windows console), keys arrive as raw chars — the kitty-only
	// decode swallowed them and the operator could not approve at all.
	const cases: Array<[string, string]> = [
		["y", "allow-once"],
		["Y", "allow-once"],
		["a", "allow-always"],
		["s", "allow-session"],
		["S", "allow-session"],
		["n", "deny"],
	];
	for (const [key, expected] of cases) {
		let resolved: string | undefined;
		const prompt = new ApprovalPrompt({
			tui: fakeTui(),
			request: makeRequest(),
			onResolve: (r) => {
				resolved = r.decision;
			},
		});
		prompt.handleInput(key);
		assert.equal(resolved, expected, `raw "${key}" should resolve ${expected}`);
	}
});

test("kitty CSI-u keystrokes still resolve the prompt", () => {
	// 'y' = codepoint 121 → CSI-u sequence \x1b[121u
	let resolved: string | undefined;
	const prompt = new ApprovalPrompt({
		tui: fakeTui(),
		request: makeRequest(),
		onResolve: (r) => {
			resolved = r.decision;
		},
	});
	prompt.handleInput("\x1b[121u");
	assert.equal(resolved, "allow-once");
});

test("escape and control bytes: Esc denies, other control input is ignored", () => {
	let resolved: string | undefined;
	let cancelled = false;
	const prompt = new ApprovalPrompt({
		tui: fakeTui(),
		request: makeRequest(),
		onResolve: (r) => {
			resolved = r.decision;
		},
		onCancel: () => {
			cancelled = true;
		},
	});
	// Random control byte → swallowed, prompt still pending.
	prompt.handleInput("\x01");
	assert.equal(resolved, undefined);
	// Legacy Esc → deny.
	prompt.handleInput("\x1b");
	assert.equal(resolved, "deny");
	assert.equal(cancelled, true);
});

test("pattern state stays within width (regex help line used to overflow narrow terminals)", () => {
	const prompt = new ApprovalPrompt({
		tui: fakeTui(),
		request: makeRequest(),
		onResolve: () => {},
	});
	(prompt as unknown as { enterPatternMode: () => void }).enterPatternMode();
	for (const width of [83, 50, 30]) {
		const lines = prompt.render(width);
		assert.ok(lines.length > 0, `width ${width}: no lines rendered`);
		const widest = maxLineWidth(lines);
		assert.ok(widest <= width, `width ${width}: widest line is ${widest}`);
	}
});
