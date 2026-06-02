/**
 * Per-agent provider/model resolution tests for the cron isolated-agent executor.
 *
 * Multi-agent cron installs expect each cron's `agentId` to pick that agent's
 * provider + model, not the workspace defaults. Without this every fire
 * would run under the boot agent's model regardless of who scheduled it.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import {
	resolveAgentModel,
	resolveAgentProvider,
} from "./run-executor.js";

describe("resolveAgentProvider", () => {
	it("falls back to 'anthropic' when no overrides are set", () => {
		const cfg = {} as BrigadeConfig;
		assert.equal(resolveAgentProvider(cfg, "main"), "anthropic");
	});

	it("returns agents.defaults.provider when no per-agent override exists", () => {
		const cfg = {
			agents: { defaults: { provider: "google" } },
		} as unknown as BrigadeConfig;
		assert.equal(resolveAgentProvider(cfg, "main"), "google");
		assert.equal(resolveAgentProvider(cfg, "ops"), "google");
	});

	it("per-agent provider override wins over defaults", () => {
		const cfg = {
			agents: {
				defaults: { provider: "anthropic" },
				ops: { provider: "google" },
			},
		} as unknown as BrigadeConfig;
		assert.equal(resolveAgentProvider(cfg, "ops"), "google");
		assert.equal(resolveAgentProvider(cfg, "main"), "anthropic");
	});

	it("ignores non-string overrides", () => {
		const cfg = {
			agents: {
				defaults: { provider: "google" },
				ops: { provider: 42 },
			},
		} as unknown as BrigadeConfig;
		assert.equal(resolveAgentProvider(cfg, "ops"), "google");
	});
});

describe("resolveAgentModel", () => {
	it("falls back to 'claude-opus-4-7' when no overrides are set", () => {
		const cfg = {} as BrigadeConfig;
		assert.equal(resolveAgentModel(cfg, "main"), "claude-opus-4-7");
	});

	it("returns agents.defaults.model.primary when no per-agent override exists", () => {
		const cfg = {
			agents: { defaults: { model: { primary: "gemini-2.5-pro" } } },
		} as unknown as BrigadeConfig;
		assert.equal(resolveAgentModel(cfg, "ops"), "gemini-2.5-pro");
	});

	it("per-agent model override wins over defaults", () => {
		const cfg = {
			agents: {
				defaults: { model: { primary: "claude-opus-4-7" } },
				ops: { model: { primary: "gemini-2.5-pro" } },
			},
		} as unknown as BrigadeConfig;
		assert.equal(resolveAgentModel(cfg, "ops"), "gemini-2.5-pro");
		assert.equal(resolveAgentModel(cfg, "main"), "claude-opus-4-7");
	});

	it("ignores empty / non-string overrides", () => {
		const cfg = {
			agents: {
				defaults: { model: { primary: "claude-opus-4-7" } },
				ops: { model: { primary: "" } },
			},
		} as unknown as BrigadeConfig;
		assert.equal(resolveAgentModel(cfg, "ops"), "claude-opus-4-7");
	});
});
