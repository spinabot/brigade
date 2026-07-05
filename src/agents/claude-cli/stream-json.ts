// Wire types + a line parser for the Claude Code CLI's `--output-format
// stream-json --include-partial-messages --verbose` protocol.
//
// The CLI emits one JSON object per line (NDJSON) on stdout. The frames we
// care about, in the order a normal turn produces them:
//
//   {"type":"system","subtype":"init", ...}          — session bootstrap (carries session_id)
//   {"type":"stream_event","event":{...}}            — a raw Anthropic SSE event (partial streaming)
//   {"type":"assistant","message":{...}}             — a COMPLETE assistant message block
//   {"type":"rate_limit_event","rate_limit_info":{}} — plan-window telemetry (informational)
//   {"type":"result","subtype":"success"|"error_*",} — terminal frame (final text, usage, cost)
//
// The `stream_event.event` payloads are the SAME shapes the Anthropic
// Messages streaming API emits (message_start / content_block_start /
// content_block_delta / content_block_stop / message_delta / message_stop),
// so the delta handling in `stream.ts` mirrors pi-ai's own anthropic
// provider. When partial frames are unavailable we fall back to the whole
// `assistant`/`result` message — the parser surfaces both so the consumer
// can degrade gracefully.

/* ─────────────────────────── wire frame types ─────────────────────────── */

/** A raw Anthropic streaming SSE event, as wrapped in a `stream_event` frame. */
export interface AnthropicStreamEvent {
	type?: string;
	// message_start
	message?: {
		usage?: AnthropicUsage;
		[k: string]: unknown;
	};
	// content_block_start / _stop
	index?: number;
	content_block?: {
		type?: "text" | "thinking" | "tool_use" | string;
		id?: string;
		name?: string;
		input?: unknown;
		[k: string]: unknown;
	};
	// content_block_delta
	delta?: {
		type?: "text_delta" | "thinking_delta" | "input_json_delta" | "signature_delta" | string;
		text?: string;
		thinking?: string;
		partial_json?: string;
		signature?: string;
		stop_reason?: string | null;
		[k: string]: unknown;
	};
	// message_delta
	usage?: AnthropicUsage;
}

export interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	[k: string]: unknown;
}

/** A complete assistant message block (`type:"assistant"`). */
export interface AssistantFrameMessage {
	id?: string;
	role?: string;
	model?: string;
	stop_reason?: string | null;
	content?: Array<{
		type?: "text" | "thinking" | "tool_use" | string;
		text?: string;
		thinking?: string;
		signature?: string;
		id?: string;
		name?: string;
		input?: unknown;
		[k: string]: unknown;
	}>;
	usage?: AnthropicUsage;
	[k: string]: unknown;
}

/** The terminal `type:"result"` frame. */
export interface ResultFrame {
	type: "result";
	subtype?: string; // "success" | "error_max_turns" | "error_during_execution" | ...
	is_error?: boolean;
	result?: string; // final assistant text (success)
	stop_reason?: string | null;
	session_id?: string;
	total_cost_usd?: number;
	usage?: AnthropicUsage & { service_tier?: string };
	// Some CLI builds carry an explicit error message on failure.
	error?: string;
	message?: string;
	[k: string]: unknown;
}

/** Discriminated union of every frame `stream.ts` acts on. */
export type ClaudeCliFrame =
	| { type: "system"; subtype?: string; session_id?: string; [k: string]: unknown }
	| { type: "stream_event"; event?: AnthropicStreamEvent; session_id?: string; [k: string]: unknown }
	| { type: "assistant"; message?: AssistantFrameMessage; session_id?: string; [k: string]: unknown }
	| { type: "rate_limit_event"; rate_limit_info?: RateLimitInfo; [k: string]: unknown }
	| ResultFrame
	| { type: string; [k: string]: unknown };

export interface RateLimitInfo {
	status?: string; // "allowed" | "rejected" | ...
	resetsAt?: number; // epoch SECONDS
	rateLimitType?: string; // "five_hour" | "seven_day" | ...
	overageStatus?: string; // "rejected" | "allowed"
	overageDisabledReason?: string; // "org_level_disabled" | ...
	isUsingOverage?: boolean;
	[k: string]: unknown;
}

/* ─────────────────────────── line parser ─────────────────────────── */

/**
 * Parse a single stdout line into a typed frame, or `null` for a blank or
 * unparseable line (never throws — a stray non-JSON diagnostic line must not
 * abort the turn). The CLI occasionally prefixes debug text on stderr, but on
 * stdout with `--output-format stream-json` every meaningful line is a JSON
 * object; anything else is skipped.
 */
export function parseClaudeCliLine(line: string): ClaudeCliFrame | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed[0] !== "{") return null;
	try {
		const obj = JSON.parse(trimmed) as ClaudeCliFrame;
		if (!obj || typeof obj !== "object" || typeof obj.type !== "string") return null;
		return obj;
	} catch {
		return null;
	}
}

/* ─────────────────────────── frame helpers ─────────────────────────── */

/** Extract the session id from any frame that carries one (system/result/stream). */
export function frameSessionId(frame: ClaudeCliFrame): string | undefined {
	const sid = (frame as { session_id?: unknown }).session_id;
	return typeof sid === "string" && sid.length > 0 ? sid : undefined;
}

/**
 * Classify the terminal `result` frame. Returns:
 *   - "success"       — a normal completion.
 *   - "limit"         — a plan-usage / overage rejection ("out of extra usage",
 *                       usage-limit reached). Callers map this to the
 *                       subscription_limit retry reason.
 *   - "auth"          — the login is dead: expired/revoked token, needs re-auth.
 *                       Callers surface a "re-run `brigade login claude-cli`" hint.
 *   - "error"         — any other failure subtype.
 * Pure — inspects subtype + is_error + any embedded message text.
 */
export function classifyResultFrame(frame: ResultFrame): "success" | "limit" | "auth" | "error" {
	const isError = frame.is_error === true || (frame.subtype ?? "").startsWith("error");
	if (!isError && (frame.subtype === "success" || frame.subtype === undefined)) return "success";
	const text = `${frame.subtype ?? ""} ${frame.error ?? ""} ${frame.message ?? ""} ${frame.result ?? ""}`;
	if (/out of extra usage|usage limit|claude\.ai\/settings\/usage|limit will reset/i.test(text)) {
		return "limit";
	}
	// Dead-login signals: the binary's own login has expired/been revoked and it
	// can't refresh headlessly. Distinct from a usage limit — the fix is re-auth,
	// not waiting for a reset.
	if (
		/\b401\b|unauthori[sz]ed|authenticat(?:e|ion)|invalid[_ ]grant|token (?:expired|revoked|invalid)|refresh[_ ]token|(?:please )?(?:re-?)?login|not (?:logged|signed) in|run `?claude`? login|session (?:expired|invalid)/i.test(
			text,
		)
	) {
		return "auth";
	}
	return isError ? "error" : "success";
}

/** Sum an Anthropic usage block into {input,output} totals (cache folded into input). */
export function foldUsage(usage: AnthropicUsage | undefined): { input: number; output: number } {
	if (!usage) return { input: 0, output: 0 };
	const input =
		(usage.input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0);
	return { input, output: usage.output_tokens ?? 0 };
}
