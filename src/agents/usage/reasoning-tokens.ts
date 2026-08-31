/**
 * Reasoning-token counts, normalised across every provider shape.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ONE FUNCTION AND NOT A PER-BACKEND READ
 * ─────────────────────────────────────────────────────────────────────────
 * Brigade used to get this figure from exactly one place: the `claude-cli`
 * stream parser, which reached into that binary's own usage record. Every
 * other backend reported nothing, so the same model showed
 * `400 reasoning tokens` on one transport and a bare timer on another, with
 * nothing on screen to explain the difference. The reader in the gateway made
 * it worse by consulting `message.usage.reasoningTokens` through an `as any`
 * cast — a field Pi's `Usage` does not declare — so the compiler could not
 * point out that it is `undefined` everywhere except the one transport that
 * happens to set it.
 *
 * The providers do not disagree about the NUMBER, only about where to put it.
 * Collecting the shapes here means adding a backend costs nothing: whatever
 * usage object it produces, this reads it, and every renderer benefits at
 * once.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SHAPES, AND WHERE THEY COME FROM
 * ─────────────────────────────────────────────────────────────────────────
 *   Anthropic          usage.output_tokens_details.thinking_tokens
 *   OpenAI + compat    usage.completion_tokens_details.reasoning_tokens
 *                      (OpenRouter, Azure, Groq, Together, Fireworks … all
 *                      inherit this from the OpenAI schema)
 *   Google Gemini      usageMetadata.thoughtsTokenCount
 *   Ollama / local     thinking_tokens, flat
 *   Brigade-internal   reasoningTokens, already normalised
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS CANNOT DO, STATED PLAINLY
 * ─────────────────────────────────────────────────────────────────────────
 * It normalises a usage object it is GIVEN. It cannot conjure one that never
 * arrives, and for Pi-native providers none does: Pi folds reasoning tokens
 * into `output` before Brigade sees a usage record, and its only stream hooks
 * are `onPayload` (the request) and `onResponse` (status + headers, before the
 * body is read). There is no seam for the response body.
 *
 * So this makes every transport Brigade OWNS report the real figure, and every
 * transport Pi owns report honestly nothing — at which point the renderer
 * falls back to reasoning VOLUME, which is measured from the deltas on every
 * backend. Absent must never render as zero: "not reported" and "none" are
 * different facts, and only one of them is a measurement.
 */

/** A count is only meaningful when it is a finite, non-negative number. */
function asCount(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	// Some transports relay usage as JSON text with numeric strings.
	if (typeof value === "string" && value.trim()) {
		const n = Number(value.trim());
		if (Number.isFinite(n) && n >= 0) return n;
	}
	return undefined;
}

function nested(source: unknown, key: string): unknown {
	if (!source || typeof source !== "object") return undefined;
	return (source as Record<string, unknown>)[key];
}

/**
 * Reasoning tokens from any provider's usage object, or `undefined`.
 *
 * `undefined` means NOT REPORTED. It is never coerced to 0 — a renderer that
 * printed "0 reasoning tokens" for a provider that simply does not say would
 * be asserting a measurement nobody took, which is the whole failure mode this
 * subsystem exists to avoid.
 */
export function extractReasoningTokens(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as Record<string, unknown>;

	// Already normalised — Brigade's own transports, and anything that has
	// passed through here before.
	const direct = asCount(u.reasoningTokens);
	if (direct !== undefined) return direct;

	// Anthropic.
	const anthropic = asCount(nested(u.output_tokens_details, "thinking_tokens"));
	if (anthropic !== undefined) return anthropic;

	// OpenAI and every API that copied its schema, OpenRouter included.
	const openai = asCount(nested(u.completion_tokens_details, "reasoning_tokens"));
	if (openai !== undefined) return openai;

	// Google Gemini, which reports usage under its own envelope.
	const gemini =
		asCount(u.thoughtsTokenCount) ?? asCount(nested(u.usageMetadata, "thoughtsTokenCount"));
	if (gemini !== undefined) return gemini;

	// Flat spellings used by local runtimes and a few relays.
	return asCount(u.reasoning_tokens) ?? asCount(u.thinking_tokens);
}
