import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "../records.js";
import { defaultRecallCapability } from "./capabilities.js";
import { assertLocalGoldPath, exportGoldScaffold, writeLocalGoldSpec } from "./gold-export.js";
import { loadGoldSpec, seedGold } from "./gold.js";
import { runRecallEval } from "./harness.js";

/**
 * Real-data gold path (build Step 2), exercised against a synthetic store
 * standing in for the operator's real facts (their data isn't on this machine,
 * and must never be committed to the public repo). Proves the MECHANISM runs
 * end-to-end — export → write-local → load → seed → eval — and that the privacy
 * guard refuses any non-local (committable) output path.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-goldexport-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("real-data gold export — privacy-safe local pipeline", () => {
	function seedRealish(store: FactStore): void {
		store.write({ content: "I live in Hyderabad, India", segment: "identity" });
		store.write({ content: "I prefer tabs over spaces when coding", segment: "preference" });
		store.write({ content: "Beta Labs is headquartered in Berlin", segment: "knowledge" });
	}

	it("exports a scaffold: facts keyed by memoryId + one candidate case each", () => {
		const store = new FactStore(dir);
		seedRealish(store);
		const spec = exportGoldScaffold(store);
		assert.equal(spec.facts.length, 3);
		assert.equal(spec.cases.length, 3);
		// Every case references a real fact key, and keys are the stable memoryIds.
		const keys = new Set(spec.facts.map((f) => f.key));
		for (const c of spec.cases) {
			assert.equal(c.relevantKeys.length, 1);
			assert.ok(keys.has(c.relevantKeys[0] ?? ""), "case points at a real fact key");
			assert.ok(c.query.length > 0, "candidate query is non-empty");
		}
		assert.ok(spec.facts.every((f) => f.key.startsWith("mem_")), "keys are real memoryIds");
		// No fixture fact set an origin, so the optional createdBy field must be
		// OMITTED entirely (not present-and-undefined) — keeps the scaffold clean.
		assert.ok(!("createdBy" in (spec.facts[0] ?? {})), "createdBy omitted when no origin");
	});

	it("respects maxCases and handles an empty store", () => {
		const store = new FactStore(dir);
		seedRealish(store);
		assert.equal(exportGoldScaffold(store, { maxCases: 2 }).cases.length, 2);
		// maxCases:0 keeps every fact but emits zero candidate cases (a valid
		// "export the corpus, author cases by hand" mode — not an empty store).
		const zero = exportGoldScaffold(store, { maxCases: 0 });
		assert.equal(zero.facts.length, 3, "all facts exported even with maxCases:0");
		assert.equal(zero.cases.length, 0, "maxCases:0 yields no candidate cases");
		// A NEGATIVE maxCases is not a "zero" sentinel — it falls through to the
		// default (every fact gets a candidate case), so it never silently truncates.
		assert.equal(exportGoldScaffold(store, { maxCases: -1 }).cases.length, 3, "negative maxCases falls through to default");
		const empty = new FactStore(path.join(dir, "empty"));
		assert.deepEqual(exportGoldScaffold(empty), { approved: false, facts: [], cases: [] });
	});

	it("emits a visible TODO when auto-extraction yields no terms (all stopwords)", () => {
		const store = new FactStore(path.join(dir, "stopwords"));
		// Every token here is a stopword ("i"/"do"/"it"), so tokenize() ⇒ [] and
		// the scaffold must surface the TODO placeholder rather than an empty query.
		store.write({ content: "I do it", segment: "preference" });
		const spec = exportGoldScaffold(store);
		assert.equal(spec.cases.length, 1);
		assert.equal(spec.cases[0]?.query, "TODO: rewrite (auto-extraction empty)");
	});

	it("carries an explicit createdBy origin through into the scaffold", () => {
		const store = new FactStore(path.join(dir, "origin"));
		const origin = {
			kind: "channel" as const,
			channelId: "whatsapp",
			conversationId: "conv-1",
			sessionKey: "sess-1",
		};
		store.write({ content: "Gamma Corp ships on Fridays", segment: "knowledge", createdBy: origin });
		const spec = exportGoldScaffold(store);
		assert.equal(spec.facts.length, 1);
		assert.deepEqual(spec.facts[0]?.createdBy, origin, "explicit createdBy survives into the scaffold fact");
	});

	it("PRIVACY GUARD: refuses to write real facts anywhere but a *.local.json", () => {
		const store = new FactStore(dir);
		seedRealish(store);
		const spec = exportGoldScaffold(store);
		assert.throws(() => writeLocalGoldSpec(path.join(dir, "gold.json"), spec), /local\.json/);
		assert.throws(() => assertLocalGoldPath(path.join(dir, "cases.jsonl")), /never pushed/);
		// The sanctioned path is accepted.
		writeLocalGoldSpec(path.join(dir, "gold.local.json"), spec);
		assert.ok(fs.existsSync(path.join(dir, "gold.local.json")));
	});

	it("round-trips through loadGoldSpec and runs the full eval pipeline", async () => {
		const store = new FactStore(dir);
		seedRealish(store);
		const localPath = path.join(dir, "gold.local.json");
		// Operator review step: a scaffold is approved:false; here the auto-queries are
		// already real terms, so "approval" is just flipping the flag. loadGoldSpec
		// REFUSES it until then (see the APPROVAL GATE tests below).
		const scaffold = exportGoldScaffold(store);
		scaffold.approved = true;
		writeLocalGoldSpec(localPath, scaffold);

		// Reload (the loader gold.ts already shipped) and seed a FRESH store —
		// the real store is never mutated by measurement.
		const reloaded = loadGoldSpec(localPath);
		assert.equal(reloaded.facts.length, 3);
		// Carried fields survive the write → reload round-trip: every fact keeps a
		// string segment, and the full segment set is preserved (none dropped).
		for (const f of reloaded.facts) {
			assert.equal(typeof f.segment, "string", "segment survives reload as a string");
		}
		assert.deepEqual(
			new Set(reloaded.facts.map((f) => f.segment)),
			new Set(["identity", "preference", "knowledge"]),
			"every seeded segment survives the round-trip",
		);
		const evalStore = new FactStore(path.join(dir, "eval"));
		const cases = seedGold(evalStore, reloaded);
		const result = await runRecallEval(defaultRecallCapability(evalStore), cases, { k: 3, clock: () => 0 });
		// Scaffold queries are the facts' own terms ⇒ trivially recallable; this
		// asserts the PIPELINE runs + scores end-to-end. Pin the exact values: `> 0`
		// is a mean over scored cases, so a 2-of-3 partial regression (mean 0.33)
		// would still pass — exactly what this round-trip exists to catch.
		assert.equal(result.nScored, 3, "all three gold cases scored (load-bearing — no silent drop)");
		assert.equal(result.n, 3, "all three cases present");
		assert.equal(result.recallAtK, 1, "every trivial self-token query recalls its fact at rank ≤ k");
	});

	it("APPROVAL GATE: loadGoldSpec refuses an un-approved scaffold (anti-inflation)", () => {
		const store = new FactStore(dir);
		seedRealish(store);
		const localPath = path.join(dir, "gold.local.json");
		// The raw scaffold is approved:false — its queries self-match their own facts.
		writeLocalGoldSpec(localPath, exportGoldScaffold(store));
		assert.throws(() => loadGoldSpec(localPath), /un-approved scaffold/, "un-reviewed scaffold must not be scorable");
		// After the operator reviews + sets approved:true, it loads.
		const approved = exportGoldScaffold(store);
		approved.approved = true;
		writeLocalGoldSpec(localPath, approved);
		assert.equal(loadGoldSpec(localPath).facts.length, 3, "an approved spec loads");
	});

	it("APPROVAL GATE: loadGoldSpec refuses a spec that still carries a rewrite placeholder", () => {
		const store = new FactStore(path.join(dir, "ph"));
		store.write({ content: "I do it", segment: "preference" }); // all stopwords ⇒ placeholder query
		const localPath = path.join(dir, "gold.local.json");
		const spec = exportGoldScaffold(store);
		spec.approved = true; // even approved, a left-in placeholder is an un-reviewed case
		writeLocalGoldSpec(localPath, spec);
		assert.throws(() => loadGoldSpec(localPath), /placeholder/, "a left-in placeholder blocks scoring");
	});
});
