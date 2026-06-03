import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	InvalidCronSessionTargetIdError,
	assertSafeCronSessionTargetId,
	extractSessionTargetId,
	isInvalidCronSessionTargetIdError,
	isSessionTargetWithId,
	isValidCronSessionTarget,
} from "./session-target.js";

describe("isValidCronSessionTarget — input-layer acceptance", () => {
	it("accepts 'main', 'isolated', 'current' literals", () => {
		assert.equal(isValidCronSessionTarget("main"), true);
		assert.equal(isValidCronSessionTarget("isolated"), true);
		assert.equal(isValidCronSessionTarget("current"), true);
	});

	it("accepts 'session:<anything>' shapes (id safety checked elsewhere)", () => {
		assert.equal(isValidCronSessionTarget("session:project-alpha"), true);
		assert.equal(isValidCronSessionTarget("session:agent:main:peer-7"), true);
	});

	it("rejects unknown literals", () => {
		assert.equal(isValidCronSessionTarget("hot"), false);
		assert.equal(isValidCronSessionTarget(""), false);
		assert.equal(isValidCronSessionTarget("session"), false);
	});
});

describe("isSessionTargetWithId + extractSessionTargetId", () => {
	it("recognises the session:* prefix", () => {
		assert.equal(isSessionTargetWithId("session:abc"), true);
		assert.equal(isSessionTargetWithId("isolated"), false);
		assert.equal(isSessionTargetWithId("current"), false);
	});

	it("extracts the id portion", () => {
		assert.equal(extractSessionTargetId("session:abc"), "abc");
		assert.equal(extractSessionTargetId("isolated"), "");
	});
});

describe("assertSafeCronSessionTargetId + InvalidCronSessionTargetIdError", () => {
	it("accepts a normal id", () => {
		assert.doesNotThrow(() => assertSafeCronSessionTargetId("project-alpha"));
	});

	it("throws on empty id", () => {
		assert.throws(
			() => assertSafeCronSessionTargetId(""),
			InvalidCronSessionTargetIdError,
		);
	});

	it("throws on forward slash", () => {
		assert.throws(
			() => assertSafeCronSessionTargetId("evil/escape"),
			/path separators/,
		);
	});

	it("throws on backslash", () => {
		assert.throws(
			() => assertSafeCronSessionTargetId("evil\\escape"),
			/path separators/,
		);
	});

	it("throws on control characters", () => {
		assert.throws(
			() => assertSafeCronSessionTargetId("ab"),
			/control characters/,
		);
	});
});

describe("isInvalidCronSessionTargetIdError predicate", () => {
	it("matches an InvalidCronSessionTargetIdError instance", () => {
		try {
			assertSafeCronSessionTargetId("");
			assert.fail("should have thrown");
		} catch (err) {
			assert.equal(isInvalidCronSessionTargetIdError(err), true);
		}
	});

	it("returns false for arbitrary errors", () => {
		assert.equal(isInvalidCronSessionTargetIdError(new Error("nope")), false);
	});

	it("returns false for non-errors", () => {
		assert.equal(isInvalidCronSessionTargetIdError(null), false);
		assert.equal(isInvalidCronSessionTargetIdError(undefined), false);
		assert.equal(isInvalidCronSessionTargetIdError("oops"), false);
	});

	it("matches by name even when prototype is lost (cross-realm safety)", () => {
		const fake = { name: "InvalidCronSessionTargetIdError", message: "x" };
		assert.equal(isInvalidCronSessionTargetIdError(fake), true);
	});
});
