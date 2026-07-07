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
 * The video is a VIDEO_COLS × VIDEO_ROWS × VIDEO_FRAME_COUNT char-based ASCII
 * clip baked at module-build time (see scripts/gen-brand-frames-cli.mjs and
 * brand-frames-cli.ts). Each cell carries a unicode codepoint and an RGB
 * colour; we paint cells with `chalk.hex(toHex(r,g,b))(char)`, plus a
 * skip-on-space-and-black optimisation that emits a literal space (no chalk
 * wrapper) for empty/black cells so the rendered string size stays sane while
 * remaining visually identical.
 *
 * Playback policy: the clip plays ONCE per process (VIDEO_FPS ticks), then
 * the last frame holds forever — and it plays at all only on terminals the
 * animation gate (./animations.ts) recognises as smooth. Everywhere else the
 * header is the static last frame, which is always correct and never janky.
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

import { type Component, type TUI, Text } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { terminalAnimationsEnabled } from "./animations.js";
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
// per-row colour mapping if we kept them. The BASE rows (unscaled, ~59 cells
// wide × 6 rows) are kept for the small-screen wordmark; the display rows are
// then pixel-doubled (nearest-neighbour) by WORDMARK_SCALE in both axes —
// codepoint-aware via Array.from so multi-byte box-drawing glyphs
// ('╗','║','═','╔','╚','╝') aren't split between their UTF-16 surrogate
// halves.
const STRIPPED_BASE_ROWS = RAW_ART.replace(/\x1b\[[0-9;]*m/g, "")
	.split("\n")
	.filter((row) => row.trim().length > 0);

const STRIPPED_ROWS = STRIPPED_BASE_ROWS.flatMap((row) => {
	const widened = Array.from(row)
		.flatMap((ch) => Array.from({ length: WORDMARK_SCALE }, () => ch))
		.join("");
	return Array.from({ length: WORDMARK_SCALE }, () => widened);
});

const COLORED_WORDMARK_ROWS: string[] = STRIPPED_ROWS.map((row, idx) =>
	chalk.hex(colorForRow(idx, STRIPPED_ROWS.length))(row),
);

// Unscaled variant for small terminals (~59×6 instead of ~118×12) — same
// 4-stop metallic gradient, distributed over the 6 base rows.
const COLORED_WORDMARK_ROWS_SMALL: string[] = STRIPPED_BASE_ROWS.map((row, idx) =>
	chalk.hex(colorForRow(idx, STRIPPED_BASE_ROWS.length))(row),
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

const TAGLINE = chalk.hex(BRIGADE_HIGHLIGHT)(toFullwidth("🦁  your personal AI crew  ·  by spinabot"));

// Compact taglines for the small-screen modes. The fullwidth TAGLINE above is
// ~80 visible cells (fullwidth glyphs are 2 cells each) — far too wide for an
// 80-col terminal — so the small wordmark gets a plain-text version, and the
// one-line mark inlines its own.
const TAGLINE_SMALL = chalk.hex(BRIGADE_HIGHLIGHT)("🦁  your personal AI crew · by spinabot");

// One-line brand mark for tiny terminals (SSH from a phone, split panes,
// quake-style dropdowns). Two widths: with and without the tagline.
const LINE_MARK_FULL = `🦁 ${chalk.hex(BRIGADE_GOLD).bold("BRIGADE")} ${chalk.hex(BRIGADE_HIGHLIGHT)("· your personal AI crew")}`;
const LINE_MARK_MIN = `🦁 ${chalk.hex(BRIGADE_GOLD).bold("BRIGADE")}`;

// Three spaces between the video block and the wordmark. The video is now
// 56 cells wide (the char-based render) and the wordmark is ~146 cells once
// pixel-doubled, so the whole composite is ~205 cols wide and requires a
// wide terminal — that's expected for the brand splash.
const GAP = " ".repeat(25);

// ─────────────────────────── responsive layout ladder ───────────────────────────
// The brand header adapts to BOTH terminal dimensions. Width decides which
// marks physically fit; height decides how much vertical budget the header
// may spend — the header must never be taller than the screen, and must
// always leave room for the actual content (prompts, chat) below it.
//
// Height gates are load-bearing, not cosmetic: Pi-TUI repaints the animation
// by rewriting the block's rows in place. If the block overflows the
// viewport, parts of it live in scrollback and every frame degenerates into
// a full clear-and-redraw — a violent strobe on small windows (a stock
// 80×24 macOS Terminal, IDE panes, split panes). The ladder guarantees the
// video only ever plays when it fits WITH margin, and that every smaller
// size still gets a deliberately designed mark, down to a one-liner.

// Minimum terminal width (in cells) for the side-by-side layout. The math:
//   EFFECTIVE_WORDMARK_WIDTH (4 + 118 = 122)
// + GAP.length              (25)
// + VIDEO_COLS              (56)
// = 203 cells exactly, plus ~7 cells of breathing room.
export const SIDE_BY_SIDE_THRESHOLD = 210;
// Scaled wordmark column ~122 cells (WORDMARK_INDENT + WORDMARK_WIDTH) + safety.
export const WORDMARK_MIN_WIDTH = 125;
// VIDEO_COLS + the WORDMARK_INDENT the ascii-only layout prepends + margin —
// below this the indented video would wrap and shred the block.
export const ASCII_MIN_WIDTH = 62;
// One-line mark: "🦁 BRIGADE" ≈ 10 visible cells + margin.
export const LINE_MIN_WIDTH = 12;

// Vertical budgets. Video modes need the 30-row clip + padding + ~12 rows for
// the content below the header; the wordmark modes are budgeted the same way
// (mark height + padding + room to actually use the app).
export const VIDEO_MODE_MIN_ROWS = 44; //  2 pad + 30 video + content room
export const STACK_MIN_ROWS = 66; //       23 wordmark col + 30 video + content room
export const WORDMARK_MIN_ROWS = 28; //     2 pad + 12 rows + tagline + content room
export const WORDMARK_SMALL_MIN_ROWS = 16; // 2 pad + 6 rows + tagline + content room
export const LINE_MIN_ROWS = 4;

export type LayoutMode = "side" | "stack" | "ascii-only" | "wordmark" | "wordmark-small" | "line" | "empty";

/** Layout modes that include the animated video clip. */
export function layoutShowsVideo(mode: LayoutMode): boolean {
	return mode === "side" || mode === "stack" || mode === "ascii-only";
}

// Pick the layout for the current terminal size. Pi-TUI's TUI exposes the
// live `tui.terminal.columns/rows`; we accept those as optional overrides
// and fall back to process.stdout. If neither is available (non-TTY pipe)
// we assume a large surface — 999 comfortably exceeds every threshold.
//
// First match wins, preferring the richest mark that fits: the full video
// experience on big surfaces, the wordmark family on short-but-wide windows,
// the one-liner on tiny ones.
export function pickLayout(termCols?: number, termRows?: number): LayoutMode {
	const cols = termCols ?? process.stdout.columns ?? 999;
	const rows = termRows ?? process.stdout.rows ?? 999;
	if (cols >= SIDE_BY_SIDE_THRESHOLD && rows >= VIDEO_MODE_MIN_ROWS) return "side";
	if (cols >= WORDMARK_MIN_WIDTH && rows >= STACK_MIN_ROWS) return "stack";
	if (cols >= ASCII_MIN_WIDTH && rows >= VIDEO_MODE_MIN_ROWS) return "ascii-only";
	if (cols >= WORDMARK_MIN_WIDTH && rows >= WORDMARK_MIN_ROWS) return "wordmark";
	if (cols >= WORDMARK_SMALL_MIN_WIDTH && rows >= WORDMARK_SMALL_MIN_ROWS) return "wordmark-small";
	if (cols >= LINE_MIN_WIDTH && rows >= LINE_MIN_ROWS) return "line";
	return "empty";
}

// Blank rows prepended directly to the composed brand block so the wordmark
// doesn't hug the top of the terminal. Baked into the block content because
// pi-tui Text components measure their own height from non-empty content,
// so a leading "\n\n" Text padder doesn't reliably reserve visible rows.
const TOP_PAD_LINES = 8;

// Render one video frame as an array of `VIDEO_ROWS` chalk-coloured strings,
// LAZILY and memoized per frame index. Each cell is a single Unicode glyph
// painted with `chalk.hex(rgb)` — one truecolor escape per cell. We skip the
// chalk wrapper for cells that are both a literal space AND fully black
// (invisible anyway), keeping the rendered string size sane while remaining
// visually identical.
//
// Lazy matters: rendering ALL frames eagerly at module load (the previous
// approach) burned VIDEO_FRAME_COUNT × VIDEO_ROWS × VIDEO_COLS chalk calls
// (~400k) before any UI painted — a visible multi-second startup stall on
// EVERY surface that imports this module, including chat/connect which only
// ever show the single static hold frame. Rendering on demand keeps first
// paint instant (one frame ≈ 1.7k cells), and memoization makes any replay
// an array lookup.
//
// Iteration is codepoint-aware via Array.from(chars) so multi-byte glyphs
// (Braille, box-drawing, etc.) aren't split between their UTF-16 surrogate
// halves. Source frames carry exactly VIDEO_COLS * VIDEO_ROWS codepoints and
// VIDEO_COLS * VIDEO_ROWS * 3 RGB bytes (validated at generation time).
const FRAME_CACHE: (string[] | undefined)[] = new Array(VIDEO_FRAME_COUNT);

// chalk.hex(...) builds a fresh styler function on every call — ~1.7k of
// those per frame adds real work to each first-render tick. The clip is
// generated from a GIF, so its palette is bounded (≤256 colours globally):
// memoising styler-per-colour makes repeat cells a map hit instead of a
// styler allocation. Bounded by the palette, so the cache can't grow past
// a few hundred entries.
const STYLER_CACHE = new Map<string, (s: string) => string>();
function stylerFor(hex: string): (s: string) => string {
	let styler = STYLER_CACHE.get(hex);
	if (!styler) {
		styler = chalk.hex(hex);
		STYLER_CACHE.set(hex, styler);
	}
	return styler;
}

function getFrame(frameIdx: number): string[] {
	const cached = FRAME_CACHE[frameIdx];
	if (cached) return cached;
	const src = VIDEO_FRAMES[frameIdx] ?? VIDEO_FRAMES[0];
	if (!src) return [];
	const buf = Buffer.from(src.rgb, "base64");
	const cps = Array.from(src.chars);
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
				line += stylerFor(hex)(ch);
			}
		}
		rows.push(line);
	}
	FRAME_CACHE[frameIdx] = rows;
	return rows;
}

// Visible width of an arbitrary string after stripping ANSI colour escapes.
// Used to right-pad the tagline row so its leftColumn entry matches the
// wordmark rows in width, keeping the ASCII video aligned on every row.
//
// Cell-aware: fullwidth / wide characters (e.g. those produced by toFullwidth,
// CJK ideographs, the ideographic space U+3000) render as TWO terminal cells
// each but count as ONE codepoint in JavaScript. Counting visual cells — not
// codepoints — keeps the tagline row's width matched to the wordmark rows so
// the ASCII video doesn't shift right on the tagline row.
export function visibleWidth(s: string): number {
	// Strip ANSI escapes first.
	const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
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
			(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
			(cp >= 0x1f300 && cp <= 0x1faff) || // emoji (incl. the 🦁 mascot)
			(cp >= 0x2600 && cp <= 0x27bf); // misc symbols / dingbats
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

// Width the unscaled small wordmark needs: indent + glyph width (~59 cells)
// + a safety cell. Exported so the layout tests can pin the ladder against
// the real cfonts output instead of a hard-coded guess. (Referenced by
// pickLayout above — safe, module consts are initialised long before any
// render call.)
export const WORDMARK_SMALL_MIN_WIDTH =
	WORDMARK_INDENT + (COLORED_WORDMARK_ROWS_SMALL[0] ? visibleWidth(COLORED_WORDMARK_ROWS_SMALL[0]) : 0) + 1;

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

// Compose one complete brand block for a given frame index. Returns the
// multiline string ready to drop into a single Text component — keeping it a
// single component lets Pi-TUI redraw it atomically with no row-tearing
// during animation.
//
// Layout adapts to terminal size via pickLayout() (see the ladder above):
//   - "side":           wordmark column LEFT + GAP + video rows RIGHT, paired row-by-row.
//   - "stack":          wordmark column on top, blank separator, then the video.
//   - "ascii-only":     the video alone (narrow but tall windows).
//   - "wordmark":       the full 12-row wordmark + tagline, no video (wide, short).
//   - "wordmark-small": the unscaled 6-row wordmark + plain tagline (a stock
//                       80×24 terminal lands here).
//   - "line":           a one-line mark for tiny panes.
//
// The video frame is rendered ONLY when the chosen mode shows it — on small
// terminals no frame is ever built, so the 2.5 MB frame data stays untouched
// (getFrame is lazy) and the header costs a handful of short strings.
//
// Exported for the layout tests: they assert the composed block's height
// against the ladder's row budgets so no future tweak can overflow a small
// screen again.
export function composeFrame(frameIdx: number, termCols?: number, termRows?: number): string {
	const mode = pickLayout(termCols, termRows);
	if (mode === "empty") {
		return "";
	}
	if (mode === "line") {
		const cols = termCols ?? process.stdout.columns ?? 999;
		const mark = cols >= 40 ? LINE_MARK_FULL : LINE_MARK_MIN;
		return `\n  ${mark}`;
	}
	if (mode === "wordmark-small") {
		const indent = " ".repeat(WORDMARK_INDENT);
		const lines: string[] = ["", ""];
		for (const row of COLORED_WORDMARK_ROWS_SMALL) lines.push(`${indent}${row}`);
		lines.push("");
		lines.push(`${indent}${TAGLINE_SMALL}`);
		return lines.join("\n");
	}
	if (mode === "wordmark") {
		const indent = " ".repeat(WORDMARK_INDENT);
		const lines: string[] = ["", ""];
		for (const row of COLORED_WORDMARK_ROWS) lines.push(`${indent}${row}`);
		lines.push("");
		lines.push(taglineRow);
		return lines.join("\n");
	}
	const videoRows = getFrame(frameIdx);
	if (mode === "ascii-only") {
		// Slimmer top pad than the side/stack layouts — this mode exists for
		// narrow windows where vertical space is the scarce resource.
		const videoIndent = " ".repeat(WORDMARK_INDENT);
		const lines: string[] = ["", ""];
		for (const row of videoRows) lines.push(`${videoIndent}${row}`);
		// The brand TEXT must read at every size, not only in the wide
		// layouts — lock up the small wordmark + tagline under the clip
		// whenever the width allows it (movie-title-card arrangement). The
		// 62–63-col sliver below WORDMARK_SMALL_MIN_WIDTH shows the clip
		// alone rather than a wrapped, shredded wordmark.
		const cols = termCols ?? process.stdout.columns ?? 999;
		if (cols >= WORDMARK_SMALL_MIN_WIDTH) {
			lines.push("");
			for (const row of COLORED_WORDMARK_ROWS_SMALL) lines.push(`${videoIndent}${row}`);
			lines.push("");
			lines.push(`${videoIndent}${TAGLINE_SMALL}`);
		}
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

// Only ONE brand header is ever on screen at a time — each renderScreen()
// rebuilds the whole screen. Track the live header's timer + resize listener at
// module scope so a re-render tears down the PRIOR one. Without this, onboarding
// (which calls renderBrandHeader once per step) accumulates an animation
// interval AND a process.stdout "resize" listener on every step → a
// MaxListenersExceededWarning plus several independent animation loops fighting
// over the brand row.
let liveHeaderTimer: NodeJS.Timeout | undefined;
let liveHeaderOnResize: (() => void) | undefined;
// The intro clip plays at most ONCE per process. Surfaces that rebuild the
// screen per step (onboarding calls renderBrandHeader once per step) get the
// animated intro on their first screen only; every later render holds the
// static last frame instantly.
let clipPlayedThisProcess = false;

/**
 * Render the wordmark + video clip + tagline. By default plays the clip ONCE
 * (a setInterval at VIDEO_FPS advances the frames), then holds the last frame
 * and retires the interval — no perpetual repaint load. The clip also plays
 * at most once per PROCESS: surfaces that re-render the header per step
 * (onboarding) get the animated intro on their first screen and the instant
 * static hold frame on every later one.
 *
 * Animation is additionally gated by terminalAnimationsEnabled() — terminals
 * that can't repaint smoothly (no DEC 2026 synchronized output: legacy
 * conhost/cmd, classic xterm, SSH sessions, …) always get the static hold
 * frame; on slow consoles the frame writes back the event loop up until the
 * whole app reads as hung and shaking. Pass `{ animate: false }` to force the
 * still frame regardless — used by the chat surface where even a one-shot
 * clip would compete with the conversation for attention.
 *
 * Returns the components added to the TUI (caller can use these to remove or
 * inspect them).
 */
export function renderBrandHeader(tui: TUI, opts: { animate?: boolean } = {}): Component[] {
	const components: Component[] = [];

	// Tear down the previous header's timer + resize listener before installing
	// this one, so repeated renders can't accumulate either.
	if (liveHeaderTimer) {
		clearInterval(liveHeaderTimer);
		liveHeaderTimer = undefined;
	}
	if (liveHeaderOnResize) {
		process.stdout.removeListener("resize", liveHeaderOnResize);
		liveHeaderOnResize = undefined;
	}

	// Pi-TUI's TUI exposes the underlying Terminal with live `columns` / `rows`
	// getters (see node_modules/@earendil-works/pi-tui/dist/terminal.d.ts).
	// Prefer those over process.stdout since they're the values pi-tui itself
	// renders with; pickLayout falls back if either is unavailable.
	const getCols = (): number | undefined => tui.terminal?.columns ?? process.stdout.columns;
	const getRows = (): number | undefined => tui.terminal?.rows ?? process.stdout.rows;

	// Animate only when (a) the caller wants it, (b) the clip hasn't already
	// played this process, (c) the terminal proved it repaints smoothly
	// (env allowlist OR a positive DECRQM 2026 probe — see animations.ts),
	// and (d) the CURRENT layout actually shows the video — on a small window
	// there are no frames to play, only a static mark, so spinning up the
	// interval would be pure waste.
	const animate =
		(opts.animate ?? true) &&
		!clipPlayedThisProcess &&
		terminalAnimationsEnabled() &&
		layoutShowsVideo(pickLayout(getCols(), getRows()));

	// Static mode (chat/connect) holds the LAST frame — the clip's resting pose.
	// Animated mode starts at frame 0 and advances from there.
	const initialFrameIdx = animate ? 0 : VIDEO_FRAME_COUNT - 1;

	const padTop = new Text("\n\n", 0, 0);
	tui.addChild(padTop);
	components.push(padTop);

	const block = new Text(composeFrame(initialFrameIdx, getCols(), getRows()), 0, 0);
	tui.addChild(block);
	components.push(block);

	const padBottom = new Text("", 0, 0);
	tui.addChild(padBottom);
	components.push(padBottom);

	tui.requestRender();

	// --- Scrollback-friendly render scheduling ---------------------------------
	// Two rules keep animation repaints clean:
	//
	// 1. Skip the call entirely when the composed frame is byte-identical to
	//    what we already pushed (resize to an unchanged layout, backpressure
	//    catch-up landing on the same frame). A no-op render would still emit
	//    cursor-move bytes that make some terminals re-anchor the viewport.
	//
	// 2. Never write to stdout from the animation timer. The timer only
	//    mutates component state and calls tui.requestRender(); pi-tui
	//    coalesces requests (min 16 ms between paints), builds each frame as
	//    ONE buffer, and brackets that single write in DEC 2026 synchronized
	//    output itself (node_modules/@earendil-works/pi-tui/dist/tui.js,
	//    doRender). Terminals that can't repaint atomically never reach this
	//    code at all — the animation gate (./animations.ts) holds them on the
	//    static frame. (An earlier revision wrote its own 2026 + save/restore
	//    -cursor brackets around requestRender here; requestRender only
	//    SCHEDULES the paint for a later tick, so those bytes bracketed
	//    nothing and are gone.)
	let lastFrameStr: string | undefined;
	const safeRender = (next: string): void => {
		if (next === lastFrameStr) {
			// No visible change — nothing to schedule.
			return;
		}
		lastFrameStr = next;
		block.setText(next);
		tui.requestRender();
	};

	// Drive the animation. The interval fires every 1000/VIDEO_FPS ms and
	// advances the frame index until the clip's LAST frame, then retires
	// itself — the last frame is the designed hold pose, so a finished clip
	// and a static header are pixel-identical. We refetch the terminal width
	// on every tick so resizes are reflected within ~1/VIDEO_FPS s even if
	// the dedicated resize listener below misses for some reason.
	//
	// Backpressure guard, two tiers (thresholds per Node's stream semantics:
	// on Windows TTYs writes queue in JS and `writableLength` grows when the
	// console can't drain — the default high-water mark there is only 16 KiB;
	// on POSIX TTYs writes are synchronous so writableLength stays ~0 and the
	// checks are inert-but-free):
	//
	//   1. DROP  — any queued bytes mean the previous frame hasn't left Node
	//      yet; painting another on top only deepens the backlog. Advance the
	//      frame index (shortening the clip) but skip the write, so a slow
	//      terminal gets a choppier-but-responsive intro, never a wedge.
	//   2. ABORT — a backlog past ~4× the stream's high-water mark means the
	//      terminal is drowning; per the stream docs unbounded queueing ends
	//      in GC pressure and ballooning RSS. Jump to the hold frame and let
	//      the finish branch retire the interval.
	//
	// In static mode (animate false) we skip the setInterval entirely — the
	// initial composeFrame(initialFrameIdx) above already painted the still
	// frame, so there's nothing to drive. The resize handler still runs so the
	// still frame re-lays-out (side / stack / ascii-only / empty) on resize.
	const ABORT_BACKPRESSURE_BYTES = 4 * (process.stdout.writableHighWaterMark || 16 * 1024);
	let frameIdx = initialFrameIdx;
	if (animate) {
		const tickMs = Math.max(1, Math.round(1000 / VIDEO_FPS));
		const timer: NodeJS.Timeout = setInterval(() => {
			if (frameIdx >= VIDEO_FRAME_COUNT - 1) {
				// Clip finished. Make sure the hold pose is actually on screen
				// (intermediate frames may have been skipped under backpressure;
				// safeRender dedups if it already is), then retire the interval.
				safeRender(composeFrame(VIDEO_FRAME_COUNT - 1, getCols(), getRows()));
				clipPlayedThisProcess = true;
				clearInterval(timer);
				if (liveHeaderTimer === timer) liveHeaderTimer = undefined;
				return;
			}
			frameIdx += 1;
			const queued = process.stdout.writableLength ?? 0;
			if (queued > ABORT_BACKPRESSURE_BYTES) {
				// Terminal is drowning — end the show at the hold pose.
				frameIdx = VIDEO_FRAME_COUNT - 1;
				return;
			}
			if (queued > 0) return;
			safeRender(composeFrame(frameIdx, getCols(), getRows()));
		}, tickMs);
		// Don't keep the event loop alive just for this animation — once the user
		// quits, the process should be free to exit even if the timer hasn't yet
		// reached the final frame.
		timer.unref?.();
		liveHeaderTimer = timer;
	}

	// Re-compose the brand block on terminal resize so the responsive layout
	// (side / stack / ascii-only / empty) keeps working as the animation
	// loops forever. During the animation the safeRender identical-frame
	// cache makes this a no-op when the layout didn't actually change. In
	// static mode this is the only thing that ever re-renders the block.
	const onResize = () => {
		safeRender(composeFrame(frameIdx, getCols(), getRows()));
	};
	process.stdout.on("resize", onResize);
	liveHeaderOnResize = onResize;

	return components;
}
