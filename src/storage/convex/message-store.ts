// src/storage/convex/message-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { NotImplementedYet } from "../store.js";
import type {
	MessageStore,
	PiTranscriptRecord,
	RepairReport,
	SystemEvent,
	Unsub,
} from "../store.js";

import { open as openSealed, sealJson } from "../encryption.js";
import { BRIGADE_BOOTSTRAP_DELIVERED_CUSTOM_TYPE } from "../../sessions/bootstrap-marker.js";

interface Deps { client: ConvexHttpClient }

function jsonToBytes(value: unknown): ArrayBuffer {
	return sealJson(value);
}
function bytesToJson<T>(b: ArrayBuffer | null | undefined): T | undefined {
	if (!b) return undefined;
	try {
		return JSON.parse(openSealed(b).toString("utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Concatenate sealed-byte slices of a chunked transcript record back into
 *  the whole sealed blob (slicing then re-joining AES-GCM ciphertext is
 *  lossless — the envelope is over the full payload). */
function concatArrayBuffers(parts: ArrayBuffer[]): ArrayBuffer {
	if (parts.length === 1) return parts[0]!;
	let total = 0;
	for (const p of parts) total += p.byteLength;
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		joined.set(new Uint8Array(p), offset);
		offset += p.byteLength;
	}
	return joined.buffer;
}

export class ConvexMessageStore implements MessageStore {
	constructor(private readonly deps: Deps) {}

	async appendRecord(
		agentId: string,
		sessionId: string,
		record: PiTranscriptRecord,
	): Promise<void> {
		const customType = (record as { customType?: unknown }).customType;
		await this.deps.client.mutation(api.messages.appendRecord, {
			agentId,
			sessionId,
			type: record.type,
			...(typeof customType === "string" ? { customType } : {}),
			payload: jsonToBytes(record),
		});
	}

	async appendRecordsBatch(
		agentId: string,
		sessionId: string,
		records: PiTranscriptRecord[],
	): Promise<void> {
		if (records.length === 0) return;
		// Slice into byte- AND count-bounded sub-batches: one mutation can't
		// carry an unbounded arg array (arg-size limit) or write unbounded rows
		// (~8k-write cap; a single record may chunk into many rows). Each sub-
		// batch is its own appendRecordsBatch call; the server derives seq from
		// the live tail, so sequential sub-batches chain identically to one call.
		const MAX_COUNT = 256;
		const MAX_BYTES = 6 * 1024 * 1024;
		let batch: Array<{ type: string; customType?: string; payload: ArrayBuffer }> = [];
		let bytes = 0;
		const flush = async (): Promise<void> => {
			if (batch.length === 0) return;
			await this.deps.client.mutation(api.messages.appendRecordsBatch, {
				agentId,
				sessionId,
				records: batch,
			});
			batch = [];
			bytes = 0;
		};
		for (const record of records) {
			const customType = (record as { customType?: unknown }).customType;
			const payload = jsonToBytes(record);
			if (
				batch.length > 0 &&
				(batch.length >= MAX_COUNT || bytes + payload.byteLength > MAX_BYTES)
			) {
				await flush();
			}
			batch.push({
				type: record.type,
				...(typeof customType === "string" ? { customType } : {}),
				payload,
			});
			bytes += payload.byteLength;
		}
		await flush();
	}

	async replaceTranscript(
		agentId: string,
		sessionId: string,
		records: PiTranscriptRecord[],
	): Promise<void> {
		// Wholesale replace at ANY size, lossless: clear the session in bounded
		// delete-pages, then append the new records in byte-bounded batches. The
		// old single `replaceTranscript` mutation read + deleted + inserted the
		// WHOLE transcript in one execution — it blew the 16 MiB read, the
		// 8k-delete, the 8k-write AND the mutation arg-size caps on a long
		// transcript. NOTE: no longer a single atomic transaction (unbounded
		// delete+insert can't be one Convex mutation) — it deletes then appends;
		// an interruption leaves the session empty and a re-run recovers (migrate
		// is idempotent; Pi's _rewriteFile is always followed by a full rewrite).
		await this.deleteTranscript(agentId, sessionId);
		await this.appendRecordsBatch(agentId, sessionId, records);
	}

	async readTranscript(
		agentId: string,
		sessionId: string,
		opts?: { limit?: number; tailBytes?: number },
	): Promise<PiTranscriptRecord[]> {
		// Page by seq cursor until we've satisfied `want` or the transcript is
		// exhausted. A single `take(limit)` truncates a session longer than the
		// per-query read cap; migrate asks for "all" (a huge limit) and MUST get
		// every record so the copy is faithful.
		//
		// Chunk reassembly: an oversized record was split across `chunkCount`
		// consecutive rows on write (see convex/messages.ts). They arrive in
		// seq order (= chunkIndex order) and contiguously (one atomic batch),
		// so we collect `chunkCount` consecutive chunk rows, concatenate their
		// sealed-byte slices into the whole blob, then decrypt once.
		const want = opts?.limit && opts.limit > 0 ? opts.limit : 1000;
		const PAGE = 4000;
		const out: PiTranscriptRecord[] = [];
		let afterSeq: number | undefined;
		// A chunk group that may straddle a page boundary.
		let pending: { count: number; parts: ArrayBuffer[] } | undefined;
		while (out.length < want) {
			const rows = (await this.deps.client.query(api.messages.readTranscript, {
				agentId,
				sessionId,
				limit: PAGE,
				...(afterSeq !== undefined ? { afterSeq } : {}),
			})) as Array<{
				payload: ArrayBuffer;
				seq: number;
				chunkIndex?: number;
				chunkCount?: number;
			}>;
			if (rows.length === 0) break;
			for (const row of rows) {
				afterSeq = row.seq;
				const cc =
					typeof row.chunkCount === "number" && row.chunkCount > 1 ? row.chunkCount : 1;
				if (cc <= 1) {
					// Normal single-row record. (Defensive: a stray pending here
					// would mean a torn group — impossible with atomic writes —
					// so drop it rather than corrupt the stream.)
					pending = undefined;
					const parsed = bytesToJson<PiTranscriptRecord>(row.payload);
					if (parsed) out.push(parsed);
					continue;
				}
				// Chunk row — collect by arrival order (== chunkIndex order).
				if (!pending || pending.count !== cc) pending = { count: cc, parts: [] };
				pending.parts.push(row.payload);
				if (pending.parts.length >= pending.count) {
					const parsed = bytesToJson<PiTranscriptRecord>(concatArrayBuffers(pending.parts));
					if (parsed) out.push(parsed);
					pending = undefined;
				}
			}
			// Do NOT stop on a short page: the server caps each page by BYTES
			// (~8 MiB) as well as count, so a page can be short mid-transcript.
			// End-of-data is signalled ONLY by an empty page (handled above) —
			// keep paging via afterSeq until then (bounded by `want`).
		}
		return out;
	}

	async hasBootstrapDelivered(agentId: string, sessionId: string): Promise<boolean> {
		// Mirror the disk walk (hasDeliveredBootstrapToSession): scan
		// newest-first and honour compaction-invalidation — a `compaction`
		// record newer than the marker means the bootstrap context was likely
		// compacted out, so the next turn must re-deliver. Walking the
		// newest-first tail, the FIRST marker-or-compaction encountered decides:
		// marker → delivered (still valid); compaction → invalidated.
		const rows = (await this.deps.client.query(api.messages.readMarkerTail, {
			agentId,
			sessionId,
		})) as Array<{ type: string; customType?: string }>;
		for (const r of rows) {
			if (r.type === "compaction") return false;
			if (r.type === "custom" && r.customType === BRIGADE_BOOTSTRAP_DELIVERED_CUSTOM_TYPE) {
				return true;
			}
		}
		return false;
	}

	async markBootstrapDelivered(agentId: string, sessionId: string): Promise<void> {
		await this.appendRecord(agentId, sessionId, {
			type: "custom",
			customType: BRIGADE_BOOTSTRAP_DELIVERED_CUSTOM_TYPE,
			data: { timestamp: new Date().toISOString() },
		} as unknown as PiTranscriptRecord);
	}

	async deleteTranscript(agentId: string, sessionId: string): Promise<void> {
		// Server deletes one bounded page per call (byte + count capped) and
		// returns how many it removed; loop until nothing remains. A single
		// delete-all would exceed the 16 MiB read + 8k-delete caps on a long
		// session. Lossless — every row is removed across the loop.
		for (;;) {
			const deleted = (await this.deps.client.mutation(api.messages.deleteTranscript, {
				agentId,
				sessionId,
			})) as number;
			if (deleted <= 0) break;
		}
	}

	async repairIfNeeded(_agentId: string, _sessionId: string): Promise<RepairReport> {
		// Convex rows can't be torn mid-write — the storage layer guarantees
		// atomicity per mutation. Repair is a no-op in convex mode.
		return { repaired: false, reason: "convex transactional storage; no torn writes" } as unknown as RepairReport;
	}

	async withWriteLock<T>(
		_agentId: string,
		_sessionId: string,
		fn: () => Promise<T>,
		_opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<T> {
		// Convex mutations on the same row keys are linearised by the backend.
		// Convex mode achieves the same property without an in-process lock.
		return fn();
	}

	subscribe(_sessionId: string, _cb: (msg: PiTranscriptRecord) => void): Unsub {
		// Convex live-query subscription is a follow-up.
		return () => undefined;
	}

	async inboxEnqueue(sessionKey: string, event: SystemEvent): Promise<boolean> {
		const e = event as unknown as {
			text?: string;
			contextKey?: string | null;
			deliveryContext?: unknown;
			trusted?: boolean;
		};
		const text = typeof e.text === "string" ? e.text : "";
		if (!text) return false;
		const ts = (e as { ts?: number }).ts;
		await this.deps.client.mutation(api.messages.inboxEnqueue, {
			sessionKey,
			text: jsonToBytes(text),
			...(typeof ts === "number" ? { ts } : {}),
			...(e.contextKey !== undefined && e.contextKey !== null ? { contextKey: e.contextKey } : {}),
			...(e.deliveryContext !== undefined ? { deliveryContext: e.deliveryContext } : {}),
			trusted: e.trusted !== false,
		});
		return true;
	}

	async inboxDrain(sessionKey: string): Promise<SystemEvent[]> {
		const rows = (await this.deps.client.mutation(api.messages.inboxDrain, {
			sessionKey,
		})) as Array<{ text: ArrayBuffer; ts: number; contextKey?: string; deliveryContext?: unknown; trusted: boolean }>;
		return rows.map((r) => ({
			text: bytesToJson<string>(r.text) ?? "",
			ts: r.ts,
			...(r.contextKey !== undefined ? { contextKey: r.contextKey } : {}),
			...(r.deliveryContext !== undefined ? { deliveryContext: r.deliveryContext } : {}),
			trusted: r.trusted,
		})) as unknown as SystemEvent[];
	}

	async inboxConsumePrefix(
		sessionKey: string,
		prefix: readonly SystemEvent[],
	): Promise<SystemEvent[]> {
		const rows = (await this.deps.client.mutation(api.messages.inboxConsumePrefix, {
			sessionKey,
			prefixLength: prefix.length,
		})) as Array<{ text: ArrayBuffer; ts: number; contextKey?: string; deliveryContext?: unknown; trusted?: boolean }>;
		return rows.map((r) => ({
			text: bytesToJson<string>(r.text) ?? "",
			ts: r.ts,
			...(r.contextKey !== undefined ? { contextKey: r.contextKey } : {}),
			...(r.deliveryContext !== undefined ? { deliveryContext: r.deliveryContext } : {}),
			...(r.trusted !== undefined ? { trusted: r.trusted } : {}),
		})) as unknown as SystemEvent[];
	}

	async inboxPeek(sessionKey: string): Promise<SystemEvent[]> {
		const rows = (await this.deps.client.query(api.messages.inboxPeek, {
			sessionKey,
		})) as Array<{ text: ArrayBuffer; ts: number; contextKey?: string; deliveryContext?: unknown; trusted?: boolean }>;
		return rows.map((r) => ({
			text: bytesToJson<string>(r.text) ?? "",
			ts: r.ts,
			...(r.contextKey !== undefined ? { contextKey: r.contextKey } : {}),
			...(r.deliveryContext !== undefined ? { deliveryContext: r.deliveryContext } : {}),
			...(r.trusted !== undefined ? { trusted: r.trusted } : {}),
		})) as unknown as SystemEvent[];
	}

	async inboxHasEvents(sessionKey: string): Promise<boolean> {
		return (await this.deps.client.query(api.messages.inboxHasEvents, {
			sessionKey,
		})) as boolean;
	}
}
