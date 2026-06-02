/**
 * Per-session pending-system-events queue.
 *
 * Brigade follows a two-track delivery model for cron announces (and any
 * other out-of-band system event the gateway needs to surface to the
 * operator):
 *
 *   TRACK 1 — live visibility. When `enqueueSystemEvent` fires, the
 *   gateway broadcasts a `system-event` WebSocket event. A connected
 *   connect-mode TUI renders it instantly as a Brigade-side chat bubble
 *   (see `cli/commands/connect.ts`'s `system-event` handler). This is
 *   the "you literally see the reminder pop up" path.
 *
 *   TRACK 2 — model awareness (this module). The text ALSO lands in a
 *   per-session in-memory queue keyed by the operator's session key.
 *   On the next agent turn for that session, `drainPendingSystemEvents`
 *   pulls the queued events and prepends them as `<system_event>`
 *   blocks to the user message. The model then KNOWS the cron's
 *   reminder fired and can respond accordingly ("yes — that was the
 *   reminder I set for you 2 minutes ago"). Without this the model
 *   would be answering blind and might bullshit "should be landing
 *   any moment now" while the actual fire happened minutes ago.
 *
 * Storage is module-level + ephemeral on purpose: the queue is bounded
 * (20 events per session — plenty for any human-paced reminder cadence),
 * never persisted to disk, and is dropped when the process restarts.
 * Persistence would be over-engineering for what's a "don't lose this
 * one tick of state" buffer.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const log = createSubsystemLogger("brigade/pending-events");

/** Per-event payload the cron service hands the queue. */
export interface PendingSystemEvent {
	/** Text the operator sees as a chat bubble + the model sees as system context. */
	text: string;
	/** Wall-clock ms when the event was queued. */
	queuedAtMs: number;
	/** Cron job id whose announce this carries (display + dedup). */
	jobId?: string;
	/** Cron job name whose announce this carries (display). */
	jobName?: string;
}

/** Max events held per session. Older events drop oldest-first on overflow. */
const MAX_EVENTS_PER_SESSION = 20;

/** Module-level queue map. Keyed by session key. Pinned via global-singleton. */
const PENDING_SYSTEM_EVENTS_QUEUES_KEY = Symbol.for("brigade.pendingSystemEvents.queues");
const queues = resolveGlobalSingleton<Map<string, PendingSystemEvent[]>>(
	PENDING_SYSTEM_EVENTS_QUEUES_KEY,
	() => new Map<string, PendingSystemEvent[]>(),
);

/**
 * Append a pending event to the queue for `sessionKey`. Bounded — once a
 * session's queue hits `MAX_EVENTS_PER_SESSION`, the OLDEST entry is
 * dropped to make room (a healthy session drains on every turn; a
 * starving session that never drains shouldn't grow unbounded and OOM
 * the gateway).
 */
export function enqueuePendingSystemEvent(
	sessionKey: string,
	event: PendingSystemEvent,
): void {
	if (!sessionKey || typeof sessionKey !== "string") {
		log.warn("enqueue called with empty sessionKey — dropping event", {
			text: event.text.slice(0, 80),
		});
		return;
	}
	const queue = queues.get(sessionKey) ?? [];
	queue.push(event);
	while (queue.length > MAX_EVENTS_PER_SESSION) {
		queue.shift();
	}
	queues.set(sessionKey, queue);
}

/**
 * Drain ALL events for `sessionKey`. Returns the events in queued order
 * (oldest first) AND clears them — the caller is expected to use the
 * returned list immediately. Returns an empty array when nothing is
 * pending; callers should check `length` before formatting.
 */
export function drainPendingSystemEvents(sessionKey: string): PendingSystemEvent[] {
	const queue = queues.get(sessionKey);
	if (!queue || queue.length === 0) return [];
	queues.delete(sessionKey);
	return queue;
}

/**
 * Peek at the queue without draining — diagnostic only. Used by the
 * `cron` tool's `status` action so the operator can see what's still
 * pending for their session before they hit Enter on a prompt.
 */
export function listPendingSystemEvents(sessionKey: string): readonly PendingSystemEvent[] {
	return queues.get(sessionKey) ?? [];
}

/**
 * Format drained events into the prefix that goes into the next user
 * prompt. Each event is wrapped in an `<system_event>` XML-ish block
 * with a timestamp and optional job-name attribution so the model can
 * cleanly distinguish system-injected context from the operator's own
 * typed text. The trailing newline separates the prefix from whatever
 * the operator actually typed.
 *
 * Returns an empty string when the input is empty, so callers can
 * safely `prefix + userMessage` without an extra branch.
 */
export function formatPendingEventsPrefix(events: readonly PendingSystemEvent[]): string {
	if (events.length === 0) return "";
	const parts: string[] = [];
	for (const event of events) {
		const ts = new Date(event.queuedAtMs).toISOString();
		const attr = event.jobName
			? ` source="cron" job="${escapeAttr(event.jobName)}"`
			: ' source="cron"';
		parts.push(`<system_event${attr} at="${ts}">`);
		parts.push(event.text);
		parts.push(`</system_event>`);
	}
	parts.push("");
	return `${parts.join("\n")}\n`;
}

/** Minimal attribute-value escape — strips quote / brackets / NUL only. */
function escapeAttr(value: string): string {
	return value.replace(/["<>\x00]/g, "");
}

/** Test-only — clear every queued event across every session. */
export function resetPendingSystemEventsForTests(): void {
	queues.clear();
}
