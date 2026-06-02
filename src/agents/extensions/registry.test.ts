/**
 * Tests for the extension registry's provider auto-detection — operator
 * pin, allow/deny lists, per-id lookup. Pure-logic; no extensions
 * actually loaded.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { BrigadeExtensionRegistry } from "./registry.js";
import type { WebSearchProvider } from "./types.js";

function fakeProvider(
	id: string,
	autoDetectOrder: number,
	configured: boolean,
	requiresCredential = true,
): WebSearchProvider {
	return {
		id,
		label: id,
		hint: "",
		envVars: [],
		requiresCredential,
		autoDetectOrder,
		isConfigured: () => configured,
		createTool: () => ({
			description: id,
			parameters: { type: "object", properties: {} },
			execute: async () => ({}),
		}),
	};
}

function makeRegistryWith(providers: WebSearchProvider[]): BrigadeExtensionRegistry {
	const r = new BrigadeExtensionRegistry();
	const ctx = r.context({
		agentId: "test",
		workspaceDir: "/tmp",
		cwd: "/tmp",
		config: {} as never,
		moduleConfig: undefined,
	});
	for (const p of providers) ctx.webSearch(p);
	return r;
}

describe("BrigadeExtensionRegistry.resolveActiveWebSearchProvider — pin/allow/deny", () => {
	it("picks lowest autoDetectOrder configured provider by default", () => {
		const r = makeRegistryWith([
			fakeProvider("tavily", 20, true),
			fakeProvider("brave", 30, true),
			fakeProvider("duckduckgo", 100, true, false),
		]);
		const active = r.resolveActiveWebSearchProvider({} as never);
		assert.equal(active?.id, "tavily");
	});

	it("honors operator pin `tools.web.search.provider`", () => {
		const r = makeRegistryWith([
			fakeProvider("tavily", 20, true),
			fakeProvider("brave", 30, true),
		]);
		const cfg = { tools: { web: { search: { provider: "brave" } } } };
		const active = r.resolveActiveWebSearchProvider(cfg as never);
		assert.equal(active?.id, "brave");
	});

	it("deny list excludes a provider from auto-detect", () => {
		const r = makeRegistryWith([
			fakeProvider("tavily", 20, true),
			fakeProvider("brave", 30, true),
		]);
		const cfg = { tools: { web: { search: { deny: ["tavily"] } } } };
		const active = r.resolveActiveWebSearchProvider(cfg as never);
		assert.equal(active?.id, "brave");
	});

	it("allow list (when non-empty) restricts to listed providers only", () => {
		const r = makeRegistryWith([
			fakeProvider("tavily", 20, true),
			fakeProvider("brave", 30, true),
			fakeProvider("exa", 40, true),
		]);
		const cfg = { tools: { web: { search: { allow: ["exa"] } } } };
		const active = r.resolveActiveWebSearchProvider(cfg as never);
		assert.equal(active?.id, "exa");
	});

	it("deny wins when a provider is both allowed and denied", () => {
		const r = makeRegistryWith([
			fakeProvider("brave", 30, true),
			fakeProvider("exa", 40, true),
		]);
		const cfg = { tools: { web: { search: { allow: ["brave", "exa"], deny: ["brave"] } } } };
		const active = r.resolveActiveWebSearchProvider(cfg as never);
		assert.equal(active?.id, "exa");
	});

	it("pinned provider that's denied returns null (operator config conflict)", () => {
		const r = makeRegistryWith([fakeProvider("brave", 30, true)]);
		const cfg = { tools: { web: { search: { provider: "brave", deny: ["brave"] } } } };
		assert.equal(r.resolveActiveWebSearchProvider(cfg as never), null);
	});
});

describe("BrigadeExtensionRegistry.lookupWebSearchProviderById — per-call override", () => {
	it("finds a provider by id", () => {
		const r = makeRegistryWith([fakeProvider("brave", 30, true)]);
		const p = r.lookupWebSearchProviderById("brave", {} as never);
		assert.equal(p?.id, "brave");
	});

	it("returns null on unknown id", () => {
		const r = makeRegistryWith([fakeProvider("brave", 30, true)]);
		assert.equal(r.lookupWebSearchProviderById("you", {} as never), null);
	});

	it("respects deny list when set", () => {
		const r = makeRegistryWith([fakeProvider("brave", 30, true)]);
		const cfg = { tools: { web: { search: { deny: ["brave"] } } } };
		assert.equal(r.lookupWebSearchProviderById("brave", cfg as never), null);
	});

	it("respects allow list when set", () => {
		const r = makeRegistryWith([
			fakeProvider("brave", 30, true),
			fakeProvider("exa", 40, true),
		]);
		const cfg = { tools: { web: { search: { allow: ["exa"] } } } };
		assert.equal(r.lookupWebSearchProviderById("brave", cfg as never), null);
		const exa = r.lookupWebSearchProviderById("exa", cfg as never);
		assert.equal(exa?.id, "exa");
	});
});

describe("BrigadeExtensionRegistry — b.tool({ create }) per-turn factory (Wave K)", () => {
	it("invokes create({ agentId, sessionKey }) at toPiExtensionFactory replay", () => {
		const r = new BrigadeExtensionRegistry();
		const ctx = r.context({
			agentId: "boot",
			workspaceDir: "/tmp",
			cwd: "/tmp",
			config: {} as never,
			moduleConfig: undefined,
		});
		const seen: Array<{ agentId: string; sessionKey: string }> = [];
		ctx.tool({
			create: (factoryCtx) => {
				seen.push({ agentId: factoryCtx.agentId, sessionKey: factoryCtx.sessionKey });
				return {
					name: "scoped-tool",
					label: "Scoped",
					description: "per-turn scoped tool",
					parameters: { type: "object", properties: {} },
					execute: async () => ({}),
				} as never;
			},
		});
		const registered: Array<{ name: string }> = [];
		const pi = {
			registerTool: (t: { name: string }) => {
				registered.push({ name: t.name });
			},
			on: () => {},
			registerCommand: () => {},
		};
		r.toPiExtensionFactory({ agentId: "ops", sessionKey: "agent:ops:main" })(pi as never);
		assert.equal(seen.length, 1, "factory invoked once per session-init");
		assert.equal(seen[0]?.agentId, "ops");
		assert.equal(seen[0]?.sessionKey, "agent:ops:main");
		assert.equal(registered.length, 1);
		assert.equal(registered[0]?.name, "scoped-tool");
	});

	it("legacy bare tool keeps working alongside factory tools", () => {
		const r = new BrigadeExtensionRegistry();
		const ctx = r.context({
			agentId: "boot",
			workspaceDir: "/tmp",
			cwd: "/tmp",
			config: {} as never,
			moduleConfig: undefined,
		});
		const bare = {
			name: "bare-tool",
			label: "Bare",
			description: "legacy bare tool",
			parameters: { type: "object", properties: {} },
			execute: async () => ({}),
		};
		ctx.tool(bare as never);
		ctx.tool({
			create: () => ({
				name: "factory-tool",
				label: "Factory",
				description: "factory tool",
				parameters: { type: "object", properties: {} },
				execute: async () => ({}),
			}) as never,
		});
		const registered: string[] = [];
		const pi = {
			registerTool: (t: { name: string }) => {
				registered.push(t.name);
			},
			on: () => {},
			registerCommand: () => {},
		};
		r.toPiExtensionFactory({ agentId: "main", sessionKey: "agent:main:main" })(pi as never);
		assert.deepEqual(registered.sort(), ["bare-tool", "factory-tool"]);
	});
});
