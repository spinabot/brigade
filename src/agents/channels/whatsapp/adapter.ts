/**
 * WhatsApp channel adapter.
 *
 * Implements the Brigade `ChannelAdapter` contract on top of the Baileys
 * connection. Linking is QR-based (no API key): on first start it prints a QR
 * to the gateway terminal and surfaces it via `ctx.onPairing`; once scanned,
 * creds persist under `~/.brigade/channels/whatsapp/auth/` and subsequent boots
 * reconnect silently.
 *
 * Enablement is explicit — `channels.whatsapp.enabled: true` in brigade.json —
 * so the gateway never prints a QR unless the operator opted in.
 */

import path from "node:path";

import { tryGetRuntimeContext } from "../../../storage/runtime-context.js";

import type { BrigadeConfig } from "../../../config/io.js";
import { ensureDir, resolveChannelStateDir } from "../../../config/paths.js";
import type {
	ChannelAdapter,
	ChannelHealth,
	ChannelStartContext,
	OutboundSendOptions,
} from "../../extensions/types.js";
import {
	listWhatsAppAccountIds,
	resolveWhatsAppAccountAuthDir,
	whatsappChannelEnabled,
} from "./account-config.js";
import { connectWhatsApp, toWhatsAppJid, type WhatsAppConnection } from "./connection.js";

const CHANNEL_ID = "whatsapp";

/** Default account id for legacy single-account installs. */
const DEFAULT_ACCOUNT_ID = "default";

/** Adapter construction options — all optional for back-compat. */
export interface CreateWhatsAppAdapterOptions {
	/** Per-account scope (multi-account plugin path). Defaults to `"default"`. */
	accountId?: string;
	/** Override the on-disk auth directory. When omitted, derived from `accountId`. */
	authDir?: string;
}

/** Render a QR to the terminal (lazy-imports qrcode-terminal). */
async function printQr(qr: string): Promise<void> {
	try {
		const mod = await import("qrcode-terminal");
		const qrcode = (mod.default ?? mod) as { generate: (text: string, opts: { small: boolean }) => void };
		// Friendly, on-brand prompt rendered ONCE above the QR. The CLI link
		// command intentionally does not print a second prompt below — one
		// instruction is enough, more is clutter.
		process.stdout.write("\n📱  Scan this QR from WhatsApp → Settings → Linked Devices → Link a Device:\n\n");
		qrcode.generate(qr, { small: true });
	} catch {
		// qrcode-terminal missing — fall back to the raw string so linking still works.
		process.stdout.write(`\nWhatsApp QR (paste into a QR renderer to link):\n${qr}\n`);
	}
}

export function createWhatsAppAdapter(opts: CreateWhatsAppAdapterOptions = {}): ChannelAdapter {
	/** Account id this adapter instance represents — stamped on every inbound. */
	const accountId = opts.accountId?.trim() || DEFAULT_ACCOUNT_ID;
	/** Auth directory override (multi-account plugin path), else derived per-account in start(). */
	const authDirOverride = opts.authDir?.trim();
	let connection: WhatsAppConnection | null = null;
	// Health state captured from the connection's lifecycle callbacks. The
	// adapter is otherwise stateless about session liveness — Baileys owns
	// the socket — so we mirror just enough into these flags for the
	// `health()` method (and every caller that depends on it) to refuse a
	// send against a dead session without dialling Baileys on the hot path.
	//
	//   - `connected` flips true when the WS handshakes + flips false again
	//     on any close (network drop, server kick, logout).
	//   - `loggedOut` is a STICKY terminal: once the phone or the platform
	//     terminates the link, reconnect is no longer attempted (per the
	//     connection layer's "dead creds — never reconnect" path) and the
	//     ONLY recovery is `brigade channels link`. The flag stays true
	//     until the next successful `onConnected` from a freshly-paired
	//     adapter (after the operator runs the unlink + link CLI flow).
	let connected = false;
	let loggedOut = false;

	return {
		id: CHANNEL_ID,
		label: "WhatsApp",

		isConfigured(cfg: BrigadeConfig): boolean {
			if (!whatsappChannelEnabled(cfg)) return false;
			// Legacy single-adapter boot: when the operator declared
			// `channels.whatsapp.accounts:[...]` with more than one entry, the
			// plugin path owns lifecycle — the legacy adapter steps aside so
			// the gateway doesn't double-spawn the default-account socket.
			const isLegacyAdapter =
				!authDirOverride && accountId === DEFAULT_ACCOUNT_ID;
			if (isLegacyAdapter && listWhatsAppAccountIds(cfg).length > 1) return false;
			return true;
		},

		async start(ctx: ChannelStartContext): Promise<void> {
			// When the plugin path resolved a per-account auth dir, use it; legacy
			// single-adapter callers fall back to the channel-state-dir layout.
			const authDir =
				authDirOverride ??
				(accountId === DEFAULT_ACCOUNT_ID
					? path.join(resolveChannelStateDir(CHANNEL_ID), "auth")
					: resolveWhatsAppAccountAuthDir(accountId));
			// Convex mode never uses the on-disk auth dir (useConvexAuthState
			// owns auth) — creating it would write under ~/.brigade and trip
			// the strict-zero guard. Skip; pass accountId so the convex auth
			// tables key per-account (multi-account safe).
			if (tryGetRuntimeContext()?.mode !== "convex") ensureDir(authDir);
			connection = await connectWhatsApp({
				authDir,
				accountId,
				verbose: false,
				log: ctx.log,
				// Plumb linkMode from the channel-start context so the CLI's
				// `channels link` command gets clean one-shot behavior, while the
				// gateway path keeps its aggressive auto-reconnect.
				linkMode: ctx.linkMode === true,
				// Forward polished link-progress strings to the CLI when present.
				onLinkProgress: ctx.onLinkProgress,
				onQr: (qr) => {
					ctx.onPairing?.({ kind: "qr", value: qr });
					void printQr(qr);
				},
				onConnected: () => {
					connected = true;
					// A fresh `onConnected` clears a prior sticky logged-out state —
					// the operator must have re-linked via the CLI flow.
					loggedOut = false;
					ctx.log("WhatsApp ready");
					ctx.onConnected?.();
				},
				onLoggedOut: () => {
					connected = false;
					loggedOut = true;
					// Recipient-friendly wording — no on-disk paths, no "delete X then …"
					// instructions. The operator gets a clean recovery flow via the CLI
					// (`brigade channels unlink` wipes the local credentials; then
					// `brigade channels link` walks them through a fresh scan). Path
					// names belong in operator logs, not in user-visible CLI output.
					ctx.log("WhatsApp was unlinked. Run `brigade channels unlink --channel whatsapp` then `brigade channels link` to scan a new code.");
					ctx.onLoggedOut?.();
				},
				onMessage: (msg) => {
					void ctx.onInbound({
						channel: CHANNEL_ID,
						// Stamp the per-account scope on every inbound so the channel
						// manager + 8-tier router can disambiguate sibling accounts
						// (e.g. personal vs work) sharing the same `from` phone digits.
						// Closure-bound — there's one adapter instance per account in
						// the plugin path; the legacy single-adapter path stamps the
						// default id transparently for back-compat.
						accountId,
						conversationId: msg.conversationId,
						messageId: msg.messageId,
						participantId: msg.participantId,
						messageTimestampMs: msg.messageTimestampMs,
						from: msg.from,
						senderLid: msg.senderLid,
						fromName: msg.fromName,
						text: msg.text,
						chatType: msg.chatType,
						isGroup: msg.chatType === "group",
						mentions: msg.mentions,
						replyTo: msg.replyTo,
						media: msg.media,
						raw: msg.raw,
					});
				},
			});
		},

		async stop(): Promise<void> {
			await connection?.close();
			connection = null;
			connected = false;
		},

		/**
		 * Synchronous read of the cached session state. Returns:
		 *   - `{ ok: true }` once Baileys has signalled a successful handshake
		 *     AND the session hasn't been terminated since.
		 *   - `{ ok: false, kind: "logged-out" }` after the phone / platform
		 *     unlinks the session. Sticky — the only recovery is the operator
		 *     re-pairing via `brigade channels link`.
		 *   - `{ ok: false, kind: "starting" }` between `start()` and the first
		 *     `onConnected` callback (incl. during QR-scan link flow).
		 *   - `{ ok: false, kind: "disconnected" }` for transient drops where
		 *     reconnect is in-flight but the socket isn't ready yet.
		 *
		 * Cheap — reads two booleans. Safe to call from cron timer / send tool
		 * pre-flights without any I/O.
		 */
		health(): ChannelHealth {
			if (loggedOut) {
				return {
					ok: false,
					kind: "logged-out",
					reason:
						"WhatsApp was unlinked from the operator's phone — Brigade can't send until it's paired again.",
					remediation:
						"Run `brigade channels unlink --channel whatsapp` then `brigade channels link --channel whatsapp` and scan the new QR.",
				};
			}
			if (!connection) {
				return {
					ok: false,
					kind: "starting",
					reason: "WhatsApp adapter is not started yet.",
				};
			}
			if (!connected) {
				return {
					ok: false,
					kind: "disconnected",
					reason: "WhatsApp socket is reconnecting — sends will fail until the link comes back up.",
				};
			}
			return { ok: true };
		},

		async sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<void> {
			if (!connection) throw new Error("WhatsApp channel is not started");
			if (loggedOut) {
				throw new Error(
					"WhatsApp is unlinked — run `brigade channels link --channel whatsapp` to re-pair, then retry.",
				);
			}
			if (!connected) {
				throw new Error("WhatsApp socket is reconnecting — try again in a moment.");
			}
			// Normalise to a JID — accept human-shaped phone numbers like
			// "+91 77026 16808" / "+917702616808" / "917702616808" by stripping
			// formatting and appending `@s.whatsapp.net`. Without this Baileys'
			// `jidDecode` returns undefined for a bare-phone input and the send
			// crashes with the opaque "Cannot destructure property 'user' of
			// 'jidDecode(...)' as it is undefined" — exactly what the operator
			// hit when telling the model "send hi to +91...". JIDs / group ids /
			// LID aliases pass through unchanged.
			const jid = toWhatsAppJid(conversationId);
			if (!jid) {
				throw new Error(
					`WhatsApp: couldn't normalise recipient "${conversationId}" — pass a phone number (e.g. +917702616808) or a WhatsApp JID.`,
				);
			}
			// WhatsApp has no thread routing — `opts.threadId` is accepted for
			// signature compatibility with threaded channels (Slack/Discord)
			// and silently ignored here.
			void opts;
			await connection.sendText(jid, text);
		},
		// Pairing customization — WhatsApp ids are international phone numbers,
		// so the challenge card uses the "Your number: +X" line. No
		// `normalizeAllowEntry` (numbers are already in canonical form by the
		// time they reach the allow store) and no `notifyApproval` (operator
		// can DM the approved sender manually for now).
		pairing: { idLabel: "phone" as const },
		async sendMedia(conversationId, media): Promise<void> {
			if (!connection) throw new Error("WhatsApp channel is not started");
			const jid = toWhatsAppJid(conversationId);
			if (!jid) {
				throw new Error(
					`WhatsApp: couldn't normalise recipient "${conversationId}" — pass a phone number or a WhatsApp JID.`,
				);
			}
			await connection.sendMedia(jid, media);
		},
		async react(conversationId, messageId, emoji): Promise<void> {
			if (!connection) throw new Error("WhatsApp channel is not started");
			const jid = toWhatsAppJid(conversationId);
			if (!jid) return; // Cosmetic — refuse silently rather than throw on a reaction.
			await connection.react(jid, messageId, emoji);
		},
		async markRead(conversationId, messageId, participant): Promise<void> {
			// No-op when the socket isn't up — read receipts are cosmetic and the
			// manager calls this best-effort post-gate.
			if (!connection) return;
			const jid = toWhatsAppJid(conversationId);
			if (!jid) return;
			await connection.markRead(jid, messageId, participant);
		},
		async setComposing(conversationId, state): Promise<void> {
			if (!connection) return;
			await connection.setComposing(conversationId, state);
		},
		selfId(): string | undefined {
			return connection?.selfId() ?? undefined;
		},
		connectedAt(): number | null {
			return connection?.connectedAt() ?? null;
		},
	};
}
