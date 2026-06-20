/**
 * Carrow — cross-model continuity. Carry a LIVE conversation from one model to
 * another with full transcript carry-over and capability-aware re-anchoring. This is
 * the NAMED composition of the in-tree switch + thinking-remap; a client or the
 * gateway calls `Carrow.handoff` and applies the returned thinking level (mirroring
 * the gateway switch path).
 *
 * What "continuity" means here — the honest mechanics:
 *   - HISTORY carries over — the swap happens on the SAME `AgentSession`, so the full
 *     message transcript moves to the new model untouched (no context loss).
 *   - THINKING is re-anchored — the operator's thinking level is remapped to what the
 *     TARGET can honor: preserved when it can reason, forced "off" for a non-reasoning
 *     model, bumped "off"→"low" for a reasoning-only model (`remapThinkingLevel`).
 *   - PROVIDER SHAPE is sanitized — Anthropic-shaped reasoning blocks the next provider
 *     would reject are stripped on the following stream by the payload mutator
 *     (`dropAnthropicThinkingBlocks`), automatically; Carrow relies on that being wired.
 *
 * Two timings:
 *   - MID-TURN (a turn is streaming + a last user message is supplied): abort the
 *     in-flight run, swap, and REPLAY the last message on the new model. The partial
 *     generation is discarded — the *conversation* continues, not the token stream
 *     (Pi 0.73.x cannot resume a stream across providers; this is the faithful mechanism).
 *   - NEXT-TURN (no active turn): swap now; the next message goes to the new model.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";

import { remapThinkingLevel } from "../core/model-caps.js";
import { switchModelMidTurn } from "./mid-turn-switch.js";

export interface CarrowHandoff {
	/** true when a MID-TURN abort+replay happened; false for a NEXT-TURN swap. */
	switched: boolean;
	/** the thinking level re-anchored for the target model — the caller applies it
	 *  (the gateway switch path sets it on the session the same way). */
	thinkingLevel: ThinkingLevel;
}

export const Carrow = {
	/** Re-anchor a thinking level to what the target model can honor (capability-aware). */
	// biome-ignore lint/suspicious/noExplicitAny: Model<any> matches Pi's cross-provider catalog typing (see mid-turn-switch.ts).
	reanchorThinking(current: ThinkingLevel | undefined, target: Model<any>): ThinkingLevel {
		return remapThinkingLevel(current, target);
	},

	/**
	 * Carry the live conversation to `target`. When a turn is in flight AND a last user
	 * message is supplied, it's a MID-TURN handoff (abort → swap → replay); otherwise the
	 * model is swapped for the NEXT turn. Conversation history carries over either way.
	 * Returns whether a mid-turn switch occurred + the re-anchored thinking level.
	 */
	async handoff(
		session: AgentSession,
		// biome-ignore lint/suspicious/noExplicitAny: Model<any> matches Pi's cross-provider catalog typing (see mid-turn-switch.ts).
		target: Model<any>,
		opts: { currentThinking?: ThinkingLevel; lastUserMessage?: string } = {},
	): Promise<CarrowHandoff> {
		const thinkingLevel = remapThinkingLevel(opts.currentThinking, target);
		if (session.agent.signal && opts.lastUserMessage !== undefined) {
			// Pass the re-anchored level so the mid-turn REPLAY runs at it (set after setModel,
			// before the replay) — not the new model's default.
			const switched = await switchModelMidTurn(session, target, opts.lastUserMessage, thinkingLevel);
			// switchModelMidTurn returns false when the turn finished between our check above
			// and its own recheck (a TOCTOU). Don't silently no-op the swap — fall through to a
			// next-turn setModel so the session still lands on the target model.
			if (switched) return { switched, thinkingLevel };
		}
		await session.setModel(target);
		return { switched: false, thinkingLevel };
	},
};
