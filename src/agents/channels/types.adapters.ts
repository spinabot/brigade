/**
 * Channel plugin sub-adapter interfaces.
 *
 * Brand-scrubbed analogue of upstream's `src/channels/plugins/types.adapters.ts`,
 * scoped to the 8 adapters the channel-manager fan-out (Step 16) MUST
 * consume. Other upstream adapters (allowlist, doctor, agentPrompt,
 * setupWizard, etc.) are slotted in the `ChannelPlugin` type with an
 * `unknown` shape and lifted to concrete interfaces as later steps need
 * them.
 *
 * Adapter contract recap:
 *
 *   1. `ChannelConfigAdapter<R>`      — account discovery + enable/disable
 *      (always required).
 *   2. `ChannelGatewayAdapter<R>`     — start/stop the inbound listener
 *      per account; the dispatch entry point.
 *   3. `ChannelOutboundAdapter`       — sendText / sendMedia / sendReaction.
 *   4. `ChannelSecurityAdapter<R>`    — DM policy decisions + audit
 *      findings.
 *   5. `ChannelLifecycleAdapter`      — config-change / removal hooks.
 *   6. `ChannelStatusAdapter<R,P,A>`  — probe + snapshot for `brigade
 *      status` UX.
 *   7. `ChannelMessageActionAdapter`  — DEAD SLOT (not consumed); message
 *      actions flow through the runtime `ChannelAdapter.handleAction` instead.
 *   8. `ChannelSecretsAdapter`        — secret-target registry entries.
 *
 * Every adapter is OPTIONAL on the `ChannelPlugin` slot list — a channel
 * that doesn't support a capability simply omits the slot. The manager
 * checks `capabilities.<flag>` first (Step 15's `ChannelCapabilities`)
 * and only calls the adapter when the flag is `true`.
 */

import type { BrigadeConfig } from "../../config/types.js";
import type {
	ChannelAccountSnapshot,
	ChannelAccountState,
	ChannelCapabilitiesDiagnostics,
	ChannelCapabilitiesDisplayLine,
	ChannelStatusIssue,
	RuntimeEnv,
} from "./types.core.js";

/* -------------------------------------------------------------------------
 * Context shared across multiple adapters
 * --------------------------------------------------------------------- */

/** Per-account gateway context — handed to `startAccount` / `stopAccount`. */
export type ChannelGatewayContext<ResolvedAccount = unknown> = {
	account: ResolvedAccount;
	accountId: string;
	cfg: BrigadeConfig;
	runtime: RuntimeEnv;
	signal?: AbortSignal;
};

/** Per-account logout context — handed to `logoutAccount`. */
export type ChannelLogoutContext<ResolvedAccount = unknown> = ChannelGatewayContext<ResolvedAccount> & {
	/** If true, blow away local creds entirely (for fully fresh re-login). */
	purge?: boolean;
};

/** Result returned from `logoutAccount`. */
export type ChannelLogoutResult = {
	ok: boolean;
	error?: string;
};

/** Per-call context for security adapter — used by every check method. */
export type ChannelSecurityContext<ResolvedAccount = unknown> = {
	account: ResolvedAccount;
	accountId: string;
	cfg: BrigadeConfig;
	peerId?: string;
	peerKind?: string;
};

/** Result of `security.resolveDmPolicy`. */
export type ChannelSecurityDmPolicy = "owner" | "allow-from" | "all";

/* -------------------------------------------------------------------------
 * Type-discovery helpers (bivariant callbacks)
 * --------------------------------------------------------------------- */

/**
 * Wraps a function reference so TypeScript treats the function-typed
 * field as bivariant. Channel plugins occasionally need a narrower
 * `account` type at the call site than the manager's generic; the
 * bivariant box lets the rename through without `as` casts.
 */
export type BivariantCallback<T extends (...args: never[]) => unknown> = { bivarianceHack: T }["bivarianceHack"];

/* -------------------------------------------------------------------------
 * Adapter 1: ChannelConfigAdapter
 * --------------------------------------------------------------------- */

/** Account-snapshot info that callers ALWAYS read first. */
export type ChannelConfigAdapter<ResolvedAccount = unknown> = {
	/** List every accountId configured for this channel. */
	listAccountIds: (cfg: BrigadeConfig) => string[];
	/** Resolve a configured account by id (or default when id is omitted). */
	resolveAccount: (cfg: BrigadeConfig, accountId?: string | null) => ResolvedAccount;
	/** Inspect-only resolve for diagnostics — never mutates. */
	inspectAccount?: (cfg: BrigadeConfig, accountId?: string | null) => unknown;
	/** Stable default account id when no explicit id was provided. */
	defaultAccountId?: (cfg: BrigadeConfig) => string;
	/** Set enabled flag on an account (returns the updated cfg). */
	setAccountEnabled?: (params: {
		cfg: BrigadeConfig;
		accountId: string;
		enabled: boolean;
	}) => BrigadeConfig;
	/** Remove an account from the config (returns the updated cfg). */
	deleteAccount?: (params: { cfg: BrigadeConfig; accountId: string }) => BrigadeConfig;
	/** Is this account currently enabled in the config? */
	isEnabled?: BivariantCallback<(account: ResolvedAccount, cfg: BrigadeConfig) => boolean>;
	/** Human-readable reason for disabled state. */
	disabledReason?: BivariantCallback<(account: ResolvedAccount, cfg: BrigadeConfig) => string>;
	/** Does the account have all required configuration to operate? */
	isConfigured?: BivariantCallback<
		(account: ResolvedAccount, cfg: BrigadeConfig) => boolean | Promise<boolean>
	>;
	/** Human-readable reason for unconfigured state. */
	unconfiguredReason?: BivariantCallback<(account: ResolvedAccount, cfg: BrigadeConfig) => string>;
	/** Build the snapshot row surfaced by `brigade status`. */
	describeAccount?: BivariantCallback<
		(account: ResolvedAccount, cfg: BrigadeConfig) => ChannelAccountSnapshot
	>;
	/** Read the per-account allow-from list (sender ids that may DM the agent). */
	resolveAllowFrom?: (params: {
		cfg: BrigadeConfig;
		accountId?: string | null;
	}) => Array<string | number> | undefined;
	/** Truthy iff at least one account is configured in `cfg`. */
	hasConfiguredState?: (params: { cfg: BrigadeConfig; env?: NodeJS.ProcessEnv }) => boolean;
	/** Truthy iff at least one account has persisted auth state on disk. */
	hasPersistedAuthState?: (params: { cfg: BrigadeConfig; env?: NodeJS.ProcessEnv }) => boolean;
	/** Default outbound `to` field when none was specified by the caller. */
	resolveDefaultTo?: (params: {
		cfg: BrigadeConfig;
		accountId?: string | null;
	}) => string | undefined;
};

/* -------------------------------------------------------------------------
 * Adapter 2: ChannelGatewayAdapter — inbound entry point
 * --------------------------------------------------------------------- */

export type ChannelGatewayAdapter<ResolvedAccount = unknown> = {
	/** Spin up the listener for this account. */
	startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
	/** Tear down the listener for this account. */
	stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
	/** Tear down + purge creds for this account. */
	logoutAccount?: (ctx: ChannelLogoutContext<ResolvedAccount>) => Promise<ChannelLogoutResult>;
	/**
	 * Paths the gateway HTTP server should NOT require operator auth for
	 * (e.g. webhook endpoints the upstream service needs to POST to). The
	 * gateway router consults this list per-request.
	 */
	resolveGatewayAuthBypassPaths?: (params: { cfg: BrigadeConfig }) => string[];
};

/* -------------------------------------------------------------------------
 * Adapter 3: ChannelOutboundAdapter — message dispatch
 * --------------------------------------------------------------------- */

/** A small reusable address shape for outbound calls. */
export type ChannelOutboundTarget = {
	channel: string;
	to: string;
	accountId?: string;
	threadId?: string;
};

export type ChannelOutboundAdapter = {
	sendText?: (params: {
		cfg: BrigadeConfig;
		runtime: RuntimeEnv;
		target: ChannelOutboundTarget;
		text: string;
		signal?: AbortSignal;
	}) => Promise<{ ok: boolean; messageId?: string; error?: string }>;
	sendMedia?: (params: {
		cfg: BrigadeConfig;
		runtime: RuntimeEnv;
		target: ChannelOutboundTarget;
		mediaUrl: string;
		mediaType?: string;
		caption?: string;
		signal?: AbortSignal;
	}) => Promise<{ ok: boolean; messageId?: string; error?: string }>;
	sendReaction?: (params: {
		cfg: BrigadeConfig;
		runtime: RuntimeEnv;
		target: ChannelOutboundTarget;
		messageId: string;
		emoji: string;
		signal?: AbortSignal;
	}) => Promise<{ ok: boolean; error?: string }>;
};

/* -------------------------------------------------------------------------
 * Adapter 4: ChannelSecurityAdapter
 * --------------------------------------------------------------------- */

export type ChannelSecurityAuditFinding = {
	checkId: string;
	severity: "info" | "warn" | "critical";
	title: string;
	detail: string;
	remediation?: string;
};

export type ChannelSecurityAdapter<ResolvedAccount = unknown> = {
	/**
	 * Decide the DM policy for an account: who is allowed to message it
	 * privately. `null` means "channel takes no opinion; defer to the
	 * gateway default".
	 */
	resolveDmPolicy?: BivariantCallback<
		(ctx: ChannelSecurityContext<ResolvedAccount>) => ChannelSecurityDmPolicy | null
	>;
	/** Surface human-readable warnings for `brigade doctor`. */
	collectWarnings?: BivariantCallback<
		(ctx: ChannelSecurityContext<ResolvedAccount>) => Promise<string[]> | string[]
	>;
	/** Structured audit findings for the security audit report. */
	collectAuditFindings?: BivariantCallback<
		(
			ctx: ChannelSecurityContext<ResolvedAccount> & {
				sourceConfig: BrigadeConfig;
				orderedAccountIds: string[];
			},
		) => Promise<ChannelSecurityAuditFinding[]> | ChannelSecurityAuditFinding[]
	>;
};

/* -------------------------------------------------------------------------
 * Adapter 5: ChannelLifecycleAdapter
 * --------------------------------------------------------------------- */

export type ChannelLifecycleAdapter = {
	/** Fires when the operator changes the config for a tracked account. */
	onAccountConfigChanged?: (params: {
		prevCfg: BrigadeConfig;
		nextCfg: BrigadeConfig;
		accountId: string;
		runtime: RuntimeEnv;
	}) => Promise<void> | void;
	/** Fires when the operator removes an account. */
	onAccountRemoved?: (params: {
		prevCfg: BrigadeConfig;
		accountId: string;
		runtime: RuntimeEnv;
	}) => Promise<void> | void;
	/** Fires once at gateway boot to perform any state migrations / repair. */
	runStartupMaintenance?: (params: {
		cfg: BrigadeConfig;
		env?: NodeJS.ProcessEnv;
		log: {
			info?: (message: string) => void;
			warn?: (message: string) => void;
		};
	}) => Promise<void> | void;
};

/* -------------------------------------------------------------------------
 * Adapter 6: ChannelStatusAdapter
 * --------------------------------------------------------------------- */

export type ChannelStatusAdapter<ResolvedAccount = unknown, Probe = unknown, Audit = unknown> = {
	/** Default per-account snapshot baseline before probe data lands. */
	defaultRuntime?: ChannelAccountSnapshot;
	/** Skip the gateway's stale-socket health check (used for stateless plugins). */
	skipStaleSocketHealthCheck?: boolean;
	/** Liveness probe — returns plugin-defined probe payload. */
	probeAccount?: BivariantCallback<
		(params: { account: ResolvedAccount; timeoutMs: number; cfg: BrigadeConfig }) => Promise<Probe>
	>;
	/** Format probe payload to display lines for `brigade status`. */
	formatCapabilitiesProbe?: BivariantCallback<
		(params: { probe: Probe }) => ChannelCapabilitiesDisplayLine[]
	>;
	/** Heavier audit-style check — runs less often than probe. */
	auditAccount?: BivariantCallback<
		(params: {
			account: ResolvedAccount;
			timeoutMs: number;
			cfg: BrigadeConfig;
			probe?: Probe;
		}) => Promise<Audit>
	>;
	/** Diagnostics block for `brigade status --verbose`. */
	buildCapabilitiesDiagnostics?: BivariantCallback<
		(params: {
			account: ResolvedAccount;
			timeoutMs: number;
			cfg: BrigadeConfig;
			probe?: Probe;
			audit?: Audit;
		}) => Promise<ChannelCapabilitiesDiagnostics | undefined>
	>;
	/** Final account snapshot row surfaced to the status table. */
	buildAccountSnapshot?: BivariantCallback<
		(params: {
			account: ResolvedAccount;
			cfg: BrigadeConfig;
			runtime?: ChannelAccountSnapshot;
			probe?: Probe;
			audit?: Audit;
		}) => ChannelAccountSnapshot | Promise<ChannelAccountSnapshot>
	>;
	/** Resolve the account's lifecycle state. */
	resolveAccountState?: BivariantCallback<
		(params: {
			account: ResolvedAccount;
			cfg: BrigadeConfig;
			configured: boolean;
			enabled: boolean;
		}) => ChannelAccountState
	>;
	/** Status-row collection for the rollup view. */
	collectStatusIssues?: (accounts: ChannelAccountSnapshot[]) => ChannelStatusIssue[];
};

/* -------------------------------------------------------------------------
 * Adapter 7: ChannelMessageActionAdapter — tool-driven outbound actions
 *
 * ⚠️ DEAD SLOT — DO NOT IMPLEMENT FOR MESSAGE ACTIONS. This typed adapter
 * (the `ChannelPlugin.actions` slot) is NOT consumed by the live message-action
 * path. The agent's `message_action` tool dispatches through the runtime
 * `ChannelAdapter.handleAction({ conversationId, action, accountId?, signal? })`
 * (see `agents/extensions/types.ts`), NOT through this `{ cfg, runtime,
 * accountId, target, action, signal }` shape. A channel author who implements
 * ONLY this typed adapter gets NO message actions. The CANONICAL path is the
 * single-account `ChannelAdapter.handleAction` — implement that + advertise the
 * matching `capabilities` flag. This type is retained only so the existing
 * bundled Telegram plugin's harmless `actions` field keeps compiling; it is no
 * longer part of the author-facing channel SDK barrel.
 * --------------------------------------------------------------------- */

/** Discriminator for the actions the agent can take on a channel message. */
export type ChannelMessageAction =
	| { kind: "reply"; text: string; threadId?: string }
	| { kind: "react"; messageId: string; emoji: string }
	| { kind: "edit"; messageId: string; text: string }
	| { kind: "delete"; messageId: string }
	| { kind: "pin"; messageId: string }
	| { kind: "unpin"; messageId: string }
	/**
	 * Create a forum topic (Telegram supergroups). `name` is the topic title;
	 * the optional icon fields style it. The result's `messageId` carries the new
	 * topic's thread id so the agent can send into it.
	 */
	| { kind: "topic-create"; name: string; iconColor?: number; iconCustomEmojiId?: string }
	/**
	 * Send a NEW message carrying a general inline keyboard. `text` is the message
	 * body; `buttons` is a grid of `{ text, data }` specs. A press posts the
	 * button's `data` back through the inbound pipeline as a turn (namespaced so
	 * it never collides with approval callbacks). The result's `messageId` is the
	 * sent message's id. Channels without inline buttons report it unsupported.
	 */
	| { kind: "buttons"; text: string; buttons: Array<Array<{ text: string; data: string }>>; threadId?: string };

export type ChannelMessageActionResult = {
	ok: boolean;
	messageId?: string;
	error?: string;
};

/**
 * @deprecated DEAD SLOT — not read by the message-action path. Implement the
 * runtime `ChannelAdapter.handleAction({ conversationId, action, accountId?,
 * signal? })` instead (the `message_action` tool dispatches through THAT). See
 * the block comment above.
 */
export type ChannelMessageActionAdapter = {
	handleAction?: (params: {
		cfg: BrigadeConfig;
		runtime: RuntimeEnv;
		accountId: string;
		target: ChannelOutboundTarget;
		action: ChannelMessageAction;
		signal?: AbortSignal;
	}) => Promise<ChannelMessageActionResult>;
};

/* -------------------------------------------------------------------------
 * Adapter 8: ChannelSecretsAdapter
 * --------------------------------------------------------------------- */

/**
 * A registry entry tells Brigade's secrets system "this config path
 * holds a secret-ref token that needs resolution before use". Channel
 * plugins declare which of their config paths (e.g.
 * `channels.slack.accounts.*.botToken`) qualify.
 */
export type SecretTargetRegistryEntry = {
	/** Wildcard-supporting config path (e.g. `channels.slack.accounts.*.botToken`). */
	path: string;
	/** Human-readable hint for setup wizards / docs. */
	description?: string;
};

export type ChannelSecretsAdapter = {
	secretTargetRegistryEntries?: readonly SecretTargetRegistryEntry[];
};

/* -------------------------------------------------------------------------
 * Adapter 9: ChannelApprovalCapability (Step 17)
 *
 * Bridges Brigade's existing approval-router (`agents/channels/approval-router.ts`)
 * with channel-native rendering. When a tool-call needs operator approval AND
 * the originating turn came in via a channel route, the approval-router dispatches
 * the prompt through THIS adapter so the operator gets the approval question in
 * the same conversation, not just on the gateway WebSocket.
 *
 * Three responsibilities:
 *   1. `sendApprovalPrompt` — render + post the approval question to the channel.
 *   2. `decodeApprovalReply` — interpret the operator's text reply ("yes" /
 *      "always" / "no") as a decision kind, or `null` if not an approval reply.
 *   3. `formatApprovalOutcome` — optional confirmation message posted back
 *      after the decision lands ("✓ Allowed and saved to allowlist").
 *
 * The approval-router itself is already in place (registerChannelApprovalDispatcher,
 * tryConsumeChannelApprovalReply, etc.); Step 17 just adds the typed adapter
 * surface so channel plugins can declare their capability statically.
 * --------------------------------------------------------------------- */

export type ChannelApprovalKind = "exec" | "plugin";

export type ChannelApprovalDecisionKind =
	| "allow-once"
	| "allow-always"
	| "allow-pattern"
	| "deny";

export type ChannelApprovalPromptParams = {
	runtime: RuntimeEnv;
	cfg: BrigadeConfig;
	/** The channel-side conversation id the approval is for. */
	conversationId: string;
	/** Optional account scope (for multi-account channels). */
	accountId?: string;
	/** Optional thread id for threaded channels. */
	threadId?: string;
	/** Stable id the operator's reply must reference back to. */
	approvalId: string;
	approvalKind: ChannelApprovalKind;
	/** The command (or plugin action) the operator is approving. */
	command: string;
	/** Tool name that initiated the approval (for display). */
	toolName?: string;
	/** Working directory at the time of the call (for display). */
	cwd?: string;
	/** Timeout in ms after which the prompt is auto-denied. */
	timeoutMs: number;
};

export type ChannelApprovalOutcomeParams = {
	decision: ChannelApprovalDecisionKind;
	command: string;
	approvalKind: ChannelApprovalKind;
};

export type ChannelApprovalCapability = {
	/**
	 * Render + post the approval prompt to the channel. Implementation is
	 * channel-native: Telegram uses inline buttons, Slack a thread reply with
	 * a slash-command hint, WhatsApp a numbered text menu, etc.
	 *
	 * The adapter is NOT responsible for tracking the pending approval —
	 * `approval-router.ts` does that. The adapter just posts the question.
	 */
	sendApprovalPrompt?: (params: ChannelApprovalPromptParams) => Promise<void>;

	/**
	 * Parse an operator reply into a decision kind. Liberal matching: "yes"
	 * / "y" / "ok" / "allow" → `"allow-once"`; "always" / "save" / "remember"
	 * → `"allow-always"`; "no" / "n" / "deny" / "cancel" → `"deny"`. Returns
	 * `null` if the text isn't an approval reply (normal chat message that
	 * happens to arrive while an approval is pending — defer to the agent
	 * dispatcher).
	 */
	decodeApprovalReply?: (text: string) => ChannelApprovalDecisionKind | null;

	/**
	 * Optionally post a confirmation back to the conversation after the
	 * decision lands. Return `undefined` to skip; return a string to post
	 * via the channel's outbound surface.
	 */
	formatApprovalOutcome?: (params: ChannelApprovalOutcomeParams) => string | undefined;

	/**
	 * Authorize a specific sender for an approval action. Channels that have
	 * a multi-operator model (Slack workspace with multiple members) return
	 * `{ authorized: false, reason }` for non-operators.
	 */
	authorizeApprover?: (params: {
		cfg: BrigadeConfig;
		accountId?: string;
		senderId?: string;
		action: "approve";
		approvalKind: ChannelApprovalKind;
	}) => { authorized: boolean; reason?: string };
};

/* -------------------------------------------------------------------------
 * Adapter 10: ChannelMessagingAdapter — OUTBOUND addressing contract
 *
 * Fills the formerly-`unknown` `ChannelPlugin.messaging` slot with a small,
 * practical interface for the OUTBOUND half of message addressing: turning the
 * loose `to` the agent hands `send_message` ("Alex", "@alex", "telegram:123")
 * into a concrete conversation/target id the runtime `ChannelAdapter.sendText`
 * understands.
 *
 * The send tool runs the methods in this order when a channel opts in:
 *   1. `parseExplicitTarget(to)` — if the agent wrote an explicit form
 *      (`telegram:123456`, `@handle`, `whatsapp:+1555…`), pull out the target
 *      (and an optional cross-channel id). `null` means "not an explicit form".
 *   2. `normalizeTarget(raw)` — canonicalise whatever target we now hold (the
 *      parsed one, or the original `to`) to the channel's id shape.
 *   3. `targetResolver(name)` — OPTIONAL. When the `to` looks like a human
 *      NAME/handle (not already a concrete id) AND the channel ships a contact
 *      directory, resolve it to a real conversation id. A channel WITHOUT a
 *      directory OMITS this method, and the caller falls back to the raw id —
 *      so back-compat is preserved by construction.
 *
 * ⚠️ OUTBOUND ONLY. The INBOUND counterpart (resolving an incoming peer id back
 * to a stable conversation/session identity) lives in the inbound pipeline and
 * is intentionally NOT part of this adapter.
 *
 * Every method except `parseExplicitTarget` + `normalizeTarget` is optional;
 * the whole adapter is optional on `ChannelPlugin` (channels opt in). A channel
 * that omits `messaging` entirely behaves EXACTLY as today: the agent's raw
 * `to` is handed straight to `sendText`.
 * --------------------------------------------------------------------- */

/** Result of {@link ChannelMessagingAdapter.parseExplicitTarget}. */
export type ParsedExplicitTarget = {
	/**
	 * The channel id the explicit form named, when it carried one (e.g.
	 * `telegram:123` → `"telegram"`). Omitted for channel-less forms like a
	 * bare `@handle`, where the target is implicitly the current channel.
	 */
	channelId?: string;
	/** The concrete (still un-normalized) target the explicit form addressed. */
	target: string;
};

export type ChannelMessagingAdapter = {
	/**
	 * Recognize an EXPLICIT outbound target form in free text and split it into
	 * an optional channel id + the bare target. Examples a channel might accept:
	 *   - `telegram:123456`   → `{ channelId: "telegram", target: "123456" }`
	 *   - `whatsapp:+15551234`→ `{ channelId: "whatsapp", target: "+15551234" }`
	 *   - `@handle`           → `{ target: "@handle" }`
	 * Return `null` when the text is NOT an explicit form (a plain name, or an
	 * already-concrete id with no scheme) — the caller then treats the input as
	 * a raw target / name and continues with `normalizeTarget` (+ resolver).
	 */
	parseExplicitTarget: (text: string) => ParsedExplicitTarget | null;

	/**
	 * Canonicalise a target id into the channel's stable id shape (trim, drop a
	 * leading `@`, append a WhatsApp JID suffix, lowercase a Slack id, …). MUST
	 * be idempotent: `normalizeTarget(normalizeTarget(x)) === normalizeTarget(x)`.
	 * Receives whatever target the caller currently holds (the parsed explicit
	 * target, or the original `to`).
	 */
	normalizeTarget: (raw: string) => string;

	/**
	 * Best-effort guess of whether a (normalized) target is a 1:1 DM or a group.
	 * Returns `undefined` when the channel can't tell from the id alone. Purely
	 * advisory — the send path does not require it.
	 */
	inferTargetChatType?: (target: string) => "dm" | "group" | undefined;

	/**
	 * OPTIONAL contact-directory hook: resolve a human NAME or handle (e.g.
	 * "Alex", "@alex") to a concrete conversation/target id. A channel that has
	 * a contact directory implements this; a channel WITHOUT one OMITS it, and
	 * the send tool falls back to the raw id (no behaviour change). Return
	 * `null` (sync or async) when the name doesn't resolve, so the caller can
	 * decide whether to fall back or refuse.
	 */
	targetResolver?: (name: string) => Promise<string | null> | string | null;

	/**
	 * Human-readable label for a (normalized) target, for echoing back in tool
	 * results / logs ("Alex (telegram:123456)"). Falls back to the raw target
	 * when omitted.
	 */
	formatTargetDisplay?: (target: string) => string;
};
