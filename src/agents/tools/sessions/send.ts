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
	describeSessionsSendTool,
	jsonToolResult,
	SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
	ToolInputError,
	type ToolResultEnvelope,
} from "./shared.js";

export interface SessionsSendToolArgs {
	sessionKey: string;
	message: string;
	timeoutSeconds?: number;
}

export interface SessionsSendToolOptions {
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
	required: ["sessionKey", "message"],
	properties: {
		sessionKey: { type: "string", minLength: 1 },
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
	const sessionKey = typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
	if (!sessionKey) throw new ToolInputError("sessions_send requires `sessionKey`");
	const message = typeof obj.message === "string" ? obj.message : "";
	if (!message.trim()) throw new ToolInputError("sessions_send requires non-empty `message`");
	const timeoutSeconds =
		typeof obj.timeoutSeconds === "number" && Number.isFinite(obj.timeoutSeconds)
			? Math.max(0, Math.floor(obj.timeoutSeconds))
			: undefined;
	return { sessionKey, message, timeoutSeconds };
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
			try {
				await callGateway({
					method: "agent",
					params: {
						message: parsed.message,
						sessionKey: parsed.sessionKey,
						deliver: false,
						lane,
						idempotencyKey,
						spawnedBy: opts.agentSessionKey ?? "main",
						timeout: parsed.timeoutSeconds,
					},
					timeoutMs: Math.max(10_000, (parsed.timeoutSeconds ?? 0) * 1_000 + 5_000),
				});
			} catch (err) {
				return jsonToolResult({
					status: "error",
					error: err instanceof Error ? err.message : String(err),
				});
			}

			return jsonToolResult({
				status: "accepted",
				sessionKey: parsed.sessionKey,
				delivery: { mode: "queued", lane },
				idempotencyKey,
			});
		},
	};
}
