/**
 * Brigade tool framework — common parameter readers + result builders.
 *
 * Pi's TypeBox-driven schema validation runs BEFORE `execute(...)` is
 * called, so by the time these helpers see `params` the shape is
 * guaranteed valid. The helpers here add three things on top of that:
 *
 *   1. **Field labelling for nicer error messages** — instead of AJV's
 *      generic "should be string" the model sees "path: string required".
 *      The label arg lets each tool override the field name when its
 *      schema key differs from the user-facing concept.
 *
 *   2. **String trimming + empty-string guarding** — Pi validates that
 *      the field IS a string but not that it's non-whitespace. Most
 *      tools want trimmed non-empty strings; the helper centralises
 *      that conversion.
 *
 *   3. **Snake-case / camel-case key aliasing** — some providers emit
 *      `tool_call_id` instead of `toolCallId`. The reader checks both
 *      shapes so a tool author can name params however they like in
 *      the schema and still receive the value.
 *
 * Pure functions; no module-level state.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import { emitAgentEvent } from "../agent-event-bus.js";
import type { AgentToolUpdateCallback, AnyBrigadeTool } from "./types.js";

/**
 * 400-class error for malformed / missing tool arguments. Pi catches
 * thrown errors from `execute` and surfaces them as tool failures to
 * the model — the model sees the `.message` string and can self-correct
 * on the next turn. The status code is informational only (Brigade has
 * no HTTP transport between the tool and Pi yet).
 */
export class BrigadeToolInputError extends Error {
	readonly status: number = 400;

	constructor(message: string) {
		super(message);
		this.name = "BrigadeToolInputError";
	}
}

/**
 * 403-class error for owner-only tools called from a non-owner sender.
 * Subclass of `BrigadeToolInputError` so callers don't have to switch
 * on the class to handle "rejected for any reason" cases.
 *
 * Today (single-user v1) every sender is the owner; this class is
 * reserved for Phase 2 (multi-user / channels) when non-owner senders
 * become a real concept.
 */
export class BrigadeToolAuthorizationError extends BrigadeToolInputError {
	override readonly status = 403;

	constructor(message: string) {
		super(message);
		this.name = "BrigadeToolAuthorizationError";
	}
}

/**
 * The standard error tools throw when refusing a call for any pre-
 * execution reason. Tools can also throw `BrigadeToolInputError` or
 * `BrigadeToolAuthorizationError` directly when the kind matters.
 */
export const OWNER_ONLY_TOOL_ERROR = "Tool restricted to the workspace owner.";

/* ─────────────────────────── param reading ─────────────────────────── */

/**
 * Read a param value tolerant of snake_case vs camelCase keys. Some
 * providers (OpenAI's older Responses API, some Mistral builds) lower-
 * case + snake-case tool arg keys regardless of the schema. The
 * helper checks both forms so the tool author can name keys however
 * they like.
 */
function readParamRaw(params: Record<string, unknown>, key: string): unknown {
	if (key in params) return params[key];
	// camelCase → snake_case fallback. Cheap regex; runs once per read.
	const snake = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
	if (snake !== key && snake in params) return params[snake];
	return undefined;
}

export interface StringParamOptions {
	required?: boolean;
	/** Trim leading/trailing whitespace before validating non-emptiness. Default `true`. */
	trim?: boolean;
	/** Display label used in error messages. Defaults to the key. */
	label?: string;
	/** When `true`, an empty string (post-trim) is accepted instead of being treated as missing. Default `false`. */
	allowEmpty?: boolean;
}

// Overloads so callers that pass `{required: true}` get a non-optional return type.
export function readStringParam(
	params: Record<string, unknown>,
	key: string,
	options: StringParamOptions & { required: true },
): string;
export function readStringParam(
	params: Record<string, unknown>,
	key: string,
	options?: StringParamOptions,
): string | undefined;
export function readStringParam(
	params: Record<string, unknown>,
	key: string,
	options: StringParamOptions = {},
): string | undefined {
	const { required = false, trim = true, label = key, allowEmpty = false } = options;
	const raw = readParamRaw(params, key);
	if (typeof raw !== "string") {
		if (required) throw new BrigadeToolInputError(`${label} required`);
		return undefined;
	}
	const value = trim ? raw.trim() : raw;
	if (!value && !allowEmpty) {
		if (required) throw new BrigadeToolInputError(`${label} required`);
		return undefined;
	}
	return value;
}

export interface NumberParamOptions {
	required?: boolean;
	label?: string;
	/** Truncate to integer with `Math.trunc`. Default `false`. */
	integer?: boolean;
	/**
	 * When `true`, only `Number()` parses are accepted (rejects "12abc").
	 * When `false`, `parseFloat` is used (more permissive). Default `false`.
	 */
	strict?: boolean;
}

export function readNumberParam(
	params: Record<string, unknown>,
	key: string,
	options: NumberParamOptions = {},
): number | undefined {
	const { required = false, label = key, integer = false, strict = false } = options;
	const raw = readParamRaw(params, key);
	let value: number | undefined;
	if (typeof raw === "number" && Number.isFinite(raw)) {
		value = raw;
	} else if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed) {
			const parsed = strict ? Number(trimmed) : Number.parseFloat(trimmed);
			if (Number.isFinite(parsed)) value = parsed;
		}
	}
	if (value === undefined) {
		if (required) throw new BrigadeToolInputError(`${label} required`);
		return undefined;
	}
	return integer ? Math.trunc(value) : value;
}

export function readBooleanParam(
	params: Record<string, unknown>,
	key: string,
	options: { required?: boolean; label?: string; default?: boolean } = {},
): boolean | undefined {
	const { required = false, label = key } = options;
	const raw = readParamRaw(params, key);
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "string") {
		const v = raw.trim().toLowerCase();
		if (v === "true" || v === "yes" || v === "1") return true;
		if (v === "false" || v === "no" || v === "0") return false;
	}
	if (raw === undefined || raw === null) {
		if (required) throw new BrigadeToolInputError(`${label} required`);
		return options.default;
	}
	throw new BrigadeToolInputError(`${label} must be a boolean`);
}

export function readStringArrayParam(
	params: Record<string, unknown>,
	key: string,
	options: StringParamOptions & { required: true },
): string[];
export function readStringArrayParam(
	params: Record<string, unknown>,
	key: string,
	options?: StringParamOptions,
): string[] | undefined;
export function readStringArrayParam(
	params: Record<string, unknown>,
	key: string,
	options: StringParamOptions = {},
): string[] | undefined {
	const { required = false, label = key } = options;
	const raw = readParamRaw(params, key);
	if (Array.isArray(raw)) {
		const values = raw
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		if (values.length === 0) {
			if (required) throw new BrigadeToolInputError(`${label} required`);
			return undefined;
		}
		return values;
	}
	if (typeof raw === "string") {
		const value = raw.trim();
		if (!value) {
			if (required) throw new BrigadeToolInputError(`${label} required`);
			return undefined;
		}
		return [value];
	}
	if (required) throw new BrigadeToolInputError(`${label} required`);
	return undefined;
}

/* ─────────────────────────── result builders ─────────────────────── */

/**
 * Stringify a payload for the `content` text block. Strings pass through
 * unchanged; everything else gets `JSON.stringify(payload, null, 2)`
 * with a graceful fallback to `String(payload)` for non-serializable
 * values (circular references, BigInt, etc.).
 */
export function stringifyToolPayload(payload: unknown): string {
	if (typeof payload === "string") return payload;
	try {
		const encoded = JSON.stringify(payload, null, 2);
		if (typeof encoded === "string") return encoded;
	} catch {
		// Fall through to String(payload) for non-serializable values.
	}
	return String(payload);
}

/**
 * Build a successful `AgentToolResult` with a single text `content`
 * block and the caller-supplied `details`. The model sees `text`;
 * the UI / logs see `details`.
 */
export function textResult<TDetails>(
	text: string,
	details: TDetails,
): AgentToolResult<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/**
 * Convenience for failure results. The `details` MUST include
 * `status: "failed"` so consumers can switch on it without parsing
 * free-form text. Returns the same shape as `textResult` — Pi
 * doesn't distinguish "success" vs "failure" results; the model
 * reads the content and adjusts. We expose this helper anyway to
 * keep the failure shape consistent across tools.
 */
export function failedTextResult<TDetails extends { status: "failed" }>(
	text: string,
	details: TDetails,
): AgentToolResult<TDetails> {
	return textResult(text, details);
}

/**
 * Stringify the payload and use both the stringified form (as `content`
 * text) AND the raw payload (as `details`). Useful for tools whose
 * result IS the payload — e.g., a config-getter returns `{key, value}`
 * and the model sees the JSON while the UI sees the structured object.
 */
export function payloadTextResult<TDetails>(
	payload: TDetails,
): AgentToolResult<TDetails> {
	return textResult(stringifyToolPayload(payload), payload);
}

/**
 * JSON-formatted result with the raw payload as `details`. Convenience
 * for tools that want the model to receive structured data as JSON
 * text without invoking the snake_case-aware stringifier.
 */
export function jsonResult(payload: unknown): AgentToolResult<unknown> {
	return textResult(JSON.stringify(payload, null, 2), payload);
}

/* ─────────────────────── streaming tool updates ─────────────────────── */

/**
 * Correlation context for a `withToolUpdates` wrapper. Held by reference
 * so the agent loop can populate it as soon as a turn binds to the wrapper
 * — the wrapper reads `ctxRef.value` lazily at emit-time, never at wrap-
 * time. All fields are optional: an empty context still emits events
 * (consumers that don't need correlation can subscribe regardless).
 */
export interface BrigadeToolUpdateContextRef {
	value: {
		runId?: string;
		agentId?: string;
		sessionKey?: string;
	};
}

/**
 * Wrap a Brigade tool so that every `onUpdate(partial)` callback Pi
 * invokes during `execute` is mirrored to the process-global agent
 * event bus as a `tool-update` event. The caller's own `onUpdate`
 * (when Pi or another wrapper supplies one) is invoked too — the
 * wrapper is a tee, not a sink.
 *
 * The returned object preserves the wrapped tool's `name`,
 * `description`, `parameters`, `label`, and any Brigade extension
 * fields (`ownerOnly`, `displaySummary`) via prototype-style spread.
 * Only `execute` is replaced. Thrown errors from the inner `execute`
 * propagate unchanged so retry / classification logic upstream sees
 * the original failure.
 */
export function withToolUpdates(
	tool: AnyBrigadeTool,
	ctxRef: BrigadeToolUpdateContextRef,
): AnyBrigadeTool {
	const innerExecute = tool.execute.bind(tool);
	const wrappedExecute: AnyBrigadeTool["execute"] = (
		toolCallId,
		params,
		signal,
		onUpdate,
	) => {
		const teedUpdate: AgentToolUpdateCallback = (partial) => {
			// Bus emit first so a throwing downstream consumer can't starve
			// the original caller. `emitAgentEvent` already catches listener
			// errors internally; this is belt-and-suspenders.
			try {
				const ctx = ctxRef.value;
				emitAgentEvent({
					type: "tool-update",
					runId: ctx.runId,
					agentId: ctx.agentId,
					sessionKey: ctx.sessionKey,
					toolName: tool.name,
					toolCallId,
					payload: partial,
				});
			} catch {
				// Defensive: never let bus plumbing break a tool's own
				// update channel. The bus itself is silent on listener
				// errors, so reaching here would require a defect in the
				// bus module — still, swallow so the caller's onUpdate
				// always runs.
			}
			// Forward to the original caller (if any). A throwing caller
			// is THEIR bug; let it propagate up through Pi the same way
			// it would without the wrapper.
			if (onUpdate) onUpdate(partial);
		};
		return innerExecute(toolCallId, params, signal, teedUpdate);
	};

	// Spread first so any future Pi/Brigade tool fields ride along
	// automatically; override `execute` last.
	return {
		...tool,
		execute: wrappedExecute,
	};
}

/* ─────────────────────────── owner-only gating ─────────────────────────── */

/**
 * Wrap a Brigade tool so that, when the caller is NOT the workspace owner,
 * `execute` throws a `BrigadeToolAuthorizationError` carrying
 * `OWNER_ONLY_TOOL_ERROR` BEFORE the inner tool body runs. When the caller
 * IS the owner, the wrapper short-circuits and returns the tool reference
 * unchanged so there is zero extra indirection on the hot path.
 *
 * The guard is intentionally enforced inside `execute` (not at registration
 * time) so the same wrapped tool object can be safely passed to Pi's
 * `customTools` slot regardless of who initiated the turn — the gating
 * decision is sender-scoped, not tool-scoped. The wrapper is a no-op for
 * tools that don't declare `ownerOnly: true` so callers can apply it
 * blindly across the tool list without per-tool branching.
 *
 * The thrown error is surfaced to the model the same way any other tool
 * failure is (Pi catches and forwards `.message`); the model self-corrects
 * by abandoning the call. The 403 status on the error class is
 * informational for any UI / log layer that wants to distinguish auth
 * refusals from generic input failures.
 */
export function wrapOwnerOnlyToolExecution(
	tool: AnyBrigadeTool,
	senderIsOwner: boolean,
): AnyBrigadeTool {
	// Owner OR non-ownerOnly tool: nothing to do. Return the original ref so
	// the caller's identity tests (===) still match and there's no allocation
	// for the common case.
	if (senderIsOwner) return tool;
	if (!tool.ownerOnly) return tool;

	const refusedExecute: AnyBrigadeTool["execute"] = async () => {
		throw new BrigadeToolAuthorizationError(OWNER_ONLY_TOOL_ERROR);
	};

	// Spread first so every Pi/Brigade tool field rides along (label,
	// description, parameters, ownerOnly, displaySummary, prepareArguments,
	// executionMode); override `execute` last.
	return {
		...tool,
		execute: refusedExecute,
	};
}

/**
 * Default per-tool execution timeout. The cron tool's `add` action runs in
 * tens of milliseconds; recall_memory / read_memory in single-digit
 * seconds; spawn_agent in tens-of-seconds at worst. 60 seconds is a generous
 * cap — well above the slow-path tail of every Brigade-native tool and
 * below the threshold at which a stuck tool starts to look like a
 * gateway hang to the operator.
 *
 * Pi's built-in tools (bash, read, write, edit, grep, find, ls) are NOT
 * wrapped here — their `execute` is owned by Pi and timeouts there go
 * through the bash gate / Pi's own controls.
 */
const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 60 * 1000;

/**
 * Wrap a Brigade-native tool's `execute` with a hard timeout. If the
 * underlying tool's promise doesn't settle within `timeoutMs`, the wrapped
 * call rejects with a `BrigadeToolTimeoutError` — Pi surfaces the
 * message to the model as a tool failure, which is FAR better than the
 * model (and the operator's TUI) sitting on a spinning `↯` indicator
 * forever while the tool quietly hangs.
 *
 * Note this is BEST-EFFORT cancellation: the underlying tool's promise
 * may still be running in the background (we can't kill JS promises).
 * What the timeout DOES guarantee is that the agent loop gets unblocked
 * and the model can continue (e.g. tell the user "the tool timed out,
 * please try again"). The orphaned promise's eventual resolution is
 * ignored.
 */
export function wrapToolExecutionTimeout(
	tool: AnyBrigadeTool,
	timeoutMs: number = DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
	/**
	 * Optional per-call budget resolver, consulted with the call's params at
	 * execute time. Lets tools whose LEGITIMATE runtime depends on their
	 * arguments (the spawn tools await children that run up to their own
	 * `timeoutSeconds`) size the watchdog per call instead of being killed
	 * by the blanket default. Invalid / missing return values fall back to
	 * `timeoutMs`.
	 */
	resolveTimeoutMs?: (toolArgs: unknown) => number | undefined,
): AnyBrigadeTool {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return tool;
	const originalExecute = tool.execute.bind(tool);
	const timedExecute: AnyBrigadeTool["execute"] = async (...args) => {
		let effectiveTimeoutMs = timeoutMs;
		if (resolveTimeoutMs) {
			try {
				const resolved = resolveTimeoutMs(args[1]);
				if (typeof resolved === "number" && Number.isFinite(resolved) && resolved > 0) {
					effectiveTimeoutMs = resolved;
				}
			} catch {
				/* resolver failure → default budget */
			}
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				originalExecute(...args),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						reject(
							new BrigadeToolTimeoutError(
								`tool "${tool.name}" did not return within ${Math.round(
									effectiveTimeoutMs / 1000,
								)}s — ` +
									`assume the call hung. Tell the operator and ask them ` +
									`what they want to do; do NOT retry the same call back-to-back.`,
							),
						);
					}, effectiveTimeoutMs);
					if (typeof timer.unref === "function") timer.unref();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	return {
		...tool,
		execute: timedExecute,
	};
}

/** 504-class — surfaced to the model so it stops waiting on the tool result. */
export class BrigadeToolTimeoutError extends Error {
	readonly status: number = 504;
	constructor(message: string) {
		super(message);
		this.name = "BrigadeToolTimeoutError";
	}
}
