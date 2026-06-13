/**
 * Resolve the default agent id from a Brigade config.
 *
 * Brand-scrubbed analogue of the upstream `src/agents/agent-scope.ts`. Used
 * by the 8-tier route resolver as the terminal fallback when no binding
 * tier matches the inbound, and by the channel manager when no agent is
 * explicitly named for an account.
 *
 * Resolution order:
 *   1. `cfg.defaults.agentId` (operator-pinned default)
 *   2. Brigade's canonical default agent, `"main"`
 *
 * Empty / non-string inputs fall through; never throws.
 *
 * NOTE (2026-06-13): step 2 used to be "the first agent id listed in
 * `cfg.agents`", with `"main"` only as a last resort. That silently broke the
 * moment an operator added agents: an org of 20 members made whichever key
 * sorted/inserted first (e.g. `accountant`) the BOOT + routing default,
 * demoting `main` — and a gateway restart re-derived the same wrong answer, so
 * it couldn't be shaken without hand-pinning. `main` is the operator's primary
 * agent (its workspace is `~/.brigade/workspace`, backed by `agents.defaults`
 * even without an explicit `cfg.agents.main` block), so it is ALWAYS a valid
 * default and must win over an arbitrary org agent. An operator who genuinely
 * wants a different default pins `defaults.agentId`.
 */

import { DEFAULT_AGENT_ID } from "../config/paths.js";
import type { BrigadeConfig } from "../config/types.js";

export function resolveDefaultAgentId(cfg: BrigadeConfig | undefined | null): string {
	if (!cfg) return DEFAULT_AGENT_ID;
	const pinned = (cfg.defaults as { agentId?: unknown } | undefined)?.agentId;
	if (typeof pinned === "string" && pinned.trim().length > 0) {
		return pinned.trim();
	}
	// No explicit pin → the canonical default agent. NEVER an arbitrary
	// `cfg.agents` key (see the NOTE above — that demoted `main` once an org
	// was created).
	return DEFAULT_AGENT_ID;
}
