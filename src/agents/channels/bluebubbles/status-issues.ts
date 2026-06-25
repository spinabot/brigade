/**
 * BlueBubbles structured status-issues — the diagnostics the central status
 * surface renders (`collectStatusIssues` on the plugin's status adapter).
 *
 * Three issue families, each carrying a concrete FIX hint:
 *   - `not-configured` — serverUrl + password aren't both resolvable.
 *   - `unreachable`     — the server/info probe failed (server down / bad URL /
 *                         wrong password).
 *   - `private-api-off` — the server is reachable but the Private API is OFF, so
 *                         reactions / edit / unsend / typing / group-admin can't run.
 *
 * The RICH shape (`{ channel, accountId, kind, message, fix }`) is what callers
 * that want the detail read; `toChannelStatusIssues` maps it onto the central
 * `{ accountId, severity, message }` rows the rollup view + `brigade doctor`
 * already render, so BlueBubbles health shows up alongside the other channels.
 */

import type { ChannelAccountSnapshot, ChannelStatusIssue } from "../sdk.js";
import { BLUEBUBBLES_CHANNEL_ID } from "./account-config.js";

/** The structured issue kinds BlueBubbles surfaces. */
export type BlueBubblesStatusIssueKind = "not-configured" | "unreachable" | "private-api-off";

/** A rich, structured BlueBubbles status issue. */
export interface BlueBubblesStatusIssue {
	/** Always `"bluebubbles"`. */
	channel: string;
	/** The account the issue is about. */
	accountId: string;
	/** The issue family. */
	kind: BlueBubblesStatusIssueKind;
	/** Operator-facing description. */
	message: string;
	/** A concrete remediation hint. */
	fix: string;
}

/** The per-account diagnostics `collectBlueBubblesStatusIssues` reads. */
export interface BlueBubblesStatusAccount {
	accountId: string;
	/** serverUrl + password both resolvable? */
	configured: boolean;
	/** server/info probe reachable? (undefined → not probed). */
	reachable?: boolean;
	/** Private-API status from the probe — true/false/null (unknown). */
	privateApi?: boolean | null;
}

/** Map a rich issue's kind to the central severity. */
function severityFor(kind: BlueBubblesStatusIssueKind): ChannelStatusIssue["severity"] {
	switch (kind) {
		case "not-configured":
			return "warn";
		case "unreachable":
			return "error";
		case "private-api-off":
			return "warn";
		default:
			return "warn";
	}
}

/**
 * Derive the structured issues for one or more BlueBubbles accounts. A fully
 * configured + reachable + Private-API-on account contributes nothing. Pure +
 * total — given the diagnostics, it derives the rows; no I/O of its own.
 */
export function collectBlueBubblesStatusIssues(accounts: BlueBubblesStatusAccount[]): BlueBubblesStatusIssue[] {
	const issues: BlueBubblesStatusIssue[] = [];
	for (const acc of accounts ?? []) {
		const accountId = (acc?.accountId ?? "").trim();
		if (!accountId) continue;

		if (!acc.configured) {
			issues.push({
				channel: BLUEBUBBLES_CHANNEL_ID,
				accountId,
				kind: "not-configured",
				message: "BlueBubbles is not fully configured (serverUrl + password).",
				fix: "Set channels.bluebubbles.serverUrl + password (or run `brigade channels add bluebubbles`).",
			});
			continue; // nothing else is meaningful until it's configured
		}

		if (acc.reachable === false) {
			issues.push({
				channel: BLUEBUBBLES_CHANNEL_ID,
				accountId,
				kind: "unreachable",
				message: "BlueBubbles server/info probe failed — the server is unreachable or rejected the password.",
				fix: "Check the BlueBubbles Server app is running, the serverUrl is reachable from the gateway host, and the password is correct.",
			});
			continue; // can't judge the Private API when unreachable
		}

		if (acc.privateApi === false) {
			issues.push({
				channel: BLUEBUBBLES_CHANNEL_ID,
				accountId,
				kind: "private-api-off",
				message: "BlueBubbles Private API is disabled — reactions, edit, unsend, typing, and group admin can't run.",
				fix: "Enable the Private API in the BlueBubbles Server app (Settings → Private API) and restart the server.",
			});
		}
	}
	return issues;
}

/** Map the rich BlueBubbles issues onto the central `ChannelStatusIssue[]` rows. */
export function toChannelStatusIssues(issues: BlueBubblesStatusIssue[]): ChannelStatusIssue[] {
	return issues.map((i) => ({ accountId: i.accountId, severity: severityFor(i.kind), message: `${i.message} ${i.fix}` }));
}

/**
 * Read the BlueBubbles diagnostics off an open-shaped account snapshot. The
 * plugin's `buildAccountSnapshot` stamps `configured` / `reachable` /
 * `privateApi`; this reads them back defensively for `collectStatusIssues`.
 */
export function statusAccountFromSnapshot(snapshot: ChannelAccountSnapshot): BlueBubblesStatusAccount {
	const rec = snapshot as Record<string, unknown>;
	const privateApiRaw = rec.privateApi;
	return {
		accountId: (snapshot.id ?? "").trim(),
		configured: rec.configured === true,
		...(typeof rec.reachable === "boolean" ? { reachable: rec.reachable } : {}),
		...(typeof privateApiRaw === "boolean" || privateApiRaw === null ? { privateApi: privateApiRaw as boolean | null } : {}),
	};
}
