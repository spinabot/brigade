import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore, type MemoryRecordOrigin } from "../store/records.js";
import { linksFrom, type MemoryLinkKind } from "../graph/links.js";
import { renderNote } from "../exports/vault.js";
import {
	buildCandidateBlock,
	fetchRelationshipCandidates,
	GLEANING_PROMPT,
	mapNewFactIds,
	MAX_SAME_TOPIC_PER_FACT,
	MIN_FACTUAL_STRENGTH,
	parseRelationshipRefs,
	resolveRelationshipPairs,
	runRelinkPass,
	SAME_TOPIC_STRENGTH,
} from "./relationship-extract.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-rel-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const OWNER: MemoryRecordOrigin = { kind: "owner" };

/** All edges of a record of a given kind, by target (the substrate the renderer turns
 *  into `## Related` / `## Same area` wikilinks). */
function edgesOfKind(store: FactStore, id: string, kind: MemoryLinkKind): string[] {
	const rec = store.readAll().find((r) => r.memoryId === id);
	if (!rec) return [];
	return linksFrom(rec)
		.filter((l) => l.kind === kind)
		.map((l) => l.target)
		.sort();
}

/** Every link of a record (kind+target+reason) for richer assertions. */
function linksOf(store: FactStore, id: string): Array<{ kind: string; target: string; reason?: string; strength?: number }> {
	const rec = store.readAll().find((r) => r.memoryId === id);
	return rec ? linksFrom(rec) : [];
}

describe("parseRelationshipRefs — carries type/reason/strength through", () => {
	it("parses a typed relationship array from a clean object", () => {
		const refs = parseRelationshipRefs(
			'{"facts":[],"relationships":[{"a":"new:0","b":"mem_x","type":"co_constrains","reason":"both diet","strength":4}]}',
		);
		assert.equal(refs.length, 1);
		assert.deepEqual({ a: refs[0]?.a, b: refs[0]?.b, type: refs[0]?.type }, { a: "new:0", b: "mem_x", type: "co_constrains" });
		assert.equal(refs[0]?.reason, "both diet");
		assert.equal(refs[0]?.strength, 4);
	});
	it("clamps a wild strength into 1..5 and rounds", () => {
		const refs = parseRelationshipRefs('{"relationships":[{"a":"mem_1","b":"mem_2","type":"uses","reason":"r","strength":9.6}]}');
		assert.equal(refs[0]?.strength, 5, "9.6 clamps to 5");
		const refs2 = parseRelationshipRefs('{"relationships":[{"a":"mem_1","b":"mem_2","type":"uses","reason":"r","strength":-3}]}');
		assert.equal(refs2[0]?.strength, 1, "-3 clamps to 1");
	});
	it("grabs the relationships even when wrapped in prose / fences", () => {
		const refs = parseRelationshipRefs('ok:\n```json\n{"relationships":[{"a":"mem_1","b":"mem_2","type":"uses","reason":"x"}]}\n```');
		assert.equal(refs.length, 1);
		assert.deepEqual({ a: refs[0]?.a, b: refs[0]?.b }, { a: "mem_1", b: "mem_2" });
	});
	it("returns [] on garbage / absent relationships / empty", () => {
		assert.deepEqual(parseRelationshipRefs("no json"), []);
		assert.deepEqual(parseRelationshipRefs(""), []);
		assert.deepEqual(parseRelationshipRefs('{"facts":[{"content":"x","segment":"knowledge"}]}'), []);
	});
	it("drops malformed entries (missing/empty a or b) but keeps a valid one with no type yet", () => {
		const refs = parseRelationshipRefs(
			'{"relationships":[{"a":"mem_1"},{"a":"","b":"mem_2"},{"a":"mem_3","b":"mem_4","type":"causes","reason":"r"}]}',
		);
		assert.equal(refs.length, 1, "only the well-formed entry survives the PARSE (type-validation is downstream)");
		assert.deepEqual({ a: refs[0]?.a, b: refs[0]?.b }, { a: "mem_3", b: "mem_4" });
	});
});

describe("resolveRelationshipPairs — typed + gated chokepoint", () => {
	const r = (a: string, b: string, type: string, reason = "because", strength?: number) => ({
		a,
		b,
		type,
		reason,
		...(strength !== undefined ? { strength } : {}),
	});

	it("resolves new:<i> + mem_ refs and carries the typed kind/reason/strength", () => {
		const pairs = resolveRelationshipPairs(
			[r("new:0", "mem_cand", "co_constrains", "both dietary", 4)],
			["mem_new0", "mem_new1"],
			new Set(["mem_cand"]),
		);
		assert.equal(pairs.length, 1);
		assert.deepEqual(pairs[0], { a: "mem_new0", b: "mem_cand", kind: "co_constrains", reason: "both dietary", strength: 4 });
	});

	it("DROPS a fabricated id — a mem_ ref not in the candidate set is never written", () => {
		const pairs = resolveRelationshipPairs([r("new:0", "mem_HALLUCINATED", "uses")], ["mem_new0"], new Set(["mem_real"]));
		assert.deepEqual(pairs, [], "an id the model invented (not in the set) is dropped");
	});

	it("DROPS an out-of-range new:<i> and a new:<i> with no written row", () => {
		const pairs = resolveRelationshipPairs(
			[r("new:5", "mem_real", "uses"), r("new:1", "mem_real", "uses")],
			["mem_new0", undefined],
			new Set(["mem_real"]),
		);
		assert.deepEqual(pairs, [], "unresolvable new-fact refs are dropped, never written");
	});

	it("DROPS self-edges (a === b after resolution)", () => {
		const pairs = resolveRelationshipPairs(
			[r("new:0", "new:0", "uses"), r("mem_c", "mem_c", "uses")],
			["mem_new0"],
			new Set(["mem_c"]),
		);
		assert.deepEqual(pairs, [], "no self-loops");
	});

	it("STRICT TYPE: drops an edge with no type, an unknown type, or a store-minted-only kind", () => {
		const existing = new Set(["mem_1", "mem_2"]);
		assert.deepEqual(
			resolveRelationshipPairs([{ a: "mem_1", b: "mem_2", reason: "r" }], [], existing),
			[],
			"no type → dropped",
		);
		assert.deepEqual(
			resolveRelationshipPairs([r("mem_1", "mem_2", "frobnicates")], [], existing),
			[],
			"unknown type → dropped",
		);
		assert.deepEqual(
			resolveRelationshipPairs([r("mem_1", "mem_2", "supersedes")], [], existing),
			[],
			"a store-minted lifecycle kind is NOT extractor-emittable → dropped",
		);
	});

	it("REASON MANDATORY: drops an edge with empty/whitespace reason", () => {
		const pairs = resolveRelationshipPairs(
			[
				{ a: "mem_1", b: "mem_2", type: "uses", reason: "  " },
				{ a: "mem_1", b: "mem_3", type: "uses" },
			],
			[],
			new Set(["mem_1", "mem_2", "mem_3"]),
		);
		assert.deepEqual(pairs, [], "no reason → dropped (justification is required)");
	});

	it("STRENGTH FILTER: drops a factual edge below the floor; keeps a typed edge with NO score (defaults to floor)", () => {
		const existing = new Set(["mem_1", "mem_2", "mem_3"]);
		const low = resolveRelationshipPairs([r("mem_1", "mem_2", "uses", "weak link", MIN_FACTUAL_STRENGTH - 1)], [], existing);
		assert.deepEqual(low, [], `strength ${MIN_FACTUAL_STRENGTH - 1} < floor ${MIN_FACTUAL_STRENGTH} → dropped`);
		const noScore = resolveRelationshipPairs([r("mem_1", "mem_3", "uses", "directly stated")], [], existing);
		assert.equal(noScore.length, 1, "a typed+reasoned edge with no score is kept at the floor");
		assert.equal(noScore[0]?.strength, MIN_FACTUAL_STRENGTH);
	});

	it("THE GATE in practice: a shared-topic-only pair gets only same_topic (weak); a genuine pair gets a strong factual edge", () => {
		// The model (correctly following the gate) marks the hairball pair as same_topic and
		// the genuine pair as co_constrains. resolveRelationshipPairs preserves that split.
		const existing = new Set(["veg", "blr", "peanut"]);
		const pairs = resolveRelationshipPairs(
			[
				r("veg", "peanut", "co_constrains", "both dietary constraints", 4), // genuine
				r("veg", "blr", "same_topic", "both are about the user", 5), // hairball → thematic only
			],
			[],
			existing,
		);
		const co = pairs.find((p) => p.kind === "co_constrains");
		const st = pairs.find((p) => p.kind === "same_topic");
		assert.ok(co && co.a === "peanut" && co.b === "veg" ? true : co?.a === "veg" && co?.b === "peanut", "genuine factual edge present");
		assert.equal(co?.strength, 4, "factual strength preserved");
		assert.ok(st, "the hairball pair survives ONLY as a weak same_topic edge");
		assert.equal(st?.strength, SAME_TOPIC_STRENGTH, "same_topic is clamped to the thematic ceiling regardless of claimed strength");
	});

	it("SAME_TOPIC QUARANTINE CAP: at most MAX_SAME_TOPIC_PER_FACT thematic edges touch one fact", () => {
		const hub = "hub";
		const others = ["o1", "o2", "o3", "o4"];
		const existing = new Set([hub, ...others]);
		const refs = others.map((o) => r(hub, o, "same_topic", "same area", 5));
		const pairs = resolveRelationshipPairs(refs, [], existing);
		const sameTopic = pairs.filter((p) => p.kind === "same_topic");
		assert.equal(sameTopic.length, MAX_SAME_TOPIC_PER_FACT, `capped to ${MAX_SAME_TOPIC_PER_FACT} thematic edges on the hub`);
	});

	it("MULTI-VALUED GUARD: two different objects of the same relation are NOT forced into a contradiction", () => {
		// The model emits two `uses` edges (Go for backend, Postgres for storage) — both are
		// kept as their own typed edges; nothing collapses them into a contrasts_with.
		const existing = new Set(["go", "pg", "backend"]);
		const pairs = resolveRelationshipPairs(
			[r("backend", "go", "uses", "backend is written in Go", 4), r("backend", "pg", "uses", "backend stores in Postgres", 4)],
			[],
			existing,
		);
		assert.equal(pairs.length, 2, "two different objects of `uses` coexist");
		assert.ok(pairs.every((p) => p.kind === "uses"), "neither is rewritten as a contradiction");
	});

	it("DEDUPES order-independently; the FIRST surviving edge for a pair wins", () => {
		const pairs = resolveRelationshipPairs(
			[
				r("mem_1", "mem_2", "co_constrains", "first", 4),
				r("mem_2", "mem_1", "same_topic", "mirror", 5), // same pair → collapses to the first
				r("mem_1", "mem_2", "uses", "exact dup pair", 4),
			],
			[],
			new Set(["mem_1", "mem_2"]),
		);
		assert.equal(pairs.length, 1, "mirror + dup pair collapse to one edge");
		assert.equal(pairs[0]?.kind, "co_constrains", "the first (strong factual) edge wins the pair");
	});
});

describe("fetchRelationshipCandidates — bounded, never the whole store", () => {
	it("returns at most K candidates even when the store is large (no dump)", () => {
		const store = new FactStore(dir);
		for (let i = 0; i < 50; i++) {
			store.write({ content: `project alpha note number ${i} about deployment`, segment: "project", createdBy: OWNER });
		}
		const cands = fetchRelationshipCandidates(store, ["project alpha deployment"], OWNER, 8);
		assert.ok(cands.length <= 8, `bounded to K=8, got ${cands.length}`);
		assert.ok(cands.length > 0, "but still returns a non-empty candidate set");
	});

	it("is origin-isolated — an owner query never returns a peer's facts", () => {
		const peer: MemoryRecordOrigin = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" };
		const store = new FactStore(dir);
		store.write({ content: "the secret deploy key is rotated weekly", segment: "knowledge", createdBy: peer });
		const cands = fetchRelationshipCandidates(store, ["deploy key rotated weekly"], OWNER, 10);
		assert.equal(cands.length, 0, "peer facts never seed an owner relationship judgement");
	});
});

describe("buildCandidateBlock", () => {
	it("renders [id] content lines, '' when empty", () => {
		assert.equal(buildCandidateBlock([]), "");
		const store = new FactStore(dir);
		const r = store.write({ content: "uses Obsidian for notes", segment: "preference", createdBy: OWNER });
		const block = buildCandidateBlock(store.readAll());
		assert.ok(block.includes(`[${r.memoryId}] uses Obsidian for notes`), "fact rendered with its real id");
		assert.ok(block.includes("EXISTING FACTS"), "labelled block");
	});
});

describe("mapNewFactIds", () => {
	it("maps each written content back to its stored memoryId, in order", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "User is vegetarian", segment: "identity", createdBy: OWNER });
		const b = store.write({ content: "User uses Obsidian daily", segment: "preference", createdBy: OWNER });
		const ids = mapNewFactIds(store, ["User is vegetarian", "User uses Obsidian daily"], OWNER);
		assert.deepEqual(ids, [a.memoryId, b.memoryId]);
	});
	it("maps a content with no active row to undefined (so its refs drop)", () => {
		const store = new FactStore(dir);
		store.write({ content: "User is vegetarian", segment: "identity", createdBy: OWNER });
		const ids = mapNewFactIds(store, ["User is vegetarian", "a fact never written"], OWNER);
		assert.equal(ids[0] !== undefined, true);
		assert.equal(ids[1], undefined, "an unwritten content has no id");
	});
});

describe("runRelinkPass — typed, gated, gleaned, owner-scoped pass over active facts", () => {
	// The marquee scenario from the task: a stubbed model names typed semantic links among
	// {vegetarian, peanut-allergy, dark-mode, uses-Obsidian, backend-Go, deploys-Tuesdays,
	// lives-in-Bangalore, South-Indian-food}. We assert the right TYPED edges are written.
	interface Ids {
		veg: string;
		peanut: string;
		dark: string;
		obs: string;
		go: string;
		tue: string;
		blr: string;
		sif: string;
	}
	function seedFacts(store: FactStore): Ids {
		const veg = store.write({ content: "User is vegetarian", segment: "identity", createdBy: OWNER });
		const peanut = store.write({ content: "User has a peanut allergy", segment: "identity", createdBy: OWNER });
		const dark = store.write({ content: "User prefers dark mode", segment: "preference", createdBy: OWNER });
		const obs = store.write({ content: "User takes notes in Obsidian", segment: "preference", createdBy: OWNER });
		const go = store.write({ content: "User writes the backend in Go", segment: "project", createdBy: OWNER });
		const tue = store.write({ content: "User deploys on Tuesdays", segment: "project", createdBy: OWNER });
		const blr = store.write({ content: "User lives in Bangalore", segment: "identity", createdBy: OWNER });
		const sif = store.write({ content: "User loves South Indian food", segment: "preference", createdBy: OWNER });
		return {
			veg: veg.memoryId,
			peanut: peanut.memoryId,
			dark: dark.memoryId,
			obs: obs.memoryId,
			go: go.memoryId,
			tue: tue.memoryId,
			blr: blr.memoryId,
			sif: sif.memoryId,
		};
	}

	// A stub that emits the GENUINE typed pairs and the ONE honest thematic pair, and
	// NOTHING for the hairball (vegetarian↔Bangalore). Emits only when both ids are in
	// the printed window (proves window-scoping). The gleaning follow-up adds one MISSED
	// directly-supported edge (South-Indian-food ~ vegetarian as co_constrains? no — it's a
	// food regional/dietary link). We model gleaning adding located_at(backend-Go? no).
	// Concretely: primary = {co_constrains(veg,peanut), same_topic(dark,obs)}; gleaning adds
	// the missed co_constrains(sif, veg) "South Indian food is typically vegetarian-friendly".
	const stub = (ids: Ids) => {
		let call = 0;
		return async (block: string): Promise<string> => {
			call += 1;
			const has = (id: string) => block.includes(id);
			const isGleaning = block.includes(GLEANING_PROMPT);
			if (isGleaning) {
				// One MISSED directly-supported edge, same format.
				if (has(ids.sif) && has(ids.veg)) {
					return JSON.stringify({
						relationships: [{ a: ids.sif, b: ids.veg, type: "co_constrains", reason: "both are dietary facts", strength: 3 }],
					});
				}
				return '{"relationships":[]}';
			}
			const rels: Array<Record<string, unknown>> = [];
			if (has(ids.veg) && has(ids.peanut))
				rels.push({ a: ids.veg, b: ids.peanut, type: "co_constrains", reason: "both dietary constraints", strength: 4 });
			if (has(ids.dark) && has(ids.obs))
				rels.push({ a: ids.dark, b: ids.obs, type: "same_topic", reason: "both are tooling/UI preferences", strength: 2 });
			// The hairball: the model (following the gate) does NOT emit veg↔blr at all.
			return JSON.stringify({ relationships: rels });
		};
	};

	it("writes typed factual + quarantined thematic edges; gleaning adds a missed edge; no hairball", async () => {
		const store = new FactStore(dir);
		const ids = seedFacts(store);
		const res = await runRelinkPass({ store, llm: stub(ids), origin: OWNER });
		assert.equal(res.considered, 8, "all eight active facts considered");
		assert.equal(res.windows, 1, "eight facts fit one window");

		// co_constrains(veg,peanut): bidirectional, both endpoints, with reason.
		assert.deepEqual(edgesOfKind(store, ids.veg, "co_constrains").sort(), [ids.peanut, ids.sif].sort(), "veg co_constrains peanut + (gleaned) sif");
		assert.deepEqual(edgesOfKind(store, ids.peanut, "co_constrains"), [ids.veg]);
		const vegPeanut = linksOf(store, ids.veg).find((l) => l.kind === "co_constrains" && l.target === ids.peanut);
		assert.equal(vegPeanut?.reason, "both dietary constraints", "the reason is stored on the edge");
		assert.equal(vegPeanut?.strength, 4, "the strength is stored on the edge");

		// same_topic(dark,obs): quarantined kind, low strength, bidirectional.
		assert.deepEqual(edgesOfKind(store, ids.dark, "same_topic"), [ids.obs]);
		assert.deepEqual(edgesOfKind(store, ids.obs, "same_topic"), [ids.dark]);
		assert.equal(
			linksOf(store, ids.dark).find((l) => l.kind === "same_topic")?.strength,
			SAME_TOPIC_STRENGTH,
			"same_topic edge is low-strength",
		);

		// GLEANING added the missed co_constrains(sif, veg).
		assert.deepEqual(edgesOfKind(store, ids.sif, "co_constrains"), [ids.veg], "gleaning pass added the missed edge");

		// THE HAIRBALL is absent: vegetarian has NO edge to lives-in-Bangalore of ANY kind.
		assert.equal(
			linksOf(store, ids.veg).some((l) => l.target === ids.blr),
			false,
			"vegetarian ↔ lives-in-Bangalore is correctly absent",
		);
		assert.deepEqual(linksOf(store, ids.blr), [], "lives-in-Bangalore has no edges at all");
		// Unrelated facts (deploys-Tuesdays) get nothing.
		assert.deepEqual(linksOf(store, ids.tue), []);
	});

	it("is IDEMPOTENT — re-running writes no new edges (gleaning included)", async () => {
		const store = new FactStore(dir);
		const ids = seedFacts(store);
		await runRelinkPass({ store, llm: stub(ids), origin: OWNER });
		const before = JSON.stringify(store.readAll().map((r) => r.links ?? []));
		const second = await runRelinkPass({ store, llm: stub(ids), origin: OWNER });
		assert.equal(second.edgesWritten, 0, "re-running adds nothing already present");
		const after = JSON.stringify(store.readAll().map((r) => r.links ?? []));
		assert.equal(after, before, "edge set byte-identical after a re-run");
	});

	it("the GLEANING follow-up is the SECOND call per window and uses the gleaning prompt", async () => {
		const store = new FactStore(dir);
		store.write({ content: "fact one about X", segment: "knowledge", createdBy: OWNER });
		store.write({ content: "fact two about Y", segment: "knowledge", createdBy: OWNER });
		const seen: string[] = [];
		const llm = async (input: string): Promise<string> => {
			seen.push(input.includes(GLEANING_PROMPT) ? "gleaning" : "primary");
			return '{"relationships":[]}';
		};
		await runRelinkPass({ store, llm, origin: OWNER });
		assert.deepEqual(seen, ["primary", "gleaning"], "one primary call then one gleaning call per window");
	});

	it("glean:false skips the follow-up (cheap per-turn-style path)", async () => {
		const store = new FactStore(dir);
		store.write({ content: "fact one about X", segment: "knowledge", createdBy: OWNER });
		store.write({ content: "fact two about Y", segment: "knowledge", createdBy: OWNER });
		let calls = 0;
		const llm = async (): Promise<string> => {
			calls += 1;
			return '{"relationships":[]}';
		};
		await runRelinkPass({ store, llm, origin: OWNER, glean: false });
		assert.equal(calls, 1, "no gleaning call when glean:false");
	});

	it("NEGATIVE: a fabricated id in the reply is dropped (no fabrication)", async () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "User is vegetarian", segment: "identity", createdBy: OWNER });
		const b = store.write({ content: "User deploys on Tuesdays", segment: "project", createdBy: OWNER });
		const llm = async () =>
			JSON.stringify({ relationships: [{ a: a.memoryId, b: "mem_DOES_NOT_EXIST", type: "uses", reason: "made up", strength: 5 }] });
		const res = await runRelinkPass({ store, llm, origin: OWNER, glean: false });
		assert.equal(res.edgesWritten, 0, "a fabricated endpoint is never written");
		assert.deepEqual(linksOf(store, a.memoryId), []);
		assert.deepEqual(linksOf(store, b.memoryId), []);
	});

	it("DROPS an out-of-taxonomy type from the live reply (strict validation end-to-end)", async () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "fact A", segment: "knowledge", createdBy: OWNER });
		const b = store.write({ content: "fact B", segment: "knowledge", createdBy: OWNER });
		const llm = async () =>
			JSON.stringify({ relationships: [{ a: a.memoryId, b: b.memoryId, type: "frobnicates", reason: "nonsense type", strength: 5 }] });
		const res = await runRelinkPass({ store, llm, origin: OWNER, glean: false });
		assert.equal(res.edgesWritten, 0, "an unknown type is dropped");
		assert.deepEqual(linksOf(store, a.memoryId), []);
	});

	it("is ORIGIN-scoped — only the requested origin's facts are linked", async () => {
		const peer: MemoryRecordOrigin = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" };
		const store = new FactStore(dir);
		const o1 = store.write({ content: "Owner is vegetarian", segment: "identity", createdBy: OWNER });
		const o2 = store.write({ content: "Owner has a peanut allergy", segment: "identity", createdBy: OWNER });
		const p1 = store.write({ content: "Peer is vegetarian", segment: "identity", createdBy: peer });
		store.write({ content: "Peer has a peanut allergy", segment: "identity", createdBy: peer });
		// A stub that would link ANY two ids it sees, typed — proves the window only ever
		// contains owner facts (so it can only relate owner↔owner).
		const linkAllPairs = async (block: string): Promise<string> => {
			const ids = [...block.matchAll(/\[(mem_[a-z0-9_]+)\]/g)].map((m) => m[1]!);
			const rels: Array<Record<string, unknown>> = [];
			for (let i = 0; i < ids.length; i++)
				for (let j = i + 1; j < ids.length; j++) rels.push({ a: ids[i]!, b: ids[j]!, type: "co_constrains", reason: "r", strength: 4 });
			return JSON.stringify({ relationships: rels });
		};
		await runRelinkPass({ store, llm: linkAllPairs, origin: OWNER, glean: false });
		assert.deepEqual(edgesOfKind(store, o1.memoryId, "co_constrains"), [o2.memoryId]);
		assert.equal(linksOf(store, o1.memoryId).some((l) => l.target === p1.memoryId), false, "no owner↔peer edge");
		assert.deepEqual(linksOf(store, p1.memoryId), [], "the peer fact has no edges from this owner pass");
	});

	it("BATCHES a large active set into windows (cost bound), still origin-scoped per window", async () => {
		const store = new FactStore(dir);
		for (let i = 0; i < 25; i++) store.write({ content: `owner fact number ${i}`, segment: "knowledge", createdBy: OWNER });
		let primaryCalls = 0;
		const countingNoLinks = async (input: string): Promise<string> => {
			if (!input.includes(GLEANING_PROMPT)) primaryCalls += 1;
			return '{"relationships":[]}';
		};
		const res = await runRelinkPass({ store, llm: countingNoLinks, origin: OWNER, windowSize: 10 });
		assert.equal(res.considered, 25);
		assert.equal(res.windows, 3, "25 facts / window 10 → 3 windows");
		assert.equal(primaryCalls, 3, "one PRIMARY model call per window — cost is linear + bounded");
	});

	it("caps the considered set (maxFacts) so one operator click is bounded on a huge vault", async () => {
		const store = new FactStore(dir);
		for (let i = 0; i < 30; i++) store.write({ content: `owner fact ${i}`, segment: "knowledge", createdBy: OWNER });
		const res = await runRelinkPass({
			store,
			llm: async () => '{"relationships":[]}',
			origin: OWNER,
			maxFacts: 12,
			windowSize: 100,
			glean: false,
		});
		assert.equal(res.considered, 12, "only the first maxFacts active facts are considered");
	});

	it("no-ops cleanly with fewer than 2 active facts", async () => {
		const store = new FactStore(dir);
		store.write({ content: "the only fact", segment: "knowledge", createdBy: OWNER });
		let called = false;
		const res = await runRelinkPass({
			store,
			llm: async () => {
				called = true;
				return "{}";
			},
			origin: OWNER,
		});
		assert.equal(res.edgesWritten, 0);
		assert.equal(res.considered, 1);
		assert.equal(called, false, "no LLM call when there's nothing to pair");
	});
});

describe("vault render — typed reason + quarantined Same area (the task's sample render)", () => {
	it("renders strong typed edges WITH reasons in ## Related and same_topic separately in ## Same area", async () => {
		const store = new FactStore(dir);
		const veg = store.write({ content: "User is vegetarian", segment: "identity", createdBy: OWNER });
		const peanut = store.write({ content: "User has a peanut allergy", segment: "identity", createdBy: OWNER });
		const dark = store.write({ content: "User prefers dark mode", segment: "preference", createdBy: OWNER });
		const obs = store.write({ content: "User takes notes in Obsidian", segment: "preference", createdBy: OWNER });
		// Strong factual edge with a reason.
		store.linkRelated([{ a: veg.memoryId, b: peanut.memoryId, kind: "co_constrains", reason: "both dietary constraints", strength: 4 }]);
		// Quarantined thematic edge.
		store.linkRelated([{ a: dark.memoryId, b: obs.memoryId, kind: "same_topic", reason: "both tooling/UI preferences", strength: 2 }]);

		const records = store.readAll();
		const names = new Map(records.map((r) => [r.memoryId, r.content]));
		const vegNote = renderNote(
			records.find((r) => r.memoryId === veg.memoryId)!,
			names,
		);
		assert.match(vegNote, /## Related/, "strong section present on the vegetarian note");
		assert.match(vegNote, /- co_constrains: \[\[User has a peanut allergy\]\] — both dietary constraints/, "typed + reasoned edge rendered");
		assert.doesNotMatch(vegNote, /## Same area/, "vegetarian note has no thematic edges");

		const darkNote = renderNote(
			records.find((r) => r.memoryId === dark.memoryId)!,
			names,
		);
		assert.match(darkNote, /## Same area/, "thematic edges render in their OWN section");
		assert.match(darkNote, /- ~ \[\[User takes notes in Obsidian\]\] — both tooling\/UI preferences/, "same_topic rendered as a soft association");
		// CRITICAL: the thematic pair is NOT in the strong ## Related section.
		const relatedBlock = darkNote.includes("## Related") ? darkNote.slice(darkNote.indexOf("## Related"), darkNote.indexOf("## Same area")) : "";
		assert.doesNotMatch(relatedBlock, /Obsidian/, "same_topic never masquerades as a strong ## Related edge");
	});
});
