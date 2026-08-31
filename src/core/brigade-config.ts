/**
 * The `brigade.json` SCHEMA, and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS NOT, ANY MORE
 * ─────────────────────────────────────────────────────────────────────────
 * It used to also carry a complete second config implementation — its own
 * loader, atomic writer, `.bak` rotation, corrupt-file recovery, env overlay,
 * and two migrations — none of which was ever called. The live path is
 * `src/config/io.ts` (`readConfigOrInit` / `writeConfigSafe`), with the
 * merge + legacy-key normalisation in `src/core/config.ts`. Only three symbols
 * here were ever imported: the schema, the error collector, and the filename.
 *
 * Removing it was not just tidying. The header promised things that did not
 * happen — "single source of truth", "schema-validated document plus rotating
 * backups and atomic writes", "boot must never fail on a corrupt file" — and a
 * reader had no way to tell which of the two implementations ran.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE v1 → v2 MIGRATION WAS DELETED RATHER THAN WIRED
 * ─────────────────────────────────────────────────────────────────────────
 * It looked like a live bug — a migration with no caller, so a v1 install
 * silently keeps a shape nothing reads. Wiring it would have CORRUPTED
 * configs.
 *
 * It composed `agents.defaults.model.primary` as `"<provider>/<modelId>"`.
 * The runtime reads that field as a BARE model id, with the provider in the
 * sibling `agents.defaults.provider` (see `manage-agent-tool.ts`, and the
 * normalisation in `core/config.ts`). Migrating a config would have written
 * `"anthropic/claude-opus-5"` where every reader expects `"claude-opus-5"`,
 * breaking model resolution for exactly the installs it claimed to rescue.
 *
 * And the `settings.defaultProvider` shape it migrated FROM was introduced by
 * the same commit as the migration itself — no released Brigade ever wrote it.
 * The real legacy shape is the flat `defaultProvider` / `defaultModelId` pair,
 * which `core/config.ts::mergeAndNormalizeConfig` already remaps on every
 * write. That path is live, tested, and correct.
 *
 * The lesson worth keeping: "this is dead, wire it up" and "this is dead,
 * delete it" look identical until you check what the live reader expects.
 */

import { type Static, Type } from "typebox";
import { Errors } from "typebox/value";


export const BRIGADE_CONFIG_SCHEMA_VERSION = 2 as const;

export const BRIGADE_CONFIG_FILENAME = "brigade.json";

/* ───────────────────────────── v2 schema ──────────────────────────────── */

const TOOL_FILTER_SCHEMA = Type.Object({
	alsoAllow: Type.Optional(Type.Array(Type.String())),
	deny: Type.Optional(Type.Array(Type.String())),
});

const IDENTITY_SCHEMA = Type.Object({
	name: Type.Optional(Type.String()),
	emoji: Type.Optional(Type.String()),
});

// Profile METADATA only — never the secret value. Key material lives in
// Pi's auth.json (or in the env block as the canonical state-isolation home).
const AUTH_PROFILE_SCHEMA = Type.Object({
	provider: Type.String(),
	mode: Type.Union([Type.Literal("api_key"), Type.Literal("oauth"), Type.Literal("token")]),
	email: Type.Optional(Type.String()),
	displayName: Type.Optional(Type.String()),
});

const AUTH_SCHEMA = Type.Object({
	profiles: Type.Optional(Type.Record(Type.String(), AUTH_PROFILE_SCHEMA)),
});

// Object form chosen so adding `fallbacks` later is additive (not a reshape).
// `primary` is "<provider>/<modelId>" — first-slash-split on read.
const AGENT_MODEL_SCHEMA = Type.Object({
	primary: Type.Optional(Type.String()),
	fallbacks: Type.Optional(Type.Array(Type.String())),
});

const AGENT_DEFAULTS_SCHEMA = Type.Object({
	model: Type.Optional(AGENT_MODEL_SCHEMA),
	subagents: Type.Optional(
		Type.Object({
			allowAgents: Type.Optional(Type.Array(Type.String())),
		}),
	),
});

// `name` is OPTIONAL by design — it mirrors the virtual-default-agent pattern
// in mature personal-AI-crew agents, where the entry is keyed by `id` (the
// routing key, e.g. "main") and the human-readable name is derived later from
// the persona layer (BOOTSTRAP / identity command writes `identity.name`, or
// the user sets a top-level `name` explicitly). Requiring `name` upfront would
// force callers to invent a placeholder string at scaffold time, which is
// exactly the back-door the v1→v2 migration was leaking the product brand
// through.
const AGENT_ENTRY_SCHEMA = Type.Object({
	id: Type.String(),
	name: Type.Optional(Type.String()),
	identity: Type.Optional(IDENTITY_SCHEMA),
	workspace: Type.Optional(Type.String()),
	agentDir: Type.Optional(Type.String()),
	tools: Type.Optional(TOOL_FILTER_SCHEMA),
	model: Type.Optional(AGENT_MODEL_SCHEMA),
});

const AGENTS_SCHEMA = Type.Object({
	defaults: Type.Optional(AGENT_DEFAULTS_SCHEMA),
	list: Type.Optional(Type.Array(AGENT_ENTRY_SCHEMA)),
});

const PLUGIN_ENTRY_SCHEMA = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const PLUGINS_SCHEMA = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	allow: Type.Optional(Type.Array(Type.String())),
	deny: Type.Optional(Type.Array(Type.String())),
	entries: Type.Optional(Type.Record(Type.String(), PLUGIN_ENTRY_SCHEMA)),
});

const SKILL_ENTRY_SCHEMA = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const SKILLS_SCHEMA = Type.Object({
	// Global on/off for the skills subsystem (default: on when omitted).
	enabled: Type.Optional(Type.Boolean()),
	// Extra skill search roots beyond the bundled + workspace dirs.
	paths: Type.Optional(Type.Array(Type.String())),
	entries: Type.Optional(Type.Record(Type.String(), SKILL_ENTRY_SCHEMA)),
});

// Per-channel settings. `dmPolicy` gates inbound DMs:
//   - `pairing` (default) — strangers get a one-shot code, operator approves
//   - `allowlist` — only senders in the allow-from list (no auto-challenge)
//   - `open` — anyone can DM (use with care)
//   - `disabled` — silently drop every DM
// The schema is intentionally OPEN so adapters can carry their own settings
// (account ids, baseUrls, etc.) without per-channel schema changes here.
const CHANNEL_ENTRY_SCHEMA = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	dmPolicy: Type.Optional(
		Type.Union([Type.Literal("pairing"), Type.Literal("allowlist"), Type.Literal("open"), Type.Literal("disabled")]),
	),
});
const CHANNELS_SCHEMA = Type.Record(Type.String(), Type.Intersect([CHANNEL_ENTRY_SCHEMA, Type.Record(Type.String(), Type.Unknown())]));

// Extension subsystem (Pi-native tools/hooks/commands + Brigade product
// channels/voice/media). Mirrors the plugins/skills gating shape: a global
// on/off, a deny-list, and per-module entries. The extension loader reads
// this; channels additionally honor their own `channels.<id>` settings.
const EXTENSION_ENTRY_SCHEMA = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

// Slots pick the active capability when multiple plugins register one (memory
// backend, context engine, compaction, agent harness). The value is the id of
// the registered capability; unset slots fall through to Brigade's built-in
// path. The resolver lives on `BrigadeExtensionRegistry.resolveSlot`.
const EXTENSIONS_SLOTS_SCHEMA = Type.Object(
	{
		memory: Type.Optional(Type.String()),
		contextEngine: Type.Optional(Type.String()),
		compaction: Type.Optional(Type.String()),
		agentHarness: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const EXTENSIONS_SCHEMA = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	// When non-empty, ONLY listed module ids load (allowlist).
	allow: Type.Optional(Type.Array(Type.String())),
	disabled: Type.Optional(Type.Array(Type.String())),
	slots: Type.Optional(EXTENSIONS_SLOTS_SCHEMA),
	entries: Type.Optional(Type.Record(Type.String(), EXTENSION_ENTRY_SCHEMA)),
});

// Brigade v1 is single-user / localhost-only — there is no WS auth layer to
// configure here. The gateway hard-refuses non-localhost binds (see server.ts)
// so this block is a no-op today; multi-user auth lands with the Phase-2 SaaS
// shape (HTTP-session / Convex), NOT a static token in this file.
//
// We intentionally still accept arbitrary keys here so existing brigade.json
// files don't fail validation, but no field is read by any runtime.
const GATEWAY_AUTH_SCHEMA = Type.Record(Type.String(), Type.Unknown());

const GATEWAY_HTTP_SCHEMA = Type.Object({
	endpoints: Type.Optional(
		Type.Record(
			Type.String(),
			Type.Object({
				enabled: Type.Optional(Type.Boolean()),
			}),
		),
	),
});

const GATEWAY_CONTROL_UI_SCHEMA = Type.Object({
	allowedOrigins: Type.Optional(Type.Array(Type.String())),
});

const GATEWAY_RELOAD_SCHEMA = Type.Object({
	mode: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("hot"), Type.Literal("manual")]),
	),
});

const GATEWAY_SCHEMA = Type.Object({
	mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
	port: Type.Optional(Type.Number()),
	auth: Type.Optional(GATEWAY_AUTH_SCHEMA),
	http: Type.Optional(GATEWAY_HTTP_SCHEMA),
	controlUi: Type.Optional(GATEWAY_CONTROL_UI_SCHEMA),
	reload: Type.Optional(GATEWAY_RELOAD_SCHEMA),
});

const WIZARD_SCHEMA = Type.Object({
	lastRunAt: Type.Optional(Type.String()),
	lastRunVersion: Type.Optional(Type.String()),
});

const META_SCHEMA = Type.Object({
	lastTouchedVersion: Type.Optional(Type.String()),
	lastTouchedAt: Type.Optional(Type.String()),
	installedAt: Type.Optional(Type.String()),
});

// Brigade-private namespace for knobs that have no v2 home in the reference
// shape yet. compaction/thinkingLevel stay here until the relevant primitive
// (Primitive #2/#4 etc.) gives them a real home in agents.* or similar.
//
// fallbackProvider/fallbackModelId/installedAt are DROPPED at v2 — they're
// moved to agents.defaults.model.fallbacks and meta.installedAt. The
// migration in `migrateBrigadeConfigV1toV2` performs the lift; in-flight
// readers fall back here transparently.
//
// defaultProvider/defaultModelId are PARTIALLY dropped: when both are
// present, they're consolidated into agents.defaults.model.primary. They
// remain accepted in the v2 schema solely as transient in-flight scratch
// for partial-write CLI flows (`brigade config set defaultProvider X`
// without a subsequent `set defaultModelId Y`), since
// agents.defaults.model.primary requires both halves to form a valid
// "<provider>/<modelId>" ref. saveConfig MUST clear them once primary is
// composed.
const SETTINGS_SCHEMA = Type.Object({
	compaction: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()) })),
	thinkingLevel: Type.Optional(Type.String()),
	defaultProvider: Type.Optional(Type.String()),
	defaultModelId: Type.Optional(Type.String()),
});

export const BrigadeConfigSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	version: Type.Literal(2),
	meta: Type.Optional(META_SCHEMA),
	wizard: Type.Optional(WIZARD_SCHEMA),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	auth: Type.Optional(AUTH_SCHEMA),
	agents: Type.Optional(AGENTS_SCHEMA),
	plugins: Type.Optional(PLUGINS_SCHEMA),
	skills: Type.Optional(SKILLS_SCHEMA),
	channels: Type.Optional(CHANNELS_SCHEMA),
	extensions: Type.Optional(EXTENSIONS_SCHEMA),
	gateway: Type.Optional(GATEWAY_SCHEMA),
	settings: Type.Optional(SETTINGS_SCHEMA),
});

export type BrigadeConfig = Static<typeof BrigadeConfigSchema>;

/* ────────────────────────── v1 schema (legacy) ────────────────────────── */


export interface BrigadeConfigValidationIssue {
	path: string;
	message: string;
}

export class BrigadeConfigValidationError extends Error {
	readonly errors: BrigadeConfigValidationIssue[];

	constructor(message: string, errors: BrigadeConfigValidationIssue[]) {
		super(message);
		this.name = "BrigadeConfigValidationError";
		this.errors = errors;
	}
}

/**
 * Validate any value against the BrigadeConfigSchema and return a flat list
 * of issues (empty array = valid). Public so the `brigade config validate`
 * subcommand can reuse the same TypeBox machinery.
 */
export function collectBrigadeConfigErrors(value: unknown): BrigadeConfigValidationIssue[] {
	const issues: BrigadeConfigValidationIssue[] = [];
	for (const err of Errors(BrigadeConfigSchema, value)) {
		issues.push({
			path: typeof err.instancePath === "string" ? err.instancePath : "",
			message: typeof err.message === "string" ? err.message : "validation error",
		});
	}
	return issues;
}
