/**
 * `bluebubbles_action` — owner-only BlueBubbles group-admin surface.
 *
 * Brigade's live BlueBubbles adapter handles inbound + the everyday
 * send/edit/react/typing/mark-read path, but it does NOT expose group
 * administration (membership, rename, group icon). This tool fills that gap with
 * a SELF-CONTAINED client over the same BlueBubbles REST plumbing the channel
 * uses (`chat.ts` helpers over `buildBlueBubblesApiUrl` + the injectable
 * `fetchImpl`): it resolves the server URL + password from config exactly like
 * `probe.ts`, so it works whether or not the live adapter is up.
 *
 * Every action here needs the BlueBubbles server's Private API. The tool probes
 * the server once (cached server/info) to learn the Private-API status, then
 * refuses cleanly when it is off. One meta-tool with an `action` discriminator
 * (keeps the prompt small) dispatches to the matching `chat.ts` helper.
 *
 * Owner-only: the standard `wrapOwnerOnlyToolExecution` gate (applied at
 * session-wiring) already refuses non-owner senders + unattended cron turns, so
 * this file does not re-implement auth. The registry only ASSEMBLES this tool
 * when the BlueBubbles channel is configured (`channels.bluebubbles.enabled`),
 * so a non-BlueBubbles install never sees it.
 */

import { readFile } from "node:fs/promises";

import { Type } from "typebox";

import { loadConfig } from "../../core/config.js";
import {
	BLUEBUBBLES_DEFAULT_ACCOUNT_ID,
	isBlueBubblesOpAllowed,
	resolveBlueBubblesAccount,
	resolveBlueBubblesActions,
	type BlueBubblesActionFlags,
	type BlueBubblesFineActionName,
} from "../channels/bluebubbles/account-config.js";
import {
	addBlueBubblesParticipant,
	leaveBlueBubblesChat,
	removeBlueBubblesParticipant,
	renameBlueBubblesChat,
	setBlueBubblesGroupIcon,
} from "../channels/bluebubbles/chat.js";
import { resolveEffectId } from "../channels/bluebubbles/effects.js";
import { probeBlueBubblesCached } from "../channels/bluebubbles/probe.js";
import { sendBlueBubblesText, type BlueBubblesRestBase } from "../channels/bluebubbles/send.js";
import type { FetchLike } from "../channels/bluebubbles/types.js";
import { validateOutboundMediaPath } from "../../security/media-path-guard.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

/* ───────────────────────────── params ───────────────────────────── */

const BlueBubblesActionParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("add-participant"),
			Type.Literal("remove-participant"),
			Type.Literal("rename-group"),
			Type.Literal("set-group-icon"),
			Type.Literal("leave-group"),
			Type.Literal("send-effect"),
			Type.Literal("reply"),
		],
		{
			description:
				"The BlueBubbles action to run. Group admin: add-participant / remove-participant (needs address), rename-group (needs displayName), set-group-icon (needs iconPath), leave-group. Rich send: send-effect (a bubble/screen effect — needs text + effect), reply (a native inline reply — needs text + replyToId). All require the server's Private API.",
		},
	),
	accountId: Type.Optional(
		Type.String({ description: "Which BlueBubbles account to act as (default: the configured default).", maxLength: 64 }),
	),
	chatGuid: Type.String({
		description: "Target group chat GUID (e.g. `iMessage;+;chat123…`). The `chat_guid:` prefix is optional and stripped.",
		maxLength: 256,
	}),
	address: Type.Optional(
		Type.String({ description: "add-participant / remove-participant: the phone number or email to add/remove.", maxLength: 256 }),
	),
	displayName: Type.Optional(Type.String({ description: "rename-group: the new group name.", maxLength: 256 })),
	iconPath: Type.Optional(
		Type.String({ description: "set-group-icon: a local image file path to upload as the group photo.", maxLength: 1024 }),
	),
	text: Type.Optional(
		Type.String({ description: "send-effect / reply: the message text to send.", maxLength: 10_000 }),
	),
	effect: Type.Optional(
		Type.String({
			description:
				"send-effect: the effect name (slam, loud, gentle, invisible-ink, echo, spotlight, balloons, confetti, love, lasers, fireworks, sparkles).",
			maxLength: 64,
		}),
	),
	replyToId: Type.Optional(
		Type.String({ description: "reply: the GUID of the message to reply to (inline thread).", maxLength: 256 }),
	),
	partIndex: Type.Optional(
		Type.Integer({ description: "reply: the part index of the replied-to message (default 0).", minimum: 0 }),
	),
});

interface BlueBubblesActionResult {
	action: string;
	ok: boolean;
	message: string;
}

/* ───────────────────────────── tool factory ───────────────────────────── */

export interface MakeBlueBubblesActionToolOptions {
	/** Inject the resolved server URL + password (tests). Defaults to config-resolve per call. */
	resolveAccount?: (accountId: string) => { serverUrl: string; password: string; timeoutMs?: number };
	/** Inject the Private-API status (tests). When omitted, probed from the server per call. */
	resolvePrivateApi?: (account: { serverUrl: string; password: string; timeoutMs?: number }) => Promise<boolean | null>;
	/** Inject the per-account action toggles (tests). Defaults to config-resolve per call. */
	resolveActions?: (accountId: string) => BlueBubblesActionFlags;
	/** Inject fetch (tests). Defaults to global fetch in the REST helpers. */
	fetchImpl?: FetchLike;
	/** Inject the icon file reader (tests). Defaults to reading from disk after the media-path guard. */
	readIcon?: (path: string) => Promise<Uint8Array>;
}

export function makeBlueBubblesActionTool(
	opts: MakeBlueBubblesActionToolOptions = {},
): BrigadeTool<typeof BlueBubblesActionParams, BlueBubblesActionResult> {
	const resolveAccount =
		opts.resolveAccount ??
		((accountId: string): { serverUrl: string; password: string; timeoutMs?: number } => {
			const acc = resolveBlueBubblesAccount(loadConfig() as never, accountId);
			return { serverUrl: acc.serverUrl, password: acc.password, timeoutMs: acc.probeTimeoutMs };
		});

	const resolvePrivateApi =
		opts.resolvePrivateApi ??
		(async (account: { serverUrl: string; password: string; timeoutMs?: number }): Promise<boolean | null> => {
			// Served from the per-server TTL cache when fresh, so back-to-back actions
			// don't each re-probe server/info.
			const probe = await probeBlueBubblesCached({
				accountId: `tool:${account.serverUrl}`,
				serverUrl: account.serverUrl,
				password: account.password,
				...(account.timeoutMs !== undefined ? { timeoutMs: account.timeoutMs } : {}),
				...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
			});
			return probe.privateApi;
		});

	const resolveActions =
		opts.resolveActions ??
		((accountId: string): BlueBubblesActionFlags => resolveBlueBubblesActions(loadConfig() as never, accountId));

	const readIcon =
		opts.readIcon ??
		(async (path: string): Promise<Uint8Array> => {
			// Exfil guard — refuse a secret / system file before reading its bytes.
			const verdict = validateOutboundMediaPath(path);
			if (!verdict.ok) throw new Error(verdict.reason ?? "icon path is not allowed");
			return new Uint8Array(await readFile(path));
		});

	return {
		name: "bluebubbles_action",
		label: "BlueBubbles action",
		displaySummary: "managing a BlueBubbles group",
		ownerOnly: true,
		description: [
			"Administer a BlueBubbles (iMessage) chat the everyday chat reply can't:",
			"add-participant / remove-participant (by phone or email), rename-group, set-group-icon (a local image path), leave-group;",
			"plus rich sends — send-effect (a bubble/screen effect with `text` + `effect`) and reply (a native inline reply with `text` + `replyToId`).",
			"All actions require the BlueBubbles server's Private API; the tool reports clearly when it is off.",
			"Owner-only. Every action needs a `chatGuid`; membership needs an `address`, rename needs `displayName`, set-group-icon needs `iconPath`.",
		].join(" "),
		parameters: BlueBubblesActionParams,
		execute: async (_toolCallId, args): Promise<AgentToolResult<BlueBubblesActionResult>> => {
			const action = args.action;
			const ok = (message: string): AgentToolResult<BlueBubblesActionResult> =>
				jsonResult({ action, ok: true, message } satisfies BlueBubblesActionResult) as AgentToolResult<BlueBubblesActionResult>;
			const fail = (message: string): AgentToolResult<BlueBubblesActionResult> =>
				jsonResult({ action, ok: false, message } satisfies BlueBubblesActionResult) as AgentToolResult<BlueBubblesActionResult>;

			const accountId = (args.accountId ?? "").trim() || BLUEBUBBLES_DEFAULT_ACCOUNT_ID;
			let account: { serverUrl: string; password: string; timeoutMs?: number };
			try {
				account = resolveAccount(accountId);
			} catch (err) {
				return fail(`Cannot resolve the BlueBubbles account: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (!account.serverUrl || !account.password) {
				return fail(
					"BlueBubbles is not configured — set channels.bluebubbles.serverUrl + password (or connect the channel) first, then retry.",
				);
			}

			// Strip an optional `chat_guid:` prefix the agent might carry from an inbound id.
			const chatGuid = (args.chatGuid ?? "").trim().replace(/^chat_guid:/i, "");
			if (!chatGuid) return fail(`${action} requires a \`chatGuid\`.`);

			// Resolve the per-account action toggles + gate the action against them,
			// PER-OP. Each op maps to a fine-grained flag that inherits its coarse
			// umbrella when unset (group-admin ops ← `groupAdmin`; send-effect ←
			// `effects`; reply ← always on) — so the operator can, e.g., allow
			// rename-group but forbid remove-participant.
			const actions = resolveActions(accountId);
			const OP_FLAG: Record<string, BlueBubblesFineActionName> = {
				"add-participant": "addParticipant",
				"remove-participant": "removeParticipant",
				"rename-group": "renameGroup",
				"set-group-icon": "setGroupIcon",
				"leave-group": "leaveGroup",
				"send-effect": "sendWithEffect",
				reply: "reply",
			};
			const opFlag = OP_FLAG[action];
			if (opFlag && !isBlueBubblesOpAllowed(actions, opFlag)) {
				return fail(`BlueBubbles ${action} is disabled (channels.bluebubbles.actions.${opFlag} = false).`);
			}

			// Probe once for the Private-API status — every action here needs it.
			const privateApi = await resolvePrivateApi(account).catch(() => null);
			if (privateApi === false) {
				return fail(
					`BlueBubbles ${action} requires the Private API, but it is disabled on the BlueBubbles server. Enable the Private API in the BlueBubbles macOS app, then retry.`,
				);
			}

			const base: BlueBubblesRestBase = {
				serverUrl: account.serverUrl,
				password: account.password,
				...(account.timeoutMs !== undefined ? { timeoutMs: account.timeoutMs } : {}),
				...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
				// We already refused on a definite `false` above; a `true` or unknown
				// (`null`) status proceeds (the helper's own guard only blocks `false`).
				privateApiEnabled: true,
			};

			try {
				switch (action) {
					case "add-participant": {
						const address = (args.address ?? "").trim();
						if (!address) return fail("add-participant requires an `address`.");
						await addBlueBubblesParticipant(base, { chatGuid, address });
						return ok(`Added ${address} to the group.`);
					}
					case "remove-participant": {
						const address = (args.address ?? "").trim();
						if (!address) return fail("remove-participant requires an `address`.");
						await removeBlueBubblesParticipant(base, { chatGuid, address });
						return ok(`Removed ${address} from the group.`);
					}
					case "rename-group": {
						const displayName = (args.displayName ?? "").trim();
						if (!displayName) return fail("rename-group requires a `displayName`.");
						await renameBlueBubblesChat(base, { chatGuid, displayName });
						return ok(`Renamed the group to "${displayName}".`);
					}
					case "set-group-icon": {
						const iconPath = (args.iconPath ?? "").trim();
						if (!iconPath) return fail("set-group-icon requires an `iconPath`.");
						let bytes: Uint8Array;
						try {
							bytes = await readIcon(iconPath);
						} catch (err) {
							return fail(`set-group-icon could not read the icon: ${err instanceof Error ? err.message : String(err)}`);
						}
						await setBlueBubblesGroupIcon(base, { chatGuid, bytes });
						return ok("Updated the group icon.");
					}
					case "leave-group": {
						await leaveBlueBubblesChat(base, { chatGuid });
						return ok("Left the group.");
					}
					case "send-effect": {
						const text = (args.text ?? "").trim();
						if (!text) return fail("send-effect requires `text`.");
						const effect = (args.effect ?? "").trim();
						if (!effect) return fail("send-effect requires an `effect` name.");
						if (!resolveEffectId(effect)) {
							return fail(`Unknown effect "${effect}". Try one of: slam, loud, gentle, invisible-ink, echo, spotlight, balloons, confetti, love, lasers, fireworks, sparkles.`);
						}
						const sent = await sendBlueBubblesText(chatGuid, text, { ...base, effect });
						return ok(`Sent with the "${effect}" effect${sent.messageId ? ` (message ${sent.messageId})` : ""}.`);
					}
					case "reply": {
						const text = (args.text ?? "").trim();
						if (!text) return fail("reply requires `text`.");
						const replyToId = (args.replyToId ?? "").trim();
						if (!replyToId) return fail("reply requires a `replyToId` (the message GUID to reply to).");
						const sent = await sendBlueBubblesText(chatGuid, text, {
							...base,
							replyToMessageGuid: replyToId,
							...(typeof args.partIndex === "number" ? { replyToPartIndex: args.partIndex } : {}),
						});
						return ok(`Replied to message ${replyToId}${sent.messageId ? ` (message ${sent.messageId})` : ""}.`);
					}
					default:
						return fail(`Unknown action "${String(action)}".`);
				}
			} catch (err) {
				return fail(`BlueBubbles ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	};
}
