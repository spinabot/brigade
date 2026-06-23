import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Type } from "typebox";

import type { BrigadeConfig } from "../../config/io.js";
import type { AnyBrigadeTool } from "../tools/types.js";
import { diagnoseExtensions } from "./diagnose.js";
import { clearDiscoveryCache, discoverUserModules } from "./discovery.js";
import { loadModules } from "./loader.js";
import { BrigadeExtensionRegistry } from "./registry.js";
import { type ChannelAdapter, defineModule } from "./types.js";

const META = { agentId: "main", workspaceDir: "/ws", cwd: "/cwd", config: {} as BrigadeConfig };

/** Minimal valid tool fake. */
function fakeTool(name: string): AnyBrigadeTool {
	return {
		name,
		label: name,
		description: "d",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	} as AnyBrigadeTool;
}

/** Minimal valid channel fake. */
function fakeChannel(id: string): ChannelAdapter {
	return {
		id,
		label: id,
		isConfigured: () => true,
		async start() {},
		async stop() {},
		async sendText() {},
	};
}

describe("BrigadeExtensionRegistry", () => {
	it("records agent-level + product-level registrations", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(fakeTool("ping"));
		b.channel(fakeChannel("wa"));
		b.tts({
			id: "el",
			label: "ElevenLabs",
			isConfigured: () => true,
			async synthesize() {
				return { audio: Buffer.from(""), mimeType: "audio/mpeg" };
			},
		});
		assert.deepEqual(reg.toolNames(), ["ping"]);
		assert.equal(reg.channels.length, 1);
		assert.equal(reg.channels[0]?.id, "wa");
		assert.equal(reg.speechProviders.length, 1);
	});

	it("product registrations dedupe by id (last wins)", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.channel({ ...fakeChannel("wa"), label: "first" });
		b.channel({ ...fakeChannel("wa"), label: "second" });
		assert.equal(reg.channels.length, 1);
		assert.equal(reg.channels[0]?.label, "second");
	});

	it("eligible()=false gates a tool out of toolNames AND the Pi factory", () => {
		const reg = new BrigadeExtensionRegistry();
		reg.context(META).tool(fakeTool("off"), { eligible: () => false });
		assert.deepEqual(reg.toolNames(), []);
		const registered: string[] = [];
		const pi = { registerTool: (t: { name: string }) => registered.push(t.name), on() {}, registerCommand() {} };
		reg.toPiExtensionFactory()(pi as never);
		assert.deepEqual(registered, []);
	});

	it("strips systemPrompt from a before_agent_start hook (persona pin is sacred)", async () => {
		const reg = new BrigadeExtensionRegistry();
		reg.context(META).hook("before_agent_start", () => ({ systemPrompt: "HIJACK", message: { content: "keep" } }));
		let captured: ((...a: unknown[]) => unknown) | undefined;
		const pi = { registerTool() {}, on: (_e: string, h: (...a: unknown[]) => unknown) => (captured = h), registerCommand() {} };
		reg.toPiExtensionFactory()(pi as never);
		const result = (await captured?.()) as Record<string, unknown>;
		assert.equal("systemPrompt" in result, false); // persona override stripped
		assert.deepEqual(result.message, { content: "keep" }); // rest preserved
	});

	it("leaves non-before_agent_start hook results untouched", async () => {
		const reg = new BrigadeExtensionRegistry();
		reg.context(META).hook("tool_result", () => ({ systemPrompt: "ok-here" }));
		let captured: ((...a: unknown[]) => unknown) | undefined;
		const pi = { registerTool() {}, on: (_e: string, h: (...a: unknown[]) => unknown) => (captured = h), registerCommand() {} };
		reg.toPiExtensionFactory()(pi as never);
		const result = (await captured?.()) as Record<string, unknown>;
		assert.equal(result.systemPrompt, "ok-here"); // only before_agent_start is guarded
	});

	it("replays hooks in priority order (higher first; ties keep registration order)", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.hook("turn_start", () => "low", { priority: -10 });
		b.hook("turn_start", () => "high", { priority: 100 });
		b.hook("turn_start", () => "mid-a"); // default 0
		b.hook("turn_start", () => "mid-b"); // default 0 — ties keep order
		const order: string[] = [];
		const pi = {
			registerTool() {},
			on: (_e: string, h: () => string) => order.push(h()),
			registerCommand() {},
		};
		reg.toPiExtensionFactory()(pi as never);
		assert.deepEqual(order, ["high", "mid-a", "mid-b", "low"]);
	});

	it("records the new product capabilities (service / httpRoute / gatewayMethod / channelCommand)", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.service({ id: "poller", async start() {}, async stop() {} });
		b.httpRoute({ path: "/hook", handler: () => {} });
		b.gatewayMethod({ name: "x.ping", handler: () => "pong" });
		b.channelCommand({ name: "status", handler: () => "ok" });
		assert.equal(reg.services.length, 1);
		assert.equal(reg.services[0]?.id, "poller");
		assert.equal(reg.httpRoutes.length, 1);
		assert.equal(reg.httpRoutes[0]?.path, "/hook");
		assert.equal(reg.gatewayMethods.length, 1);
		assert.equal(reg.gatewayMethods[0]?.name, "x.ping");
		assert.equal(reg.channelCommands.length, 1);
		assert.equal(reg.channelCommands[0]?.name, "status");
	});

	it("httpRoute dedupes by method+path (last wins; same path different method coexist)", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.httpRoute({ method: "POST", path: "/hook", handler: () => {} });
		b.httpRoute({ method: "POST", path: "/hook", handler: () => {} }); // dup → replaces
		b.httpRoute({ method: "GET", path: "/hook", handler: () => {} }); // different method → coexists
		assert.equal(reg.httpRoutes.length, 2);
	});

	it("channelCommand dedupes case-insensitively (matches dispatch)", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.channelCommand({ name: "Echo", handler: () => "1" });
		b.channelCommand({ name: "echo", handler: () => "2" }); // same key (lowercased) → replaces
		assert.equal(reg.channelCommands.length, 1);
	});

	it("toPiExtensionFactory replays tools + hooks + commands into the Pi API", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(fakeTool("ping"));
		b.hook("tool_result", () => {});
		b.command("hi", {});
		const tools: string[] = [];
		const events: string[] = [];
		const cmds: string[] = [];
		const pi = {
			registerTool: (t: { name: string }) => tools.push(t.name),
			on: (e: string) => events.push(e),
			registerCommand: (n: string) => cmds.push(n),
		};
		reg.toPiExtensionFactory()(pi as never);
		assert.deepEqual(tools, ["ping"]);
		assert.deepEqual(events, ["tool_result"]);
		assert.deepEqual(cmds, ["hi"]);
	});
});

describe("loadModules gating", () => {
	const channelMod = (id: string) => defineModule({ id, register: (b) => b.channel(fakeChannel(id)) });
	// noDiscovery keeps these hermetic — no scan of the real ~/.brigade/extensions.
	const load = (args: Parameters<typeof loadModules>[0]) => loadModules({ noDiscovery: true, ...args });

	it("loads an enabled module", async () => {
		const reg = await load({ modules: [channelMod("a")], meta: META });
		assert.equal(reg.channels.length, 1);
		assert.deepEqual(
			reg.loadedModules.map((m) => m.id),
			["a"],
		);
	});

	it("skips a module in extensions.disabled[]", async () => {
		const reg = await load({
			modules: [channelMod("a")],
			meta: { ...META, config: { extensions: { disabled: ["a"] } } as unknown as BrigadeConfig },
		});
		assert.equal(reg.channels.length, 0);
	});

	it("skips everything when extensions.enabled === false", async () => {
		const reg = await load({
			modules: [channelMod("a")],
			meta: { ...META, config: { extensions: { enabled: false } } as unknown as BrigadeConfig },
		});
		assert.equal(reg.channels.length, 0);
	});

	it("allowlist: when extensions.allow is non-empty, only listed modules load", async () => {
		const reg = await load({
			modules: [channelMod("a"), channelMod("b")],
			meta: { ...META, config: { extensions: { allow: ["b"] } } as unknown as BrigadeConfig },
		});
		assert.deepEqual(
			reg.channels.map((c) => c.id),
			["b"],
		);
	});

	it("skips a module whose requiresEnv is missing", async () => {
		const mod = defineModule({ id: "b", requiresEnv: ["MISSING_XYZ_123"], register: (b) => b.channel(fakeChannel("b")) });
		const reg = await load({ modules: [mod], meta: META, env: {} });
		assert.equal(reg.channels.length, 0);
	});

	it("config-schema: a module whose entries[id].config fails validation is skipped", async () => {
		const mod = defineModule({
			id: "needs-config",
			configSchema: Type.Object({ token: Type.String() }),
			register: (b) => b.channel(fakeChannel("needs-config")),
		});
		// Missing required `token` → validation fails → skipped.
		const bad = await load({ modules: [mod], meta: META });
		assert.equal(bad.channels.length, 0);
		// Valid config → loads, and the module sees it via moduleConfig.
		let seen: unknown;
		const mod2 = defineModule({
			id: "needs-config",
			configSchema: Type.Object({ token: Type.String() }),
			register: (b) => {
				seen = b.moduleConfig;
				b.channel(fakeChannel("needs-config"));
			},
		});
		const ok = await load({
			modules: [mod2],
			meta: {
				...META,
				config: { extensions: { entries: { "needs-config": { config: { token: "x" } } } } } as unknown as BrigadeConfig,
			},
		});
		assert.equal(ok.channels.length, 1);
		assert.deepEqual(seen, { token: "x" });
	});

	it("a throwing module is skipped, not fatal", async () => {
		const boom = defineModule({
			id: "c",
			register() {
				throw new Error("boom");
			},
		});
		const reg = await load({ modules: [boom, channelMod("d")], meta: META });
		assert.equal(reg.channels.length, 1); // d still loaded despite c throwing
		assert.deepEqual(
			reg.loadedModules.map((m) => m.id),
			["d"],
		);
	});
});

describe("loadModules — user-module discovery", () => {
	it("discovers + loads a module dropped in the extensions dir", async () => {
		const dir = mkdtempSync(join(tmpdir(), "brigade-ext-"));
		try {
			// A plain default-exported module object (no SDK import needed in the fixture).
			writeFileSync(
				join(dir, "mymod.mjs"),
				`export default { id: "usr", register(b) { b.channel({ id: "usr-ch", label: "U", isConfigured: () => true, start: async () => {}, stop: async () => {}, sendText: async () => {} }); } };`,
			);
			const reg = await loadModules({ modules: [], meta: META, extensionsDir: dir });
			assert.deepEqual(
				reg.channels.map((c) => c.id),
				["usr-ch"],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a bundled module id wins over a same-id user module", async () => {
		const dir = mkdtempSync(join(tmpdir(), "brigade-ext-"));
		try {
			writeFileSync(
				join(dir, "dup.mjs"),
				`export default { id: "dup", register(b) { b.channel({ id: "user-version", label: "U", isConfigured: () => true, start: async () => {}, stop: async () => {}, sendText: async () => {} }); } };`,
			);
			const bundled = defineModule({ id: "dup", register: (b) => b.channel(fakeChannel("bundled-version")) });
			const reg = await loadModules({ modules: [bundled], meta: META, extensionsDir: dir });
			assert.deepEqual(
				reg.channels.map((c) => c.id),
				["bundled-version"],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("discoverUserModules — cache semantics", () => {
	it("does NOT negatively cache an absent dir (module created later is still found)", async () => {
		const dir = join(tmpdir(), `brigade-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		// Dir does not exist yet.
		assert.deepEqual(await discoverUserModules(dir), []);
		// Create it + drop a module — must be discovered despite the earlier miss.
		mkdtempOver(dir);
		try {
			writeFileSync(
				join(dir, "m.mjs"),
				`export default { id: "late", register(b) { b.channel({ id: "late-ch", label: "L", isConfigured: () => true, start: async () => {}, stop: async () => {}, sendText: async () => {} }); } };`,
			);
			const found = await discoverUserModules(dir);
			assert.deepEqual(
				found.map((d) => d.module.id),
				["late"],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caches an existing dir; clearDiscoveryCache forces a re-scan", async () => {
		const dir = mkdtempSync(join(tmpdir(), "brigade-cache-"));
		try {
			writeFileSync(join(dir, "a.mjs"), `export default { id: "a", register() {} };`);
			const first = await discoverUserModules(dir);
			assert.equal(first.length, 1);
			// Add a second module — cached result should still be 1 (no re-scan).
			writeFileSync(join(dir, "b.mjs"), `export default { id: "b", register() {} };`);
			const cached = await discoverUserModules(dir);
			assert.equal(cached.length, 1, "cache hit — new file not seen until cleared");
			// Clear → re-scan picks up both.
			clearDiscoveryCache();
			const rescanned = await discoverUserModules(dir);
			assert.equal(rescanned.length, 2);
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * FIX 4 — durable PluginRecord state machine on the live registry. The loader
 * populates a per-module record (discovered → activated/failed) with attributed
 * capability ids, and the CLI diagnosis can overlay it when a live registry is
 * available WITHOUT disturbing the discovery-only path.
 */
describe("loadModules — PluginRecord lifecycle (FIX 4)", () => {
	it("records an activated module with the capability ids it registered", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({
					id: "toolsmith",
					register(b) {
						b.tool(fakeTool("alpha"));
						b.tool(fakeTool("beta"));
						b.channel(fakeChannel("ch-x"));
					},
				}),
			],
			meta: META,
		});
		const rec = reg.pluginRecord("toolsmith");
		assert.ok(rec, "record must exist");
		assert.equal(rec?.status, "activated");
		assert.deepEqual([...(rec?.capabilities.tools ?? [])].sort(), ["alpha", "beta"]);
		assert.deepEqual(rec?.capabilities.channels, ["ch-x"]);
		assert.equal(rec?.failurePhase, undefined);
	});

	it("attributes capabilities to the RIGHT module (per-module diff)", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({ id: "first", register: (b) => b.tool(fakeTool("one")) }),
				defineModule({ id: "second", register: (b) => b.tool(fakeTool("two")) }),
			],
			meta: META,
		});
		assert.deepEqual(reg.pluginRecord("first")?.capabilities.tools, ["one"]);
		assert.deepEqual(reg.pluginRecord("second")?.capabilities.tools, ["two"], "second must not inherit first's tool");
	});

	it("records a failed module with failurePhase=register", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({
					id: "boom",
					register() {
						throw new Error("kaboom");
					},
				}),
			],
			meta: META,
		});
		const rec = reg.pluginRecord("boom");
		assert.equal(rec?.status, "failed");
		assert.equal(rec?.failurePhase, "register");
		// A failed module must NOT be in loadedModules.
		assert.equal(reg.loadedModules.some((m) => m.id === "boom"), false);
	});

	it("pluginRecords() returns every module's record in load order", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({ id: "a", register: () => undefined }),
				defineModule({ id: "b", register: () => undefined }),
			],
			meta: META,
		});
		assert.deepEqual(reg.pluginRecords().map((r) => r.id), ["a", "b"]);
		assert.ok(reg.pluginRecords().every((r) => r.status === "activated"));
	});

	it("the returned record is a copy — mutating it does not corrupt the registry", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "m", register: (b) => b.tool(fakeTool("t")) })],
			meta: META,
		});
		const rec = reg.pluginRecord("m");
		rec?.capabilities.tools.push("INJECTED");
		assert.deepEqual(reg.pluginRecord("m")?.capabilities.tools, ["t"], "registry copy must be untouched");
	});

	it("diagnoseExtensions overlays live status when a registry is passed (and omits it otherwise)", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "live-mod", register: (b) => b.tool(fakeTool("zed")) })],
			meta: META,
		});
		const dir = mkdtempSync(join(tmpdir(), "brigade-diag-"));
		try {
			// With the live registry: the bundled entry carries a `live` overlay.
			const withLive = await diagnoseExtensions(
				[defineModule({ id: "live-mod", register: () => undefined })],
				dir,
				reg,
			);
			const e = withLive.extensions.find((x) => x.id === "live-mod");
			assert.equal(e?.live?.status, "activated");
			assert.ok(e?.live?.capabilities.includes("tools:zed"));

			// Without it: discovery-only path is unchanged — no `live` field.
			const noLive = await diagnoseExtensions(
				[defineModule({ id: "live-mod", register: () => undefined })],
				dir,
			);
			assert.equal(noLive.extensions.find((x) => x.id === "live-mod")?.live, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Create a directory at an exact path (mkdtemp makes a random suffix; we want this path). */
function mkdtempOver(dir: string): void {
	mkdirSync(dir, { recursive: true });
}
