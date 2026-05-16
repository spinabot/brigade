import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	isLikelyMalformedArgs,
	makeUnknownToolGuard,
	trimToolCallName,
} from "./tool-guard.js";

// The Pi `BeforeToolCallContext` is a structural type — we can build minimal
// test ctx objects with just the fields the guard reads.
const ctx = (toolCall: { name?: unknown; arguments?: unknown }): never =>
	({ toolCall }) as never;

describe("trimToolCallName", () => {
	it("trims surrounding whitespace", () => {
		assert.equal(trimToolCallName("  read  "), "read");
		assert.equal(trimToolCallName("\tbash\n"), "bash");
		assert.equal(trimToolCallName("read"), "read");
	});
	it("returns empty for non-strings", () => {
		assert.equal(trimToolCallName(undefined), "");
		assert.equal(trimToolCallName(null), "");
		assert.equal(trimToolCallName(123), "");
		assert.equal(trimToolCallName({}), "");
	});
});

describe("isLikelyMalformedArgs", () => {
	it("flags null / undefined / non-objects", () => {
		assert.equal(isLikelyMalformedArgs(null, "read"), true);
		assert.equal(isLikelyMalformedArgs(undefined, "read"), true);
		assert.equal(isLikelyMalformedArgs("string", "read"), true);
		assert.equal(isLikelyMalformedArgs(42, "read"), true);
	});
	it("flags empty object for tools that need args", () => {
		assert.equal(isLikelyMalformedArgs({}, "read"), true);
		assert.equal(isLikelyMalformedArgs({}, "bash"), true);
		assert.equal(isLikelyMalformedArgs({}, "edit"), true);
	});
	it("does NOT flag empty object for parameter-less tools", () => {
		assert.equal(isLikelyMalformedArgs({}, "ping"), false);
		assert.equal(isLikelyMalformedArgs({}, "status"), false);
		assert.equal(isLikelyMalformedArgs({}, "list_models"), false);
		assert.equal(isLikelyMalformedArgs({}, "version"), false);
	});
	it("does NOT flag objects with at least one key", () => {
		assert.equal(isLikelyMalformedArgs({ path: "foo" }, "read"), false);
		assert.equal(isLikelyMalformedArgs({ a: 1, b: 2 }, "read"), false);
	});
});

describe("makeUnknownToolGuard", () => {
	const allowed = ["read", "write", "edit", "bash", "grep"];
	const guard = makeUnknownToolGuard(allowed);

	it("allows a known tool with valid args (returns undefined)", async () => {
		const result = await guard(ctx({ name: "read", arguments: { path: "foo.ts" } }));
		assert.equal(result, undefined);
	});

	it("blocks a hallucinated tool name", async () => {
		const result = await guard(ctx({ name: "open_file", arguments: { path: "foo.ts" } }));
		assert.ok(result?.block);
		assert.match(result!.reason!, /Tool "open_file" is not available/);
		assert.match(result!.reason!, /bash, edit, grep, read, write/);
	});

	it("ALLOWS a known tool name wrapped in whitespace if trimmed name is valid", async () => {
		// trim happens before the allowlist check. "  read  " trims to "read"
		// which IS in the allowlist, so the call passes through. The whitespace
		// hint only fires for names that AREN'T recognised even after trimming.
		const result = await guard(ctx({ name: "  read  ", arguments: { path: "foo.ts" } }));
		assert.equal(result, undefined);
	});

	it("blocks an UNKNOWN name with whitespace, hints to drop spaces", async () => {
		// "  open_file  " trims to "open_file", still not in allowlist → refuse,
		// AND the hint mentions the whitespace so the model knows to retry
		// with a clean name.
		const result = await guard(ctx({ name: "  open_file  ", arguments: { path: "foo.ts" } }));
		assert.ok(result?.block);
		assert.match(result!.reason!, /had extra whitespace/i);
		assert.match(result!.reason!, /"open_file"/);
	});

	it("blocks a known tool with empty args (likely malformed)", async () => {
		const result = await guard(ctx({ name: "read", arguments: {} }));
		assert.ok(result?.block);
		assert.match(result!.reason!, /empty\/missing arguments/i);
	});

	it("allows a parameter-less tool with empty args", async () => {
		const guardWithPing = makeUnknownToolGuard([...allowed, "ping"]);
		const result = await guardWithPing(ctx({ name: "ping", arguments: {} }));
		assert.equal(result, undefined);
	});

	it("unknown-tool refusal wins over malformed-args refusal", async () => {
		// Both bad name AND empty args — guard should refuse on name first
		// so the model retries with the right tool, not the right args
		// for a wrong tool.
		const result = await guard(ctx({ name: "unknownX", arguments: {} }));
		assert.ok(result?.block);
		assert.match(result!.reason!, /not available/);
		assert.doesNotMatch(result!.reason!, /empty\/missing arguments/);
	});

	it("empty allowlist → every call refused, lists '(no tools enabled)'", async () => {
		const emptyGuard = makeUnknownToolGuard([]);
		const result = await emptyGuard(ctx({ name: "read", arguments: { path: "foo" } }));
		assert.ok(result?.block);
		assert.match(result!.reason!, /no tools enabled/);
	});

	it("missing toolCall.name returns refusal (treated as unknown)", async () => {
		const result = await guard(ctx({ arguments: { path: "foo" } }));
		assert.ok(result?.block);
		assert.match(result!.reason!, /not available/);
	});
});
