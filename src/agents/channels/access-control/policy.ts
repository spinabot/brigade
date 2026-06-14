/**
 * Channel access-control policy — pure decision logic.
 *
 * `evaluateAccess` takes the channel's configured policy + lists and an inbound
 * sender, and returns one of: allow / block / challenge (issue a pairing code).
 * It does NO I/O — the caller (the channel manager) reads the allow-from list
 * + (on challenge) calls `upsertPairingRequest` and sends the code via the
 * adapter. This split keeps the decision logic trivially testable.
 */

import type { AccessDecision, DmPolicy } from "./types.js";

export interface EvaluateAccessArgs {
	policy: DmPolicy;
	senderId: string;
	/**
	 * Secondary sender handle (e.g. a WhatsApp `@lid` privacy alias) for senders
	 * that can be addressed by more than one stable id. When present, allow-list
	 * and self checks match if EITHER `senderId` OR `senderLid` matches —
	 * mirrors the reference codebase's identity overlap so a sender allow-listed
	 * by phone number is still recognised when they arrive via their LID, and
	 * vice-versa.
	 */
	senderLid?: string;
	/** The linked-self id, when known (operator messaging themselves → allow). */
	selfId?: string;
	/** Approved senders for this channel (from `allow-from.json` + config). */
	allowFrom: ReadonlyArray<string>;
	/** True when the inbound came from a multi-party room (group, Slack channel). */
	isGroup?: boolean;
	/**
	 * Group-specific policy. When unset, group messages inherit the DM `policy`.
	 * In `pairing` mode groups never auto-challenge (you don't want the bot
	 * mass-DM-ing a group's members with codes) — they only allow listed senders.
	 */
	groupPolicy?: DmPolicy;
	/** Approved senders for groups (separate list from DM allow-from). */
	groupAllowFrom?: ReadonlyArray<string>;
	/** True if the bot was explicitly @-mentioned in a group message. */
	mentioned?: boolean;
	/**
	 * Whether the crew is being ADDRESSED, computed by the caller as a superset of
	 * a bare @-mention: mention OR a reply/quote to one of the bot's own messages
	 * OR within an active-conversation follow-up window. When provided it REPLACES
	 * `mentioned` for the group gate — so a member can tag once (or reply to the
	 * bot) and keep talking untagged for a while. Falls back to `mentioned` when
	 * unset (today's strict per-message tagging).
	 */
	addressed?: boolean;
	/**
	 * The group's stable room id (WhatsApp `…@g.us` JID / Slack channel id), when
	 * this is a group message. Used for per-group JID allow-listing.
	 */
	groupId?: string;
	/**
	 * Group ids the operator has explicitly opted in as FULLY TRUSTED. In these
	 * groups the crew responds WITHOUT requiring an @-mention and regardless of
	 * who spoke — for a dedicated group the operator wants the crew live in.
	 * Empty by default (no behaviour change). A `*` entry trusts EVERY group (the
	 * bot then answers every message in every group it's in — use with care). A
	 * `disabled` group policy still wins over this.
	 */
	groupAllowJids?: ReadonlyArray<string>;
}

function eq(a: string, b: string): boolean {
	return a.replace(/\s+/g, "").trim() === b.replace(/\s+/g, "").trim();
}

/**
 * Whether `senderId` is approved by an allow-from list. A bare `*` entry in
 * the list is a wildcard — matches every sender (useful for open-to-all
 * deployments where the operator wants the agent reachable by anyone but
 * still wants the OTHER policy controls). Otherwise the sender must appear
 * verbatim. Mirrors the upstream `isSenderAllowed` shape: wildcard check
 * happens BEFORE the per-entry comparison so an empty / partial list with
 * `*` still matches.
 */
function isOnAllowList(
	senderId: string,
	allowFrom: ReadonlyArray<string>,
	senderLid?: string,
): boolean {
	for (const entry of allowFrom) if (entry === "*") return true;
	// Identity overlap — a sender matches if the list carries EITHER of their
	// stable handles (phone number OR `@lid` privacy alias).
	return allowFrom.includes(senderId) || (senderLid !== undefined && allowFrom.includes(senderLid));
}

/**
 * Decide what to do with one inbound message based on the channel's DM policy
 * and the current allow-from list. The caller is responsible for ISSUING the
 * code on a `challenge` decision (so the evaluator stays pure).
 */
export function evaluateAccess(args: EvaluateAccessArgs): AccessDecision {
	const isSelf = !!(
		args.selfId &&
		(eq(args.selfId, args.senderId) || (args.senderLid !== undefined && eq(args.selfId, args.senderLid)))
	);
	// Group branch — completely separate gate from DMs. A `pairing` group policy
	// is intentionally degraded to "allowlist" semantics: spamming pairing codes
	// at strangers in a group is worse than just being silent.
	//
	// CRITICAL: the operator's OWN messages in a group must follow the same
	// mention rules as anyone else. Without this, every time the operator
	// types in a group chat (where their account is the linked self), the
	// bot would answer — turning every group conversation into a Brigade
	// interview. Self-bypass is DM-only; in groups, even the operator must
	// either be on the group allow-from list AND mention the bot, or the
	// message is silently dropped.
	if (args.isGroup) {
		const policy = args.groupPolicy ?? args.policy;
		const allow = args.groupAllowFrom ?? args.allowFrom;
		// "Addressed" = mention OR reply-to-bot OR active follow-up window (the
		// caller computes the superset). Lets a member tag once / reply to the
		// bot and keep the thread going untagged. Defaults to the bare mention.
		const addressed = args.addressed ?? args.mentioned;
		if (policy === "disabled") return { kind: "block", reason: "group:disabled" };
		// Per-group allow-list: a group whose id the operator explicitly opted in
		// is FULLY TRUSTED — the crew responds without an @-mention and regardless
		// of who spoke. Opt-in (empty list ⇒ no effect), takes precedence over the
		// mention/sender gates below. `disabled` (above) still wins; `*` trusts
		// every group. This is the only path that responds in a group untagged.
		if (
			args.groupId &&
			args.groupAllowJids &&
			args.groupAllowJids.length > 0 &&
			isOnAllowList(args.groupId, args.groupAllowJids)
		) {
			return { kind: "allow", reason: "group:jid-allowlisted" };
		}
		if (policy === "open") {
			// Even in `open`, only respond when the crew is addressed (mention /
			// reply-to-bot / follow-up window) — otherwise it answers every group
			// message and gets kicked.
			return addressed
				? { kind: "allow", reason: "group:open+mention" }
				: { kind: "block", reason: "group:open-without-mention" };
		}
		// `allowlist` or `pairing` (degraded): only approved senders, only when
		// the bot is addressed. Operator (self) is treated as implicitly
		// allow-listed here — they don't need to add themselves — but they
		// STILL need to mention the bot to be heard. A `*` in the list is
		// a wildcard and matches everyone (still mention-gated below).
		const senderAllowed = isSelf || isOnAllowList(args.senderId, allow, args.senderLid);
		if (!senderAllowed) return { kind: "block", reason: "group:not-allowlisted" };
		return addressed
			? {
					kind: "allow",
					reason: isSelf ? "group:self+mention" : "group:allow-from+mention",
				}
			: {
					kind: "block",
					reason: isSelf
						? "group:self-without-mention"
						: "group:allow-from-without-mention",
				};
	}
	// DM branch — self-chat (operator DMing their own linked number) is
	// ALWAYS allowed, regardless of allow-from / pairing state. The owner
	// must be able to talk to their own bot from day one.
	if (isSelf) {
		return { kind: "allow", reason: "self" };
	}
	switch (args.policy) {
		case "open":
			return { kind: "allow", reason: "policy:open" };
		case "disabled":
			return { kind: "block", reason: "policy:disabled" };
		case "allowlist":
			return isOnAllowList(args.senderId, args.allowFrom, args.senderLid)
				? { kind: "allow", reason: "allow-from" }
				: { kind: "block", reason: "not-allowlisted" };
		case "pairing":
			if (isOnAllowList(args.senderId, args.allowFrom, args.senderLid))
				return { kind: "allow", reason: "allow-from" };
			// Caller will mint/refresh the code via the store and send a reply.
			return { kind: "challenge", code: "", reason: "needs-pairing" };
	}
}
