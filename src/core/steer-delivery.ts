/**
 * WHEN a mid-turn message reaches the running turn.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO OPERATIONS, AND ONLY ONE IS RECOVERABLE
 * ─────────────────────────────────────────────────────────────────────────
 * Pi exposes both:
 *
 *   • `steer()`    — injected into the turn in flight. The model sees it at the
 *                    next loop iteration and can change course mid-task.
 *                    Powerful, and irreversible: it alters a plan the model is
 *                    halfway through executing.
 *   • `followUp()` — held until the turn has no more tool calls and no pending
 *                    steering, i.e. a real TURN BOUNDARY.
 *
 * Brigade only ever called the first, so a message typed by reflex during a
 * long tool loop landed in the middle of the model's plan. Claude Code drains
 * its queue "at the next LLM pause" — between tool calls, after a subagent
 * returns — and carries five open steering issues plus a documented
 * docs-versus-behaviour bug from exactly that. Codex has the same two
 * operations with the polarity inverted, putting the destructive one under the
 * reflex finger.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE DEFAULT IS STILL `steer`
 * ─────────────────────────────────────────────────────────────────────────
 * The RPC method is NAMED `steer`. A client that calls it — the desktop app, a
 * third party — is asking to steer, and quietly turning that into a queue would
 * be the same class of silent breaking change as stripping `message.content`
 * from clients that never asked for deltas.
 *
 * So the wire default preserves the old behaviour, and Brigade's own TUI opts
 * in to `followUp` for a plain Enter, keeping `steer` for the deliberate
 * Ctrl/Cmd+Enter gesture.
 */

export type SteerDelivery = "steer" | "followUp";

/**
 * Resolve the requested delivery mode.
 *
 * Anything other than an explicit `"followUp"` — absent, empty, misspelled,
 * a value from a future client — resolves to `"steer"`. Failing toward the
 * documented default beats guessing at intent.
 */
export function resolveSteerDelivery(deliverAs: unknown): SteerDelivery {
	return deliverAs === "followUp" ? "followUp" : "steer";
}
