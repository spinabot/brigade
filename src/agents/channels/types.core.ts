/**
 * Channel plugin contract — core types shared across every adapter.
 *
 * Brand-scrubbed analogue of upstream's `src/channels/plugins/types.core.ts`.
 * The shapes here are domain-neutral (no upstream-specific identifiers),
 * so the lift is mostly a rename pass: upstream `Config` type → `BrigadeConfig`.
 *
 * Conventions:
 *
 *   - `ChannelId` is the canonical, kebab-case plugin id (`whatsapp`,
 *     `slack`, `telegram`, `discord`). It's also the directory name
 *     under `extensions/<id>/` and the key under `cfg.channels.<id>`.
 *
 *   - `ChannelMeta` is the user-facing display surface (labels, blurb,
 *     docs paths). The CLI setup wizard, the device-pairing UI, and
 *     the `brigade status` view all read from this.
 *
 *   - `ChannelCapabilities` is the static "what this plugin can do"
 *     declaration. Channel-manager (Step 16) uses these flags to pre-
 *     check whether a sub-adapter call is even worth attempting (e.g.
 *     `capabilities.reactions === false` → skip the `sendReaction`
 *     dispatch entirely).
 *
 *   - `RuntimeEnv` is a placeholder for the cross-cutting runtime
 *     context (process logger, abort signal, plugin runtime helpers,
 *     etc.) that gets handed to every adapter that needs side effects.
 *     Brigade narrows this in Step 16 when the channel-manager lift
 *     wires the actual runtime; today it's deliberately loose so the
 *     contract can be defined without dragging the manager in first.
 */

import type { ChatType } from "./chat-type.js";

/** Canonical, kebab-case plugin id. */
export type ChannelId = string;

/**
 * Per-surface visibility overrides for a channel.
 *
 * Three independent toggles — each defaults to `true` (visible) when omitted,
 * so a channel that says nothing is shown everywhere:
 *
 *   - `configured` — list this channel in "configured channels" views
 *     (`brigade status`, account pickers). Default-true; falls back to the
 *     legacy `meta.showConfigured` flag when this object key is absent.
 *   - `setup`      — offer this channel in the onboarding / setup wizard.
 *     Default-true; falls back to the legacy `meta.showInSetup` flag.
 *   - `docs`       — surface this channel in generated docs / help. Default-true.
 *
 * History: an earlier Brigade revision narrowed this to a string union
 * (`"public" | "internal" | "experimental"`), but nothing ever consumed the
 * union — it was inert. The resolver (`resolveChannelExposure`) needs
 * per-surface booleans to drive `isChannelVisibleInSetup` et al., so the
 * object shape is restored (matching the upstream contract the metas were
 * scrubbed from). The booleans compose with the existing `showConfigured` /
 * `showInSetup` meta fields rather than replacing them.
 */
export type ChannelExposure = {
	configured?: boolean;
	setup?: boolean;
	docs?: boolean;
};

/**
 * Static capability flags advertised by a channel plugin.
 *
 * Channel-manager (Step 16) reads these to pre-check sub-adapter calls
 * — a plugin with `reactions: false` won't have `outbound.sendReaction`
 * invoked, even if the dispatcher receives a reaction payload.
 */
export type ChannelCapabilities = {
	/** Which chat shapes the plugin handles ("direct" | "group" | "channel" | "thread"). */
	chatTypes: Array<ChatType | "thread">;
	polls?: boolean;
	reactions?: boolean;
	edit?: boolean;
	unsend?: boolean;
	reply?: boolean;
	effects?: boolean;
	groupManagement?: boolean;
	threads?: boolean;
	media?: boolean;
	nativeCommands?: boolean;
	/**
	 * If `true`, streaming output must be buffered and sent as one final
	 * payload (e.g. SMS gateways that can't update a live message).
	 */
	blockStreaming?: boolean;
};

/** User-facing metadata used in docs, pickers, and setup surfaces. */
export type ChannelMeta = {
	id: ChannelId;
	label: string;
	selectionLabel: string;
	docsPath: string;
	docsLabel?: string;
	blurb: string;
	order?: number;
	aliases?: readonly string[];
	selectionDocsPrefix?: string;
	selectionDocsOmitLabel?: boolean;
	selectionExtras?: readonly string[];
	detailLabel?: string;
	systemImage?: string;
	markdownCapable?: boolean;
	exposure?: ChannelExposure;
	showConfigured?: boolean;
	showInSetup?: boolean;
	quickstartAllowFrom?: boolean;
	forceAccountBinding?: boolean;
	preferSessionLookupForAnnounceTarget?: boolean;
	preferOver?: readonly string[];
};

/** "running" / "stopped" / "errored" — surfaced by `brigade status`. */
export type ChannelAccountState = "running" | "stopped" | "errored" | "starting" | "stopping";

/**
 * Display snapshot returned by `status.buildAccountSnapshot`. The shape
 * is intentionally open — different channels surface different fields.
 */
export type ChannelAccountSnapshot = {
	id: string;
	state?: ChannelAccountState;
	displayName?: string;
	description?: string;
	[key: string]: unknown;
};

/** Single status row for `collectStatusIssues` callers. */
export type ChannelStatusIssue = {
	accountId: string;
	severity: "info" | "warn" | "error";
	message: string;
};

/** Lines emitted by `status.formatCapabilitiesProbe` — one diagnostic per line. */
export type ChannelCapabilitiesDisplayLine = {
	label: string;
	value: string;
	hint?: string;
};

/** Diagnostic block emitted by `status.buildCapabilitiesDiagnostics`. */
export type ChannelCapabilitiesDiagnostics = {
	target?: string;
	lines: ChannelCapabilitiesDisplayLine[];
};

/**
 * Cross-cutting runtime context handed to side-effect adapters.
 *
 * Step 16 narrows this to a concrete interface (logger + abortSignal +
 * runtime helpers); for now the contract accepts an open shape so the
 * plugin SDK can compile without the manager lift landing first.
 */
export type RuntimeEnv = {
	logger?: {
		info?: (message: string, meta?: Record<string, unknown>) => void;
		warn?: (message: string, meta?: Record<string, unknown>) => void;
		error?: (message: string, meta?: Record<string, unknown>) => void;
		debug?: (message: string, meta?: Record<string, unknown>) => void;
	};
	signal?: AbortSignal;
	[key: string]: unknown;
};

export type { ChatType };
