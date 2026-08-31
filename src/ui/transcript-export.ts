/**
 * Rendering a transcript to a file someone can read.
 *
 * The source is `ResumeSnapshot.messages` — the same `WireMessage[]` the TUI
 * renders — so an export is a pure function of what is already on the wire. No
 * new RPC, no server state, nothing to keep in sync.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT GOES IN, AND WHY THAT SET
 * ─────────────────────────────────────────────────────────────────────────
 * The default is the conversation a human wants to re-read or attach to a bug
 * report: prose, and enough of the tool traffic to follow what happened.
 *
 *   • Tool CALLS are always named with their arguments — "we already ran this"
 *     is most of what makes a transcript useful after the fact.
 *   • Tool RESULTS are truncated by default. They are the bulk of the bytes and
 *     usually the least interesting part; `full` keeps them whole.
 *   • THINKING is excluded by default. It is the model's scratch, it is the
 *     largest single thing in a reasoning transcript, and it is the part most
 *     likely to contain something the operator would not choose to publish.
 *
 * Every one of those is an opinion, so each is a flag rather than a hard rule.
 */

import {
	blockText,
	blockThinking,
	isToolCall,
	toolCallArguments,
	toolCallName,
} from "../agents/pi-dialect.js";
import type { WireMessage } from "../protocol.js";

export interface ExportOptions {
	/** Keep tool results whole instead of truncating them. */
	full?: boolean;
	/** Include the model's thinking blocks. Off by default. */
	includeThinking?: boolean;
	/** Per-result truncation budget when `full` is false. */
	maxToolResultChars?: number;
	/** Header title. */
	title?: string;
	/** Rendered into the header so a reader knows which session this was. */
	sessionKey?: string;
	/**
	 * Redact a tool-result body BEFORE it is truncated.
	 *
	 * Ordering is the whole point. Truncation used to run first, and the PEM
	 * rule is anchored on `-----END … PRIVATE KEY-----` — so clipping a 3 KB
	 * key at 2000 chars removed the END marker, the rule stopped matching, and
	 * the DEFAULT export wrote key material in the clear while reporting "no
	 * secrets matched". `/export full` was the only safe mode, which is exactly
	 * backwards.
	 */
	redact?: (text: string) => string;
	/** Injectable for deterministic tests. */
	now?: () => Date;
}

const DEFAULT_TOOL_RESULT_CHARS = 2_000;

/** Flatten a message's content to plain text, by block type. */
function blocksOf(m: WireMessage): { text: string[]; thinking: string[]; calls: string[] } {
	const text: string[] = [];
	const thinking: string[] = [];
	const calls: string[] = [];
	const content = m.content;
	if (typeof content === "string") {
		if (content.trim()) text.push(content);
		return { text, thinking, calls };
	}
	if (!Array.isArray(content)) return { text, thinking, calls };
	for (const block of content) {
		// Read through `pi-dialect`, never an inline cast — see that module's
		// header for why an inline cast cannot catch a dialect mistake.
		const t = blockText(block);
		if (t && t.trim()) {
			text.push(t);
			continue;
		}
		const think = blockThinking(block);
		if (think && think.trim()) {
			thinking.push(think);
			continue;
		}
		if (isToolCall(block)) {
			const name = toolCallName(block) || "tool";
			const rawArgs = toolCallArguments(block);
			let args = "";
			try {
				args =
					Object.keys(rawArgs).length === 0 ? "" : JSON.stringify(rawArgs, null, 2);
			} catch {
				args = "";
			}
			calls.push(args ? `${name}\n${args}` : name);
		}
	}
	return { text, thinking, calls };
}

function clip(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n… [${s.length - max} more characters truncated — re-export with \`/export full\` to keep them]`;
}

/** A fenced block that cannot be broken by backticks in the content. */
function fence(body: string, lang = ""): string {
	// Count the longest backtick run so the fence is always longer than
	// anything inside it — tool output frequently contains code fences.
	let longest = 0;
	for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}${lang}\n${body}\n${ticks}`;
}

/**
 * Render a transcript as Markdown.
 *
 * Pure and deterministic given `now` — the same transcript always produces the
 * same bytes, so an export can be diffed and a test can assert on it.
 */
export function renderTranscriptMarkdown(
	messages: readonly WireMessage[],
	opts: ExportOptions = {},
): string {
	const now = (opts.now ?? (() => new Date()))();
	const maxResult = opts.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS;
	const out: string[] = [];

	out.push(`# ${opts.title ?? "Brigade transcript"}`);
	out.push("");
	// ISO, not a locale format: an export is a file that travels, and a
	// locale-dependent date renders differently on the reader's machine.
	out.push(`*Exported ${now.toISOString()}*`);
	if (opts.sessionKey) out.push(`*Session: \`${opts.sessionKey}\`*`);
	out.push(`*${messages.length} messages*`);
	out.push("");
	// State the limits of the redactor in the artifact itself. A reader who
	// assumes it is exhaustive is the person this line exists for.
	out.push(
		"> Secrets matching common patterns have been redacted, and home paths replaced with `~`.",
	);
	out.push("> This is pattern matching, not a guarantee — **read before sharing.**");
	out.push("");
	out.push("---");
	out.push("");

	for (const m of messages) {
		const { text, thinking, calls } = blocksOf(m);
		const role = typeof m.role === "string" ? m.role : "unknown";

		if (role === "user") {
			if (text.length === 0) continue;
			out.push("### 🧑 User");
			out.push("");
			out.push(text.join("\n\n"));
			out.push("");
			continue;
		}

		if (role === "assistant") {
			if (text.length === 0 && calls.length === 0 && thinking.length === 0) continue;
			out.push("### 🤖 Assistant");
			out.push("");
			if (opts.includeThinking && thinking.length > 0) {
				out.push("<details><summary>Thinking</summary>");
				out.push("");
				out.push(fence(thinking.join("\n\n")));
				out.push("");
				out.push("</details>");
				out.push("");
			}
			if (text.length > 0) {
				out.push(text.join("\n\n"));
				out.push("");
			}
			for (const call of calls) {
				const [name, ...rest] = call.split("\n");
				out.push(`**→ ${name}**`);
				if (rest.length > 0) {
					out.push("");
					out.push(fence(rest.join("\n"), "json"));
				}
				out.push("");
			}
			continue;
		}

		if (role === "toolResult") {
			const body = text.join("\n").trim();
			if (!body) continue;
			const label = typeof m.toolName === "string" ? m.toolName : "tool";
			const marker = m.isError === true ? "✗" : "←";
			out.push(`**${marker} ${label}**`);
			out.push("");
			// Redact first, THEN clip — see `redact` above.
			const safe = opts.redact ? opts.redact(body) : body;
			out.push(fence(opts.full ? safe : clip(safe, maxResult)));
			out.push("");
			continue;
		}
	}

	// Exactly one trailing newline — a file that ends mid-line is annoying to
	// concatenate, and a run of blank lines shows up as a diff artifact.
	return `${out.join("\n").replace(/\s+$/, "")}\n`;
}

/**
 * Filename for an export.
 *
 * Sortable, filesystem-safe on every platform, and carrying the session so two
 * exports from different threads do not collide. Colons are deliberately absent
 * — they are illegal in Windows filenames and Brigade's session keys are full
 * of them.
 */
export function exportFileName(sessionKey: string | undefined, at: Date, ext = "md"): string {
	const stamp = at.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
	// DOTS ARE NOT ALLOWED IN THE SLUG. This name is joined to a directory, and
	// a session key is caller-influenced — `..` surviving the sanitizer would be
	// path traversal through a filename. Word characters and dashes only; the
	// extension is appended separately below.
	const slug = (sessionKey ?? "session")
		.replace(/[^\w-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return `brigade-${slug || "session"}-${stamp}.${ext}`;
}
