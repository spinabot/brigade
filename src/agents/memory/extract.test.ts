import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "./records.js";
import { linksFrom } from "./links.js";
import {
	flattenConversation,
	getCursor,
	parseExtractedFacts,
	runExtractionSweep,
	storeExtractedFacts,
} from "./extract.js";

/** Targets of a record's EXTRACTOR-written association edges (any typed factual kind,
 *  same_topic, or the legacy `relates`), by id — i.e. everything the relationship
 *  extractor can mint, excluding the store-minted lifecycle edges. */
function relatesTargets(store: FactStore, id: string): string[] {
	const rec = store.readAll().find((r) => r.memoryId === id);
	if (!rec) return [];
	const minted = new Set(["supersedes", "transition", "corrects", "derived_from", "supports"]);
	return linksFrom(rec)
		.filter((l) => !minted.has(l.kind))
		.map((l) => l.target)
		.sort();
}

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-extract-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("parseExtractedFacts", () => {
	it("parses a clean facts JSON object", () => {
		const facts = parseExtractedFacts(
			'{"facts":[{"content":"User is on Windows.","segment":"identity","importance":0.9}]}',
		);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.segment, "identity");
		assert.equal(facts[0]?.importance, 0.9);
	});
	it("grabs JSON even when wrapped in prose / fences", () => {
		const facts = parseExtractedFacts(
			'Here you go:\n```json\n{"facts":[{"content":"Likes spaces.","segment":"preference"}]}\n```\nDone.',
		);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.content, "Likes spaces.");
	});
	it("returns [] on garbage / no JSON / empty", () => {
		assert.deepEqual(parseExtractedFacts("no json here"), []);
		assert.deepEqual(parseExtractedFacts(""), []);
		assert.deepEqual(parseExtractedFacts("{not valid"), []);
	});
	it("drops malformed fact entries (missing content/segment)", () => {
		const facts = parseExtractedFacts(
			'{"facts":[{"segment":"identity"},{"content":"ok","segment":"knowledge"},{"content":""}]}',
		);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.content, "ok");
	});
	it("strips inline <think> reasoning that surrounds the JSON (local reasoning models)", () => {
		const facts = parseExtractedFacts(
			'<think>I should record that the user is on Windows and prefers spaces.</think>\n' +
				'{"facts":[{"content":"User is on Windows.","segment":"identity"}]}',
		);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.content, "User is on Windows.");
	});
	it("tolerates near-JSON (trailing commas / single quotes) via the JSON5 fallback", () => {
		const facts = parseExtractedFacts(
			"{'facts':[{'content':'Likes tabs','segment':'preference',},],}",
		);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.content, "Likes tabs");
	});
});

describe("storeExtractedFacts", () => {
	it("confines an untrusted distillation (correction→knowledge, no corrects), keeps descriptive, skips unknown", () => {
		const n = storeExtractedFacts(
			dir,
			[
				{ content: "User uses pnpm... no, npm.", segment: "correction", corrects: "pnpm" },
				{ content: "Bad segment.", segment: "nonsense" },
				{ content: "Deploys Fridays.", segment: "project" },
			],
			"turn-1",
		);
		assert.equal(n, 2); // confined-correction (→knowledge) + project; nonsense skipped
		const store = new FactStore(dir);
		const all = store.list();
		assert.equal(all.length, 2);
		// Auto-extraction defaults to the `extraction` (untrusted) tier, so a proposed
		// `correction` is CONFINED to descriptive `knowledge` — it can't author the
		// operator's self-model — and its `corrects` is dropped (it's evidence, not authority).
		assert.equal(all.find((r) => r.segment === "correction"), undefined, "no extraction-authored correction");
		const confined = all.find((r) => r.content === "User uses pnpm... no, npm.");
		assert.equal(confined?.segment, "knowledge");
		assert.equal(confined?.metadata?.corrects, undefined);
		assert.equal(confined?.sourceType, "extraction");
		assert.equal(confined?.sourceTurn, "turn-1");
		// The descriptive project fact passes through unchanged.
		assert.equal(all.find((r) => r.segment === "project")?.content, "Deploys Fridays.");
	});

	it("stamps a CHANNEL origin + sourceType so peer-derived facts are ISOLATED, not owner-scoped (poisoned-inbox guard)", () => {
		const peer = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" } as const;
		storeExtractedFacts(dir, [{ content: "the user prefers tabs", segment: "preference" }], "turn-peer", {
			origin: peer,
			sourceType: "channel_message",
		});
		const store = new FactStore(dir);
		assert.equal(store.list({ origin: { kind: "owner" } }).length, 0, "NOT in owner scope — can't poison the operator's recall");
		const peerFacts = store.list({ origin: peer });
		assert.equal(peerFacts.length, 1, "present only in the peer's own isolated scope");
		assert.equal(peerFacts[0]?.sourceType, "channel_message", "honest provenance stamp");
	});

	// IDEMPOTENCY (Fix 1) — extraction re-reads the SAME turns the operator already
	// taught via write_memory and REWORDS them; the reworded `knowledge`/no-subjectKey
	// copy slips past write-time dedup's strict near-exact bar, so without an
	// idempotency check it piles a subject-less churn twin beside the rich original.
	// Extraction re-seeing an already-stored fact must be a NO-OP (reinforce), not a row.
	it("does NOT re-create a fact the operator already taught (reinforces the existing one instead)", () => {
		const owner = { kind: "owner" } as const;
		const store = new FactStore(dir);
		// The operator taught a rich, subject-bearing fact.
		const taught = store.write({ content: "User is vegetarian — no meat or fish", segment: "identity", subjectKey: "diet", createdBy: owner });
		// Post-turn extraction distils a REWORDED copy of the SAME fact (segment knowledge,
		// no subjectKey) — a paraphrase well below the 0.85 write-time dedup bar.
		const stored = storeExtractedFacts(
			dir,
			[{ content: "The user is vegetarian and does not eat meat or fish", segment: "knowledge" }],
			"turn-9",
			{ origin: owner },
		);
		assert.equal(stored, 0, "no new row — the reworded copy is recognised as already-known");
		const active = store.list({ origin: owner });
		assert.equal(active.length, 1, "no churn duplicate created");
		assert.equal(active[0]?.memoryId, taught.memoryId, "the original rich record is what survived");
		assert.equal(active[0]?.subjectKey, "diet", "survivor keeps its subjectKey (vault hub anchor)");
		assert.equal(active[0]?.segment, "identity", "survivor keeps its specific segment");
		assert.equal(active[0]?.accessCount, 1, "the existing fact was REINFORCED (not duplicated)");
	});

	it("still stores a GENUINELY new extracted fact (idempotency must not suppress distinct facts)", () => {
		const owner = { kind: "owner" } as const;
		const store = new FactStore(dir);
		store.write({ content: "User lives in Hyderabad", segment: "identity", subjectKey: "location", createdBy: owner });
		// A different subject entirely — must be stored, not swallowed by the location fact.
		const stored = storeExtractedFacts(
			dir,
			[{ content: "User works at a startup in Bangalore", segment: "knowledge" }],
			"turn-10",
			{ origin: owner },
		);
		assert.equal(stored, 1, "a distinct fact is still stored");
		assert.equal(store.list({ origin: owner }).length, 2, "both the existing and the new fact coexist");
	});

	it("idempotency is ORIGIN-isolated — a peer's prior does NOT suppress an owner's extracted fact", () => {
		const owner = { kind: "owner" } as const;
		const peer = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" } as const;
		const store = new FactStore(dir);
		store.write({ content: "User is vegetarian — no meat or fish", segment: "identity", subjectKey: "diet", createdBy: peer });
		// The SAME fact extracted under the OWNER origin must still be stored — a peer's
		// record can't satisfy the owner's idempotency (origins are isolated stores).
		const stored = storeExtractedFacts(
			dir,
			[{ content: "The user is vegetarian and does not eat meat or fish", segment: "knowledge" }],
			"turn-11",
			{ origin: owner },
		);
		assert.equal(stored, 1, "owner extraction is not suppressed by a peer's identical fact");
		assert.equal(store.list({ origin: owner }).length, 1, "owner scope now has its own copy");
		assert.equal(store.list({ origin: peer }).length, 1, "peer scope unchanged");
	});
});

describe("flattenConversation", () => {
	it("renders user/assistant turns, skipping tool/system noise", () => {
		const text = flattenConversation([
			{ role: "user", content: "hey" },
			{ role: "assistant", content: [{ type: "text", text: "hi there" }] },
			{ role: "tool", content: "ignored" },
			{ role: "user", content: "" }, // empty → skipped
		]);
		assert.equal(text, "USER: hey\n\nASSISTANT: hi there");
	});
});

describe("runExtractionSweep — batched, cursor-tracked, LLM injected", () => {
	const messages = [
		{ role: "user", content: "I'm Bhasvanth and I'm on Windows." },
		{ role: "assistant", content: "Noted!" },
	];

	it("distills new turns, stores facts, advances the cursor", async () => {
		const llm = async () => '{"facts":[{"content":"User name is Bhasvanth.","segment":"identity"}]}';
		const res = await runExtractionSweep({ workspaceDir: dir, sessionId: "s1", messages, llm });
		assert.equal(res.ran, true);
		assert.equal(res.stored, 1);
		assert.equal(res.processedTo, 2);
		assert.equal(getCursor(dir, "s1"), 2);
		assert.equal(new FactStore(dir).list()[0]?.content, "User name is Bhasvanth.");
	});

	it("a CHANNEL-origin sweep isolates peer-derived facts; an owner sweep stays owner-scoped (the live poisoned-inbox fix)", async () => {
		const peer = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" } as const;
		const llm = async () => '{"facts":[{"content":"prefers deploying on Mondays","segment":"preference"}]}';
		// A peer turn's extraction must land in the PEER's scope, never the operator's.
		await runExtractionSweep({ workspaceDir: dir, sessionId: "peer-sess", messages, llm, origin: peer, sourceType: "channel_message" });
		const store = new FactStore(dir);
		assert.equal(store.list({ origin: { kind: "owner" } }).length, 0, "peer extraction did NOT leak into owner scope");
		assert.equal(store.list({ origin: peer }).length, 1, "peer extraction isolated to the peer");

		// An owner turn's extraction is owner-scoped, as before.
		await runExtractionSweep({ workspaceDir: dir, sessionId: "owner-sess", messages, llm, origin: { kind: "owner" } });
		assert.equal(store.list({ origin: { kind: "owner" } }).length, 1, "owner extraction lands in owner scope");
	});

	it("is a no-op when there's nothing new since the cursor (no LLM call)", async () => {
		let called = 0;
		const llm = async () => {
			called++;
			return "{}";
		};
		await runExtractionSweep({ workspaceDir: dir, sessionId: "s1", messages, llm });
		called = 0; // reset after first real sweep
		// Second sweep over the SAME messages → cursor already at end → skip.
		const res = await runExtractionSweep({ workspaceDir: dir, sessionId: "s1", messages, llm });
		assert.equal(res.ran, false);
		assert.equal(called, 0, "no second LLM call when nothing new");
	});

	it("does not advance the cursor if the LLM throws (retries next sweep)", async () => {
		const llm = async () => {
			throw new Error("provider down");
		};
		const res = await runExtractionSweep({ workspaceDir: dir, sessionId: "s1", messages, llm });
		assert.equal(res.ran, false);
		assert.equal(getCursor(dir, "s1"), 0, "cursor stays so the turns are retried");
	});

	it("ZERO-FACT GUARD: holds the cursor on an empty/garbage reply, but advances on a structured empty", async () => {
		// An empty/non-JSON reply is a TRANSIENT failure (not "nothing to extract") —
		// advancing here would skip these turns forever. Cursor must stay put.
		for (const broken of ["", "   ", "I could not find anything", "{not json"]) {
			const res = await runExtractionSweep({ workspaceDir: dir, sessionId: `g-${broken.length}`, messages, llm: async () => broken });
			assert.equal(res.ran, false, `unparseable reply (${JSON.stringify(broken)}) → no advance`);
			assert.equal(getCursor(dir, `g-${broken.length}`), 0, "cursor held for retry");
		}
		// MALFORMED-but-parseable replies that are NOT a reply envelope must ALSO hold —
		// they can carry un-distilled content. A top-level ARRAY of fact objects is the
		// worst case: its inner objects parse, but advancing would silently DROP those
		// facts (the regression an over-broad "any parseable JSON advances" signal caused).
		for (const [label, malformed] of [
			["top-level array of facts", '[{"content":"the deploy is on friday","segment":"knowledge"}]'],
			["object without a facts array", '{"foo":1}'],
		] as const) {
			const sid = `m-${label.length}`;
			const res = await runExtractionSweep({ workspaceDir: dir, sessionId: sid, messages, llm: async () => malformed });
			assert.equal(res.ran, false, `${label} → no advance (content not dropped)`);
			assert.equal(getCursor(dir, sid), 0, `${label}: cursor held for retry`);
		}
		// A STRUCTURED empty reply ({} or {facts:[]}) DID engage the model — nothing to
		// remember — so the cursor advances (re-distilling it would only waste calls).
		for (const [sid, empty] of [["empty-obj", "{}"], ["empty-facts", '{"facts":[]}']] as const) {
			const res = await runExtractionSweep({ workspaceDir: dir, sessionId: sid, messages, llm: async () => empty });
			assert.equal(res.ran, true, `structured empty (${empty}) is a real sweep`);
			assert.equal(res.stored, 0);
			assert.equal(getCursor(dir, sid), messages.length, `cursor advances past a genuine empty (${empty})`);
		}
	});

	it("RETRY CAP: after repeated unparseable replies, advances the cursor so it can't re-burn LLM calls forever", async () => {
		const sid = "cap-sess";
		let calls = 0;
		const llm = async () => {
			calls++;
			return "totally not json — a weak local model that never returns JSON";
		};
		// Attempts 1 & 2 HOLD the cursor (retry next sweep).
		await runExtractionSweep({ workspaceDir: dir, sessionId: sid, messages, llm });
		assert.equal(getCursor(dir, sid), 0, "attempt 1 holds the cursor");
		await runExtractionSweep({ workspaceDir: dir, sessionId: sid, messages, llm });
		assert.equal(getCursor(dir, sid), 0, "attempt 2 holds the cursor");
		// Attempt 3 hits the cap → advance past the un-distillable slice.
		const capped = await runExtractionSweep({ workspaceDir: dir, sessionId: sid, messages, llm });
		assert.equal(capped.ran, false);
		assert.equal(getCursor(dir, sid), messages.length, "attempt 3 advances the cursor (cap reached)");
		assert.equal(calls, 3);
		// A later sweep is now a no-op (cursor at end) — the loop is bounded.
		await runExtractionSweep({ workspaceDir: dir, sessionId: sid, messages, llm });
		assert.equal(calls, 3, "no further LLM calls once the cursor has advanced past the slice");
	});

	it("respects minNewMessages (skips tiny slices without a call)", async () => {
		let called = 0;
		const llm = async () => {
			called++;
			return "{}";
		};
		const res = await runExtractionSweep({
			workspaceDir: dir,
			sessionId: "s1",
			messages: [{ role: "user", content: "hi" }],
			llm,
			minNewMessages: 2,
		});
		assert.equal(res.ran, false);
		assert.equal(called, 0);
	});
});

describe("runExtractionSweep — semantic relationship edges (SAME call, no extra round-trip)", () => {
	const messages = [
		{ role: "user", content: "I'm vegetarian and I also have a peanut allergy." },
		{ role: "assistant", content: "Noted — I'll keep both dietary constraints in mind." },
	];

	it("writes `relates` edges between NEW facts from the SAME extraction reply (single LLM call)", async () => {
		let calls = 0;
		// ONE reply carries BOTH facts AND their relationship — proving no second call.
		const llm = async () => {
			calls += 1;
			return JSON.stringify({
				facts: [
					{ content: "User is vegetarian", segment: "identity" },
					{ content: "User has a peanut allergy", segment: "identity" },
				],
				relationships: [{ a: "new:0", b: "new:1", type: "co_constrains", reason: "both dietary constraints", strength: 4 }],
			});
		};
		const res = await runExtractionSweep({ workspaceDir: dir, sessionId: "s1", messages, llm, origin: { kind: "owner" } });
		assert.equal(res.ran, true);
		assert.equal(res.stored, 2);
		assert.equal(calls, 1, "exactly ONE model call — relationships rode the extraction reply");
		const store = new FactStore(dir);
		const veg = store.readAll().find((r) => r.content === "User is vegetarian")!;
		const peanut = store.readAll().find((r) => r.content === "User has a peanut allergy")!;
		assert.deepEqual(relatesTargets(store, veg.memoryId), [peanut.memoryId]);
		assert.deepEqual(relatesTargets(store, peanut.memoryId), [veg.memoryId], "bidirectional edge");
	});

	it("relates a NEW fact to an EXISTING candidate fact (mem_ ref resolved against the bounded candidate set)", async () => {
		const owner = { kind: "owner" } as const;
		const store = new FactStore(dir);
		// An existing fact the model should relate the new one to.
		const existing = store.write({ content: "User is vegetarian — no meat or fish", segment: "identity", subjectKey: "diet", createdBy: owner });
		const llm = async (prompt: string) => {
			// The candidate block must carry the existing fact's id (bounded recall surfaced it).
			assert.ok(prompt.includes(existing.memoryId), "existing candidate id present in the prompt");
			return JSON.stringify({
				facts: [{ content: "User avoids all animal products when cooking", segment: "preference" }],
				relationships: [{ a: "new:0", b: existing.memoryId, type: "co_constrains", reason: "both about the user's diet", strength: 4 }],
			});
		};
		const res = await runExtractionSweep({
			workspaceDir: dir,
			sessionId: "s2",
			messages: [
				{ role: "user", content: "When I cook I avoid all animal products." },
				{ role: "assistant", content: "Understood." },
			],
			llm,
			origin: owner,
		});
		assert.equal(res.ran, true);
		const neu = store.readAll().find((r) => r.content === "User avoids all animal products when cooking")!;
		assert.deepEqual(relatesTargets(store, neu.memoryId), [existing.memoryId], "new fact linked to the existing candidate");
		assert.deepEqual(relatesTargets(store, existing.memoryId), [neu.memoryId], "edge is bidirectional");
	});

	it("NO FABRICATION through the sweep — a hallucinated id in the reply is never written", async () => {
		const llm = async () =>
			JSON.stringify({
				facts: [{ content: "User is vegetarian", segment: "identity" }],
				relationships: [{ a: "new:0", b: "mem_NEVER_EXISTED", type: "co_constrains", reason: "made up", strength: 4 }],
			});
		const res = await runExtractionSweep({ workspaceDir: dir, sessionId: "s3", messages, llm, origin: { kind: "owner" } });
		assert.equal(res.stored, 1);
		const store = new FactStore(dir);
		const veg = store.readAll().find((r) => r.content === "User is vegetarian")!;
		assert.deepEqual(relatesTargets(store, veg.memoryId), [], "no edge to a fabricated id; no self-edge either");
	});

	it("a malformed/garbage reply stores no facts AND no edges (cursor held, see zero-fact guard)", async () => {
		const res = await runExtractionSweep({ workspaceDir: dir, sessionId: "s4", messages, llm: async () => "not json", origin: { kind: "owner" } });
		assert.equal(res.ran, false);
		assert.equal(new FactStore(dir).readAll().length, 0, "no facts, hence no edges");
	});
});
