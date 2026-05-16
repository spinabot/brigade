import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	BrigadeToolAuthorizationError,
	BrigadeToolInputError,
	failedTextResult,
	jsonResult,
	payloadTextResult,
	readBooleanParam,
	readNumberParam,
	readStringArrayParam,
	readStringParam,
	stringifyToolPayload,
	textResult,
} from "./common.js";

describe("BrigadeToolInputError", () => {
	it("carries a 400 status by default", () => {
		const err = new BrigadeToolInputError("missing path");
		assert.equal(err.status, 400);
		assert.equal(err.name, "BrigadeToolInputError");
		assert.equal(err.message, "missing path");
	});

	it("BrigadeToolAuthorizationError is a 403-class subclass", () => {
		const err = new BrigadeToolAuthorizationError("not owner");
		assert.equal(err.status, 403);
		assert.ok(err instanceof BrigadeToolInputError);
		assert.equal(err.name, "BrigadeToolAuthorizationError");
	});
});

describe("readStringParam", () => {
	it("returns trimmed value when present", () => {
		assert.equal(readStringParam({ path: "  foo  " }, "path"), "foo");
	});

	it("returns undefined when missing and not required", () => {
		assert.equal(readStringParam({}, "path"), undefined);
	});

	it("throws BrigadeToolInputError when missing and required", () => {
		assert.throws(
			() => readStringParam({}, "path", { required: true }),
			(err: unknown) =>
				err instanceof BrigadeToolInputError && /path required/.test((err as Error).message),
		);
	});

	it("uses the label in the error message", () => {
		assert.throws(
			() => readStringParam({}, "p", { required: true, label: "search pattern" }),
			/search pattern required/,
		);
	});

	it("trim=false preserves whitespace", () => {
		assert.equal(readStringParam({ path: "  foo  " }, "path", { trim: false }), "  foo  ");
	});

	it("allowEmpty accepts empty string", () => {
		assert.equal(readStringParam({ path: "" }, "path", { allowEmpty: true }), "");
	});

	it("snake_case fallback — camelCase key resolves a snake_case param", () => {
		assert.equal(readStringParam({ tool_call_id: "abc" }, "toolCallId"), "abc");
	});

	it("non-string raw → undefined (no throw when not required)", () => {
		assert.equal(readStringParam({ path: 42 }, "path"), undefined);
		assert.equal(readStringParam({ path: null }, "path"), undefined);
		assert.equal(readStringParam({ path: { x: 1 } }, "path"), undefined);
	});

	it("non-string raw + required → throws", () => {
		assert.throws(
			() => readStringParam({ path: 42 }, "path", { required: true }),
			BrigadeToolInputError,
		);
	});
});

describe("readNumberParam", () => {
	it("returns numeric values as-is", () => {
		assert.equal(readNumberParam({ n: 3 }, "n"), 3);
		assert.equal(readNumberParam({ n: 3.14 }, "n"), 3.14);
	});

	it("parses numeric strings", () => {
		assert.equal(readNumberParam({ n: "42" }, "n"), 42);
		assert.equal(readNumberParam({ n: "  3.14  " }, "n"), 3.14);
	});

	it("integer=true truncates", () => {
		assert.equal(readNumberParam({ n: 3.9 }, "n", { integer: true }), 3);
		assert.equal(readNumberParam({ n: -3.9 }, "n", { integer: true }), -3);
	});

	it("strict=true rejects 12abc (parseFloat accepts it)", () => {
		assert.equal(readNumberParam({ n: "12abc" }, "n"), 12);
		assert.equal(readNumberParam({ n: "12abc" }, "n", { strict: true }), undefined);
	});

	it("required throws when missing", () => {
		assert.throws(
			() => readNumberParam({}, "n", { required: true }),
			BrigadeToolInputError,
		);
	});

	it("Infinity/NaN are not finite → treated as missing", () => {
		assert.equal(readNumberParam({ n: Number.POSITIVE_INFINITY }, "n"), undefined);
		assert.equal(readNumberParam({ n: Number.NaN }, "n"), undefined);
	});
});

describe("readBooleanParam", () => {
	it("returns booleans as-is", () => {
		assert.equal(readBooleanParam({ x: true }, "x"), true);
		assert.equal(readBooleanParam({ x: false }, "x"), false);
	});

	it("parses common truthy/falsy strings", () => {
		assert.equal(readBooleanParam({ x: "true" }, "x"), true);
		assert.equal(readBooleanParam({ x: "YES" }, "x"), true);
		assert.equal(readBooleanParam({ x: "1" }, "x"), true);
		assert.equal(readBooleanParam({ x: "false" }, "x"), false);
		assert.equal(readBooleanParam({ x: "no" }, "x"), false);
		assert.equal(readBooleanParam({ x: "0" }, "x"), false);
	});

	it("returns default when missing", () => {
		assert.equal(readBooleanParam({}, "x", { default: true }), true);
		assert.equal(readBooleanParam({}, "x", { default: false }), false);
		assert.equal(readBooleanParam({}, "x"), undefined);
	});

	it("required + missing → throws", () => {
		assert.throws(
			() => readBooleanParam({}, "x", { required: true }),
			BrigadeToolInputError,
		);
	});

	it("non-boolean, non-string → throws", () => {
		assert.throws(
			() => readBooleanParam({ x: 42 }, "x"),
			(err: unknown) =>
				err instanceof BrigadeToolInputError && /must be a boolean/.test((err as Error).message),
		);
	});
});

describe("readStringArrayParam", () => {
	it("returns trimmed non-empty strings from an array", () => {
		assert.deepEqual(
			readStringArrayParam({ tags: ["a", "  b  ", "", "c"] }, "tags"),
			["a", "b", "c"],
		);
	});

	it("a single string is wrapped into a one-element array", () => {
		assert.deepEqual(readStringArrayParam({ tags: "single" }, "tags"), ["single"]);
	});

	it("empty array + required → throws", () => {
		assert.throws(
			() => readStringArrayParam({ tags: [] }, "tags", { required: true }),
			BrigadeToolInputError,
		);
	});

	it("absent + not-required → undefined", () => {
		assert.equal(readStringArrayParam({}, "tags"), undefined);
	});
});

describe("stringifyToolPayload", () => {
	it("strings pass through unchanged", () => {
		assert.equal(stringifyToolPayload("hello"), "hello");
	});

	it("objects are JSON-stringified with 2-space indent", () => {
		assert.equal(stringifyToolPayload({ a: 1 }), '{\n  "a": 1\n}');
	});

	it("non-serializable values fall back to String()", () => {
		const circular: { self?: unknown } = {};
		circular.self = circular;
		// JSON.stringify throws on circular; the fallback is String(payload).
		const out = stringifyToolPayload(circular);
		assert.ok(typeof out === "string");
	});

	it("primitive non-strings are stringified via JSON", () => {
		assert.equal(stringifyToolPayload(42), "42");
		assert.equal(stringifyToolPayload(true), "true");
		assert.equal(stringifyToolPayload(null), "null");
	});
});

describe("textResult / failedTextResult / payloadTextResult / jsonResult", () => {
	it("textResult builds a {content: [{text}], details}", () => {
		const r = textResult("hello", { x: 1 });
		assert.deepEqual(r.content, [{ type: "text", text: "hello" }]);
		assert.deepEqual(r.details, { x: 1 });
	});

	it("failedTextResult is a type-narrowed alias of textResult", () => {
		const r = failedTextResult("oops", { status: "failed", reason: "x" });
		assert.deepEqual(r.content, [{ type: "text", text: "oops" }]);
		assert.equal(r.details.status, "failed");
	});

	it("payloadTextResult uses the payload as both content text and details", () => {
		const r = payloadTextResult({ a: 1 });
		// content is the stringified payload
		assert.match((r.content[0] as { text: string }).text, /"a": 1/);
		// details is the raw payload
		assert.deepEqual(r.details, { a: 1 });
	});

	it("jsonResult is JSON.stringify w/ details = raw payload", () => {
		const r = jsonResult({ x: [1, 2] });
		assert.equal((r.content[0] as { text: string }).text, '{\n  "x": [\n    1,\n    2\n  ]\n}');
		assert.deepEqual(r.details, { x: [1, 2] });
	});
});
