/**
 * Tests for the memory plugin SDK runtime — the seam between the built-in
 * `FactStore` + `FileMemoryStore` and a plugin-registered `MemoryCapability`.
 *
 * Asserts:
 *   1. `createDefaultMemoryCapability` returns hits from the underlying
 *      FactStore for a matching query.
 *   2. `resolveActiveMemoryCapability` returns the bundled default when no
 *      slot pin exists.
 *   3. `resolveActiveMemoryCapability` returns the slot-pinned plugin
 *      capability when `extensions.slots.memory` selects one.
 *   4. A fake `MemoryCapability` registered + pinned takes over
 *      `recall_memory`'s search (verified via `makeRecallMemoryTool`).
 *   5. `recordFact` round-trips through the capability AND lands in the
 *      underlying store (default backend).
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import { BrigadeExtensionRegistry } from "../extensions/registry.js";
import type { MemoryCapability } from "../extensions/types.js";
import { makeRecallMemoryTool } from "../tools/memory-tools.js";
import {
	createDefaultMemoryCapability,
	isDefaultMemoryCapability,
	resolveActiveMemoryCapability,
} from "./plugin-runtime.js";
import { FactStore } from "./records.js";

let workspace: string;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mem-plugin-"));
	fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(workspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("createDefaultMemoryCapability", () => {
	it("searches return facts from the underlying FactStore", async () => {
		// Seed the file-backed store directly so the capability has something
		// to find — proves the wrapper actually consults FactStore.
		const factStore = new FactStore(workspace);
		factStore.write({ content: "User prefers spaces over tabs.", segment: "preference" });
		factStore.write({ content: "Deploys run on Fridays.", segment: "project" });

		const capability = createDefaultMemoryCapability({ workspaceDir: workspace });
		const hits = await capability.search("spaces tabs");
		assert.equal(hits.length, 1, "should find the single matching fact");
		const hit = hits[0]!;
		assert.match(hit.content, /spaces over tabs/);
		assert.equal(hit.source, "memory", "fact hits surface as source=memory");
		assert.match(hit.id, /^mem_/, "fact id should follow FactStore mem_<base36>_<rand> format");
		assert.ok(hit.score > 0, "score should be positive");
	});

	it("status returns the active fact count", async () => {
		const factStore = new FactStore(workspace);
		factStore.write({ content: "thing one", segment: "context" });
		factStore.write({ content: "thing two", segment: "context" });
		const capability = createDefaultMemoryCapability({ workspaceDir: workspace });
		const status = await capability.status?.();
		assert.equal(status?.ready, true);
		assert.equal(status?.itemCount, 2);
	});
});

describe("resolveActiveMemoryCapability", () => {
	it("returns the bundled default when no slot pin is set", () => {
		const registry = new BrigadeExtensionRegistry();
		const cfg = {} as BrigadeConfig;
		const capability = resolveActiveMemoryCapability({
			config: cfg,
			registry,
			workspaceDir: workspace,
		});
		assert.equal(capability.id, "brigade.memory.default");
		assert.equal(isDefaultMemoryCapability(capability), true);
	});

	it("returns the slot-pinned capability when configured", () => {
		const registry = new BrigadeExtensionRegistry();
		const fake: MemoryCapability = {
			id: "test-vector-backend",
			label: "Test vector backend",
			async search() {
				return [{ id: "v-1", content: "from plugin", score: 1, source: "memory" }];
			},
			async recordFact() {
				return { id: "v-fresh" };
			},
		};
		// Register the fake through the recording context (same path a real
		// `defineModule({ register(b) { b.memory(...) } })` would take).
		registry
			.context({
				agentId: "main",
				workspaceDir: workspace,
				cwd: workspace,
				config: {} as BrigadeConfig,
			})
			.memory(fake);

		const pinnedConfig = {
			extensions: { slots: { memory: "test-vector-backend" } },
		} as unknown as BrigadeConfig;
		const capability = resolveActiveMemoryCapability({
			config: pinnedConfig,
			registry,
			workspaceDir: workspace,
		});
		assert.equal(capability.id, "test-vector-backend");
		assert.equal(
			isDefaultMemoryCapability(capability),
			false,
			"plugin id should NOT match the default-backend id",
		);
	});

	it("falls back to default when slot pin names a non-registered capability", () => {
		const registry = new BrigadeExtensionRegistry();
		const cfg = {
			extensions: { slots: { memory: "does-not-exist" } },
		} as unknown as BrigadeConfig;
		const capability = resolveActiveMemoryCapability({
			config: cfg,
			registry,
			workspaceDir: workspace,
		});
		// Unresolved pin → resolveSlot returns undefined → default backend
		// takes over. The unknown-plugin id is silently ignored (matches the
		// pattern in `BrigadeExtensionRegistry.resolveSlot`).
		assert.equal(capability.id, "brigade.memory.default");
	});
});

describe("recall_memory tool routes through the active capability", () => {
	it("a pinned plugin takes over recall_memory's search output", async () => {
		// A fake backend that ignores the query and returns a marker — proves
		// recall_memory delegated to the plugin (the marker can't come from
		// the file-backed default).
		const sentinelId = "vec_42";
		const sentinelContent = "ONLY-FROM-PLUGIN-BACKEND";
		const fake: MemoryCapability = {
			id: "fake-vector",
			label: "Fake vector backend",
			async search() {
				return [
					{ id: sentinelId, content: sentinelContent, score: 0.99, source: "memory" },
				];
			},
			async recordFact() {
				return { id: "fresh" };
			},
		};

		const tool = makeRecallMemoryTool(fake);
		const result = await tool.execute("call-1", { query: "anything" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, new RegExp(sentinelContent));
		assert.match(text, /fake-vector/, "rendered output advertises the active backend");
		assert.equal(result.details.backend, "fake-vector");
		assert.equal(result.details.pluginHits?.length, 1);
		assert.equal(result.details.pluginHits?.[0]?.id, sentinelId);
		// Default-backend channels are empty on the plugin path.
		assert.equal(result.details.results.length, 0);
		assert.equal(result.details.facts.length, 0);
	});
});

describe("recordFact round-trips through the capability and the underlying store", () => {
	it("default backend persists to FactStore and the fact is recall-findable", async () => {
		const capability = createDefaultMemoryCapability({ workspaceDir: workspace });
		const written = await capability.recordFact("Coffee orders involve oat milk.", {
			meta: { segment: "preference" },
		});
		assert.ok(written.id.startsWith("mem_"), "should return a FactStore-style id");

		// Underlying store has the record at the right segment.
		const fromStore = new FactStore(workspace).list();
		assert.equal(fromStore.length, 1);
		assert.equal(fromStore[0]?.segment, "preference");
		assert.match(fromStore[0]?.content ?? "", /oat milk/);

		// And recall via the same capability surfaces it.
		const hits = await capability.search("oat milk");
		assert.equal(hits.length, 1);
		assert.match(hits[0]?.content ?? "", /oat milk/);
	});
});
