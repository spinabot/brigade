/**
 * Pin-down tests for the brand header's responsive layout ladder.
 *
 * The header must adapt to BOTH terminal dimensions: width decides which
 * marks physically fit, height decides the vertical budget. The invariants
 * under test:
 *
 *   1. Realistic terminal sizes land on the intended mode (a stock 80×24
 *      macOS Terminal gets the small wordmark, never a 30-row video).
 *   2. Video modes are chosen ONLY with enough rows to fit the clip plus
 *      room for content below — repainting a block that overflows the
 *      viewport degenerates into full clear-and-redraw strobing.
 *   3. The composed block always fits: every line's visible width ≤ cols,
 *      and the line count leaves at least two rows for the app below.
 *
 * These run against the REAL composed output (frame 0 of the baked clip),
 * so a change to the wordmark, tagline, pads, or thresholds that would
 * overflow a small screen fails here instead of in a user's terminal.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	ASCII_MIN_WIDTH,
	composeFrame,
	type LayoutMode,
	layoutShowsVideo,
	LINE_MIN_ROWS,
	LINE_MIN_WIDTH,
	pickLayout,
	SIDE_BY_SIDE_THRESHOLD,
	STACK_MIN_ROWS,
	VIDEO_MODE_MIN_ROWS,
	visibleWidth,
	WORDMARK_MIN_ROWS,
	WORDMARK_MIN_WIDTH,
	WORDMARK_SMALL_MIN_ROWS,
	WORDMARK_SMALL_MIN_WIDTH,
} from "./brand.js";

describe("pickLayout — realistic terminal sizes", () => {
	const cases: Array<[cols: number, rows: number, expected: LayoutMode, why: string]> = [
		[80, 24, "wordmark-small", "stock macOS Terminal / MacBook Air default"],
		[80, 25, "wordmark-small", "iTerm2 default window"],
		[120, 30, "wordmark-small", "Windows Terminal default"],
		[140, 30, "wordmark", "wide-but-short editor pane"],
		[140, 24, "wordmark-small", "wide but too short for the 12-row wordmark"],
		[200, 50, "ascii-only", "13\" laptop fullscreen — video fits, side pair doesn't"],
		[100, 50, "ascii-only", "narrow-tall — clip with the small wordmark locked up under it"],
		[220, 50, "side", "big desktop terminal"],
		[220, 40, "wordmark", "wide but under the video's row budget"],
		[130, 70, "stack", "portrait / rotated monitor"],
		[60, 20, "line", "split pane — too narrow for the small wordmark"],
		[40, 10, "line", "quake-style dropdown"],
		[14, 6, "line", "sliver pane still shows the mark"],
		[10, 6, "empty", "too narrow for anything"],
		[80, 10, "line", "wide sliver — not enough rows for the small wordmark"],
		[80, 3, "empty", "too short for anything"],
	];
	for (const [cols, rows, expected, why] of cases) {
		it(`${cols}×${rows} → ${expected} (${why})`, () => {
			assert.equal(pickLayout(cols, rows), expected);
		});
	}

	it("missing dimensions (non-TTY pipe) assume a large surface → side", () => {
		assert.equal(pickLayout(undefined, undefined), "side");
	});
});

describe("layoutShowsVideo", () => {
	it("true only for the three video modes", () => {
		const video: LayoutMode[] = ["side", "stack", "ascii-only"];
		const still: LayoutMode[] = ["wordmark", "wordmark-small", "line", "empty"];
		for (const m of video) assert.equal(layoutShowsVideo(m), true, m);
		for (const m of still) assert.equal(layoutShowsVideo(m), false, m);
	});

	it("video modes are unreachable below the video row budget", () => {
		for (let cols = 12; cols <= 300; cols += 4) {
			for (let rows = 1; rows < VIDEO_MODE_MIN_ROWS; rows += 1) {
				const mode = pickLayout(cols, rows);
				assert.equal(layoutShowsVideo(mode), false, `${cols}×${rows} chose video mode ${mode}`);
			}
		}
	});
});

describe("composeFrame — the block always fits the terminal", () => {
	// Sweep a grid of sizes that brackets every threshold edge. For each,
	// compose the real block and assert width and height budgets.
	const colSamples = [
		LINE_MIN_WIDTH,
		LINE_MIN_WIDTH + 2,
		20,
		39,
		40,
		56,
		ASCII_MIN_WIDTH,
		WORDMARK_SMALL_MIN_WIDTH,
		WORDMARK_SMALL_MIN_WIDTH + 4,
		80,
		100,
		120,
		WORDMARK_MIN_WIDTH,
		140,
		180,
		200,
		SIDE_BY_SIDE_THRESHOLD,
		240,
	];
	const rowSamples = [
		LINE_MIN_ROWS,
		6,
		10,
		WORDMARK_SMALL_MIN_ROWS,
		20,
		24,
		WORDMARK_MIN_ROWS,
		32,
		38,
		VIDEO_MODE_MIN_ROWS,
		50,
		60,
		STACK_MIN_ROWS,
		80,
	];

	it("every sampled size: lines ≤ rows − 2 and every line's visible width ≤ cols", () => {
		for (const cols of colSamples) {
			for (const rows of rowSamples) {
				const mode = pickLayout(cols, rows);
				const block = composeFrame(0, cols, rows);
				if (mode === "empty") {
					assert.equal(block, "", `${cols}×${rows} empty mode must compose nothing`);
					continue;
				}
				const lines = block.split("\n");
				assert.ok(
					lines.length <= rows - 2,
					`${cols}×${rows} (${mode}): block is ${lines.length} rows — leaves <2 rows for content`,
				);
				for (const line of lines) {
					const w = visibleWidth(line);
					assert.ok(w <= cols, `${cols}×${rows} (${mode}): line ${w} cells wide overflows ${cols} cols`);
				}
			}
		}
	});

	it("small screens get the compact wordmark, not the 30-row video", () => {
		// 80×24 (stock macOS Terminal): 2 pad + 6 wordmark rows + gap + tagline
		// = 10 rows. The video alone is 30 rows, so a small block structurally
		// proves no frame was embedded (and lazy getFrame was never invoked).
		const block = composeFrame(0, 80, 24);
		const lines = block.split("\n");
		assert.ok(lines.length <= 10, `expected the compact mark (≤10 rows), got ${lines.length}`);
		assert.ok(block.toLowerCase().includes("crew"), "tagline present");
	});

	it("ascii-only locks up the brand text under the clip when width allows", () => {
		// The brand must READ at every size — the video-only layout still
		// carries the small wordmark + tagline beneath the clip.
		const block = composeFrame(0, 100, 50);
		assert.ok(block.toLowerCase().includes("crew"), "tagline lockup missing under the clip");
	});

	it("one-line mode truncates to the bare mark on very narrow panes", () => {
		const narrow = composeFrame(0, LINE_MIN_WIDTH, 10);
		assert.ok(narrow.includes("BRIGADE"));
		assert.ok(!narrow.toLowerCase().includes("crew"), "tagline must be dropped at minimum width");
		const wide = composeFrame(0, 60, 10);
		assert.ok(wide.toLowerCase().includes("crew"), "tagline shown when it fits");
	});
});
