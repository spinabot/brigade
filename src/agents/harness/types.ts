// src/agents/harness/types.ts
//
// The HARNESS layer: making external-loop backends first-class.
//
// Brigade has two kinds of backend:
//
//   LOOP backends (anthropic, openai, ollama, …) — a model endpoint. Pi's loop
//   runs in-process: it dispatches tools, emits tool events, and writes
//   toolCall/toolResult messages into the transcript. Everything downstream
//   (TUI chips, resume, compaction, memory) works because Pi did the work.
//
//   HARNESS backends (claude-cli today; codex-cli / gemini-cli tomorrow) — an
//   external agent BINARY runs its own loop and calls Brigade's tools back in.
//   Pi's loop dispatches nothing, so it emits nothing and persists nothing.
//
// A harness backend is NOT a loop replacement. It sits BENEATH Pi's loop: it
// contributes a `StreamFn` transport plus three out-of-band channels for the
// work Pi can no longer do — serving the tools (guarded), minting the tool
// events, and recording the transcript. Pi's `AgentSession` still owns the turn:
// prompt, retry, steering, compaction, reply extraction are untouched.
//
// This is why we do NOT implement pi-agent-core's own `AgentHarness` class: that
// IS the in-process loop engine (it dispatches tools itself, exposes
// `appendMessage`/`compact`/`skill`). Forcing an out-of-process loop into an
// in-process loop's interface would be a category error — the same mistake as
// modelling a harness as `runAttempt(prompt) => { reply }`, which can express
// none of: which `api` strings the backend owns, how the child learns its
// callback URL, the tool-plane token lifecycle, event minting, transcript
// reconciliation, capability negotiation, or teardown ordering.
//
// So: mirror Pi's CONCEPTS (context ownership, compaction, tools) as capability
// flags; delegate the LOOP to `AgentSession`; stay independent on the transport
// and the three channels, which are inherently out-of-process.

import type { StreamFn } from "@earendil-works/pi-agent-core";

import type { BrigadeBeforeToolCallHook } from "../tool-guard.js";
import type { AnyBrigadeTool } from "../tools/types.js";

/**
 * Everything a harness backend reads off the LIVE turn. Assembled by the
 * agent-loop once the session, guard chain and toolset exist and `runId` /
 * `gateCtxRef` are populated — i.e. immediately before `session.prompt()`.
 */
export interface HarnessTurn {
	agentId: string;
	provider: string;
	modelId: string;
	cwd: string;
	sessionKey: string;
	runId: string;
	/** The wired Pi `AgentSession` — the transcript + context target. Kept opaque
	 *  so this layer never couples to a Pi version's exported type. */
	session: unknown;
	/**
	 * The EFFECTIVE owner flag — already demoted by the poisoned-inbox check. It
	 * is the same signal the in-process tool registry gates on, so a harness can
	 * never expose a broader surface than a normal turn would.
	 */
	senderIsOwner: boolean;
	/** Already ownerOnly-wrapped, origin-bound and timeout-wrapped for THIS turn. */
	customTools: AnyBrigadeTool[];
	/** Pi normally constructs these from names inside its loop; a harness backend
	 *  that declares `needsBuiltinsServed` must build and serve guarded equivalents. */
	builtinToolNames: string[];
	/** The turn's composed `beforeToolCall` chain (closes over its `gateCtxRef`). */
	guard?: BrigadeBeforeToolCallHook;
	signal?: AbortSignal;
}

/**
 * One turn's installation. Every method is a no-op when the backend installed
 * nothing (fail-open), so the agent-loop can call them unconditionally.
 */
export interface HarnessTurnHandle {
	/**
	 * Stamp the per-dispatch Pi `context` so the transport learns what this turn
	 * is allowed to do (owner flag, tool-plane callback URL). Fires on EVERY
	 * dispatch of this backend's api — including retries.
	 */
	stampContext(context: unknown): void;
	/**
	 * Reconcile anything the harness produced out-of-band into the in-memory
	 * session. Idempotent: it drains what it merged, so it is safe to call again
	 * (the max_tokens continuation flushes before re-prompting).
	 */
	afterTurn(): void;
	/**
	 * Did this backend execute tools out-of-band during the turn?
	 *
	 * Brigade's content-quality gate infers "the model never acted" from the
	 * absence of `toolCall` blocks on the assistant message. For a harness backend
	 * those blocks can never be present, so that inference is always wrong — and a
	 * recovery re-prompt would respawn the binary and re-run every side effect. The
	 * gate consults this instead.
	 */
	hadToolActivity(): boolean;
	/** Idempotent teardown (tool-plane token). Called from the loop's `finally`. */
	dispose(): void;
}

/** The handle every LOOP-backend turn gets: nothing installed, nothing to undo. */
export const NOOP_HARNESS_HANDLE: HarnessTurnHandle = Object.freeze({
	stampContext(): void {},
	afterTurn(): void {},
	hadToolActivity(): boolean {
		return false;
	},
	dispose(): void {},
});

/**
 * What a harness backend declares about itself. These flags exist so a future
 * backend is a drop-in rather than another round of surgery on the agent-loop.
 */
export interface HarnessCapabilities {
	/** The external binary runs the agent loop, so Brigade must serve tools
	 *  out-of-band, mint the tool events, and reconcile the transcript. */
	servesOwnLoop: boolean;
	/**
	 * The backend owns its own context window (e.g. it binds a persistent
	 * `--resume` session). When true the agent-loop must NOT run its own
	 * compaction. False for claude-cli, which is stateless per turn: Brigade
	 * replays the whole transcript on every spawn.
	 */
	managesOwnContext: boolean;
	/** Pi's builtins (read/write/edit/bash/grep/ls) reach the toolset only as
	 *  NAMES, and Pi's loop is what turns them into callable objects. A backend
	 *  whose binary runs the loop must have guarded equivalents constructed and
	 *  served, or it has no filesystem or shell at all. */
	needsBuiltinsServed: boolean;
}

/**
 * A HARNESS backend. Implement this and a new external agent binary becomes a
 * single module — no agent-loop edit.
 */
export interface HarnessBackend {
	id: string;
	label: string;
	/** Higher wins when more than one backend claims a turn. Built-ins are 0. */
	priority: number;

	/* ── transport ─────────────────────────────────────────────────────────── */
	/** The Pi `api` strings this backend owns. */
	readonly apis: readonly string[];
	/** Does this backend drive the given turn? */
	owns(ctx: { provider: string; api?: string; modelId?: string }): boolean;
	/** The transport. Backends memoize; the fn must be stateless per call. */
	createStreamFn(): StreamFn;
	/** Idempotently (re)assert the api registration. Must self-heal after Pi's
	 *  `resetApiProviders()`, and must be safe to call on every dispatch. */
	ensureRegistered(): void;

	/* ── auth ──────────────────────────────────────────────────────────────── */
	/**
	 * Some harness binaries authenticate themselves (their own stored login), but
	 * Pi still refuses to dispatch a provider with no credential. A backend may
	 * seed a NON-SECRET sentinel that never goes on the wire.
	 */
	readonly authSentinel?: { provider: string; credential: unknown };

	/* ── capabilities ──────────────────────────────────────────────────────── */
	readonly capabilities: HarnessCapabilities;

	/* ── per-turn ──────────────────────────────────────────────────────────── */
	/** Install for one turn. MUST fail open: on any missing precondition return
	 *  `NOOP_HARNESS_HANDLE` rather than throwing — a harness can only ADD. */
	installTurn(turn: HarnessTurn): HarnessTurnHandle;
}
