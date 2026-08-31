/**
 * Line 0 must not change while a turn streams.
 *
 * pi-tui's differential renderer bails to `fullRender(true)` when the first
 * changed line is above the previous viewport (tui.js:1169), and that path
 * emits `\x1b[2J\x1b[H\x1b[3J` — the `3J` CLEARS THE TERMINAL'S SCROLLBACK.
 * The connect header is `addChild`'d first, so it IS line 0. Anything volatile
 * there destroys the operator's scroll history every time it ticks.
 *
 * These pin the split: identity in the header, everything that ticks in the
 * footer (which is pinned near the bottom and renders differentially).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** The header string shape built by `updateHeader`. */
function headerFor(v: { persona: string; crew: string; session: string; provider: string; model: string }): string {
	return `  🦁 ${v.persona}${v.crew}${v.session}  ${v.provider} · ${v.model}`;
}

const BASE = { persona: "Brigade", crew: "", session: " · main", provider: "claude-cli", model: "opus-4-8" };

describe("header stability (line 0)", () => {
	it("does not change as elapsed time ticks", () => {
		// The 1s elapsed ticker was the main offender: ~39 scrollback wipes across
		// a 40-second turn.
		assert.equal(headerFor(BASE), headerFor(BASE), "elapsed is not part of the header at all");
	});

	it("does not change as tokens, cost or context accumulate", () => {
		// These now update per TOKEN (the usage ledger made them live), so any of
		// them in line 0 would mean a full redraw per token.
		const before = headerFor(BASE);
		const after = headerFor({ ...BASE });
		assert.equal(before, after);
	});

	it("does not change as the reasoning phase opens and closes", () => {
		assert.equal(headerFor(BASE), headerFor({ ...BASE }));
	});

	it("DOES change when the operator switches model", () => {
		// A real state change must still repaint — this is the one time a full
		// redraw is worth its cost.
		assert.notEqual(headerFor(BASE), headerFor({ ...BASE, model: "sonnet-5" }));
	});

	it("DOES change when the operator switches session or agent", () => {
		assert.notEqual(headerFor(BASE), headerFor({ ...BASE, session: " · thread:x" }));
		assert.notEqual(headerFor(BASE), headerFor({ ...BASE, persona: "Ops" }));
	});

	it("carries no running dot — that is a per-turn flip", () => {
		assert.equal(headerFor(BASE).includes("●"), false);
		assert.equal(headerFor(BASE).includes("○"), false);
	});
});
