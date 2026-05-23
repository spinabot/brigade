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

import type { BrigadeConfig } from "../../../config/io.js";
import { ensureDir, resolveChannelStateDir } from "../../../config/paths.js";
import type { ChannelAdapter, ChannelStartContext } from "../../extensions/types.js";
import { connectWhatsApp, type WhatsAppConnection } from "./connection.js";

const CHANNEL_ID = "whatsapp";

/** Read `channels.whatsapp` from config (loosely — schema keeps it open). */
function whatsappConfig(cfg: BrigadeConfig): { enabled?: boolean; verbose?: boolean } | undefined {
	return (cfg as { channels?: Record<string, { enabled?: boolean; verbose?: boolean }> }).channels?.[CHANNEL_ID];
}

/** Render a QR to the terminal (lazy-imports qrcode-terminal). */
async function printQr(qr: string): Promise<void> {
	try {
		const mod = await import("qrcode-terminal");
		const qrcode = (mod.default ?? mod) as { generate: (text: string, opts: { small: boolean }) => void };
		// eslint-disable-next-line no-console
		console.log("\nScan this QR in WhatsApp → Settings → Linked Devices:\n");
		qrcode.generate(qr, { small: true });
	} catch {
		// qrcode-terminal missing — fall back to the raw string so linking still works.
		// eslint-disable-next-line no-console
		console.log(`\nWhatsApp QR (paste into a QR renderer to link):\n${qr}\n`);
	}
}

export function createWhatsAppAdapter(): ChannelAdapter {
	let connection: WhatsAppConnection | null = null;

	return {
		id: CHANNEL_ID,
		label: "WhatsApp",

		isConfigured(cfg: BrigadeConfig): boolean {
			return whatsappConfig(cfg)?.enabled === true;
		},

		async start(ctx: ChannelStartContext): Promise<void> {
			const authDir = path.join(resolveChannelStateDir(CHANNEL_ID), "auth");
			ensureDir(authDir);
			connection = await connectWhatsApp({
				authDir,
				verbose: false,
				log: ctx.log,
				// Plumb linkMode from the channel-start context so the CLI's
				// `channels link` command gets clean one-shot behavior, while the
				// gateway path keeps its aggressive auto-reconnect.
				linkMode: ctx.linkMode === true,
				onQr: (qr) => {
					ctx.onPairing?.({ kind: "qr", value: qr });
					void printQr(qr);
				},
				onConnected: () => {
					ctx.log("WhatsApp ready");
					ctx.onConnected?.();
				},
				onLoggedOut: () => {
					ctx.log(`WhatsApp was unlinked. Delete ${authDir} and restart to scan a new QR code.`);
					ctx.onLoggedOut?.();
				},
				onMessage: (msg) => {
					void ctx.onInbound({
						channel: CHANNEL_ID,
						conversationId: msg.conversationId,
						messageId: msg.messageId,
						participantId: msg.participantId,
						from: msg.from,
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
		},

		async sendText(conversationId: string, text: string): Promise<void> {
			if (!connection) throw new Error("WhatsApp channel is not started");
			await connection.sendText(conversationId, text);
		},
		async sendMedia(conversationId, media): Promise<void> {
			if (!connection) throw new Error("WhatsApp channel is not started");
			await connection.sendMedia(conversationId, media);
		},
		async react(conversationId, messageId, emoji): Promise<void> {
			if (!connection) throw new Error("WhatsApp channel is not started");
			await connection.react(conversationId, messageId, emoji);
		},
		async markRead(conversationId, messageId, participant): Promise<void> {
			// No-op when the socket isn't up — read receipts are cosmetic and the
			// manager calls this best-effort post-gate.
			if (!connection) return;
			await connection.markRead(conversationId, messageId, participant);
		},
		async setComposing(conversationId, state): Promise<void> {
			if (!connection) return;
			await connection.setComposing(conversationId, state);
		},
		selfId(): string | undefined {
			return connection?.selfId() ?? undefined;
		},
	};
}
