// src/agents/claude-cli/harness-backend.ts
//
// The claude-cli HARNESS backend: the first implementation of `HarnessBackend`.
//
// Everything claude-cli-specific that used to be inlined in the agent-loop lives
// here — the tool-plane registration + token lifecycle, the guarded builtins,
// the per-dispatch context stamp, and the transcript reconciliation. The
// agent-loop keeps one opaque handle instead of four locals and a 30-line block.
//
// SCOPE. This backend is the ONLY thing that behaves differently. A turn on any
// other provider never reaches `installTurn` (see `owns`), and the loop hands it
// a frozen no-op handle, so loop backends (anthropic/openai/ollama) are
// byte-identical to before.
//
// FAIL-OPEN. Every precondition that isn't met yields a handle that still stamps
// the context (so the memory-only stdio plane keeps working) but registers no
// tool-plane. A harness can only ADD capability; it can never break a turn.

import type { StreamFn } from "@earendil-works/pi-agent-core";

import {
	mergeHarnessRecordsIntoSession,
	recordHarnessToolCall,
	type HarnessRecordBatch,
	type HarnessToolRecord,
} from "../harness-transcript.js";
import {
	NOOP_HARNESS_HANDLE,
	type HarnessBackend,
	type HarnessTurn,
	type HarnessTurnHandle,
} from "../harness/types.js";
import { createGuardedBuiltinTools } from "../mcp/builtin-tools.js";
import { getActiveMcpToolPlaneHost } from "../mcp/tool-plane-host.js";
import { CLAUDE_CLI_API, CLAUDE_CLI_PROVIDER, CLAUDE_CLI_SENTINEL_KEY } from "./catalog.js";
import { ensureClaudeCliApiRegistered } from "./register.js";
import { createClaudeCliStreamFn } from "./stream.js";
import { stampClaudeCliToolPlane } from "./tool-plane.js";

let memoizedStreamFn: StreamFn | undefined;

export const claudeCliHarnessBackend: HarnessBackend = {
	id: "claude-cli",
	label: "Claude Code (subscription binary)",
	priority: 0, // built-in default; a plugin must out-prioritize or be pinned

	apis: [CLAUDE_CLI_API],

	owns(ctx: { provider: string; api?: string }): boolean {
		return ctx.provider === CLAUDE_CLI_PROVIDER || ctx.api === CLAUDE_CLI_API;
	},

	createStreamFn(): StreamFn {
		memoizedStreamFn ??= createClaudeCliStreamFn();
		return memoizedStreamFn;
	},

	ensureRegistered(): void {
		ensureClaudeCliApiRegistered();
	},

	// The `claude` binary authenticates with its OWN stored login, but Pi refuses
	// to dispatch a provider with no credential. Non-secret; never sent on the wire.
	authSentinel: { provider: CLAUDE_CLI_PROVIDER, credential: { type: "api_key", key: CLAUDE_CLI_SENTINEL_KEY } },

	capabilities: {
		// The binary runs the loop, so Brigade serves tools out-of-band, mints the
		// tool events, and reconciles the transcript afterwards.
		servesOwnLoop: true,
		// Stateless per turn: Brigade replays the whole transcript into each spawn,
		// so Brigade's own compaction stays in charge. A future backend that binds a
		// persistent `--resume` session would flip this and own its context window.
		managesOwnContext: false,
		// Pi's read/write/edit/bash/grep/ls arrive as NAMES; Pi's loop is what turns
		// them into callable objects, and that loop doesn't run here.
		needsBuiltinsServed: true,
	},

	installTurn(turn: HarnessTurn): HarnessTurnHandle {
		if (!claudeCliHarnessBackend.owns({ provider: turn.provider })) return NOOP_HARNESS_HANDLE;

		let mcpHttpUrl: string | undefined;
		let disposeToken: (() => void) | undefined;
		// Tool calls the binary made on our behalf. Written to the JSONL as they
		// happen; merged into the in-memory context by `afterTurn`, each at the
		// position it occupied when it ran.
		const records: HarnessRecordBatch[] = [];
		// Survives the drain in `afterTurn` — the content-quality gate needs to know
		// the turn ACTED, even after its records were merged.
		let toolCallCount = 0;

		// The FULL guarded tool-plane needs an in-process host (gateway only), an
		// OWNER turn, and the turn's composed guard. Absent any of them we still
		// stamp below, so the owner memory-only stdio plane keeps working.
		const host = turn.senderIsOwner && turn.guard ? getActiveMcpToolPlaneHost() : null;
		if (host && turn.guard) {
			// Pi's builtins reach the toolset only as NAMES. Construct guarded
			// equivalents against the turn's cwd and serve them beside the native
			// tools, so this backend has a filesystem + shell at all. Every call still
			// runs the turn's guard: bash → exec-gate (approval), write/edit →
			// path-write + config-write guards.
			const builtinTools = createGuardedBuiltinTools({ cwd: turn.cwd, allow: turn.builtinToolNames });
			const reg = host.registry.register({
				customTools: [...turn.customTools, ...builtinTools],
				guard: turn.guard,
				...(turn.signal ? { signal: turn.signal } : {}),
				agentId: turn.agentId,
				sessionKey: turn.sessionKey,
				// Lets the MCP route mint pi-shaped tool events for the TUI.
				runId: turn.runId,
				// ...and record what the binary actually did into the transcript, so a
				// resumed session, compaction and the next turn's replayed context all
				// know a file was written / a command was run.
				recordToolCall: (rec: HarnessToolRecord) => {
					toolCallCount += 1;
					records.push(
						recordHarnessToolCall(turn.session, rec, {
							api: CLAUDE_CLI_API,
							provider: turn.provider,
							model: turn.modelId,
						}),
					);
				},
			});
			mcpHttpUrl = `${host.baseUrl}/mcp/${reg.token}`;
			disposeToken = reg.dispose;
		}

		return {
			stampContext(context: unknown): void {
				// `senderIsOwner` is the SAME (poisoned-inbox demoted) signal the tool
				// registry gates on, so the MCP surface can never be broader than the
				// in-process tool surface. With no `mcpHttpUrl` the transport falls back
				// to the memory-only stdio config.
				stampClaudeCliToolPlane(context, {
					agentId: turn.agentId,
					senderIsOwner: turn.senderIsOwner,
					...(mcpHttpUrl !== undefined ? { mcpHttpUrl } : {}),
				});
			},
			afterTurn(): void {
				if (records.length === 0) return;
				// Drain: the max_tokens continuation flushes before it re-prompts, so the
				// respawned binary sees what already happened. Merging twice would
				// duplicate the pairs.
				const pending = records.splice(0, records.length);
				mergeHarnessRecordsIntoSession(turn.session, pending);
			},
			hadToolActivity(): boolean {
				return toolCallCount > 0;
			},
			dispose(): void {
				disposeToken?.();
				disposeToken = undefined;
			},
		};
	},
};
