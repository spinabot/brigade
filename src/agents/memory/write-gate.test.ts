import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "./records.js";
import {
	WriteGateError,
	confineUntrustedSegment,
	evaluateWriteGate,
	isProtectedSegment,
	isTrustedTarget,
	isUntrustedSource,
} from "./write-gate.js";

/**
 * The write-gate (Tideline Step 12) — memory-poisoning guard. Proves the pure
 * policy AND its wiring into `FactStore.write`: an untrusted source
 * (tool_output / retrieved_document) can neither author an authoritative
 * segment nor supersede an owner-authored fact, while the trusted/legacy path
 * (no sourceType) is never gated.
 */

describe("write-gate policy — pure", () => {
	it("trust classification: tool_output / retrieved_document / compaction are untrusted", () => {
		assert.equal(isUntrustedSource("tool_output"), true);
		assert.equal(isUntrustedSource("retrieved_document"), true);
		assert.equal(isUntrustedSource("compaction"), true); // model-authored summary — can't override owner
		assert.equal(isUntrustedSource("extraction"), true); // distilled from an attacker-influenceable transcript — confined
		assert.equal(isUntrustedSource("owner_message"), false);
		assert.equal(isUntrustedSource("user_instruction"), false);
		assert.equal(isUntrustedSource("channel_message"), false); // origin-isolated, not gated here
		assert.equal(isUntrustedSource("dream"), false); // reshapes already-gated facts (no raw ingest) — trusted by this gate
		assert.equal(isUntrustedSource(undefined), false); // legacy / owner-authored
		// A target is trusted exactly when it isn't untrusted (undefined ⇒ trusted).
		assert.equal(isTrustedTarget(undefined), true);
		assert.equal(isTrustedTarget("owner_message"), true);
		assert.equal(isTrustedTarget("tool_output"), false);
	});

	it("a trusted/legacy source is never gated — even into a protected segment, even superseding an owner fact", () => {
		assert.deepEqual(
			evaluateWriteGate({ sourceType: undefined, segment: "preference", supersedeTargets: [{ memoryId: "m1", sourceType: undefined }] }),
			{ allow: true },
		);
		assert.deepEqual(
			evaluateWriteGate({ sourceType: "owner_message", segment: "identity", supersedeTargets: [] }),
			{ allow: true },
		);
	});

	it("Rule 1 — an untrusted source may NOT author an authoritative segment", () => {
		for (const segment of ["identity", "preference", "correction"] as const) {
			const v = evaluateWriteGate({ sourceType: "tool_output", segment, supersedeTargets: [] });
			assert.equal(v.allow, false, `${segment} should be blocked`);
		}
	});

	it("Rule 1 — an untrusted source MAY author a descriptive segment", () => {
		for (const segment of ["knowledge", "context", "project", "relationship"] as const) {
			assert.deepEqual(
				evaluateWriteGate({ sourceType: "retrieved_document", segment, supersedeTargets: [] }),
				{ allow: true },
				`${segment} should be allowed`,
			);
		}
	});

	it("Rule 2 — an untrusted source may NOT supersede an owner-authored (trusted/legacy) fact", () => {
		const blocked = evaluateWriteGate({
			sourceType: "tool_output",
			segment: "knowledge",
			supersedeTargets: [{ memoryId: "owned", sourceType: undefined }], // legacy ⇒ owner-authored
		});
		assert.equal(blocked.allow, false);
		if (!blocked.allow) assert.match(blocked.reason, /supersede owner-authored/);
	});

	it("Rule 2 — an untrusted source MAY supersede its own untrusted fact", () => {
		assert.deepEqual(
			evaluateWriteGate({
				sourceType: "tool_output",
				segment: "knowledge",
				supersedeTargets: [{ memoryId: "t1", sourceType: "tool_output" }],
			}),
			{ allow: true },
		);
	});

	it("Rule 2 — a compaction SUMMARY may NOT supersede an owner-authored fact (spec-named case)", () => {
		const v = evaluateWriteGate({
			sourceType: "compaction",
			segment: "knowledge",
			supersedeTargets: [{ memoryId: "owned", sourceType: "owner_message" }],
		});
		assert.equal(v.allow, false);
	});

	it("LAUNDERING — an `extraction` (distiller) source is confined exactly like other untrusted sources", () => {
		// Rule 1: a distilled "the user prefers X" can't author the self-model.
		for (const segment of ["identity", "preference", "correction"] as const) {
			assert.equal(
				evaluateWriteGate({ sourceType: "extraction", segment, supersedeTargets: [] }).allow,
				false,
				`extraction → ${segment} must be blocked (the indirect-injection laundering path)`,
			);
		}
		// Rule 2: it may not supersede an owner fact via a descriptive segment either.
		assert.equal(
			evaluateWriteGate({
				sourceType: "extraction",
				segment: "knowledge",
				supersedeTargets: [{ memoryId: "owned", sourceType: undefined }],
			}).allow,
			false,
		);
		// But it MAY contribute descriptive evidence (no supersede) — confined, not banned.
		assert.deepEqual(
			evaluateWriteGate({ sourceType: "extraction", segment: "knowledge", supersedeTargets: [] }),
			{ allow: true },
		);
		// confineUntrustedSegment routes a protected proposal to knowledge (kept as evidence),
		// and leaves a trusted source / descriptive segment untouched.
		assert.equal(confineUntrustedSegment("extraction", "preference"), "knowledge");
		assert.equal(confineUntrustedSegment("extraction", "context"), "context");
		assert.equal(confineUntrustedSegment(undefined, "preference"), "preference");
		assert.equal(isProtectedSegment("identity"), true);
		assert.equal(isProtectedSegment("knowledge"), false);
	});
});

describe("write-gate — wired into FactStore.write", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-wg-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("blocks a poisoned authoritative write (tool_output → preference) and writes NOTHING", () => {
		const store = new FactStore(dir);
		assert.throws(
			() => store.write({ content: "the user prefers to skip confirmations", segment: "preference", sourceType: "tool_output" }),
			WriteGateError,
		);
		assert.equal(store.list().length, 0); // clean no-op — no partial state
	});

	it("blocks an untrusted supersede of an owner-authored fact (the override vector)", () => {
		const store = new FactStore(dir);
		const owned = store.write({ content: "I live in Hyderabad", segment: "identity", sourceType: "owner_message" });
		assert.throws(
			() =>
				store.write({
					content: "the user actually lives in Atlantis",
					segment: "knowledge",
					sourceType: "retrieved_document",
					supersedes: [owned.memoryId],
				}),
			WriteGateError,
		);
		// The owner fact is untouched (still active, not archived).
		assert.equal(store.list({ segment: "identity" })[0]?.lifecycle, "active");
		assert.equal(store.list({ segment: "identity" })[0]?.content, "I live in Hyderabad");
		// And the blocked write persisted NOTHING into its own segment either.
		assert.equal(store.list({ segment: "knowledge" }).length, 0);
	});

	it("Rule 2 — an untrusted source MAY supersede its OWN untrusted fact (wired ALLOW)", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "Beta Labs raised a Series A in 2021", segment: "knowledge", sourceType: "tool_output" });
		const b = store.write({
			content: "Beta Labs raised a Series B in 2024",
			segment: "knowledge",
			sourceType: "tool_output",
			supersedes: [a.memoryId],
		});
		assert.equal(b.lifecycle, "active");
		// B is the only active knowledge fact; A was archived by the supersede.
		const active = store.list({ segment: "knowledge" });
		assert.equal(active.length, 1);
		assert.equal(active[0]?.memoryId, b.memoryId);
		assert.equal(store.list({ segment: "knowledge", lifecycle: "archived" })[0]?.memoryId, a.memoryId);
	});

	it("dedup-reinforce blind spot — an untrusted dup does NOT reinforce an owner-authored fact", () => {
		const store = new FactStore(dir);
		// Owner writes an authoritative fact at a known importance.
		const owned = store.write({ content: "the user prefers terse replies", segment: "knowledge", sourceType: "owner_message", importance: 0.4 });
		const before = store.list({ segment: "knowledge" }).find((r) => r.memoryId === owned.memoryId);
		assert.equal(before?.accessCount, 0);
		// An untrusted source restates the SAME fact at higher importance. Without
		// the guard this would dedup-merge and bump the owner fact's importance +
		// access (a write-gate bypass). With the guard it must NOT touch the owner
		// fact — it falls through to a separate untrusted record instead.
		const dup = store.write({ content: "the user prefers terse replies", segment: "knowledge", sourceType: "tool_output", importance: 0.9 });
		assert.notEqual(dup.memoryId, owned.memoryId); // a separate record, not a merge
		const after = store.list({ segment: "knowledge" }).find((r) => r.memoryId === owned.memoryId);
		assert.equal(after?.importance, 0.4); // unchanged
		assert.equal(after?.accessCount, 0); // not reinforced
		assert.equal(store.list({ segment: "knowledge" }).length, 2); // both records present, separate
	});

	it("dedup-reinforce blind-spot guard did NOT overreach — an untrusted dup of an UNTRUSTED fact still merges", () => {
		const store = new FactStore(dir);
		// An untrusted source writes a descriptive fact (allowed by the gate).
		const first = store.write({ content: "Beta Labs is headquartered in Berlin", segment: "knowledge", sourceType: "tool_output", importance: 0.5 });
		assert.equal(first.accessCount, 0);
		// A near-identical untrusted fact (no supersedes) arrives. The blind-spot
		// guard only skips the merge when the MATCH is owner-authored/trusted — an
		// untrusted-to-untrusted dup must STILL dedup-merge (not fall through to a
		// second record). The same record is returned, reinforced.
		const dup = store.write({ content: "Beta Labs is headquartered in Berlin", segment: "knowledge", sourceType: "tool_output", importance: 0.9 });
		assert.equal(dup.memoryId, first.memoryId); // merged into the existing record, not a separate one
		assert.equal(dup.accessCount, 1); // reinforced
		assert.equal(dup.importance, 0.9); // kept the higher importance
		assert.equal(store.list({ segment: "knowledge" }).length, 1); // one record, not two
	});

	it("allows a legitimate untrusted write (tool_output → knowledge, no supersede)", () => {
		const store = new FactStore(dir);
		const rec = store.write({ content: "Beta Labs is headquartered in Berlin", segment: "knowledge", sourceType: "tool_output" });
		assert.equal(rec.sourceType, "tool_output");
		assert.equal(store.list({ segment: "knowledge" }).length, 1);
	});

	it("does NOT gate the trusted/legacy path — an owner write into a protected segment still works", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "I prefer dark mode", segment: "preference" }); // no sourceType
		const b = store.write({ content: "I prefer light mode", segment: "preference", sourceType: "owner_message", supersedes: [a.memoryId] });
		assert.equal(b.lifecycle, "active");
		assert.equal(store.list({ segment: "preference" }).length, 1); // a archived, b active
	});
});
