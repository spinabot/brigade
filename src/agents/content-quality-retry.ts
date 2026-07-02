/**
 * Content-quality retry — after a turn settles, detects low-quality output and
 * re-prompts with a tailored steer. Two tiers (see `runWithContentQualityRetry`):
 *   - RECOVERY ("said it would act but didn't" / "reasoning but no visible reply" /
 *     "empty") → exactly ONE re-prompt (one retry recovers the common cases; looping
 *     a pathological empty turn would just burn budget).
 *   - QUALITY GATE (slop) → keeps forcing a rewrite until the reply clears the slop
 *     bar or a cap (default 3), so a sloppy reply can't ship after a single nudge.
 *
 * The slop cap bounds the compounded budget across the other retry layers
 * (model-fallback + retry-policy + stream-wrappers).
 *
 * Failure modes:
 *   - **empty** — no content blocks at all
 *   - **reasoning-only** — thinking blocks present but no visible text
 *     OR tool call (the user sees a blank reply)
 *   - **planning-only** — text matches a "I'll do X" pattern AND no tool
 *     was invoked. Only flagged when tools are actually available.
 *
 * Ported from `core/agent.ts:1140-1248` (Runtime A) — same logic, no
 * functional change. Lives here so Runtime B can call it without
 * importing from Runtime A.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { detectSlop } from "./quality/slop-detector.js";

export type ContentQualityIssue = "empty" | "reasoning-only" | "planning-only" | "slop" | null;

/**
 * Sentence-start anchor — `(?:^|[.!?\n]\s+)`. Used by every planning-phrase
 * pattern below so the matcher fires only when the phrase opens a sentence,
 * not when it appears inside a quoted user message ("the user said 'I'll
 * fix it' which means..."). Without this anchor, the assistant echoing
 * the user's own intent would falsely trigger a retry.
 */
const SENTENCE_START = "(?:^|[.!?\\n]\\s+)";

/**
 * Matches a full inline reasoning block — <think>/<thinking>/<thought> …
 * </…> (any attributes, case-insensitive). Used to strip chain-of-thought
 * that some models emit as plain text before quality detection runs, so the
 * reasoning content is never mistaken for a visible answer or an action plan.
 */
const THINK_BLOCK_RE =
	/<\s*(?:think(?:ing)?|thought)\b[^>]*>[\s\S]*?<\/\s*(?:think(?:ing)?|thought)\s*>/gi;

const PLANNING_PHRASES = [
	new RegExp(
		`${SENTENCE_START}i'?ll (?:create|write|build|make|generate|set up|implement|fix|update|add|do|run|execute|launch|deploy|install|configure)`,
		"i",
	),
	new RegExp(
		`${SENTENCE_START}let me (?:create|write|build|make|generate|implement|fix|update|add|do|run|execute|launch|deploy|install|configure)`,
		"i",
	),
	new RegExp(
		`${SENTENCE_START}(?:going to|i will|i shall) (?:create|write|build|make|generate|implement)`,
		"i",
	),
	new RegExp(`${SENTENCE_START}here'?s (?:what|how) i'?ll`, "i"),
];

const STEER_FOR: Record<NonNullable<ContentQualityIssue>, string> = {
	empty:
		"You returned no visible reply. Provide your full visible answer to the user's last message now, in plain text.",
	"reasoning-only":
		"You produced reasoning but no visible answer. Provide your final visible answer to the user now, in plain text outside of any reasoning blocks.",
	"planning-only":
		"You described an action you would take, but you did not actually invoke the tool to do it. Take the action now using the appropriate tool — do not just describe it again.",
	slop:
		"Your reply leaned on filler / cliché phrasing (formulaic openers, empty intensifiers, boilerplate). Rewrite it concretely and concisely — keep the substance, drop the padding.",
};

/**
 * Inspect an assistant message for low-quality content. Returns the
 * issue type or null. Public for tests; the wrapper below calls it.
 *
 * `hadTools` should be `true` when the session has tools registered —
 * planning-only is only meaningful in that case (without tools, "I'll
 * write the code" IS the deliverable).
 */
export function detectContentIssue(
	message: { role?: string; content?: unknown } | null | undefined,
	hadTools: boolean,
): ContentQualityIssue {
	if (!message || message.role !== "assistant") return null;
	const content = message.content;
	if (!Array.isArray(content) || content.length === 0) return "empty";

	const textBlocks = content.filter(
		(b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text"
			&& typeof (b as { text?: unknown }).text === "string",
	);
	const thinkingBlocks = content.filter(
		(b) => b && typeof b === "object" && (b as { type?: unknown }).type === "thinking",
	);
	const toolCallBlocks = content.filter(
		(b) => b && typeof b === "object" && (b as { type?: unknown }).type === "toolCall",
	);

	const rawText = textBlocks
		.map((b) => (b as { text: string }).text)
		.join("")
		.trim();

	// Some models (notably local Ollama reasoning models marked reasoning:false)
	// emit their chain-of-thought INLINE as <think>/<thinking>/<thought> text
	// rather than as Pi-tagged `thinking` blocks. That reasoning is NOT a visible
	// answer and NOT a plan-to-act, so strip it before the planning / slop checks —
	// otherwise "let me do X" *inside* the reasoning falsely trips planning-only.
	THINK_BLOCK_RE.lastIndex = 0;
	const hadInlineThinking = THINK_BLOCK_RE.test(rawText);
	THINK_BLOCK_RE.lastIndex = 0;
	const totalText = rawText.replace(THINK_BLOCK_RE, "").trim();

	// Reasoning-only: had reasoning (Pi-tagged blocks OR inline <think> text), no
	// visible answer text, and no tool call.
	if (
		(thinkingBlocks.length > 0 || hadInlineThinking) &&
		totalText.length === 0 &&
		toolCallBlocks.length === 0
	) {
		return "reasoning-only";
	}

	// Empty: zero text AND zero tool calls (and not reasoning-only above).
	if (totalText.length === 0 && toolCallBlocks.length === 0) return "empty";

	// Planning-only: only matters when tools were available — otherwise the
	// model has no choice. We check that the text matches a planning phrase
	// AND no tool was invoked in this final message.
	if (hadTools && toolCallBlocks.length === 0 && totalText.length > 0) {
		if (PLANNING_PHRASES.some((re) => re.test(totalText))) return "planning-only";
	}

	// Slop (the post-generation quality gate) — LOWEST priority, only on a visible
	// text reply that isn't otherwise broken. The detector's density threshold keeps
	// this rare (it takes several distinct filler/cliché hits to trip); the wrapper
	// then re-drives a rewrite until the reply clears the bar or the cap.
	if (totalText.length > 0 && detectSlop(totalText).isSlop) return "slop";

	return null;
}

export interface ContentQualityRetryOptions {
	/** Called when a retry is triggered, with the detected reason. */
	onRetry?: (reason: NonNullable<ContentQualityIssue>) => void;
	/** Max rewrite re-prompts for the QUALITY (slop) gate. The gate keeps forcing a
	 *  rewrite until the reply clears the slop bar OR this cap is hit — then it ships the
	 *  last attempt (a response must go out eventually). Default 3. The RECOVERY issues
	 *  (empty / reasoning-only / planning-only) always get exactly ONE re-prompt,
	 *  regardless of this value — looping those is pathological, not a quality bar. */
	maxSlopRewrites?: number;
}

/**
 * Run a prompt body. After it resolves, inspect the final assistant message for
 * low-quality content; if detected, re-prompt with a tailored steer.
 *
 * Two tiers:
 *   - RECOVERY (empty / reasoning-only / planning-only) → exactly ONE re-prompt.
 *     One retry recovers the common cases; looping a pathological empty turn would
 *     just burn budget.
 *   - QUALITY GATE (slop) → keeps forcing a rewrite until the reply clears the slop
 *     bar or `maxSlopRewrites` (default 3) is hit. This is the "no slop ships" gate:
 *     a single sloppy reply can't slip through after one nudge — it's re-driven until
 *     clean (or, at the cap, the last attempt ships, since a response must go out).
 *
 * Composes with the other retry layers (model-fallback, retry-policy, thinking-
 * fallback) — the slop cap bounds the compounded budget. Each retry is a fresh
 * `session.prompt()` with the steer text (provider-portable, not a prefill).
 */
export async function runWithContentQualityRetry(
	session: AgentSession,
	body: () => Promise<void>,
	options: ContentQualityRetryOptions = {},
): Promise<void> {
	await body();

	// Inspect the LAST assistant message off a fresh snapshot each call — async
	// subscribers (extension hooks, telemetry) could append between a prompt
	// resolving and our inspection, so "last assistant" must be re-read, not cached.
	const inspectLast = (): ContentQualityIssue => {
		const snapshot = [...session.messages];
		const tools = (session.agent.state as { tools?: unknown }).tools;
		const hadTools = Array.isArray(tools) && tools.length > 0;
		const lastAssistant = [...snapshot].reverse().find((m: { role?: string }) => m.role === "assistant");
		return detectContentIssue(lastAssistant, hadTools);
	};

	const issue = inspectLast();
	if (!issue) return;

	// RECOVERY issues — a single steer re-prompt (Pi's `agent.steer` is for mid-turn
	// injection; this fires AFTER the turn, so we re-prompt directly).
	if (issue !== "slop") {
		options.onRetry?.(issue);
		await session.prompt(STEER_FOR[issue]);
		return;
	}

	// QUALITY GATE (slop) — force a rewrite, re-check, and keep going until the reply
	// clears the bar or the cap. "No slop ships" within budget.
	const maxRewrites = Math.max(1, options.maxSlopRewrites ?? 3);
	for (let attempt = 0; attempt < maxRewrites; attempt++) {
		options.onRetry?.("slop");
		await session.prompt(STEER_FOR.slop);
		if (inspectLast() !== "slop") return; // cleared the bar — ship it
	}
	// Hit the cap with the reply still flagged — ship the last attempt (a response
	// must go out eventually; the gate forced `maxRewrites` rewrites trying to clear it).
}
