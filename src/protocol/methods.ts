/**
 * Gateway method signature catalogue (Step 24).
 *
 * Brand-scrubbed analogue of upstream's per-method params + result type
 * definitions. ONE authoritative file mapping every method name to its
 * `{ params, result }` shape. Step 18's `gateway-call.ts` re-exports
 * `GatewayMethodSignatures` from here; tool layers (Steps 19-23) and
 * handler layers (Step 25) consume the same types.
 *
 * The catalogue is INTENTIONALLY LIMITED to the methods Brigade's
 * runtime currently exposes (sessions / cron / approvals / health /
 * agent). Adding a new method = add an entry here + register a handler
 * at the gateway boot path.
 */

import type { SpawnSubagentMode, SpawnSubagentSandboxMode } from "../agents/subagent-registry.types.js";
import type {
	CronAddParamsV2,
	CronAddResultV2,
	CronListParamsV2,
	CronListResultV2,
	CronRemoveParamsV2,
	CronRemoveResultV2,
	CronRunParamsV2,
	CronRunResultV2,
	CronRunsParamsV2,
	CronRunsResultV2,
	CronStatusParamsV2,
	CronStatusResultV2,
	CronUpdateParamsV2,
	CronUpdateResultV2,
	CronWakeParams,
} from "../core/server-methods/cron.js";

/* ─── Sessions methods ──────────────────────────────────────────── */

export interface SessionsSendParams {
	sessionKey: string;
	message: string;
	thinking?: string;
	attachments?: ReadonlyArray<{ type: string; url: string }>;
	timeoutMs?: number;
	idempotencyKey?: string;
}

export interface SessionsSendResult {
	ok: boolean;
	runId?: string;
	messageSeq?: number;
	interruptedActiveRun?: boolean;
}

export interface SessionsSpawnParams {
	parentSessionKey: string;
	task: string;
	label?: string;
	agentId?: string;
	model?: string;
	thinking?: string;
	runTimeoutSeconds?: number;
	thread?: boolean;
	mode?: SpawnSubagentMode;
	cleanup?: "delete" | "keep";
	sandbox?: SpawnSubagentSandboxMode;
}

export interface SessionsSpawnResult {
	runId: string;
	childSessionKey: string;
	mode: SpawnSubagentMode;
}

export interface SessionsListParams {
	limit?: number;
	activeMinutes?: number;
	kinds?: ReadonlyArray<string>;
	spawnedBy?: string;
	agentId?: string;
	messageLimit?: number;
}

export interface SessionListRow {
	sessionKey: string;
	agentId?: string;
	kind?: string;
	channel?: string;
	subject?: string;
	model?: string;
	state?: string;
	startedAt?: number;
	endedAt?: number;
	runtimeMs?: number;
	updatedAt?: number;
	parentSessionKey?: string;
	label?: string;
	displayName?: string;
	contextTokens?: number;
	totalTokens?: number;
	estimatedCostUsd?: number;
	/**
	 * Wave O0.7 - spawn lineage surfaced on the list row so a caller doing
	 * `sessions_list` can see, for each row, which parent spawned the
	 * session and how deep the spawn tree is. Drives visibility=tree
	 * filtering on the agent side and the connect TUI's "spawned by X"
	 * label.
	 */
	spawnedBy?: string;
	spawnDepth?: number;
}

export interface SessionsListResult {
	sessions: SessionListRow[];
	count: number;
}

export interface SessionsHistoryParams {
	sessionKey: string;
	limit?: number;
}

export interface SessionsHistoryResult {
	messages: ReadonlyArray<unknown>;
}

export interface SessionsAbortParams {
	sessionKey: string;
	runId?: string;
}

/**
 * `sessions.patch` — update metadata on an existing session entry.
 *
 * Used by Step 20's sub-agent spawn engine to write `spawnDepth`,
 * `spawnedBy`, `spawnedWorkspaceDir` (+ optional `subagentRole` /
 * `controlScope`) into the persistent session-store BEFORE the first
 * child turn runs. Without this, depth tracking lives only in the
 * in-memory `subagent-registry` and gets lost on restart.
 *
 * Patch semantics: shallow merge into the existing entry. The
 * `sessionId` field is read-only — supplying it has no effect.
 * `lastUsedAt` is always touched. If the entry doesn't exist yet,
 * the handler creates one (matching upstream's upsert semantics).
 */
export interface SessionsPatchParams {
	sessionKey: string;
	patch: {
		provider?: string;
		modelId?: string;
		authProfile?: string;
		thinkingLevel?: string;
		spawnedWorkspaceDir?: string;
		subagent?: {
			spawnDepth: number;
			spawnedBy: string;
			parentRunId?: string;
			label?: string;
			cleanup?: "delete" | "keep";
			spawnedAt: string;
			spawnedWorkspaceDir?: string;
		};
		[key: string]: unknown;
	};
}

export interface SessionsPatchResult {
	ok: boolean;
	created: boolean;
	sessionId?: string;
}

/* ─── Agent (turn dispatch) method ──────────────────────────────── */

export interface AgentParams {
	message: string;
	sessionKey?: string;
	sessionId?: string;
	agentId?: string;
	model?: string;
	provider?: string;
	channel?: string;
	to?: string;
	accountId?: string;
	threadId?: string | number;
	thinking?: string;
	deliver?: boolean;
	lane?: string;
	idempotencyKey: string;
	timeout?: number;
	label?: string;
	spawnedBy?: string;
	workspaceDir?: string;
	extraSystemPrompt?: string;
	bootstrapContextMode?: "full" | "lightweight";
}

export interface AgentResult {
	runId: string;
	status?: "accepted" | "ok" | "error";
	summary?: string;
	result?: unknown;
}

/* ─── Cron methods ──────────────────────────────────────────────── */
/**
 * Cron RPC parameters + results are owned by the handler module
 * (`core/server-methods/cron.ts`) so the wire shapes stay in lockstep
 * with the dispatch path. We re-export them here under the canonical
 * `Cron*Params` / `Cron*Result` names so existing imports from
 * `protocol/methods.ts` keep working.
 */
export type CronAddParams = CronAddParamsV2;
export type CronAddResult = CronAddResultV2;
export type CronListParams = CronListParamsV2;
export type CronListResult = CronListResultV2;
export type CronStatusParams = CronStatusParamsV2;
export type CronStatusResult = CronStatusResultV2;
export type CronUpdateParams = CronUpdateParamsV2;
export type CronUpdateResult = CronUpdateResultV2;
export type CronRemoveParams = CronRemoveParamsV2;
export type CronRemoveResult = CronRemoveResultV2;
export type CronRunParams = CronRunParamsV2;
export type CronRunResult = CronRunResultV2;
export type CronRunsParams = CronRunsParamsV2;
export type CronRunsResult = CronRunsResultV2;
export type WakeParams = CronWakeParams;
export type WakeResult = void;

/* ─── Approvals methods ─────────────────────────────────────────── */

export interface ApprovalsRespondParams {
	approvalId: string;
	decision: "allow-once" | "allow-always" | "allow-pattern" | "deny";
}

export interface ApprovalsRespondResult {
	ok: boolean;
}

/* ─── Health + system methods ───────────────────────────────────── */

export type HealthParams = Record<string, never>;

export interface HealthResult {
	status: "ok" | "degraded" | "unavailable";
	uptimeMs: number;
	versions?: { brigade: string; protocol: number };
	channels?: Record<string, { state?: string }>;
}

/* ─── Org methods ────────────────────────────────────────────────── */

/** Params for `org.snapshot` — no-op today, reserved for future filtering. */
export type OrgSnapshotParams = Record<string, never> | undefined;

/** Per-format Pride chart bundle returned when cfg.org is present. */
export interface OrgSnapshotCharts {
	/** ANSI + emoji — for the TUI. */
	tui: string;
	/** Emoji + plain text wrapped in a triple-backtick code block. */
	channel: string;
	/** Plain ASCII (no emoji, no ANSI). */
	ascii: string;
	/** Raw OrgGraph for downstream re-rendering. */
	json: unknown;
}

/** Discriminated result envelope — `ok: true` carries every render format. */
export type OrgSnapshotResult =
	| {
		ok: true;
		graph: unknown;
		charts: OrgSnapshotCharts;
	}
	| {
		ok: false;
		reason: "flat-crew";
		redirect: string;
	};

/* ─── Config methods ────────────────────────────────────────────── */
//
// Operator-level config CRUD over the wire — the `brigade config` CLI surface,
// reachable by a remote client. Secrets are redacted in get/list output.

export interface ConfigGetParams {
	path: string;
}
export interface ConfigGetResult {
	found: boolean;
	value?: unknown;
}
export interface ConfigSetParams {
	path: string;
	value: unknown;
}
export interface ConfigSetResult {
	ok: boolean;
	path: string;
	value: unknown;
}
export interface ConfigUnsetParams {
	path: string;
}
export interface ConfigUnsetResult {
	ok: boolean;
	path: string;
	removed: boolean;
}
export interface ConfigListParams {
	/** Pass `false` to include raw secret values. Default redacts. */
	redact?: boolean;
}
export interface ConfigListResult {
	config: unknown;
}
export type ConfigSchemaParams = Record<string, never> | undefined;
export interface ConfigSchemaResult {
	schema: unknown;
}
export type ConfigValidateParams = Record<string, never> | undefined;
export interface ConfigValidateResult {
	valid: boolean;
	issues: Array<{ path: string; message: string }>;
}

/* ─── Exec-approval methods ─────────────────────────────────────── */
//
// Operator-level per-agent bash-approval allowlist CRUD — the `brigade exec`
// CLI surface, reachable by a remote client.

export interface ExecListParams {
	agentId?: string;
}
export interface ExecListResult {
	agentId: string;
	filePath: string;
	commands: string[];
	patterns: string[];
}
export interface ExecAllowParams {
	command: string;
	agentId?: string;
}
export interface ExecAllowPatternParams {
	pattern: string;
	agentId?: string;
}
export interface ExecMutateResult {
	ok: boolean;
	agentId: string;
	kind?: "exact" | "pattern";
	value?: string;
	reason?: string;
}
export interface ExecRemoveParams {
	value: string;
	agentId?: string;
}
export interface ExecRemoveResult {
	ok: boolean;
	agentId: string;
	removedCommands: number;
	removedPatterns: number;
	reason?: string;
}
export interface ExecDenyTestParams {
	command: string;
	agentId?: string;
}
export interface ExecDenyTestResult {
	agentId: string;
	command: string;
	decision: "allow" | "deny" | "prompt";
}

/* ─── Agent routing-binding methods ─────────────────────────────── */
//
// Operator-level routing-binding management — the `brigade agents
// <bindings|bind|unbind>` surface. (Agent add/delete/set-identity are reached
// over the gateway via the `manage_agent` tool, not these RPCs.)

export interface AgentsBindingsParams {
	agentId?: string;
}
export interface AgentsBindingsResult {
	bindings: Array<{ agentId: string; description: string }>;
}
export interface AgentsBindParams {
	agentId?: string;
	/** Binding specs, e.g. `["whatsapp", "slack:T123"]`. */
	specs: string[];
}
export interface AgentsBindResult {
	ok: boolean;
	agentId: string;
	added: string[];
	updated: string[];
	skipped: string[];
	conflicts: string[];
	errors?: string[];
}
export interface AgentsUnbindParams {
	agentId?: string;
	specs?: string[];
	/** Remove every binding owned by the agent. */
	all?: boolean;
}
export interface AgentsUnbindResult {
	ok: boolean;
	agentId: string;
	removed: string[];
	missing: string[];
	conflicts: string[];
	errors?: string[];
}

/* ─── Channel pairing methods ───────────────────────────────────── */
//
// Operator-level channel access control — the `brigade pairing
// <list|approve|revoke>` surface. Requires an explicit channel id.

export interface PairingPendingEntry {
	code: string;
	senderId: string;
	senderName?: string;
	createdAt: string;
}
export interface PairingListParams {
	channel: string;
}
export interface PairingListResult {
	channel: string;
	pending: PairingPendingEntry[];
}
export interface PairingApproveParams {
	channel: string;
	code: string;
}
export interface PairingApproveResult {
	ok: boolean;
	channel: string;
	sender?: string;
	owner?: boolean;
	reason?: string;
}
export interface PairingRevokeParams {
	channel: string;
	code: string;
}
export interface PairingRevokeResult {
	ok: boolean;
	channel: string;
	reason?: string;
}

/* ─── Session maintenance methods ───────────────────────────────── */

export interface SessionsCleanupParams {
	agentId?: string;
	/** Duration like "30d" / "12h" / "2w". */
	olderThan: string;
	dryRun?: boolean;
}
export interface SessionsCleanupResult {
	ok: boolean;
	agentId: string;
	candidates: number;
	deleted: number;
	dryRun: boolean;
	wouldDelete?: string[];
	reason?: string;
}

/* ─── Agent CRUD + skill authoring methods ──────────────────────── */
//
// agents add/delete/set-identity (workspace + config) and skill create/delete/
// write-file (SKILL.md files) — neither is purely config-backed. Reuse the
// manage_agent / manage_skill tool logic; results are the tool's `details`.

export interface AgentsAddParams {
	id: string;
	provider?: string;
	model?: string;
	department?: string;
	reportsTo?: string;
	role?: string;
	bio?: string;
	displayName?: string;
	[key: string]: unknown;
}
export interface AgentsDeleteParams {
	id: string;
}
export interface AgentsSetIdentityParams {
	id: string;
	displayName?: string;
	emoji?: string;
	theme?: string;
	avatar?: string;
	[key: string]: unknown;
}
export interface AgentsManageResult {
	action: string;
	id: string;
	ok: boolean;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	[key: string]: unknown;
}
export interface SkillsCreateParams {
	name: string;
	scope?: "agent" | "managed";
	agentId?: string;
	body?: string;
	description?: string;
	[key: string]: unknown;
}
export interface SkillsDeleteParams {
	name: string;
	scope?: "agent" | "managed";
	agentId?: string;
}
export interface SkillsWriteFileParams {
	name: string;
	filePath: string;
	content?: string;
	scope?: "agent" | "managed";
	agentId?: string;
	[key: string]: unknown;
}
export interface SkillsManageResult {
	action: string;
	name: string;
	ok: boolean;
	message?: string;
	[key: string]: unknown;
}

/* ─── Memory (Tideline) write/manage methods ────────────────────── */
//
// The ONLY typed remote path to MUTATE memory (it lives in facts.jsonl, not
// config). Read is covered by the memory-query / memory-graph methods.

export interface MemoryWriteParams {
	content: string;
	/** identity | preference | fact | correction | context | project … */
	segment: string;
	importance?: number;
	supersedes?: string[];
	subjectKey?: string;
	agentId?: string;
}
export interface MemoryWriteResult {
	memoryId?: string;
	segment?: string;
	importance?: number;
	backend?: string;
	[key: string]: unknown;
}
export interface MemoryManageParams {
	action: "dream" | "purge" | "inspect" | "export" | "retention" | "vault" | "propose" | "retract" | "restore" | "relink";
	memory_id?: string;
	ttl_days?: number;
	agentId?: string;
}
export interface MemoryManageResult {
	action: string;
	ok: boolean;
	message: string;
	[key: string]: unknown;
}

/* ─── Channel runtime + DM-allow, and provider-key removal ──────── */

export interface ChannelsConnectParams {
	channel: string;
	/** Token for token channels (e.g. Telegram); omit for QR channels. */
	token?: string;
	accountId?: string;
}
export interface ChannelsDisconnectParams {
	channel: string;
	accountId?: string;
}
export interface ChannelsActionResult {
	action?: string;
	ok: boolean;
	message?: string;
	[key: string]: unknown;
}
export interface ChannelsAllowParams {
	channel: string;
	senderId: string;
	accountId?: string;
}
export interface ChannelsAllowResult {
	ok: boolean;
	channel: string;
	senderId: string;
	changed: boolean;
	reason?: string;
}
export interface ChannelsAllowListParams {
	channel: string;
	accountId?: string;
}
export interface ChannelsAllowListResult {
	channel: string;
	senders: string[];
}
export interface ProviderRemoveParams {
	providerId: string;
	agentId?: string;
}
export interface ProviderRemoveResult {
	ok: boolean;
	providerId: string;
	agentId: string;
	removed: number;
	reason?: string;
}

/* ─── Integrations: Composio + OAuth ─────────────────────────────── */
//
// `composio` is remote-clean (Composio hosts the OAuth callback). `oauth` is
// the DIY loopback flow — `start` opens a 127.0.0.1 listener ON THE GATEWAY
// HOST, so the round-trip completes only for a local/tunneled operator;
// status/token work remotely. Action-based, mirroring the tools.

export interface ComposioParams {
	action: "set-key" | "apps" | "connect" | "status" | "search" | "execute" | "disconnect" | "refresh";
	key?: string;
	app?: string;
	query?: string;
	tool?: string;
	arguments?: Record<string, unknown>;
	connectionId?: string;
	all?: boolean;
	agentId?: string;
	[key: string]: unknown;
}
export interface ComposioResult {
	action: string;
	ok: boolean;
	message: string;
	[key: string]: unknown;
}
export interface OauthParams {
	action: "start" | "await" | "cancel" | "status" | "token";
	clientId?: string;
	clientSecret?: string;
	authorizeUrl?: string;
	tokenUrl?: string;
	scopes?: string[];
	port?: number;
	waitSeconds?: number;
	connectionId?: string;
	agentId?: string;
	[key: string]: unknown;
}
export interface OauthResult {
	action?: string;
	ok?: boolean;
	[key: string]: unknown;
}

/* ─── Authoritative catalogue ───────────────────────────────────── */

export interface GatewayMethodSignatures {
	"memory.write": { params: MemoryWriteParams; result: MemoryWriteResult };
	"memory.manage": { params: MemoryManageParams; result: MemoryManageResult };
	"agents.add": { params: AgentsAddParams; result: AgentsManageResult };
	"agents.delete": { params: AgentsDeleteParams; result: AgentsManageResult };
	"agents.set-identity": { params: AgentsSetIdentityParams; result: AgentsManageResult };
	"skills.create": { params: SkillsCreateParams; result: SkillsManageResult };
	"skills.delete": { params: SkillsDeleteParams; result: SkillsManageResult };
	"skills.write-file": { params: SkillsWriteFileParams; result: SkillsManageResult };
	"channels.connect": { params: ChannelsConnectParams; result: ChannelsActionResult };
	"channels.disconnect": { params: ChannelsDisconnectParams; result: ChannelsActionResult };
	"channels.allow-add": { params: ChannelsAllowParams; result: ChannelsAllowResult };
	"channels.allow-remove": { params: ChannelsAllowParams; result: ChannelsAllowResult };
	"channels.allow-list": { params: ChannelsAllowListParams; result: ChannelsAllowListResult };
	"provider.remove": { params: ProviderRemoveParams; result: ProviderRemoveResult };
	composio: { params: ComposioParams; result: ComposioResult };
	oauth: { params: OauthParams; result: OauthResult };
	"config.get": { params: ConfigGetParams; result: ConfigGetResult };
	"config.set": { params: ConfigSetParams; result: ConfigSetResult };
	"config.unset": { params: ConfigUnsetParams; result: ConfigUnsetResult };
	"config.list": { params: ConfigListParams; result: ConfigListResult };
	"config.schema": { params: ConfigSchemaParams; result: ConfigSchemaResult };
	"config.validate": { params: ConfigValidateParams; result: ConfigValidateResult };
	"exec.list": { params: ExecListParams; result: ExecListResult };
	"exec.allow": { params: ExecAllowParams; result: ExecMutateResult };
	"exec.allow-pattern": { params: ExecAllowPatternParams; result: ExecMutateResult };
	"exec.remove": { params: ExecRemoveParams; result: ExecRemoveResult };
	"exec.deny-test": { params: ExecDenyTestParams; result: ExecDenyTestResult };
	"agents.bindings": { params: AgentsBindingsParams; result: AgentsBindingsResult };
	"agents.bind": { params: AgentsBindParams; result: AgentsBindResult };
	"agents.unbind": { params: AgentsUnbindParams; result: AgentsUnbindResult };
	"pairing.list": { params: PairingListParams; result: PairingListResult };
	"pairing.approve": { params: PairingApproveParams; result: PairingApproveResult };
	"pairing.revoke": { params: PairingRevokeParams; result: PairingRevokeResult };
	"sessions.cleanup": { params: SessionsCleanupParams; result: SessionsCleanupResult };
	"sessions.send": { params: SessionsSendParams; result: SessionsSendResult };
	"sessions.spawn": { params: SessionsSpawnParams; result: SessionsSpawnResult };
	"sessions.list": { params: SessionsListParams; result: SessionsListResult };
	"sessions.history": { params: SessionsHistoryParams; result: SessionsHistoryResult };
	"sessions.abort": { params: SessionsAbortParams; result: { ok: boolean } };
	"sessions.patch": { params: SessionsPatchParams; result: SessionsPatchResult };
	agent: { params: AgentParams; result: AgentResult };
	"cron.add": { params: CronAddParams; result: CronAddResult };
	"cron.list": { params: CronListParams; result: CronListResult };
	"cron.status": { params: CronStatusParams; result: CronStatusResult };
	"cron.update": { params: CronUpdateParams; result: CronUpdateResult };
	"cron.remove": { params: CronRemoveParams; result: CronRemoveResult };
	"cron.run": { params: CronRunParams; result: CronRunResult };
	"cron.runs": { params: CronRunsParams; result: CronRunsResult };
	wake: { params: WakeParams; result: WakeResult };
	"approvals.respond": { params: ApprovalsRespondParams; result: ApprovalsRespondResult };
	health: { params: HealthParams; result: HealthResult };
	"org.snapshot": { params: OrgSnapshotParams; result: OrgSnapshotResult };
}

export type GatewayMethodName = keyof GatewayMethodSignatures;
