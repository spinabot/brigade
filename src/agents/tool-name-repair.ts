// Tool-name reconciliation for misnamed tool calls.
//
// Pi's agent-loop dispatches tool calls by EXACT string match
// (`tools.find(t => t.name === toolCall.name)`) and, on a miss, hard-returns a
// `Tool <name> not found` error tool-result BEFORE any Brigade guard / hook can
// run. Weak local models (Ollama forks) routinely misname a call:
//   • wrong case / stray whitespace (`Browser`, `" read "`),
//   • a provider/namespace prefix (`functions.browser`, `browser.navigate`),
//   • — most commonly — the `browser` tool's `action` DISCRIMINATOR used AS the
//     tool name: it emits a tool literally named `action` (with
//     `{action:"navigate", url}`), or names the tool after an action VALUE like
//     `navigate`. There is no tool called `action`/`navigate`, so dispatch
//     fails and the turn stalls.
//
// This module reconciles the emitted name against the LIVE allowed-tool set and
// rewrites it (on both the streamed events and the final assistant message Pi
// dispatches from) so a recoverable call lands instead of erroring. Nothing is
// invented: if no real tool plausibly matches, the name is left for Pi to
// reject as before.

import { BROWSER_ACTIONS } from "./tools/browser.js";
import type { BrigadeStreamFn } from "./stream-wrappers.js";

const BROWSER_ACTION_SET: ReadonlySet<string> = new Set(BROWSER_ACTIONS.map((a) => a.toLowerCase()));

// Unknown-name → real-tool aliases. Seeded from the observed failure: the
// browser tool multiplexes on an `action` param, and models mistake that
// discriminator (or the verbs "browse"/"web") for the tool name.
const STATIC_ALIASES: Readonly<Record<string, string>> = {
	action: "browser",
	browse: "browser",
	web: "browser",
};

export interface ResolvedToolName {
	/** The real registered tool name to dispatch. */
	name: string;
	/** When the raw name was a multiplexed-tool ACTION value, the action to inject into args. */
	action?: string;
}

/**
 * Resolve a model-emitted tool name to a REAL registered tool. Returns null
 * when no change is needed (already valid) or nothing plausibly matches (leave
 * it for Pi to reject). Order: exact → trim → case-insensitive-unique → static
 * alias → browser-action-value → segmented/prefixed name.
 */
export function resolveToolName(rawName: unknown, allowed: ReadonlySet<string>): ResolvedToolName | null {
	if (typeof rawName !== "string" || rawName.length === 0) return null;
	if (allowed.has(rawName)) return null; // already a valid tool name

	const trimmed = rawName.trim();
	if (trimmed !== rawName && allowed.has(trimmed)) return { name: trimmed };

	const lower = trimmed.toLowerCase();

	// Case-insensitive UNIQUE match (`Browser`/`READ` → the real name).
	const ciMatches = [...allowed].filter((n) => n.toLowerCase() === lower);
	if (ciMatches.length === 1) return { name: ciMatches[0] as string };

	// Static alias (action/browse/web → browser).
	const alias = STATIC_ALIASES[lower];
	if (alias && allowed.has(alias)) return { name: alias };

	// A browser ACTION value used as the tool name (navigate/click/…) → route to
	// `browser` and carry the action along.
	if (BROWSER_ACTION_SET.has(lower) && allowed.has("browser")) {
		return { name: "browser", action: lower };
	}

	// Provider-prefixed / segmented name: `functions.browser`, `browser.navigate`.
	const segments = trimmed.split(/[.:/]+/).filter(Boolean);
	if (segments.length > 1) {
		for (const seg of segments) {
			if (allowed.has(seg)) return { name: seg };
			const s = seg.toLowerCase();
			if (allowed.has(s)) return { name: s };
		}
		for (const seg of segments) {
			if (BROWSER_ACTION_SET.has(seg.toLowerCase()) && allowed.has("browser")) {
				return { name: "browser", action: seg.toLowerCase() };
			}
		}
	}

	return null;
}

interface ToolCallBlock {
	type?: unknown;
	name?: unknown;
	arguments?: unknown;
	[k: string]: unknown;
}

/** Rewrite one `toolCall` content block; returns null when unchanged. */
export function rewriteToolCallBlock(block: unknown, allowed: ReadonlySet<string>): unknown | null {
	if (!block || typeof block !== "object") return null;
	const b = block as ToolCallBlock;
	if (b.type !== "toolCall" || typeof b.name !== "string") return null;
	const res = resolveToolName(b.name, allowed);
	if (!res) return null;
	let args = b.arguments;
	if (res.action) {
		const obj =
			args && typeof args === "object" && !Array.isArray(args)
				? (args as Record<string, unknown>)
				: {};
		if (obj.action === undefined) args = { ...obj, action: res.action };
	}
	return { ...b, name: res.name, arguments: args };
}

/** Rewrite every `toolCall` block in an assistant message. Same ref if unchanged. */
export function rewriteMessageToolNames<M>(message: M, allowed: ReadonlySet<string>): M {
	const m = message as { content?: unknown } | null | undefined;
	if (!m || !Array.isArray(m.content)) return message;
	let changed = false;
	const content = m.content.map((block) => {
		const rewritten = rewriteToolCallBlock(block, allowed);
		if (rewritten) {
			changed = true;
			return rewritten;
		}
		return block;
	});
	return changed ? ({ ...(m as object), content } as M) : message;
}

interface EventStreamLike {
	[Symbol.asyncIterator](): AsyncIterator<unknown>;
	result(): Promise<unknown>;
}

function isEventStreamLike(v: unknown): v is EventStreamLike {
	if (!v || (typeof v !== "object" && typeof v !== "function")) return false;
	const s = v as { [Symbol.asyncIterator]?: unknown; result?: unknown };
	return typeof s[Symbol.asyncIterator] === "function" && typeof s.result === "function";
}

function rewriteEventToolNames(ev: unknown, allowed: ReadonlySet<string>): unknown {
	if (!ev || typeof ev !== "object") return ev;
	const e = ev as { type?: unknown; toolCall?: unknown; partial?: unknown };
	let next = ev;
	if (e.type === "toolcall_end" && e.toolCall) {
		const rewritten = rewriteToolCallBlock(e.toolCall, allowed);
		if (rewritten) next = { ...(next as object), toolCall: rewritten };
	}
	if (e.partial && typeof e.partial === "object") {
		const rewrittenPartial = rewriteMessageToolNames(e.partial, allowed);
		if (rewrittenPartial !== e.partial) next = { ...(next as object), partial: rewrittenPartial };
	}
	return next;
}

async function* toolNameIterator(
	inner: EventStreamLike,
	allowed: ReadonlySet<string>,
): AsyncGenerator<unknown> {
	for await (const ev of inner) {
		yield rewriteEventToolNames(ev, allowed);
	}
}

/**
 * Wrap Pi's streamFn to reconcile misnamed tool calls against the live
 * allowed-tool set — rewriting the name on BOTH the final assistant message
 * (`.result()`, which Pi dispatches from) and the streamed toolcall events (so
 * the TUI shows the corrected name). `getAllowedNames` is read per call so
 * per-turn tool changes are honoured. Composes on top of Pi's auth-aware
 * streamFn — never replaces it.
 */
export function wrapStreamFnWithToolNameRepair<F extends BrigadeStreamFn>(
	base: F,
	getAllowedNames: () => Iterable<string> | undefined,
): F {
	const wrapped = async function (this: unknown, ...args: unknown[]) {
		const stream = await Promise.resolve(base.apply(this, args));
		if (!isEventStreamLike(stream)) return stream;
		const allowed = new Set<string>();
		for (const n of getAllowedNames() ?? []) {
			if (typeof n === "string" && n) allowed.add(n);
		}
		if (allowed.size === 0) return stream;
		const inner = stream;
		return {
			[Symbol.asyncIterator]: () => toolNameIterator(inner, allowed),
			result: async () => rewriteMessageToolNames(await inner.result(), allowed),
		} satisfies EventStreamLike;
	} as unknown as F;
	return wrapped;
}
