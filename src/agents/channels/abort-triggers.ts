/**
 * Detect when an inbound message is asking the agent to STOP an in-flight turn.
 *
 * Recognized triggers (case-insensitive, word-boundary anchored so "stopwatch"
 * doesn't match):
 *   - English: `stop`, `cancel`, `abort`, `halt`, `wait`
 *   - Slash-prefixed: `/stop`, `/cancel`, `/abort`
 *   - Common in international DMs: `parar`/`detener` (Spanish), `arrête`
 *     (French), `stopp` (German/Norwegian/Swedish), `रुको` (Hindi), `止まれ`
 *     (Japanese), `停止` (Chinese)
 *
 * The text must be SHORT (≤24 chars after trim) — a long paragraph that
 * happens to contain "stop" elsewhere isn't a cancel request.
 */

const SHORT_LIMIT = 24;

// Single-word triggers; checked case-insensitively + word-boundary anchored.
const WORD_TRIGGERS = [
	"stop",
	"cancel",
	"abort",
	"halt",
	"wait",
	"parar",
	"detener",
	"alto",
	"arrete",
	"arrêt",
	"arrête",
	"stopp",
	"stoppen",
	"para",
	"basta",
];

// Pre-compile a single anchored regex: `^(?:trigger1|trigger2|...)[!.?]*$`
const TRIGGER_RE = new RegExp(
	`^/?(?:${WORD_TRIGGERS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[!.?]*$`,
	"i",
);

// Non-Latin literals matched as substrings of a short message (no word boundary
// concept for CJK / Devanagari).
const NON_LATIN_TRIGGERS = ["रुको", "止まれ", "停止", "やめて"];

/** True when this looks like a "please stop the current turn" message. */
export function isAbortTrigger(rawText: string): boolean {
	const text = rawText.trim();
	if (!text || text.length > SHORT_LIMIT) return false;
	if (TRIGGER_RE.test(text)) return true;
	for (const t of NON_LATIN_TRIGGERS) {
		if (text.includes(t)) return true;
	}
	return false;
}
