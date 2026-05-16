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
 * Mirrors OpenClaw's `src/agents/tools/common.ts:72-199`. Pure functions;
 * no module-level state.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

/**
 * 400-class error for malformed / missing tool arguments. Pi catches
 * thrown errors from `execute` and surfaces them as tool failures to
 * the model — the model sees the `.message` string and can self-correct
 * on the next turn. The status code is informational only (Brigade has
 * no HTTP transport between the tool and Pi yet).
 *
 * Mirrors OpenClaw's `ToolInputError` at `src/agents/tools/common.ts:38`.
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
 *
 * Mirrors OpenClaw's `ToolAuthorizationError` at
 * `src/agents/tools/common.ts:47`.
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
 *
 * Mirrors OpenClaw's `readSnakeCaseParamRaw` at `src/param-key.ts`.
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
 *
 * Mirrors OpenClaw's `textResult` at `src/agents/tools/common.ts:243`.
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
 *
 * Mirrors OpenClaw's `failedTextResult` at `src/agents/tools/common.ts:255`.
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
 *
 * Mirrors OpenClaw's `payloadTextResult` at `src/agents/tools/common.ts:262`.
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
 *
 * Mirrors OpenClaw's `jsonResult` at `src/agents/tools/common.ts:266`.
 */
export function jsonResult(payload: unknown): AgentToolResult<unknown> {
	return textResult(JSON.stringify(payload, null, 2), payload);
}
