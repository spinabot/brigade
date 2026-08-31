/**
 * Searching the conversation you are in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO "JUMP TO MESSAGE"
 * ─────────────────────────────────────────────────────────────────────────
 * Brigade's TUI does not own a scrollable viewport. It inserts widgets into the
 * terminal's own append-only scrollback above the editor, which is what lets
 * the transcript survive being scrolled with the mouse, copied, and piped —
 * and it is why the header had to be de-volatilised earlier.
 *
 * A harness that owns an alt-screen viewport can scroll it to a hit. Brigade
 * cannot: the scrollback belongs to the terminal, and there is no cursor
 * address for "eleven messages ago". Faking it by re-printing the whole
 * conversation would duplicate every message and destroy the real history.
 *
 * So search RENDERS THE MATCHES instead of navigating to them. That is not a
 * consolation prize — for the thing people actually search for ("what was that
 * path", "what did the error say"), showing the line beats scrolling to it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS SEARCHED
 * ─────────────────────────────────────────────────────────────────────────
 * Prose, tool names and arguments, and tool RESULTS — because "what was that
 * error" and "which file did it read" live in tool output, and a search that
 * skips it would miss the most common question. Thinking is excluded, matching
 * the export default: it is the model's scratch, not the conversation.
 */

import {
	blockText,
	isToolCall,
	PI_TOOL_RESULT,
	toolCallArguments,
	toolCallName,
} from "../agents/pi-dialect.js";
import type { WireMessage } from "../protocol.js";

export interface SearchHit {
	/** Index into the transcript, so the caller can show position. */
	index: number;
	role: string;
	/** Where in the message the match was found. */
	where: "text" | "tool-call" | "tool-result";
	/** Tool name, when `where` is a tool. */
	toolName?: string;
	/** One line of context around the match, already clipped. */
	snippet: string;
	/** Offsets of the match INSIDE `snippet`, for highlighting. */
	matchStart: number;
	matchEnd: number;
	timestamp?: number;
}

export interface SearchOptions {
	/** Treat the query as a regular expression. Invalid patterns fall back to literal. */
	regex?: boolean;
	/** Case-sensitive matching. Default false. */
	caseSensitive?: boolean;
	/** Cap on hits returned, so a common word cannot flood the scrollback. */
	limit?: number;
	/** Characters of context either side of the match. */
	contextChars?: number;
}

const DEFAULT_LIMIT = 40;
const DEFAULT_CONTEXT = 60;

/** Escape a literal query so it can go through the same regex path. */
function escapeLiteral(q: string): string {
	return q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the matcher.
 *
 * An invalid regex falls back to a literal search rather than throwing — the
 * operator typed a query, not a program, and `(` is a perfectly ordinary thing
 * to look for in a transcript full of code.
 */
export function buildMatcher(
	query: string,
	opts: SearchOptions = {},
): { re: RegExp; usedRegex: boolean } {
	const flags = opts.caseSensitive ? "g" : "gi";
	if (opts.regex) {
		try {
			return { re: new RegExp(query, flags), usedRegex: true };
		} catch {
			/* fall through to literal */
		}
	}
	return { re: new RegExp(escapeLiteral(query), flags), usedRegex: false };
}

/** Collapse to one line and clip around the match, keeping offsets accurate. */
function snippetAround(
	haystack: string,
	start: number,
	end: number,
	contextChars: number,
): { snippet: string; matchStart: number; matchEnd: number } {
	// Collapse whitespace FIRST would move the offsets, so clip on the raw text
	// and normalise only the window we keep.
	const from = Math.max(0, start - contextChars);
	const to = Math.min(haystack.length, end + contextChars);
	const raw = haystack.slice(from, to);
	// C0 bytes are stripped here, at the source. `\s` does not match ESC, so a
	// whitespace collapse alone leaves ANSI/OSC intact for whatever renders this.
	// eslint-disable-next-line no-control-regex
	const flat = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
	const before = flat(haystack.slice(from, start));
	const match = flat(haystack.slice(start, end));
	const after = flat(haystack.slice(end, to));
	const lead = from > 0 ? "…" : "";
	const tail = to < haystack.length ? "…" : "";
	void raw;
	return {
		snippet: `${lead}${before}${match}${after}${tail}`,
		matchStart: lead.length + before.length,
		matchEnd: lead.length + before.length + match.length,
	};
}

/** Every searchable field of one message, tagged with where it came from. */
function searchableParts(m: WireMessage): { where: SearchHit["where"]; text: string; toolName?: string }[] {
	const parts: { where: SearchHit["where"]; text: string; toolName?: string }[] = [];
	// A transcript arrives over the wire and can contain anything. Search is a
	// read-only convenience — it must never be the thing that takes down a turn.
	if (!m || typeof m !== "object") return parts;
	const content = m.content;

	if (typeof content === "string") {
		if (content.trim()) parts.push({ where: "text", text: content });
		return parts;
	}
	if (!Array.isArray(content)) return parts;

	for (const block of content) {
		// Field access goes through `pi-dialect` rather than an inline cast: an
		// inline cast is checked against the shape written at the point of use,
		// so reaching for the Anthropic wire spelling (`.input`, `"tool_use"`)
		// compiles and silently returns nothing. That is how four bugs shipped.
		const text = blockText(block);
		if (text && text.trim()) {
			// A toolResult message's blocks are plain text; tag by the MESSAGE role
			// so the caller can label the hit correctly.
			parts.push({
				where: m.role === PI_TOOL_RESULT ? "tool-result" : "text",
				text,
				...(typeof m.toolName === "string" ? { toolName: m.toolName } : {}),
			});
			continue;
		}
		if (isToolCall(block)) {
			const name = toolCallName(block) || "tool";
			const rawArgs = toolCallArguments(block);
			let args = "";
			try {
				args = Object.keys(rawArgs).length === 0 ? "" : JSON.stringify(rawArgs);
			} catch {
				args = "";
			}
			parts.push({ where: "tool-call", text: `${name} ${args}`, toolName: name });
		}
		// `thinking` is deliberately not searched — the model's scratch is not
		// the conversation, and it is excluded from exports for the same reason.
	}
	return parts;
}

/**
 * Find every occurrence of `query` in the transcript.
 *
 * Returns at most `limit` hits, oldest first, so the output reads in the same
 * order as the conversation above it.
 */
export function searchTranscript(
	messages: readonly WireMessage[],
	query: string,
	opts: SearchOptions = {},
): { hits: SearchHit[]; truncated: boolean; usedRegex: boolean } {
	const trimmed = query.trim();
	if (!trimmed) return { hits: [], truncated: false, usedRegex: false };

	const limit = opts.limit ?? DEFAULT_LIMIT;
	const contextChars = opts.contextChars ?? DEFAULT_CONTEXT;
	const { re, usedRegex } = buildMatcher(trimmed, opts);
	const hits: SearchHit[] = [];
	let truncated = false;

	for (let i = 0; i < messages.length; i += 1) {
		const m = messages[i] as WireMessage | undefined;
		if (!m) continue;
		for (const part of searchableParts(m)) {
			// A fresh lastIndex per part: the regex is global and reused.
			re.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = re.exec(part.text)) !== null) {
				if (hits.length >= limit) {
					truncated = true;
					return { hits, truncated, usedRegex };
				}
				const { snippet, matchStart, matchEnd } = snippetAround(
					part.text,
					match.index,
					match.index + match[0].length,
					contextChars,
				);
				hits.push({
					index: i,
					role: typeof m.role === "string" ? m.role : "unknown",
					where: part.where,
					...(part.toolName ? { toolName: part.toolName } : {}),
					snippet,
					matchStart,
					matchEnd,
					...(typeof m.timestamp === "number" ? { timestamp: m.timestamp } : {}),
				});
				// A zero-width match (e.g. `a*`) would loop forever otherwise.
				if (match[0].length === 0) re.lastIndex += 1;
			}
		}
	}
	return { hits, truncated, usedRegex };
}
