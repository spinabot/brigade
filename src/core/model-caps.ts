/**
 * Model capability adapter.
 *
 * Pi-AI exposes ~150+ models across 9 providers. They have wildly different
 * defaults, quirks, and breakages. This module is the single place where
 * Brigade encodes that knowledge. Two responsibilities:
 *
 *   1. Pick a SAFE initial `thinkingLevel` for a freshly-selected model
 *      (some reasoning-only models reject `thinking budget = 0`).
 *   2. Render a human-readable description of what a model supports
 *      (used in the header and in the model picker).
 *
 * If a new model regression shows up — "X provider rejects Y when Z" —
 * encode it here, not scattered across agent.ts/tui.ts/onboarding.ts.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

/**
 * Pick the SAFE initial `thinkingLevel` for this model.
 *
 * Pi clamps to "off" for non-reasoning models server-side, so we don't
 * strictly need to handle that case ourselves — but doing it here keeps
 * Brigade's behavior obvious without having to chase Pi internals.
 *
 * Reasoning models default to `"low"` because:
 *   - Several models (Gemini 2.5 Pro, Gemini 3.x Pro) REJECT `"off"` —
 *     they require a non-zero thinking budget. `"low"` is the cheapest
 *     value that satisfies them.
 *   - For Anthropic / OpenAI o-series, `"low"` produces fast responses
 *     without burning tokens on heavy chain-of-thought.
 *   - Users who want more reasoning can `/thinking high` at runtime.
 */
export function pickInitialThinkingLevel(model: Model<any>): ThinkingLevel {
	if (!model.reasoning) return "off";
	return "low";
}

/**
 * Short human description of a model's notable capabilities,
 * suitable for the chat header (e.g. "thinking · vision · 1M ctx · $1.25/Mtok").
 *
 * Renders only what's relevant — omits cost when zero (free tier),
 * omits vision when text-only, omits thinking when not supported.
 */
export function describeModelCapabilities(model: Model<any>, currentThinkingLevel?: ThinkingLevel): string {
	const parts: string[] = [];

	if (model.reasoning) {
		// Show the active thinking level so the user can see what they're paying for.
		// `off` is an explicit user choice — show it so it doesn't look like a bug.
		parts.push(currentThinkingLevel ? `think:${currentThinkingLevel}` : "thinking");
	}

	if (Array.isArray(model.input) && model.input.includes("image")) {
		parts.push("vision");
	}

	if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
		parts.push(`${formatTokens(model.contextWindow)} ctx`);
	}

	if (model.cost && model.cost.input > 0) {
		parts.push(`$${model.cost.input.toFixed(2)}/Mtok in`);
	}

	return parts.join(" · ");
}

/**
 * Pick the SAFE stream-idle timeout for this model in milliseconds.
 *
 * Wrong defaults here are user-visible failures: too low and we abort a
 * working slow model (the "qwen3-coder:30b: no response for 60s" bug from
 * the screenshot); too high and a genuinely-stalled connection makes the
 * user wait minutes before getting feedback.
 *
 * Trade-off chosen:
 *   - Cloud (Anthropic, OpenAI, Google, Groq, etc.) → 60s
 *     First token typically <3s; >60s of silence is genuine stall.
 *   - Cloud reasoning (Gemini 2.5 Pro thinking, etc.) → 180s
 *     Heavy reasoning can take 30-60s before any text emits.
 *   - Ollama (local) → 300s (5 min)
 *     30B model on consumer GPU: 30-90s first token, 5+ min for complex.
 *   - Custom OpenAI-compatible → 180s
 *     Could be cloud OR local (Together, Fireworks, vLLM, LM Studio);
 *     conservative default keeps both working.
 */
export function pickStreamIdleMs(model: Model<any>): number {
	const provider = (model?.provider ?? "").toLowerCase();

	// Local providers — always generous. Even small models can take seconds
	// per token on a busy laptop.
	if (provider === "ollama") return 300_000; // 5 min

	const KNOWN_CLOUD_PROVIDERS = new Set([
		"anthropic",
		"openai",
		"google",
		"google-vertex",
		"openrouter",
		"groq",
		"cerebras",
		"xai",
		"deepseek",
		"mistral",
		"github-copilot",
		"vercel-ai-gateway",
	]);
	const isCloud = KNOWN_CLOUD_PROVIDERS.has(provider);

	// Custom OpenAI-compatible endpoints — could be cloud OR local. Default
	// conservative so on-prem vLLM / LM Studio keep working.
	if (!isCloud) return 180_000;

	// Reasoning-capable cloud models can sit silent during extended thinking.
	if (model?.reasoning) return 180_000;

	return 60_000; // cloud, non-reasoning
}

/** Tokens → "1M", "200k", etc. */
function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${m === Math.floor(m) ? m : m.toFixed(1)}M`;
	}
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

/**
 * Parse a raw provider error message (often an embedded JSON blob) into
 * a single human-readable line. Each provider returns errors in a slightly
 * different shape — this function unwraps the common ones.
 *
 * Examples this handles:
 *   - Google:    `{"error":{"message":"Budget 0 is invalid…","code":400,…}}`
 *   - OpenAI:    `{"error":{"message":"Invalid API key…","type":"invalid_request_error","code":"invalid_api_key"}}`
 *   - Anthropic: `{"error":{"type":"authentication_error","message":"…"}}`
 *   - Pi-wrapped: `{"error":{"message":"<the JSON above stringified>","code":400,"status":"Bad Request"}}`
 *
 * Returns the cleaned message, or the original input if nothing matched.
 * Never throws.
 */
export function cleanProviderError(raw: string): string {
	if (!raw) return raw;

	// Strip a single layer of Pi wrapping if present, then attempt to peel
	// any nested JSON message. We loop a few times because some providers
	// stringify their JSON error inside another JSON error.
	let current = raw.trim();
	for (let depth = 0; depth < 4; depth++) {
		const peeled = peelOneJsonError(current);
		if (peeled === null || peeled === current) break;
		current = peeled;
	}

	// Final cleanup — collapse whitespace and trim.
	return current.replace(/\s+/g, " ").trim();
}

function peelOneJsonError(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{")) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;

	// Shape: { error: { message: "...", ... } }  — Google, OpenAI, Anthropic, most.
	if (obj.error && typeof obj.error === "object") {
		const inner = obj.error as Record<string, unknown>;
		if (typeof inner.message === "string" && inner.message.length > 0) {
			return inner.message;
		}
	}

	// Shape: { error: "string" }  — Ollama, some HF endpoints.
	if (typeof obj.error === "string" && obj.error.length > 0) {
		return obj.error;
	}

	// Shape: { message: "..." }  — Cohere, some Mistral errors.
	if (typeof obj.message === "string" && obj.message.length > 0) {
		return obj.message;
	}

	// Shape: { detail: "..." }  — FastAPI-style (Replicate, some self-hosted).
	if (typeof obj.detail === "string" && obj.detail.length > 0) {
		return obj.detail;
	}

	return null;
}
