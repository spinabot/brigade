/**
 * Activation-planner tests (plugin SDK Step 5: manifest-driven lazy activation).
 *
 * Covers the pure planner + snapshot builder: back-compat always-activate, the
 * OR-across-triggers match semantics, the empty-array "no constraint" rule, and
 * the config → snapshot derivation (channels enabled/disabled, active provider,
 * pinned capability slots).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import {
	type ActivationSnapshot,
	BUILTIN_CHANNEL_COMMAND_NAMES,
	buildActivationSnapshot,
	planActivation,
} from "./activation-planner.js";
import type { BrigadeModuleManifest } from "./types.js";

const EMPTY_SNAPSHOT: ActivationSnapshot = {
	channels: new Set(),
	providers: new Set(),
	commands: new Set(),
	capabilities: new Set(),
};

function snap(over: Partial<{ channels: string[]; providers: string[]; commands: string[]; capabilities: string[] }>): ActivationSnapshot {
	return {
		channels: new Set(over.channels ?? []),
		providers: new Set(over.providers ?? []),
		commands: new Set(over.commands ?? []),
		capabilities: new Set(over.capabilities ?? []),
	};
}

function manifest(activation?: BrigadeModuleManifest["activation"]): BrigadeModuleManifest {
	return { id: "m", activation };
}

describe("planActivation — back-compat (always activate)", () => {
	it("activates when manifest is undefined", () => {
		const d = planActivation(undefined, EMPTY_SNAPSHOT);
		assert.equal(d.activate, true);
		assert.equal(d.reason, undefined);
	});

	it("activates when the manifest has no activation block", () => {
		assert.equal(planActivation(manifest(undefined), EMPTY_SNAPSHOT).activate, true);
	});

	it("activates when activation declares only empty trigger arrays (no constraint)", () => {
		const d = planActivation(manifest({ onChannels: [], onProviders: [] }), EMPTY_SNAPSHOT);
		assert.equal(d.activate, true);
	});
});

describe("planActivation — trigger matching", () => {
	it("activates when an onChannels trigger matches a configured channel", () => {
		const d = planActivation(manifest({ onChannels: ["slack"] }), snap({ channels: ["slack"] }));
		assert.equal(d.activate, true);
	});

	it("skips (with a reason) when an onChannels trigger does NOT match", () => {
		const d = planActivation(manifest({ onChannels: ["slack"] }), snap({ channels: ["whatsapp"] }));
		assert.equal(d.activate, false);
		assert.match(d.reason ?? "", /no activation trigger matched/);
		assert.match(d.reason ?? "", /onChannels=\[slack\]/);
	});

	it("matches case-insensitively", () => {
		const d = planActivation(manifest({ onChannels: ["SLACK"] }), snap({ channels: ["slack"] }));
		assert.equal(d.activate, true);
	});

	it("activates on ANY matching trigger kind (OR across kinds)", () => {
		// onChannels misses, onProviders hits → still activate.
		const d = planActivation(
			manifest({ onChannels: ["slack"], onProviders: ["openai"] }),
			snap({ providers: ["openai"] }),
		);
		assert.equal(d.activate, true);
	});

	it("skips only when EVERY declared trigger misses", () => {
		const d = planActivation(
			manifest({ onChannels: ["slack"], onProviders: ["openai"] }),
			snap({ channels: ["whatsapp"], providers: ["anthropic"] }),
		);
		assert.equal(d.activate, false);
	});

	it("activates on an onCapabilities slot match", () => {
		const d = planActivation(
			manifest({ onCapabilities: ["lancedb"] }),
			snap({ capabilities: ["lancedb"] }),
		);
		assert.equal(d.activate, true);
	});

	it("activates a command-only-gated module when its command is available", () => {
		// A module gated ONLY on onCommands:["foo"] activates iff `foo` is in the
		// snapshot's command set — proving the previously-dormant trigger fires.
		const d = planActivation(manifest({ onCommands: ["foo"] }), snap({ commands: ["foo"] }));
		assert.equal(d.activate, true);
		assert.equal(d.reason, undefined);
	});

	it("skips a command-only-gated module when its command is NOT available", () => {
		const d = planActivation(manifest({ onCommands: ["foo"] }), snap({ commands: ["bar"] }));
		assert.equal(d.activate, false);
		assert.match(d.reason ?? "", /onCommands=\[foo\]/);
	});

	it("matches onCommands case-insensitively", () => {
		const d = planActivation(manifest({ onCommands: ["FOO"] }), snap({ commands: ["foo"] }));
		assert.equal(d.activate, true);
	});

	it("an empty trigger array does not block a non-empty matching one", () => {
		const d = planActivation(
			manifest({ onChannels: [], onProviders: ["anthropic"] }),
			snap({ providers: ["anthropic"] }),
		);
		assert.equal(d.activate, true);
	});
});

describe("buildActivationSnapshot", () => {
	it("collects configured + enabled channels, dropping enabled:false", () => {
		const cfg = {
			channels: {
				telegram: { enabled: true },
				whatsapp: {},
				slack: { enabled: false },
			},
		} as unknown as BrigadeConfig;
		const s = buildActivationSnapshot(cfg);
		assert.equal(s.channels.has("telegram"), true);
		assert.equal(s.channels.has("whatsapp"), true, "absent enabled flag counts as on");
		assert.equal(s.channels.has("slack"), false, "enabled:false is excluded");
	});

	it("collects the active model provider from agents.defaults.provider", () => {
		const cfg = { agents: { defaults: { provider: "Anthropic" } } } as unknown as BrigadeConfig;
		const s = buildActivationSnapshot(cfg);
		assert.equal(s.providers.has("anthropic"), true, "provider lowercased into the set");
	});

	it("collects pinned capability slots from extensions.slots", () => {
		const cfg = {
			extensions: { slots: { memory: "lancedb", agentHarness: "codex" } },
		} as unknown as BrigadeConfig;
		const s = buildActivationSnapshot(cfg);
		assert.equal(s.capabilities.has("lancedb"), true);
		assert.equal(s.capabilities.has("codex"), true);
	});

	it("returns empty sets for a bare config (no channels/providers/slots)", () => {
		const s = buildActivationSnapshot({} as BrigadeConfig);
		assert.equal(s.channels.size, 0);
		assert.equal(s.providers.size, 0);
		assert.equal(s.capabilities.size, 0);
		assert.equal(s.commands.size, 0, "no channel configured ⇒ no built-in commands available");
	});

	it("populates the built-in channel commands once a channel is configured", () => {
		const cfg = { channels: { telegram: { enabled: true } } } as unknown as BrigadeConfig;
		const s = buildActivationSnapshot(cfg);
		for (const name of BUILTIN_CHANNEL_COMMAND_NAMES) {
			assert.equal(s.commands.has(name), true, `built-in command "${name}" should be available`);
		}
	});

	it("does NOT populate built-in commands when no channel is configured", () => {
		const cfg = { agents: { defaults: { provider: "anthropic" } } } as unknown as BrigadeConfig;
		const s = buildActivationSnapshot(cfg);
		assert.equal(s.commands.has("help"), false);
	});

	it("folds caller-supplied availableCommands into the command set (lowercased)", () => {
		const s = buildActivationSnapshot({} as BrigadeConfig, ["Weather", "  ", "deploy"]);
		assert.equal(s.commands.has("weather"), true);
		assert.equal(s.commands.has("deploy"), true);
		assert.equal(s.commands.has(""), false, "blank entries dropped");
	});

	it("a command-only-gated module activates end-to-end against a built-up snapshot", () => {
		// Wire the two halves together: a configured channel makes /help available,
		// so a module gated only on onCommands:["help"] activates; one gated on an
		// unknown command does not.
		const cfg = { channels: { whatsapp: {} } } as unknown as BrigadeConfig;
		const s = buildActivationSnapshot(cfg);
		assert.equal(planActivation({ id: "m", activation: { onCommands: ["help"] } }, s).activate, true);
		assert.equal(planActivation({ id: "m", activation: { onCommands: ["nope"] } }, s).activate, false);
	});
});
