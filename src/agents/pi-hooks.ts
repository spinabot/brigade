/**
 * Installing Brigade's hooks onto a Pi session — by COMPOSITION, never by
 * assignment.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RULE, AND WHY IT HAS TEETH
 * ─────────────────────────────────────────────────────────────────────────
 * `AgentSession` installs its own handlers on the underlying `Agent` at
 * construction time, and those handlers are the ONLY bridge from Pi's
 * extension runner to the loop. `_installAgentToolHooks` sets
 * `agent.beforeToolCall` / `agent.afterToolCall` to forward `tool_call` /
 * `tool_result` to the runner (`pi-coding-agent` `agent-session.js:185-206`);
 * `createAgentSession` sets `agent.transformContext` to forward `context`
 * (`sdk.js:219`).
 *
 * They are plain mutable fields. A bare `agent.beforeToolCall = ours` compiles,
 * runs, passes every test — and silently unbinds an entire extension event. No
 * error, no warning, no failing assertion. That is exactly how Brigade's whole
 * `transformContext` chain sat dead in production while the suite stayed green.
 *
 * So hook installation lives here, in one file, and every function in it
 * composes over whatever Pi already installed. There is deliberately no
 * "replace" helper to reach for.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE ORDERING DIFFERS PER HOOK
 * ─────────────────────────────────────────────────────────────────────────
 * It is not arbitrary, and it is not the same in both directions:
 *
 *   • `transformContext` — Pi FIRST. Extensions may add context; Brigade's
 *     chain must see the final array, or an extension could grow a request
 *     after we reduced it to fit the window.
 *
 *   • `beforeToolCall` — BRIGADE FIRST. This is a security gate. A call the
 *     exec-gate refuses must not be handed to third-party extension code at
 *     all, and an operator must never be asked to approve a call that was
 *     already going to be blocked.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { BrigadeBeforeToolCallHook } from "./tool-guard.js";

/** The `Agent` fields this module composes onto. */
interface HookableAgent {
	beforeToolCall?: (ctx: unknown, signal?: AbortSignal) => Promise<unknown> | unknown;
	transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => Promise<AgentMessage[]>;
}

function agentOf(session: AgentSession): HookableAgent | undefined {
	return (session as unknown as { agent?: HookableAgent }).agent;
}

/**
 * Compose Brigade's tool guard over Pi's extension `tool_call` bridge.
 *
 * Brigade's guard chain runs FIRST and short-circuits on a block: the
 * unknown-tool guard, path-write guard, cmd-ism guard, config-write guard,
 * loop detector and exec-gate are a security boundary, and a refused call has
 * no business reaching extension code or an approval prompt.
 *
 * If nothing blocks, Pi's own handler runs and its verdict is honoured — which
 * is what keeps a `tool_call` extension working. Before this existed, the
 * assignment at the call site replaced Pi's handler outright, so any extension
 * registering `tool_call` would load cleanly, report as registered, and never
 * fire once.
 */
export function installBrigadeBeforeToolCall(
	session: AgentSession,
	guard: BrigadeBeforeToolCallHook,
): void {
	const agent = agentOf(session);
	if (!agent) return;

	const piOwn = agent.beforeToolCall;
	agent.beforeToolCall = async (ctx: unknown, signal?: AbortSignal): Promise<unknown> => {
		const verdict = await guard(ctx as never, signal);
		// Fail closed, and stop here — never consult extensions about a call the
		// security chain has already refused.
		if ((verdict as { block?: boolean } | undefined)?.block) return verdict;
		if (!piOwn) return verdict;
		// Pi's bridge is documented to THROW when an extension fails, and Pi's
		// loop treats that as blocking execution. Preserve that: swallowing it
		// would turn an extension's deliberate refusal into an allow.
		const piVerdict = await piOwn(ctx, signal);
		return (piVerdict as { block?: boolean } | undefined)?.block ? piVerdict : verdict;
	};
}
