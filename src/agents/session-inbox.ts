/**
 * Per-session system-event inbox.
 *
 * Brand-scrubbed verbatim lift of upstream's `src/infra/system-events.ts`.
 * Lightweight, in-memory, ephemeral queue of human-readable events that
 * the next turn for a session prefixes onto the prompt. Persistence is
 * intentionally NOT supported — events are wake-up signals, not history.
 *
 * Producers (planned):
 *   - Channel manager (Step 16) → inbound messages while a turn is busy
 *   - Cron service (later) → fired-job reminders + payloads
 *   - Sub-agent completion handler (Step 20) → child-result notifications
 *   - Approval router (Step 17) → operator decisions on tool gates
 *   - Heartbeat layer (Steps 13-14) → wake signals scoped per session
 *
 * Consumer (always one):
 *   - The session's main turn loop, which calls `drainSystemEventEntries`
 *     before composing the next user message.
 *
 * Concurrency:
 *   - Map is a global singleton, shared across the gateway process.
 *   - Mutations are NOT lock-guarded; producers run on the JS event loop
 *     and the consumer drains under the per-session lane lock that
 *     `command-queue.ts` already enforces, so the only "drain mid-write"
 *     race is one producer racing one drainer — and the drainer atomically
 *     snapshots-then-truncates so the worst case is "next call sees the
 *     latecomer".
 *   - 20-event soft cap per session (oldest dropped) prevents a runaway
 *     producer from starving memory.
 *   - Consecutive identical `text` is suppressed (returns `false` from
 *     `enqueueSystemEvent`) so a noisy producer can't fill the queue with
 *     duplicates.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveAgentDir } from "../config/paths.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
	normalizeOptionalLowercaseString,
	normalizeOptionalString,
} from "../shared/string-coerce.js";
import { mergeDeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { resolveAgentIdFromSessionKey } from "./routing/session-key.js";

const log = createSubsystemLogger("agents/session-inbox");

export type SystemEvent = {
	text: string;
	ts: number;
	contextKey?: string | null;
	deliveryContext?: DeliveryContext;
	trusted?: boolean;
};

const MAX_EVENTS = 20;

type SessionQueue = {
	queue: SystemEvent[];
	lastText: string | null;
	lastContextKey: string | null;
};

const SESSION_INBOX_QUEUES_KEY = Symbol.for("brigade.sessionInbox.queues");

const queues = resolveGlobalSingleton<Map<string, SessionQueue>>(
	SESSION_INBOX_QUEUES_KEY,
	() => new Map<string, SessionQueue>(),
);

type SystemEventOptions = {
	sessionKey: string;
	contextKey?: string | null;
	deliveryContext?: DeliveryContext;
	trusted?: boolean;
};

function requireSessionKey(key?: string | null): string {
	const trimmed = normalizeOptionalString(key) ?? "";
	if (!trimmed) {
		throw new Error("system events require a sessionKey");
	}
	return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
	return normalizeOptionalLowercaseString(key) ?? null;
}

function getSessionQueue(sessionKey: string): SessionQueue | undefined {
	return queues.get(requireSessionKey(sessionKey));
}

function getOrCreateSessionQueue(sessionKey: string): SessionQueue {
	const key = requireSessionKey(sessionKey);
	const existing = queues.get(key);
	if (existing) return existing;
	const created: SessionQueue = {
		queue: [],
		lastText: null,
		lastContextKey: null,
	};
	queues.set(key, created);
	return created;
}

function cloneSystemEvent(event: SystemEvent): SystemEvent {
	return {
		...event,
		...(event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}),
	};
}

/* ─── Wave O0.8 GAP 11 — JSONL persistence helpers ───────────────────────
 *
 * Persists each enqueued system event to `<agentDir>/inbox/<sessionKey>.jsonl`
 * so a gateway restart between child completion and parent next turn does
 * not lose the announce. Append on enqueue, delete on drain, capped at the
 * same 20-entry soft cap as the in-memory queue.
 *
 * Enabled when BRIGADE_ENABLE_INBOX_PERSIST is set. The gateway boot path
 * flips this on for production runs; existing tests (which already write
 * to the singleton in-memory Map) inherit a no-op disk path so they don't
 * pollute `~/.brigade`. New tests that need persistence opt in by setting
 * the env var alongside a tempdir-scoped BRIGADE_STATE_DIR.
 */

const INBOX_FILE_EXT = ".jsonl";

function isPersistDisabled(): boolean {
	// Operator opt-out always wins so production deployments can disable
	// the disk write surface entirely.
	if (process.env.BRIGADE_DISABLE_INBOX_PERSIST === "1") return true;
	// Default-off so existing tests that don't tempdir-isolate keep
	// passing. The gateway entry point flips ENABLE on for production.
	return process.env.BRIGADE_ENABLE_INBOX_PERSIST !== "1";
}

/** Replace any character outside `[A-Za-z0-9._-]` with `_` for cross-platform-safe filenames. */
function sanitizeSessionKeyForFile(sessionKey: string): string {
	return sessionKey.replace(/[^A-Za-z0-9._-]/g, "_");
}

function resolveInboxFilePath(sessionKey: string): string {
	const agentId = resolveAgentIdFromSessionKey(sessionKey);
	const safeName = sanitizeSessionKeyForFile(sessionKey);
	return path.join(resolveAgentDir(agentId), "inbox", `${safeName}${INBOX_FILE_EXT}`);
}

function ensureInboxDir(filePath: string): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
	} catch (err) {
		log.warn("inbox dir create failed", {
			dir: path.dirname(filePath),
			error: (err as Error)?.message,
		});
	}
}

// Convex mode: the in-memory `queues` Map remains the working store (the
// per-turn drains read it synchronously); these helpers mirror to the
// sessionInboxEvents table for cross-restart durability instead of writing
// JSONL under ~/.brigade. Fire-and-forget on a serial chain — a failed
// mirror never blocks event delivery (the in-memory copy is authoritative
// within a gateway lifetime).
let inboxMirrorChain: Promise<void> = Promise.resolve();
function inConvexMode(): boolean {
	return tryGetRuntimeContext()?.mode === "convex";
}
function enqueueInboxMirror(work: () => Promise<unknown>): void {
	inboxMirrorChain = inboxMirrorChain.then(work).then(
		() => {},
		(err) => log.warn("inbox convex mirror failed", { error: (err as Error)?.message }),
	);
}
export function awaitInboxMirrorFlush(): Promise<void> {
	return inboxMirrorChain;
}

function appendEventToDisk(sessionKey: string, event: SystemEvent): void {
	if (inConvexMode()) {
		const store = tryGetRuntimeContext()!.store;
		enqueueInboxMirror(() => store.messages.inboxEnqueue(sessionKey, event));
		return;
	}
	if (isPersistDisabled()) return;
	try {
		const filePath = resolveInboxFilePath(sessionKey);
		ensureInboxDir(filePath);
		fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
	} catch (err) {
		log.warn("inbox JSONL append failed", {
			sessionKey,
			error: (err as Error)?.message,
		});
	}
}

function truncateInboxFile(sessionKey: string): void {
	if (inConvexMode()) {
		const store = tryGetRuntimeContext()!.store;
		enqueueInboxMirror(() => store.messages.inboxDrain(sessionKey));
		return;
	}
	if (isPersistDisabled()) return;
	try {
		const filePath = resolveInboxFilePath(sessionKey);
		if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
	} catch (err) {
		log.warn("inbox JSONL truncate failed", {
			sessionKey,
			error: (err as Error)?.message,
		});
	}
}

function rewriteInboxFile(sessionKey: string, events: readonly SystemEvent[]): void {
	if (inConvexMode()) {
		// Replace semantics (cap-overflow path): drain then re-enqueue the
		// kept tail. The in-memory cap already applied, so `events` is small.
		const store = tryGetRuntimeContext()!.store;
		const kept = events.map(cloneSystemEvent);
		enqueueInboxMirror(async () => {
			await store.messages.inboxDrain(sessionKey);
			for (const e of kept) await store.messages.inboxEnqueue(sessionKey, e);
		});
		return;
	}
	if (isPersistDisabled()) return;
	try {
		const filePath = resolveInboxFilePath(sessionKey);
		if (events.length === 0) {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
			return;
		}
		ensureInboxDir(filePath);
		const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filePath, body, "utf8");
	} catch (err) {
		log.warn("inbox JSONL rewrite failed", {
			sessionKey,
			error: (err as Error)?.message,
		});
	}
}

function readInboxFromDisk(sessionKey: string): SystemEvent[] {
	if (isPersistDisabled()) return [];
	try {
		const filePath = resolveInboxFilePath(sessionKey);
		if (!fs.existsSync(filePath)) return [];
		const raw = fs.readFileSync(filePath, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim().length > 0);
		const out: SystemEvent[] = [];
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as SystemEvent;
				if (parsed && typeof parsed.text === "string" && typeof parsed.ts === "number") {
					out.push(parsed);
				}
			} catch {
				// Skip a corrupt line — the rest of the file is still useful.
			}
		}
		// Honour the cap so a runaway producer's persisted file can't blow
		// the in-memory queue on restore.
		if (out.length > MAX_EVENTS) return out.slice(out.length - MAX_EVENTS);
		return out;
	} catch (err) {
		log.warn("inbox JSONL read failed", {
			sessionKey,
			error: (err as Error)?.message,
		});
		return [];
	}
}

/**
 * Hydrate the in-memory queue for `sessionKey` from any unconsumed JSONL
 * entries on disk. Called lazily on first access so we only pay the read
 * cost when the session is actually used. Idempotent — repeat calls after
 * the first hydration are no-ops because the queue is already in-memory.
 */
function hydrateFromDiskIfNeeded(sessionKey: string): void {
	if (isPersistDisabled()) return;
	const existing = queues.get(sessionKey);
	if (existing) return;
	const persisted = readInboxFromDisk(sessionKey);
	if (persisted.length === 0) return;
	const tail = persisted[persisted.length - 1];
	const created: SessionQueue = {
		queue: persisted.map(cloneSystemEvent),
		lastText: tail?.text ?? null,
		lastContextKey: tail?.contextKey ?? null,
	};
	queues.set(sessionKey, created);
}

/**
 * `true` iff `contextKey` differs from the most-recently-enqueued event's
 * key for this session. Used by producers that want to suppress a follow-up
 * notification when the operator is still inside the same logical context
 * (e.g. a long-running exec emitting periodic status — only the first
 * status text needs to wake the session).
 */
export function isSystemEventContextChanged(
	sessionKey: string,
	contextKey?: string | null,
): boolean {
	hydrateFromDiskIfNeeded(requireSessionKey(sessionKey));
	const existing = getSessionQueue(sessionKey);
	const normalized = normalizeContextKey(contextKey);
	return normalized !== (existing?.lastContextKey ?? null);
}

/**
 * Enqueue a human-readable system event for the next turn on `sessionKey`.
 *
 * Returns:
 *   - `true`  → event accepted (queued or replaced a duplicate's metadata)
 *   - `false` → event dropped (empty text OR consecutive duplicate text)
 *
 * Empty-string `text` is dropped silently. Consecutive duplicates by `text`
 * are suppressed so a noisy producer can't flood the queue.
 */
export function enqueueSystemEvent(text: string, options: SystemEventOptions): boolean {
	const key = requireSessionKey(options?.sessionKey);
	// Wave O0.8 GAP 11 — restore any disk-persisted events before mutating
	// the in-memory queue so a post-restart enqueue doesn't strand the
	// pre-restart events.
	hydrateFromDiskIfNeeded(key);
	const entry = getOrCreateSessionQueue(key);
	const cleaned = text.trim();
	if (!cleaned) return false;
	const normalizedContextKey = normalizeContextKey(options?.contextKey);
	const normalizedDeliveryContext = normalizeDeliveryContext(options?.deliveryContext);
	entry.lastContextKey = normalizedContextKey;
	if (entry.lastText === cleaned) return false;
	entry.lastText = cleaned;
	const event: SystemEvent = {
		text: cleaned,
		ts: Date.now(),
		contextKey: normalizedContextKey,
		deliveryContext: normalizedDeliveryContext,
		trusted: options.trusted !== false,
	};
	entry.queue.push(event);
	if (entry.queue.length > MAX_EVENTS) {
		entry.queue.shift();
		// Persisted file's tail-N rewrite keeps disk + memory in sync.
		rewriteInboxFile(key, entry.queue);
	} else {
		appendEventToDisk(key, event);
	}
	return true;
}

/**
 * Atomic snapshot-and-truncate: returns every queued event for the session
 * in FIFO order and resets the queue.
 *
 * Empty queues return `[]` (NOT `undefined`). The session's queue entry is
 * deleted from the global Map after a successful drain so the registry
 * doesn't grow unbounded under churn.
 */
export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
	const key = requireSessionKey(sessionKey);
	// Hydrate first so post-restart drains see the pre-restart events.
	hydrateFromDiskIfNeeded(key);
	const entry = getSessionQueue(key);
	if (!entry || entry.queue.length === 0) return [];
	const out = entry.queue.map(cloneSystemEvent);
	entry.queue.length = 0;
	entry.lastText = null;
	entry.lastContextKey = null;
	queues.delete(key);
	// Wave O0.8 GAP 11 — clear persisted file once memory is drained so a
	// later restart-then-drain does not re-emit the same entries.
	truncateInboxFile(key);
	return out;
}

function areDeliveryContextsEqual(left?: DeliveryContext, right?: DeliveryContext): boolean {
	if (!left && !right) return true;
	if (!left || !right) return false;
	return (
		(left.channel ?? undefined) === (right.channel ?? undefined) &&
		(left.to ?? undefined) === (right.to ?? undefined) &&
		(left.threadId ?? undefined) === (right.threadId ?? undefined)
	);
}

function areSystemEventsEqual(left: SystemEvent, right: SystemEvent): boolean {
	return (
		left.text === right.text &&
		left.ts === right.ts &&
		(left.contextKey ?? null) === (right.contextKey ?? null) &&
		(left.trusted ?? true) === (right.trusted ?? true) &&
		areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext)
	);
}

/**
 * Partial drain. Removes ONLY the events that match the leading prefix of
 * `consumedEntries` (compared field-wise). If the caller's prefix doesn't
 * match (events arrived out of order, or were already drained), the queue
 * is left intact and `[]` is returned.
 *
 * Used by Step 12's pending-system-events partial drain: the prompt
 * assembler peeks at events, formats them, then consumes the exact set it
 * was about to render — guarantees no event is rendered AND queued at the
 * same time, even under concurrent writes.
 */
export function consumeSystemEventEntries(
	sessionKey: string,
	consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
	const key = requireSessionKey(sessionKey);
	hydrateFromDiskIfNeeded(key);
	const entry = getSessionQueue(key);
	if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) return [];
	if (
		consumedEntries.length > entry.queue.length ||
		!consumedEntries.every((event, index) => {
			const queued = entry.queue[index];
			return queued !== undefined && areSystemEventsEqual(queued, event);
		})
	) {
		return [];
	}
	const removed = entry.queue.splice(0, consumedEntries.length).map(cloneSystemEvent);
	if (entry.queue.length === 0) {
		entry.lastText = null;
		entry.lastContextKey = null;
		queues.delete(key);
		// Wave O0.8 GAP 11 — partial-drain that empties memory also clears disk.
		truncateInboxFile(key);
	} else {
		const newest = entry.queue[entry.queue.length - 1];
		if (newest) {
			entry.lastText = newest.text;
			entry.lastContextKey = newest.contextKey ?? null;
		}
		// Wave O0.8 GAP 11 — keep persisted file in sync with the trimmed memory queue.
		rewriteInboxFile(key, entry.queue);
	}
	return removed;
}

/** Drain just the text strings (legacy compatible). */
export function drainSystemEvents(sessionKey: string): string[] {
	return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

/** Read-only peek at the queued events for a session. */
export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
	hydrateFromDiskIfNeeded(requireSessionKey(sessionKey));
	return getSessionQueue(sessionKey)?.queue.map(cloneSystemEvent) ?? [];
}

/** Read-only peek at the queued event texts for a session. */
export function peekSystemEvents(sessionKey: string): string[] {
	return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

/** `true` iff the session has at least one queued event. */
export function hasSystemEvents(sessionKey: string): boolean {
	hydrateFromDiskIfNeeded(requireSessionKey(sessionKey));
	return (getSessionQueue(sessionKey)?.queue.length ?? 0) > 0;
}

/**
 * Remove the FIRST queued event matching `text` + `contextKey` exactly,
 * wherever it sits in the queue. Returns true when one was removed.
 *
 * Exists for producers that enqueue an event BEFORE a dispatch that can
 * fail (sessions_send enqueues the A2A attribution event, then dispatches
 * the peer turn): on a failed dispatch the event must be withdrawn or it
 * ghosts into the peer's NEXT unrelated turn ("A2A from X: …" acted on
 * hours later). `consumeSystemEventEntries` can't do this — it only
 * removes exact queue PREFIXES (its drain contract).
 */
export function removeMatchingSystemEvent(
	sessionKey: string,
	match: { text: string; contextKey?: string },
): boolean {
	const key = requireSessionKey(sessionKey);
	hydrateFromDiskIfNeeded(key);
	const entry = getSessionQueue(key);
	if (!entry || entry.queue.length === 0) return false;
	const idx = entry.queue.findIndex(
		(e) =>
			e.text === match.text &&
			(match.contextKey === undefined || e.contextKey === match.contextKey),
	);
	if (idx < 0) return false;
	entry.queue.splice(idx, 1);
	if (entry.queue.length === 0) {
		entry.lastText = null;
		entry.lastContextKey = null;
		queues.delete(key);
		truncateInboxFile(key);
	} else {
		const newest = entry.queue[entry.queue.length - 1];
		if (newest) {
			entry.lastText = newest.text;
			entry.lastContextKey = newest.contextKey ?? null;
		}
		rewriteInboxFile(key, entry.queue);
	}
	return true;
}

/**
 * Merge the delivery contexts of `events` into a single context. Later
 * events override earlier ones field-by-field. Used by the dispatcher to
 * pick a delivery target when multiple events fired for the same session.
 */
export function resolveSystemEventDeliveryContext(
	events: readonly SystemEvent[],
): DeliveryContext | undefined {
	let resolved: DeliveryContext | undefined;
	for (const event of events) {
		resolved = mergeDeliveryContext(event.deliveryContext, resolved);
	}
	return resolved;
}

/** Test-only — clear every queued event across every session. */
export function resetSessionInboxForTest(): void {
	queues.clear();
}

/**
 * Wave O0.8 GAP 11 — explicit "force re-hydrate from disk" for the
 * post-restart replay path. Production callers don't need this (hydration
 * is lazy on first access of every public read/write entry), but tests
 * that simulate a gateway restart by clearing the in-memory Map need to
 * trigger hydration without touching one of the public APIs first.
 */
export function forceHydrateFromDiskForTests(sessionKey: string): void {
	hydrateFromDiskIfNeeded(requireSessionKey(sessionKey));
}
