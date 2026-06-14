/**
 * Shared helpers for the sessions tool surface (Step 19).
 *
 * Brand-scrubbed lift of upstream's `src/agents/tools/sessions-*` helpers.
 * One file because the cross-tool surface is small (~400 LOC); splitting
 * would just move declarations between files without saving any reads.
 *
 * The four sessions tools (`sessions_send`, `sessions_spawn`,
 * `sessions_list`, `sessions_history`) all reach for the same primitives:
 *
 *   - History text sanitizer + 4 KB-per-block / 80 KB-total caps
 *   - Tool-message stripper (drop tool-call rows from history)
 *   - JSON-byte-cap enforcement for the per-call result envelope
 *   - Sender-redactor (strip credentials/API keys before exposing history)
 *   - Visibility resolution + agent-to-agent allowlist matcher
 *   - Common error classes that map to tool-result error shapes
 *
 * Nothing here issues gateway calls — the tools receive a `GatewayCaller`
 * (from Step 18 — `agents/gateway-call.ts`) and call out from their own
 * execute bodies. Keeps the helper layer testable + tool-agnostic.
 */

import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";

export const SESSIONS_HISTORY_MAX_BYTES = 80 * 1024;
export const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4_000;

/* ─── Error classes ─────────────────────────────────────────────── */

/**
 * Sessions-tool-specific input / authorization errors. Prefixed with
 * `Sessions*` to avoid colliding with Brigade's existing
 * `BrigadeToolInputError` / `BrigadeToolAuthorizationError` in
 * `src/agents/tools/common.ts` — the two surfaces serve different layers
 * (sessions tools' execute bodies catch these and return error envelopes
 * via `jsonToolResult`, while Brigade's existing tools wrap their errors
 * inline via `wrapOwnerOnlyToolExecution`).
 */
export class SessionsToolInputError extends Error {
	readonly status: number = 400;
	constructor(message: string) {
		super(message);
		this.name = "SessionsToolInputError";
	}
}

export class SessionsToolAuthorizationError extends SessionsToolInputError {
	override readonly status = 403;
	constructor(message: string) {
		super(message);
		this.name = "SessionsToolAuthorizationError";
	}
}

/** @deprecated retained for backwards compatibility; use `SessionsToolInputError`. */
export const ToolInputError = SessionsToolInputError;
/** @deprecated retained for backwards compatibility; use `SessionsToolAuthorizationError`. */
export const ToolAuthorizationError = SessionsToolAuthorizationError;

/* ─── Text utility ──────────────────────────────────────────────── */

/**
 * UTF-16-safe truncation. Preserves surrogate-pair boundaries so the
 * returned string is always valid UTF-16 (no orphan lead/trail
 * surrogates), even at the cut point.
 */
export function truncateUtf16Safe(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	let end = maxChars;
	// Don't split a surrogate pair.
	if (end > 0) {
		const code = value.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	}
	return value.slice(0, end);
}

const SENSITIVE_PATTERNS: RegExp[] = [
	// API keys / bearer tokens (long alphanumeric runs with prefixes)
	/\b(?:sk|pk|api[_-]?key|bearer|token)[-_=:\s]+[A-Za-z0-9_\-]{16,}\b/gi,
	// Standalone long base64-ish runs
	/\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
	// Generic password-y assignments
	/\bpassword[\s:=]+\S+/gi,
	// Github / Slack / common service tokens by prefix
	/\bghp_[A-Za-z0-9]{20,}\b/g,
	/\bxoxb-[A-Za-z0-9-]{10,}\b/g,
	/\bxoxp-[A-Za-z0-9-]{10,}\b/g,
];

/** Best-effort credential redaction for history text. NOT a security boundary. */
export function redactSensitiveText(input: string): string {
	let out = input;
	for (const re of SENSITIVE_PATTERNS) {
		out = out.replace(re, "[redacted]");
	}
	return out;
}

/* ─── History sanitizers ────────────────────────────────────────── */

export function truncateHistoryText(text: string): {
	text: string;
	truncated: boolean;
	redacted: boolean;
} {
	const sanitized = redactSensitiveText(text);
	const redacted = sanitized !== text;
	if (sanitized.length <= SESSIONS_HISTORY_TEXT_MAX_CHARS) {
		return { text: sanitized, truncated: false, redacted };
	}
	const cut = truncateUtf16Safe(sanitized, SESSIONS_HISTORY_TEXT_MAX_CHARS);
	return { text: `${cut}\n…(truncated)…`, truncated: true, redacted };
}

function readStringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Sanitize ONE content block (text, image, thinking, tool-use payload, etc.). */
export function sanitizeHistoryContentBlock(block: unknown): {
	block: unknown;
	truncated: boolean;
	redacted: boolean;
} {
	if (!block || typeof block !== "object") {
		return { block, truncated: false, redacted: false };
	}
	const entry = { ...(block as Record<string, unknown>) };
	let truncated = false;
	let redacted = false;
	const type = typeof entry.type === "string" ? entry.type : "";
	if (typeof entry.text === "string") {
		const res = truncateHistoryText(entry.text);
		entry.text = res.text;
		truncated ||= res.truncated;
		redacted ||= res.redacted;
	}
	if (type === "thinking") {
		if (typeof entry.thinking === "string") {
			const res = truncateHistoryText(entry.thinking);
			entry.thinking = res.text;
			truncated ||= res.truncated;
			redacted ||= res.redacted;
		}
		if ("thinkingSignature" in entry) {
			delete entry.thinkingSignature;
			truncated = true;
		}
	}
	if (typeof entry.partialJson === "string") {
		const res = truncateHistoryText(entry.partialJson);
		entry.partialJson = res.text;
		truncated ||= res.truncated;
		redacted ||= res.redacted;
	}
	if (type === "image") {
		const data = readStringValue(entry.data);
		const bytes = data ? data.length : undefined;
		if ("data" in entry) {
			delete entry.data;
			truncated = true;
		}
		(entry as Record<string, unknown>).omitted = true;
		if (bytes !== undefined) (entry as Record<string, unknown>).bytes = bytes;
	}
	return { block: entry, truncated, redacted };
}

/** Sanitize ONE message — strips heavy fields + sanitizes each content block. */
export function sanitizeHistoryMessage(message: unknown): {
	message: unknown;
	truncated: boolean;
	redacted: boolean;
} {
	if (!message || typeof message !== "object") {
		return { message, truncated: false, redacted: false };
	}
	const entry = { ...(message as Record<string, unknown>) };
	let truncated = false;
	let redacted = false;
	for (const heavy of ["details", "usage", "cost"] as const) {
		if (heavy in entry) {
			delete entry[heavy];
			truncated = true;
		}
	}
	if (typeof entry.content === "string") {
		const res = truncateHistoryText(entry.content);
		entry.content = res.text;
		truncated ||= res.truncated;
		redacted ||= res.redacted;
	} else if (Array.isArray(entry.content)) {
		const updated = entry.content.map((block) => sanitizeHistoryContentBlock(block));
		entry.content = updated.map((item) => item.block);
		truncated ||= updated.some((item) => item.truncated);
		redacted ||= updated.some((item) => item.redacted);
	}
	if (typeof entry.text === "string") {
		const res = truncateHistoryText(entry.text);
		entry.text = res.text;
		truncated ||= res.truncated;
		redacted ||= res.redacted;
	}
	return { message: entry, truncated, redacted };
}

/** Drop tool-call + tool-result messages (default for `includeTools: false`). */
export function stripToolMessages(messages: readonly unknown[]): unknown[] {
	return messages.filter((msg) => {
		if (!msg || typeof msg !== "object") return true;
		const role = (msg as { role?: unknown }).role;
		return role !== "toolResult" && role !== "tool";
	});
}

/** Byte-aware JSON size estimate (UTF-8). */
export function jsonUtf8Bytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

/**
 * Hard byte cap for the per-call envelope. If the message list still
 * exceeds the cap, fall back to the most recent message — and if even
 * THAT is too big, swap in a placeholder so the tool never returns a
 * response that overflows the wire budget.
 */
export function enforceSessionsHistoryHardCap(params: {
	items: unknown[];
	bytes: number;
	maxBytes: number;
}): { items: unknown[]; bytes: number; hardCapped: boolean } {
	if (params.bytes <= params.maxBytes) {
		return { items: params.items, bytes: params.bytes, hardCapped: false };
	}
	const last = params.items.at(-1);
	const lastOnly = last ? [last] : [];
	const lastBytes = jsonUtf8Bytes(lastOnly);
	if (lastBytes <= params.maxBytes) {
		return { items: lastOnly, bytes: lastBytes, hardCapped: true };
	}
	const placeholder = [
		{ role: "assistant", content: "[sessions_history omitted: message too large]" },
	];
	return { items: placeholder, bytes: jsonUtf8Bytes(placeholder), hardCapped: true };
}

/* ─── Visibility + agent-to-agent policy ────────────────────────── */

export type SessionToolsVisibility = "self" | "tree" | "agent" | "all";

export type SessionToolAccessAction = "history" | "send" | "list" | "status";

export type SessionToolAccessResult =
	| { allowed: true }
	| { allowed: false; error: string; status: "forbidden" };

export type AgentToAgentPolicy = {
	enabled: boolean;
	matchesAllow: (agentId: string) => boolean;
	isAllowed: (requesterAgentId: string, targetAgentId: string) => boolean;
};

export interface AgentToAgentPolicyInput {
	enabled: boolean;
	allow: readonly string[];
}

/**
 * Build the A2A policy from a config snapshot. The Brigade gateway
 * passes `{ enabled, allow }` resolved from `cfg.tools.agentToAgent`;
 * tests can inject a stub directly without going through config.
 */
export function createAgentToAgentPolicy(input: AgentToAgentPolicyInput): AgentToAgentPolicy {
	const { enabled, allow } = input;
	const matchesAllow = (agentId: string): boolean => {
		if (!allow || allow.length === 0) return true;
		return allow.some((pattern) => {
			const raw = pattern?.trim() ?? "";
			if (!raw) return false;
			if (raw === "*") return true;
			if (!raw.includes("*")) return raw === agentId;
			const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const re = new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`, "i");
			return re.test(agentId);
		});
	};
	const isAllowed = (requesterAgentId: string, targetAgentId: string): boolean => {
		if (requesterAgentId === targetAgentId) return true;
		if (!enabled) return false;
		return matchesAllow(requesterAgentId) && matchesAllow(targetAgentId);
	};
	return { enabled, matchesAllow, isAllowed };
}

/**
 * Decide whether a requester session may take the given action on a
 * target session. The check folds visibility + A2A policy + parent-child
 * spawned-tree containment in one place.
 *
 * `spawnedKeys` is the set of session keys spawned by the requester
 * (transitively) — the caller is expected to compute it once and reuse
 * across multiple `checkSessionToolAccess` calls during one tool
 * invocation.
 */
export function checkSessionToolAccess(params: {
	action: SessionToolAccessAction;
	requesterSessionKey: string;
	targetSessionKey: string;
	visibility: SessionToolsVisibility;
	a2aPolicy: AgentToAgentPolicy;
	spawnedKeys?: ReadonlySet<string>;
}): SessionToolAccessResult {
	const { action, requesterSessionKey, targetSessionKey, visibility, a2aPolicy } = params;
	if (requesterSessionKey === targetSessionKey) return { allowed: true };
	const requesterAgentId = resolveAgentIdFromSessionKey(requesterSessionKey);
	const targetAgentId = resolveAgentIdFromSessionKey(targetSessionKey);
	const crossAgent = targetAgentId !== requesterAgentId;
	if (crossAgent) {
		// Self-documenting refusals: each carries the EXACT operator remedy.
		// Production 2026-06-11 — without this the model guessed wrong causes
		// ("hot-reload issue") instead of naming the real knob. The remedy is
		// addressed to the OPERATOR by design: enabling cross-agent reach is
		// a security decision the agent must surface, not silently apply.
		if (visibility !== "all") {
			return forbidden(
				action,
				'cross-agent visibility not enabled (session.sessionTools.visibility is not "all"). When the operator asks you to enable cross-agent messaging, call manage_access set {visibility: "all"} then RETRY this sessions_send in the same turn — it re-checks against the new setting and goes through. The change is live in-memory; NEVER tell the operator to restart the gateway. Do NOT change it unasked.',
			);
		}
		if (!a2aPolicy.enabled) {
			return forbidden(
				action,
				"agent-to-agent messaging disabled (session.agentToAgent.enabled is false). When the operator asks, call manage_access set {a2aEnabled: true} (it seeds a wide-open allow list if none exists) then RETRY this sessions_send in the same turn. The change is live — NEVER suggest a gateway restart. Do NOT change it unasked.",
			);
		}
		if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
			return forbidden(
				action,
				`agent ${targetAgentId} not reachable from ${requesterAgentId} under the current policy. With an org configured, edges follow the org graph (escalate up, assign down, same-department lateral, top↔all; cross-department lateral is closed) — route via the shared manager. A non-org agent like main reaches org members only under explicit/open mode: when the operator asks, call manage_access set {a2aMode: "explicit"}. Do NOT change it unasked.`,
			);
		}
		return { allowed: true };
	}
	if (visibility === "self") {
		return forbidden(action, "sessions tool visibility is self-only");
	}
	if (visibility === "tree") {
		if (!params.spawnedKeys?.has(targetSessionKey)) {
			return forbidden(action, "target session is not in the spawned tree");
		}
	}
	return { allowed: true };
}

function forbidden(action: SessionToolAccessAction, reason: string): SessionToolAccessResult {
	return {
		allowed: false,
		status: "forbidden",
		error: `sessions_${action} forbidden: ${reason}`,
	};
}

/* ─── Tool-result envelope ──────────────────────────────────────── */

export interface ToolResultEnvelope {
	content: string;
	details?: Record<string, unknown>;
}

/** Build the standard Pi AgentTool result for JSON payloads. */
export function jsonToolResult(payload: unknown): ToolResultEnvelope {
	return { content: JSON.stringify(payload, null, 2), details: { payload } };
}

/* ─── Tool-description presets ──────────────────────────────────── */

export const SESSIONS_LIST_TOOL_DISPLAY_SUMMARY =
	"List visible sessions and optional recent messages.";
export const SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY =
	"Read sanitized message history for a visible session.";
export const SESSIONS_SEND_TOOL_DISPLAY_SUMMARY =
	"Send a message to another visible session.";
export const SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY = "Spawn a sub-agent session.";

export function describeSessionsListTool(): string {
	return [
		"List visible sessions with optional filters for kind, recent activity, and last messages.",
		"Use this to discover a target session before calling sessions_history or sessions_send.",
	].join(" ");
}

export function describeSessionsHistoryTool(): string {
	return [
		"Fetch sanitized message history for a visible session.",
		"Supports limits and optional tool messages; use this to inspect another session before replying, debugging, or resuming work.",
	].join(" ");
}

export function describeSessionsSendTool(): string {
	return [
		"Delegate a question to another agent in the crew. The peer agent runs the message in ITS own session (its persona, skills, memory) and returns its reply to you — you can then relay to the user.",
		"OUTCOMES — exactly two, read them carefully:",
		'  status "ok": the peer\'s run FINISHED and `reply` is its complete, final answer. Relay it. If the reply is a bare acknowledgement with no deliverable, the peer violated its contract — send a follow-up demanding the deliverable.',
		'  status "accepted": the peer is STILL WORKING past your wait window. Its finished reply will be DELIVERED to your session automatically — you will see "A2A reply from <peer>: …" on a later turn; relay it to the user THEN. Meanwhile tell the user the work is in progress. Do NOT fabricate results, do NOT poll sessions_history, do NOT promise a time.',
		"For long tasks you can raise timeoutSeconds (default 90) to wait inline instead of taking the async path.",
		"Two shorthand shapes:",
		'  sessions_send({ agentId: "<peer-id>", message: "..." })  — auto-targets the peer\'s main session (the common case)',
		'  sessions_send({ sessionKey: "agent:<peer-id>:main", message: "..." })  — when you need an explicit session',
		"This is the canonical delegation pattern when the user asks YOU (the main/orchestrator agent) for something a specialist peer handles better.",
		"Do NOT use sessions_spawn for delegation — that creates a sub-agent under YOUR session, not a peer hand-off.",
		"Do NOT tell the user to type /agent <id> when they ask you to handle a delegation request — use this tool to fetch the peer's answer and relay it.",
		"Tell the user to type /agent <id> ONLY when they explicitly say 'let me talk to <agent>' / 'switch me to <agent>' — that's user-driven, not delegation.",
	].join(" ");
}

export function describeSessionsSpawnTool(): string {
	return [
		'ASYNC fire-and-forget. Returns IMMEDIATELY with {status:"accepted", childSessionKey, runId}. The child runs in its own session lane.',
		"WHEN the child finishes, its final assistant reply is DELIVERED into YOUR session transcript as a system message (you will see it on your next turn).",
		"Do NOT call sessions_history immediately - the result has not landed yet. Use sessions_spawn for parallel fan-out where you do not need the result THIS turn.",
		"For a blocking call that returns the child's reply as the tool result this turn, use spawn_agent instead.",
		'mode="run" is one-shot; mode="session" keeps the child available for thread follow-up via sessions_send. Sub-agents inherit the parent workspace directory automatically.',
	].join(" ");
}
