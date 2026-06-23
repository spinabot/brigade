/**
 * Loader-layer tests: activation traceability + skip-reason structured logs.
 *
 * The loader's job here is to surface a stable, structured log line for every
 * module decision so an operator can answer "why didn't my plugin load" from
 * the JSONL log alone. We flip the subsystem logger's console mirror on,
 * capture stderr, and assert the expected `id=`/`reason=`/`cause=` tokens.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Type } from "typebox";
import { Check } from "typebox/value";

import type { BrigadeConfig } from "../../config/io.js";
import { BrigadeConfigSchema, collectBrigadeConfigErrors } from "../../core/brigade-config.js";
import { setConsoleLogging, setLogLevel } from "../../logging/subsystem-logger.js";
import { clearDiscoveryCache } from "./discovery.js";
import { loadModules } from "./loader.js";
import { BrigadeExtensionRegistry } from "./registry.js";
import { defineModule } from "./types.js";

const META = { agentId: "main", workspaceDir: "/ws", cwd: "/cwd", config: {} as BrigadeConfig };

const noopRegister = () => undefined;

/** Capture stderr while a block runs; restore the original writer afterwards. */
function captureStderr(): { chunks: string[]; restore: () => void } {
	const chunks: string[] = [];
	const orig = process.stderr.write.bind(process.stderr);
	(process.stderr.write as unknown as (s: string | Uint8Array) => boolean) = (s) => {
		chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
		return true;
	};
	return {
		chunks,
		restore: () => {
			process.stderr.write = orig;
		},
	};
}

describe("loadModules — activation traceability", () => {
	let cap: { chunks: string[]; restore: () => void };

	beforeEach(() => {
		// Force the subsystem logger to mirror to stderr regardless of TTY state
		// so the test can observe the structured lines without depending on the
		// runner's terminal kind.
		setConsoleLogging(true);
		// Per-module activation/skip traces live at debug now (they flooded info
		// for every CLI command). Raise the level so these traceability tests can
		// still observe them; restored to info in afterEach.
		setLogLevel("debug");
		cap = captureStderr();
	});

	afterEach(() => {
		cap.restore();
		setConsoleLogging(false);
		setLogLevel("info");
	});

	it("emits 'extension activated' for a module that loads cleanly", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "ok", register: noopRegister })],
			meta: META,
		});
		assert.equal(reg.loadedModules.length, 1);
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension activated/);
		assert.match(out, /id=ok/);
		assert.match(out, /origin=bundled/);
	});

	it("emits skip log with reason=disabled when extensions.disabled[] hits", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "x", register: noopRegister })],
			meta: { ...META, config: { extensions: { disabled: ["x"] } } as unknown as BrigadeConfig },
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=x/);
		assert.match(out, /reason=disabled/);
	});

	it("emits skip log with reason=allowlist when extensions.allow excludes the id", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "blocked", register: noopRegister })],
			meta: { ...META, config: { extensions: { allow: ["other"] } } as unknown as BrigadeConfig },
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=blocked/);
		assert.match(out, /reason=allowlist/);
		assert.match(out, /extensions\.allow does not include this id/);
	});

	it("emits skip log with reason=requiresEnv when an env var is missing", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "envy", requiresEnv: ["NOPE_BRIGADE_XYZ"], register: noopRegister })],
			meta: META,
			env: {},
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=envy/);
		assert.match(out, /reason=requiresEnv/);
		assert.match(out, /NOPE_BRIGADE_XYZ/);
	});

	it("emits skip log with reason=eligible when eligible() returns false", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "elig", eligible: () => false, register: noopRegister })],
			meta: META,
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=elig/);
		assert.match(out, /reason=eligible/);
	});

	it("emits skip log with reason=configSchema when config fails validation", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({
					id: "needs-token",
					configSchema: Type.Object({ token: Type.String() }),
					register: noopRegister,
				}),
			],
			meta: META,
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=needs-token/);
		assert.match(out, /reason=configSchema/);
	});

	it("emits skip log with reason=registerFailed when register() throws", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({
					id: "boom",
					register() {
						throw new Error("nope");
					},
				}),
			],
			meta: META,
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension register failed/);
		assert.match(out, /id=boom/);
		assert.match(out, /reason=registerFailed/);
		assert.match(out, /nope/);
	});
});

describe("loadModules — enabledByDefault opt-out (FIX 2)", () => {
	it("does NOT auto-activate a bundled module whose manifest sets enabledByDefault:false", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({
					id: "optout",
					manifest: { id: "optout", enabledByDefault: false },
					register: noopRegister,
				}),
			],
			meta: META,
		});
		assert.equal(
			reg.loadedModules.some((m) => m.id === "optout"),
			false,
			"enabledByDefault:false module must not load by default",
		);
	});

	it("still auto-activates a module with enabledByDefault:true (and one with the field absent)", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({ id: "on", manifest: { id: "on", enabledByDefault: true }, register: noopRegister }),
				defineModule({ id: "plain", register: noopRegister }),
			],
			meta: META,
		});
		assert.equal(reg.loadedModules.some((m) => m.id === "on"), true);
		assert.equal(reg.loadedModules.some((m) => m.id === "plain"), true);
	});

	it("activates an enabledByDefault:false module when entries[id].enabled=true overrides it", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({
					id: "optout",
					manifest: { id: "optout", enabledByDefault: false },
					register: noopRegister,
				}),
			],
			meta: {
				...META,
				config: { extensions: { entries: { optout: { enabled: true } } } } as unknown as BrigadeConfig,
			},
		});
		assert.equal(
			reg.loadedModules.some((m) => m.id === "optout"),
			true,
			"explicit entries[id].enabled=true must override the opt-out",
		);
	});

	it("activates an enabledByDefault:false module when it is named in extensions.allow", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({
					id: "optout",
					manifest: { id: "optout", enabledByDefault: false },
					register: noopRegister,
				}),
			],
			meta: { ...META, config: { extensions: { allow: ["optout"] } } as unknown as BrigadeConfig },
		});
		assert.equal(reg.loadedModules.some((m) => m.id === "optout"), true);
	});

	it("emits skip log with reason=enabledByDefault for the opt-out", async () => {
		setConsoleLogging(true);
		setLogLevel("debug");
		const cap = captureStderr();
		try {
			await loadModules({
				noDiscovery: true,
				modules: [
					defineModule({
						id: "optout",
						manifest: { id: "optout", enabledByDefault: false },
						register: noopRegister,
					}),
				],
				meta: META,
			});
		} finally {
			cap.restore();
			setConsoleLogging(false);
			setLogLevel("info");
		}
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=optout/);
		assert.match(out, /reason=enabledByDefault/);
	});
});

describe("loadModules — bundled-vs-user origin tracking", () => {
	it("marks a bundled module's activation log with origin=bundled", async () => {
		setConsoleLogging(true);
		setLogLevel("debug");
		const cap = captureStderr();
		try {
			await loadModules({
				noDiscovery: true,
				modules: [defineModule({ id: "bun", register: noopRegister })],
				meta: META,
			});
		} finally {
			cap.restore();
			setConsoleLogging(false);
			setLogLevel("info");
		}
		const out = cap.chunks.join("");
		assert.match(out, /id=bun/);
		assert.match(out, /origin=bundled/);
	});
});

describe("brigade-config.extensions.slots schema", () => {
	it("accepts a config with extensions.slots.memory set to a string", () => {
		const cfg = {
			version: 2,
			extensions: { slots: { memory: "lancedb" } },
		};
		assert.equal(Check(BrigadeConfigSchema, cfg), true);
		assert.deepEqual(collectBrigadeConfigErrors(cfg), []);
	});

	it("accepts every named slot (memory/contextEngine/compaction/agentHarness)", () => {
		const cfg = {
			version: 2,
			extensions: {
				slots: {
					memory: "lancedb",
					contextEngine: "semantic-window",
					compaction: "llm-summary",
					agentHarness: "codex",
				},
			},
		};
		assert.equal(Check(BrigadeConfigSchema, cfg), true);
	});

	it("rejects an unknown slot key (additionalProperties=false)", () => {
		const cfg = {
			version: 2,
			extensions: { slots: { madeUp: "x" } },
		};
		assert.equal(Check(BrigadeConfigSchema, cfg), false);
	});

	it("resolveSlot picks the capability whose id matches extensions.slots.<name>", () => {
		const reg = new BrigadeExtensionRegistry();
		const cfg = {
			version: 2,
			extensions: { slots: { memory: "wanted" } },
		} as unknown as BrigadeConfig;
		const candidates = [
			{ id: "other", label: "Other" },
			{ id: "wanted", label: "Wanted" },
		];
		const picked = reg.resolveSlot("memory", cfg, candidates);
		assert.equal(picked?.id, "wanted");
	});

	it("resolveSlot returns undefined when the slot is unset (built-in path)", () => {
		const reg = new BrigadeExtensionRegistry();
		const cfg = { version: 2 } as unknown as BrigadeConfig;
		const picked = reg.resolveSlot("memory", cfg, [{ id: "x", label: "X" }]);
		assert.equal(picked, undefined);
	});
});

/**
 * Step 5 — manifest-driven lazy activation. The headline proof: a user module
 * whose sidecar `brigade.extension.json` declares an activation trigger that does
 * NOT match the active config is SKIPPED and is NOT imported — its top-level
 * (which writes a marker file) must never run.
 */
describe("loadModules — manifest-driven lazy activation", () => {
	// A user module whose TOP-LEVEL writes a marker file the moment it's
	// imported. The marker path is baked into the source so we can assert
	// (non-)existence regardless of whether the body ran. Forward-slash the path
	// so it's a valid string literal on Windows too.
	function moduleSrcWritingMarker(markerPath: string, id: string): string {
		const lit = JSON.stringify(markerPath);
		return `import { writeFileSync } from "node:fs";
writeFileSync(${lit}, "imported");
export default { id: ${JSON.stringify(id)}, register() {} };`;
	}

	function withDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
		return async () => {
			clearDiscoveryCache();
			const dir = mkdtempSync(join(tmpdir(), "brigade-lazy-"));
			try {
				await fn(dir);
			} finally {
				clearDiscoveryCache();
				rmSync(dir, { recursive: true, force: true });
			}
		};
	}

	it(
		"a non-matching sidecar trigger SKIPS the module WITHOUT importing it (marker never written)",
		withDir(async (dir) => {
			const marker = join(dir, "ran.marker").replace(/\\/g, "/");
			writeFileSync(join(dir, "slacky.mjs"), moduleSrcWritingMarker(marker, "slacky"));
			// Sidecar declares onChannels:["slack"] but no slack channel is configured.
			writeFileSync(
				join(dir, "slacky.brigade.extension.json"),
				JSON.stringify({ id: "slacky", activation: { onChannels: ["slack"] } }),
			);

			const reg = await loadModules({
				modules: [],
				extensionsDir: dir,
				meta: { ...META, config: { channels: { telegram: { enabled: true } } } as unknown as BrigadeConfig },
			});

			assert.equal(
				existsSync(marker),
				false,
				"module top-level must NOT have run — it was never imported",
			);
			assert.equal(
				reg.loadedModules.some((m) => m.id === "slacky"),
				false,
				"non-triggered module must not be registered",
			);
		}),
	);

	it(
		"a matching sidecar trigger ACTIVATES the module (marker written, module registered)",
		withDir(async (dir) => {
			const marker = join(dir, "ran.marker").replace(/\\/g, "/");
			writeFileSync(join(dir, "slacky.mjs"), moduleSrcWritingMarker(marker, "slacky"));
			writeFileSync(
				join(dir, "slacky.brigade.extension.json"),
				JSON.stringify({ id: "slacky", activation: { onChannels: ["slack"] } }),
			);

			const reg = await loadModules({
				modules: [],
				extensionsDir: dir,
				meta: { ...META, config: { channels: { slack: { enabled: true } } } as unknown as BrigadeConfig },
			});

			assert.equal(existsSync(marker), true, "matching module must have been imported (top-level ran)");
			assert.equal(
				reg.loadedModules.some((m) => m.id === "slacky"),
				true,
				"matching module must be registered",
			);
		}),
	);

	it(
		"a manifest-less module still ACTIVATES (back-compat — imported + registered)",
		withDir(async (dir) => {
			const marker = join(dir, "ran.marker").replace(/\\/g, "/");
			writeFileSync(join(dir, "plain.mjs"), moduleSrcWritingMarker(marker, "plain"));
			// No sidecar, no body manifest → always-on.

			const reg = await loadModules({
				modules: [],
				extensionsDir: dir,
				meta: META,
			});

			assert.equal(existsSync(marker), true, "manifest-less module must still be imported");
			assert.equal(
				reg.loadedModules.some((m) => m.id === "plain"),
				true,
				"manifest-less module must still register",
			);
		}),
	);

	it(
		"the sidecar manifest is honored WITHOUT importing the body (non-trigger ⇒ body never read)",
		withDir(async (dir) => {
			// The body, if imported, throws at top-level — proving the loader never
			// touched it. The sidecar's non-matching trigger gates it out first.
			const marker = join(dir, "exploded.marker").replace(/\\/g, "/");
			writeFileSync(
				join(dir, "bomb.mjs"),
				`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "boom");
throw new Error("body should never be imported");
export default { id: "bomb", register() {} };`,
			);
			writeFileSync(
				join(dir, "bomb.brigade.extension.json"),
				JSON.stringify({ id: "bomb", activation: { onProviders: ["openai"] } }),
			);

			const reg = await loadModules({
				modules: [],
				extensionsDir: dir,
				meta: { ...META, config: { agents: { defaults: { provider: "anthropic" } } } as unknown as BrigadeConfig },
			});

			assert.equal(existsSync(marker), false, "body must never have been imported (sidecar gated it)");
			assert.equal(reg.loadedModules.some((m) => m.id === "bomb"), false);
		}),
	);

	it(
		"emits a skip log with reason=activation-not-triggered for a gated module",
		withDir(async (dir) => {
			writeFileSync(join(dir, "gated.mjs"), `export default { id: "gated", register() {} };`);
			writeFileSync(
				join(dir, "gated.brigade.extension.json"),
				JSON.stringify({ id: "gated", activation: { onChannels: ["discord"] } }),
			);

			setConsoleLogging(true);
			setLogLevel("debug");
			const cap = captureStderr();
			try {
				await loadModules({
					modules: [],
					extensionsDir: dir,
					meta: { ...META, config: {} as BrigadeConfig },
				});
			} finally {
				cap.restore();
				setConsoleLogging(false);
				setLogLevel("info");
			}
			const out = cap.chunks.join("");
			assert.match(out, /extension skipped/);
			assert.match(out, /id=gated/);
			assert.match(out, /reason=activation-not-triggered/);
		}),
	);

	it(
		"a body-carried manifest (no sidecar) still gates registration when its trigger misses",
		withDir(async (dir) => {
			// No sidecar → the body IS imported (to read its manifest), but the
			// non-matching activation trigger keeps it OUT of the registry.
			writeFileSync(
				join(dir, "bodyman.mjs"),
				`export default {
					id: "bodyman",
					manifest: { id: "bodyman", activation: { onChannels: ["slack"] } },
					register() {},
				};`,
			);

			const reg = await loadModules({
				modules: [],
				extensionsDir: dir,
				meta: { ...META, config: { channels: { telegram: {} } } as unknown as BrigadeConfig },
			});

			assert.equal(
				reg.loadedModules.some((m) => m.id === "bodyman"),
				false,
				"body-manifest module whose trigger misses must not register",
			);
		}),
	);
});
