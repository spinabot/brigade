/**
 * Terminal input sanitizer — scrub hostile/garbled control bytes from user input
 * BEFORE it reaches the transcript, the model payload, or the terminal echo.
 *
 * Two threats this closes:
 *  - TERMINAL-ESCAPE INJECTION: pasted text (or text the agent is told to copy
 *    from a malicious page) can carry ANSI escape sequences — cursor moves, OSC
 *    title/clipboard sets, screen clears — that corrupt the operator's terminal
 *    when echoed, and pollute the transcript/model payload. ESC (0x1B) never
 *    legitimately appears in typed prose, so stripping all escape sequences is
 *    safe and high-value.
 *  - LEAKED BRACKETED-PASTE markers: when a terminal's bracketed-paste parse
 *    tears (SSH glitch, sleep/wake, multiplexer tab switch), the ESC[200~ /
 *    ESC[201~ wrappers — and degraded ^[[200~ / [200~ fragments — leak as
 *    literal text into the buffer. And lone UTF-16 surrogates (from rich-text
 *    clipboard paste) crash JSON serialization in some provider SDKs.
 *
 * Pure + deterministic. Outbound message surrogate-sanitization already exists
 * (`sanitize-surrogates.ts`); this is the INPUT-side complement the TUI lacked.
 */

// CSI sequences: ESC [ <params> <intermediates> <final 0x40-0x7E>. Covers
// cursor-position reports (DSR/CPR ESC[…R), SGR mouse reports (ESC[<…M/m),
// device attributes, screen clears, AND the bracketed-paste markers ESC[200~ /
// ESC[201~ (~ is a valid final byte).
const CSI_SEQUENCE = /\x1b\[[0-9;?<>=!"']*[ -\/]*[@-~]/g;
// OSC sequences: ESC ] … (BEL | ST). These set window title / clipboard (OSC 52!)
// and must never ride in from pasted text.
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Degraded bracketed-paste markers that arrive as LITERAL text (ESC already lost).
// Boundary-anchored so we don't eat prose/code that merely embeds the digits —
// e.g. "200~300", "x[200~210]", "list[201~]end" stay intact. The OPEN marker
// ([200~ / ^[[200~) is stripped only at start-of-string or after whitespace/
// bracket/quote; the CLOSE marker ([201~ / ^[[201~) only at end-of-string or
// before whitespace. The canonical ESC-wrapped form stays owned by CSI_SEQUENCE.
const LEAKED_PASTE_OPEN = /(^|[\s\[\]"'`(){}])\^?\[\[?200~/g;
const LEAKED_PASTE_CLOSE = /\^?\[\[?201~(?=$|\s)/g;
// Caret-notation forms of the cursor/mouse reports CSI_SEQUENCE catches, for the
// SAME defense-in-depth reason the leaked-paste caret form is stripped: a torn
// terminal can surface CPR/DSR (^[[<row>;<col>R) and SGR mouse (^[[<…M/m) as
// literal caret text. Numeric-anchored so ordinary prose like "^[[0m" is left be.
const CARET_CPR = /\^\[\[\d+;\d+R/g;
const CARET_SGR_MOUSE = /\^\[\[<\d+;\d+;\d+[Mm]/g;

/** Replace a lone UTF-16 surrogate (not part of a valid pair) with U+FFFD. */
function replaceLoneSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/**
 * Strip terminal control bytes + leaked paste markers + lone surrogates from a
 * line of user input. Returns the cleaned text (idempotent). Leaves all ordinary
 * printable text — including newlines, tabs, emoji, and CJK — untouched.
 */
export function sanitizeTerminalInput(text: string): string {
	if (!text) return text;
	let out = text.replace(CSI_SEQUENCE, "").replace(OSC_SEQUENCE, "");
	out = out.replace(LEAKED_PASTE_OPEN, "$1").replace(LEAKED_PASTE_CLOSE, "");
	// Caret-notation leaks (CPR/DSR + SGR mouse) — consistency with the leaked
	// paste caret handling above; applied before the lone-ESC strip below.
	out = out.replace(CARET_CPR, "").replace(CARET_SGR_MOUSE, "");
	// Any malformed/standalone ESC bytes left after sequence removal.
	out = out.replace(/\x1b/g, "");
	out = replaceLoneSurrogates(out);
	return out;
}

/** True if `text` carries anything `sanitizeTerminalInput` would strip — lets a
 *  caller log/flag a hostile paste without recomputing. */
export function hasTerminalControlBytes(text: string): boolean {
	return text !== sanitizeTerminalInput(text);
}
