import assert from "node:assert/strict";
import { test } from "node:test";

import {
	REDACTED_SENTINEL,
	configGetValue,
	configSetValue,
	configUnsetValue,
	deleteNested,
	getNested,
	parseConfigValue,
	parsePath,
	redactDeep,
	setNested,
} from "./config-ops.js";

test("parsePath: dot notation, escaped dots, bracket index + literal key", () => {
	assert.deepEqual(parsePath("a.b.c"), ["a", "b", "c"]);
	assert.deepEqual(parsePath("keys.foo\\.bar"), ["keys", "foo.bar"]);
	assert.deepEqual(parsePath("a.list[0]"), ["a", "list", "0"]);
	assert.deepEqual(parsePath('m.providers["my.vault"]'), ["m", "providers", "my.vault"]);
	assert.throws(() => parsePath("   "), /empty/);
	assert.throws(() => parsePath("a.[0"), /unclosed/);
});

test("getNested: reads nested objects + array indices", () => {
	const root = { a: { b: [10, 20] }, x: "y" };
	assert.equal(getNested(root, ["a", "b", "1"]), 20);
	assert.equal(getNested(root, ["x"]), "y");
	assert.equal(getNested(root, ["a", "missing"]), undefined);
	assert.equal(getNested(root, ["nope", "deep"]), undefined);
});

test("setNested: creates intermediate objects + arrays in the right shape", () => {
	const root: Record<string, unknown> = {};
	setNested(root, ["a", "b", "c"], 42);
	assert.deepEqual(root, { a: { b: { c: 42 } } });
	setNested(root, ["list", "0"], "first");
	const list = (root as { list?: unknown[] }).list;
	assert.ok(Array.isArray(list));
	assert.equal(list?.[0], "first");
});

test("deleteNested: removes object keys + splices array slots", () => {
	const root: Record<string, unknown> = { a: { b: 1, c: 2 }, list: [10, 20, 30] };
	assert.equal(deleteNested(root, ["a", "b"]), true);
	assert.deepEqual(root.a, { c: 2 });
	assert.equal(deleteNested(root, ["list", "1"]), true);
	assert.deepEqual(root.list, [10, 30]); // spliced down, not nulled
	assert.equal(deleteNested(root, ["missing"]), false);
});

test("redactDeep: redacts secret-looking keys, leaves the rest", () => {
	const out = redactDeep({
		apiKey: "sk-secret",
		token: "tok",
		nested: { password: "pw", name: "ok" },
		list: [{ secret: "s" }],
		empty: "",
	}) as {
		apiKey: string;
		token: string;
		nested: { password: string; name: string };
		list: Array<{ secret: string }>;
		empty: string;
	};
	assert.equal(out.apiKey, REDACTED_SENTINEL);
	assert.equal(out.token, REDACTED_SENTINEL);
	assert.equal(out.nested.password, REDACTED_SENTINEL);
	assert.equal(out.nested.name, "ok");
	assert.equal(out.list[0]?.secret, REDACTED_SENTINEL);
	assert.equal(out.empty, ""); // empty string is not redacted
});

test("parseConfigValue: JSON5 by default, raw-string fallback, strict JSON", () => {
	assert.equal(parseConfigValue("42"), 42);
	assert.equal(parseConfigValue("true"), true);
	assert.deepEqual(parseConfigValue("[1,2]"), [1, 2]);
	assert.equal(parseConfigValue("hello world"), "hello world"); // not JSON → raw string
	assert.throws(() => parseConfigValue("{bad", { strictJson: true }));
});

test("configGetValue: redacts secrets + reports found/absent", () => {
	const cfg = {
		agents: { defaults: { provider: "openrouter" } },
		providers: { x: { apiKey: "sk-live" } },
	};
	assert.deepEqual(configGetValue(cfg, "agents.defaults.provider"), { found: true, value: "openrouter" });
	assert.deepEqual(configGetValue(cfg, "providers.x"), { found: true, value: { apiKey: REDACTED_SENTINEL } });
	assert.deepEqual(configGetValue(cfg, "nope"), { found: false });
});

test("configSetValue / configUnsetValue: mutate in place", () => {
	const cfg: Record<string, unknown> = {};
	configSetValue(cfg, "gateway.auth.tokens", ["a", "b"]);
	assert.deepEqual((cfg as { gateway: { auth: { tokens: string[] } } }).gateway.auth.tokens, ["a", "b"]);
	assert.equal(configUnsetValue(cfg, "gateway.auth.tokens"), true);
	assert.equal((cfg as { gateway: { auth: { tokens?: string[] } } }).gateway.auth.tokens, undefined);
	assert.equal(configUnsetValue(cfg, "nope.path"), false);
});
