import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createMcpTurnRegistry,
	getActiveMcpToolPlaneHost,
	setActiveMcpToolPlaneHost,
	type McpTurnContext,
} from "./tool-plane-host.js";

const fakeCtx = (agentId = "main"): McpTurnContext => ({
	customTools: [],
	guard: async () => undefined,
	agentId,
});

test("register mints a 256-bit hex token and lookup resolves it", () => {
	const reg = createMcpTurnRegistry();
	const { token } = reg.register(fakeCtx());
	assert.match(token, /^[0-9a-f]{64}$/);
	assert.equal(reg.lookup(token)?.agentId, "main");
	assert.equal(reg.size(), 1);
});

test("dispose is idempotent and removes the entry", () => {
	const reg = createMcpTurnRegistry();
	const r = reg.register(fakeCtx());
	r.dispose();
	assert.equal(reg.lookup(r.token), undefined);
	assert.equal(reg.size(), 0);
	assert.doesNotThrow(() => r.dispose()); // idempotent
});

test("each registration is a distinct unguessable token", () => {
	const reg = createMcpTurnRegistry();
	const a = reg.register(fakeCtx("a"));
	const b = reg.register(fakeCtx("b"));
	assert.notEqual(a.token, b.token);
	assert.equal(reg.lookup(a.token)?.agentId, "a");
	assert.equal(reg.lookup(b.token)?.agentId, "b");
});

test("lookup rejects malformed tokens before hitting the map", () => {
	const reg = createMcpTurnRegistry();
	assert.equal(reg.lookup(""), undefined);
	assert.equal(reg.lookup("../evil"), undefined);
	assert.equal(reg.lookup("SHORT"), undefined);
	assert.equal(reg.lookup("g".repeat(64)), undefined); // non-hex
	assert.equal(reg.lookup(undefined as never), undefined);
});

test("host singleton: null by default (cold path), set/clear round-trips", () => {
	setActiveMcpToolPlaneHost(null);
	assert.equal(getActiveMcpToolPlaneHost(), null);
	const host = { baseUrl: "http://127.0.0.1:7777", registry: createMcpTurnRegistry() };
	setActiveMcpToolPlaneHost(host);
	assert.equal(getActiveMcpToolPlaneHost()?.baseUrl, "http://127.0.0.1:7777");
	setActiveMcpToolPlaneHost(null);
	assert.equal(getActiveMcpToolPlaneHost(), null);
});
