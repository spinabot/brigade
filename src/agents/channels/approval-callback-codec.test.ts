/**
 * Tests for the central approval-callback codec.
 *
 * Covers: round-trip of every decision; the 64-byte (Telegram callback_data)
 * bound; rejection of foreign / malformed / oversized payloads; and the
 * wire-safety invariant (printable ASCII, no NUL/control bytes).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	APPROVAL_CALLBACK_MAX_BYTES,
	APPROVAL_CALLBACK_TAG,
	type ApprovalCallbackDecision,
	decodeApprovalCallback,
	encodeApprovalCallback,
	fitsApprovalCallback,
} from "./approval-callback-codec.js";

const DECISIONS: ApprovalCallbackDecision[] = ["allow-once", "allow-always", "deny"];

describe("approval-callback-codec — round-trip", () => {
	it("encodes then decodes every decision back to the same id + decision", () => {
		const approvalId = "exec:7f3a9c10-2b6e-4d51-9a0f-1c2d3e4f5061";
		for (const decision of DECISIONS) {
			const payload = encodeApprovalCallback({ approvalId, decision });
			assert.ok(payload, `encode produced a payload for ${decision}`);
			const decoded = decodeApprovalCallback(payload);
			assert.deepEqual(decoded, { approvalId, decision }, `round-trip ${decision}`);
		}
	});

	it("carries ids with colons / dashes / underscores intact (base64url)", () => {
		const approvalId = "plugin:a-b_c:de:fg";
		const payload = encodeApprovalCallback({ approvalId, decision: "allow-always" });
		assert.ok(payload);
		assert.deepEqual(decodeApprovalCallback(payload), {
			approvalId,
			decision: "allow-always",
		});
	});

	it("uses the versioned brand-neutral tag and the colon delimiter", () => {
		const payload = encodeApprovalCallback({ approvalId: "x", decision: "deny" });
		assert.ok(payload);
		assert.ok(payload.startsWith(`${APPROVAL_CALLBACK_TAG}:`), "tag-prefixed");
		assert.equal(payload.split(":").length, 3, "tag:id:code shape");
		assert.ok(payload.endsWith(":d"), "deny → d");
	});
});

describe("approval-callback-codec — 64-byte bound", () => {
	it("the constant is Telegram's 64-byte limit", () => {
		assert.equal(APPROVAL_CALLBACK_MAX_BYTES, 64);
	});

	it("a normal UUID-shaped approval id encodes well under 64 bytes", () => {
		const payload = encodeApprovalCallback({
			approvalId: "exec:7f3a9c10-2b6e-4d51-9a0f-1c2d3e4f5061",
			decision: "allow-once",
		});
		assert.ok(payload);
		assert.ok(Buffer.byteLength(payload, "utf8") <= 64, `payload ${Buffer.byteLength(payload)} bytes`);
	});

	it("returns undefined (drop the button) when the id is too long to fit", () => {
		// A 60-char id base64url-expands to ~80 chars + tag + delims → over 64.
		const huge = "x".repeat(60);
		const payload = encodeApprovalCallback({ approvalId: huge, decision: "deny" });
		assert.equal(payload, undefined, "oversized payload must not be emitted");
	});

	it("emits for the largest id that still fits and drops one byte larger", () => {
		// Find the boundary by growing the id until encode returns undefined.
		let lastFit = 0;
		let firstDrop = 0;
		for (let n = 1; n <= 80; n += 1) {
			const p = encodeApprovalCallback({ approvalId: "a".repeat(n), decision: "deny" });
			if (p) {
				assert.ok(fitsApprovalCallback(p));
				lastFit = n;
			} else if (firstDrop === 0) {
				firstDrop = n;
			}
		}
		assert.ok(lastFit > 0, "some id length fits");
		assert.ok(firstDrop > lastFit, "the drop boundary is above the last fitting length");
	});

	it("fitsApprovalCallback measures UTF-8 bytes, not string length", () => {
		// 33 × 2-byte chars = 66 bytes > 64, though length is only 33.
		const multibyte = "é".repeat(33);
		assert.equal(multibyte.length, 33);
		assert.equal(Buffer.byteLength(multibyte, "utf8"), 66);
		assert.equal(fitsApprovalCallback(multibyte), false);
	});
});

describe("approval-callback-codec — rejection of bad input", () => {
	it("decode returns null for an empty string", () => {
		assert.equal(decodeApprovalCallback(""), null);
	});

	it("decode returns null for a foreign (wrong-tag) payload", () => {
		assert.equal(decodeApprovalCallback("xx:aGVsbG8:o"), null);
	});

	it("decode returns null for a wrong field count", () => {
		assert.equal(decodeApprovalCallback(`${APPROVAL_CALLBACK_TAG}:aGVsbG8`), null);
		assert.equal(decodeApprovalCallback(`${APPROVAL_CALLBACK_TAG}:a:b:c:d`), null);
	});

	it("decode returns null for an unknown decision code", () => {
		const idB64 = Buffer.from("exec:1", "utf8").toString("base64url");
		assert.equal(decodeApprovalCallback(`${APPROVAL_CALLBACK_TAG}:${idB64}:z`), null);
	});

	it("decode returns null for an empty id segment", () => {
		assert.equal(decodeApprovalCallback(`${APPROVAL_CALLBACK_TAG}::o`), null);
	});

	it("decode returns null for an oversized (foreign) value", () => {
		const big = `${APPROVAL_CALLBACK_TAG}:${"A".repeat(80)}:o`;
		assert.ok(Buffer.byteLength(big, "utf8") > 64);
		assert.equal(decodeApprovalCallback(big), null);
	});

	it("encode returns undefined for an empty approval id", () => {
		assert.equal(encodeApprovalCallback({ approvalId: "", decision: "deny" }), undefined);
		assert.equal(encodeApprovalCallback({ approvalId: "   ", decision: "deny" }), undefined);
	});
});

describe("approval-callback-codec — wire safety", () => {
	it("every emitted payload is printable ASCII with no NUL/control bytes", () => {
		const ids = ["exec:1", "plugin:abc-def_ghi:jkl", "a".repeat(20), "EXEC:UPPER-case_42"];
		for (const approvalId of ids) {
			for (const decision of DECISIONS) {
				const payload = encodeApprovalCallback({ approvalId, decision });
				if (!payload) continue;
				assert.ok(/^[\x20-\x7e]+$/.test(payload), `printable ASCII: ${JSON.stringify(payload)}`);
				assert.ok(!/[\x00-\x1f\x7f]/.test(payload), "no control/NUL bytes");
			}
		}
	});
});
