// Register the claude-cli transport into Pi's API-provider registry so a model
// with `api: "claude-cli"` dispatches to the subprocess stream fn — exactly
// like the native Ollama transport (`ollama-native/register.ts`). Also exposes
// a synthesizer that resolves a `claude-cli/<model>` ref to a Pi `Model`
// object (no models.json write needed; the never-miss resolver calls it).

import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import {
	CLAUDE_CLI_API,
	CLAUDE_CLI_DEFAULT_MODEL,
	CLAUDE_CLI_MODELS,
	CLAUDE_CLI_PROVIDER,
	stripClaudeCliPrefix,
} from "./catalog.js";
import { createClaudeCliStreamFn } from "./stream.js";

const REGISTRY_SOURCE_ID = "brigade-claude-cli";

/**
 * Idempotently register the claude-cli transport for `api: "claude-cli"`.
 * Guards on the LIVE registry (`getApiProvider`) rather than a sticky flag, so
 * it self-heals after Pi's `resetApiProviders()` (fired by `ModelRegistry
 * .refresh()`, `AgentSession.reload()`, and register/unregisterProvider). Safe
 * to call at boot, per turn, and before any isolated claude-cli session.
 * Returns true when it actually registered (was absent), false when already up.
 */
export function ensureClaudeCliApiRegistered(): boolean {
	if (getApiProvider(CLAUDE_CLI_API)) return false;
	const streamFn: StreamFn = createClaudeCliStreamFn();
	registerApiProvider(
		{
			api: CLAUDE_CLI_API,
			// One transport serves both surfaces (the CLI has no separate simple-
			// completion path). Cast: the registry's generic stream types are
			// stricter than our loose StreamFn.
			stream: streamFn as never,
			streamSimple: streamFn as never,
		},
		REGISTRY_SOURCE_ID,
	);
	return true;
}

/** Loose Pi `Model` shape — we synthesize rather than construct from a class. */
export type SynthClaudeCliModel = Record<string, unknown> & {
	provider: string;
	id: string;
	api: string;
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * Synthesize a Pi `Model` for a `claude-cli` model id. A catalogued snapshot
 * uses its declared metadata; an unknown id (a newer release the operator
 * names explicitly) synthesizes a sensible default so a turn is never blocked
 * on "model not registered" — the CLI validates the concrete id at spawn time.
 * Cost is zero (a subscription turn draws no per-token charge).
 */
export function synthClaudeCliModel(modelId: string): SynthClaudeCliModel {
	const id = stripClaudeCliPrefix(modelId) || CLAUDE_CLI_DEFAULT_MODEL;
	const known = CLAUDE_CLI_MODELS.find((m) => m.id.toLowerCase() === id.toLowerCase());
	return {
		provider: CLAUDE_CLI_PROVIDER,
		id,
		name: known?.name ?? `${id} (subscription)`,
		api: CLAUDE_CLI_API,
		// No baseUrl — the transport is a subprocess, not an HTTP endpoint.
		reasoning: known?.reasoning ?? /opus|sonnet/i.test(id),
		input: ["text"] as ("text" | "image")[],
		cost: { ...ZERO_COST },
		contextWindow: known?.contextWindow ?? 200_000,
		maxTokens: known?.maxTokens ?? 32_000,
	};
}

/** True when a provider id routes to the claude-cli backend. */
export function isClaudeCliProvider(provider: string | undefined): boolean {
	return (provider ?? "").trim().toLowerCase() === CLAUDE_CLI_PROVIDER;
}

/**
 * The catalogued claude-cli models as Pi `Model` objects, for merging into the
 * gateway's `/model` list so the backend is selectable. Callers should gate on
 * `isClaudeCliAvailable()` first — advertise it only when the binary exists.
 */
export function listClaudeCliModels(): SynthClaudeCliModel[] {
	return CLAUDE_CLI_MODELS.map((m) => synthClaudeCliModel(m.id));
}
