/**
 * Mid-turn model switch — abort the in-flight prompt, swap to a new
 * model, and re-run the user's last message on the new one. The user
 * surface for this is the `/model <id>` slash command in chat: instead
 * of "abort, switch model, retype the message," they get a single
 * command that does the switch in place.
 *
 * Sequence:
 *   1. abort the current run (Pi unwinds via AbortController)
 *   2. wait for `agent_end` so session state is settled
 *   3. `setModel(target)` — Pi validates auth + persists the swap
 *   4. re-prompt with the same user message
 *
 * Returns `true` when the swap+re-prompt completed, `false` when the
 * user wasn't actually mid-turn (caller should use a normal
 * `session.setModel` instead — the next user message will go to the
 * new model).
 *
 * Ported from `core/agent.ts:1373-1446` (Runtime A) — same logic.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";

const SAFETY_TIMEOUT_MS = 5_000;

// Model<any> matches Pi's own catalog typing (Pi 0.70.x) — the API
// generic narrows per-provider but the cross-provider switch path doesn't
// care which API the target is on. `unknown` here would fail Pi's `Api`
// constraint; `any` is the documented escape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function switchModelMidTurn(
	session: AgentSession,
	target: Model<any>,
	userMessageToReplay: string,
	thinkingLevel?: ThinkingLevel,
): Promise<boolean> {
	// If no turn is active, the caller should use `session.setModel(target)`
	// directly — the new model takes effect on the next user prompt. This
	// path is for the case where the user typed `/model X` while the agent
	// was still streaming.
	if (!session.agent.signal) return false;

	// Idempotent unsub guard — BOTH the `agent_end` event handler AND the
	// safety-timeout call into the same cleanup path. Without the guard
	// we'd race-call Pi's raw unsub twice; depending on Pi's internals,
	// that could detach a stale listener registered by code reading our
	// event stream concurrently.
	let unsubbed = false;
	let resolved = false;

	const ended = new Promise<void>((resolve) => {
		const rawUnsub = session.subscribe((ev: { type?: string }) => {
			if (ev.type === "agent_end") {
				if (!unsubbed) {
					unsubbed = true;
					try {
						rawUnsub();
					} catch {
						/* defensive */
					}
				}
				if (!resolved) {
					resolved = true;
					resolve();
				}
			}
		});
		// Safety: if abort never produces `agent_end` (shouldn't happen, Pi
		// guarantees it), don't hang forever. Defense in depth.
		setTimeout(() => {
			if (!unsubbed) {
				unsubbed = true;
				try {
					rawUnsub();
				} catch {
					/* defensive */
				}
			}
			if (!resolved) {
				resolved = true;
				resolve();
			}
		}, SAFETY_TIMEOUT_MS);
	});

	await session.abort();
	await ended;

	try {
		await session.setModel(target);
		// Re-anchor thinking AFTER setModel (which resets the session to the new model's
		// DEFAULT level) but BEFORE the replay — so the replayed turn runs at the operator's
		// preserved/clamped level, not Pi's default. Carrying that level IS the point of /switch.
		if (thinkingLevel !== undefined) {
			try {
				session.setThinkingLevel(thinkingLevel as never);
			} catch {
				/* clamp / unsupported — the turn still replays on the new model */
			}
		}
	} catch (err) {
		// setModel validates auth + can throw (e.g. the target provider has no key). The turn
		// is already aborted, so DON'T drop the user's message — replay it on the still-current
		// model so the conversation isn't lost, then surface the switch failure to the caller.
		await session.prompt(userMessageToReplay);
		throw err;
	}
	await session.prompt(userMessageToReplay);
	return true;
}
