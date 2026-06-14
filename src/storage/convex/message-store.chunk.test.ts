/**
 * ConvexMessageStore transcript-chunk reassembly tests.
 *
 * Convex caps a single document at 1 MiB. A transcript record whose sealed
 * payload exceeds that is split across consecutive rows on write
 * (convex/messages.ts insertRecordChunked) and stitched back here on read.
 * These tests pin the CLIENT reassembly deterministically (no live backend):
 * seal a record, slice the sealed bytes into chunk rows exactly as the
 * server would, feed them through a stubbed query, and assert the original
 * record round-trips — plus normal single-row records and a mixed page.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { ConvexMessageStore } from "./message-store.js";
import { sealJson } from "../encryption.js";
import type { PiTranscriptRecord } from "../store.js";

/** Slice an ArrayBuffer into `n` roughly-equal parts (mirrors the server's
 *  fixed-size slicing closely enough — reassembly only needs concat order). */
function sliceInto(buf: ArrayBuffer, n: number): ArrayBuffer[] {
	const size = Math.ceil(buf.byteLength / n);
	const parts: ArrayBuffer[] = [];
	for (let i = 0; i < n; i += 1) {
		parts.push(buf.slice(i * size, Math.min((i + 1) * size, buf.byteLength)));
	}
	return parts;
}

interface Row {
	payload: ArrayBuffer;
	seq: number;
	chunkIndex?: number;
	chunkCount?: number;
}

/** A stub ConvexHttpClient whose `query(readTranscript)` serves `pages` in
 *  order (one page per call), then []. */
function stubClientServing(pages: Row[][]): { query: (...a: unknown[]) => Promise<unknown> } {
	let call = 0;
	return {
		query: async () => {
			const page = pages[call] ?? [];
			call += 1;
			return page;
		},
	};
}

function makeStore(pages: Row[][]): ConvexMessageStore {
	return new ConvexMessageStore({
		client: stubClientServing(pages) as never,
	});
}

describe("ConvexMessageStore: transcript chunk reassembly", () => {
	it("a record split into N chunk rows reassembles to the original", async () => {
		const big = "X".repeat(2_000_000); // ~2 MB → would never fit one row
		const record = {
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: big }] },
		} as unknown as PiTranscriptRecord;

		const sealed = sealJson(record);
		const parts = sliceInto(sealed, 3);
		const page: Row[] = parts.map((payload, i) => ({
			payload,
			seq: i + 1,
			chunkIndex: i,
			chunkCount: 3,
		}));
		// Page is full-but-drained: first call returns the 3 rows, the loop
		// sees a short page (3 < PAGE) and stops.
		const store = makeStore([page]);

		const out = await store.readTranscript("main", "s1", { limit: 1000 });
		assert.equal(out.length, 1, "three chunk rows collapse to ONE record");
		assert.deepEqual(out[0], record, "reassembled record is byte-for-byte the original");
	});

	it("normal single-row records pass through unchanged", async () => {
		const r1 = { type: "message", message: { role: "user", content: "hi" } } as unknown as PiTranscriptRecord;
		const r2 = { type: "message", message: { role: "assistant", content: "yo" } } as unknown as PiTranscriptRecord;
		const page: Row[] = [
			{ payload: sealJson(r1), seq: 1 },
			{ payload: sealJson(r2), seq: 2 },
		];
		const store = makeStore([page]);
		const out = await store.readTranscript("main", "s1", { limit: 1000 });
		assert.deepEqual(out, [r1, r2]);
	});

	it("a mixed page (normal, chunked, normal) reassembles in order", async () => {
		const a = { type: "message", message: { role: "user", content: "a" } } as unknown as PiTranscriptRecord;
		const bigB = { type: "message", message: { role: "assistant", content: "B".repeat(1_800_000) } } as unknown as PiTranscriptRecord;
		const c = { type: "message", message: { role: "user", content: "c" } } as unknown as PiTranscriptRecord;

		const bParts = sliceInto(sealJson(bigB), 2);
		const page: Row[] = [
			{ payload: sealJson(a), seq: 1 },
			{ payload: bParts[0]!, seq: 2, chunkIndex: 0, chunkCount: 2 },
			{ payload: bParts[1]!, seq: 3, chunkIndex: 1, chunkCount: 2 },
			{ payload: sealJson(c), seq: 4 },
		];
		const store = makeStore([page]);
		const out = await store.readTranscript("main", "s1", { limit: 1000 });
		assert.deepEqual(out, [a, bigB, c], "order preserved, middle record reassembled");
	});

	it("a chunk group split across two pages still reassembles", async () => {
		const bigB = { type: "message", message: { role: "assistant", content: "B".repeat(2_400_000) } } as unknown as PiTranscriptRecord;
		const parts = sliceInto(sealJson(bigB), 3);
		// PAGE is 4000 internally, so a real split needs >4000 rows — simulate
		// the carry by serving the group across two stub pages where the FIRST
		// page is exactly PAGE-length so the loop continues. We fake "full
		// page" by padding the first page to 4000 rows with tiny records, then
		// the chunk group straddles into page 2.
		const filler: Row[] = [];
		const fillerRecords: PiTranscriptRecord[] = [];
		for (let i = 0; i < 3998; i += 1) {
			const r = { type: "message", message: { role: "user", content: `f${i}` } } as unknown as PiTranscriptRecord;
			fillerRecords.push(r);
			filler.push({ payload: sealJson(r), seq: i + 1 });
		}
		const page1: Row[] = [
			...filler,
			{ payload: parts[0]!, seq: 3999, chunkIndex: 0, chunkCount: 3 },
			{ payload: parts[1]!, seq: 4000, chunkIndex: 1, chunkCount: 3 },
		];
		const page2: Row[] = [{ payload: parts[2]!, seq: 4001, chunkIndex: 2, chunkCount: 3 }];
		const store = makeStore([page1, page2]);
		const out = await store.readTranscript("main", "s1", { limit: 1_000_000 });
		assert.equal(out.length, fillerRecords.length + 1);
		assert.deepEqual(out[out.length - 1], bigB, "group straddling the page boundary reassembled");
	});
});
