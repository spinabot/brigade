/**
 * BlueBubbles inbound debounce / balloon-coalescing.
 *
 * BlueBubbles fires SEPARATE `new-message` webhook events for things that are
 * really ONE logical message:
 *
 *   - a URL text + its link-preview "balloon" (the balloon carries an
 *     `associatedMessageGuid` pointing back at the text + a `balloonBundleId`);
 *   - a text and its attachment that the server splits across two webhooks
 *     (same `messageGuid`, one with text, one with the now-indexed media);
 *   - rapid-fire bubbles a sender taps out back-to-back.
 *
 * Dispatching each as its own turn produces TWO agent replies for one user
 * action. This module collects messages that share a coalescing key inside a
 * short window (default 500 ms) and MERGES them into one (`combineDebounceEntries`):
 * the texts join (de-duped), the attachments concatenate, the latest timestamp
 * wins, and reply context is preserved. The merged message is then dispatched
 * once.
 *
 * Self-contained + channel-local: it owns its own timer map (no central
 * dependency). The connection wires it in ONLY when `inboundDebounceMs > 0`; the
 * default (0) keeps the historical synchronous dispatch path so nothing changes
 * for installs that don't opt in.
 */

import type { BlueBubblesInboundMessage } from "./connection.js";

/** Default debounce window (ms) when coalescing is enabled but no value is given. */
export const BLUEBUBBLES_DEFAULT_INBOUND_DEBOUNCE_MS = 500;
/** Hard ceiling on the debounce window (defends against a misconfigured huge value). */
export const BLUEBUBBLES_MAX_INBOUND_DEBOUNCE_MS = 10_000;

/** One buffered inbound awaiting a possible merge. */
interface DebounceEntry {
	message: BlueBubblesInboundMessage;
}

/** A per-key buffer + its pending flush timer. */
interface DebounceSlot {
	entries: DebounceEntry[];
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Merge multiple buffered inbound messages into ONE. The first entry is the
 * base (typically the originating text); texts from the rest are appended unless
 * a case-insensitive duplicate (a URL echoed in both the text and its balloon),
 * attachments concatenate, the latest timestamp wins, and the first reply target
 * is preserved. The deferred-media thunks are chained so the merged message
 * resolves ALL of them.
 */
export function combineDebounceEntries(entries: DebounceEntry[]): BlueBubblesInboundMessage {
	if (entries.length === 0) throw new Error("cannot combine zero debounce entries");
	const first = entries[0]!.message;
	if (entries.length === 1) return first;

	// Join texts, skipping empties + case-insensitive duplicates.
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const { message } of entries) {
		const text = (typeof message.text === "string" ? message.text : "").trim();
		if (!text) continue;
		const norm = text.toLowerCase();
		if (seen.has(norm)) continue;
		seen.add(norm);
		parts.push(text);
	}

	// Concatenate raw attachment descriptors across all entries.
	const attachments = entries.flatMap((e) => e.message.attachments ?? []);

	// Latest timestamp wins.
	const stamps = entries
		.map((e) => e.message.timestampMs)
		.filter((t): t is number => typeof t === "number");
	const latest = stamps.length > 0 ? Math.max(...stamps) : first.timestampMs;

	// Chain every deferred-media thunk so the merged message resolves them all.
	const thunks = entries.map((e) => e.message.resolveMedia).filter((r): r is NonNullable<typeof r> => !!r);
	const resolveMedia =
		thunks.length > 0
			? async () => {
					const all = await Promise.all(thunks.map((t) => t().catch(() => [])));
					return all.flat();
				}
			: first.resolveMedia;

	// Prefer a reply target from any entry that carries one.
	const withReply = entries.find((e) => e.message.replyToGuid)?.message;

	const merged: BlueBubblesInboundMessage = {
		...first,
		text: parts.join(" "),
		attachments,
		...(latest !== undefined ? { timestampMs: latest } : {}),
		...(withReply?.replyToGuid ? { replyToGuid: withReply.replyToGuid } : {}),
		// The merged message is no longer "just a balloon".
		...(resolveMedia ? { resolveMedia } : {}),
	};
	// Drop the balloon-only markers now that we've coalesced.
	delete merged.balloonBundleId;
	return merged;
}

/**
 * The coalescing key for an inbound message. A balloon (URL preview / sticker)
 * uses a different `messageGuid` than its parent text but carries the parent's
 * `associatedMessageGuid` — key on THAT so text + balloon collapse. Otherwise key
 * on the stable `messageGuid` (a text + its late-indexed attachment share it).
 * Falls back to chat + sender so two bare bubbles in the same chat still merge.
 */
export function resolveDebounceKey(accountId: string, msg: BlueBubblesInboundMessage): string {
	// A balloon keys on its PARENT's guid so it collides with the parent text
	// (which keys on its OWN messageGuid) — same `msg:` namespace either way.
	const assoc = msg.associatedMessageGuid?.trim();
	if (msg.balloonBundleId?.trim() && assoc) return `${accountId}:msg:${assoc}`;
	const guid = msg.messageGuid?.trim();
	if (guid) return `${accountId}:msg:${guid}`;
	const chat = msg.chatGuid?.trim() || "chat";
	return `${accountId}:${chat}:${msg.from}`;
}

/** A debouncer: enqueue an inbound + a way to tear all pending timers down. */
export interface BlueBubblesInboundDebouncer {
	/** Buffer an inbound; it (and any that share its key) flush after the window. */
	enqueue(msg: BlueBubblesInboundMessage): void;
	/** Flush everything immediately (e.g. on close). */
	flushAll(): void;
	/** Clear all pending timers without flushing (teardown). */
	clear(): void;
}

export interface CreateInboundDebouncerArgs {
	accountId: string;
	/** Debounce window (ms). Clamped to `(0, MAX]`. */
	debounceMs: number;
	/** Called with the (possibly merged) message once a key's window elapses. */
	dispatch: (msg: BlueBubblesInboundMessage) => void;
	/** Optional verbose logger. */
	log?: (msg: string) => void;
}

/** Clamp a requested debounce window into `[1, MAX]` ms. */
export function clampInboundDebounceMs(raw: number | undefined): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 0;
	if (n <= 0) return 0;
	return Math.min(n, BLUEBUBBLES_MAX_INBOUND_DEBOUNCE_MS);
}

/**
 * Build a per-conversation inbound debouncer. Each coalescing key gets its own
 * buffer + timer; when the timer fires the buffered entries are merged (or passed
 * through when there's only one) and handed to `dispatch`.
 */
export function createBlueBubblesInboundDebouncer(args: CreateInboundDebouncerArgs): BlueBubblesInboundDebouncer {
	const windowMs = clampInboundDebounceMs(args.debounceMs);
	const slots = new Map<string, DebounceSlot>();

	const flush = (key: string): void => {
		const slot = slots.get(key);
		if (!slot) return;
		slots.delete(key);
		clearTimeout(slot.timer);
		if (slot.entries.length === 0) return;
		try {
			const out = slot.entries.length === 1 ? slot.entries[0]!.message : combineDebounceEntries(slot.entries);
			if (slot.entries.length > 1) {
				args.log?.(`coalesced ${slot.entries.length} messages into one turn`);
			}
			args.dispatch(out);
		} catch (err) {
			args.log?.(`debounce flush failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	return {
		enqueue(msg: BlueBubblesInboundMessage): void {
			// Window disabled → straight through (defensive; callers gate on > 0).
			if (windowMs <= 0) {
				args.dispatch(msg);
				return;
			}
			const key = resolveDebounceKey(args.accountId, msg);
			const existing = slots.get(key);
			if (existing) {
				existing.entries.push({ message: msg });
				clearTimeout(existing.timer);
				existing.timer = arm(key);
				return;
			}
			slots.set(key, { entries: [{ message: msg }], timer: arm(key) });
		},
		flushAll(): void {
			for (const key of [...slots.keys()]) flush(key);
		},
		clear(): void {
			for (const slot of slots.values()) clearTimeout(slot.timer);
			slots.clear();
		},
	};

	function arm(key: string): ReturnType<typeof setTimeout> {
		const t = setTimeout(() => flush(key), windowMs);
		if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
		return t;
	}
}
