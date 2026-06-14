// src/sessions/session-manager-factory.ts
//
// THE seam between Pi SDK's SessionManager and Brigade's storage layer.
//
// Filesystem mode: a one-line passthrough to `SessionManager.open(path)` —
// byte-identical to today.
//
// Convex mode: returns `SessionManager.inMemory()` whose runtime state is
// (a) pre-seeded from the `sessionTranscriptRecords` table so getBranch /
// buildSessionContext / byId / leafId behave exactly as if the JSONL
// existed, and (b) patched so every append lands on an ordered write-behind
// queue that flushes batches to Convex. Nothing touches disk.
//
// Why patching works (verified against pi-coding-agent 0.73.x source):
//   • `SessionManager.inMemory()` constructs with persist=false — Pi
//     natively skips ALL disk IO (session-manager.js:1003).
//   • `_persist(entry)` is the single append choke point — all eleven
//     appendXxx helpers funnel through `_appendEntry` → `_persist`
//     (session-manager.js:549-572). `_rewriteFile` is the only other
//     writer (migration + branch extraction; session-manager.js:528).
//   • TS `private` is type-system-only — `fileEntries` / `byId` / `leafId`
//     are plain runtime fields we can seed.
//   • Pi calls the appendXxx helpers synchronously from event handlers, so
//     the patched `_persist` returns synchronously after enqueueing; the
//     queue drains in batches (one transaction per flush — no torn
//     parent-id chains).
//
// Durability posture (operator decision 2026-06-10): in-memory queue with
// per-turn flush — `awaitTranscriptFlush()` is awaited at turn end and on
// gateway shutdown. A hard kill mid-turn loses at most the in-flight tail;
// transcripts are observability, not source of truth.

import { SessionManager } from "@mariozechner/pi-coding-agent";

import { tryGetRuntimeContext } from "../storage/runtime-context.js";
import type { PiTranscriptRecord } from "../storage/store.js";

interface PendingBatch {
	agentId: string;
	sessionId: string;
	records: PiTranscriptRecord[];
}

let _queue: PendingBatch | undefined;
let _flushChain: Promise<void> = Promise.resolve();
let _flushTimer: ReturnType<typeof setTimeout> | undefined;

const FLUSH_DELAY_MS = 250;
const FLUSH_MAX_BATCH = 50;

function scheduleFlush(): void {
	if (_flushTimer) return;
	_flushTimer = setTimeout(() => {
		_flushTimer = undefined;
		void flushNow();
	}, FLUSH_DELAY_MS);
	// Don't hold the event loop open for a pending transcript flush — the
	// turn-end await drains explicitly.
	_flushTimer.unref?.();
}

function flushNow(): Promise<void> {
	const batch = _queue;
	_queue = undefined;
	if (_flushTimer) {
		clearTimeout(_flushTimer);
		_flushTimer = undefined;
	}
	if (!batch || batch.records.length === 0) return _flushChain;
	const rctx = tryGetRuntimeContext();
	if (!rctx) return _flushChain;
	const store = rctx.store;
	_flushChain = _flushChain
		.then(() =>
			store.messages.appendRecordsBatch(batch.agentId, batch.sessionId, batch.records),
		)
		.catch((err) => {
			console.error(
				`brigade: transcript flush to convex failed (session ${batch.sessionId}) — ${(err as Error).message}`,
			);
		});
	return _flushChain;
}

/** Awaited at turn end + gateway shutdown: every transcript record appended
 *  so far has reached the backend when this resolves. */
export async function awaitTranscriptFlush(): Promise<void> {
	await flushNow();
}

/** Test-only. */
export function __resetTranscriptQueueForTests(): void {
	_queue = undefined;
	_flushChain = Promise.resolve();
	if (_flushTimer) {
		clearTimeout(_flushTimer);
		_flushTimer = undefined;
	}
}

function enqueue(agentId: string, sessionId: string, record: PiTranscriptRecord): void {
	if (_queue && (_queue.agentId !== agentId || _queue.sessionId !== sessionId)) {
		// Different session lane — flush the previous batch first so ordering
		// across lanes follows enqueue order.
		void flushNow();
	}
	if (!_queue) _queue = { agentId, sessionId, records: [] };
	_queue.records.push(record);
	if (_queue.records.length >= FLUSH_MAX_BATCH) {
		void flushNow();
		return;
	}
	scheduleFlush();
}

/** Pi SessionManager runtime internals we seed/patch. TS `private` fields
 *  are plain runtime properties in the compiled JS. */
interface SessionManagerInternals {
	fileEntries: Array<Record<string, unknown>>;
	byId: Map<string, Record<string, unknown>>;
	leafId: string | null;
	_persist: (entry: Record<string, unknown>) => void;
	_rewriteFile?: () => void;
}

export interface OpenSessionManagerArgs {
	agentId: string;
	sessionId: string;
	/** Canonical JSONL path — used verbatim in filesystem mode; convex mode
	 *  never touches it (kept only so Pi's getSessionFile() returns a stable
	 *  string for log lines). */
	transcriptPath: string;
	/** Pre-fetched transcript records (boot/turn paths that already loaded
	 *  them); when absent the factory loads from the store. */
	previousRecords?: PiTranscriptRecord[];
}

/** Open the session's SessionManager for the active storage mode. */
export async function openSessionManagerForAgent(
	args: OpenSessionManagerArgs,
): Promise<SessionManager> {
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode !== "convex") {
		return SessionManager.open(args.transcriptPath);
	}

	const records =
		args.previousRecords ??
		(await rctx.store.messages.readTranscript(args.agentId, args.sessionId));

	const sm = SessionManager.inMemory();
	const internals = sm as unknown as SessionManagerInternals;

	// Seed history. The stored records carry Pi's `id`/`parentId` chain
	// inside the payload verbatim; rebuilding `byId` + `leafId` here gives
	// getBranch/buildSessionContext the exact state a JSONL re-open yields.
	// The synthesised header row (type "session") is NOT part of byId.
	for (const record of records) {
		const entry = record as Record<string, unknown>;
		internals.fileEntries.push(entry);
		if (entry.type !== "session" && typeof entry.id === "string") {
			internals.byId.set(entry.id, entry);
			internals.leafId = entry.id;
		}
	}

	// Route every append to the write-behind queue. Wholesale replacement —
	// the persist/sessionFile guard in Pi's own body would early-return for
	// an inMemory() instance, so the original body never runs.
	internals._persist = (entry: Record<string, unknown>) => {
		enqueue(args.agentId, args.sessionId, entry as PiTranscriptRecord);
	};

	// `_rewriteFile` fires on v1→v3 migration and branch extraction — both
	// rewrite the WHOLE entry list. Realise transactionally.
	const agentId = args.agentId;
	const sessionId = args.sessionId;
	internals._rewriteFile = () => {
		const snapshot = internals.fileEntries.map(
			(e) => structuredClone(e) as PiTranscriptRecord,
		);
		const store = rctx.store;
		_flushChain = _flushChain
			.then(() => store.messages.replaceTranscript(agentId, sessionId, snapshot))
			.catch((err) => {
				console.error(
					`brigade: transcript rewrite to convex failed (session ${sessionId}) — ${(err as Error).message}`,
				);
			});
	};

	return sm;
}
