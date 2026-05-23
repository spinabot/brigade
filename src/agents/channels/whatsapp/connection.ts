/**
 * WhatsApp Web connection (Baileys).
 *
 * A multi-file auth store on disk, QR-on-first-link, auto-reconnect with
 * backoff, and a normalized text-message callback. Baileys is a heavy
 * dependency, so it is lazy-imported here — the gateway only pays for it when a
 * WhatsApp channel actually starts. Types are imported `type`-only (erased at
 * build) so the static import never pulls the runtime in.
 *
 * Reconnect discipline: on a transient drop the live socket is fully torn down
 * (listeners removed + ended) BEFORE a replacement is built, and the rebuild is
 * scheduled on a backoff timer rather than synchronously inside the close
 * handler — so a flapping link can never fork into parallel reconnect chains or
 * leak listeners. A logged-out close stops reconnection entirely (creds are
 * dead). `close()` cancels any pending reconnect and tears the socket down.
 *
 * Scope (this phase): text in / text out. Media, reactions, groups-as-rooms,
 * and presence are deliberately out of scope and slot in later behind the same
 * ChannelAdapter contract.
 */

import type { ConnectionState, WAMessage, WASocket } from "@whiskeysockets/baileys";

import { createDedupeCache } from "../dedupe.js";
import { chunkText } from "./chunk.js";
import { markdownToWhatsApp } from "./format.js";
import { extractMentions, extractReplyContext } from "./inbound-extras.js";
import { downloadInboundMedia } from "./media.js";

/** A normalized inbound WhatsApp message (text and/or media). */
export interface WaInboundText {
	/** Chat JID — the conversation id (e.g. `123@s.whatsapp.net` or `…@g.us`). */
	conversationId: string;
	/** Baileys `msg.key.id` — surfaces to the adapter so post-gate markRead works. */
	messageId?: string;
	/** Baileys `msg.key.participant` (groups only) — used as the read-receipt participant id. */
	participantId?: string;
	/** Sender JID (canonical digits-only E.164). */
	from: string;
	/** WhatsApp display name, when present. */
	fromName?: string;
	/** Plain message text. May be empty when only media was sent. */
	text: string;
	/** Whether this message arrived in a group room (`@g.us`) vs a DM. */
	chatType: "direct" | "group";
	/** Canonical digits of @-mentioned participants, when a group message tagged accounts. */
	mentions?: string[];
	/** Quoted-reply context — what message this inbound replies to, if any. */
	replyTo?: import("../../extensions/types.js").InboundReplyContext;
	/** Media attachments saved to disk under ~/.brigade/channels/whatsapp/media. */
	media?: import("../../extensions/types.js").InboundMediaAttachment[];
	/** Raw Baileys message (for adapters that need more). */
	raw: WAMessage;
}

export interface ConnectWhatsAppArgs {
	/** Directory holding the multi-file auth state (creds + signal keys). */
	authDir: string;
	/** Baileys log level — quiet unless the operator asked for verbose. */
	verbose?: boolean;
	/** Called with the QR string whenever WhatsApp wants the device linked. */
	onQr?: (qr: string) => void;
	/** Called once the socket reaches the `open` state. */
	onConnected?: () => void;
	/** Called when WhatsApp ends the session (creds invalid — re-link needed). */
	onLoggedOut?: () => void;
	/** Called for every inbound text message from another user. */
	onMessage: (msg: WaInboundText) => void;
	/** Subsystem logger. */
	log: (msg: string, meta?: Record<string, unknown>) => void;
	/**
	 * One-shot LINK mode: suppress aggressive auto-reconnect (used by the
	 * gateway path to recover transient drops). The pair handshake's mandatory
	 * 515-restart hop is still honored — that's the only reconnect needed for
	 * a successful pair. Any other close is treated as a hard failure so the
	 * caller's outer timeout can act on it.
	 */
	linkMode?: boolean;
}

export interface WhatsAppConnection {
	/** The live Baileys socket (rebuilt internally across reconnects). */
	current(): WASocket | null;
	/** The linked self id in canonical form (digits-only E.164), or null pre-connect. */
	selfId(): string | null;
	/** Send a text message to a chat JID. */
	sendText(conversationId: string, text: string): Promise<void>;
	/** Send a media attachment (image / video / audio / voice / document / sticker). */
	sendMedia(
		conversationId: string,
		media: import("../../extensions/types.js").OutboundMedia,
	): Promise<void>;
	/** React to a previously-received message with an emoji. `""` clears any prior reaction. */
	react(conversationId: string, messageId: string, emoji: string, fromMe?: boolean): Promise<void>;
	/**
	 * Send a read receipt ("blue ticks") for a previously-received message.
	 * Cosmetic — failures are swallowed. Called by the channel manager AFTER
	 * the access-control gate allows the inbound so a stranger waiting on a
	 * pairing challenge never sees a read receipt before the bot has decided
	 * to engage.
	 */
	markRead(conversationId: string, messageId: string, participant?: string): Promise<void>;
	/**
	 * Set the chat's typing-indicator state. `"composing"` shows the recipient
	 * "Brigade is typing…", `"paused"` clears it. Best-effort; cosmetic.
	 */
	setComposing(conversationId: string, state: "composing" | "paused"): Promise<void>;
	/** Close the connection and stop reconnecting. */
	close(): Promise<void>;
}

/**
 * Extract the canonical phone-number id (digits-only E.164) from a regular
 * WhatsApp jid like `15551234567@s.whatsapp.net`, a participant jid with a
 * device suffix like `15551234567:1@s.whatsapp.net`, or a raw E.164 string.
 * Returns `""` when no digits are present.
 *
 * ⚠ DO NOT use this on LID-suffixed jids (`@lid` / `@hosted.lid`). LIDs are
 * privacy aliases — the leading digits are an opaque WhatsApp-internal id, NOT
 * a phone number. Use {@link resolveJidToE164} (async) which calls Baileys'
 * `signalRepository.lidMapping.getPNForLID` to map the alias to a real phone.
 */
export function canonicalWhatsAppId(raw: string | null | undefined): string {
	if (!raw) return "";
	// Strip everything except digits — drops `+`, `-`, spaces, jid suffix, and
	// the device-id `:N` segment that follows the number in participant ids.
	const at = raw.indexOf("@");
	const head = at === -1 ? raw : raw.slice(0, at);
	const beforeColon = head.split(":")[0] ?? head;
	return beforeColon.replace(/\D/g, "");
}

// Regular phone-number jid (with optional device suffix). The capture is the
// raw E.164 digits — no leading `+`, callers add it when displaying.
const WA_PHONE_JID_RE = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/;
// Privacy-alias (LID) jid. The leading digits look like a phone number but
// are NOT — they're an opaque alias the user opted into to hide their real
// number. The only way to map LID → phone is `signalRepository.lidMapping`.
const WA_LID_JID_RE = /^(\d+)(?::\d+)?@(lid|hosted\.lid)$/;

/**
 * Baileys' LID-mapping lookup, narrowed to the one method we need. Stamped as
 * an interface so callers can stub it in tests without dragging in the entire
 * Baileys type.
 */
interface LidLookup {
	getPNForLID?: (lidJid: string) => Promise<string | null | undefined> | string | null | undefined;
}

/**
 * Resolve a WhatsApp jid to a canonical phone number (digits-only E.164),
 * including LID-aliased jids that need a runtime lookup. Returns `null` when:
 *   - `jid` is empty/missing
 *   - the jid is in LID form AND the socket can't (or won't) map it to a phone
 *   - the resolved value isn't a recognized phone-jid shape
 *
 * Callers MUST drop messages with a `null` resolution rather than inventing a
 * fake sender id from raw LID digits — those digits aren't a phone number, and
 * downstream pairing/allow-list code keys on E.164.
 */
export async function resolveJidToE164(
	sock: WASocket | null,
	jid: string | null | undefined,
): Promise<string | null> {
	if (!jid) return null;
	const direct = jid.match(WA_PHONE_JID_RE);
	if (direct) return direct[1] ?? null;
	if (!WA_LID_JID_RE.test(jid)) return null;
	// LID jid — need the runtime to translate. Some Baileys builds expose
	// `signalRepository.lidMapping`; older / partially-initialized sockets
	// don't. Treat a missing lookup as "unresolvable".
	const lookup = (sock as unknown as { signalRepository?: { lidMapping?: LidLookup } } | null)?.signalRepository
		?.lidMapping;
	if (!lookup?.getPNForLID) return null;
	try {
		const pnJid = await lookup.getPNForLID(jid);
		if (!pnJid) return null;
		const m = pnJid.match(WA_PHONE_JID_RE);
		return m ? (m[1] ?? null) : null;
	} catch {
		// Lookup failure (e.g. mapping not cached yet) → drop the inbound.
		return null;
	}
}

// Reconnect backoff: 2s → 30s, ×1.8 with ±25% jitter, capped attempts so a
// permanently-broken link stops hammering WhatsApp instead of looping forever.
const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_JITTER = 0.25;
const RECONNECT_MAX_ATTEMPTS = 12;

function backoffDelay(attempt: number): number {
	const base = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * RECONNECT_FACTOR ** attempt);
	const jitter = base * RECONNECT_JITTER * (Math.random() * 2 - 1);
	return Math.max(0, Math.round(base + jitter));
}

/** Extract plain text from a Baileys message, unwrapping the common envelopes. */
function extractText(message: WAMessage["message"], normalize: (m: unknown) => unknown): string {
	const content = (normalize(message) ?? {}) as Record<string, unknown>;
	if (typeof content.conversation === "string") return content.conversation;
	const ext = content.extendedTextMessage as { text?: string } | undefined;
	if (ext && typeof ext.text === "string") return ext.text;
	// Image/video/document with a caption — treat the caption as the text.
	const img = content.imageMessage as { caption?: string } | undefined;
	if (img && typeof img.caption === "string") return img.caption;
	const vid = content.videoMessage as { caption?: string } | undefined;
	if (vid && typeof vid.caption === "string") return vid.caption;
	const doc = content.documentMessage as { caption?: string } | undefined;
	if (doc && typeof doc.caption === "string") return doc.caption;
	return "";
}

/**
 * Establish a WhatsApp Web connection with auto-reconnect. Resolves once the
 * first socket is constructed (NOT once connected — QR/open events arrive via
 * the callbacks). The returned handle owns the reconnect loop.
 */
export async function connectWhatsApp(args: ConnectWhatsAppArgs): Promise<WhatsAppConnection> {
	const baileys = await import("@whiskeysockets/baileys");
	const makeWASocket = (baileys.default ?? baileys.makeWASocket) as typeof import("@whiskeysockets/baileys").makeWASocket;
	const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, normalizeMessageContent, useMultiFileAuthState } =
		baileys;

	const loggedOutCode = DisconnectReason?.loggedOut ?? 401;
	const restartRequiredCode = DisconnectReason?.restartRequired ?? 515;

	// Silent pino-shaped logger unless verbose — Baileys logs prolifically.
	const level = args.verbose ? "info" : "silent";
	const noop = () => {};
	const baileysLogger: Record<string, unknown> = {
		level,
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		child: () => baileysLogger,
	};

	const { state, saveCreds } = await useMultiFileAuthState(args.authDir);
	const { version } = await fetchLatestBaileysVersion();

	let sock: WASocket | null = null;
	let closed = false;
	let reconnectAttempts = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	// Inbound dedupe: WhatsApp re-delivers the same msg.key.id after a
	// reconnect; without this, the agent runs the LLM (and bills) twice and
	// posts the reply twice. Per-connection lifetime.
	const inboundDedupe = createDedupeCache({ maxEntries: 5_000, ttlMs: 60 * 60 * 1_000 });
	// Outbound id tracking — every successful send records `result.key.id` so
	// the inbound `fromMe` echo (WhatsApp mirrors our own sends back through
	// `messages.upsert`) can be distinguished from a genuine self-chat. Without
	// this we'd have to blanket-drop `fromMe`, which silences the operator
	// DMing themselves (selfChat). 20-min TTL matches OpenClaw's recent-outbound
	// window — long enough to survive a slow reconnect, short enough to bound
	// memory on a chatty account.
	const outboundDedupe = createDedupeCache({ maxEntries: 5_000, ttlMs: 20 * 60 * 1_000 });
	const recordOutboundId = (id: string | undefined | null): void => {
		if (id) outboundDedupe.remember(id);
	};
	// Track the last QR we surfaced so a Baileys QR refresh (same string) doesn't
	// flood the operator's terminal with duplicate prints. Only NEW QRs reach
	// `args.onQr`.
	let lastQr: string | null = null;
	// Pending creds writes are tracked so a reconnect (notably the 515 that
	// follows first-link) can wait for them to flush before rebuilding.
	let pendingCredsSave: Promise<void> = Promise.resolve();

	/** Detach every listener from a socket and end it — no zombie emits. */
	const teardownSocket = (s: WASocket | null): void => {
		if (!s) return;
		try {
			(s.ev as unknown as { removeAllListeners?: () => void }).removeAllListeners?.();
		} catch {
			/* best-effort */
		}
		try {
			const ws = (s as unknown as { ws?: { removeAllListeners?: () => void } }).ws;
			ws?.removeAllListeners?.();
		} catch {
			/* best-effort */
		}
		try {
			s.end?.(undefined);
		} catch {
			/* already torn down */
		}
	};

	const scheduleReconnect = (): void => {
		if (closed || reconnectTimer) return;
		if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
			args.log("WhatsApp reconnect attempts exhausted — giving up until restart", {
				attempts: reconnectAttempts,
			});
			return;
		}
		const delay = backoffDelay(reconnectAttempts);
		reconnectAttempts += 1;
		args.log("WhatsApp reconnecting", { attempt: reconnectAttempts, delayMs: delay });
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			if (closed) return;
			// Flush any pending creds write first (covers the 515 first-link race),
			// then build a fresh socket on the same creds.
			void pendingCredsSave
				.catch(() => {})
				.then(() => {
					if (closed) return;
					sock = buildSocket();
				});
		}, delay);
		reconnectTimer.unref?.();
	};

	const buildSocket = (): WASocket => {
		const s = makeWASocket({
			version,
			// biome-ignore lint/suspicious/noExplicitAny: pino-shaped stub logger
			logger: baileysLogger as any,
			printQRInTerminal: false,
			browser: ["Brigade", "Chrome", "1.0.0"],
			syncFullHistory: false,
			markOnlineOnConnect: false,
			auth: {
				creds: state.creds,
				// biome-ignore lint/suspicious/noExplicitAny: pino-shaped stub logger
				keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
			},
		});

		s.ev.on("creds.update", () => {
			pendingCredsSave = Promise.resolve(saveCreds()).catch((err) => {
				args.log("failed saving WhatsApp creds", { error: err instanceof Error ? err.message : String(err) });
			});
		});

		s.ev.on("connection.update", (update: Partial<ConnectionState>) => {
			// Wrap the whole handler — a throw inside a Baileys event emit would
			// otherwise surface as an unhandled rejection and could crash the daemon.
			try {
				const { connection, lastDisconnect, qr } = update;
				// Dedupe QR refreshes — Baileys re-emits the same string on its own
				// polling cadence; only forward when the QR actually changed so the
				// operator's terminal doesn't fill with identical QR codes.
				if (qr && qr !== lastQr) {
					lastQr = qr;
					args.onQr?.(qr);
				}
				if (connection === "open") {
					reconnectAttempts = 0; // healthy link — reset backoff
					lastQr = null; // any future QR is genuinely a re-pair
					args.log("connected to WhatsApp");
					args.onConnected?.();
				}
				if (connection === "close") {
					const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
						?.statusCode;
					// Tear the dead socket down BEFORE doing anything else so its
					// listeners can't fire again (no leak, no duplicate inbound).
					teardownSocket(s);
					if (sock === s) sock = null;
					if (status === loggedOutCode) {
						args.log("WhatsApp session logged out — re-link required");
						args.onLoggedOut?.();
						return; // dead creds — never reconnect
					}
					if (status === restartRequiredCode) {
						// Expected immediately after first-link; reconnect promptly
						// without consuming the backoff budget. This single hop is
						// honored even in linkMode — it's part of the pair handshake.
						args.log("WhatsApp restart required (post-link) — reconnecting");
						reconnectAttempts = 0;
						scheduleReconnect();
						return;
					}
					// In one-shot link mode, treat any non-515 close as a hard failure
					// so the link command's outer timeout / failure path can act on it.
					// The gateway path keeps the auto-reconnect (its job IS to stay up).
					if (args.linkMode) {
						args.log("WhatsApp connection dropped during link — aborting (linkMode)", { status });
						return;
					}
					scheduleReconnect();
				}
			} catch (err) {
				args.log("WhatsApp connection.update handler error", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});

		s.ev.on("messages.upsert", (payload: { messages: WAMessage[]; type: string }) => {
			// `notify` = live messages; `append`/history-sync are ignored so we
			// never replay old chats on reconnect.
			if (payload.type !== "notify") return;
			// Process each message in its own async task so media download (a
			// network round-trip) doesn't block the next message's dedupe claim.
			for (const m of payload.messages) {
				void (async () => {
					try {
						const jid = m.key.remoteJid;
						if (!jid) return;
						// Status/broadcast feeds — both legacy (`status@broadcast`) and
						// the suffix variants (`…@status`, `…@broadcast`) — are story
						// updates, never DMs to react to.
						if (jid === "status@broadcast" || jid.endsWith("@status") || jid.endsWith("@broadcast")) return;
						const isGroup = jid.endsWith("@g.us");
						const msgId = m.key.id;
						// `fromMe` handling: WhatsApp mirrors our own outbound sends back
						// through `messages.upsert` (the platform's "you sent X" event).
						// A blanket `if (fromMe) return` would silence those echoes — good —
						// but it would ALSO silence the operator legitimately DMing
						// themselves from a linked device (self-chat mode), which is a
						// real-world use case (notes to self, testing). Drop only the
						// echoes we recognize (id we just sent), let everything else
						// (including unrecognized fromMe = self-chat DM) flow through.
						if (m.key.fromMe) {
							if (!msgId || outboundDedupe.peek(msgId)) {
								// Either no id (can't dedupe — defensive drop) or a known
								// echo of our own send. Either way: not user input.
								return;
							}
							// Unrecognized fromMe = the operator typed this on a linked
							// device. Fall through to normal handling.
						}
						// Drop duplicates of the same message — WhatsApp re-delivers the
						// same `msg.key.id` after a reconnect; without this guard the agent
						// would run twice (and bill twice) per real message.
						if (msgId && !inboundDedupe.claim(`${jid}:${msgId}`)) {
							args.log("dropped duplicate inbound (already processed)", { jid, msgId });
							return;
						}
						const normalized = (normalizeMessageContent as (x: unknown) => unknown)(m.message) as
							| WAMessage["message"]
							| undefined;
						const text = extractText(m.message, normalizeMessageContent as (x: unknown) => unknown).trim();
						// Download any attached media so the agent gets paths it can read.
						const media =
							normalized && msgId
								? await downloadInboundMedia({
										content: normalized,
										msgId,
										downloadMediaMessage: baileys.downloadMediaMessage as never,
										rawMessage: m,
										log: args.log,
									})
								: [];
						// Drop the message entirely only if there's no text AND no media.
						if (!text && media.length === 0) return;
						// Sender-jid resolution. For DMs the chat jid itself is the sender;
						// for groups the per-message `participant` carries the speaker.
						// LID-aliased jids must be mapped to E.164 through the Baileys LID
						// table — the leading digits of `@lid` jids are NOT a phone number.
						// If the mapping isn't available, we DROP the message rather than
						// inventing a fake sender id from the LID digits (which would key
						// allow-lists and pairing requests on garbage).
						const rawParticipant = m.key.participant?.trim();
						const senderJid =
							isGroup && rawParticipant && rawParticipant.length > 0 ? rawParticipant : jid;
						const fromCanonical = await resolveJidToE164(sock, senderJid);
						if (!fromCanonical) {
							args.log("inbound dropped — could not resolve sender jid to phone (LID unmapped)", {
								jid,
								participant: rawParticipant,
							});
							return;
						}
						// Mentions + quoted-reply context come from the normalized message;
						// pulled here so the manager can gate group activation cleanly and
						// the LLM gets the "user replied to X" context for free. Async
						// because LID mentions need the same resolver above.
						const mentions = normalized ? await extractMentions(normalized, sock) : [];
						const replyTo = normalized ? await extractReplyContext(normalized, sock) : undefined;
						args.onMessage({
							conversationId: jid,
							messageId: msgId ?? undefined,
							participantId: isGroup ? rawParticipant : undefined,
							from: fromCanonical,
							fromName: m.pushName ?? undefined,
							text,
							chatType: isGroup ? "group" : "direct",
							mentions: mentions.length > 0 ? mentions : undefined,
							replyTo,
							media: media.length > 0 ? media : undefined,
							raw: m,
						});
					} catch (err) {
						args.log("failed to process inbound message", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				})();
			}
		});

		// Surface socket-level WS errors instead of crashing the process.
		const ws = (s as unknown as { ws?: { on?: (e: string, cb: (err: Error) => void) => void } }).ws;
		ws?.on?.("error", (err) => args.log("WhatsApp socket error", { error: String(err) }));

		return s;
	};

	sock = buildSocket();

	const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

	/**
	 * Send one chunk with retry on transient send failures. A WebSocket flap
	 * during a reply would otherwise drop the message silently — Baileys throws
	 * "Connection Closed" / "WS not open" until the auto-reconnect lands a
	 * fresh socket. We back off and retry against the LIVE `sock` reference (so
	 * a reconnect-replaced socket is used on the next attempt). Permanent
	 * errors (e.g. "jid not registered") propagate after the first try.
	 */
	async function sendOneChunkWithRetry(
		conversationId: string,
		chunk: string,
		log: (msg: string, meta?: Record<string, unknown>) => void,
	): Promise<void> {
		// Per-chunk correlation id — every log line for this send is searchable
		// via grep on the gateway log so operators can answer "did this reply
		// actually land?" with a single id, not a fuzzy time match.
		const correlationId = `wa-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
		const startedAt = Date.now();
		const TRANSIENT = /closed|reset|timed?\s*out|disconnect|not\s*open|stream\s*error|ws/i;
		const MAX_ATTEMPTS = 3;
		let lastErr: unknown;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const live = sock;
			if (live) {
				try {
					const result = (await live.sendMessage(conversationId, { text: chunk })) as
						| { key?: { id?: string } }
						| undefined;
					// Remember the outbound message id so the inbound `fromMe` echo
					// can be distinguished from a genuine self-chat message (see
					// outboundDedupe in the upsert handler).
					recordOutboundId(result?.key?.id);
					log("WhatsApp send ok", {
						correlationId,
						attempt,
						chunkBytes: chunk.length,
						messageId: result?.key?.id,
						durationMs: Date.now() - startedAt,
					});
					return;
				} catch (err) {
					lastErr = err;
					const message = err instanceof Error ? err.message : String(err);
					if (!TRANSIENT.test(message)) {
						log("WhatsApp send permanent error", { correlationId, attempt, error: message });
						throw err;
					}
					log("WhatsApp send transient — retrying", { correlationId, attempt, error: message });
				}
			} else {
				lastErr = new Error("WhatsApp socket not connected");
				log("WhatsApp send paused — socket reconnecting", { correlationId, attempt });
			}
			if (attempt < MAX_ATTEMPTS) await delay(500 * attempt);
		}
		log("WhatsApp send failed after retries", {
			correlationId,
			attempts: MAX_ATTEMPTS,
			durationMs: Date.now() - startedAt,
			error: lastErr instanceof Error ? lastErr.message : String(lastErr),
		});
		throw lastErr ?? new Error("WhatsApp send failed after retries");
	}

	return {
		current: () => sock,
		selfId: () => canonicalWhatsAppId(sock?.user?.id) || null,
		async sendText(conversationId: string, text: string): Promise<void> {
			// Convert agent-style markdown (**bold**, headings, tables, [links])
			// into WhatsApp's sparse formatting (*bold*, • bullets, "label (url)")
			// before splitting. Otherwise raw `**` / `|` / `###` leak into chat.
			const wa = markdownToWhatsApp(text);
			// Split long replies into WhatsApp-sized chunks (~4000 chars, fence-
			// aware). Each chunk goes through its own retry loop so a transient
			// reconnect mid-reply doesn't lose the rest of the message.
			const chunks = chunkText(wa);
			// Show "composing…" once at the start of a multi-chunk reply so the
			// recipient sees "typing…" while the LLM was thinking AND while we're
			// sending. Best-effort — failure here never breaks the send.
			try {
				await sock?.sendPresenceUpdate?.("composing", conversationId);
			} catch {
				/* presence is cosmetic */
			}
			for (let i = 0; i < chunks.length; i++) {
				await sendOneChunkWithRetry(conversationId, chunks[i] as string, args.log);
				if (i < chunks.length - 1) await delay(150);
			}
			// Reset presence so the bot doesn't show as "typing forever".
			try {
				await sock?.sendPresenceUpdate?.("paused", conversationId);
			} catch {
				/* ignore */
			}
		},
		async sendMedia(
			conversationId: string,
			media: import("../../extensions/types.js").OutboundMedia,
		): Promise<void> {
			if (!sock) throw new Error("WhatsApp socket not connected");
			// Map Brigade's media kind onto Baileys' payload shape. Caption rides
			// the media (a single message) so the agent doesn't have to issue two
			// sends; voice = audio + ptt=true with opus mime.
			const url = media.path; // Baileys accepts an absolute path for `url`.
			const captionWa = media.caption ? markdownToWhatsApp(media.caption) : undefined;
			let payload: Record<string, unknown>;
			switch (media.kind) {
				case "image":
					payload = { image: { url }, mimetype: media.mimeType ?? "image/jpeg", caption: captionWa };
					break;
				case "video":
					payload = { video: { url }, mimetype: media.mimeType ?? "video/mp4", caption: captionWa };
					break;
				case "audio":
					payload = { audio: { url }, mimetype: media.mimeType ?? "audio/mpeg", ptt: false };
					break;
				case "voice":
					payload = { audio: { url }, mimetype: media.mimeType ?? "audio/ogg; codecs=opus", ptt: true };
					break;
				case "document":
					payload = {
						document: { url },
						mimetype: media.mimeType ?? "application/octet-stream",
						fileName: media.fileName,
						caption: captionWa,
					};
					break;
				case "sticker":
					payload = { sticker: { url }, mimetype: media.mimeType ?? "image/webp" };
					break;
			}
			const mediaResult = (await sock.sendMessage(conversationId, payload as never)) as
				| { key?: { id?: string } }
				| undefined;
			recordOutboundId(mediaResult?.key?.id);
		},
		async react(conversationId: string, messageId: string, emoji: string, fromMe?: boolean): Promise<void> {
			if (!sock) throw new Error("WhatsApp socket not connected");
			// Reactions need the original message's key (jid + id + fromMe). When
			// the caller only has the inbound's id (the common case), pass
			// fromMe=false; for clearing our own reaction, pass fromMe=true.
			const reactResult = (await sock.sendMessage(conversationId, {
				react: {
					text: emoji, // "" clears any prior reaction
					key: { remoteJid: conversationId, id: messageId, fromMe: fromMe ?? false },
				},
			})) as { key?: { id?: string } } | undefined;
			recordOutboundId(reactResult?.key?.id);
		},
		async markRead(conversationId: string, messageId: string, participant?: string): Promise<void> {
			// Read receipts are cosmetic — drop silently when the socket is
			// reconnecting or the platform refuses (e.g. account hasn't opted
			// into read receipts globally).
			try {
				await sock?.readMessages?.([
					{
						remoteJid: conversationId,
						id: messageId,
						...(participant ? { participant } : {}),
					},
				]);
			} catch {
				/* cosmetic */
			}
		},
		async setComposing(conversationId: string, state: "composing" | "paused"): Promise<void> {
			try {
				await sock?.sendPresenceUpdate?.(state, conversationId);
			} catch {
				/* cosmetic */
			}
		},
		async close(): Promise<void> {
			closed = true;
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			// `logout()` would invalidate creds; we want a clean disconnect that
			// keeps the link, so just tear the socket down.
			teardownSocket(sock);
			sock = null;
			// Let a final creds write flush so the link survives a restart.
			await pendingCredsSave.catch(() => {});
		},
	};
}
