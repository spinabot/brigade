/**
 * `manage_provider` tool — owner-only provider credential + per-agent model
 * management. The Brigade answer to "save this API key" and "agent X should
 * run on openai/gpt-4o".
 *
 * Why this tool exists (production, 2026-06-11)
 * ---------------------------------------------
 * Handed an OpenAI key mid-chat, the model wrote it PLAINTEXT into
 * `workspace/.env` ("that's the standard place") and then, asked to point an
 * agent at it, dumped hand-edit JSON instructions — with a config shape
 * Brigade doesn't even read. The reference architecture studied for this has
 * the same hole: its agent-driven config path lands keys plaintext in the
 * main config file, its canonical 0600 credential store has NO model-reachable
 * writer, and nothing in its prompts tells the model how to treat a secret.
 * This tool closes all three gaps at once:
 *
 *   - `save-key` writes the CANONICAL per-agent credential store
 *     (`agents/<id>/agent/auth-profiles.json`, 0600, atomic tmp+rename,
 *     sealed-column sync in convex mode) via the same `upsertApiKeyProfile`
 *     path onboarding uses. The result NEVER echoes the key — masked tail
 *     only.
 *   - `set-agent-model` edits `agents.<id>.provider` + `model.primary`
 *     through the atomic config helpers (same path as manage_agent), and
 *     SEEDS the provider key into the target agent's own store when only the
 *     default agent has it — write-time inheritance, so "marketing-lead uses
 *     gpt-4o" works on the next turn instead of failing on a missing key.
 *     The gateway hot-reloads runtime models on config change.
 *   - `list` reports which providers have keys (masked) so the model can
 *     answer "what providers are set up?" without filesystem spelunking.
 *
 * Secret-handling contract (the guidance the reference lacks): keys go HERE,
 * never into .env / workspace files / memory / config / chat echoes.
 */

import { Type } from "typebox";

import { DEFAULT_AGENT_ID } from "../../config/paths.js";
import { loadConfig, saveConfig } from "../../core/config.js";
import { applyAgentConfig, hasAgentEntry } from "../../cli/commands/agents-config.js";
import { PROVIDERS } from "../../providers/catalog.js";
import {
	readProfiles,
	upsertApiKeyProfile,
	upsertApiKeyRefProfile,
} from "../../auth/profiles.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

const ManageProviderParams = Type.Object({
	action: Type.Union(
		[Type.Literal("save-key"), Type.Literal("set-agent-model"), Type.Literal("list")],
		{
			description:
				"save-key: store a provider API key in Brigade's credential store. set-agent-model: point an agent at a provider/model (seeds the key if needed). list: which providers have keys (masked).",
		},
	),
	provider: Type.Optional(
		Type.String({
			description:
				"Provider id, e.g. openai, anthropic, openrouter, google. Required for save-key and set-agent-model.",
			minLength: 1,
			maxLength: 64,
		}),
	),
	key: Type.Optional(
		Type.String({
			description:
				"The API key (save-key only). Stored in the per-agent credential store with restricted permissions — NEVER echoed back, NEVER written anywhere else.",
			minLength: 8,
			maxLength: 512,
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Model id for set-agent-model, e.g. "gpt-4o" or "claude-opus-4-7". Bare id (the provider field carries the provider).',
			minLength: 1,
			maxLength: 128,
		}),
	),
	agentId: Type.Optional(
		Type.String({
			description:
				"Target agent. save-key: which agent's credential store gets the key (default: the main/default agent — every agent assignment can seed from there). set-agent-model: REQUIRED — the agent whose brain changes.",
			minLength: 1,
			maxLength: 64,
		}),
	),
});

interface ManageProviderDetails {
	action: "save-key" | "set-agent-model" | "list";
	ok: boolean;
	message: string;
	provider?: string;
	agentId?: string;
	model?: string;
	maskedKey?: string;
	seededKey?: boolean;
	providers?: Array<{ provider: string; hasKey: boolean; maskedKey?: string; source: string }>;
}

export interface MakeManageProviderToolOptions {
	/** Caller's agent id — default target for save-key. */
	requesterAgentId?: string;
}

const KNOWN_PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id));

export function makeManageProviderTool(
	opts: MakeManageProviderToolOptions = {},
): BrigadeTool<typeof ManageProviderParams, ManageProviderDetails> {
	const requesterId = normalizeAgentId(opts.requesterAgentId ?? DEFAULT_AGENT_ID);
	return {
		name: "manage_provider",
		label: "Manage Provider",
		displaySummary: "managing provider credentials",
		ownerOnly: true,
		description: [
			"Owner-only provider credential + per-agent model management.",
			"WHEN THE OPERATOR HANDS YOU AN API KEY: call save-key IMMEDIATELY. NEVER write a key to a .env file, workspace file, memory, brigade.json, or shell command, and NEVER repeat the key back in chat — this tool's credential store (restricted permissions, encrypted in convex mode) is the ONLY correct destination.",
			'save-key: {action:"save-key", provider:"openai", key:"sk-…"} — stores it for the default agent (pass agentId to target another agent\'s store).',
			'set-agent-model: {action:"set-agent-model", agentId:"marketing-lead", provider:"openai", model:"gpt-4o"} — updates the agent\'s config atomically AND copies the provider key into that agent\'s own credential store when only the default agent has it. The gateway hot-reloads the model — applies from the agent\'s next turn, no restart.',
			"list: which providers have stored keys (masked tails only — full keys are never readable through this tool).",
		].join(" "),
		parameters: ManageProviderParams,
		execute: async (
			_toolCallId,
			args,
		): Promise<AgentToolResult<ManageProviderDetails>> => {
			const action = args.action;

			if (action === "list") {
				const providers = listProviderKeyStatus(requesterId);
				return jsonResult({
					action,
					ok: true,
					providers,
					message: `${providers.filter((p) => p.hasKey).length} provider(s) with stored keys.`,
				} satisfies ManageProviderDetails) as AgentToolResult<ManageProviderDetails>;
			}

			const provider = (args.provider ?? "").trim().toLowerCase();
			if (!provider) {
				return jsonResult({
					action,
					ok: false,
					message: "`provider` is required.",
				} satisfies ManageProviderDetails) as AgentToolResult<ManageProviderDetails>;
			}
			if (!KNOWN_PROVIDER_IDS.has(provider)) {
				return jsonResult({
					action,
					ok: false,
					provider,
					message: `Unknown provider "${provider}". Known: ${[...KNOWN_PROVIDER_IDS].sort().join(", ")}.`,
				} satisfies ManageProviderDetails) as AgentToolResult<ManageProviderDetails>;
			}

			if (action === "save-key") {
				const key = (args.key ?? "").trim();
				if (!key) {
					return jsonResult({
						action,
						ok: false,
						provider,
						message: "`key` is required for save-key.",
					} satisfies ManageProviderDetails) as AgentToolResult<ManageProviderDetails>;
				}
				const targetAgent = normalizeAgentId(args.agentId ?? DEFAULT_AGENT_ID);
				upsertApiKeyProfile(targetAgent, { provider, key });
				return jsonResult({
					action,
					ok: true,
					provider,
					agentId: targetAgent,
					maskedKey: maskKey(key),
					message:
						`Stored the ${provider} key (${maskKey(key)}) in agent "${targetAgent}"'s credential store. ` +
						"Usable from the next turn. Do not store or repeat the key anywhere else; if it was previously written to a file, tell the operator to rotate it.",
				} satisfies ManageProviderDetails) as AgentToolResult<ManageProviderDetails>;
			}

			// action === "set-agent-model"
			const agentIdRaw = (args.agentId ?? "").trim();
			const model = (args.model ?? "").trim();
			if (!agentIdRaw || !model) {
				return jsonResult({
					action,
					ok: false,
					provider,
					message: "`agentId` and `model` are required for set-agent-model.",
				} satisfies ManageProviderDetails) as AgentToolResult<ManageProviderDetails>;
			}
			const targetId = normalizeAgentId(agentIdRaw);
			const cfg = loadConfig();
			if (targetId !== DEFAULT_AGENT_ID && !hasAgentEntry(cfg, targetId)) {
				return jsonResult({
					action,
					ok: false,
					provider,
					agentId: targetId,
					message: `Agent "${targetId}" is not configured. Create it first with manage_agent({action:"add", id:"${targetId}"}).`,
				} satisfies ManageProviderDetails) as AgentToolResult<ManageProviderDetails>;
			}
			const next = applyAgentConfig(cfg, { agentId: targetId, provider, model });
			saveConfig(next);
			// Write-time key inheritance: the per-turn auth path reads ONLY the
			// target agent's own credential store (plus env). When the key lives
			// solely with the default agent, clone it across so the very next
			// turn works instead of failing "no key for provider".
			const seededKey = seedProviderKeyIfMissing(provider, targetId);
			return jsonResult({
				action,
				ok: true,
				provider,
				agentId: targetId,
				model,
				seededKey,
				message:
					`Agent "${targetId}" now runs on ${provider}/${model}.` +
					(seededKey
						? ` Copied the ${provider} key from the default agent into "${targetId}"'s credential store.`
						: "") +
					" The gateway hot-reloads the model — applies from that agent's next turn.",
			} satisfies ManageProviderDetails) as AgentToolResult<ManageProviderDetails>;
		},
	};
}

/* ───────────────────────── helpers ───────────────────────── */

function maskKey(key: string): string {
	if (key.length <= 8) return "…" + key.slice(-2);
	return `…${key.slice(-4)} (${key.length} chars)`;
}

interface ProfileShape {
	provider?: string;
	type?: string;
	key?: string;
	keyRef?: { source?: string; provider?: string; id?: string } | string;
}

function readProviderProfile(agentId: string, provider: string): ProfileShape | null {
	try {
		const file = readProfiles(agentId) as unknown as {
			profiles?: Record<string, ProfileShape>;
		};
		for (const profile of Object.values(file.profiles ?? {})) {
			if (profile?.provider === provider && profile.type === "api_key") return profile;
		}
	} catch {
		/* missing store ⇔ no profile */
	}
	return null;
}

/**
 * Clone the default agent's key for `provider` into `agentId`'s store when
 * the target has none. Ref-shaped profiles are cloned AS refs (the literal
 * never materializes); literal keys copy literally. Returns true when a
 * seed happened.
 */
function seedProviderKeyIfMissing(provider: string, agentId: string): boolean {
	if (agentId === DEFAULT_AGENT_ID) return false;
	if (readProviderProfile(agentId, provider)) return false;
	const source = readProviderProfile(DEFAULT_AGENT_ID, provider);
	if (!source) return false;
	if (typeof source.keyRef === "object" && source.keyRef?.source) {
		upsertApiKeyRefProfile(agentId, {
			provider,
			keyRef: source.keyRef as never,
		});
		return true;
	}
	if (typeof source.key === "string" && source.key.length > 0) {
		upsertApiKeyProfile(agentId, { provider, key: source.key });
		return true;
	}
	return false;
}

function listProviderKeyStatus(
	requesterId: string,
): Array<{ provider: string; hasKey: boolean; maskedKey?: string; source: string }> {
	const out: Array<{ provider: string; hasKey: boolean; maskedKey?: string; source: string }> =
		[];
	for (const provider of [...KNOWN_PROVIDER_IDS].sort()) {
		const profile =
			readProviderProfile(DEFAULT_AGENT_ID, provider) ??
			(requesterId !== DEFAULT_AGENT_ID ? readProviderProfile(requesterId, provider) : null);
		if (profile) {
			const masked =
				typeof profile.key === "string" && profile.key.length > 0
					? maskKey(profile.key)
					: undefined;
			out.push({
				provider,
				hasKey: true,
				...(masked ? { maskedKey: masked } : {}),
				source: typeof profile.keyRef === "object" ? "env-reference" : "credential store",
			});
			continue;
		}
		const envVar = PROVIDERS.find((p) => p.id === provider)?.envVar;
		if (envVar && process.env[envVar]) {
			out.push({ provider, hasKey: true, source: `environment (${envVar})` });
			continue;
		}
		out.push({ provider, hasKey: false, source: "none" });
	}
	return out;
}
