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
import { requestHeartbeatNow } from "../../heartbeat-wake.js";
import { enqueueSystemEvent, removeMatchingSystemEvent } from "../../session-inbox.js";
import { getLastChannelForAgent } from "../../channels/last-channel.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.js";
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
// Stage C — structured A2A denial wrapping. Only invoked when the
// legacy denial path runs AND cfg.org is present AND mode === "derived".
// Otherwise the legacy error message stays untouched.
import { buildOrgDeniedMessage } from "../../org/structured-errors.js";
import { deriveOrgGraph } from "../../org/derive-graph.js";
import { resolveSessionAccessPolicy } from "./resolve-access.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";

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
				let access = checkSessionToolAccess({
					action: "send",
					requesterSessionKey: opts.agentSessionKey,
					targetSessionKey: parsed.sessionKey,
					visibility: opts.visibility,
					a2aPolicy: opts.a2aPolicy,
					...(opts.spawnedKeys ? { spawnedKeys: opts.spawnedKeys } : {}),
				});
				// LIVE re-check (2026-06-11): the injected policy was frozen at
				// run start. If the model just called `manage_access` to enable
				// cross-agent messaging and is retrying THIS run, the frozen
				// policy still says "denied". Re-resolve from CURRENT config and
				// re-check before refusing — a mid-run enable then takes effect
				// immediately (no gateway restart, which is what the model used
				// to wrongly tell the operator). Deny-path only: the happy path
				// keeps the injected policy untouched, and a re-check can only
				// GRANT (after an enable), never widen a still-denying config.
				if (!access.allowed && opts.agentSessionKey) {
					try {
						const freshCfg = (
							require("../../../core/config.js") as { loadConfig: () => unknown }
						).loadConfig();
						const live = resolveSessionAccessPolicy(freshCfg);
						const liveAccess = checkSessionToolAccess({
							action: "send",
							requesterSessionKey: opts.agentSessionKey,
							targetSessionKey: parsed.sessionKey,
							visibility: live.visibility,
							a2aPolicy: live.a2aPolicy,
							...(opts.spawnedKeys ? { spawnedKeys: opts.spawnedKeys } : {}),
						});
						if (liveAccess.allowed) access = liveAccess;
					} catch {
						/* keep the original denial on any resolve failure */
					}
				}
				if (!access.allowed) {
					// Stage C additive-gate: when cfg.org is present AND mode ===
					// "derived", wrap the legacy denial message with the
					// structured-errors helper so the model gets an actionable
					// remediation suggestion (e.g. delegate_to_department or
					// escalate via <manager>). When cfg.org is absent OR mode is
					// "explicit", the LEGACY error message is returned untouched.
					let wrappedError = access.error;
					try {
						const cfg = (require("../../../core/config.js") as {
							loadConfig: () => unknown;
						}).loadConfig() as { org?: { a2a?: { mode?: string } } };
						if (cfg.org && cfg.org.a2a?.mode !== "explicit") {
							const graph = deriveOrgGraph(cfg as never);
							if (graph && opts.agentSessionKey) {
								const fromAgentId = resolveAgentIdFromSessionKey(opts.agentSessionKey);
								const toAgentId = resolveAgentIdFromSessionKey(parsed.sessionKey);
								wrappedError = buildOrgDeniedMessage({
									originalMessage: access.error,
									fromAgentId,
									toAgentId,
									graph,
								});
							}
						}
					} catch {
						// Fall through to the legacy error text on any failure.
					}
					return jsonToolResult({
						status: "forbidden",
						sessionKey: parsed.sessionKey,
						error: wrappedError,
					});
				}
			}

			// Inject a system event into the target's inbox so the target's
			// next prompt assembly sees the sender + carries the context tag.
			// This is the same mechanism Step 12 drains on turn-start.
			//
			// The contract suffix exists because peers used to ANSWER LIKE
			// HUMANS: "On it, let me hit the directories…" — and end the turn
			// without doing anything. The peer must know the work happens IN
			// this turn (tools included, minutes are fine) and the final
			// message is the entire hand-off.
			const senderRef = opts.agentSessionKey ?? "main";
			const a2aEventText =
				`A2A from ${senderRef}: ${parsed.message}\n` +
				`[A2A contract: do the requested work NOW, in this turn — use your tools; long ` +
				`tool runs are fine. Your FINAL message is the entire hand-off: it must contain ` +
				`the complete deliverable. Never end the turn with just an acknowledgement like ` +
				`"on it" or a promise to follow up — there is no later turn unless the requester ` +
				`sends again.]`;
			const a2aEventContextKey = `a2a:from:${senderRef}`;
			enqueueSystemEvent(a2aEventText, {
				sessionKey: parsed.sessionKey,
				contextKey: a2aEventContextKey,
				trusted: true,
			});

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
			// Dispatch the peer's turn and HOLD the run promise. `wait: true`
			// makes the gateway's agent handler await the run's SETTLED
			// outcome before responding (the in-process caller otherwise
			// resolves the moment the handler returns its fire-and-forget
			// ack — which made every settle-gated branch below dead code and
			// returned "completed" for runs that had just started). The old
			// code additionally polled for the FIRST new assistant text,
			// which returned intermediate progress messages ("On it, let me
			// hit the directories…") from tool-heavy runs as if they were
			// the final reply. Pattern now: wait for the run, THEN read the
			// final reply (the reference codebase's run-wait contract).
			//
			// NOTE deliberately NO `timeout` param on the dispatch: the
			// caller's wait window must never bound the PEER's run lifetime
			// (reference contract — wait-timeout and run-kill are separate
			// knobs; the dispatcher owns the run).
			const timeoutSec =
				parsed.timeoutSeconds !== undefined && parsed.timeoutSeconds > 0
					? parsed.timeoutSeconds
					: 90;
			interface AgentWaitResponse {
				ok?: boolean;
				runId?: string;
				error?: string;
				reply?: string;
				aborted?: boolean;
				timedOut?: boolean;
			}
			let runSettled = false;
			let runOutcome: AgentWaitResponse | undefined;
			let rpcFailed: string | undefined;
			let runPromise: Promise<void>;
			try {
				runPromise = callGateway<AgentWaitResponse>({
					method: "agent",
					params: {
						message: parsed.message,
						sessionKey: parsed.sessionKey,
						deliver: false,
						lane,
						idempotencyKey,
						spawnedBy: opts.agentSessionKey ?? "main",
						wait: true,
					},
					// RPC ceiling for the HELD wait — generous so long peer
					// work settles through it; its expiry does NOT abort the
					// peer run (the dispatcher owns the run lifecycle).
					timeoutMs: Math.max(timeoutSec * 1_000 + 5_000, 15 * 60 * 1_000),
				}).then(
					(res) => {
						runSettled = true;
						runOutcome = res ?? { ok: true };
					},
					(err) => {
						// RPC-level failure (incl. the 15-min ceiling). The peer
						// run may STILL be in flight — never report it finished.
						runSettled = true;
						rpcFailed = err instanceof Error ? err.message : String(err);
					},
				);
			} catch (err) {
				removeMatchingSystemEvent(parsed.sessionKey, {
					text: a2aEventText,
					contextKey: a2aEventContextKey,
				});
				return jsonToolResult({
					status: "error",
					sessionKey: parsed.sessionKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// Wait for run-settle OR the caller's wait window, whichever first.
			let raceTimer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				runPromise,
				new Promise<void>((resolve) => {
					raceTimer = setTimeout(resolve, timeoutSec * 1_000);
					(raceTimer as { unref?: () => void }).unref?.();
				}),
			]);
			if (raceTimer) clearTimeout(raceTimer);

			if (runSettled) {
				// Dispatch/run failures must SURFACE, not masquerade as
				// success — and the attribution event enqueued above must be
				// withdrawn or it ghosts into the peer's next unrelated turn.
				if (rpcFailed !== undefined || runOutcome?.ok === false) {
					removeMatchingSystemEvent(parsed.sessionKey, {
						text: a2aEventText,
						contextKey: a2aEventContextKey,
					});
					const detail = rpcFailed ?? runOutcome?.error ?? "peer dispatch failed";
					return jsonToolResult({
						status: "error",
						sessionKey: parsed.sessionKey,
						error: rpcFailed
							? `gateway wait failed (${detail}) — the peer run MAY still be in flight; check sessions_history({sessionKey: "${parsed.sessionKey}"}) before re-sending.`
							: detail,
						idempotencyKey,
					});
				}
				// Run finished inside the wait window. Prefer the settled
				// outcome's own reply; Pi's session can flush the final text
				// a beat after the run resolves, so fall back to a brief poll.
				const direct =
					typeof runOutcome?.reply === "string" &&
					runOutcome.reply.trim().length > 0 &&
					runOutcome.reply !== beforeReply
						? runOutcome.reply
						: undefined;
				const newReply =
					direct ??
					(await pollForNewReply({
						sessionKey: parsed.sessionKey,
						beforeReply,
						timeoutMs: 10_000,
					}));
				if (newReply) {
					return jsonToolResult({
						status: "ok",
						sessionKey: parsed.sessionKey,
						reply: newReply,
						idempotencyKey,
					});
				}
				return jsonToolResult({
					status: "ok",
					sessionKey: parsed.sessionKey,
					idempotencyKey,
					note:
						"peer turn completed but produced no new text reply. " +
						`Check sessions_history({sessionKey: "${parsed.sessionKey}", limit: 3}) before telling the user anything.`,
				});
			}

			// Peer is STILL WORKING past the wait window — true async hand-off.
			// Attach the delivery now: when the run settles, the peer's final
			// reply is pushed into the REQUESTER's session inbox and a
			// heartbeat wake fires, so the requester's next (woken) turn
			// relays the result to the user hands-free. Same inbox + wake
			// spine that delivers cron reminders.
			const requesterSessionKey = opts.agentSessionKey;
			if (requesterSessionKey) {
				void runPromise.then(async () => {
					try {
						// Honest classification of the settled outcome — the
						// requester is never told "finished" for a run that
						// failed or whose RPC ceiling expired mid-flight.
						let eventText: string;
						if (rpcFailed !== undefined) {
							eventText =
								`A2A: the wait on peer ${parsed.sessionKey} failed (${rpcFailed}); the peer ` +
								`MAY still be working. Check sessions_history({sessionKey: "${parsed.sessionKey}", limit: 3}) ` +
								`and tell the user honestly.`;
						} else if (runOutcome?.ok === false) {
							eventText =
								`A2A: peer ${parsed.sessionKey} turn FAILED (${runOutcome?.error ?? "unknown error"}). ` +
								`Tell the user the delegated work did not complete.`;
						} else {
							const direct =
								typeof runOutcome?.reply === "string" &&
								runOutcome.reply.trim().length > 0 &&
								runOutcome.reply !== beforeReply
									? runOutcome.reply
									: undefined;
							const finalReply =
								direct ??
								(await pollForNewReply({
									sessionKey: parsed.sessionKey,
									beforeReply,
									timeoutMs: 15_000,
								}));
							eventText = finalReply
								? `A2A reply from ${parsed.sessionKey}: ${finalReply}\n` +
									`[The peer finished the delegated work — relay this result to the user NOW. Do not re-run the work.]`
								: `A2A: peer ${parsed.sessionKey} finished the delegated turn but produced no text reply. ` +
									`Check sessions_history({sessionKey: "${parsed.sessionKey}", limit: 3}) and tell the user honestly.`;
						}
						// P0-2: stamp the requester's CHANNEL on the event so the woken
						// turn's relay reaches them where they actually are (WhatsApp /
						// Slack), not just the TUI. The heartbeat dispatcher reads this
						// deliveryContext and sends the reply out via the channel adapter
						// (cron-announce-style). Resolved from the requester agent's last
						// active channel; absent for pure-TUI requesters — then it stays
						// TUI-only, exactly as before.
						const requesterAgentId = resolveAgentIdFromSessionKey(requesterSessionKey);
						const lastCh = requesterAgentId
							? getLastChannelForAgent(requesterAgentId)
							: undefined;
						const deliveryContext = lastCh
							? normalizeDeliveryContext({
									channel: lastCh.channelId,
									to: lastCh.conversationId,
									accountId: lastCh.accountId,
									threadId: lastCh.threadId,
								})
							: undefined;
						enqueueSystemEvent(eventText, {
							sessionKey: requesterSessionKey,
							contextKey: `a2a:reply:${parsed.sessionKey}`,
							trusted: true,
							...(deliveryContext && deliveryContext.channel && deliveryContext.to
								? { deliveryContext }
								: {}),
						});
						requestHeartbeatNow({
							reason: "a2a-reply",
							...(requesterAgentId ? { agentId: requesterAgentId } : {}),
							sessionKey: requesterSessionKey,
						});
					} catch {
						/* best-effort delivery — the reply stays readable via sessions_history */
					}
				});
			}
			return jsonToolResult({
				status: "accepted",
				sessionKey: parsed.sessionKey,
				delivery: { mode: "auto-deliver-on-finish", lane },
				idempotencyKey,
				note:
					`peer is STILL WORKING (no reply within ${timeoutSec}s — tool-heavy or long task). ` +
					`Its finished reply will be DELIVERED into your session automatically: you will see ` +
					`"A2A reply from ${parsed.sessionKey}: …" on a later turn — relay it to the user then. ` +
					`Right now: tell the user the work is in progress. Do NOT fabricate results and do NOT poll.`,
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
