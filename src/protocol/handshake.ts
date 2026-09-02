/**
 * Connect-frame + capability negotiation (Step 24).
 *
 * Brand-scrubbed analogue of upstream's connect/hello flow. Defines the
 * THREE moving parts of the handshake:
 *
 *   - `PROTOCOL_VERSION`  — single integer; bumped ONLY on FRAMING
 *                           incompatibility (a client can no longer parse the
 *                           frames). Behaviour changes ride `features.
 *                           capabilities` instead — see below.
 *   - `ConnectParams`     — what the client sends in its first frame
 *   - `HelloOk`           — server's reply confirming version + features
 *
 * Brigade's gateway accepts clients of multiple types (TUI, web UI,
 * mobile, in-process agent tools). The shapes here are agnostic to
 * transport — the same types describe an in-process call and a remote
 * WebSocket.
 */

/**
 * Framing version. Deliberately still 1, and expected to stay there.
 *
 * Nothing in Brigade or in its known clients COMPARES this number — it is
 * advertised in `hello-ok` and in `/health` and read nowhere. And Brigade
 * cannot serve two behaviours at once, so bumping it could only ever mean
 * "something changed, take it or leave it". For a client doing a strict
 * `=== 1` check that is a hard outage in exchange for zero information.
 *
 * Every project that solved this with third-party clients reached the same
 * answer: LSP has no version number at all, only capabilities; DAP froze at 1
 * on purpose ("an explicit design goal to support new features in a completely
 * backward compatible way"); MCP keeps a date string for wire-incompatible
 * changes and moves everything else into capabilities/extensions.
 *
 * So: a behaviour change gets a CAPABILITY plus an opt-out on the call that
 * changed. A version bump is reserved for the one case a capability cannot
 * express — the frames themselves becoming unparseable.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Behaviours a client can detect and opt into, by name.
 *
 * An unknown string is ignorable by construction, which is what makes this
 * safe to extend — unlike an integer, where "newer than me" is the only
 * possible reading. Brigade's desktop client already feature-detects off
 * `features.methods`, so this reuses a channel that is live and proven.
 */
export const PROTOCOL_CAPABILITIES = [
	/** `subscribe { deltas: true }` — content-stripped `message_update` frames. */
	"subscribe.deltas",
	/** `subscribe { scope: "session" | "agent" }` — how broadly frames are delivered. */
	"subscribe.scope",
	/** `resume { seq }` — gap-free replay from a per-session sequence cursor. */
	"resume.seq",
] as const;

export type ProtocolCapability = (typeof PROTOCOL_CAPABILITIES)[number];

/* ─── Client identity ───────────────────────────────────────────── */

export const GatewayClientIds = {
	TUI: "brigade-tui",
	WEB_UI: "brigade-web",
	WEBCHAT: "brigade-webchat",
	CLI: "cli",
	GATEWAY_CLIENT: "gateway-client",
	MACOS_APP: "brigade-macos",
	IOS_APP: "brigade-ios",
	ANDROID_APP: "brigade-android",
	NODE_HOST: "node-host",
	TEST: "test",
	PROBE: "brigade-probe",
} as const;

export type GatewayClientId = (typeof GatewayClientIds)[keyof typeof GatewayClientIds];

export const GatewayClientModes = {
	WEBCHAT: "webchat",
	CLI: "cli",
	UI: "ui",
	BACKEND: "backend",
	NODE: "node",
	PROBE: "probe",
	TEST: "test",
} as const;

export type GatewayClientMode = (typeof GatewayClientModes)[keyof typeof GatewayClientModes];

export interface GatewayClientInfo {
	id: GatewayClientId;
	displayName?: string;
	version: string;
	platform: string;
	deviceFamily?: string;
	modelIdentifier?: string;
	mode: GatewayClientMode;
	instanceId?: string;
}

/* ─── Operator scopes ───────────────────────────────────────────── */

export const OperatorScopes = {
	ADMIN: "admin",
	APPROVALS: "approvals",
	PAIRING: "pairing",
	READ: "read",
	TALK_SECRETS: "talk-secrets",
	WRITE: "write",
} as const;

export type OperatorScope = (typeof OperatorScopes)[keyof typeof OperatorScopes];

/* ─── Connect frame (client → server) ───────────────────────────── */

export interface ConnectParams {
	minProtocol: number;
	maxProtocol: number;
	client: GatewayClientInfo;
	caps?: readonly string[];
	commands?: readonly string[];
	permissions?: Record<string, boolean>;
	role?: "operator" | "node" | "device" | string;
	scopes?: readonly OperatorScope[];
	auth?: {
		token?: string;
		bootstrapToken?: string;
		deviceToken?: string;
		password?: string;
	};
	locale?: string;
	userAgent?: string;
}

/* ─── Hello-ok reply (server → client) ──────────────────────────── */

export interface HelloOk {
	type: "hello-ok";
	protocol: number;
	server: {
		version: string;
		connId: string;
		/**
		 * Per-process boot id (session generation / "epoch"). Changes whenever
		 * the gateway process restarts. A client compares the epoch across
		 * (re)connections: if it changed, the server's per-session seq counters
		 * reset, so the client must invalidate its seq cursors and re-`resume`
		 * rather than infer a restart from a backwards seq. This makes cursor
		 * invalidation explicit + correct, rather than inferred from a
		 * backwards-jumping seq.
		 */
		epoch: string;
	};
	features: {
		methods: readonly string[];
		events: readonly string[];
		/**
		 * Named behaviours this gateway supports. Absent on older gateways, so a
		 * client must treat `undefined` as "none of them".
		 */
		capabilities?: readonly string[];
	};
	policy: {
		maxPayload: number;
		maxBufferedBytes: number;
		tickIntervalMs: number;
	};
	auth?: {
		deviceToken?: string;
		role?: string;
		scopes?: readonly OperatorScope[];
		issuedAtMs?: number;
	};
}
