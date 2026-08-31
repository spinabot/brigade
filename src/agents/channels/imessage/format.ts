/**
 * iMessage outbound formatting helpers.
 *
 * iMessage has NO rich markup — a message is plain text. So unlike Telegram
 * (HTML) or Discord (CommonMark), the only transform we need is to make markdown
 * READABLE as plain text:
 *   - a markdown pipe-table is flattened to `cell | cell` lines (the LLM emits
 *     tables and an un-flattened one renders as raw `| --- |` noise);
 *   - everything else passes through untouched (bold `**x**`, links `[a](b)` —
 *     iMessage shows the literal characters, which is the honest fallback).
 *
 * Plus two send-path utilities ported from the upstream `send.ts`:
 *   - `sanitizeReplyToId` — scrub a reply-to id of control chars / brackets so it
 *     can't break the bridge's tag parsing, capped at 256 chars;
 *   - `resolveDeliveredText` — when an outbound has media but no text, deliver a
 *     `<media:kind>` placeholder so the echo cache + transcript have a body.
 */

/** Max length of a sanitized reply-to id. */
const MAX_REPLY_TO_ID_LENGTH = 256;

/**
 * Flatten a markdown pipe-table block into plain `cell | cell` lines, dropping
 * the `|---|` separator row. A non-table block is returned unchanged.
 */
function flattenTableBlock(lines: string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		// Drop the header separator row (`| --- | --- |`).
		if (/^\|?\s*:?-{2,}.*\|/.test(trimmed) && /^[\s|:-]+$/.test(trimmed)) continue;
		const cells = trimmed
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((c) => c.trim());
		out.push(cells.join(" | "));
	}
	return out;
}

/** True when a line looks like a markdown table row (`| a | b |`). */
function isTableRow(line: string): boolean {
	const t = line.trim();
	return t.startsWith("|") && t.includes("|", 1);
}

/**
 * Convert agent-style markdown to iMessage-friendly plain text. The only
 * load-bearing transform is flattening pipe tables; all other markdown passes
 * through verbatim (iMessage renders the literal characters).
 */
export function markdownToIMessageText(markdown: string): string {
	const src = markdown ?? "";
	if (!src.includes("|")) return src; // fast path — no table possible
	const lines = src.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (isTableRow(lines[i] ?? "")) {
			const start = i;
			while (i < lines.length && isTableRow(lines[i] ?? "")) i++;
			out.push(...flattenTableBlock(lines.slice(start, i)));
			continue;
		}
		out.push(lines[i] ?? "");
		i++;
	}
	return out.join("\n");
}

/** Strip control chars + `[` / `]` so a reply id can't break the bridge's tags. */
function stripUnsafeReplyTagChars(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (code <= 31 || code === 127) continue;
		if (ch === "[" || ch === "]") continue;
		out += ch;
	}
	return out;
}

/**
 * Sanitize an outbound reply-to id: trim, strip unsafe chars, cap at 256 chars.
 * Returns undefined when nothing usable remains.
 */
export function sanitizeReplyToId(raw?: string): string | undefined {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return undefined;
	let v = stripUnsafeReplyTagChars(trimmed).trim();
	if (!v) return undefined;
	if (v.length > MAX_REPLY_TO_ID_LENGTH) v = v.slice(0, MAX_REPLY_TO_ID_LENGTH);
	return v;
}

/**
 * Outbound delivery sanitizer (the twin of the inbound reflection guard).
 *
 * The central pipeline already strips `<think>`/`<final>` via
 * `sanitizeReplyForChannel`, but the channel send path is reachable by OTHER
 * routes (agent tools, catch-up replays, plugins) and a model can emit Brigade's
 * own internal scaffolding mid-text. This is the last gate before the wire: it
 * removes anything that is unambiguously internal so it can never reach a
 * recipient's iMessage thread. Shared by BOTH channels (iMessage native +
 * BlueBubbles) — it runs on every outbound text bubble.
 *
 * What it strips:
 *   - inline directive tags (`[[audio_as_voice]]`, `[[reply_to:…]]`,
 *     `[[reply_to_current]]`) — Brigade consumes these as send-options; they
 *     must never render as literal text;
 *   - `<think>`/`<thinking>`/`<thought>` reasoning blocks + `<final>` wrappers
 *     (residue if an upstream sanitizer was skipped);
 *   - role/turn scaffolding markers (`assistant to=…`, a trailing
 *     `user:` / `system:` / `assistant:` line) and internal `#+#+` separators.
 *
 * Idempotent + dependency-free. Collapses the blank lines a strip leaves behind.
 */

/** Inline directive tags Brigade consumes as send-options (never user-visible). */
const INLINE_DIRECTIVE_TAG_RE =
	/\s*(?:\[\[\s*audio_as_voice\s*\]\]|\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\])\s*/gi;
/** Model-internal separator runs (`+#+#+#`). */
const INTERNAL_SEPARATOR_RE = /(?:[#+]){4,}#?/g;
/** A leaked `assistant to=<role>` scaffolding marker. */
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/gi;
/** A trailing role-turn marker on its own line (`assistant:` / `user:` / `system:`). */
const ROLE_TURN_MARKER_RE = /^[ \t]*(?:user|system|assistant)\s*:\s*$/gim;

/** Iteratively drop fully-closed `<think>`/`<thinking>`/`<thought>` blocks. */
function stripReasoningBlocks(text: string): string {
	let out = text;
	for (let i = 0; i < 32; i++) {
		const next = out.replace(/<(think|thinking|thought)>(?:(?!<\1>)[\s\S])*?<\/\1>\s*/i, "");
		if (next === out) break;
		out = next;
	}
	return out;
}

/**
 * Strip Brigade-internal scaffolding from outbound text before it hits the wire.
 *
 * Returns "" when stripping leaves nothing — the caller must then send NOTHING.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE OLD FALLBACK WAS EXACTLY BACKWARDS
 * ─────────────────────────────────────────────────────────────────────────
 * This used to return the raw original in that case, reasoning that it is
 * "better to send something than confuse the recipient with silence". But the
 * case where stripping empties the text is precisely the case where the body
 * was ENTIRELY internal scaffolding — so "something" is the model's private
 * reasoning, or a `[[reply_to:…]]` directive, delivered verbatim to another
 * person. Proven: `"&lt;think&gt;secret plan&lt;/think&gt;"` went out as-is,
 * contradicting this module's own rule that such text "must never reach a
 * recipient's iMessage thread".
 *
 * Silence is the correct outcome. A recipient seeing nothing is a bug the
 * operator can notice and report; a recipient seeing the model's reasoning
 * cannot be taken back.
 */
export function sanitizeOutboundIMessageText(text: string): string {
	if (!text) return text;
	let cleaned = stripReasoningBlocks(text);
	cleaned = cleaned.replace(/<\/?final>\s*/gi, "");
	cleaned = cleaned.replace(INLINE_DIRECTIVE_TAG_RE, " ");
	cleaned = cleaned.replace(INTERNAL_SEPARATOR_RE, "");
	cleaned = cleaned.replace(ASSISTANT_ROLE_MARKER_RE, "");
	cleaned = cleaned.replace(ROLE_TURN_MARKER_RE, "");
	// Collapse runs of spaces a strip can leave mid-line, then blank lines.
	cleaned = cleaned.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
	return cleaned.trim();
}

/** Outbound media kind → the placeholder text used when the message has no body. */
export type IMessageMediaKind = OutboundMediaKind;
type OutboundMediaKind = "image" | "video" | "audio" | "voice" | "document" | "sticker";

/**
 * When an outbound carries media but no text, deliver a `<media:kind>`
 * placeholder so the echo cache + transcript have a body to key on. Returns the
 * text unchanged when it's non-empty.
 */
export function resolveDeliveredText(text: string, mediaKind?: OutboundMediaKind): string {
	if ((text ?? "").trim()) return text;
	if (!mediaKind) return text;
	return `<media:${mediaKind}>`;
}
