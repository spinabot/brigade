/**
 * Channel access control — types.
 *
 * Brigade's WhatsApp (and any future messaging channel) gates inbound messages
 * BEFORE the LLM runs. Without this, anyone who knows the linked phone number
 * can DM the agent and get full access — a B2B blocker.
 *
 * Policies (`channels.<id>.dmPolicy`):
 *
 *   - `pairing` (default): strangers get an 8-char pairing code in the reply
 *     and must be approved out-of-band by the operator (`brigade pairing
 *     approve <CODE>`), which adds them to the allow-from list. The operator's
 *     own linked-self number is always allowed (self-chat).
 *   - `allowlist`: only senders explicitly added via
 *     `brigade channels allow add <id>` get through. No automatic challenge.
 *   - `open`: anyone can DM (dangerous default for B2B — explicit opt-in).
 *   - `disabled`: every DM is silently dropped (lock down).
 */

/** The four DM-policy modes. Default is `pairing`. */
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

/** A pending pairing code issued to a sender; expires after PAIRING_TTL_MS. */
export interface PairingRequest {
	/** Stable sender id on the channel (e.g. WhatsApp E.164 like `15551234567`). */
	senderId: string;
	/** Channel-display name when known (push name on WhatsApp). */
	senderName?: string;
	/** The 8-char one-shot code the operator approves. */
	code: string;
	/** ISO timestamp of issuance. */
	createdAt: string;
	/** ISO timestamp of the last DM that re-prompted this code. */
	lastSeenAt: string;
}

/** Decision returned by the policy evaluator for one inbound message. */
export type AccessDecision =
	/** Allow the message through; the manager runs an agent turn. */
	| { kind: "allow"; reason: string }
	/** Silently drop the message; no reply, no turn. */
	| { kind: "block"; reason: string }
	/** Block this message, but reply to the sender with an issued pairing code. */
	| { kind: "challenge"; code: string; reason: string };
