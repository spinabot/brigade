/**
 * Brigade tool registry.
 *
 * Factory that builds the array of Brigade-native custom tools passed to
 * Pi's `createAgentSession({customTools})` slot. Today it returns the three
 * Primitive #4 memory tools — `recall_memory` (lexical search across markdown
 * notes + the structured fact store), `read_memory` (fetch a specific note),
 * and `write_memory` (persist a structured fact) — alongside Pi's built-in
 * tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`). `spawn_agent`
 * ships with Primitive #6 (sub-agents).
 *
 * The factory is plumbed through `session-wiring.ts` (the single
 * tool-assembly seam) so adding a tool later is a one-line change in
 * `createBrigadeTools` rather than a multi-file rewire.
 *
 * Tool-factory pattern with Brigade-native naming and a deliberately
 * narrow scope (no plugins, no channels, no MCP).
 */

import { getActiveChannelManager } from "../channels/active-manager.js";
import type { ChannelApprovalRoute } from "../channels/approval-router.js";
import type { MemoryCapability } from "../extensions/types.js";
import type { SessionContext } from "../session-context.js";
import { FileMemoryStore } from "../memory/storage.js";
import {
	createDefaultMemoryCapability,
	isDefaultMemoryCapability,
} from "../memory/plugin-runtime.js";
import {
	DEFAULT_SUBAGENT_MAX_DEPTH,
	filterToolsForSubagentDepth,
} from "../subagent-policy.js";
import { getActiveCronService } from "../../cron/active-service.js";
import { makeAgentsListTool } from "./agents-list-tool.js";
import { makeCronTool } from "./cron-tool.js";
import { makeManageAgentTool } from "./manage-agent-tool.js";
import { makeFindTool } from "./find-tool.js";
import { makeGenerateImageTool } from "./generate-image-tool.js";
import { makeAnalyzeMediaTool } from "./analyze-media-tool.js";
import { makeManageAccessTool } from "./manage-access-tool.js";
import { makeManageChannelAccessTool } from "./manage-channel-access-tool.js";
import { makeConnectChannelTool } from "./connect-channel-tool.js";
import { makeMessageActionTool } from "./message-action-tool.js";
import { makeComposioTool } from "./composio-tool.js";
import { makeDiscordActionTool } from "./discord-action-tool.js";
import { discordChannelEnabled } from "../channels/discord/account-config.js";
import { makeBlueBubblesActionTool } from "./bluebubbles-action-tool.js";
import { bluebubblesChannelEnabled } from "../channels/bluebubbles/account-config.js";
import { makeManageProviderTool } from "./manage-provider-tool.js";
import { makeOAuthAuthorizeTool } from "./oauth-authorize-tool.js";
import { makeManageSkillTool } from "./manage-skill-tool.js";
// Consolidated `org` tool — only registered when cfg.org is present
// (gate is below). Replaces the prior two-tool surface
// (`org_describe` + `delegate_to_department`). Per-action capability
// checks (e.g. delegate requiring cfg.session.agentToAgent.enabled)
// happen inside the action body.
import { makeOrgTool } from "./org-tool.js";
import { loadConfig as _loadConfigForOrgGate } from "../../core/config.js";
import { makeManageMemoryTool } from "./manage-memory-tool.js";
import { makeReadMemoryTool, makeRecallMemoryTool, makeWriteMemoryTool } from "./memory-tools.js";
import { makeSendMediaTool } from "./send-media-tool.js";
import { makeSendMessageTool } from "./send-message-tool.js";
import { makeSpawnAgentTool } from "./spawn-agent-tool.js";
import { makeSpawnAgentsTool } from "./spawn-agents-tool.js";
import { createSessionsBrigadeTools } from "./sessions/index.js";
import type { AnyBrigadeTool } from "./types.js";

/**
 * Options threaded through to every Brigade-native tool. Each tool
 * picks the fields it needs; the rest are ignored.
 *
 * Per-field rationale:
 *   - `workspaceDir` — the absolute path to `~/.brigade/workspace/`.
 *     Persona-mutating tools (write_memory, recall_memory) resolve
 *     their target files under this root. The agent's session cwd
 *     defaults to this dir so Pi's built-in write/edit/read resolve
 *     relative paths into it naturally; Brigade-native tools take it
 *     as an explicit parameter so they're not coupled to that default.
 *   - `agentId` — the active agent id (default `"main"`). Sub-agent
 *     tools (`spawn_agent`) use this to scope nested sessions.
 *   - `cwd` — process cwd. Tools that need to resolve relative paths
 *     for read-only operations (grep / ls equivalents) can choose to
 *     resolve against cwd OR workspaceDir depending on intent.
 */
export interface CreateBrigadeToolsOptions {
	workspaceDir: string;
	agentId: string;
	cwd: string;
	/**
	 * Active memory backend. The agent loop resolves this via
	 * `resolveActiveMemoryCapability(...)` so a plugin pinned through
	 * `extensions.slots.memory` automatically owns recall + write. Omitted →
	 * the registry builds the built-in file-backed default (back-compat with
	 * pre-SDK call sites + tests).
	 */
	memoryCapability?: MemoryCapability;
	/**
	 * Sub-agent spawn context — Primitive #6. When provided, `spawn_agent` is
	 * registered so the model can delegate sub-tasks. When omitted, the tool is
	 * dropped (tests, unit-test paths, and any caller that doesn't want a
	 * `spawn_agent` surface get the legacy three-tool set).
	 *
	 * The depth at which the CHILD will run is `callerDepth + 1`. When that
	 * already equals `subagentMaxDepth`, the tool is also dropped — a leaf
	 * sub-agent cannot recursively spawn further sub-agents.
	 */
	subagentContext?: {
		/** Parent session key — drives the child key + the concurrency map. */
		parentSessionKey: string;
		/** Caller's depth (0 = top-level operator-driven turn). */
		callerDepth: number;
		/** Parent's run id (event correlation). */
		parentRunId?: string;
		/** Parent's abort signal — propagates cancellation to the child. */
		parentSignal?: AbortSignal;
		/**
		 * Parent's RESOLVED provider + modelId. The child inherits these unless
		 * the `spawn_agent` call explicitly overrides via the `model` param.
		 */
		parentProvider?: string;
		parentModelId?: string;
	};
	/** Max sub-agent depth — defaults to `DEFAULT_SUBAGENT_MAX_DEPTH` (3). */
	subagentMaxDepth?: number;
	/**
	 * Active channel context for this turn — set when the inbound came from a
	 * channel adapter (WhatsApp / Slack / Telegram / …). Lets cron-tool's
	 * `add` auto-fill `delivery.channel`/`delivery.to`/`delivery.threadId`
	 * so a scheduled job created mid-chat replies back to the SAME chat by
	 * default. The model can still override by passing explicit `delivery`
	 * params (e.g. "schedule X to message me on Slack instead").
	 *
	 * Undefined for TUI / direct-RPC turns — those have no originating
	 * channel; a cron added from the TUI without explicit channel/to
	 * announces into the operator's main session via the
	 * `enqueueSystemEvent` fallback (see `cron/service/timer.ts`).
	 */
	channelContext?: ChannelApprovalRoute;
	/**
	 * When false, `send_media` (and other context-aware tools) refuse
	 * cross-conversation sends — only the inbound's own chat is
	 * reachable. Defaults to true (treat as owner-routed). Channel
	 * turns from approved-non-owner peers set this to false so the
	 * narrow per-call gate kicks in.
	 */
	senderIsOwner?: boolean;
	/**
	 * Resolved turn-model context (provider + modelId of the model driving this
	 * turn). Threaded into `analyze_media` so it can decide whether returning an
	 * IMAGE content block is meaningful (a text-only model can't consume one).
	 * Optional — when omitted (tests / legacy call sites) the tool assumes the
	 * model is vision-capable but annotates the uncertainty.
	 */
	modelContext?: {
		provider?: string;
		modelId?: string;
		imageInput?: boolean;
	};
	/**
	 * Per-turn session metadata (Step 11's `SessionContext`). When supplied,
	 * `createBrigadeTools` includes the four sessions tools
	 * (`sessions_send` / `sessions_spawn` / `sessions_list` / `sessions_history`)
	 * pre-wired with the caller's session key, agent id, channel context,
	 * etc. Omit the field on TUI / cron / unit-test paths that don't need
	 * cross-session coordination — the four tools simply aren't surfaced.
	 */
	sessionContext?: SessionContext;
	/**
	 * Sandbox flag for the sessions tools — when true, `sessions_list`
	 * clamps visibility to spawned-tree only. Defers to the caller (the
	 * dispatcher) to compute.
	 */
	sandboxedSessionTools?: boolean;
	/**
	 * Per-turn session-tool access guard — visibility scope + A2A policy +
	 * spawned-tree containment. Threaded through to the sessions tool bundle
	 * so each tool's execute body can fail-closed BEFORE dispatching to a
	 * session the caller is not allowed to reach.
	 */
	sessionToolAccess?: {
		visibility?: import("./sessions/shared.js").SessionToolsVisibility;
		a2aPolicy?: import("./sessions/shared.js").AgentToAgentPolicy;
		spawnedKeys?: ReadonlySet<string>;
	};
}

/**
 * Build Brigade's custom tool array — the THREE Primitive #4 memory tools
 * today (recall_memory, read_memory, write_memory); skills (#5) and
 * sub-agents (#6) add more later. Callers pass the result to Pi's
 * `customTools` option — Pi merges it with the `tools` allowlist (built-ins
 * by name) to form the full tool surface.
 *
 * The function takes options eagerly rather than late-binding so tests can
 * construct a deterministic registry without touching the filesystem.
 */
export function createBrigadeTools(opts: CreateBrigadeToolsOptions): AnyBrigadeTool[] {
	// Primitive #4 (Memory): the active backend is a `MemoryCapability` — bundled
	// default (file-based FactStore + FileMemoryStore) when no plugin is pinned,
	// or a registered plugin (vector DB, KG, …) when `extensions.slots.memory`
	// selects one. The agent loop resolves and passes `memoryCapability`; tests
	// and legacy call sites omit it and get the default.
	const capability =
		opts.memoryCapability ?? createDefaultMemoryCapability({
			workspaceDir: opts.workspaceDir,
			agentId: opts.agentId,
		});
	// `read_memory` is filesystem-only (bounded read of MEMORY.md /
	// memory/<name>.md), so it always binds to the file store. When the active
	// capability IS the bundled default we reuse its store; otherwise we
	// construct one over the same workspaceDir so the read tool keeps
	// working alongside a plugin-backed search.
	const fileStore = isDefaultMemoryCapability(capability)
		? capability.fileStore
		: new FileMemoryStore(opts.workspaceDir);
	// Per-turn memory scope — threads the caller's senderIsOwner +
	// channelContext + sessionKey into the recall + write tools so peer
	// memories stay session-scoped and the operator's view stays clean
	// of peer state. Same shape as `cron` / `send_media` / `send_message`.
	const memoryScope = {
		...(opts.senderIsOwner !== undefined ? { senderIsOwner: opts.senderIsOwner } : {}),
		...(opts.channelContext !== undefined ? { channelContext: opts.channelContext } : {}),
		...(typeof opts.sessionContext?.key === "string" && opts.sessionContext.key.length > 0
			? { sessionKey: opts.sessionContext.key }
			: {}),
	};
	const tools: AnyBrigadeTool[] = [
		// find — Brigade-native glob search. Replaces Pi's fd-backed builtin,
		// whose --glob --full-path mode matches nothing on Windows (see
		// find-tool.ts). Same name + schema, so the model's call shapes and
		// any cron `toolsAllow: ["find", …]` lists keep working.
		makeFindTool({ cwd: opts.cwd }),
		// recall routes through the capability (rich render for the default,
		// minimal SDK render for plugins). Origin filter is applied inside
		// the tool so peer + operator state stay isolated.
		makeRecallMemoryTool(capability, undefined, memoryScope),
		makeReadMemoryTool(fileStore),
		// write_memory persists distilled structured facts through the
		// capability. The per-call gate inside the tool stamps the right
		// MemoryRecordOrigin so subsequent recalls can filter to caller-own.
		makeWriteMemoryTool(capability, memoryScope),
		// manage_memory — owner-only Phase-3 maintenance + governance: run a dream
		// reflection on demand, crypto-shred a fact (+ cascade), inspect provenance,
		// export, or apply retention. The live operator surface for Tideline's
		// dream/governance behaviours (otherwise library-only).
		makeManageMemoryTool(opts.workspaceDir, { agentId: opts.agentId }),
		// agents_list — read-only enumeration of agents the caller can target.
		// Mirrors the reference codebase's posture: the model can SEE the agent
		// catalog without any privilege check.
		makeAgentsListTool(opts.agentId !== undefined ? { requesterAgentId: opts.agentId } : {}),
		// manage_agent — owner-only LLM-driven agent CRUD. Same posture as the
		// reference codebase's `gateway` tool (also owner-only) but with a
		// dedicated action surface (add/delete/set-identity) that wraps the
		// existing CLI helpers so workspace bootstrap + atomic rollback +
		// soft-delete-to-trash all come for free instead of the model
		// hand-constructing a config.patch.
		makeManageAgentTool(),
		// manage_skill — owner-only LLM-driven skill CRUD. Pairs with the
		// path-write guard that refuses raw `write`/`edit` into the install
		// dir's `skills/` directory: the model can't accidentally land a new
		// SKILL.md in the bundled tree, so the only correct surface is this
		// tool, which resolves the right scope root (`agent` workspace OR
		// `~/.brigade/skills/` managed) for the user.
		makeManageSkillTool(opts.agentId !== undefined ? { requesterAgentId: opts.agentId } : {}),
		// generate_image — first-class image generation via the operator's
		// OpenRouter key. Exists so the model never reaches for bash/curl
		// (key-through-shell, guessed model ids, guessed response shapes —
		// a billed generation got silently dropped that way in production).
		// Owner-gated: each call is billed.
		makeGenerateImageTool(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
		// analyze_media — read-capability media + document understanding. The
		// model hands it a local path or URL (+ a question) and it RESOLVES the
		// input into content the CURRENT turn's model analyzes: images become an
		// image content block (when the model is vision-capable), PDF/DOCX/PPTX/
		// XLSX/HTML are extracted to text/markdown, video is reported unsupported
		// (Pi's tool-result content channel is text+image only — no aux-model
		// runtime, no video/document block). NOT owner-only (read), but the
		// local-path guard + SSRF guard run for every sender. `modelContext` lets
		// it skip attaching an image a text-only model can't see.
		makeAnalyzeMediaTool({
			...(opts.workspaceDir !== undefined ? { workspaceDir: opts.workspaceDir } : {}),
			...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
			...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
			...(opts.modelContext !== undefined ? { modelContext: opts.modelContext } : {}),
		}),
		// manage_provider — owner-only credential + per-agent model surface.
		// Exists so a pasted API key lands in the canonical 0600 credential
		// store (never .env / workspace files / config / chat echoes) and so
		// "agent X should run on openai/gpt-4o" is one grounded call that
		// also seeds the key into that agent's own store.
		makeManageProviderTool(
			opts.agentId !== undefined ? { requesterAgentId: opts.agentId } : {},
		),
		// manage_access — owner-only agent-to-agent access control. The
		// sanctioned path the path-write / config-write guards point to for
		// changing session.sessionTools.visibility / session.agentToAgent /
		// org.a2a.mode, so "let main message marketing-lead" is one validated
		// call instead of a guard-refused hand-edit.
		makeManageAccessTool(),
		// manage_channel_access — owner-only channel GROUP access control: the
		// sanctioned path for channels.<ch>.groupPolicy / groupAllowFrom /
		// groupAllowJids / groupFollowUpWindowMs, so "let the crew answer in this
		// group / stop making me tag you" is one validated call, not a hand-edit.
		makeManageChannelAccessTool(),
		// connect_channel — connect / disconnect a messaging channel (Telegram,
		// WhatsApp, …) LIVE from chat without a gateway restart. Always mounted so
		// the crew is always aware it CAN connect a channel. list/status are
		// read-only + safe for anyone; connect/disconnect are owner-gated per-call
		// (a channel peer must never wire up / tear down a messaging surface), and
		// a supplied token is sealed as a `${VAR}` secret-ref (never stored raw).
		makeConnectChannelTool(
			opts.senderIsOwner !== undefined ? { senderIsOwner: opts.senderIsOwner } : {},
		),
		// message_action: edit / delete / react / pin on an EXISTING channel
		// message. Always mounted (like connect_channel) so the crew is aware
		// it CAN amend/remove a message; owner-only per-call (a peer must never
		// mutate arbitrary messages). The tool pre-checks the channel's
		// capability flag and reports unsupported actions cleanly.
		makeMessageActionTool({
			...(opts.channelContext !== undefined ? { channelContext: opts.channelContext } : {}),
			...(opts.senderIsOwner !== undefined ? { senderIsOwner: opts.senderIsOwner } : {}),
			...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
		}),
		// composio — owner-only universal app connector (Composio, 1,000+ apps).
		// Always mounted (like oauth_authorize) so the crew is always aware it
		// can connect apps; set-key seals the operator's Composio key, then
		// connect/search/execute. Inert (reports "no key") until set-key.
		makeComposioTool({
			...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
			...(typeof opts.sessionContext?.key === "string" && opts.sessionContext.key.length > 0
				? { sessionKey: opts.sessionContext.key }
				: {}),
		}),
		// oauth_authorize — owner-only OAuth 2.0 authorization-code flow with a
		// one-shot loopback callback. Exists so the model never hand-rolls an
		// http listener in bash (the Gmail-OAuth flow fought EADDRINUSE +
		// redirect-mismatch across six manual tries). Tokens land sealed in the
		// agent's credential store; codes/tokens never echo.
		makeOAuthAuthorizeTool({
			...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
			...(typeof opts.sessionContext?.key === "string" && opts.sessionContext.key.length > 0
				? { sessionKey: opts.sessionContext.key }
				: {}),
		}),
	];
	// Consolidated org tool additive-gate: the single `org` tool is
	// registered ONLY when cfg.org is present in the loaded config. When
	// cfg.org is absent (the default for every existing install), NO org
	// tool surfaces to the model — pre-org installs see the legacy tool
	// list bit-for-bit unchanged.
	//
	// Per-action capability checks (e.g. `delegate` requiring
	// `cfg.session.agentToAgent.enabled`) live INSIDE the action body, not
	// the registry, so the action surface stays forward-compatible and a
	// disabled action returns a structured refusal envelope instead of
	// disappearing from the surface.
	try {
		const cfgForOrgGate = _loadConfigForOrgGate() as { org?: unknown };
		if (cfgForOrgGate && cfgForOrgGate.org) {
			tools.push(
				makeOrgTool({
					...(opts.agentId !== undefined
						? { requesterAgentId: opts.agentId }
						: {}),
					...(opts.sessionContext?.key !== undefined
						? { agentSessionKey: opts.sessionContext.key }
						: {}),
					...(opts.senderIsOwner !== undefined
						? { senderIsOwner: opts.senderIsOwner }
						: {}),
					...(opts.channelContext !== undefined
						? {
								channelContext: {
									channelId: opts.channelContext.channelId,
									conversationId: opts.channelContext.conversationId,
									...(opts.channelContext.threadId !== undefined
										? { threadId: opts.channelContext.threadId }
										: {}),
									...(opts.channelContext.accountId !== undefined
										? { accountId: opts.channelContext.accountId }
										: {}),
								},
							}
						: {}),
				}),
			);
		}
	} catch {
		// loadConfig failures are non-fatal: skip the gate and keep the
		// legacy tool list rather than crashing tool assembly.
	}
	// `discord_action` additive-gate (Phase 4): the owner-only Discord guild
	// action surface (channels / roles / members / emojis / events / moderation
	// / rich content) is assembled ONLY when the Discord channel is configured
	// (`channels.discord.enabled`). A non-Discord install never sees it, so the
	// exact-count tool surface stays bit-for-bit unchanged. The tool is
	// SELF-CONTAINED over Discord REST v10 (resolves the bot token like probe.ts;
	// no live adapter needed). `ownerOnly: true` → the session-wiring owner
	// wrapper refuses non-owner senders + unattended cron before execute runs.
	try {
		if (discordChannelEnabled(_loadConfigForOrgGate() as never)) {
			tools.push(makeDiscordActionTool());
		}
	} catch {
		// loadConfig failures are non-fatal: skip the Discord gate too.
	}
	// `bluebubbles_action` additive-gate: the owner-only BlueBubbles group-admin
	// surface (add/remove participant, rename, group icon, leave) is assembled
	// ONLY when the BlueBubbles channel is configured (`channels.bluebubbles.enabled`).
	// A non-BlueBubbles install never sees it, so the exact-count tool surface
	// stays bit-for-bit unchanged. The tool is SELF-CONTAINED over BlueBubbles
	// REST (resolves serverUrl+password like probe.ts; no live adapter needed).
	// `ownerOnly: true` → the session-wiring owner wrapper refuses non-owner
	// senders + unattended cron before execute runs.
	try {
		if (bluebubblesChannelEnabled(_loadConfigForOrgGate() as never)) {
			tools.push(makeBlueBubblesActionTool());
		}
	} catch {
		// loadConfig failures are non-fatal: skip the BlueBubbles gate too.
	}
	// Primitive #6 — register `spawn_agent` (sync, single child) AND
	// `spawn_agents` (sync, parallel fan-out) only when the caller supplied a
	// parent context AND the child wouldn't be a leaf. `filterToolsForSubagentDepth`
	// owns the depth check so the rule lives in one place; the registry just
	// passes the candidate tool array through it. The two spawn tools share
	// the same depth gate — if the model can't spawn one child, it can't
	// spawn five either.
	//
	// OWNER GATE (security): a sub-agent currently runs with OWNER privileges
	// (subagent-runner hardcodes senderIsOwner:true and does not thread the parent's
	// channel origin), so a NON-owner channel peer turn must not be offered spawn at
	// all — else a peer could induce the model to delegate, and the owner-privileged
	// child would read the operator's private memory + author trusted owner facts
	// (cross-origin isolation + write-gate bypass). Owner turns (true) and trusted
	// internal pathways (undefined) keep spawn. (A confined peer→sub-agent that
	// inherits the peer's origin is a future enhancement; until then, deny.)
	if (opts.subagentContext && opts.senderIsOwner !== false) {
		const spawnAgentTool = makeSpawnAgentTool({
			parentSessionKey: opts.subagentContext.parentSessionKey,
			parentAgentId: opts.agentId,
			...(opts.subagentContext.parentRunId !== undefined
				? { parentRunId: opts.subagentContext.parentRunId }
				: {}),
			...(opts.subagentContext.parentSignal !== undefined
				? { parentSignal: opts.subagentContext.parentSignal }
				: {}),
			...(opts.subagentContext.parentProvider !== undefined
				? { parentProvider: opts.subagentContext.parentProvider }
				: {}),
			...(opts.subagentContext.parentModelId !== undefined
				? { parentModelId: opts.subagentContext.parentModelId }
				: {}),
			// Wave O0.5 — thread the access policy so the spawn_agent tool
			// can fail-closed against the parent's visibility + A2A policy
			// the same way the sessions_* tool surface does.
			...(opts.sessionToolAccess?.visibility !== undefined
				? { visibility: opts.sessionToolAccess.visibility }
				: {}),
			...(opts.sessionToolAccess?.a2aPolicy !== undefined
				? { a2aPolicy: opts.sessionToolAccess.a2aPolicy }
				: {}),
			...(opts.sessionToolAccess?.spawnedKeys !== undefined
				? { spawnedKeys: opts.sessionToolAccess.spawnedKeys }
				: {}),
		});
		const spawnAgentsTool = makeSpawnAgentsTool({
			parentSessionKey: opts.subagentContext.parentSessionKey,
			parentAgentId: opts.agentId,
			...(opts.subagentContext.parentRunId !== undefined
				? { parentRunId: opts.subagentContext.parentRunId }
				: {}),
			...(opts.subagentContext.parentSignal !== undefined
				? { parentSignal: opts.subagentContext.parentSignal }
				: {}),
			...(opts.subagentContext.parentProvider !== undefined
				? { parentProvider: opts.subagentContext.parentProvider }
				: {}),
			...(opts.subagentContext.parentModelId !== undefined
				? { parentModelId: opts.subagentContext.parentModelId }
				: {}),
			...(opts.sessionToolAccess?.visibility !== undefined
				? { visibility: opts.sessionToolAccess.visibility }
				: {}),
			...(opts.sessionToolAccess?.a2aPolicy !== undefined
				? { a2aPolicy: opts.sessionToolAccess.a2aPolicy }
				: {}),
			...(opts.sessionToolAccess?.spawnedKeys !== undefined
				? { spawnedKeys: opts.sessionToolAccess.spawnedKeys }
				: {}),
		});
		const filtered = filterToolsForSubagentDepth({
			tools: [spawnAgentTool, spawnAgentsTool],
			callerDepth: opts.subagentContext.callerDepth,
			maxDepth: opts.subagentMaxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH,
		});
		tools.push(...filtered);
	}
	// Cron primitive — register the `cron` tool when the gateway daemon's
	// cron service is up. The agent uses it to add/list/run/wake jobs from
	// inside chat. `ownerOnly: true` ensures non-operator senders can't
	// mutate the cron set; the ownership wrapper at session-wiring rejects
	// their calls before they reach the action handler.
	const cronService = getActiveCronService();
	if (cronService) {
		// Pass channel context so `cron add` from a channel-routed turn can
		// auto-fill `delivery.channel/to/threadId` and the eventual announce
		// lands back in the SAME chat the operator created the job from.
		// Caller's session key threads in so the tool can resolve
		// `sessionTarget: "current"` to `session:<sessionKey>` and (when
		// `contextMessages` is set on a systemEvent add) fetch the operator's
		// recent messages via `sessions.history`. TUI / unit-test paths that
		// don't supply `sessionContext.key` keep the existing fallback
		// behaviour (current → isolated, contextMessages → no-op).
		const agentSessionKey =
			typeof opts.sessionContext?.key === "string" && opts.sessionContext.key.trim().length > 0
				? opts.sessionContext.key
				: undefined;
		tools.push(
			makeCronTool({
				...(opts.channelContext !== undefined ? { channelContext: opts.channelContext } : {}),
				...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
				...(agentSessionKey !== undefined ? { agentSessionKey } : {}),
				// Wave O0.6 — thread visibility + A2A so the cron tool
				// can refuse cross-agent `cron add` whose `job.agentId`
				// targets another agent and policy disallows it.
				...(opts.sessionToolAccess?.visibility !== undefined
					? { visibility: opts.sessionToolAccess.visibility }
					: {}),
				...(opts.sessionToolAccess?.a2aPolicy !== undefined
					? { a2aPolicy: opts.sessionToolAccess.a2aPolicy }
					: {}),
				...(opts.sessionToolAccess?.spawnedKeys !== undefined
					? { spawnedKeys: opts.sessionToolAccess.spawnedKeys }
					: {}),
				// Same shape as `send_media` — channel turns from approved
				// non-owner peers thread `senderIsOwner: false` so the
				// per-call gate inside `cron` enforces "own chat only".
				...(opts.senderIsOwner !== undefined
					? { senderIsOwner: opts.senderIsOwner }
					: {}),
			}),
		);
	}
	// `send_message` — register only when a channel manager is mounted AND
	// at least one adapter actually started. Without that the tool would
	// surface to the model but every call would fail validation; better to
	// hide it until the operator has a working channel (per the reference's pattern
	// of "no message tool when no channels are configured").
	const channelManager = getActiveChannelManager();
	if (channelManager && channelManager.started.length > 0) {
		tools.push(
			makeSendMessageTool({
				...(opts.channelContext !== undefined ? { channelContext: opts.channelContext } : {}),
				// Same shape as `send_media` — channel turns from approved
				// non-owner peers thread `senderIsOwner: false` so the
				// per-call gate inside `send_message` enforces "own chat only".
				...(opts.senderIsOwner !== undefined
					? { senderIsOwner: opts.senderIsOwner }
					: {}),
			}),
		);
		// `send_media` — same gating as send_message. The tool itself
		// refuses cleanly when the chosen channel adapter happens to be
		// text-only (no sendMedia capability), so it can safely surface
		// to the model whenever ANY channel is started.
		tools.push(
			makeSendMediaTool({
				...(opts.channelContext !== undefined
					? { channelContext: opts.channelContext }
					: {}),
				...(opts.senderIsOwner !== undefined
					? { senderIsOwner: opts.senderIsOwner }
					: {}),
			}),
		);
	}
	// Sessions tools (Steps 19-23) — register only when the caller passed
	// a `sessionContext`. TUI / cron / unit-test paths skip these because
	// they don't need cross-session coordination; channel-routed agent
	// turns + sub-agent runs always pass a context so the four sessions
	// tools surface there.
	if (opts.sessionContext) {
		const sessionsTools = createSessionsBrigadeTools({
			sessionContext: opts.sessionContext,
			...(opts.channelContext !== undefined
				? { channelContext: opts.channelContext }
				: {}),
			callerDepth: opts.subagentContext?.callerDepth ?? 0,
			maxSpawnDepth: opts.subagentMaxDepth,
			workspaceDir: opts.workspaceDir,
			sandboxed: opts.sandboxedSessionTools,
			...(opts.sessionToolAccess?.visibility !== undefined
				? { visibility: opts.sessionToolAccess.visibility }
				: {}),
			...(opts.sessionToolAccess?.a2aPolicy !== undefined
				? { a2aPolicy: opts.sessionToolAccess.a2aPolicy }
				: {}),
			...(opts.sessionToolAccess?.spawnedKeys !== undefined
				? { spawnedKeys: opts.sessionToolAccess.spawnedKeys }
				: {}),
		});
		tools.push(...sessionsTools);
	}
	return tools;
}

/**
 * Names of Brigade-native tools shipped today. Used by the system-prompt
 * assembler to advertise tools by name in the `## Tooling` section AND by
 * `agent-loop.ts` to flip on the memory-capability prompt block.
 */
export function listBrigadeToolNames(): string[] {
	return ["recall_memory", "read_memory", "write_memory"];
}
