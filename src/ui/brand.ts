/**
 * Brigade brand mark — animated coloured ASCII video clip beside a chunky wordmark.
 *
 * Layout (top to bottom):
 *
 *     [pad]
 *     [ASCII video LEFT (56×30)]   GAP   [BRIGADE wordmark RIGHT (12 rows)]
 *     [tagline below the whole thing — cornsilk fullwidth]
 *     [pad]
 *
 * The video is a 56-col × 30-row × 89-frame char-based ASCII clip baked at
 * module-build time (see scripts/gen-brand-frames-cli.mjs and brand-frames-cli.ts).
 * Each cell carries a unicode codepoint and an RGB colour; we paint cells with
 * `chalk.hex(toHex(r,g,b))(char)`, plus a skip-on-space-and-black optimisation
 * that emits a literal space (no chalk wrapper) for empty/black cells so the
 * pre-rendered string size stays sane while remaining visually identical.
 * 89 frames at 15 fps play once, then the last frame holds.
 *
 * Wordmark colours are unchanged from the prior pure-text mark: a 4-stop
 * vertical metallic gradient (cornsilk → gold → amber → bronze) so the
 * lettering still reads as polished metal.
 */

// cfonts is CommonJS — Node's ESM loader can't statically extract named
// exports from it, so `import { render } from "cfonts"` fails at runtime
// even when esModuleInterop lets it typecheck. Use default-import + destructure.
import cfontsPkg from "cfonts";
const { render } = cfontsPkg;

import { type Component, type TUI, Text } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { VIDEO_COLS, VIDEO_FPS, VIDEO_FRAME_COUNT, VIDEO_FRAMES, VIDEO_ROWS } from "./brand-frames-cli.js";

// Wordmark palette — unchanged from the prior pure-text version.
const BRIGADE_HIGHLIGHT = "#FFF8DC"; // cornsilk — barely-there warm white
const BRIGADE_GOLD = "#FFD700"; // bright reflective gold
const BRIGADE_AMBER = "#FFBF00"; // amber midline
const BRIGADE_BRONZE = "#CD7F32"; // bronze fadeout

// Nearest-neighbour upscale factor applied to the cfonts `block` output.
// 2 = each char duplicated horizontally and each row duplicated vertically,
// so 6 letterform rows become 12. Tune this to scale the wordmark.
const WORDMARK_SCALE = 2;

// Cells of left margin applied to ALL rows of the wordmark column (wordmark
// glyphs, blank padding rows, and tagline). Shifts the entire left column
// right so it doesn't hug terminal column 0.
const WORDMARK_INDENT = 4;

// Cells of left margin applied to the tagline so it sits slightly inside
// the BRIGADE wordmark's left edge instead of flush with column 0.
const TAGLINE_INDENT = 10;

// Cells of vertical gap between the wordmark and the tagline.
const TAGLINE_TOP_GAP = 2;

// Per-row colour gradient distributed across the actual row count. With the
// 2x scale the wordmark is 12 rows; the 4-stop ramp flows smoothly regardless.
const COLOR_STOPS = [BRIGADE_HIGHLIGHT, BRIGADE_GOLD, BRIGADE_AMBER, BRIGADE_BRONZE];
function colorForRow(i: number, total: number): string {
	const t = total <= 1 ? 0 : i / (total - 1);
	const idx = Math.min(COLOR_STOPS.length - 1, Math.floor(t * COLOR_STOPS.length));
	return COLOR_STOPS[idx]!;
}

// Render the wordmark glyph shapes once at module load. cfonts is used only
// for SHAPES; we strip its colour escapes and re-apply our own per-row colour
// below so the gradient flows top-to-bottom (cfonts only does horizontal
// gradients).
const cfontsResult = render("BRIGADE", {
	font: "block",
	align: "left",
	colors: ["white"],
	background: "transparent",
	letterSpacing: 1,
	lineHeight: 1,
	space: false,
	maxLength: "0",
	env: "node",
});
const RAW_ART = cfontsResult === false ? "BRIGADE" : cfontsResult.string;

// Strip every ANSI colour escape cfonts injected and split into rows. cfonts
// inserts blank padding rows even with `space: false`, which would shift the
// per-row colour mapping if we kept them. Then pixel-double (nearest-neighbour)
// each row by WORDMARK_SCALE in both axes — codepoint-aware via Array.from so
// multi-byte box-drawing glyphs ('╗','║','═','╔','╚','╝') aren't split between
// their UTF-16 surrogate halves.
const STRIPPED_ROWS = RAW_ART.replace(/\x1b\[[0-9;]*m/g, "")
	.split("\n")
	.filter((row) => row.trim().length > 0)
	.flatMap((row) => {
		const widened = Array.from(row)
			.flatMap((ch) => Array.from({ length: WORDMARK_SCALE }, () => ch))
			.join("");
		return Array.from({ length: WORDMARK_SCALE }, () => widened);
	});

const COLORED_WORDMARK_ROWS: string[] = STRIPPED_ROWS.map((row, idx) =>
	chalk.hex(colorForRow(idx, STRIPPED_ROWS.length))(row),
);

// Convert ASCII letters/digits/printable punctuation to their Unicode
// FULLWIDTH twins (U+FFxx range, codepoint = ascii + 0xFEE0). Fullwidth
// glyphs render at 2 cells wide in most monospace fonts, which makes the
// tagline look visibly larger than plain ASCII without needing cfonts.
// SPACE becomes the ideographic space U+3000 so inter-word gaps stay 2 cells.
function toFullwidth(s: string): string {
	let out = "";
	for (const ch of s) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) {
			out += ch;
			continue;
		}
		if (cp === 0x20) {
			out += "　";
			continue;
		}
		if (cp >= 0x21 && cp <= 0x7e) {
			out += String.fromCodePoint(cp + 0xfee0);
			continue;
		}
		out += ch;
	}
	return out;
}

const TAGLINE = chalk.hex(BRIGADE_HIGHLIGHT)(toFullwidth("your personal AI crew  ·  by spinabot"));

// Three spaces between the video block and the wordmark. The video is now
// 56 cells wide (the char-based render) and the wordmark is ~146 cells once
// pixel-doubled, so the whole composite is ~205 cols wide and requires a
// wide terminal — that's expected for the brand splash.
const GAP = " ".repeat(25);

// Minimum terminal width (in cells) needed for the side-by-side layout to
// fit comfortably. The math:
//   EFFECTIVE_WORDMARK_WIDTH (4 + 118 = 122)
// + GAP.length              (25)
// + VIDEO_COLS              (56)
// = 203 cells exactly. We add ~7 cells of breathing room so the user isn't
// staring at a layout pinned to the right edge of their terminal, giving
// THRESHOLD = 210. Below this width we stack the wordmark on top of the
// video instead of placing them side by side.
export const SIDE_BY_SIDE_THRESHOLD = 210;
// Wordmark column visible width is ~122 cells (WORDMARK_INDENT + WORDMARK_WIDTH);
// pad a few cells for safety so the wordmark never wraps into the gutter.
export const WORDMARK_MIN_WIDTH = 125;
// VIDEO_COLS exactly. Below this width the ASCII video can't fit either, so we
// render nothing at all rather than something visually broken.
export const ASCII_MIN_WIDTH = 56;

type LayoutMode = "side" | "stack" | "ascii-only" | "empty";

// Pick layout mode based on current terminal width. Pi-TUI's TUI exposes
// `tui.terminal.columns` (see node_modules/@mariozechner/pi-tui/dist/terminal.d.ts);
// we accept that as an optional override. Otherwise we fall back to
// process.stdout.columns. If neither is available (non-TTY pipe etc.) we
// assume the terminal is wide enough and keep the side-by-side layout —
// 999 is just a sentinel that comfortably exceeds THRESHOLD.
function pickLayout(termCols?: number): LayoutMode {
	const cols = termCols ?? process.stdout.columns ?? 999;
	if (cols < ASCII_MIN_WIDTH) return "empty";
	if (cols < WORDMARK_MIN_WIDTH) return "ascii-only";
	if (cols < SIDE_BY_SIDE_THRESHOLD) return "stack";
	return "side";
}

// Blank rows prepended directly to the composed brand block so the wordmark
// doesn't hug the top of the terminal. Baked into the block content because
// pi-tui Text components measure their own height from non-empty content,
// so a leading "\n\n" Text padder doesn't reliably reserve visible rows.
const TOP_PAD_LINES = 8;

// Pre-render every video frame as an array of `VIDEO_ROWS` chalk-coloured
// strings. Each cell is a single Unicode glyph painted with `chalk.hex(rgb)`
// — one truecolor escape per cell. We skip the chalk wrapper for cells that
// are both a literal space AND fully black (invisible anyway), keeping the
// pre-rendered string size sane while remaining visually identical.
//
// Doing this once at module load means animation ticks are just an array
// lookup + setText — no per-tick chalk allocation.
//
// Iteration is codepoint-aware via Array.from(chars) so multi-byte glyphs
// (Braille, box-drawing, etc.) aren't split between their UTF-16 surrogate
// halves. Source frames carry exactly VIDEO_COLS * VIDEO_ROWS codepoints and
// VIDEO_COLS * VIDEO_ROWS * 3 RGB bytes (validated at generation time).
const PRE_RENDERED_FRAMES: string[][] = VIDEO_FRAMES.map(({ chars, rgb }) => {
	const buf = Buffer.from(rgb, "base64");
	const cps = Array.from(chars);
	const rows: string[] = [];
	for (let y = 0; y < VIDEO_ROWS; y++) {
		let line = "";
		for (let x = 0; x < VIDEO_COLS; x++) {
			const i = y * VIDEO_COLS + x;
			const ch = cps[i] ?? " ";
			const r = buf[i * 3] ?? 0;
			const g = buf[i * 3 + 1] ?? 0;
			const b = buf[i * 3 + 2] ?? 0;
			if (ch === " " && r === 0 && g === 0 && b === 0) {
				line += " ";
			} else {
				const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
				line += chalk.hex(hex)(ch);
			}
		}
		rows.push(line);
	}
	return rows;
});

// Visible width of an arbitrary string after stripping ANSI colour escapes.
// Used to right-pad the tagline row so its leftColumn entry matches the
// wordmark rows in width, keeping the ASCII video aligned on every row.
//
// Cell-aware: fullwidth / wide characters (e.g. those produced by toFullwidth,
// CJK ideographs, the ideographic space U+3000) render as TWO terminal cells
// each but count as ONE codepoint in JavaScript. Counting visual cells — not
// codepoints — keeps the tagline row's width matched to the wordmark rows so
// the ASCII video doesn't shift right on the tagline row.
function visibleWidth(s: string): number {
	// Strip ANSI escapes first.
	const stripped = s.replace(/\[[0-9;]*m/g, "");
	// Count visual cells: fullwidth / wide characters take 2 cells, the rest 1.
	// We approximate "wide" via the common East Asian Width / Halfwidth-Fullwidth
	// ranges that toFullwidth produces, plus CJK ideographs and the
	// ideographic space U+3000 used for fullwidth spaces.
	let cells = 0;
	for (const ch of stripped) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		const wide =
			cp === 0x3000 || // ideographic space
			(cp >= 0xff01 && cp <= 0xff60) || // fullwidth ASCII variants
			(cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
			(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
			(cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals/Symbols
			(cp >= 0x3041 && cp <= 0x33ff) || // Kana, Bopomofo, CJK Compat
			(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
			(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
			(cp >= 0xa000 && cp <= 0xa4cf) || // Yi
			(cp >= 0xac00 && cp <= 0xd7a3); // Hangul Syllables
		cells += wide ? 2 : 1;
	}
	return cells;
}

// Cell-aware visible width of one wordmark row. Used to pad the left column
// with blank space once the wordmark runs out so the ASCII video on the right
// doesn't shift left in those rows. The current cfonts `block` output is all
// ASCII + box-drawing (1-cell glyphs), so the value here matches raw .length —
// using visibleWidth() just adds robustness if the wordmark ever changes.
const WORDMARK_WIDTH = COLORED_WORDMARK_ROWS[0] ? visibleWidth(COLORED_WORDMARK_ROWS[0]) : 0;

// Build the LEFT COLUMN once at module load: wordmark rows, then a vertical
// gap, then the indented tagline. This mirrors the OpenTUI layout in
// asciify-engine/tui-demo/brand.tsx where the Wordmark component is a column
// of [wordmark rows][marginTop gap][indented tagline] sitting beside the
// ASCII video. Total = 12 wordmark rows + 2 blank rows + 1 tagline row = 15.
// Every row in leftColumn must be padded to EFFECTIVE_WORDMARK_WIDTH visible
// cells so composeFrame's `leftPart + GAP + videoRow` keeps the video at the
// same screen column on every row (otherwise the tagline row, whose visible
// width is less than the wordmark width, would let the video shift left
// there). Each row gets WORDMARK_INDENT spaces prepended to shift the whole
// left column right by that many cells; the ASCII video on the right shifts
// in lockstep because every row carries the same prefix.
// Math.max(0, …) means we never truncate if the tagline ever happens to
// exceed EFFECTIVE_WORDMARK_WIDTH — we just skip the padding in that case.
const EFFECTIVE_WORDMARK_WIDTH = WORDMARK_INDENT + WORDMARK_WIDTH;
const taglineRow = `${" ".repeat(WORDMARK_INDENT)}${" ".repeat(TAGLINE_INDENT)}${TAGLINE}`;
const taglineVisibleLen = visibleWidth(taglineRow);
const taglinePadding = Math.max(0, EFFECTIVE_WORDMARK_WIDTH - taglineVisibleLen);
const leftColumn: string[] = [
	...Array.from({ length: TOP_PAD_LINES }, () => " ".repeat(EFFECTIVE_WORDMARK_WIDTH)),
	...COLORED_WORDMARK_ROWS.map((row) => `${" ".repeat(WORDMARK_INDENT)}${row}`),
	...Array(TAGLINE_TOP_GAP).fill(" ".repeat(EFFECTIVE_WORDMARK_WIDTH)),
	`${taglineRow}${" ".repeat(taglinePadding)}`,
];

// Compose one complete brand block (wordmark || video) for a given frame
// index. Returns the multiline string ready to drop into a single Text
// component — keeping it a single component lets Pi-TUI redraw it atomically
// with no row-tearing during animation.
//
// Layout adapts to terminal width via pickLayout():
//   - "side":  wordmark column LEFT + GAP + video rows RIGHT, paired row-by-row.
//   - "stack": wordmark column on top, blank separator row, then video rows
//              indented with WORDMARK_INDENT so the video lines up flush-left
//              with the wordmark column instead of hugging column 0.
function composeFrame(frameIdx: number, termCols?: number): string {
	const videoRows = PRE_RENDERED_FRAMES[frameIdx] ?? PRE_RENDERED_FRAMES[0] ?? [];
	const mode = pickLayout(termCols);
	if (mode === "empty") {
		return "";
	}
	if (mode === "ascii-only") {
		const videoIndent = " ".repeat(WORDMARK_INDENT);
		const lines: string[] = [];
		for (let i = 0; i < TOP_PAD_LINES; i++) lines.push("");
		for (const row of videoRows) lines.push(`${videoIndent}${row}`);
		return lines.join("\n");
	}
	if (mode === "stack") {
		const videoIndent = " ".repeat(WORDMARK_INDENT);
		const lines: string[] = [];
		for (const row of leftColumn) lines.push(row);
		lines.push("");
		for (const row of videoRows) lines.push(`${videoIndent}${row}`);
		return lines.join("\n");
	}
	const totalRows = Math.max(leftColumn.length, VIDEO_ROWS);
	const wordmarkBlankPad = " ".repeat(EFFECTIVE_WORDMARK_WIDTH);
	const videoBlankPad = " ".repeat(VIDEO_COLS);
	const lines: string[] = [];
	for (let r = 0; r < totalRows; r++) {
		const leftPart = leftColumn[r] ?? wordmarkBlankPad;
		const rightPart = videoRows[r] ?? videoBlankPad;
		lines.push(`${leftPart}${GAP}${rightPart}`);
	}
	return lines.join("\n");
}

/**
 * Render the wordmark + video clip + tagline. By default spawns a setInterval
 * that drives the animation; the frame index wraps via modulo so the clip
 * loops continuously for the rest of the session. Pass `{ animate: false }` to
 * render a single still frame (the last frame, which is the intended "hold"
 * state) and skip the interval entirely — used by the chat surface where the
 * looping clip would compete with the conversation for attention.
 *
 * Returns the components added to the TUI (caller can use these to remove or
 * inspect them).
 */
export function renderBrandHeader(tui: TUI, opts: { animate?: boolean } = {}): Component[] {
	const animate = opts.animate ?? true;
	const components: Component[] = [];

	// Pi-TUI's TUI exposes the underlying Terminal which has a `columns` getter
	// (see node_modules/@mariozechner/pi-tui/dist/terminal.d.ts). Prefer that
	// over process.stdout.columns since it's the value pi-tui itself uses for
	// rendering, but pickLayout falls back if either is unavailable.
	const getCols = (): number | undefined => tui.terminal?.columns ?? process.stdout.columns;

	// Static-mode start frame is the LAST frame — the artist's intended resting
	// pose (see header docstring "the last frame holds"). Animated mode starts
	// at frame 0 and advances from there.
	const initialFrameIdx = animate ? 0 : VIDEO_FRAME_COUNT - 1;

	const padTop = new Text("\n\n", 0, 0);
	tui.addChild(padTop);
	components.push(padTop);

	const block = new Text(composeFrame(initialFrameIdx, getCols()), 0, 0);
	tui.addChild(block);
	components.push(block);

	const padBottom = new Text("", 0, 0);
	tui.addChild(padBottom);
	components.push(padBottom);

	tui.requestRender();

	// --- Scrollback-friendly render scheduling ---------------------------------
	// pi-tui's differential renderer (see node_modules/@mariozechner/pi-tui/dist/tui.js
	// `doRender`, lines ~674-971) repaints animation frames by moving the
	// hardware cursor up with `\x1b[{n}A`, clearing each row with `\x1b[2K`, and
	// writing the new content. Windows Terminal (and other Conhost-derived
	// emulators) treat any write that targets the bottom region of the buffer
	// as "active output" and snap the viewport to the cursor — fighting the
	// user's scrollback. Two complementary mitigations:
	//
	// 1. Skip the call entirely when the composed frame is byte-identical to
	//    what we already pushed (e.g. when terminal width hasn't changed and
	//    the layout produced the same string for an empty/clamped layout).
	//    This avoids a no-op render that still emits cursor-move bytes.
	//
	// 2. Wrap each tui.requestRender() in DEC mode 2026 (synchronized output
	//    begin/end) AND VT100 save/restore-cursor (`\x1b[s` / `\x1b[u`). pi-tui
	//    already opens 2026 inside doRender, but it does so AROUND its cursor
	//    moves; wrapping at the outer scope means Windows Terminal sees the
	//    full repaint as one atomic frame and won't auto-scroll the viewport
	//    to follow intermediate cursor moves. The save/restore pair is a
	//    belt-and-braces signal that the terminal can keep its viewport pinned
	//    where the user put it. Both sequences are cheap (≤8 bytes each) and
	//    are no-ops on terminals that don't honour them.
	//
	// References:
	//   - pi-tui differential renderer: node_modules/@mariozechner/pi-tui/dist/tui.js:674-971
	//   - Synchronized Output (DEC 2026): https://gitlab.com/gnachman/iterm2/-/wikis/synchronized-updates-spec
	//   - Cursor save/restore (DECSC / DECRC, ANSI \x1b[s/\x1b[u): VT100 spec
	const SYNC_BEGIN = "\x1b[?2026h\x1b[s"; // begin sync + save cursor
	const SYNC_END = "\x1b[u\x1b[?2026l"; // restore cursor + end sync
	let lastFrameStr: string | undefined;
	const safeRender = (next: string): void => {
		if (next === lastFrameStr) {
			// No visible change — don't re-emit cursor-move bytes that would
			// make the terminal re-anchor the viewport.
			return;
		}
		lastFrameStr = next;
		block.setText(next);
		try {
			process.stdout.write(SYNC_BEGIN);
			tui.requestRender();
		} finally {
			process.stdout.write(SYNC_END);
		}
	};

	// Drive the animation. The interval fires every 1000/VIDEO_FPS ms and the
	// frame index wraps via modulo so the clip loops continuously for the rest
	// of the session — no early-exit clearInterval. We refetch the terminal
	// width on every tick so resizes are reflected within ~1/VIDEO_FPS s
	// even if the dedicated resize listener below misses for some reason.
	//
	// In static mode (animate: false) we skip the setInterval entirely — the
	// initial composeFrame(initialFrameIdx) above already painted the still
	// frame, so there's nothing to drive. The resize handler still runs so the
	// still frame re-lays-out (side / stack / ascii-only / empty) on resize.
	let frameIdx = initialFrameIdx;
	if (animate) {
		const tickMs = Math.max(1, Math.round(1000 / VIDEO_FPS));
		const timer: NodeJS.Timeout = setInterval(() => {
			frameIdx = (frameIdx + 1) % VIDEO_FRAME_COUNT;
			safeRender(composeFrame(frameIdx, getCols()));
		}, tickMs);
		// Don't keep the event loop alive just for this animation — once the user
		// quits, the process should be free to exit even if the timer hasn't yet
		// reached the final frame.
		timer.unref?.();
	}

	// Re-compose the brand block on terminal resize so the responsive layout
	// (side / stack / ascii-only / empty) keeps working as the animation
	// loops forever. During the animation the safeRender identical-frame
	// cache makes this a no-op when the layout didn't actually change. In
	// static mode this is the only thing that ever re-renders the block.
	const onResize = () => {
		safeRender(composeFrame(frameIdx, getCols()));
	};
	process.stdout.on("resize", onResize);

	return components;
}
