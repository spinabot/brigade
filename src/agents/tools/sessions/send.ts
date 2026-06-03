/**
 * `sessions_send` agent tool (Step 21).
 *
 * Sends a message into another session (child, sibling, or — when A2A
 * is enabled in config — a session belonging to a different agent). The
 * receiving session sees the inbound as a system event and drains it on
 * the next turn (Step 12's prompt orchestrator handles the prefix).
 *
 * Brigade scope today:
 *   - Validates target sessionKey + caller permissions (Step 19 helpers).
 *   - Dispatches via `callGateway("agent", ...)` with `lane: Nested` so the
 *     target turn runs without bumping the caller's main lane.
 *   - Returns the run id; the announce-back flow is fired on the target
 *     side via Step 12's drain + Step 14's heartbeat.
 *
 * What this tool DOES NOT do at this milestone:
 *   - The full ping-pong A2A flow (upstream's `runSessionsSendA2AFlow`)
 *     stays deferred; today the caller sends one message, and the target
 *     session replies on its next turn. Multi-turn A2A lands when the
 *     gateway dispatcher (Step 25) wires the cross-session announce
 *     callback.
 */

import crypto from "node:crypto";

import { callGateway } from "../../gateway-call.js";
import { nestedLane } from "../../../process/lanes.js";
import { enqueueSystemEvent } from "../../session-inbox.js";
import {
	checkSessionToolAccess,
	describeSessionsSendTool,
	jsonToolResult,
	SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
	ToolInputError,
	type AgentToAgentPolicy,
	type SessionToolsVisibility,
	type ToolResultEnvelope,
} from "./shared.js";

export interface SessionsSendToolArgs {
	sessionKey: string;
	message: string;
	timeoutSeconds?: number;
}

/**
 * Build the canonical "main" session key for a target agent — used when
 * the model passes `agentId` instead of `sessionKey`. Same shape as
 * `buildBrigadeMainSessionKey` but inlined to avoid a routing import cycle.
 */
function buildAgentMainSessionKey(agentId: string): string {
	const id = agentId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 64);
	return `agent:${id || "main"}:main`;
}

/**
 * Resolved per-turn access context for the session-tool guard. Threaded by
 * the bundle factory so each tool's execute body can fail-closed BEFORE
 * dispatching when the caller is not allowed to talk to the target session.
 *
 * Fail-closed contract: when the bundle was constructed without a complete
 * access policy (any of `agentSessionKey` / `visibility` / `a2aPolicy`
 * missing) the tool refuses every call. Callers that need to bypass the
 * guard (internal boot/cron/heartbeat flows that prove the request is
 * trusted) must opt in by setting `bypassAccessGuard: true`.
 */
export interface SessionToolAccessOptions {
	/** Visibility scope for the caller's session: self/tree/agent/all. */
	visibility?: SessionToolsVisibility;
	/** A2A policy resolved from `cfg.session.agentToAgent`. */
	a2aPolicy?: AgentToAgentPolicy;
	/** Session keys the caller (transitively) spawned — used for tree-scope. */
	spawnedKeys?: ReadonlySet<string>;
	/**
	 * When true, skip the access guard entirely. Reserved for internal
	 * system pathways (boot wiring, cron lane, heartbeat) where the caller
	 * has independently proven trust. Channel adapters / model-side dispatch
	 * MUST NOT set this — leaving it unset means an unwired bundle fails
	 * closed instead of accidentally allowing traffic.
	 */
	bypassAccessGuard?: boolean;
}

export interface SessionsSendToolOptions extends SessionToolAccessOptions {
	agentSessionKey?: string;
	agentChannel?: string;
}

export interface SessionsSendToolDescriptor {
	name: "sessions_send";
	displaySummary: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: SessionsSendToolArgs) => Promise<ToolResultEnvelope>;
}

const SESSIONS_SEND_SCHEMA: Record<string, unknown> = {
	type: "object",
	required: ["message"],
	properties: {
		sessionKey: { type: "string", minLength: 1 },
		agentId: { type: "string", minLength: 1, maxLength: 64 },
		label: {
			type: "string",
			minLength: 1,
			maxLength: 96,
			description:
				"Human label for the peer (e.g. 'Internet Exploreerr'). Resolved against configured agents' `identity.name` then their id. Use when you want to address a peer by display name.",
		},
		message: { type: "string", minLength: 1 },
		timeoutSeconds: { type: "number", minimum: 0 },
	},
	additionalProperties: false,
};

function coerceArgs(args: unknown): SessionsSendToolArgs {
	if (!args || typeof args !== "object") {
		throw new ToolInputError("sessions_send requires an object argument");
	}
	const obj = args as Record<string, unknown>;
	// Mirror OC's shape — caller may pass `sessionKey` (explicit), `agentId`
	// (shortcut for that agent's main session), OR `label` (human name resolved
	// against `cfg.agents.<id>.identity.name`). Precedence: explicit sessionKey
	// → agentId → label resolution.
	const sessionKeyRaw = typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
	const agentIdRaw = typeof obj.agentId === "string" ? obj.agentId.trim() : "";
	const labelRaw = typeof obj.label === "string" ? obj.label.trim() : "";
	let sessionKey = sessionKeyRaw;
	if (!sessionKey && agentIdRaw) sessionKey = buildAgentMainSessionKey(agentIdRaw);
	if (!sessionKey && labelRaw) {
		const resolved = resolveAgentIdByLabel(labelRaw);
		if (resolved) sessionKey = buildAgentMainSessionKey(resolved);
	}
	if (!sessionKey) {
		throw new ToolInputError(
			labelRaw
				? `sessions_send: no agent matches label "${labelRaw}". Pass \`agentId\` instead.`
				: "sessions_send requires `sessionKey`, `agentId`, or `label`",
		);
	}
	const message = typeof obj.message === "string" ? obj.message : "";
	if (!message.trim()) throw new ToolInputError("sessions_send requires non-empty `message`");
	const timeoutSeconds =
		typeof obj.timeoutSeconds === "number" && Number.isFinite(obj.timeoutSeconds)
			? Math.max(0, Math.floor(obj.timeoutSeconds))
			: undefined;
	return { sessionKey, message, timeoutSeconds };
}

/**
 * Resolve a human label to an agent id by walking `cfg.agents`. Matches
 * (case-insensitive): identity.name first, then the id itself. Returns
 * the canonical agent id on hit or `null` on no-match.
 *
 * Mirrors the reference codebase's `sessions.resolve` lookup but inlined
 * here so the tool stays self-contained (no extra gateway round-trip).
 */
function resolveAgentIdByLabel(label: string): string | null {
	try {
		// Lazy require so the tool doesn't drag config-loader into bundles
		// that don't need label resolution.
		const { loadConfig } = require("../../../core/config.js") as {
			loadConfig: () => unknown;
		};
		const cfg = loadConfig() as { agents?: Record<string, unknown> };
		const agents = cfg?.agents;
		if (!agents || typeof agents !== "object") return null;
		const want = label.toLowerCase();
		// Pass 1: match by identity.name
		for (const [id, entry] of Object.entries(agents)) {
			if (id === "defaults" || !entry || typeof entry !== "object") continue;
			const identity = (entry as { identity?: { name?: unknown } }).identity;
			const name = identity && typeof identity.name === "string" ? identity.name : "";
			if (name.trim().toLowerCase() === want) return id;
		}
		// Pass 2: match by id (case-insensitive)
		for (const id of Object.keys(agents)) {
			if (id === "defaults") continue;
			if (id.toLowerCase() === want) return id;
		}
		return null;
	} catch {
		return null;
	}
}

export function createSessionsSendTool(
	opts: SessionsSendToolOptions = {},
): SessionsSendToolDescriptor {
	return {
		name: "sessions_send",
		displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
		description: describeSessionsSendTool(),
		parameters: SESSIONS_SEND_SCHEMA,
		execute: async (args) => {
			const parsed = coerceArgs(args);
			if (parsed.sessionKey === opts.agentSessionKey) {
				return jsonToolResult({
					status: "error",
					error: "sessions_send cannot target the caller's own session",
				});
			}

			// Access guard — fail-closed. When the bundle was built without a
			// full policy (visibility + a2aPolicy + caller key) the tool
			// refuses every call. Internal system pathways that must bypass
			// the check explicitly opt in via `bypassAccessGuard: true`.
			if (opts.bypassAccessGuard !== true) {
				if (!opts.agentSessionKey || !opts.visibility || !opts.a2aPolicy) {
					return jsonToolResult({
						status: "forbidden",
						sessionKey: parsed.sessionKey,
						error: "sessions_send forbidden: session access policy not configured",
					});
				}
				const access = checkSessionToolAccess({
					action: "send",
					requesterSessionKey: opts.agentSessionKey,
					targetSessionKey: parsed.sessionKey,
					visibility: opts.visibility,
					a2aPolicy: opts.a2aPolicy,
					...(opts.spawnedKeys ? { spawnedKeys: opts.spawnedKeys } : {}),
				});
				if (!access.allowed) {
					return jsonToolResult({
						status: "forbidden",
						sessionKey: parsed.sessionKey,
						error: access.error,
					});
				}
			}

			// Inject a system event into the target's inbox so the target's
			// next prompt assembly sees the sender + carries the context tag.
			// This is the same mechanism Step 12 drains on turn-start.
			const senderRef = opts.agentSessionKey ?? "main";
			enqueueSystemEvent(
				`A2A from ${senderRef}: ${parsed.message}`,
				{
					sessionKey: parsed.sessionKey,
					contextKey: `a2a:from:${senderRef}`,
					trusted: true,
				},
			);

			// Trigger the target's next turn via the per-caller nested lane so
			// concurrent sends from different callers don't queue head-of-line
			// behind each other (won't bump the caller's main lane either).
			const idempotencyKey = crypto.randomUUID();
			const lane = nestedLane(opts.agentSessionKey);
			// Snapshot the peer's current last-assistant-reply BEFORE the
			// dispatch so we can detect "did the peer actually produce a new
			// reply?" after the call completes. Mirrors the reference
			// codebase's `waitForAgentRunAndReadUpdatedAssistantReply`.
			const beforeReply = await readLatestAssistantReply(parsed.sessionKey);
			// The gateway's `agent` method dispatches the peer's turn and
			// awaits it — but Pi's session may flush the final assistant
			// text AFTER the run resolves. We fire the call (no extra wait)
			// then poll sessions.history for a NEW non-empty assistant text.
			// Tool-call-heavy turns (web_search, fetch_url, browser) can
			// take 30-60s before the final text lands; poll up to
			// `timeoutSeconds` (default 90s) before falling back to
			// "accepted" — the announce-delivery will still surface the
			// reply on the parent's next turn via the inbox.
			const timeoutSec =
				parsed.timeoutSeconds !== undefined && parsed.timeoutSeconds > 0
					? parsed.timeoutSeconds
					: 90;
			try {
				// Fire and forget the agent call — the gateway awaits the
				// peer's run. We don't await this Promise; the polling loop
				// below picks up the result as soon as the transcript flushes.
				void callGateway({
					method: "agent",
					params: {
						message: parsed.message,
						sessionKey: parsed.sessionKey,
						deliver: false,
						lane,
						idempotencyKey,
						spawnedBy: opts.agentSessionKey ?? "main",
						timeout: timeoutSec,
					},
					timeoutMs: Math.max(10_000, timeoutSec * 1_000 + 5_000),
				}).catch(() => {
					/* failures surface via the polling-timeout path below */
				});
			} catch (err) {
				return jsonToolResult({
					status: "error",
					sessionKey: parsed.sessionKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// Poll for the peer's new assistant reply with exponential
			// backoff. Returns as soon as a non-empty text block lands.
			const newReply = await pollForNewReply({
				sessionKey: parsed.sessionKey,
				beforeReply,
				timeoutMs: timeoutSec * 1_000,
			});
			if (newReply) {
				return jsonToolResult({
					status: "ok",
					sessionKey: parsed.sessionKey,
					reply: newReply,
					idempotencyKey,
				});
			}
			// Peer didn't produce a new text reply within the timeout window.
			// Fall back to the accepted envelope; announce-delivery will
			// surface the reply on the next turn via the parent inbox if it
			// lands later.
			return jsonToolResult({
				status: "accepted",
				sessionKey: parsed.sessionKey,
				delivery: { mode: "queued", lane },
				idempotencyKey,
				note: `peer turn dispatched but no text reply within ${timeoutSec}s (tool-heavy or long task). The peer is still running; its reply will land in its own session transcript. To check: call sessions_history({sessionKey: "${parsed.sessionKey}", limit: 3}) on a subsequent turn. Do NOT claim a status to the user without re-checking.`,
			});
		},
	};
}

/**
 * Poll the peer's session.history for a NEW non-empty assistant text
 * reply. Returns as soon as one lands or the timeout elapses.
 *
 * Exponential backoff: 200ms → 400ms → 800ms → 1600ms → 3200ms → capped
 * at 3000ms. This keeps short replies (most chat) responsive while
 * tool-call-heavy turns (web_search, browser) don't burn the gateway
 * with rapid polls.
 *
 * Mirrors the intent of the reference codebase's
 * `waitForAgentRunAndReadUpdatedAssistantReply` — wait for the peer's
 * turn to actually FLUSH its final text, not just dispatch.
 */
async function pollForNewReply(params: {
	sessionKey: string;
	beforeReply: string;
	timeoutMs: number;
}): Promise<string> {
	const deadline = Date.now() + params.timeoutMs;
	let waitMs = 200;
	while (Date.now() < deadline) {
		await sleep(waitMs);
		const candidate = await readLatestAssistantReply(params.sessionKey);
		if (candidate && candidate !== params.beforeReply) {
			return candidate;
		}
		waitMs = Math.min(3_000, waitMs * 2);
	}
	return "";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the latest assistant reply text from a peer session via the
 * gateway's `sessions.history` RPC. Returns empty string when the
 * peer hasn't produced a reply yet OR the session has no transcript
 * on disk (first-turn case before the agent call).
 */
async function readLatestAssistantReply(sessionKey: string): Promise<string> {
	try {
		const response = (await callGateway({
			method: "sessions.history",
			params: { sessionKey, limit: 10 },
		})) as { messages?: unknown[] } | undefined;
		const messages = Array.isArray(response?.messages) ? response.messages : [];
		// Walk backwards for the last assistant message.
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as { role?: string; content?: unknown } | undefined;
			if (msg?.role !== "assistant") continue;
			const text = extractAssistantText(msg.content);
			if (text) return text;
		}
		return "";
	} catch {
		return "";
	}
}

/**
 * Pi message content is either a plain string or a content-block array
 * `[{type:"text", text:"..."}, {type:"thinking", ...}]`. Extract the
 * user-visible text (concatenating multi-block text parts).
 */
function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("").trim();
}
