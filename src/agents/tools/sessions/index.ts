/**
 * Sessions tools bundle — public entry point (Step 26).
 *
 * Wires Steps 19-23's tool factories with Step 11's `SessionContext` so
 * the per-turn dispatcher (Step 25) can construct the right tool surface
 * for the caller. Replaces the alternative of every dispatcher hand-
 * threading agentSessionKey/agentChannel/etc. through four factory calls.
 *
 * Usage from the dispatcher:
 *
 *   ```ts
 *   import { createSessionsToolsBundle } from "./tools/sessions/index.js";
 *   const tools = createSessionsToolsBundle({
 *     sessionContext: buildSessionContext({ sessionKey }),
 *     callerDepth: resolveCallerDepth({ sessionKey }),
 *   });
 *   // tools is `{ send, spawn, list, history, rename }` — each factory output
 *   // is already wired with the caller's context.
 *   ```
 *
 * The bundle is plain factory output — caller is expected to spread it
 * into Pi's `customTools` array (or whatever the host runtime accepts).
 *
 * Naming note: this file is the SOLE re-export surface for the four
 * sessions tools — `import { createSessionsSendTool } from "..."` etc.
 * still works, but new code should prefer the bundle factory.
 */

import type { TSchema } from "typebox";

import type { AnyBrigadeTool } from "../types.js";
import type { SessionContext } from "../../session-context.js";
import type { ChannelApprovalRoute } from "../../channels/approval-router.js";
import { createSessionsHistoryTool } from "./history.js";
import { createSessionsListTool } from "./list.js";
import { createSessionsRenameTool } from "./rename.js";
import { createSessionsSendTool } from "./send.js";
import { createSessionsSpawnTool } from "./spawn.js";
import type {
	AgentToAgentPolicy,
	SessionToolsVisibility,
	ToolResultEnvelope,
} from "./shared.js";

export {
	createSessionsHistoryTool,
	createSessionsListTool,
	createSessionsSendTool,
	createSessionsSpawnTool,
};
export type { SessionsHistoryToolArgs, SessionsHistoryToolDescriptor } from "./history.js";
export type { SessionsListToolArgs, SessionsListToolDescriptor } from "./list.js";
export type { SessionsSendToolArgs, SessionsSendToolDescriptor } from "./send.js";
export type { SessionsSpawnToolArgs, SessionsSpawnToolDescriptor } from "./spawn.js";
export {
	jsonToolResult,
	SESSIONS_HISTORY_MAX_BYTES,
	SESSIONS_HISTORY_TEXT_MAX_CHARS,
	ToolAuthorizationError,
	ToolInputError,
} from "./shared.js";

export interface CreateSessionsToolsBundleParams {
	/** Per-turn context produced by Step 11's `buildSessionContext`. */
	sessionContext?: SessionContext;
	/**
	 * Originating channel route for this turn (Phase 6). When the inbound came
	 * from a channel adapter, this carries the channel name + conversation id +
	 * thread id so `sessions_spawn` can materialize a Discord thread for a
	 * `thread: true` sub-agent. Undefined on TUI / cron / RPC turns.
	 */
	channelContext?: ChannelApprovalRoute;
	/** Caller's resolved spawn depth (from session store). Defaults to 0. */
	callerDepth?: number;
	/** Optional cap overrides; defaults to 3 / 5 from Step 20. */
	maxSpawnDepth?: number;
	maxChildrenPerAgent?: number;
	/** Caller's workspace dir (sub-agents inherit it). */
	workspaceDir?: string;
	/** Sandbox flag — tightens `sessions_list` visibility to spawned-only. */
	sandboxed?: boolean;
	/** Visibility scope for the caller's session: self/tree/agent/all. */
	visibility?: SessionToolsVisibility;
	/** A2A policy resolved from `cfg.session.agentToAgent`. */
	a2aPolicy?: AgentToAgentPolicy;
	/** Session keys the caller (transitively) spawned — used for tree-scope. */
	spawnedKeys?: ReadonlySet<string>;
	/**
	 * Fail-closed opt-out — set to true ONLY when the caller is a trusted
	 * internal pathway (boot wiring, cron lane, heartbeat). Channel-routed
	 * and model-side bundles must leave this unset so the four sessions
	 * tools refuse traffic when policy is missing.
	 */
	bypassAccessGuard?: boolean;
}

export interface SessionsToolsBundle {
	send: ReturnType<typeof createSessionsSendTool>;
	spawn: ReturnType<typeof createSessionsSpawnTool>;
	list: ReturnType<typeof createSessionsListTool>;
	history: ReturnType<typeof createSessionsHistoryTool>;
	rename: ReturnType<typeof createSessionsRenameTool>;
}

/**
 * Build the sessions tool bundle the gateway dispatcher (Step 25) installs
 * for one agent turn. Every tool in the bundle is pre-wired with the
 * caller's session context — no further hand-threading needed.
 *
 * The bundle returns descriptor objects (NOT Pi `AgentTool`s yet). The
 * dispatcher wraps each descriptor in Brigade's `BrigadeTool` shape at
 * the seam where Pi's runtime is set up. Keeping the bundle in
 * descriptor form means tests can exercise the `execute` body directly
 * without depending on Pi's tool-loop.
 */
export function createSessionsToolsBundle(
	params: CreateSessionsToolsBundleParams = {},
): SessionsToolsBundle {
	const ctx = params.sessionContext;
	// Phase 6 — when the turn originated from a channel adapter, the
	// `channelContext` carries the originating channel name + conversation +
	// thread. Threading it here lets `sessions_spawn` materialize a Discord
	// thread for a `thread: true` sub-agent. Absent (TUI / cron / RPC) → the
	// spawn engine sees no channel origin and the thread-binding path is skipped.
	const route = params.channelContext;
	const sharedOpts = {
		agentSessionKey: ctx?.key,
		agentChannel: route?.channelId,
		// Prefer the channel route's conversation id (the real Discord channel
		// id) over the sender id for spawn delivery targeting.
		agentAccountId: route?.accountId ?? ctx?.requesterAccountId,
		agentTo: route?.conversationId ?? ctx?.requesterSenderId,
		agentThreadId: route?.threadId,
		sandboxed: params.sandboxed,
	};
	// Shared access-guard context — threaded into every tool so each
	// execute body can fail-closed BEFORE dispatching. The bypass flag is
	// forwarded only when the factory caller explicitly opts in.
	const accessGuard = {
		...(params.visibility ? { visibility: params.visibility } : {}),
		...(params.a2aPolicy ? { a2aPolicy: params.a2aPolicy } : {}),
		...(params.spawnedKeys ? { spawnedKeys: params.spawnedKeys } : {}),
		...(params.bypassAccessGuard === true ? { bypassAccessGuard: true } : {}),
	};
	const send = createSessionsSendTool({
		agentSessionKey: sharedOpts.agentSessionKey,
		agentChannel: sharedOpts.agentChannel,
		...accessGuard,
	});
	const spawn = createSessionsSpawnTool({
		agentSessionKey: sharedOpts.agentSessionKey,
		agentChannel: sharedOpts.agentChannel,
		agentAccountId: sharedOpts.agentAccountId,
		agentTo: sharedOpts.agentTo,
		...(sharedOpts.agentThreadId !== undefined
			? { agentThreadId: sharedOpts.agentThreadId }
			: {}),
		requesterAgentIdOverride: ctx?.agentId,
		workspaceDir: params.workspaceDir,
		callerDepth: params.callerDepth,
		maxSpawnDepth: params.maxSpawnDepth,
		maxChildrenPerAgent: params.maxChildrenPerAgent,
		...accessGuard,
	});
	const list = createSessionsListTool({
		agentSessionKey: sharedOpts.agentSessionKey,
		sandboxed: params.sandboxed,
		...accessGuard,
	});
	const history = createSessionsHistoryTool({
		agentSessionKey: sharedOpts.agentSessionKey,
		...accessGuard,
	});
	// No `accessGuard` spread: this tool can only ever touch the caller's OWN
	// session, so visibility / A2A policy — which exist to gate reaching OTHER
	// sessions — have nothing to decide. Requiring them would disable
	// self-titling in legitimate configs for no security gain. The gateway's own
	// access check still runs on the resulting `sessions.rename`.
	const rename = createSessionsRenameTool({
		agentSessionKey: sharedOpts.agentSessionKey,
	});
	return { send, spawn, list, history, rename };
}

/**
 * Shape descriptor → Brigade Pi `AgentTool` adapter.
 *
 * The sessions tools (Steps 19-23) declare a lean descriptor with a
 * plain JSON-schema `parameters` + a simple `execute(args) → Promise<{content, details}>`.
 * Pi's `AgentTool` wants TypeBox `TSchema` + `execute(toolCallId, params, signal?, onUpdate?)`.
 *
 * The runtime difference is zero: Pi's TypeBox emits JSON-schema for
 * AJV at validation time, and our descriptor's parameter object IS
 * JSON-schema. We cast at the boundary and adapt the execute signature.
 */
interface DescriptorShape<TArgs> {
	name: string;
	description: string;
	displaySummary: string;
	parameters: Record<string, unknown>;
	execute: (args: TArgs) => Promise<ToolResultEnvelope>;
}

function toBrigadeTool<TArgs>(descriptor: DescriptorShape<TArgs>): AnyBrigadeTool {
	return {
		name: descriptor.name,
		label: descriptor.displaySummary,
		description: descriptor.description,
		displaySummary: descriptor.displaySummary,
		parameters: descriptor.parameters as unknown as TSchema,
		execute: async (_toolCallId: string, args: unknown) => {
			const result = await descriptor.execute(args as TArgs);
			// Pi expects `content` as an array of content blocks (TextContent
			// | ImageContent). The sessions tools return a single string; wrap
			// it in one `{type: "text", text}` block.
			return {
				content: [{ type: "text", text: result.content }],
				details: result.details ?? {},
			};
		},
	} as unknown as AnyBrigadeTool;
}

/**
 * Build the sessions-tools bundle and adapt every descriptor into a
 * Brigade `AnyBrigadeTool` for `createBrigadeTools`'s `customTools` slot.
 * Returned in registry order so `assembleBrigadeToolset` can spread it
 * directly into the tool array.
 */
export function createSessionsBrigadeTools(
	params: CreateSessionsToolsBundleParams = {},
): AnyBrigadeTool[] {
	const bundle = createSessionsToolsBundle(params);
	return [
		toBrigadeTool(bundle.send),
		toBrigadeTool(bundle.spawn),
		toBrigadeTool(bundle.list),
		toBrigadeTool(bundle.history),
		toBrigadeTool(bundle.rename),
	];
}
