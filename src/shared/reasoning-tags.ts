// Reasoning-tag handling for models that emit chain-of-thought as literal text.
//
// Many local models (Ollama qwen3 / deepseek-r1 / qwq / "thinking" forks, and
// assorted fine-tunes) emit their reasoning INLINE as `<think>…</think>`,
// `<thinking>…</thinking>`, `<thought>…</thought>`, sometimes wrapped in a
// `<final>…</final>` around the real answer — as plain TEXT, not as a typed
// reasoning content block. Left in place this reasoning:
//   • leaks the raw tags into the visible reply (bad UX), and
//   • defeats JSON extraction (the chain-of-thought surrounds/pollutes the
//     JSON the memory extractor asks for).
//
// This module is the single source of truth for stripping/splitting that
// reasoning. Two entry points:
//   • stripReasoningTags(text)  — drop reasoning, return only the answer text.
//   • splitReasoning(text)      — split into { visible, reasoning } so callers
//                                 that want to SHOW the trace (e.g. the TUI's
//                                 /show-thinking) can keep it.

// Fast pre-check: bail immediately when there's no reasoning tag at all so the
// common (no-tag) path allocates nothing.
const REASONING_QUICK_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|final)\b/i;

// A complete paired reasoning block. Group 1 captures the tag word so the
// backreference (\1) forces the closing tag to match the opener
// (`<thinking>…</thinking>`, not `<thinking>…</think>`); group 2 is the inner
// reasoning. Case-insensitive; tolerant of attributes/whitespace.
const REASONING_BLOCK_RE = /<\s*(think(?:ing)?|thought)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi;

// A reasoning block that was OPENED but never closed — e.g. a stream cut off
// mid-thought. Everything from the open tag to end-of-text is reasoning.
const REASONING_OPEN_TO_END_RE = /<\s*(?:think(?:ing)?|thought)\b[^>]*>([\s\S]*)$/i;

// `<final>` / `</final>` wrapper tags — the INNER content is the real answer,
// so we only remove the tags, never the content.
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^>]*>/gi;

// Any stray/leftover reasoning tag (unpaired open or close) after the passes
// above.
const REASONING_STRAY_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought)\b[^>]*>/gi;

/**
 * Split `text` into the visible answer and the concatenated reasoning trace.
 * `reasoning` is "" when there was none. Never throws.
 */
export function splitReasoning(text: string): { visible: string; reasoning: string } {
	if (!text || !REASONING_QUICK_RE.test(text)) return { visible: text, reasoning: "" };

	const reasoning: string[] = [];

	// 1. Complete paired blocks → collect inner, drop from visible.
	let visible = text.replace(REASONING_BLOCK_RE, (_m, _word: string, inner: string) => {
		const t = (inner ?? "").trim();
		if (t) reasoning.push(t);
		return "";
	});

	// 2. An unclosed reasoning block (opened, never closed) → collect the tail.
	const open = REASONING_OPEN_TO_END_RE.exec(visible);
	if (open) {
		const t = (open[1] ?? "").trim();
		if (t) reasoning.push(t);
		visible = visible.slice(0, open.index);
	}

	// 3. Unwrap <final>…</final> (keep the answer, drop the tags).
	visible = visible.replace(FINAL_TAG_RE, "");

	// 4. Remove any stray leftover reasoning tags.
	visible = visible.replace(REASONING_STRAY_TAG_RE, "");

	return { visible, reasoning: reasoning.join("\n").trim() };
}

/**
 * Return `text` with all reasoning removed — only the model's actual answer
 * (or the JSON it was asked for) remains. Never throws.
 */
export function stripReasoningTags(text: string): string {
	return splitReasoning(text).visible;
}
