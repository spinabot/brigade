/**
 * Reminder-context helper for cron `systemEvent` payloads.
 *
 * When the agent (via the cron tool) schedules a reminder with
 * `contextMessages: N`, this module fetches the caller's last N messages from
 * the gateway's session history and formats them into a compact
 * `Recent context:` block appended to the reminder's text. The fire-time
 * heartbeat consumer sees the operator's recent chat alongside the reminder
 * so the reply can pick up on what they were just talking about.
 *
 * Constants are tuned for tight budgets — the reminder text itself is the
 * primary signal; the context is a hint. Total context never exceeds 700
 * chars across at most 10 lines of at most 220 chars each.
 *
 * Mirrored from the upstream cron-tool reminder-context block. Two small
 * Brigade-side adjustments:
 *   1. Calls `sessions.history` (Brigade's RPC) instead of `chat.history`.
 *   2. Drops the public-alias → internal-key resolver step because Brigade
 *      session keys are already in internal form. Caller passes the key as-
 *      is; `handleSessionsHistory` accepts it directly.
 */

import { callGateway } from "../agents/gateway-call.js";

export const REMINDER_CONTEXT_MESSAGES_MAX = 10;
export const REMINDER_CONTEXT_PER_MESSAGE_MAX = 220;
export const REMINDER_CONTEXT_TOTAL_MAX = 700;
export const REMINDER_CONTEXT_MARKER = "\n\nRecent context:\n";

/**
 * Strip a previously-appended `Recent context:` block so a re-add (e.g.
 * follow-up `cron update`) doesn't double-stack contexts. Idempotent.
 */
export function stripExistingContext(text: string): string {
	const index = text.indexOf(REMINDER_CONTEXT_MARKER);
	if (index === -1) return text;
	return text.slice(0, index).trim();
}

/** UTF-16-safe truncation with "..." suffix when over `maxLen`. */
export function truncateText(input: string, maxLen: number): string {
	if (input.length <= maxLen) return input;
	const headLen = Math.max(0, maxLen - 3);
	// Don't split a surrogate pair: if the last code unit is a high
	// surrogate, drop one more code unit.
	let head = input.slice(0, headLen);
	if (head.length > 0) {
		const last = head.charCodeAt(head.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			head = head.slice(0, -1);
		}
	}
	return `${head.trimEnd()}...`;
}

/**
 * Pull `text` out of a chat message's `content` field. Handles both legacy
 * string-content and the Anthropic-style array-of-blocks. Returns `null` for
 * non-text content or whitespace-only text so the caller can drop the entry.
 */
export function extractTextFromChatContent(content: unknown): string | null {
	if (typeof content === "string") {
		const trimmed = content.replace(/\s+/g, " ").trim();
		return trimmed ? trimmed : null;
	}
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const rec = block as { type?: unknown; text?: unknown };
			if (rec.type !== "text") continue;
			if (typeof rec.text !== "string") continue;
			parts.push(rec.text);
		}
		const joined = parts.join(" ").replace(/\s+/g, " ").trim();
		return joined ? joined : null;
	}
	return null;
}

interface ChatLikeMessage {
	role?: unknown;
	content?: unknown;
}

function extractMessageText(message: ChatLikeMessage): { role: string; text: string } | null {
	const role = typeof message.role === "string" ? message.role : "";
	if (role !== "user" && role !== "assistant") return null;
	const text = extractTextFromChatContent(message.content);
	return text ? { role, text } : null;
}

export interface BuildReminderContextLinesOpts {
	/** Caller's session key — `sessions.history` is fetched against this. */
	agentSessionKey?: string;
	/** Requested count (0..MAX). Clamped. */
	contextMessages: number;
	/**
	 * Override for the gateway dispatcher — defaults to the in-process
	 * caller. Tests inject a stub to avoid wiring a real gateway.
	 */
	callGateway?: typeof callGateway;
}

/**
 * Build the `- Role: text` lines for the `Recent context:` block.
 *
 * Returns `[]` when:
 *   - `contextMessages <= 0` after clamping.
 *   - `agentSessionKey` is empty / whitespace (TUI / standalone CLI).
 *   - The gateway call throws (any reason — silent degrade, the reminder
 *     still fires without context).
 *
 * Respects both per-message (220 chars + "...") and total (700 chars) caps;
 * the first line that would push total over budget is dropped (not
 * partially included).
 */
export async function buildReminderContextLines(
	opts: BuildReminderContextLinesOpts,
): Promise<string[]> {
	const maxMessages = Math.min(
		REMINDER_CONTEXT_MESSAGES_MAX,
		Math.max(0, Math.floor(opts.contextMessages)),
	);
	if (maxMessages <= 0) return [];
	const sessionKey = opts.agentSessionKey?.trim();
	if (!sessionKey) return [];
	const dispatch = opts.callGateway ?? callGateway;
	try {
		const res = await dispatch<{ messages: ReadonlyArray<unknown> }>({
			method: "sessions.history",
			params: { sessionKey, limit: maxMessages },
		});
		const messages = Array.isArray(res?.messages) ? res.messages : [];
		const parsed = messages
			.map((m) => extractMessageText(m as ChatLikeMessage))
			.filter((m): m is { role: string; text: string } => Boolean(m));
		const recent = parsed.slice(-maxMessages);
		if (recent.length === 0) return [];
		const lines: string[] = [];
		let total = 0;
		for (const entry of recent) {
			const label = entry.role === "user" ? "User" : "Assistant";
			const text = truncateText(entry.text, REMINDER_CONTEXT_PER_MESSAGE_MAX);
			const line = `- ${label}: ${text}`;
			total += line.length;
			if (total > REMINDER_CONTEXT_TOTAL_MAX) break;
			lines.push(line);
		}
		return lines;
	} catch {
		return [];
	}
}

/**
 * Mutate-or-passthrough helper used by the cron tool's `add` branch.
 * When the input job's payload is a non-empty `systemEvent.text`, fetches
 * recent context and appends it to the payload's text. Non-mutating: returns
 * the original input when context can't be built.
 */
export async function maybeAttachReminderContext(args: {
	job: Record<string, unknown>;
	contextMessages: number;
	agentSessionKey?: string;
	/** Override gateway dispatcher for tests. */
	callGateway?: typeof callGateway;
}): Promise<Record<string, unknown>> {
	const payloadRaw = args.job.payload;
	if (!payloadRaw || typeof payloadRaw !== "object" || Array.isArray(payloadRaw)) {
		return args.job;
	}
	const payload = payloadRaw as { kind?: unknown; text?: unknown };
	if (payload.kind !== "systemEvent") return args.job;
	if (typeof payload.text !== "string" || !payload.text.trim()) return args.job;
	const lines = await buildReminderContextLines({
		contextMessages: args.contextMessages,
		...(args.agentSessionKey !== undefined ? { agentSessionKey: args.agentSessionKey } : {}),
		...(args.callGateway !== undefined ? { callGateway: args.callGateway } : {}),
	});
	if (lines.length === 0) return args.job;
	const baseText = stripExistingContext(payload.text);
	const nextText = `${baseText}${REMINDER_CONTEXT_MARKER}${lines.join("\n")}`;
	return {
		...args.job,
		payload: { ...payload, text: nextText },
	};
}
