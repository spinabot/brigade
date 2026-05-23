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
}

function eq(a: string, b: string): boolean {
	return a.replace(/\s+/g, "").trim() === b.replace(/\s+/g, "").trim();
}

/**
 * Decide what to do with one inbound message based on the channel's DM policy
 * and the current allow-from list. The caller is responsible for ISSUING the
 * code on a `challenge` decision (so the evaluator stays pure).
 */
export function evaluateAccess(args: EvaluateAccessArgs): AccessDecision {
	// Self-chat is always allowed — the operator messaging their own linked
	// number must work even before any allow-from entries are recorded.
	if (args.selfId && eq(args.selfId, args.senderId)) {
		return { kind: "allow", reason: "self" };
	}
	// Group branch — completely separate gate from DMs. A `pairing` group policy
	// is intentionally degraded to "allowlist" semantics: spamming pairing codes
	// at strangers in a group is worse than just being silent.
	if (args.isGroup) {
		const policy = args.groupPolicy ?? args.policy;
		const allow = args.groupAllowFrom ?? args.allowFrom;
		if (policy === "disabled") return { kind: "block", reason: "group:disabled" };
		if (policy === "open") {
			// Even in `open`, only respond when the bot was explicitly @-mentioned —
			// otherwise the bot answers every group message and gets kicked.
			return args.mentioned
				? { kind: "allow", reason: "group:open+mention" }
				: { kind: "block", reason: "group:open-without-mention" };
		}
		// `allowlist` or `pairing` (degraded): only approved senders, only when
		// the bot is addressed.
		if (!allow.includes(args.senderId)) return { kind: "block", reason: "group:not-allowlisted" };
		return args.mentioned
			? { kind: "allow", reason: "group:allow-from+mention" }
			: { kind: "block", reason: "group:allow-from-without-mention" };
	}
	switch (args.policy) {
		case "open":
			return { kind: "allow", reason: "policy:open" };
		case "disabled":
			return { kind: "block", reason: "policy:disabled" };
		case "allowlist":
			return args.allowFrom.includes(args.senderId)
				? { kind: "allow", reason: "allow-from" }
				: { kind: "block", reason: "not-allowlisted" };
		case "pairing":
			if (args.allowFrom.includes(args.senderId)) return { kind: "allow", reason: "allow-from" };
			// Caller will mint/refresh the code via the store and send a reply.
			return { kind: "challenge", code: "", reason: "needs-pairing" };
	}
}
