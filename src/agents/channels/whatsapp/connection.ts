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

import { existsSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import type { ConnectionState, WAMessage, WASocket } from "@whiskeysockets/baileys";

import { tryGetRuntimeContext } from "../../../storage/runtime-context.js";
import { createDedupeCache } from "../dedupe.js";
import { chunkText } from "./chunk.js";
import { lookupLidReverseSync, useConvexAuthState } from "./convex-auth-state.js";
import { markdownToWhatsApp } from "./format.js";
import { extractMentions, extractReplyContext } from "./inbound-extras.js";
import { downloadInboundMedia, hasInboundMedia } from "./media.js";

/** A normalized inbound WhatsApp message (text and/or media). */
export interface WaInboundText {
	/** Chat JID — the conversation id (e.g. `123@s.whatsapp.net` or `…@g.us`). */
	conversationId: string;
	/** Baileys `msg.key.id` — surfaces to the adapter so post-gate markRead works. */
	messageId?: string;
	/** Baileys `msg.key.participant` (groups only) — used as the read-receipt participant id. */
	participantId?: string;
	/**
	 * When the platform stamped the message (epoch ms). Used by the access-
	 * control gate to suppress pairing-challenge replies to messages that
	 * arrived AT the gateway but were originally sent before this socket
	 * came up — i.e. queued-since-last-restart DMs that would otherwise
	 * burst-spam every stranger with codes the moment Brigade reconnects.
	 */
	messageTimestampMs?: number;
	/**
	 * Sender id within the channel. Canonical digits-only E.164 when the sender
	 * could be resolved to a phone number; otherwise a stable `@lid` privacy
	 * alias (see {@link resolveSenderIdentity}) so a group message from an
	 * unmapped sender still reaches the gate. Routing / allow-lists key off this.
	 */
	from: string;
	/**
	 * The sender's `@lid` privacy alias, set ONLY when the phone number could
	 * not be resolved and `from` fell back to the LID. Carried separately so the
	 * access-control gate can recognise an allow-listed / self LID without
	 * conflating it with an E.164 number. Undefined for resolved phone senders.
	 */
	senderLid?: string;
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
	/**
	 * DEFERRED media download. The socket layer no longer downloads media
	 * eagerly — a stranger's group video used to be fetched from WhatsApp,
	 * sealed, and archived into the backend BEFORE the access-control gate
	 * dropped the message (storage bloat + privacy hole: anyone in any group
	 * with the operator could fill the database). The pipeline invokes this
	 * ONLY after the gate admits the sender.
	 */
	resolveMedia?: () => Promise<import("../../extensions/types.js").InboundMediaAttachment[]>;
	/** Raw Baileys message (for adapters that need more). */
	raw: WAMessage;
}

export interface ConnectWhatsAppArgs {
	/** Directory holding the multi-file auth state (creds + signal keys).
	 *  Filesystem mode only — convex mode ignores it (auth rides the
	 *  whatsappAuthCreds/whatsappAuthKeys tables). */
	authDir: string;
	/** Account namespace for the convex auth tables. Defaults to "default". */
	accountId?: string;
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
	/**
	 * Called during link with a single polished status string (e.g. when the
	 * post-pair 515 restart fires). The CLI renders this as a clean
	 * "Finalising link…" line instead of two scary "restart required" /
	 * "reconnecting" logs. Ignored outside linkMode.
	 */
	onLinkProgress?: (status: string) => void;
}

export interface WhatsAppConnection {
	/** The live Baileys socket (rebuilt internally across reconnects). */
	current(): WASocket | null;
	/** The linked self id in canonical form (digits-only E.164), or null pre-connect. */
	selfId(): string | null;
	/** Epoch ms of the most recent successful `connection: "open"` event; `null` pre-connect. */
	connectedAt(): number | null;
	/**
	 * Epoch ms of the last raw `messages.upsert notify` frame the socket
	 * received — including status broadcasts and other passthrough traffic.
	 * Useful as a coarse "transport-is-alive" signal for doctor + health
	 * surfaces. The watchdog deliberately does NOT use this (broadcasts
	 * would falsely keep it warm); see `lastActivityAt()`.
	 */
	lastInboundAt(): number;
	/**
	 * Epoch ms of the last REAL DM/group message that survived the
	 * status/broadcast filter. This is the signal the watchdog reads —
	 * it proves conversational traffic is flowing, not just metadata.
	 */
	lastActivityAt(): number;
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

/**
 * Coerce ANY operator-shaped target into a sendable WhatsApp JID. Accepts:
 *
 *   - `"+91 77026 16808"` / `"+917702616808"` / `"917702616808"` → strips
 *     formatting, treats as a personal phone number, returns
 *     `"917702616808@s.whatsapp.net"`.
 *   - `"917702616808@s.whatsapp.net"` → returned unchanged (already canonical).
 *   - `"123-456-789@g.us"` → returned unchanged (group jid).
 *   - `"260451430568126@lid"` → returned unchanged (LID alias — Baileys handles
 *     the lookup internally during send).
 *
 * Returns `""` when the input has no recoverable digits AND no `@`.
 *
 * The Baileys `sendMessage` API parses the recipient via `jidDecode` and
 * crashes with `"Cannot destructure property 'user' of 'jidDecode(...)' as
 * it is undefined"` when the input is a bare `"+phonenumber"` — `jidDecode`
 * returns undefined because there's no `@`. Normalising at the adapter
 * boundary means the operator (and the model) can address peers by phone
 * number in the natural shape and never has to know about JID syntax.
 */
export function toWhatsAppJid(raw: string | null | undefined): string {
	if (!raw) return "";
	const trimmed = raw.trim();
	if (!trimmed) return "";
	// Already a jid → pass through unchanged. Covers @s.whatsapp.net (personal),
	// @g.us (group), @lid / @hosted.lid (LID alias), @broadcast (status).
	if (trimmed.includes("@")) return trimmed;
	// Bare phone — strip formatting (`+`, spaces, hyphens, parens) and append
	// the personal-jid suffix. We DO NOT validate the number's country-code
	// shape; Baileys will reject with a clear error if the number is invalid.
	const digits = trimmed.replace(/\D/g, "");
	if (!digits) return "";
	return `${digits}@s.whatsapp.net`;
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
 * Read the on-disk LID-reverse mapping file Baileys writes alongside its
 * multi-file auth store. When `signalRepository.lidMapping.getPNForLID` hasn't
 * cached a mapping yet (typical right after a fresh link), the cached reverse
 * file is the only place to find the LID → phone translation. Path shape:
 *   `<authDir>/lid-mapping-<lid>_reverse.json` → JSON containing the phone
 *   number (string or number) the LID is aliased to.
 *
 * Sync (single small JSON file, microseconds); the caller's outer resolver is
 * async because the runtime lookup is async. Returns null when the file is
 * absent, unreadable, or carries a null/empty value.
 */
function readLidReverseMappingSync(
	authDir: string | null | undefined,
	lidDigits: string,
	accountId: string = "default",
): string | null {
	if (!lidDigits) return null;
	// Convex mode — the lid-mapping keys live in the keystore; the
	// auth-state module mirrors reverse entries for exactly this sync read.
	// The mirror is keyed by accountId, so the lookup MUST use the same
	// accountId the auth-state was loaded with (not a hardcoded "default",
	// which silently misses for any non-default WhatsApp account → inbound
	// LID-form senders get dropped).
	if (tryGetRuntimeContext()?.mode === "convex") {
		return lookupLidReverseSync(accountId, lidDigits);
	}
	if (!authDir) return null;
	// Best-effort filesystem read — gated by a quick exists check so the
	// happy-path "no mapping yet" branch doesn't spam the disk.
	try {
		const mappingPath = joinPath(authDir, `lid-mapping-${lidDigits}_reverse.json`);
		if (!existsSync(mappingPath)) return null;
		const raw = readFileSync(mappingPath, "utf8");
		const parsed = JSON.parse(raw) as string | number | null;
		if (parsed === null || parsed === undefined) return null;
		const digits = String(parsed).replace(/\D/g, "");
		return digits.length >= 7 ? digits : null;
	} catch {
		// Missing / malformed / racing-with-write — degrade silently to the
		// runtime-lookup path so a transient read error doesn't drop the msg.
		return null;
	}
}

/**
 * Resolve a WhatsApp jid to a canonical phone number (digits-only E.164),
 * including LID-aliased jids that need a runtime lookup. Resolution order
 * for LID jids:
 *   1. On-disk reverse mapping at `<authDir>/lid-mapping-<lid>_reverse.json`
 *      (Baileys persists these across reconnects — survives the cold-start
 *      window where `signalRepository.lidMapping` is empty).
 *   2. `signalRepository.lidMapping.getPNForLID()` — the live in-memory cache.
 *
 * Returns `null` when:
 *   - `jid` is empty/missing
 *   - the jid is in LID form AND neither resolution path yields a phone
 *   - the resolved value isn't a recognized phone-jid shape
 *
 * Callers MUST drop messages with a `null` resolution rather than inventing a
 * fake sender id from raw LID digits — those digits aren't a phone number, and
 * downstream pairing/allow-list code keys on E.164.
 *
 * `authDir` is optional so tests can call without an on-disk store; when
 * omitted only the runtime lookup is consulted.
 */
export async function resolveJidToE164(
	sock: WASocket | null,
	jid: string | null | undefined,
	authDir?: string,
	accountId?: string,
): Promise<string | null> {
	if (!jid) return null;
	const direct = jid.match(WA_PHONE_JID_RE);
	if (direct) return direct[1] ?? null;
	const lidMatch = jid.match(WA_LID_JID_RE);
	if (!lidMatch) return null;
	const lidDigits = lidMatch[1] ?? "";
	// First: on-disk reverse mapping. Baileys' multi-file auth store writes
	// these the moment it sees a LID's phone translation, so right after a
	// fresh link they're available even while the in-memory `lidMapping` is
	// still warming up.
	const fromDisk = readLidReverseMappingSync(authDir, lidDigits, accountId);
	if (fromDisk) return fromDisk;
	// Then: runtime lookup. Some Baileys builds expose
	// `signalRepository.lidMapping`; older / partially-initialized sockets
	// don't. Treat a missing lookup as "unresolvable" — we already tried disk.
	const lookup = (sock as unknown as { signalRepository?: { lidMapping?: LidLookup } } | null)?.signalRepository
		?.lidMapping;
	if (!lookup?.getPNForLID) return null;
	try {
		const pnJid = await lookup.getPNForLID(jid);
		if (!pnJid) return null;
		const m = pnJid.match(WA_PHONE_JID_RE);
		return m ? (m[1] ?? null) : null;
	} catch {
		// Lookup failure (e.g. mapping not cached yet) → fall through.
		return null;
	}
}

/** Strip a device-id suffix (`:NN`) from a jid, leaving the bare user jid. */
export function normalizeDeviceScopedJid(jid: string | null | undefined): string | null {
	return jid ? jid.replace(/:\d+/, "") : null;
}

/**
 * Resolve an inbound sender jid to a STABLE channel identity that NEVER drops a
 * usable sender. Mirrors the reference codebase's identity model
 * (`getPrimaryIdentityId`: e164 || jid || lid): try the phone number first, and
 * when it can't be resolved — e.g. an unmapped `@lid` privacy alias, the common
 * case for group participants — fall back to the canonical LID jid so the
 * message still reaches the access-control gate instead of being silently
 * dropped at the socket layer. The LID is a perfectly stable "same person"
 * handle: routing, allow-lists, and per-sender sessions all key off the
 * returned `id` exactly the way they key off a phone number.
 *
 * Returns:
 *   { id: "<e164 digits>", e164: "<e164 digits>" }   — phone resolved
 *   { id: "<digits>@lid", lid: "<digits>@lid" }       — LID alias, unmapped
 *   { id: "<normalized jid>" }                         — other jid shape
 *   null                                               — empty / unusable input
 */
export async function resolveSenderIdentity(
	sock: WASocket | null,
	jid: string | null | undefined,
	authDir?: string,
	accountId?: string,
): Promise<{ id: string; e164?: string; lid?: string } | null> {
	if (!jid) return null;
	// Capture the LID alias whenever the sender came in via one — even when it
	// DID map to a phone number — so the access-control gate can match on either
	// the number or the LID (mirrors the reference codebase's identity overlap).
	const lid = WA_LID_JID_RE.test(jid) ? (normalizeDeviceScopedJid(jid) ?? undefined) : undefined;
	const e164 = await resolveJidToE164(sock, jid, authDir, accountId);
	if (e164) return { id: e164, e164, ...(lid ? { lid } : {}) };
	const normalized = normalizeDeviceScopedJid(jid) ?? jid;
	if (!normalized) return null;
	// Unmapped LID privacy alias — keep it verbatim as the stable identity.
	if (lid || /@(lid|hosted\.lid)$/i.test(normalized)) {
		return { id: normalized, lid: lid ?? normalized };
	}
	// Some other jid shape we couldn't map — keep it rather than dropping.
	return { id: normalized };
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

// How often to send an outbound "available" presence ping while the link is
// otherwise idle. WhatsApp's servers can silently mark a long-idle linked
// device offline (queueing inbound until the next reconnect) — a periodic
// nudge keeps the link warm. Defaults to 5 minutes; tune with the env var
// when debugging suspicious overnight stalls.
const PRESENCE_PING_MS_DEFAULT = 5 * 60 * 1_000;
function presencePingMs(): number {
	const raw = process.env.BRIGADE_WHATSAPP_PRESENCE_PING_MS;
	const parsed = raw ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : PRESENCE_PING_MS_DEFAULT;
}

/**
 * Cold-start presence nudges. After EVERY `connection: "open"` event we
 * fire `sendPresenceUpdate("available")` once immediately, then again at
 * these offsets. WhatsApp's server has a "is the device really ready"
 * debounce — one presence ping is often not enough to convince it to
 * flush a queued message backlog, leaving the operator staring at a
 * silent chat for ~60s on first connect. Three quick re-pings during
 * the cold-start window pull that floor down to ~5-15 s. Cheap (one
 * outbound stanza each) and cancelled the moment a real inbound flows.
 *
 * Tuning rationale: 5s catches the case where the first presence beat
 * the server's "device-ready" decision; 15s catches the case where the
 * server held the queue waiting for a steady-state signal; 30s is the
 * outer envelope before the regular 5-min ping cadence takes over.
 */
const COLD_START_NUDGES_MS = [5_000, 15_000, 30_000] as const;

// Long-lived sessions accumulate Signal-protocol state drift; a clean recycle
// every N hours costs one reconnect and avoids a midnight stall against a
// session the server has quietly invalidated. 6h default — long enough to
// avoid churn during a normal workday, short enough to recover before the
// next morning.
const MAX_SESSION_AGE_MS_DEFAULT = 6 * 60 * 60 * 1_000;
function maxSessionAgeMs(): number {
	const raw = process.env.BRIGADE_WHATSAPP_MAX_SESSION_AGE_MS;
	const parsed = raw ? Number(raw) : NaN;
	// Minimum 10 min so a misconfigured "0" doesn't reconnect-storm.
	return Number.isFinite(parsed) && parsed >= 10 * 60_000 ? parsed : MAX_SESSION_AGE_MS_DEFAULT;
}

// Baileys DisconnectReason value emitted when a NEW WhatsApp Web session opens
// against the same number — another linked Brigade or a manual Web login. Two
// sessions reconnecting on the same number get into a 440-conflict ping-pong
// loop, so this code is treated as terminal (same as logged-out) instead of
// retried.
const MULTI_DEVICE_CONFLICT_CODE = 440;

/**
 * Detect Signal-protocol crypto errors that bubble up from Baileys as
 * unhandled promise rejections instead of through the `connection.update`
 * event (the protocol library throws inside its own async ratchet). When a
 * pre-key rotation goes wrong or a session entry desyncs we'd otherwise wait
 * for the watchdog to time out; trapping the rejection lets us force-reconnect
 * immediately and recover the link in seconds.
 *
 * The attribution-keyword list is deliberately narrow: only stack-frame
 * markers unique to Baileys' WhatsApp transport. Broader markers (e.g. the
 * generic "signal" token, which can appear in unrelated libsignal builds,
 * crypto-library stacks, or even our own log lines) would cause false
 * positives that force-reconnect a healthy socket on unrelated rejections.
 */
export function isWaCryptoError(reason: unknown): boolean {
	const message = String(
		(reason as { message?: unknown } | null | undefined)?.message ?? reason ?? "",
	).toLowerCase();
	const cryptoHit =
		message.includes("unsupported state or unable to authenticate data") ||
		message.includes("bad mac");
	if (!cryptoHit) return false;
	return (
		message.includes("baileys") ||
		message.includes("noise-handler") ||
		message.includes("aesdecryptgcm") ||
		message.includes("@whiskeysockets")
	);
}

/**
 * Extract plain text from a Baileys message, unwrapping the common envelopes
 * (`ephemeralMessage`, `viewOnceMessage*`, `documentWithCaptionMessage`) and
 * surfacing placeholder text for content kinds without a natural body —
 * shared contacts, location pins, polls — so the LLM at least sees that the
 * user sent SOMETHING and can acknowledge it instead of silently dropping
 * the inbound.
 */
function extractText(message: WAMessage["message"], normalize: (m: unknown) => unknown): string {
	// `normalize` is Baileys' own envelope-flattener; we still wrap it in our
	// wrapper-chain walk in case `normalize` itself leaves a wrapper in place
	// for shapes it doesn't recognize (newer Baileys variants).
	const flattened = (normalize(message) ?? {}) as WAMessage["message"];
	let content = flattened as Record<string, unknown>;
	const fromWrappers = unwrapWrapperEnvelopes(flattened);
	if (fromWrappers) content = fromWrappers as Record<string, unknown>;

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

	// Contact card — placeholder so the LLM knows a contact was shared.
	const contact = content.contactMessage as { displayName?: string } | undefined;
	if (contact && typeof contact.displayName === "string" && contact.displayName.length > 0) {
		return `[contact shared: ${contact.displayName}]`;
	}
	const contactsArray = content.contactsArrayMessage as { contacts?: { displayName?: string }[] } | undefined;
	if (contactsArray?.contacts && contactsArray.contacts.length > 0) {
		const names = contactsArray.contacts
			.map((c) => (typeof c?.displayName === "string" ? c.displayName : ""))
			.filter(Boolean);
		if (names.length > 0) return `[contacts shared: ${names.join(", ")}]`;
	}
	// Location pin — placeholder with lat/lon when present.
	const loc = content.locationMessage as
		| { degreesLatitude?: number; degreesLongitude?: number; name?: string }
		| undefined;
	if (loc && (typeof loc.degreesLatitude === "number" || typeof loc.name === "string")) {
		const named = typeof loc.name === "string" && loc.name ? `"${loc.name}"` : "";
		const coords =
			typeof loc.degreesLatitude === "number" && typeof loc.degreesLongitude === "number"
				? `(${loc.degreesLatitude.toFixed(6)}, ${loc.degreesLongitude.toFixed(6)})`
				: "";
		return `[location shared ${named}${named && coords ? " " : ""}${coords}]`.trim();
	}
	// Live-location update — placeholder so a stream of these doesn't drop silently.
	if (content.liveLocationMessage) return "[live location update]";
	return "";
}

/**
 * Wrapper envelopes Baileys' own `normalizeMessageContent` may not unwrap
 * (newer message kinds, hosted-LID variants). Walks the chain in lock-step
 * with `inbound-extras.ts:unwrapMessage` so caller behavior is consistent.
 */
const WRAPPER_KEYS = [
	"ephemeralMessage",
	"viewOnceMessage",
	"viewOnceMessageV2",
	"viewOnceMessageV2Extension",
	"documentWithCaptionMessage",
	"botInvokeMessage",
	"groupMentionedMessage",
];
function unwrapWrapperEnvelopes(message: WAMessage["message"]): WAMessage["message"] | undefined {
	let current = message;
	for (let depth = 0; depth < 8 && current; depth += 1) {
		const obj = current as Record<string, unknown>;
		let inner: WAMessage["message"] | undefined;
		for (const key of WRAPPER_KEYS) {
			const wrapper = obj[key] as { message?: WAMessage["message"] } | undefined;
			if (wrapper?.message) {
				inner = wrapper.message;
				break;
			}
		}
		if (!inner) return current;
		current = inner;
	}
	return current;
}

/**
 * Establish a WhatsApp Web connection with auto-reconnect. Resolves once the
 * first socket is constructed (NOT once connected — QR/open events arrive via
 * the callbacks). The returned handle owns the reconnect loop.
 */
/**
 * Patch `console.info` ONCE per process so the libsignal protocol library
 * (Baileys' Signal implementation) stops dumping massive `Closing session:
 * SessionEntry { … }` objects into the gateway log on every key-ratchet step.
 * That's a debug print inside `libsignal/src/session_record.js` we can't reach
 * to remove; filtering at the console layer keeps the gateway log readable
 * without losing real `console.info` calls.
 *
 * Idempotent — the patch checks for its own marker so a second `connectWhatsApp`
 * call doesn't double-wrap.
 */
const LIBSIGNAL_FILTER_MARKER = Symbol.for("brigade.libsignal.console.filter");
function installLibsignalConsoleFilter(): void {
	const flag = console as unknown as { [LIBSIGNAL_FILTER_MARKER]?: true };
	if (flag[LIBSIGNAL_FILTER_MARKER]) return;
	const original = console.info.bind(console);
	console.info = ((...callArgs: unknown[]) => {
		const first = callArgs[0];
		if (typeof first === "string" && first.startsWith("Closing session:")) return;
		original(...callArgs);
	}) as typeof console.info;
	flag[LIBSIGNAL_FILTER_MARKER] = true;
}

export async function connectWhatsApp(args: ConnectWhatsAppArgs): Promise<WhatsAppConnection> {
	installLibsignalConsoleFilter();
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

	// Auth state — mode dispatch. Filesystem: Baileys' own multi-file dir
	// (~900 small files under the channel state dir). Convex: the
	// whatsappAuthCreds/whatsappAuthKeys tables via useConvexAuthState — no
	// auth files on disk; key material is sealed before it leaves the
	// process; pre-hydrated in one query so Signal-path key reads never pay
	// a network round-trip.
	const rctxForAuth = tryGetRuntimeContext();
	// One accountId for the whole connection: the auth-state load, the
	// LID-reverse mirror lookups, and (convex) the close() flush all key off
	// it. Hardcoding "default" downstream silently breaks any non-default
	// WhatsApp account.
	const connectionAccountId = args.accountId ?? "default";
	let state: Awaited<ReturnType<typeof useMultiFileAuthState>>["state"];
	let saveCreds: () => Promise<void>;
	// Convex-mode: the auth-state queues key writes write-behind. Capture its
	// flush so close() can drain it — otherwise a fresh pair's keys can be
	// lost when the link command exits right after a successful connect.
	let convexAuthFlush: (() => Promise<void>) | undefined;
	if (rctxForAuth?.mode === "convex") {
		const convexAuth = await useConvexAuthState(rctxForAuth.store, connectionAccountId, {
			initAuthCreds: baileys.initAuthCreds as never,
			BufferJSON: baileys.BufferJSON as never,
			proto: baileys.proto as never,
		});
		state = convexAuth.state as never;
		saveCreds = convexAuth.saveCreds;
		convexAuthFlush = convexAuth.flush;
	} else {
		const multiFile = await useMultiFileAuthState(args.authDir);
		state = multiFile.state;
		saveCreds = multiFile.saveCreds;
	}
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
	// DMing themselves (selfChat). 20-min TTL — long enough to survive a
	// slow reconnect, short enough to bound memory on a chatty account.
	const outboundDedupe = createDedupeCache({ maxEntries: 5_000, ttlMs: 20 * 60 * 1_000 });
	/**
	 * Compose the outbound-dedupe key from the destination jid + the WhatsApp
	 * `msg.key.id`. WAMIDs are statistically unique, but defence-in-depth: if
	 * a future Baileys build ever reuses short ids across chats, an id-only
	 * key would collide and Brigade would mis-classify a real inbound from
	 * one chat as an echo of an outbound from another. Conversation-scoped
	 * keys close that window with no real cost.
	 */
	const outboundKey = (conversationId: string, messageId: string): string =>
		`${conversationId}:${messageId}`;
	const recordOutboundId = (conversationId: string, id: string | undefined | null): void => {
		if (id) outboundDedupe.remember(outboundKey(conversationId, id));
	};
	// Track the last QR we surfaced so a Baileys QR refresh (same string) doesn't
	// flood the operator's terminal with duplicate prints. Only NEW QRs reach
	// `args.onQr`.
	let lastQr: string | null = null;
	// Pending creds writes are tracked so a reconnect (notably the 515 that
	// follows first-link) can wait for them to flush before rebuilding.
	let pendingCredsSave: Promise<void> = Promise.resolve();
	// Epoch ms of the most recent `connection: "open"` event. Inbound messages
	// older than `connectedAtMs - PAIRING_GRACE_MS` are treated as queued-since-
	// last-restart history — the access-control gate uses this to suppress
	// pairing-challenge replies to historical DMs (otherwise every stranger
	// who messaged Brigade since the last shutdown gets a code in a burst
	// the moment the gateway reconnects).
	let connectedAtMs: number | null = null;
	// How long a "healthy" session must run before its next disconnect is
	// treated as a fresh flap rather than another retry inside an existing
	// failure sequence. Without this guard a link that ran fine for 2 hours
	// then blipped would consume all 12 reconnect attempts in a few minutes;
	// every flap mid-cycle would count as one more retry against a budget
	// that should have been considered fresh.
	const LONG_SESSION_RESET_MS = 60_000;
	// Watchdog state. Two clocks:
	//   `lastInboundAt` — bumped on ANY notify frame (incl. status@broadcast).
	//     Coarse "transport seeing traffic" signal; kept for telemetry + back-
	//     compat with consumers that may already read it.
	//   `lastActivityAt` — bumped ONLY after per-message filtering rejects the
	//     broadcast / dedupe / LID-unresolvable cases, so the watchdog wakes
	//     up when REAL DM/group inbound stops flowing — not when story updates
	//     happen to keep the socket warm.
	// The watchdog reads `lastActivityAt`. Disabled in linkMode (one-shot).
	let lastInboundAt = Date.now();
	let lastActivityAt = Date.now();
	let watchdogTimer: ReturnType<typeof setInterval> | null = null;
	// Periodic outbound presence ping — keeps WhatsApp's server convinced the
	// device is online even during long idle windows. Armed when the link
	// opens, cleared on teardown.
	let presencePingTimer: ReturnType<typeof setInterval> | null = null;
	// Cold-start presence nudge timers — extra presence-updates fired in the
	// first ~30s after each `connection.open` to convince WhatsApp's server
	// the device is genuinely ready and trigger immediate queue flush.
	// Cleared on teardown AND cancelled the moment real conversational
	// traffic starts flowing (no need to keep nagging once we know the
	// queue is open).
	let coldStartNudgeTimers: Array<ReturnType<typeof setTimeout>> = [];
	const clearColdStartNudges = (): void => {
		for (const t of coldStartNudgeTimers) clearTimeout(t);
		coldStartNudgeTimers = [];
	};
	// Max-session-age guard — preventively recycles the socket every N hours
	// so accumulated Signal-state drift can't silently kill inbound delivery.
	let sessionAgeTimer: ReturnType<typeof setTimeout> | null = null;
	const WATCHDOG_CHECK_MS = 60_000;
	const WATCHDOG_STALE_MS = 10 * 60 * 1_000;
	// Connect-time liveness probe. As soon as the link opens we want proof that
	// inbound is actually flowing — not just a socket that *says* "ready" while
	// the server silently holds the queue (the "turn it on after a week and
	// nothing arrives" failure). WhatsApp emits `receivedPendingNotifications:
	// true` on `connection.update` once it has flushed everything that arrived
	// while the device was away; a real inbound also counts as proof. If NEITHER
	// happens within COLD_START_HEALTH_MS of connect, the socket is wedged, so we
	// force ONE immediate clean reconnect to wake it — instead of waiting out the
	// 10-minute watchdog. Bounded to MAX_COLD_START_KICKS per attempt so a
	// legitimately slow flush of a huge backlog can't become a reconnect-storm.
	const COLD_START_HEALTH_MS = 90_000;
	const MAX_COLD_START_KICKS = 2;
	let coldStartHealthTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingNotificationsSeen = false;
	let coldStartKicks = 0;
	const clearColdStartHealth = (): void => {
		if (coldStartHealthTimer) {
			clearTimeout(coldStartHealthTimer);
			coldStartHealthTimer = null;
		}
	};

	// Signal-protocol crypto errors don't reach `connection.update` — they
	// surface as unhandled rejections from inside Baileys' async ratchet.
	// Trap them per-connection and force a fast reconnect; the handler is
	// idempotent (the `closed` + `linkMode` guards keep multi-account
	// processes safe) and is removed on `close()`. The actual `process.on`
	// registration happens at the bottom of `connectWhatsApp` once
	// `teardownSocket` and `scheduleReconnect` have been declared.
	const onUnhandledRejection = (reason: unknown): void => {
		if (closed || args.linkMode) return;
		if (!isWaCryptoError(reason)) return;
		args.log("WhatsApp Signal-crypto error — force-reconnecting", {
			error: String((reason as { message?: unknown } | null | undefined)?.message ?? reason ?? ""),
		});
		const dying = sock;
		sock = null;
		teardownSocket(dying);
		reconnectAttempts = 0;
		scheduleReconnect({ immediate: true });
	};

	/** Detach every listener from a socket and end it — no zombie emits. */
	// Per-socket detach callbacks. Every listener attached inside `buildSocket`
	// pushes its `() => emitter.off(event, handler)` here so `teardownSocket`
	// can detach each one explicitly before falling back to the coarse
	// `removeAllListeners()`. Explicit detach is the principled path —
	// `removeAllListeners` would also drop any listener a future Brigade
	// subsystem (a doctor probe, a sub-agent, an extension) might have
	// attached to the same emitter.
	const socketDetach = new Map<WASocket, Array<() => void>>();
	const registerDetach = (s: WASocket, off: () => void): void => {
		let list = socketDetach.get(s);
		if (!list) {
			list = [];
			socketDetach.set(s, list);
		}
		list.push(off);
	};

	const teardownSocket = (s: WASocket | null): void => {
		// Per-socket timers go down with the socket — a fresh `buildSocket`
		// re-arms them in the next open handler. Clearing here keeps a
		// reconnect from leaving zombie pings firing against a dead socket.
		if (presencePingTimer) {
			clearInterval(presencePingTimer);
			presencePingTimer = null;
		}
		if (sessionAgeTimer) {
			clearTimeout(sessionAgeTimer);
			sessionAgeTimer = null;
		}
		clearColdStartNudges();
		clearColdStartHealth();
		if (!s) return;
		// Detach our own listeners explicitly first so we never drop
		// listeners owned by callers (defense against a future cross-cutting
		// subsystem subscribing to the same emitter).
		const detaches = socketDetach.get(s);
		if (detaches) {
			for (const off of detaches) {
				try {
					off();
				} catch {
					/* best-effort — keep going on the next detach */
				}
			}
			socketDetach.delete(s);
		}
		// Belt-and-braces fallback: in case a Baileys-internal listener slipped
		// past our register helper, the coarse removeAllListeners catches it.
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

	const scheduleReconnect = (opts: { immediate?: boolean } = {}): void => {
		if (closed || reconnectTimer) return;
		if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
			args.log("WhatsApp reconnect attempts exhausted — giving up until restart", {
				attempts: reconnectAttempts,
			});
			return;
		}
		// `immediate: true` is set by the 515 first-link recovery path — we know
		// the creds just landed and there's no rate-limit risk reconnecting at
		// once. Skipping the 2s backoff turns a 7-second pair into a 2-second
		// pair and avoids a window where neither socket nor timer is anchoring
		// the Node event loop. For drop recoveries we keep the jittered backoff.
		const delay = opts.immediate ? 0 : backoffDelay(reconnectAttempts);
		reconnectAttempts += 1;
		// During linkMode the CLI is rendering a polished status; the technical
		// "reconnecting attempt=N delayMs=…" line would clutter the link UX.
		// Gateway mode keeps the structured log — operators want that detail.
		if (!args.linkMode) {
			args.log("WhatsApp reconnecting", { attempt: reconnectAttempts, delayMs: delay });
		}
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
		// In gateway mode we `.unref()` so a permanently-broken link can't keep
		// the daemon alive across shutdown. In linkMode we MUST NOT unref — the
		// CLI's outer `await done` is the only thing holding the event loop
		// open across the brief gap between socket teardown and rebuild; an
		// unref'd timer plus a torn-down socket = nothing anchoring the loop,
		// which surfaces as "Detected unsettled top-level await" and an early
		// exit BEFORE the new socket reaches `open`.
		if (!args.linkMode) reconnectTimer.unref?.();
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
			// Explicit timeouts + keepalive. Baileys' defaults work in
			// well-connected environments but leave the door open to slow
			// silent failures over flaky networks: keepalive at 25s sits
			// under WhatsApp's typical 30s server-side idle threshold so
			// the link gets nudged before the server marks it offline; the
			// 60s connect/query timeouts give Baileys enough headroom on
			// the initial handshake without dragging shutdown.
			keepAliveIntervalMs: 25_000,
			connectTimeoutMs: 60_000,
			defaultQueryTimeoutMs: 60_000,
			retryRequestDelayMs: 250,
			qrTimeout: 60_000,
			auth: {
				creds: state.creds,
				// biome-ignore lint/suspicious/noExplicitAny: pino-shaped stub logger
				keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
			},
		});

		const credsUpdateHandler = (): void => {
			pendingCredsSave = Promise.resolve(saveCreds()).catch((err) => {
				args.log("failed saving WhatsApp creds", { error: err instanceof Error ? err.message : String(err) });
			});
		};
		s.ev.on("creds.update", credsUpdateHandler);
		registerDetach(s, () => {
			(s.ev as unknown as { off?: (e: string, h: () => void) => void }).off?.("creds.update", credsUpdateHandler);
		});

		const connectionUpdateHandler = (update: Partial<ConnectionState>): void => {
			// Wrap the whole handler — a throw inside a Baileys event emit would
			// otherwise surface as an unhandled rejection and could crash the daemon.
			try {
				const { connection, lastDisconnect, qr } = update;
				// Offline-queue flush signal — WhatsApp sets
				// `receivedPendingNotifications: true` on `connection.update` once it
				// has delivered everything that arrived while the device was away.
				// That's positive proof inbound is flowing (not a connected-but-deaf
				// socket), so we disarm the connect-time liveness probe and announce
				// the catch-up — the operator sees "turned it on → immediately caught
				// up", even after a week away.
				if ((update as { receivedPendingNotifications?: boolean }).receivedPendingNotifications) {
					if (!pendingNotificationsSeen) {
						pendingNotificationsSeen = true;
						coldStartKicks = 0;
						clearColdStartHealth();
						if (!args.linkMode) args.log("WhatsApp caught up — offline message queue flushed");
					}
				}
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
					const now = Date.now();
					lastInboundAt = now; // coarse "frames flowing" reset on fresh link
					lastActivityAt = now; // watchdog clock reset on fresh link
					connectedAtMs = now; // anchor the pairing-grace window
					pendingNotificationsSeen = false; // re-arm the connect-time liveness probe
					clearColdStartHealth();
					// Gateway mode: always log the structured event.
					// Link mode: the CLI renders the polished success card itself,
					//   so suppress the duplicate "connected" log here.
					if (!args.linkMode) args.log("connected to WhatsApp");
					args.onConnected?.();
					// Tell WhatsApp's server we're online and ready for queued
					// messages. Without this nudge the server can sit on queued
					// inbound for hours (boot connection silent until a later
					// reconnect happens to push the queue) — exactly the overnight
					// "connected but no messages" failure mode. Fires on EVERY
					// fresh `open`, not just the first connect, so watchdog-
					// triggered reconnects also reannounce presence. `queueMicrotask`
					// so `onConnected` callers see the connection before any
					// outbound traffic.
					if (!args.linkMode) {
						queueMicrotask(() => {
							const live = sock;
							if (!live) return;
							void Promise.resolve()
								.then(() => live.sendPresenceUpdate?.("available"))
								.catch((err) => {
									args.log("WhatsApp presence-update on open failed", {
										error: err instanceof Error ? err.message : String(err),
									});
								});
						});
						// Cold-start nudges. The single presence-update above is
						// often not enough to convince WhatsApp's server the device
						// is "really" ready — there's a server-side debounce that
						// otherwise holds the queue for ~60s before flushing. Three
						// quick re-pings during the cold window pull that floor
						// down to ~5-15s. Self-cancel as soon as real inbound
						// flows (see the per-message loop). New nudges replace any
						// stale ones from a prior `open` event in the same lifetime.
						clearColdStartNudges();
						for (const offset of COLD_START_NUDGES_MS) {
							const timer = setTimeout(() => {
								if (closed) return;
								const live = sock;
								if (!live) return;
								void Promise.resolve()
									.then(() => live.sendPresenceUpdate?.("available"))
									.catch((err) => {
										args.log("WhatsApp cold-start presence-nudge failed", {
											offsetMs: offset,
											error: err instanceof Error ? err.message : String(err),
										});
									});
							}, offset);
							timer.unref?.();
							coldStartNudgeTimers.push(timer);
						}
						// Arm the periodic presence ping (idle keepalive nudge).
						// Cleared by `teardownSocket` on the next reconnect / close.
						if (presencePingTimer) clearInterval(presencePingTimer);
						const pingInterval = presencePingMs();
						presencePingTimer = setInterval(() => {
							if (closed) return;
							const live = sock;
							if (!live) return;
							void Promise.resolve()
								.then(() => live.sendPresenceUpdate?.("available"))
								.catch((err) => {
									args.log("WhatsApp presence-ping failed", {
										error: err instanceof Error ? err.message : String(err),
									});
								});
						}, pingInterval);
						presencePingTimer.unref?.();
						// Arm the max-session-age recycle. After N hours we force a
						// clean reconnect regardless of how healthy the link looks —
						// preventive defense against accumulated Signal state drift.
						if (sessionAgeTimer) clearTimeout(sessionAgeTimer);
						const sessionAge = maxSessionAgeMs();
						sessionAgeTimer = setTimeout(() => {
							if (closed) return;
							args.log("WhatsApp forced reconnect after max session age", {
								maxAgeMs: sessionAge,
							});
							const dying = sock;
							sock = null;
							teardownSocket(dying);
							reconnectAttempts = 0; // preventive recycle isn't a failure
							scheduleReconnect();
						}, sessionAge);
						sessionAgeTimer.unref?.();
						// Arm the connect-time liveness probe (one-shot per open). If
						// the offline-queue flush (`receivedPendingNotifications`)
						// hasn't arrived AND no real inbound has flowed within
						// COLD_START_HEALTH_MS, the socket is connected-but-deaf — force
						// ONE immediate clean reconnect so a wedged link wakes up in
						// ~90s instead of waiting out the 10-minute watchdog. Bounded by
						// MAX_COLD_START_KICKS so a legitimately slow flush of a huge
						// backlog can't become a reconnect-storm; after that we leave it
						// to the steady-state watchdog.
						clearColdStartHealth();
						coldStartHealthTimer = setTimeout(() => {
							if (closed || !sock) return;
							if (pendingNotificationsSeen) return; // queue flushed / inbound flowed — healthy
							if (Date.now() - lastActivityAt < COLD_START_HEALTH_MS) return; // real inbound recently
							if (coldStartKicks >= MAX_COLD_START_KICKS) {
								args.log("WhatsApp liveness probe — still no inbound after retries; leaving it to the watchdog", {
									kicks: coldStartKicks,
								});
								return;
							}
							coldStartKicks += 1;
							args.log("WhatsApp liveness probe — no inbound flow after connect, forcing reconnect to wake the link", {
								waitedMs: COLD_START_HEALTH_MS,
								kick: coldStartKicks,
							});
							const dying = sock;
							sock = null;
							teardownSocket(dying);
							reconnectAttempts = 0; // liveness kick isn't a failure sequence
							scheduleReconnect({ immediate: true });
						}, COLD_START_HEALTH_MS);
						coldStartHealthTimer.unref?.();
					}
				}
				if (connection === "close") {
					const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
						?.statusCode;
					// Tear the dead socket down BEFORE doing anything else so its
					// listeners can't fire again (no leak, no duplicate inbound).
					teardownSocket(s);
					if (sock === s) sock = null;
					// If this socket lived for more than LONG_SESSION_RESET_MS, the
					// close is a fresh flap — not the continuation of a failing
					// reconnect sequence. Reset the attempt counter so the new
					// flap gets the full 12-retry budget instead of inheriting a
					// burned-down one from earlier in the day. Without this guard,
					// a single transient blip after a healthy 2-hour session can
					// exhaust the budget within minutes.
					if (
						connectedAtMs !== null &&
						Date.now() - connectedAtMs >= LONG_SESSION_RESET_MS &&
						reconnectAttempts > 0
					) {
						reconnectAttempts = 0;
					}
					if (status === loggedOutCode) {
						args.log("WhatsApp session logged out — re-link required");
						args.onLoggedOut?.();
						return; // dead creds — never reconnect
					}
					if (status === MULTI_DEVICE_CONFLICT_CODE) {
						// A new WhatsApp Web session opened against the same number
						// (another linked Brigade, a manual Web login, or the
						// operator scanning the QR somewhere else). Reconnecting
						// here would put us into a 440-conflict ping-pong with the
						// other session — both reconnect, both see 440, both
						// reconnect, forever. Treat as terminal; the operator must
						// resolve which session keeps the link.
						args.log(
							"WhatsApp multi-device conflict — another linked Web session took over; not reconnecting",
						);
						args.onLoggedOut?.();
						return;
					}
					if (status === restartRequiredCode) {
						// Expected immediately after first-link; reconnect promptly
						// without consuming the backoff budget. This single hop is
						// honored even in linkMode — it's part of the pair handshake.
						// During linkMode we emit a single polished progress string
						// instead of the technical "restart required" log; the CLI
						// renders it as "Finalising link…" — much friendlier than
						// "restart required → reconnecting" which sounds like an error.
						if (args.linkMode) {
							args.onLinkProgress?.("Finalising link…");
						} else {
							args.log("WhatsApp restart required (post-link) — reconnecting");
						}
						reconnectAttempts = 0;
						// Immediate reconnect — the creds-flush promise still gates
						// the rebuild, but there's no jittered 2s delay. Halves the
						// total link time and closes the unref'd-timer race window.
						scheduleReconnect({ immediate: true });
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
		};
		s.ev.on("connection.update", connectionUpdateHandler);
		registerDetach(s, () => {
			(s.ev as unknown as { off?: (e: string, h: typeof connectionUpdateHandler) => void }).off?.(
				"connection.update",
				connectionUpdateHandler,
			);
		});

		const messagesUpsertHandler = (payload: { messages: WAMessage[]; type: string }): void => {
			// `notify` = live messages. `append` = the offline/history catch-up
			// batch WhatsApp delivers on (re)connect — the messages that arrived
			// while the device was away. We accept BOTH (mirrors the reference
			// codebase) so a gateway turned on after a long offline window
			// immediately surfaces what it missed; the per-message handler gates
			// `append` to RECENT entries (within APPEND_RECENT_GRACE_MS of connect)
			// so we catch genuinely-missed live messages without replaying the
			// whole backlog of old chats.
			if (payload.type !== "notify" && payload.type !== "append") return;
			const upsertType = payload.type;
			// Coarse "frames are flowing" clock — bumped on ANY notify, including
			// status broadcasts and other passthrough traffic. This proves the
			// transport is alive but says nothing about real inbound delivery,
			// so the watchdog does NOT read it. Telemetry / back-compat only.
			lastInboundAt = Date.now();
			// Process each message in its own async task so media download (a
			// network round-trip) doesn't block the next message's dedupe claim.
			for (const m of payload.messages) {
				void (async () => {
					try {
						const jid = m.key.remoteJid;
						if (!jid) return;
						// Status/broadcast feeds — both legacy (`status@broadcast`) and
						// the suffix variants (`…@status`, `…@broadcast`) — are story
						// updates, never DMs to react to. They must NOT bump the
						// watchdog clock: if a contact posts a story every few
						// minutes, those notifies would otherwise keep the watchdog
						// satisfied while real DMs were silently queued server-side.
						if (jid === "status@broadcast" || jid.endsWith("@status") || jid.endsWith("@broadcast")) return;
						// Real DM/group inbound — bump the watchdog clock. From this
						// point on we know we've got actual conversational traffic.
						lastActivityAt = Date.now();
						// Cancel any pending cold-start nudges — the queue is open
						// and flowing, no need to keep nagging the server.
						if (coldStartNudgeTimers.length > 0) clearColdStartNudges();
						// Real inbound (live OR offline catch-up) proves delivery is
						// flowing — disarm the connect-time liveness probe.
						pendingNotificationsSeen = true;
						clearColdStartHealth();
						// History/offline catch-up (`append`) — process only RECENT
						// entries so a reconnect after a long offline window surfaces
						// genuinely-missed live messages without replaying the whole
						// backlog of old chats. Mirrors the reference codebase's
						// APPEND_RECENT_GRACE_MS gate. `notify` messages are always
						// live and skip this check.
						if (upsertType === "append") {
							const APPEND_RECENT_GRACE_MS = 60_000;
							const tsRaw = m.messageTimestamp;
							const tsSec =
								typeof tsRaw === "number"
									? tsRaw
									: tsRaw && typeof (tsRaw as { toNumber?: () => number }).toNumber === "function"
										? (tsRaw as { toNumber: () => number }).toNumber()
										: 0;
							const tsMs = tsSec > 0 ? tsSec * 1000 : 0;
							if (connectedAtMs !== null && tsMs < connectedAtMs - APPEND_RECENT_GRACE_MS) return;
						}
						const isGroup = jid.endsWith("@g.us");
						const msgId = m.key.id;
						// `fromMe` handling. WhatsApp surfaces TWO distinct flavours of
						// `fromMe: true` messages through the same `messages.upsert`
						// event, and they must be handled completely differently:
						//
						//   (a) ECHO of an outbound Brigade just sent — `msgId` is in
						//       `outboundDedupe` (we remembered it on send). Always
						//       drop; it's not user input.
						//
						//   (b) OPERATOR TYPED ON A LINKED DEVICE (their phone, web,
						//       another linked Brigade) — `msgId` is fresh. This branches:
						//
						//       (b1) DM to a CONTACT (chat jid ≠ operator's own phone):
						//            the operator messaging Mom from their phone. Brigade
						//            MUST NOT engage with this — otherwise we'd send
						//            Mom a pairing-challenge card from the operator's
						//            own account. Drop silently. Matches the upstream
						//            reference's access-control.ts:136-144 "Skipping outbound DM".
						//
						//       (b2) SELF-CHAT (chat jid == operator's own phone): the
						//            "notes-to-self" use case. Flow through as normal
						//            inbound; the bot responds.
						//
						//       (b3) GROUP: fall through so policy.ts can apply the
						//            standard group rules (mention required even for
						//            the operator). policy.ts blocks operator-without-
						//            mention with reason `group:self-without-mention`.
						if (m.key.fromMe) {
							// (a) — known echo of our own outbound.
							if (!msgId || outboundDedupe.peek(outboundKey(jid, msgId))) return;
							// (b1) — operator messaged a contact from a linked device.
							// Detect by comparing the chat jid's canonical phone to the
							// linked self id. Resolution gates on having BOTH — without
							// either, we conservatively drop (better to miss a self-
							// chat than to spam a contact with a pairing card).
							if (!isGroup) {
								const selfPhone = canonicalWhatsAppId(sock?.user?.id);
								const chatPhone = await resolveJidToE164(sock, jid, args.authDir, connectionAccountId);
								const isSelfChat = !!(selfPhone && chatPhone && selfPhone === chatPhone);
								if (!isSelfChat) {
									args.log("dropped operator outbound DM (fromMe, not self-chat)", {
										jid,
										msgId,
									});
									return;
								}
							}
							// (b2) self-chat, or (b3) group: fall through.
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
						// Media download is DEFERRED. Only a cheap envelope probe runs
						// here; the actual download (bytes from WhatsApp + seal +
						// backend archive) happens via `resolveMedia` AFTER the
						// pipeline's access-control gate admits the sender. Eager
						// download meant any stranger in any group could push videos
						// into the operator's storage even though the message itself
						// was dropped by policy.
						const hasMedia = !!(normalized && msgId) && hasInboundMedia(normalized);
						const resolveMedia =
							hasMedia && normalized && msgId
								? () =>
										downloadInboundMedia({
											content: normalized,
											msgId,
											downloadMediaMessage: baileys.downloadMediaMessage as never,
											rawMessage: m,
											log: args.log,
										})
								: undefined;
						// Drop the message entirely only if there's no text AND no media.
						if (!text && !hasMedia) return;
						// Sender resolution. For DMs the chat jid itself is the sender;
						// for groups the per-message `participant` carries the speaker.
						// We resolve to a STABLE identity that NEVER drops a usable
						// sender (mirrors the reference codebase): the phone number when
						// the LID can be mapped, otherwise the canonical `@lid` alias
						// itself — so a group message from a privacy-aliased member
						// still reaches the access-control gate instead of vanishing at
						// the socket layer. Only a genuinely empty/unusable jid drops.
						const rawParticipant = m.key.participant?.trim();
						const senderJid =
							isGroup && rawParticipant && rawParticipant.length > 0 ? rawParticipant : jid;
						const senderIdentity = await resolveSenderIdentity(sock, senderJid, args.authDir, connectionAccountId);
						if (!senderIdentity) {
							args.log("inbound dropped — empty/unusable sender jid", {
								jid,
								participant: rawParticipant,
							});
							return;
						}
						const fromCanonical = senderIdentity.id;
						const senderLid = senderIdentity.lid;
						// Mentions + quoted-reply context come from the normalized message;
						// pulled here so the manager can gate group activation cleanly and
						// the LLM gets the "user replied to X" context for free. Async
						// because LID mentions need the same resolver above.
						const mentions = normalized
							? await extractMentions(normalized, sock, args.authDir, connectionAccountId)
							: [];
						const replyTo = normalized
							? await extractReplyContext(normalized, sock, args.authDir, connectionAccountId)
							: undefined;
						// Baileys' `messageTimestamp` is in seconds (Long or number).
						// Normalize to epoch ms; the manager uses this to decide
						// whether a stranger's DM is "live" or "since-restart
						// history" for the pairing-grace window.
						const tsRaw = m.messageTimestamp;
						const tsSec =
							typeof tsRaw === "number"
								? tsRaw
								: tsRaw && typeof (tsRaw as { toNumber?: () => number }).toNumber === "function"
									? (tsRaw as { toNumber: () => number }).toNumber()
									: undefined;
						args.onMessage({
							conversationId: jid,
							messageId: msgId ?? undefined,
							participantId: isGroup ? rawParticipant : undefined,
							messageTimestampMs: typeof tsSec === "number" && tsSec > 0 ? tsSec * 1000 : undefined,
							from: fromCanonical,
							senderLid,
							fromName: m.pushName ?? undefined,
							text,
							chatType: isGroup ? "group" : "direct",
							mentions: mentions.length > 0 ? mentions : undefined,
							replyTo,
							...(resolveMedia ? { resolveMedia } : {}),
							raw: m,
						});
					} catch (err) {
						args.log("failed to process inbound message", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				})();
			}
		};
		s.ev.on("messages.upsert", messagesUpsertHandler);
		registerDetach(s, () => {
			(s.ev as unknown as { off?: (e: string, h: typeof messagesUpsertHandler) => void }).off?.(
				"messages.upsert",
				messagesUpsertHandler,
			);
		});

		// Surface socket-level WS errors instead of crashing the process.
		const ws = (s as unknown as { ws?: { on?: (e: string, cb: (err: Error) => void) => void; off?: (e: string, cb: (err: Error) => void) => void } }).ws;
		const wsErrorHandler = (err: Error): void => args.log("WhatsApp socket error", { error: String(err) });
		ws?.on?.("error", wsErrorHandler);
		registerDetach(s, () => {
			ws?.off?.("error", wsErrorHandler);
		});

		return s;
	};

	sock = buildSocket();

	// Watchdog — once-a-minute check that WhatsApp is still delivering REAL
	// inbound. Reads `lastActivityAt` (post-filter) so a stream of story-
	// broadcast notifies on an otherwise-silent link can't keep us asleep.
	// If we go past the stale threshold, force a reconnect so the operator
	// doesn't sit there wondering why nothing arrives. Disabled in linkMode
	// (one-shot pair, no daemon).
	if (!args.linkMode) {
		watchdogTimer = setInterval(() => {
			if (closed || !sock) return;
			const elapsed = Date.now() - lastActivityAt;
			if (elapsed < WATCHDOG_STALE_MS) return;
			args.log("WhatsApp watchdog — no inbound activity, forcing reconnect", {
				elapsedMs: elapsed,
				staleThresholdMs: WATCHDOG_STALE_MS,
			});
			const dying = sock;
			sock = null;
			teardownSocket(dying);
			scheduleReconnect();
			// Reset the clock so a flapping link doesn't trigger another forced
			// reconnect before the new socket has a chance to open.
			lastActivityAt = Date.now();
			lastInboundAt = Date.now();
		}, WATCHDOG_CHECK_MS);
		watchdogTimer.unref?.();
	}

	// Trap Signal-protocol crypto rejections (declared earlier in this
	// function; see `onUnhandledRejection`). Registered here, AFTER
	// `teardownSocket` and `scheduleReconnect` are in scope, and removed in
	// `close()` so a torn-down connection's handler doesn't survive past
	// the lifecycle that armed it.
	if (!args.linkMode) {
		process.on("unhandledRejection", onUnhandledRejection);
	}

	const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

	/**
	 * Send one chunk with retry on transient send failures. A WebSocket flap
	 * during a reply would otherwise drop the message silently — Baileys throws
	 * "Connection Closed" / "WS not open" until the auto-reconnect lands a
	 * fresh socket. We back off and retry against the LIVE `sock` reference (so
	 * a reconnect-replaced socket is used on the next attempt). Permanent
	 * errors (e.g. "jid not registered") propagate after the first try.
	 */
	const TRANSIENT_SEND_ERROR = /closed|reset|timed?\s*out|disconnect|not\s*open|stream\s*error|ws/i;
	const SEND_MAX_ATTEMPTS = 3;

	/**
	 * Run an outbound send against the LIVE `sock` reference with retry on
	 * transient WS / disconnect errors. Used by text / media / reaction /
	 * presence paths so a single reconnect mid-flight doesn't silently drop
	 * the send. Permanent errors (e.g. "jid not registered") propagate after
	 * the first try. `kind` is just a log tag — every line for one send shares
	 * a correlation id so operators can grep for it.
	 */
	async function sendWithRetry<T>(
		kind: string,
		send: (live: WASocket) => Promise<T>,
		log: (msg: string, meta?: Record<string, unknown>) => void,
		extra?: Record<string, unknown>,
	): Promise<T> {
		const correlationId = `wa-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
		const startedAt = Date.now();
		let lastErr: unknown;
		for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
			const live = sock;
			if (live) {
				try {
					const result = await send(live);
					log(`WhatsApp ${kind} ok`, {
						correlationId,
						attempt,
						durationMs: Date.now() - startedAt,
						...extra,
					});
					return result;
				} catch (err) {
					lastErr = err;
					const message = err instanceof Error ? err.message : String(err);
					if (!TRANSIENT_SEND_ERROR.test(message)) {
						log(`WhatsApp ${kind} permanent error`, { correlationId, attempt, error: message });
						throw err;
					}
					log(`WhatsApp ${kind} transient — retrying`, { correlationId, attempt, error: message });
				}
			} else {
				lastErr = new Error("WhatsApp socket not connected");
				log(`WhatsApp ${kind} paused — socket reconnecting`, { correlationId, attempt });
			}
			if (attempt < SEND_MAX_ATTEMPTS) await delay(500 * attempt);
		}
		log(`WhatsApp ${kind} failed after retries`, {
			correlationId,
			attempts: SEND_MAX_ATTEMPTS,
			durationMs: Date.now() - startedAt,
			error: lastErr instanceof Error ? lastErr.message : String(lastErr),
		});
		throw lastErr ?? new Error(`WhatsApp ${kind} failed after retries`);
	}

	/** Send a single text chunk with retry. Records the outbound id for echo-dedupe. */
	async function sendOneChunkWithRetry(
		conversationId: string,
		chunk: string,
		log: (msg: string, meta?: Record<string, unknown>) => void,
	): Promise<void> {
		const result = await sendWithRetry(
			"send",
			async (live) =>
				(await live.sendMessage(conversationId, { text: chunk })) as
					| { key?: { id?: string } }
					| undefined,
			log,
			{ chunkBytes: chunk.length },
		);
		// Remember the outbound message id so the inbound `fromMe` echo
		// can be distinguished from a genuine self-chat message (see
		// outboundDedupe in the upsert handler).
		recordOutboundId(conversationId, result?.key?.id);
	}

	return {
		current: () => sock,
		selfId: () => canonicalWhatsAppId(sock?.user?.id) || null,
		connectedAt: () => connectedAtMs,
		lastInboundAt: () => lastInboundAt,
		lastActivityAt: () => lastActivityAt,
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
			// Same transient-retry shape as text — a reconnect mid-upload
			// otherwise drops the media silently. The actual Baileys upload
			// happens inside `live.sendMessage`; if it fails transiently we
			// retry against whatever socket the reconnect loop hands us next.
			const mediaResult = await sendWithRetry(
				`sendMedia(${media.kind})`,
				async (live) =>
					(await live.sendMessage(conversationId, payload as never)) as
						| { key?: { id?: string } }
						| undefined,
				args.log,
			);
			recordOutboundId(conversationId, mediaResult?.key?.id);
		},
		async react(conversationId: string, messageId: string, emoji: string, fromMe?: boolean): Promise<void> {
			// Reactions need the original message's key (jid + id + fromMe). When
			// the caller only has the inbound's id (the common case), pass
			// fromMe=false; for clearing our own reaction, pass fromMe=true.
			// Wrapped in sendWithRetry so a transient reconnect mid-reaction
			// doesn't silently drop it (reactions are cheap; better to retry
			// than to leave a half-acknowledged inbound).
			const reactResult = await sendWithRetry(
				"react",
				async (live) =>
					(await live.sendMessage(conversationId, {
						react: {
							text: emoji, // "" clears any prior reaction
							key: { remoteJid: conversationId, id: messageId, fromMe: fromMe ?? false },
						},
					})) as { key?: { id?: string } } | undefined,
				args.log,
			);
			recordOutboundId(conversationId, reactResult?.key?.id);
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
			if (watchdogTimer) {
				clearInterval(watchdogTimer);
				watchdogTimer = null;
			}
			clearColdStartHealth();
			// Remove the process-level crypto-rejection trap — otherwise a
			// torn-down connection's handler survives and could touch a `sock`
			// that's been nulled out (the `closed` guard catches that, but it's
			// cleaner to deregister).
			process.off("unhandledRejection", onUnhandledRejection);
			// `logout()` would invalidate creds; we want a clean disconnect that
			// keeps the link, so just tear the socket down. (presencePingTimer
			// + sessionAgeTimer are cleared inside teardownSocket.)
			teardownSocket(sock);
			sock = null;
			// Let a final creds write flush so the link survives a restart.
			await pendingCredsSave.catch(() => {});
			// Convex mode: drain the auth-state's write-behind key queue so a
			// just-completed pair (or any keys written right before close) lands
			// in the backend. Without this, a `brigade channels link` that exits
			// immediately after connect can lose the freshly-negotiated keys.
			if (convexAuthFlush) await convexAuthFlush().catch(() => {});
		},
	};
}
