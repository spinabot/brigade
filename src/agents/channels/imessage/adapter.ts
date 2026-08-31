/**
 * iMessage channel adapter.
 *
 * Implements the Brigade `ChannelAdapter` contract on top of the `imsg` CLI
 * driven as a JSON-RPC subprocess (`connection.ts`). iMessage authenticates via
 * the local Messages.app session — there is NO bot token, so enablement is just
 * `channels.imessage.enabled: true` plus a runnable `imsg` binary. The adapter
 * declares a `setup` wizard for the binary path (so `brigade channels add` can
 * configure a non-PATH install) and has no QR/link flow.
 *
 * Modeled on `discord/adapter.ts`: same `isConfigured`→`start` config capture,
 * same health-flag mirroring, same deferred-media passthrough on inbound, same
 * chunk-then-send outbound (chunk the markdown, plain-text-ify each chunk, send).
 *
 * TEST SEAM: `connectImpl` overrides how the connection is built — production
 * leaves it undefined and `connectIMessage` lazy-spawns the subprocess (which
 * itself refuses in tests); a unit test injects a fake connection so send /
 * health / inbound dispatch run with no real binary.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { loadConfig } from "../../../core/config.js";
// Channel SDK barrel — the single import surface for the channel-authoring
// contract + shared helpers.
import {
	chunkText,
	type ChannelAdapter,
	type ChannelCapabilities,
	type ChannelHealth,
	type ChannelMessageActionResult,
	type ChannelStartContext,
	type OutboundMedia,
	type OutboundSendOptions,
} from "../sdk.js";
import {
	imessageChannelEnabled,
	listIMessageAccountIds,
	resolveIMessageAccount,
	resolveIMessageCliPath,
	DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT,
	IMESSAGE_CHANNEL_ID,
	IMESSAGE_DEFAULT_ACCOUNT_ID,
	type IMessageChunkMode,
} from "./account-config.js";
import {
	connectIMessage,
	type ConnectIMessageArgs,
	type IMessageConnection,
	type IMessageInboundMessage,
} from "./connection.js";
import { markdownToIMessageText } from "./format.js";
import { normalizeIMessageAclEntry, normalizeIMessageHandle } from "./targets.js";

/**
 * The identities one inbound message can be allow-listed under.
 *
 * `from` is whatever the chat database stores — `+1 (555) 123-4567`,
 * `User@Example.com`, sometimes an `iMessage;-;` service-prefixed handle. The
 * operator types what the setup wizard showed them. Exact matching between
 * those two spellings fails, so the sender is refused despite being listed.
 *
 * The wizard also documents `chat_id:123`, which describes the THREAD, not the
 * sender, and so could never equal `from` under any spelling. It is listed here
 * so allow-listing a conversation does what the wizard says it does.
 */
function imessageSenderAliases(msg: {
	from: string;
	chatId?: number;
	chatIdentifier?: string;
}): string[] {
	const out = new Set<string>();
	const handle = normalizeIMessageHandle(msg.from);
	if (handle) out.add(handle);
	if (typeof msg.chatId === "number" && Number.isFinite(msg.chatId)) {
		out.add(`chat_id:${msg.chatId}`);
	}
	const ident = normalizeIMessageHandle(msg.chatIdentifier ?? "");
	if (ident) out.add(`chat_identifier:${ident}`);
	return [...out];
}

/** iMessage's practical per-message text limit for chunked sends (default; config can override). */
const IMESSAGE_TEXT_LIMIT = DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT;

/** iMessage capabilities — DMs + groups, media + reply; no edit/unsend/reactions via the bridge. */
export const IMESSAGE_CAPABILITIES: ChannelCapabilities = {
	chatTypes: ["direct", "group"],
	media: true,
	reply: true,
};

/** Adapter construction options — all optional for back-compat. */
export interface CreateIMessageAdapterOptions {
	/** Per-account scope. Defaults to `"default"` (single-account). */
	accountId?: string;
	/**
	 * TEST SEAM: override how the connection is built. Production leaves this
	 * undefined and `connectIMessage` lazy-spawns the `imsg` subprocess. Tests
	 * inject a fake.
	 */
	connectImpl?: (args: ConnectIMessageArgs) => Promise<IMessageConnection>;
}

async function loadStartConfig(): Promise<BrigadeConfig> {
	return loadConfig() as unknown as BrigadeConfig;
}

/**
 * For `chunkMode: "newline"`, break an already-limit-bounded chunk into one piece
 * per line (dropping blank lines), so each non-empty line is delivered as its own
 * message. A line longer than `limit` is left intact (the caller already bounded
 * the chunk to `limit`, so this only ever sub-divides). Returns the original
 * chunk in a single-element array when it has no internal line breaks.
 */
function splitChunkByNewline(chunk: string, limit: number): string[] {
	void limit;
	const lines = chunk.split("\n").map((l) => l.trimEnd());
	const out = lines.filter((l) => l.trim().length > 0);
	return out.length > 0 ? out : [chunk];
}

export function createIMessageAdapter(opts: CreateIMessageAdapterOptions = {}): ChannelAdapter {
	const accountId = opts.accountId?.trim() || IMESSAGE_DEFAULT_ACCOUNT_ID;
	const connectImpl = opts.connectImpl ?? connectIMessage;

	let connection: IMessageConnection | null = null;
	// The manager calls isConfigured(cfg, env) right before start(ctx); capture
	// them so start() reads the resolved account without a second config load.
	let lastConfig: BrigadeConfig | null = null;
	let lastEnv: NodeJS.ProcessEnv = process.env;
	// Health flags mirrored from the connection lifecycle so health() never has to
	// round-trip the subprocess.
	let connected = false;
	let closedReason: string | null = null;
	// Captured from the resolved account at start() so the inbound/outbound paths
	// don't re-resolve config per message.
	let selfHandle = "";
	let textChunkLimit = IMESSAGE_TEXT_LIMIT;
	let chunkMode: IMessageChunkMode = "length";

	const adapter: ChannelAdapter = {
		id: IMESSAGE_CHANNEL_ID,
		label: "iMessage",

		isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean {
			lastConfig = cfg;
			lastEnv = env ?? process.env;
			if (!imessageChannelEnabled(cfg)) return false;
			// Need a resolvable `imsg` binary path (always resolves to at least the
			// default "imsg"); enablement is the real gate.
			if (!resolveIMessageCliPath(cfg, accountId, env ?? process.env)) return false;
			// Multi-account: the plugin path owns lifecycle when >1 account; the
			// legacy single adapter steps aside.
			const isLegacyAdapter = accountId === IMESSAGE_DEFAULT_ACCOUNT_ID;
			if (isLegacyAdapter && listIMessageAccountIds(cfg).length > 1) return false;
			return true;
		},

		async start(ctx: ChannelStartContext): Promise<void> {
			const cfg = lastConfig ?? (await loadStartConfig());
			const account = resolveIMessageAccount(cfg, accountId, lastEnv);
			selfHandle = account.selfHandle;
			textChunkLimit = account.textChunkLimit;
			chunkMode = account.chunkMode;
			try {
				const conn = await connectImpl({
					account,
					loadConfig: () => (lastConfig ?? cfg),
					log: ctx.log,
					...(ctx.signal ? { signal: ctx.signal } : {}),
					onConnected: () => {
						connected = true;
						closedReason = null;
						ctx.log("iMessage connected");
						ctx.onConnected?.();
					},
					onClosed: (reason) => {
						connected = false;
						closedReason = reason;
						ctx.log(`iMessage transport closed: ${reason}`);
						ctx.onLoggedOut?.();
					},
					onMessage: (msg: IMessageInboundMessage) => {
						// Prepend the rolling-history context block (untagged group msg) to
						// the body so the agent replies INTO the conversation.
						const body = msg.historyContext ? `${msg.historyContext}\n\n${msg.text}` : msg.text;
						void ctx.onInbound({
							channel: IMESSAGE_CHANNEL_ID,
							accountId,
							conversationId: msg.conversationId,
							...(msg.messageId ? { messageId: msg.messageId } : {}),
							...(msg.createdAtMs !== undefined ? { messageTimestampMs: msg.createdAtMs } : {}),
							from: msg.from,
							senderAliases: imessageSenderAliases(msg),
							...(msg.fromName !== undefined ? { fromName: msg.fromName } : {}),
							text: body,
							chatType: msg.isGroup ? "group" : "direct",
							isGroup: msg.isGroup,
							// Bot-handle mentions (group requireMention gate fires on these).
							...(msg.mentions && msg.mentions.length > 0 ? { mentions: msg.mentions } : {}),
							...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
							// Deferred media thunk rides through untouched — the pipeline
							// resolves it only after the access gate admits the sender.
							...(msg.resolveMedia ? { resolveMedia: msg.resolveMedia } : {}),
							raw: msg.raw,
						});
					},
				});
				connection = conn;
			} catch (err) {
				connected = false;
				closedReason = err instanceof Error ? err.message : String(err);
				ctx.log(`iMessage failed to start: ${closedReason}`);
			}
		},

		async stop(): Promise<void> {
			await connection?.close();
			connection = null;
			connected = false;
		},

		health(): ChannelHealth {
			if (!connection) {
				// SURFACE THE REASON WE ALREADY CAPTURED.
				//
				// `start()` records the real failure into `closedReason` —
				// "authorization denied" when Full Disk Access is off,
				// "imsg: command not found" when the bridge is missing — and this
				// branch threw it away and said "not started yet", which reads as
				// a transient boot state rather than a permission wall the
				// operator has to go and fix. That is why a denied FDA presented
				// as the channel simply never answering.
				if (closedReason) {
					return {
						ok: false,
						kind: "disconnected",
						reason: `iMessage failed to start — ${closedReason}.`,
						remediation:
							"Check that the imsg CLI is installed and that Terminal has Full Disk Access, then restart the gateway.",
					};
				}
				return { ok: false, kind: "starting", reason: "iMessage adapter is not started yet." };
			}
			// A watch error means the socket is fine and the reader is dead — no
			// message will arrive again, yet every liveness signal says ok.
			const watchErr = connection.lastWatchError?.();
			if (watchErr) {
				return {
					ok: false,
					kind: "disconnected",
					reason: `iMessage is connected but its watch failed — ${watchErr}. Incoming messages are not being read.`,
					remediation:
						"Check Full Disk Access for Terminal and that Messages.app is signed in, then restart the channel.",
				};
			}
			if (!connected || !connection.isConnected()) {
				return {
					ok: false,
					kind: "disconnected",
					reason: closedReason
						? `iMessage is not connected — ${closedReason}.`
						: "iMessage is reconnecting — sends will fail until the imsg bridge resumes.",
					remediation: "Ensure the imsg CLI is installed and Messages.app is signed in.",
				};
			}
			return { ok: true };
		},

		async sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<{ messageId?: string } | void> {
			if (!connection) throw new Error("iMessage channel is not started");
			// Chunk on the raw markdown (so fences/paragraphs aren't shredded), then
			// plain-text-ify each chunk and send. The chunk size is config-driven
			// (`textChunkLimit`); `chunkMode: "newline"` additionally breaks each chunk
			// on single line boundaries (one message per line), where `length` (default)
			// packs lines to the limit.
			const limit = textChunkLimit > 0 ? textChunkLimit : IMESSAGE_TEXT_LIMIT;
			let chunks = chunkText(text, { limit });
			if (chunkMode === "newline") {
				chunks = chunks.flatMap((chunk) => splitChunkByNewline(chunk, limit));
			}
			let first = true;
			let lastMessageId: string | undefined;
			let sentAny = false;
			for (const chunk of chunks) {
				const body = markdownToIMessageText(chunk);
				if (body.trim().length === 0) continue;
				// Native reply target applies to the FIRST chunk only.
				const replyOpt = first && opts?.replyToId ? { replyToId: opts.replyToId } : {};
				const sent = await connection.sendText(conversationId, body, { ...replyOpt });
				if (sent.messageId) lastMessageId = sent.messageId;
				sentAny = true;
				first = false;
			}
			// NOTHING WENT OUT — SAY SO.
			//
			// Every chunk can be skipped: an empty reply, whitespace, or a body
			// that was entirely internal scaffolding (the outbound sanitizer now
			// correctly returns "" for that rather than leaking it). This used to
			// return `undefined`, which `plugin.ts` reports as `{ok:true}` — so a
			// message that was never sent was reported delivered, and the operator
			// had no way to know their reply vanished.
			if (!sentAny) {
				throw new Error(
					"iMessage: nothing to send — the reply was empty after formatting (all chunks were blank or internal-only)",
				);
			}
			return lastMessageId ? { messageId: lastMessageId } : undefined;
		},

		async sendMedia(conversationId: string, media: OutboundMedia): Promise<{ messageId?: string } | void> {
			if (!connection) throw new Error("iMessage channel is not started");
			const sent = await connection.sendMedia(conversationId, media);
			return sent.messageId ? { messageId: sent.messageId } : undefined;
		},

		// The bot's own iMessage handle (when the operator configured
		// `channels.imessage.selfHandle`) — lets the central pipeline's group
		// mention-gating match `msg.mentions` against the bot. Undefined when unset.
		selfId(): string | undefined {
			return selfHandle || undefined;
		},

		connectedAt(): number | null {
			return connection?.connectedAt() ?? null;
		},

		// iMessage senders are phone numbers / emails on the operator's own device;
		// the bot runs AS the operator (Messages.app), so the pairing card uses the
		// "account" label and ownership is NOT bootstrapped from a separate bot.
		pairing: { idLabel: "account" as const },

		/**
		 * Canonicalize the operator's allow-list entries to the same spelling
		 * `imessageSenderAliases` produces, so exact matching can succeed.
		 *
		 * `chat_id:` / `chat_identifier:` entries keep their prefix — they are
		 * conversation identities, matched against the thread rather than the
		 * sender. Everything else is a handle: an email lowercases, a phone
		 * becomes E.164. Neither mapping can collide two real identities, so the
		 * allow-list is not widened.
		 */
		normalizeAclEntry: normalizeIMessageAclEntry,

		// iMessage has no bot token — the `imsg` binary path + Messages.app sign-in
		// are the auth. `brigade channels add imessage` walks: cliPath → dmPolicy →
		// allowFrom → selfHandle. The first prompt carries the macOS-permissions
		// completion note (Full Disk Access + Automation) since the central setup
		// surface has no separate "completion note" hook.
		setup: {
			credentialKeys: [
				{
					key: "cliPath",
					prompt:
						"Path to the `imsg` CLI binary (leave blank to use `imsg` on PATH). " +
						"Requires Messages.app signed in on this Mac, and the terminal/app running `imsg` must be granted " +
						"macOS Full Disk Access (to read the Messages chat.db) + Automation permission for Messages " +
						"(System Settings → Privacy & Security). Tip: list chats with `imsg chats --limit 20`.",
					secret: false,
					envVar: "IMSG_CLI_PATH",
				},
				{
					key: "dmPolicy",
					prompt:
						"Who may DM this account? pairing (owner + approved; strangers challenged — default) / " +
						"allowlist (only allowFrom) / open (anyone) / disabled (drop all DMs). Leave blank for pairing.",
					secret: false,
				},
				{
					key: "allowFrom",
					prompt:
						"Allowlist of senders for allowlist mode — handles or chat targets, comma-separated " +
						"(e.g. +15555550123, user@example.com, chat_id:123). Leave blank for none.",
					secret: false,
				},
				{
					key: "selfHandle",
					prompt:
						"This bot's OWN iMessage handle (phone or email) — used so a group message naming the bot " +
						"counts as a mention for the group requireMention gate. Leave blank to skip.",
					secret: false,
				},
			],
			validateInput(key: string, value: string): string | null {
				const v = value.trim();
				if (key === "cliPath" && v && /\s$/.test(value)) return "Path must not end with whitespace.";
				if (key === "dmPolicy" && v && !["pairing", "allowlist", "open", "disabled"].includes(v.toLowerCase())) {
					return "dmPolicy must be one of: pairing, allowlist, open, disabled.";
				}
				return null;
			},
			buildAccountConfig(values: Record<string, string>): Record<string, unknown> {
				const out: Record<string, unknown> = { enabled: true };
				const cliPath = (values.cliPath ?? "").trim();
				if (cliPath) out.cliPath = cliPath;
				const dmPolicy = (values.dmPolicy ?? "").trim().toLowerCase();
				if (dmPolicy && dmPolicy !== "pairing") out.dmPolicy = dmPolicy;
				const allowFrom = (values.allowFrom ?? "")
					.split(/[\n,]+/g)
					.map((s) => s.trim())
					.filter(Boolean);
				if (allowFrom.length > 0) out.allowFrom = allowFrom;
				const selfHandleVal = (values.selfHandle ?? "").trim();
				if (selfHandleVal) out.selfHandle = selfHandleVal;
				return out;
			},
		},

		capabilities: IMESSAGE_CAPABILITIES,

		// iMessage has no edit/delete/react/pin via the bridge; the central
		// message_action tool pre-checks `capabilities` (none advertised beyond
		// reply), so this reports anything else unsupported cleanly.
		async handleAction(): Promise<ChannelMessageActionResult> {
			return { ok: false, error: "iMessage does not support message actions" };
		},
	};

	return adapter;
}
