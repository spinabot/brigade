/**
 * Brigade super-config.
 *
 * Single source of truth at `<BRIGADE_DIR>/brigade.json`. Replaces the legacy
 * three-file layout (`auth.json`, `config.json`, `settings.json`) with a
 * versioned, schema-validated document plus rotating backups and atomic
 * writes. Boot must never fail on a corrupt file — recovery walks the
 * backup chain and ultimately falls through to a fresh empty config.
 *
 * v2 schema (current). The block names mirror the reference super-config
 * shape so future Phase-2/3 features (auth profiles for non-key providers,
 * multi-agent rosters, plugins, skills, channels, gateway control UI) just
 * add nested fields rather than reshaping the document. The migration from
 * v1 → v2 reorganises three things:
 *
 *   1. settings.defaultProvider + settings.defaultModelId
 *        → agents.defaults.model.primary (composed as "<provider>/<modelId>")
 *   2. settings.fallbackProvider + settings.fallbackModelId
 *        → agents.defaults.model.fallbacks[0]
 *   3. settings.installedAt
 *        → meta.installedAt
 *
 * settings.compaction and settings.thinkingLevel stay under `settings` —
 * Brigade-private namespace until later primitives give them a real home.
 */

import { chmodSync, closeSync, copyFileSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

import { BRIGADE_CLI_VERSION } from "./version.js";

export const BRIGADE_CONFIG_SCHEMA_VERSION = 2 as const;

export const BRIGADE_CONFIG_FILENAME = "brigade.json";
export const BACKUP_DEPTH = 4;
const FILE_MODE = 0o600;

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

const CHANNELS_SCHEMA = Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()));

// Extension subsystem (Pi-native tools/hooks/commands + Brigade product
// channels/voice/media). Mirrors the plugins/skills gating shape: a global
// on/off, a deny-list, and per-module entries. The extension loader reads
// this; channels additionally honor their own `channels.<id>` settings.
const EXTENSION_ENTRY_SCHEMA = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const EXTENSIONS_SCHEMA = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	// When non-empty, ONLY listed module ids load (allowlist).
	allow: Type.Optional(Type.Array(Type.String())),
	disabled: Type.Optional(Type.Array(Type.String())),
	entries: Type.Optional(Type.Record(Type.String(), EXTENSION_ENTRY_SCHEMA)),
});

const GATEWAY_AUTH_SCHEMA = Type.Object({
	mode: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("token"), Type.Literal("password")]),
	),
	token: Type.Optional(Type.String()),
	password: Type.Optional(Type.String()),
});

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

/**
 * v1 schema kept around solely for migration validation. Never written; only
 * matched against on disk to detect "this is a pre-v2 file we should lift."
 */
const BRIGADE_CONFIG_V1_SCHEMA = Type.Object({
	version: Type.Literal(1),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	settings: Type.Optional(
		Type.Object({
			defaultProvider: Type.Optional(Type.String()),
			defaultModelId: Type.Optional(Type.String()),
			fallbackProvider: Type.Optional(Type.String()),
			fallbackModelId: Type.Optional(Type.String()),
			installedAt: Type.Optional(Type.String()),
			thinkingLevel: Type.Optional(Type.String()),
			compaction: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()) })),
		}),
	),
});
type BrigadeConfigV1 = Static<typeof BRIGADE_CONFIG_V1_SCHEMA>;

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

function configPath(brigadeDir: string): string {
	return path.join(brigadeDir, BRIGADE_CONFIG_FILENAME);
}

function backupPath(brigadeDir: string, slot: number): string {
	const base = `${configPath(brigadeDir)}.bak`;
	return slot === 0 ? base : `${base}.${slot}`;
}

function backupChain(brigadeDir: string): string[] {
	const chain: string[] = [];
	for (let slot = 0; slot <= BACKUP_DEPTH; slot++) {
		chain.push(backupPath(brigadeDir, slot));
	}
	return chain;
}

function emptyConfig(): BrigadeConfig {
	return { version: BRIGADE_CONFIG_SCHEMA_VERSION };
}

function isoTimestampForFilename(): string {
	return new Date().toISOString().replace(/[:]/g, "-");
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

// Backwards-compat alias used by writers in this file.
const collectErrors = collectBrigadeConfigErrors;

async function tryReadJson(p: string): Promise<unknown> {
	const buf = await fs.readFile(p, "utf8");
	return JSON.parse(buf) as unknown;
}

async function safeRename(from: string, to: string): Promise<void> {
	try {
		await fs.rename(from, to);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return;
		throw err;
	}
}

async function safeRemove(p: string): Promise<void> {
	try {
		await fs.rm(p, { force: true });
	} catch {
		/* ignore */
	}
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function rotateBackups(brigadeDir: string): Promise<void> {
	// Rotate before write so a crash mid-write leaves bak as the last known good.
	const current = configPath(brigadeDir);
	if (!(await exists(current))) return;
	for (let slot = BACKUP_DEPTH; slot >= 1; slot--) {
		const from = backupPath(brigadeDir, slot - 1);
		const to = backupPath(brigadeDir, slot);
		if (!(await exists(from))) continue;
		await safeRemove(to);
		await safeRename(from, to);
	}
	await safeRemove(backupPath(brigadeDir, 0));
	await safeRename(current, backupPath(brigadeDir, 0));
}

function atomicWriteSync(filePath: string, data: string): void {
	const tmp = `${filePath}.tmp`;
	const fd = openSync(tmp, "w", FILE_MODE);
	try {
		writeSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, filePath);
	try {
		chmodSync(filePath, FILE_MODE);
	} catch {
		/* ignore — Windows / restricted FS */
	}
}

function snapshotCorrupted(brigadeDir: string): string | undefined {
	const src = configPath(brigadeDir);
	const target = `${src}.clobbered.${isoTimestampForFilename()}`;
	try {
		renameSync(src, target);
		return target;
	} catch {
		return undefined;
	}
}

/**
 * Scrub the legacy `agents.list[i].name = "Brigade"` value that pre-v0.1.0
 * onboarding wrote to disk. The product brand was being injected into the
 * persona slot through a back door — once the seed entry exists with that
 * name, every downstream display surface that reads `agents.list[i].name`
 * surfaces "Brigade" as the agent's own name, which is exactly the leak the
 * `name`-removal fix was meant to prevent.
 *
 * Strategy: if any list entry has `name === "Brigade"` (the literal product
 * brand), drop the `name` field entirely. Schema marks `name` optional so a
 * scrubbed entry remains valid; downstream code falls back to whatever the
 * user picks via the BOOTSTRAP / identity command (which writes IDENTITY.md).
 *
 * Returns true when at least one entry was modified, so the caller can
 * persist the cleaned config back to disk + emit a one-line audit message.
 * Idempotent: a second pass over an already-clean config does nothing.
 */
function scrubLegacyAgentName(cfg: BrigadeConfig): boolean {
	const list = cfg.agents?.list;
	if (!list || list.length === 0) return false;
	let changed = false;
	for (const entry of list) {
		if (entry && entry.name === "Brigade") {
			delete (entry as { name?: string }).name;
			changed = true;
		}
	}
	return changed;
}

export async function loadBrigadeConfig(brigadeDir: string): Promise<BrigadeConfig> {
	const main = configPath(brigadeDir);
	if (await exists(main)) {
		try {
			const raw = await tryReadJson(main);
			if (Check(BrigadeConfigSchema, raw)) {
				const cfg = raw as BrigadeConfig;
				// Migrate-on-read scrub: drop legacy product-brand seed in
				// agents.list[i].name. See `scrubLegacyAgentName` for rationale.
				// Persist the cleaned config back so the next read finds nothing
				// to scrub (idempotent), and so other readers + the brigade.json
				// file on disk both reflect the same cleaned state.
				if (scrubLegacyAgentName(cfg)) {
					try {
						await writeBrigadeConfig(brigadeDir, cfg);
						process.stderr.write(
							"brigade: scrubbed legacy agents.list[i].name='Brigade' from brigade.json (auto-cleanup of pre-v0.1.0 leak)\n",
						);
					} catch {
						// Don't block boot if the write fails — the in-memory
						// config is already clean for this process; the next
						// successful write from any code path will persist it.
					}
				}
				return cfg;
			}
			// Parsed but failed schema — treat as corrupt: snapshot, walk backups.
			snapshotCorrupted(brigadeDir);
		} catch {
			snapshotCorrupted(brigadeDir);
		}
	}

	for (let slot = 0; slot <= BACKUP_DEPTH; slot++) {
		const candidate = backupPath(brigadeDir, slot);
		if (!(await exists(candidate))) continue;
		try {
			const raw = await tryReadJson(candidate);
			if (Check(BrigadeConfigSchema, raw)) {
				const cfg = raw as BrigadeConfig;
				// Same scrub on the recovered backup. Don't try to write here —
				// recovery already implies the main file was bad; we'd rather
				// hand back a clean in-memory copy and let the next normal
				// write path persist the scrub.
				scrubLegacyAgentName(cfg);
				return cfg;
			}
		} catch {
			/* try the next slot */
		}
	}

	process.stderr.write(
		"brigade: warning: brigade.json corrupt, all backups exhausted, starting fresh\n",
	);
	return emptyConfig();
}

/**
 * Strip leaf properties whose value is `undefined`, recursively. JSON.stringify
 * already drops them at the top level, but the migration builds nested objects
 * (`{ agents: { defaults: { model: { primary: undefined } } } }`) where the
 * `undefined` would mean the inner objects survive serialization as empty `{}`
 * — noisy and hostile to grep. Clean both empty objects AND undefined leaves.
 */
function stripUndefined<T>(value: T): T {
	if (Array.isArray(value)) {
		return value
			.map((v) => stripUndefined(v as unknown))
			.filter((v) => v !== undefined) as unknown as T;
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (v === undefined) continue;
			const cleaned = stripUndefined(v);
			// Drop empty plain objects so we don't litter the file with `{}` leaves.
			// Arrays may legitimately be empty (explicit "I want no fallbacks") so
			// they're preserved — only object-shaped emptiness gets pruned.
			if (
				cleaned !== null &&
				typeof cleaned === "object" &&
				!Array.isArray(cleaned) &&
				Object.keys(cleaned as Record<string, unknown>).length === 0
			) {
				continue;
			}
			out[k] = cleaned;
		}
		return out as unknown as T;
	}
	return value;
}

/**
 * Stamp meta.lastTouchedVersion + lastTouchedAt unconditionally on every write
 * so `~/.brigade/brigade.json` always reflects which Brigade build last
 * mutated it. Preserves existing meta fields (notably installedAt) by merging.
 */
function applyMetaTouch(cfg: BrigadeConfig): BrigadeConfig {
	const meta = { ...(cfg.meta ?? {}) };
	meta.lastTouchedVersion = BRIGADE_CLI_VERSION;
	meta.lastTouchedAt = new Date().toISOString();
	return { ...cfg, meta };
}

export async function writeBrigadeConfig(
	brigadeDir: string,
	cfg: BrigadeConfig,
): Promise<void> {
	const stamped = applyMetaTouch(cfg);
	if (!Check(BrigadeConfigSchema, stamped)) {
		const issues = collectErrors(stamped);
		throw new BrigadeConfigValidationError(
			`brigade.json failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
			issues,
		);
	}

	await fs.mkdir(brigadeDir, { recursive: true });
	await rotateBackups(brigadeDir);

	const serialized = `${JSON.stringify(stamped, null, 2)}\n`;
	atomicWriteSync(configPath(brigadeDir), serialized);
}

/* ───────────────────── v1 → v2 schema migration ───────────────────────── */

export interface V1MigrationResult {
	migrated: boolean;
	snapshotPath?: string;
}

/**
 * Compose a "<provider>/<modelId>" model ref string. Avoid double-prefixing
 * when the modelId already starts with "<provider>/" (e.g. OpenRouter ids
 * like "openrouter/auto" — joining naively would give "openrouter/openrouter/auto"
 * which is technically what the user typed, but the cleaner stored form is
 * "openrouter/auto"). First-slash-split on read still recovers the right
 * provider either way, but skip the redundant prefix when we can.
 */
function composeModelRef(p?: string, m?: string): string | undefined {
	if (!p || !m) return undefined;
	return m.startsWith(`${p}/`) ? m : `${p}/${m}`;
}

function composeFallbacks(p?: string, m?: string): string[] | undefined {
	const ref = composeModelRef(p, m);
	return ref ? [ref] : undefined;
}

/**
 * Migrate a v1 Brigade super-config to the v2 reference-aligned shape.
 * Idempotent — already-v2 configs short-circuit. Side effect: writes a
 * `<configPath>.migrated-v1-<ISO-ts>.bak` snapshot before write so the
 * migration is auditable + reversible.
 *
 * Behaviour:
 *   - missing brigade.json         → no-op (returns {migrated:false})
 *   - version === 2                → no-op (already migrated)
 *   - version > 2                  → no-op + stderr warn (don't trash a future config)
 *   - version === 1 (or absent)    → snapshot + lift + write v2
 *   - corrupt v1 (schema-fails)    → no-op + stderr warn (don't trash bad data)
 */
export async function migrateBrigadeConfigV1toV2(
	brigadeDir: string,
): Promise<V1MigrationResult> {
	const cfgPath = configPath(brigadeDir);
	if (!(await exists(cfgPath))) return { migrated: false };

	let raw: unknown;
	try {
		raw = await tryReadJson(cfgPath);
	} catch {
		// Corrupt JSON — leave it alone. loadBrigadeConfig's recovery path
		// will deal with it on next read; we don't want to mask the corruption
		// or destroy a file the user might still be able to hand-recover.
		process.stderr.write(
			"brigade: warning: brigade.json is unparseable; v1→v2 migration skipped\n",
		);
		return { migrated: false };
	}

	const versionField = (raw && typeof raw === "object")
		? (raw as Record<string, unknown>).version
		: undefined;

	if (versionField === 2) return { migrated: false };
	if (typeof versionField === "number" && versionField > 2) {
		process.stderr.write(
			`brigade: warning: brigade.json is version ${versionField} (newer than this build); skipping migration\n`,
		);
		return { migrated: false };
	}

	// Treat absent version as v1 best-effort. Validate against the v1 schema
	// to confirm the shape is recognisable; if it isn't, leave the file alone.
	let v1: BrigadeConfigV1;
	if (versionField === undefined) {
		// Synthesise a version field so the v1 schema check passes; we already
		// know there's no version, so it's v0/v1-shaped at best.
		const candidate = { ...(raw as Record<string, unknown>), version: 1 };
		if (!Check(BRIGADE_CONFIG_V1_SCHEMA, candidate)) {
			process.stderr.write(
				"brigade: warning: brigade.json has no version and doesn't match the v1 shape; migration skipped\n",
			);
			return { migrated: false };
		}
		v1 = candidate as BrigadeConfigV1;
	} else if (versionField === 1) {
		if (!Check(BRIGADE_CONFIG_V1_SCHEMA, raw)) {
			process.stderr.write(
				"brigade: warning: brigade.json claims version 1 but failed schema validation; migration skipped\n",
			);
			return { migrated: false };
		}
		v1 = raw as BrigadeConfigV1;
	} else {
		// Some other version literal (0, negative, non-number). Skip — too risky
		// to lift heuristically.
		process.stderr.write(
			`brigade: warning: brigade.json has unexpected version ${String(versionField)}; migration skipped\n`,
		);
		return { migrated: false };
	}

	// Snapshot before write so the migration is reversible. Use copyFile (not
	// rename) because writeBrigadeConfig will overwrite the original — we want
	// to keep both the new v2 file AND the original v1 backup side-by-side.
	const snapshotPath = `${cfgPath}.migrated-v1-${isoTimestampForFilename()}.bak`;
	try {
		copyFileSync(cfgPath, snapshotPath);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(
			`brigade: warning: couldn't snapshot v1 config before migration (${msg}); aborting migration\n`,
		);
		return { migrated: false };
	}

	const v2: BrigadeConfig = stripUndefined({
		version: 2 as const,
		env: v1.env,
		meta: {
			installedAt: v1.settings?.installedAt,
			// lastTouchedVersion + lastTouchedAt stamped by writeBrigadeConfig
		},
		agents: {
			defaults: {
				model: {
					primary: composeModelRef(
						v1.settings?.defaultProvider,
						v1.settings?.defaultModelId,
					),
					fallbacks: composeFallbacks(
						v1.settings?.fallbackProvider,
						v1.settings?.fallbackModelId,
					),
				},
			},
			// Deliberately DO NOT seed `agents.list` here. This matches the
			// virtual-default-agent pattern used in mature personal-AI-crew
			// agents: when `agents.list` is absent, the runtime synthesizes a
			// virtual entry keyed by the well-known "main" id. Writing a stub
			// like `{ id: "main", name: "<product>" }` would leak the product
			// brand into the persona slot through a back door — the `name`
			// field is reserved for whatever the user picks via the BOOTSTRAP
			// conversation (which writes IDENTITY.md) or an explicit identity
			// command. Leaving the list undefined keeps that slot clean.
		},
		settings: {
			compaction: v1.settings?.compaction,
			thinkingLevel: v1.settings?.thinkingLevel,
		},
	});

	await writeBrigadeConfig(brigadeDir, v2);
	return { migrated: true, snapshotPath };
}

/* ────────────────── legacy 3-file → super-config migration ────────────── */

export interface MigrationResult {
	migrated: boolean;
	movedFiles: string[];
}

interface LegacyAuth {
	[k: string]: string;
}

interface LegacyConfig {
	defaultProvider?: string;
	defaultModelId?: string;
	fallbackProvider?: string;
	fallbackModelId?: string;
	thinkingLevel?: string;
	installedAt?: string;
	[k: string]: unknown;
}

interface LegacySettings {
	compaction?: { enabled?: boolean };
	[k: string]: unknown;
}

async function readLegacyJson<T>(p: string): Promise<T | undefined> {
	if (!(await exists(p))) return undefined;
	try {
		const raw = await fs.readFile(p, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object") return parsed as T;
		return undefined;
	} catch {
		return undefined;
	}
}

export async function migrateLegacyConfig(brigadeDir: string): Promise<MigrationResult> {
	// Idempotent guard — a valid super-config means the migration already ran.
	const main = configPath(brigadeDir);
	if (await exists(main)) {
		try {
			const existing = await tryReadJson(main);
			if (Check(BrigadeConfigSchema, existing)) {
				return { migrated: false, movedFiles: [] };
			}
		} catch {
			/* corrupted — fall through to attempt migration */
		}
	}

	const authPath = path.join(brigadeDir, "auth.json");
	const configFile = path.join(brigadeDir, "config.json");
	const settingsPath = path.join(brigadeDir, "settings.json");

	const legacyAuth = await readLegacyJson<LegacyAuth>(authPath);
	const legacyConfig = await readLegacyJson<LegacyConfig>(configFile);
	const legacySettings = await readLegacyJson<LegacySettings>(settingsPath);

	if (!legacyAuth && !legacyConfig && !legacySettings) {
		return { migrated: false, movedFiles: [] };
	}

	// Build directly into v2 shape — skip the intermediate v1 hop. Otherwise
	// every fresh install would write v1 first, then immediately migrate to v2
	// on the next call, doubling the .bak chain churn for no benefit.
	const merged: BrigadeConfig = stripUndefined({
		version: BRIGADE_CONFIG_SCHEMA_VERSION,
		env:
			legacyAuth && Object.keys(legacyAuth).length > 0
				? Object.fromEntries(
						Object.entries(legacyAuth).filter(
							([, v]) => typeof v === "string",
						) as Array<[string, string]>,
					)
				: undefined,
		meta: {
			installedAt:
				typeof legacyConfig?.installedAt === "string"
					? legacyConfig.installedAt
					: undefined,
		},
		agents: legacyConfig
			? {
					defaults: {
						model: {
							primary: composeModelRef(
								legacyConfig.defaultProvider,
								legacyConfig.defaultModelId,
							),
							fallbacks: composeFallbacks(
								legacyConfig.fallbackProvider,
								legacyConfig.fallbackModelId,
							),
						},
					},
					// `agents.list` deliberately omitted — runtime synthesizes the
					// virtual default agent keyed by "main" when the list is
					// absent (see migrateBrigadeConfigV1toV2 for the same
					// rationale). Avoids leaking the product name into the
					// persona slot.
				}
			: undefined,
		settings: {
			compaction:
				legacySettings?.compaction && typeof legacySettings.compaction === "object"
					? typeof legacySettings.compaction.enabled === "boolean"
						? { enabled: legacySettings.compaction.enabled }
						: undefined
					: undefined,
			thinkingLevel:
				typeof legacyConfig?.thinkingLevel === "string"
					? legacyConfig.thinkingLevel
					: undefined,
		},
	});

	await writeBrigadeConfig(brigadeDir, merged);

	const moved: string[] = [];
	const ts = isoTimestampForFilename();
	for (const legacyPath of [authPath, configFile, settingsPath]) {
		if (!(await exists(legacyPath))) continue;
		const target = `${legacyPath}.migrated-${ts}`;
		try {
			await fs.rename(legacyPath, target);
			moved.push(target);
		} catch {
			/* leave the legacy file in place if rename fails */
		}
	}

	return { migrated: true, movedFiles: moved };
}

/* ───────────────────── env overlay into process.env ───────────────────── */

export interface EnvLoadResult {
	applied: string[];
	skipped: string[];
}

/**
 * Module-level snapshot of which env-block keys were ACTUALLY written into
 * `process.env` by the most recent `loadEnvIntoProcess` call. Auth-source
 * resolution reads this so it can distinguish "value came from brigade.json"
 * from "value happens to match a shell env var" — without this set, value-
 * equality would falsely report "file" when the shell pre-populated the
 * variable, and `rm -rf ~/.brigade` would NOT actually wipe the auth.
 *
 * Reset on every `loadEnvIntoProcess` invocation, including the empty-config
 * path, so stale entries from a previous boot can't bleed into a new one.
 */
let _appliedFromFile: ReadonlySet<string> = new Set();

export function getAppliedEnvKeys(): ReadonlySet<string> {
	return _appliedFromFile;
}

export function loadEnvIntoProcess(cfg: BrigadeConfig): EnvLoadResult {
	const result: EnvLoadResult = { applied: [], skipped: [] };
	const env = cfg.env;
	if (!env) {
		_appliedFromFile = new Set();
		return result;
	}
	for (const [key, value] of Object.entries(env)) {
		// Shell-supplied env wins so users aren't surprised by config overriding it.
		if (Object.prototype.hasOwnProperty.call(process.env, key)) {
			result.skipped.push(key);
			continue;
		}
		process.env[key] = value;
		result.applied.push(key);
	}
	_appliedFromFile = new Set(result.applied);
	return result;
}

/* ──────────────────────── helpers exported for callers ────────────────── */

/**
 * First-slash-split a "<provider>/<modelId>" model ref into its component
 * parts. Used by config readers that need to recover provider+modelId from
 * `agents.defaults.model.primary` (or `.fallbacks[i]`). Documented semantics:
 * the FIRST `/` is the provider/modelId separator, so multi-slash modelIds
 * (e.g. `openrouter/openrouter/auto` → provider="openrouter",
 * modelId="openrouter/auto") survive intact.
 */
export function parseModelRef(
	ref: string | undefined,
): { provider: string; modelId: string } | undefined {
	if (!ref || ref.length === 0) return undefined;
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return {
		provider: ref.slice(0, slash),
		modelId: ref.slice(slash + 1),
	};
}

/**
 * Inverse of `parseModelRef`. Exposed so callers (config-cmd, onboarding,
 * server, chat) can compose a model ref consistently and avoid double-
 * prefixing OpenRouter-style ids that already include the provider segment.
 */
export function composeModelRefExternal(provider?: string, modelId?: string): string | undefined {
	return composeModelRef(provider, modelId);
}
