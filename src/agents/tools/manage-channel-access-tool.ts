/**
 * `manage_channel_access` — owner-only channel GROUP access control.
 *
 * The sanctioned, model-agnostic path for changing who the crew answers in
 * group chats (WhatsApp / Slack / …). It reads/writes the `channels.<channel>`
 * slice of brigade.json — `groupPolicy`, `groupAllowFrom`, `groupAllowJids`,
 * `groupFollowUpWindowMs` — so the operator can say "be live in this group" or
 * "stop making me tag you" and the crew does it, instead of hand-editing
 * brigade.json (which the config-write guard refuses).
 *
 * Owner-gated (`ownerOnly: true`) — only the operator can move a security
 * boundary. Writes the CONFIG layer only (same scope as a manual edit); the
 * runtime list is the union of this + the file store in access-control/store.
 */

import { Type } from "typebox";

import { loadConfig } from "../../core/config.js";
import { mutateConfigAtomic, type BrigadeConfig } from "../../config/io.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

const GROUP_POLICIES = ["disabled", "open", "allowlist", "pairing"] as const;

const ManageChannelAccessParams = Type.Object({
	action: Type.Union([Type.Literal("show"), Type.Literal("set")], {
		description:
			"show: print the channel's current group-access settings. set: change one or more of them (pass only what you want to change).",
	}),
	channel: Type.Optional(
		Type.String({
			description: 'Channel id under config.channels (default "whatsapp").',
			minLength: 1,
			maxLength: 64,
		}),
	),
	groupPolicy: Type.Optional(
		Type.Union(
			GROUP_POLICIES.map((p) => Type.Literal(p)),
			{
				description:
					"channels.<ch>.groupPolicy. disabled=never respond in groups; open=respond when addressed; allowlist=only listed senders (default); pairing=degraded to allowlist in groups.",
			},
		),
	),
	addAllowFrom: Type.Optional(
		Type.String({ description: "Sender id (phone / @lid) to ADD to groupAllowFrom.", maxLength: 256 }),
	),
	removeAllowFrom: Type.Optional(
		Type.String({ description: "Sender id to REMOVE from groupAllowFrom.", maxLength: 256 }),
	),
	addAllowJid: Type.Optional(
		Type.String({
			description: "Group JID (…@g.us) to ADD to groupAllowJids — a FULLY-TRUSTED group the crew answers untagged. `*` = every group.",
			maxLength: 256,
		}),
	),
	removeAllowJid: Type.Optional(
		Type.String({ description: "Group JID to REMOVE from groupAllowJids.", maxLength: 256 }),
	),
	groupFollowUpWindowMs: Type.Optional(
		Type.Number({
			description:
				"channels.<ch>.groupFollowUpWindowMs — after a member addresses the crew (mention / reply-to-bot), their untagged follow-ups count for this many ms. 0 = off (tag every message).",
		}),
	),
});

interface ChannelAccessSnapshot {
	channel: string;
	groupPolicy: string;
	groupAllowFrom: string[];
	groupAllowJids: string[];
	groupFollowUpWindowMs: number;
}

interface ManageChannelAccessResult {
	action: "show" | "set";
	ok: boolean;
	message: string;
	before?: ChannelAccessSnapshot;
	after?: ChannelAccessSnapshot;
	settings?: ChannelAccessSnapshot;
}

export function makeManageChannelAccessTool(): BrigadeTool<
	typeof ManageChannelAccessParams,
	ManageChannelAccessResult
> {
	return {
		name: "manage_channel_access",
		label: "Manage Channel Access",
		displaySummary: "managing channel group access",
		ownerOnly: true,
		description: [
			"Owner-only channel GROUP access control. Read or change who the crew answers in WhatsApp/Slack/etc. group chats — NEVER hand-edit brigade.json (the guard refuses it).",
			"show: returns {groupPolicy, groupAllowFrom, groupAllowJids, groupFollowUpWindowMs} for the channel (default whatsapp).",
			"set: change groupPolicy (disabled|open|allowlist|pairing), add/remove a sender via addAllowFrom/removeAllowFrom, add/remove a fully-trusted group JID via addAllowJid/removeAllowJid (so the crew answers untagged there), or set groupFollowUpWindowMs (tag-once-then-continue window). Pass only what changes.",
			"Call ONLY on explicit operator request; report exactly what changed.",
		].join(" "),
		parameters: ManageChannelAccessParams,
		execute: async (_toolCallId, args): Promise<AgentToolResult<ManageChannelAccessResult>> => {
			const channel = (args.channel ?? "whatsapp").trim().toLowerCase() || "whatsapp";

			if (args.action === "show") {
				const snap = readChannelSnapshot(loadConfig() as BrigadeConfig, channel);
				return jsonResult({
					action: "show",
					ok: true,
					settings: snap,
					message: describeSnapshot(snap),
				} satisfies ManageChannelAccessResult) as AgentToolResult<ManageChannelAccessResult>;
			}

			// action === "set"
			const wantsPolicy = args.groupPolicy !== undefined;
			const wantsWindow = args.groupFollowUpWindowMs !== undefined;
			const addFrom = (args.addAllowFrom ?? "").trim();
			const remFrom = (args.removeAllowFrom ?? "").trim();
			const addJid = (args.addAllowJid ?? "").trim();
			const remJid = (args.removeAllowJid ?? "").trim();
			if (!wantsPolicy && !wantsWindow && !addFrom && !remFrom && !addJid && !remJid) {
				return jsonResult({
					action: "set",
					ok: false,
					message:
						"manage_channel_access set: nothing to change — pass groupPolicy / addAllowFrom / removeAllowFrom / addAllowJid / removeAllowJid / groupFollowUpWindowMs.",
				} satisfies ManageChannelAccessResult) as AgentToolResult<ManageChannelAccessResult>;
			}

			const before = readChannelSnapshot(loadConfig() as BrigadeConfig, channel);

			const next = await mutateConfigAtomic((current: BrigadeConfig) => {
				const merged: BrigadeConfig = { ...current };
				const channels = {
					...((merged as { channels?: Record<string, unknown> }).channels ?? {}),
				} as Record<string, Record<string, unknown>>;
				const entry = { ...(channels[channel] ?? {}) } as Record<string, unknown>;

				if (wantsPolicy) entry.groupPolicy = args.groupPolicy;
				if (wantsWindow) entry.groupFollowUpWindowMs = args.groupFollowUpWindowMs;
				if (addFrom || remFrom) entry.groupAllowFrom = mutateList(entry.groupAllowFrom, addFrom, remFrom);
				if (addJid || remJid) entry.groupAllowJids = mutateList(entry.groupAllowJids, addJid, remJid);

				channels[channel] = entry;
				(merged as Record<string, unknown>).channels = channels;
				return merged;
			});

			const after = readChannelSnapshot(next as BrigadeConfig, channel);
			return jsonResult({
				action: "set",
				ok: true,
				before,
				after,
				message: `Updated channel "${channel}" group access. ${describeSnapshot(after)} Takes effect on new inbound — no restart needed.`,
			} satisfies ManageChannelAccessResult) as AgentToolResult<ManageChannelAccessResult>;
		},
	};
}

/* ───────────────────────────── helpers ───────────────────────────── */

/** Add/remove an entry idempotently (remove first, then add-if-absent). */
function mutateList(raw: unknown, add: string, remove: string): string[] {
	const list = Array.isArray(raw) ? (raw as unknown[]).map((x) => String(x)) : [];
	let out = [...list];
	if (remove) out = out.filter((x) => x !== remove);
	if (add && !out.includes(add)) out.push(add);
	return out;
}

function readChannelSnapshot(cfg: BrigadeConfig, channel: string): ChannelAccessSnapshot {
	const entry = (cfg as { channels?: Record<string, Record<string, unknown>> }).channels?.[channel] ?? {};
	const list = (v: unknown): string[] =>
		Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
	return {
		channel,
		groupPolicy: typeof entry.groupPolicy === "string" ? entry.groupPolicy : "allowlist",
		groupAllowFrom: list(entry.groupAllowFrom),
		groupAllowJids: list(entry.groupAllowJids),
		groupFollowUpWindowMs: typeof entry.groupFollowUpWindowMs === "number" ? entry.groupFollowUpWindowMs : 0,
	};
}

function describeSnapshot(s: ChannelAccessSnapshot): string {
	const jids =
		s.groupAllowJids.length === 1 && s.groupAllowJids[0] === "*"
			? "every group"
			: `${s.groupAllowJids.length} group(s)`;
	return [
		`groupPolicy=${s.groupPolicy}`,
		`groupAllowFrom=${s.groupAllowFrom.length} sender(s)`,
		`groupAllowJids=${jids}`,
		`groupFollowUpWindowMs=${s.groupFollowUpWindowMs}`,
	].join(", ").concat(".");
}
