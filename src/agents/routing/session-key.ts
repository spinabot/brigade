/**
 * Session-key builders + canonical-shape classifier.
 *
 * Brand-scrubbed lift of the upstream reference codebase's
 * `src/routing/session-key.ts`. Every algorithm preserved verbatim — the
 * dmScope branching, identity-link resolution, key-shape classifier,
 * thread-suffix assembler, and the agent-id sanitiser are the source of
 * truth for routing + lane resolution + cross-session tools.
 *
 * What's different from the upstream file:
 *   - `ChatType` is declared inline (Brigade has no `channels/chat-type.js`
 *     module; the type stays a string-literal union of the three values
 *     the builder actually branches on).
 *   - `DEFAULT_AGENT_ID` is re-exported from Brigade's existing
 *     `config/paths.js` (single source of truth) instead of redeclared
 *     here. The re-export keeps the upstream import path working.
 *   - `buildAgentMainSessionKey` (upstream name) is exported as
 *     `buildBrigadeMainSessionKey` per the locked design's R2 Leak #2 fix.
 *     `buildAgentMainSessionKey` is kept as a deprecated alias so any
 *     subsequent OC-port lift compiles without a rename pass.
 *   - `isAcpSessionKey` is NOT re-exported. Brigade is subagent-only;
 *     the ACP harness runtime is permanently dropped (R2 Leak #10).
 *
 * Public surface (consumed by route resolver, lane engine, sessions_*
 * tools, gateway RPC, channel manager):
 *   - `DEFAULT_AGENT_ID`, `DEFAULT_MAIN_KEY`
 *   - `SessionKeyShape` type
 *   - `parseAgentSessionKey`, `getSubagentDepth`, `isCronSessionKey`,
 *     `isSubagentSessionKey` (re-exported from session-key-utils)
 *   - `DEFAULT_ACCOUNT_ID`, `normalizeAccountId`, `normalizeOptionalAccountId`
 *     (re-exported from account-id)
 *   - `normalizeAgentId`, `isValidAgentId`, `sanitizeAgentId`
 *   - `normalizeMainKey`, `classifySessionKeyShape`,
 *     `resolveAgentIdFromSessionKey`, `scopedHeartbeatWakeOptions`,
 *     `toAgentRequestSessionKey`, `toAgentStoreSessionKey`
 *   - `buildBrigadeMainSessionKey` (alias: `buildAgentMainSessionKey`)
 *   - `buildAgentPeerSessionKey`
 *   - `buildGroupHistoryKey`, `resolveThreadSessionKeys`
 *
 * `resolveLinkedPeerId` lives in its sibling `identity-links.ts` (Brigade
 * promotes it from the upstream's private helper into its own module so
 * the channel manager + cross-session send tool can share ONE
 * implementation). The peer-key builder below imports it from there.
 */

import { parseAgentSessionKey, type ParsedAgentSessionKey } from "../../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "./account-id.js";
// DEFAULT_AGENT_ID is Brigade's existing constant — single source of truth.
import { DEFAULT_AGENT_ID } from "../../config/paths.js";
// Cross-channel canonical-peer resolver (Step 5). The upstream layout had
// this function inline as a private helper; Brigade promotes it to its own
// module so the channel manager + cross-session send tool can share ONE
// implementation. The builder below imports it from the new location.
import { resolveLinkedPeerId } from "./identity-links.js";

export {
	getSubagentDepth,
	isCronSessionKey,
	isSubagentSessionKey,
	parseAgentSessionKey,
	type ParsedAgentSessionKey,
} from "../../sessions/session-key-utils.js";
export {
	DEFAULT_ACCOUNT_ID,
	normalizeAccountId,
	normalizeOptionalAccountId,
} from "./account-id.js";
export { DEFAULT_AGENT_ID } from "../../config/paths.js";

export const DEFAULT_MAIN_KEY = "main";
export type SessionKeyShape = "missing" | "agent" | "legacy_or_alias" | "malformed_agent";

/**
 * Per-conversation chat kind discriminator. Mirrors the values the upstream
 * channels/chat-type module exports; Brigade keeps the type local so the
 * builder doesn't drag a 1-line module along.
 */
export type ChatType = "direct" | "group" | "channel";

// Pre-compiled regex (same as upstream — agent-id validation + sanitisation)
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

function normalizeToken(value: string | undefined | null): string {
	return normalizeLowercaseStringOrEmpty(value);
}

/**
 * When a heartbeat wake fires for a non-main session, propagate the
 * `sessionKey` so the wake handler dispatches to the right lane.
 * Main-session wakes don't carry the key (default behaviour).
 */
export function scopedHeartbeatWakeOptions<T extends object>(
	sessionKey: string,
	wakeOptions: T,
): T | (T & { sessionKey: string }) {
	return parseAgentSessionKey(sessionKey) ? { ...wakeOptions, sessionKey } : wakeOptions;
}

export function normalizeMainKey(value: string | undefined | null): string {
	return normalizeLowercaseStringOrEmpty(value) || DEFAULT_MAIN_KEY;
}

/**
 * Turn a STORE session key (`agent:main:whatsapp:direct:+91…`) into the
 * REQUEST session key (`whatsapp:direct:+91…`) the gateway RPC accepts.
 * Empty / unparseable input passes through unchanged.
 */
export function toAgentRequestSessionKey(storeKey: string | undefined | null): string | undefined {
	const raw = (storeKey ?? "").trim();
	if (!raw) {
		return undefined;
	}
	return parseAgentSessionKey(raw)?.rest ?? raw;
}

/**
 * Inverse of `toAgentRequestSessionKey`. Promotes a request key to the
 * canonical store key, handling main aliases (`""`, `"main"`) + already-
 * prefixed strings + agent overrides correctly.
 */
export function toAgentStoreSessionKey(params: {
	agentId: string;
	requestKey: string | undefined | null;
	mainKey?: string | undefined;
}): string {
	const raw = (params.requestKey ?? "").trim();
	const lowered = normalizeLowercaseStringOrEmpty(raw);
	if (!raw || lowered === DEFAULT_MAIN_KEY) {
		return buildBrigadeMainSessionKey({ agentId: params.agentId, mainKey: params.mainKey });
	}
	const parsed = parseAgentSessionKey(raw);
	if (parsed) {
		return `agent:${parsed.agentId}:${parsed.rest}`;
	}
	if (lowered.startsWith("agent:")) {
		return lowered;
	}
	return `agent:${normalizeAgentId(params.agentId)}:${lowered}`;
}

export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
	const parsed = parseAgentSessionKey(sessionKey);
	return normalizeAgentId(parsed?.agentId ?? DEFAULT_AGENT_ID);
}

/**
 * Classify what kind of string a caller passed as a "session key".
 *   - `missing`           → empty / whitespace
 *   - `agent`             → canonical `agent:<id>:<rest>` (parses cleanly)
 *   - `legacy_or_alias`   → no `agent:` prefix; a legacy short key or alias
 *   - `malformed_agent`   → starts with `agent:` but failed parsing
 */
export function classifySessionKeyShape(sessionKey: string | undefined | null): SessionKeyShape {
	const raw = (sessionKey ?? "").trim();
	if (!raw) {
		return "missing";
	}
	if (parseAgentSessionKey(raw)) {
		return "agent";
	}
	return normalizeLowercaseStringOrEmpty(raw).startsWith("agent:")
		? "malformed_agent"
		: "legacy_or_alias";
}

/**
 * Canonical agent id. Path-safe + shell-friendly. Invalid input collapses
 * to `DEFAULT_AGENT_ID` ("main") rather than throwing — every consumer of
 * `agentId` runs through this gate.
 */
export function normalizeAgentId(value: string | undefined | null): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) {
		return DEFAULT_AGENT_ID;
	}
	const normalized = normalizeLowercaseStringOrEmpty(trimmed);
	// Keep it path-safe + shell-friendly.
	if (VALID_ID_RE.test(trimmed)) {
		return normalized;
	}
	// Best-effort fallback: collapse invalid characters to "-"
	return (
		normalized
			.replace(INVALID_CHARS_RE, "-")
			.replace(LEADING_DASH_RE, "")
			.replace(TRAILING_DASH_RE, "")
			.slice(0, 64) || DEFAULT_AGENT_ID
	);
}

export function isValidAgentId(value: string | undefined | null): boolean {
	const trimmed = (value ?? "").trim();
	return Boolean(trimmed) && VALID_ID_RE.test(trimmed);
}

export function sanitizeAgentId(value: string | undefined | null): string {
	return normalizeAgentId(value);
}

/**
 * Canonical main session key: `agent:<id>:main`. Renamed from the upstream
 * `buildAgentMainSessionKey` per the locked design's R2 Leak #2 brand-scrub
 * — Brigade callers should use this name. The deprecated alias below
 * accepts the upstream name for any future OC-port copy-paste.
 */
export function buildBrigadeMainSessionKey(params: {
	agentId: string;
	mainKey?: string | undefined;
}): string {
	const agentId = normalizeAgentId(params.agentId);
	const mainKey = normalizeMainKey(params.mainKey);
	return `agent:${agentId}:${mainKey}`;
}

/**
 * @deprecated alias for {@link buildBrigadeMainSessionKey}. Provided so
 * subsequent lift-and-paste of upstream files compiles without a rename
 * pass; new Brigade code should use the canonical name.
 */
export function buildAgentMainSessionKey(params: {
	agentId: string;
	mainKey?: string | undefined;
}): string {
	return buildBrigadeMainSessionKey(params);
}

/**
 * Canonical peer session-key builder. Encodes (agentId, channel, account,
 * peerKind, peerId) into the session-key shape selected by `dmScope`:
 *
 *   - `main`                       → `agent:<id>:main` (every DM collapses)
 *   - `per-peer`                   → `agent:<id>:direct:<peerId>` (cross-channel)
 *   - `per-channel-peer`           → `agent:<id>:<channel>:direct:<peerId>`
 *   - `per-account-channel-peer`   → `agent:<id>:<channel>:<account>:direct:<peerId>`
 *   - group / channel peers       → `agent:<id>:<channel>:<peerKind>:<peerId>`
 *
 * `identityLinks` collapses cross-channel peer aliases (e.g. the same human
 * on Telegram + WhatsApp) into a canonical id BEFORE the key is built.
 * Active for every dmScope except `"main"` (where all DMs collapse anyway).
 */
export function buildAgentPeerSessionKey(params: {
	agentId: string;
	mainKey?: string | undefined;
	channel: string;
	accountId?: string | null;
	peerKind?: ChatType | null;
	peerId?: string | null;
	identityLinks?: Record<string, string[]>;
	/** DM session scope. */
	dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
}): string {
	const peerKind = params.peerKind ?? "direct";
	if (peerKind === "direct") {
		const dmScope = params.dmScope ?? "main";
		let peerId = (params.peerId ?? "").trim();
		const linkedPeerId =
			dmScope === "main"
				? null
				: resolveLinkedPeerId({
						identityLinks: params.identityLinks,
						channel: params.channel,
						peerId,
					});
		if (linkedPeerId) {
			peerId = linkedPeerId;
		}
		peerId = normalizeLowercaseStringOrEmpty(peerId);
		if (dmScope === "per-account-channel-peer" && peerId) {
			const channel = normalizeLowercaseStringOrEmpty(params.channel) || "unknown";
			const accountId = normalizeAccountId(params.accountId);
			return `agent:${normalizeAgentId(params.agentId)}:${channel}:${accountId}:direct:${peerId}`;
		}
		if (dmScope === "per-channel-peer" && peerId) {
			const channel = normalizeLowercaseStringOrEmpty(params.channel) || "unknown";
			return `agent:${normalizeAgentId(params.agentId)}:${channel}:direct:${peerId}`;
		}
		if (dmScope === "per-peer" && peerId) {
			return `agent:${normalizeAgentId(params.agentId)}:direct:${peerId}`;
		}
		return buildBrigadeMainSessionKey({
			agentId: params.agentId,
			mainKey: params.mainKey,
		});
	}
	const channel = normalizeLowercaseStringOrEmpty(params.channel) || "unknown";
	const peerId = normalizeLowercaseStringOrEmpty(params.peerId) || "unknown";
	// Mirror the DM branch's account-aware shape when the operator opted into
	// `per-account-channel-peer`: a single agent serving two accounts of the
	// same channel (Slack workspace A + workspace B) must keep group/channel
	// histories separate per account, not collapse them onto one peer id.
	if (params.dmScope === "per-account-channel-peer") {
		const accountId = normalizeAccountId(params.accountId);
		return `agent:${normalizeAgentId(params.agentId)}:${channel}:${accountId}:${peerKind}:${peerId}`;
	}
	return `agent:${normalizeAgentId(params.agentId)}:${channel}:${peerKind}:${peerId}`;
}

/**
 * Stable key for group / channel history lookup (NOT a session key).
 * Used by per-conversation histories where the agent id is irrelevant
 * (the history is shared across agents in a multi-agent setup).
 */
export function buildGroupHistoryKey(params: {
	channel: string;
	accountId?: string | null;
	peerKind: "group" | "channel";
	peerId: string;
}): string {
	const channel = normalizeToken(params.channel) || "unknown";
	const accountId = normalizeAccountId(params.accountId);
	const peerId = normalizeLowercaseStringOrEmpty(params.peerId) || "unknown";
	return `${channel}:${accountId}:${params.peerKind}:${peerId}`;
}

/**
 * Append a `:thread:<id>` suffix to a base session key. When `useSuffix`
 * is false, returns the base key unchanged — caller is opting into a
 * thread-flat conversation (parent thread + replies share one session).
 */
export function resolveThreadSessionKeys(params: {
	baseSessionKey: string;
	threadId?: string | null;
	parentSessionKey?: string;
	useSuffix?: boolean;
	normalizeThreadId?: (threadId: string) => string;
}): { sessionKey: string; parentSessionKey?: string } {
	const threadId = (params.threadId ?? "").trim();
	if (!threadId) {
		return { sessionKey: params.baseSessionKey, parentSessionKey: undefined };
	}
	const normalizedThread =
		params.normalizeThreadId?.(threadId) ?? normalizeLowercaseStringOrEmpty(threadId);
	const useSuffix = params.useSuffix ?? true;
	const sessionKey = useSuffix
		? `${params.baseSessionKey}:thread:${normalizedThread}`
		: params.baseSessionKey;
	return { sessionKey, parentSessionKey: params.parentSessionKey };
}
