/**
 * Tool-call guard — refuses problematic tool invocations BEFORE they
 * execute. Wired into Pi's `session.agent.beforeToolCall` hook.
 *
 * Three failure modes caught here:
 *
 *   1. UNKNOWN TOOL — model hallucinated a name not in the allowlist.
 *      Returns a refusal listing the real tools so it self-corrects on
 *      the next turn.
 *
 *   2. WHITESPACE-WRAPPED NAME — provider emitted `"  read  "` instead
 *      of `"read"`. Pi treats this as unknown. We trim before checking.
 *      The error message tells the model to drop the spaces.
 *
 *   3. MALFORMED ARGS — empty args for a tool that needs params (xAI
 *      sometimes emits broken JSON; Pi parses what it can, leaves us
 *      with `{}`). Refuse with explicit instruction to retry.
 *
 * Ported from `core/agent.ts:807-929` (Runtime A) — same logic, no
 * functional change. Lives here so Runtime B can use it without
 * importing from Runtime A.
 */

import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";

/**
 * Hook signature matches Pi's exact contract — strictly async, returns
 * `Promise<BeforeToolCallResult | undefined>`. Pi awaits the result so
 * making it async (vs `sync | async`) avoids TS variance issues at the
 * assignment site (`session.agent.beforeToolCall = guard`).
 */
export type BrigadeBeforeToolCallHook = (
	ctx: BeforeToolCallContext,
	signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

/**
 * Tools that DON'T need parameters. If the model calls one of these
 * with empty args, that's normal — don't flag.
 *
 * Small allowlist of common parameter-less tools across our provider
 * catalog. Add new ones here as they ship.
 */
const PARAMETERLESS_TOOLS = new Set([
	"ping",
	"status",
	"list_models",
	"list-models",
	"version",
	"help",
	"now",
]);

export function trimToolCallName(name: unknown): string {
	if (typeof name !== "string") return "";
	return name.trim();
}

/**
 * Canonical tool-name normaliser shared by every `beforeToolCall` hook
 * in the chain (unknown-tool guard, loop detector, exec gate). Lowercase
 * + trim, so a provider that emits `Read`, `READ`, or `  read  ` is
 * handled identically across all three layers. Without a shared
 * helper, the layers diverge — earlier audits caught the bash gate
 * doing lowercase matching while the path guards used raw casing.
 *
 * Mirrors OpenClaw's `normalizeToolName` at
 * `src/agents/tool-policy.ts` (Brigade-native rename).
 */
export function normalizeToolName(name: unknown): string {
	if (typeof name !== "string") return "";
	return name.trim().toLowerCase();
}

/**
 * Heuristic detector for malformed tool arguments. Returns true when
 * the call looks suspiciously empty (likely a streaming JSON parse
 * failure) for a tool that typically requires arguments.
 *
 * Pure approximation — true repair would need stream-level intervention
 * (see `wrapStreamFnWithToolCallRepair` in `stream-wrappers.ts`). This
 * surface-level check is the second-line defence: even if the stream
 * wrapper missed it, the guard still refuses execution.
 */
export function isLikelyMalformedArgs(args: unknown, toolName: string): boolean {
	if (args === null || args === undefined) return true;
	if (typeof args !== "object") return true;

	const keys = Object.keys(args as object);
	if (keys.length === 0) {
		const normalized = (toolName ?? "").toLowerCase();
		return !PARAMETERLESS_TOOLS.has(normalized);
	}

	return false;
}

/**
 * Build a `beforeToolCall` hook that blocks problematic tool calls
 * before they execute.
 *
 * Wire via:
 *   session.agent.beforeToolCall = makeUnknownToolGuard(toolNames);
 *
 * To compose with another `beforeToolCall` hook (e.g. operator-defined
 * audit policy), wrap manually:
 *   const guard = makeUnknownToolGuard(toolNames);
 *   const userHook = ...;
 *   session.agent.beforeToolCall = async (ctx, signal) => {
 *     const guarded = await guard(ctx, signal);
 *     if (guarded?.block) return guarded;        // hard refusal wins
 *     return userHook(ctx, signal);              // otherwise user policy
 *   };
 */
export function makeUnknownToolGuard(allowedToolNames: string[]): BrigadeBeforeToolCallHook {
	// Normalise the allowlist so a model that emits `Read`, `READ`, or
	// `  read  ` matches a `read` entry. The shared `normalizeToolName`
	// helper applies the same rules at every other hook layer.
	const allowed = new Set(allowedToolNames.map((n) => normalizeToolName(n)));
	return async (ctx) => {
		// Pi's BeforeToolCallContext exposes the tool call. Field shape
		// varies slightly across Pi versions — the most stable accessors
		// are `name` and `arguments`/`args`.
		const rawName = (ctx as { toolCall?: { name?: unknown }; name?: unknown })?.toolCall?.name
			?? (ctx as { name?: unknown })?.name
			?? "";
		const name = normalizeToolName(rawName);
		const args = (ctx as { toolCall?: { arguments?: unknown }; args?: unknown; arguments?: unknown })
			?.toolCall?.arguments
			?? (ctx as { args?: unknown })?.args
			?? (ctx as { arguments?: unknown })?.arguments
			?? {};

		// CHECK ORDER MATTERS:
		//   1. Unknown tool first — if the name is wrong, the model has
		//      to retry with a different tool entirely; arg validation
		//      is moot.
		//   2. Malformed args second — name was right but call was
		//      empty; model needs to retry with proper params for the
		//      SAME tool.
		// Without this ordering, a call with both bad name AND empty
		// args would only learn about the name issue on the first
		// retry, then fail again on the args.

		if (!name || !allowed.has(name)) {
			const list = [...allowed].sort().join(", ") || "(no tools enabled)";
			const trimmedRaw = trimToolCallName(rawName);
			const hadCasing = typeof rawName === "string" && trimmedRaw !== name;
			const hadWhitespace = typeof rawName === "string" && rawName !== trimmedRaw;
			const hint =
				hadCasing && hadWhitespace
					? ` (note: name normalises to "${name}" — re-emit lowercased and without surrounding whitespace)`
					: hadCasing
						? ` (note: name normalises to "${name}" — re-emit lowercased)`
						: hadWhitespace
							? ` (note: name had extra whitespace — re-emit as "${name}" without spaces)`
							: "";
			return {
				block: true,
				reason: `Tool "${String(rawName)}" is not available${hint}. Available tools: ${list}. Please use one of those instead.`,
			};
		}

		if (isLikelyMalformedArgs(args, name)) {
			return {
				block: true,
				reason: `Tool "${name}" was called with empty/missing arguments. Please retry with the required parameters.`,
			};
		}

		return undefined;
	};
}
