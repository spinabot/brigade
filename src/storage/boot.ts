// src/storage/boot.ts
//
// Process-boot entry for the storage layer. Every Brigade process calls
// `bootRuntimeContext()` exactly once before any subsystem touches state;
// after that, subsystems reach storage via `getRuntimeContext().store`.
//
// Idempotent by design: the CLI preAction hook, the gateway server, and any
// future embedder can all call it — the first caller pays the resolution +
// `store.init()` cost, everyone else gets the already-frozen context. A
// failed boot clears the in-flight slot so a retry (e.g. convex backend came
// back up) can succeed instead of replaying a cached rejection.

import { primeConfigCache } from "./config-cache.js";
import { primeSessionCache } from "./session-cache.js";
import {
	createRuntimeContext,
	setRuntimeContext,
	tryGetRuntimeContext,
	type RuntimeContext,
} from "./runtime-context.js";
import type { BrigadeStore } from "./store.js";

let _inflight: Promise<RuntimeContext> | undefined;

/** Resolve mode, build + init the store, and install the process-wide
 *  RuntimeContext. Safe to call from multiple places — only the first call
 *  does work. Throws when the backing store cannot initialise (e.g. convex
 *  mode with an unreachable deployment); callers that can operate without
 *  storage (doctor, status) catch and continue.
 *
 *  Convex mode additionally hydrates the in-process config cache so the
 *  codebase's synchronous `readConfigOrInit()` callers (per-turn loop, Pi
 *  boot paths) are served without touching disk. Long-lived processes call
 *  `enableConfigLiveRefresh()` afterwards to keep the cache hot. */
export async function bootRuntimeContext(): Promise<RuntimeContext> {
	const existing = tryGetRuntimeContext();
	if (existing) return existing;
	if (!_inflight) {
		_inflight = (async () => {
			const ctx = await createRuntimeContext();
			if (ctx.mode === "convex") {
				// Enforcement that ~/.brigade stays file-free (modulo the
				// allowlist): preventive fs patches + a detective watcher.
				// BRIGADE_STRICT_MODE=off|warn|enforce (default warn).
				const { installStrictGuard } = await import("./strict-guard.js");
				installStrictGuard(ctx.stateDir);
				// Wrong-key tripwire: the first encrypted boot stores the key's
				// fingerprint; every later boot verifies it. A mismatched
				// BRIGADE_ENCRYPTION_KEY would otherwise corrupt-on-write and
				// fail-on-read cryptically deep inside a turn.
				await verifyEncryptionFingerprint(ctx.store);
				const { value } = await ctx.store.config.read();
				// First-boot parity with the disk path: an absent row reads as
				// `{}`; the disk path's absent-file shape is `{ agents: {} }`.
				const cfg =
					Object.keys(value as Record<string, unknown>).length === 0
						? ({ agents: {} } as typeof value)
						: value;
				primeConfigCache(cfg);
				await Promise.all([
					hydrateSessionCaches(ctx.store, cfg as Record<string, unknown>),
					hydrateApprovalCaches(ctx.store, cfg as Record<string, unknown>),
					hydrateAccessCaches(ctx.store),
					hydrateCronCache(ctx.store),
					hydrateFactsCaches(ctx.store, cfg as Record<string, unknown>),
					hydrateAuthCaches(ctx.store, cfg as Record<string, unknown>),
					materialiseModelsCatalog(ctx.store),
					syncWorkspaceMirrors(ctx.store, cfg as Record<string, unknown>),
				]);
			}
			setRuntimeContext(ctx);
			return ctx;
		})();
		_inflight.catch(() => {
			// Allow a later retry after a transient failure. Without this, the
			// first rejection would be cached for the life of the process.
			_inflight = undefined;
		});
	}
	return _inflight;
}

/** Convex mode boot — fill the per-agent session caches so the codebase's
 *  synchronous sessions.json helpers serve from memory. Every agent in the
 *  config gets a slot (parallel queries — one wall-clock round-trip);
 *  agents added at runtime start from the empty shape, which is correct
 *  for a brand-new agent. */
async function hydrateSessionCaches(
	store: BrigadeStore,
	cfg: Record<string, unknown>,
): Promise<void> {
	const agents = cfg.agents as Record<string, unknown> | undefined;
	const ids = new Set<string>(["main"]);
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults" || !key.trim()) continue;
			ids.add(key.trim());
		}
	}
	await Promise.all(
		Array.from(ids, async (agentId) => {
			try {
				const rows = await store.sessions.listEntries(agentId);
				const sessions: Record<string, unknown> = {};
				for (const { sessionKey, entry } of rows) sessions[sessionKey] = entry;
				primeSessionCache(agentId, {
					version: 1,
					sessions: sessions as never,
				});
			} catch (err) {
				// A failed hydration for one agent must not block boot; the
				// empty-slot fallback in readSessionStore covers reads, and the
				// error is loud enough for the operator to investigate.
				console.error(
					`brigade: session hydration failed for agent ${agentId} — ${(err as Error).message}`,
				);
			}
		}),
	);
}

/** Convex mode boot — fill the exec-approvals module cache so the
 *  synchronous bash gate (`decideApproval`) never touches disk or network
 *  on the hot path. Same agent set as the session hydration. */
async function hydrateApprovalCaches(
	store: BrigadeStore,
	cfg: Record<string, unknown>,
): Promise<void> {
	const { primeApprovalsCache } = await import("../core/exec-approvals.js");
	const agents = cfg.agents as Record<string, unknown> | undefined;
	const ids = new Set<string>(["main"]);
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults" || !key.trim()) continue;
			ids.add(key.trim());
		}
	}
	await Promise.all(
		Array.from(ids, async (agentId) => {
			try {
				const contents = await store.execApprovals.list(agentId);
				primeApprovalsCache(agentId, contents);
			} catch (err) {
				console.error(
					`brigade: approvals hydration failed for agent ${agentId} — ${(err as Error).message}`,
				);
			}
		}),
	);
}

/** Convex mode boot — install channel access state (allow lists + pending
 *  pairings) into the access-control module's cache. One query for the
 *  whole owner; the module groups rows by (channel, account, kind). */
async function hydrateAccessCaches(store: BrigadeStore): Promise<void> {
	try {
		const { primeAccessCacheFromRows } = await import(
			"../agents/channels/access-control/store.js"
		);
		const rows = await store.channels.listAllAccessRows();
		primeAccessCacheFromRows(rows);
	} catch (err) {
		console.error(
			`brigade: channel-access hydration failed — ${(err as Error).message}`,
		);
	}
}

/** Convex mode boot — install the cron jobs into the cron cache so the
 *  cron service's whole-file load/save choke points serve from memory. */
async function hydrateCronCache(store: BrigadeStore): Promise<void> {
	try {
		const { primeCronCache } = await import("./cron-cache.js");
		const jobs = await store.cron.listJobs();
		primeCronCache(jobs as never[]);
	} catch (err) {
		console.error(`brigade: cron hydration failed — ${(err as Error).message}`);
	}
}

/** Convex mode boot — fill the per-workspace facts caches ("main" + every
 *  config agent) so the synchronous FactStore surface serves from memory. */
async function hydrateFactsCaches(
	store: BrigadeStore,
	cfg: Record<string, unknown>,
): Promise<void> {
	const { primeFactsCache } = await import("./facts-cache.js");
	const agents = cfg.agents as Record<string, unknown> | undefined;
	const ids = new Set<string>(["main"]);
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults" || !key.trim()) continue;
			ids.add(key.trim());
		}
	}
	await Promise.all(
		Array.from(ids, async (workspaceId) => {
			try {
				const records = await store.memory.listAllFactRecordsRaw(workspaceId);
				primeFactsCache(workspaceId, records as never[]);
			} catch (err) {
				console.error(
					`brigade: memory hydration failed for workspace ${workspaceId} — ${(err as Error).message}`,
				);
			}
		}),
	);
}

/** Convex mode boot — install every config agent's auth profiles (decrypted
 *  by the adapter) + auth-state + profile-state blobs into the in-process
 *  caches so the synchronous credential surface (Pi's AuthStorage boot,
 *  the failover ladder, cooldown bookkeeping) works without disk. */
async function hydrateAuthCaches(
	store: BrigadeStore,
	cfg: Record<string, unknown>,
): Promise<void> {
	const [{ primeAuthCaches }, { primeProfileStateCache }] = await Promise.all([
		import("../auth/profiles.js"),
		import("../auth/profile-cooldown.js"),
	]);
	const agents = cfg.agents as Record<string, unknown> | undefined;
	const ids = new Set<string>(["main"]);
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults" || !key.trim()) continue;
			ids.add(key.trim());
		}
	}
	await Promise.all(
		Array.from(ids, async (agentId) => {
			try {
				const [profiles, authState, profileState] = await Promise.all([
					store.auth.listProfiles(agentId),
					store.auth.readAuthFileBlob(agentId, "auth-state"),
					store.auth.readAuthFileBlob(agentId, "profile-state"),
				]);
				const profilesFile: { version: number; profiles: Record<string, unknown> } = {
					version: 1,
					profiles: {},
				};
				for (const p of profiles as Array<Record<string, unknown>>) {
					const { profileId, ...rest } = p;
					if (typeof profileId === "string") profilesFile.profiles[profileId] = rest;
				}
				primeAuthCaches(
					agentId,
					profilesFile as never,
					(authState ?? {
						version: 1,
						order: {},
						lastGood: {},
						usageStats: {},
					}) as never,
				);
				primeProfileStateCache(
					agentId,
					(profileState ?? { version: 1, usageStats: {} }) as never,
				);
			} catch (err) {
				console.error(
					`brigade: auth hydration failed for agent ${agentId} — ${(err as Error).message}`,
				);
			}
		}),
	);
}

/** Convex mode boot — materialise the models.json catalog (custom providers
 *  — Ollama etc.) from its sealed blob into the OS cache dir, where
 *  `resolveModelsPath` points in convex mode. Pi's ModelRegistry reads the
 *  file with sync fs, so a real file is unavoidable — but it's a
 *  regenerable mirror OUTSIDE ~/.brigade; the blob is the source of
 *  truth. No blob (the common case — no custom providers) → no file, and
 *  Pi treats the absent file as an empty catalog. */
async function materialiseModelsCatalog(store: BrigadeStore): Promise<void> {
	try {
		const blob = await store.auth.readAuthFileBlob("main", "models");
		if (!blob) return;
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const path = await import("node:path");
		const { resolveModelsPath } = await import("../config/paths.js");
		const target = resolveModelsPath("main");
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, JSON.stringify(blob, null, 2), "utf8");
	} catch (err) {
		console.error(
			`brigade: models catalog materialisation failed — ${(err as Error).message}`,
		);
	}
}

/** Convex mode boot — two-way workspace mirror sync.
 *
 *  The workspace DIRECTORY stays fully local in both modes (operator
 *  decision 2026-06-10): it is the agent's CWD, the git repo lives there,
 *  and Pi tools read/write it natively. Convex's personaFiles +
 *  workspaceState tables are the MIRROR:
 *
 *    • disk file present → push to Convex when content differs (the disk
 *      copy is the working copy — disk wins while it exists)
 *    • disk file missing but a Convex row exists → materialise to disk
 *      (fresh machine, or the operator deleted ~/.brigade — customised
 *      personas come back; only git history is lost, by design)
 *
 *  Runs BEFORE onboarding's bootstrapWorkspace can seed templates, so the
 *  `wx` create-only flag preserves restored customisations over templates.
 *  Agents that never had their own workspace (they share the top-level
 *  one) have neither disk dirs nor Convex rows — both directions no-op. */
async function syncWorkspaceMirrors(
	store: BrigadeStore,
	cfg: Record<string, unknown>,
): Promise<void> {
	const fsp = await import("node:fs/promises");
	const { existsSync } = await import("node:fs");
	const path = await import("node:path");
	const { resolveAgentWorkspaceDir } = await import("../config/paths.js");
	const { readWorkspaceState, markBootstrapSeeded, markSetupCompleted } = await import(
		"../workspace/state.js"
	);

	const PERSONA_NAMES = [
		"AGENTS.md",
		"SOUL.md",
		"IDENTITY.md",
		"USER.md",
		"TOOLS.md",
		"BOOTSTRAP.md",
		"MEMORY.md",
		"HEARTBEAT.md",
	] as const;

	const agents = cfg.agents as Record<string, unknown> | undefined;
	const ids = new Set<string>(["main"]);
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults" || !key.trim()) continue;
			ids.add(key.trim());
		}
	}

	await Promise.all(
		Array.from(ids, async (agentId) => {
			try {
				const workspaceDir = resolveAgentWorkspaceDir(agentId);
				const dirExists = existsSync(workspaceDir);
				const rows = await store.workspace.listPersona(agentId);
				const byName = new Map(rows.map((r) => [r.name, r] as const));
				if (!dirExists && rows.length === 0) return; // never materialised

				for (const name of PERSONA_NAMES) {
					const filePath = path.join(workspaceDir, name);
					const onDisk = existsSync(filePath);
					const inConvex = byName.get(name);
					if (onDisk) {
						const content = await fsp.readFile(filePath, "utf8");
						if (!inConvex || inConvex.content !== content) {
							await store.workspace.writePersona(agentId, name, content);
						}
					} else if (inConvex) {
						await fsp.mkdir(workspaceDir, { recursive: true });
						await fsp.writeFile(filePath, inConvex.content, "utf8");
					}
				}

				// Skills — same two-way rule, one row per workspace/skills/<name>/SKILL.md.
				try {
					const skillsDir = path.join(workspaceDir, "skills");
					const convexSkills = await store.skills.list({ workspaceDir });
					const convexByName = new Map(
						(convexSkills.records as Array<{ name?: string; frontmatter?: string; body?: string }>)
							.filter((r) => typeof r.name === "string")
							.map((r) => [r.name as string, r] as const),
					);
					const diskNames = new Set<string>();
					if (existsSync(skillsDir)) {
						for (const entry of await fsp.readdir(skillsDir, { withFileTypes: true })) {
							if (!entry.isDirectory()) continue;
							const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
							if (!existsSync(skillFile)) continue;
							diskNames.add(entry.name);
							const content = await fsp.readFile(skillFile, "utf8");
							const inConvex = convexByName.get(entry.name);
							const convexContent = inConvex
								? `${inConvex.frontmatter ?? ""}${inConvex.body ?? ""}`
								: undefined;
							if (!inConvex || convexContent !== content) {
								await store.skills.write({
									scope: "workspace",
									agentId,
									name: entry.name,
									content,
								} as never);
							}
						}
					}
					for (const [name, record] of convexByName) {
						if (diskNames.has(name)) continue;
						const skillFile = path.join(skillsDir, name, "SKILL.md");
						await fsp.mkdir(path.dirname(skillFile), { recursive: true });
						await fsp.writeFile(
							skillFile,
							`${record.frontmatter ?? ""}${record.body ?? ""}`,
							"utf8",
						);
					}
				} catch {
					// Skills mirror is best-effort — discovery still works from
					// disk; a fresh machine simply re-installs skills.
				}

				// Lifecycle marker — same two-way rule.
				const diskState = dirExists
					? await readWorkspaceState(workspaceDir)
					: { version: 1 };
				const convexState = await store.workspace.readState(agentId);
				if (diskState.bootstrapSeededAt && !convexState.bootstrapSeededAt) {
					await store.workspace.markBootstrapSeeded(agentId);
				}
				if (diskState.setupCompletedAt && !convexState.setupCompletedAt) {
					await store.workspace.markSetupCompleted(agentId);
				}
				if (!diskState.bootstrapSeededAt && convexState.bootstrapSeededAt) {
					await markBootstrapSeeded(workspaceDir);
				}
				if (!diskState.setupCompletedAt && convexState.setupCompletedAt) {
					await markSetupCompleted(workspaceDir);
				}
			} catch (err) {
				console.error(
					`brigade: workspace mirror sync failed for agent ${agentId} — ${(err as Error).message}`,
				);
			}
		}),
	);
}

/** Convex mode boot — wrong-key tripwire. The first boot with encryption
 *  enabled records the key's sha256 fingerprint in systemMeta; later boots
 *  refuse loudly on mismatch instead of corrupting writes / failing reads
 *  cryptically mid-turn. Key ROTATION goes through
 *  BRIGADE_ENCRYPTION_KEY_OLD: when the stored fingerprint matches the OLD
 *  key, the stored value updates to the new key's fingerprint. */
async function verifyEncryptionFingerprint(store: BrigadeStore): Promise<void> {
	const { encryptionStatus } = await import("./encryption.js");
	const status = encryptionStatus();
	if (!status.enabled || !status.primaryKeyFingerprint) return; // no key — nothing to pin
	try {
		const { getConvexClient } = await import("./convex/client.js");
		const { api } = await import("../../convex/_generated/api.js");
		const client = getConvexClient({});
		const stored = (await client.query(api.health.getMeta, {
			key: "encryptionFingerprint",
		})) as string | null;
		if (stored === null) {
			await client.mutation(api.health.setMeta, {
				key: "encryptionFingerprint",
				value: status.primaryKeyFingerprint,
			});
			return;
		}
		if (stored === status.primaryKeyFingerprint) return;
		// Rotation path: stored matches the OLD key → re-pin to the new one.
		if (status.hasOldKey) {
			const { createHash } = await import("node:crypto");
			const oldHex = process.env.BRIGADE_ENCRYPTION_KEY_OLD?.trim();
			if (oldHex) {
				const oldFp = createHash("sha256")
					.update(Buffer.from(oldHex, "hex"))
					.digest("hex")
					.slice(0, 8);
				if (stored === oldFp) {
					await client.mutation(api.health.setMeta, {
						key: "encryptionFingerprint",
						value: status.primaryKeyFingerprint,
					});
					return;
				}
			}
		}
		throw new Error(
			`BRIGADE_ENCRYPTION_KEY does not match the key this deployment was sealed with ` +
				`(stored fingerprint ${stored}, current ${status.primaryKeyFingerprint}). ` +
				`Use the original key, or rotate properly by setting BRIGADE_ENCRYPTION_KEY_OLD ` +
				`to the previous key alongside the new BRIGADE_ENCRYPTION_KEY.`,
		);
	} catch (err) {
		// Re-throw only the deliberate mismatch error — a transient meta
		// read failure must not block boot (the healthcheck already passed).
		if ((err as Error).message?.includes("BRIGADE_ENCRYPTION_KEY does not match")) throw err;
	}
}

/** Test-only — exercise the workspace mirror sync against a stub store. */
export async function __syncWorkspaceMirrorsForTests(
	store: BrigadeStore,
	cfg: Record<string, unknown>,
): Promise<void> {
	await syncWorkspaceMirrors(store, cfg);
}

let _configLiveUnsub: (() => void) | undefined;

/** Convex mode, long-lived processes only (the gateway): subscribe to the
 *  config live-query and re-prime the cache on every server-side change —
 *  the convex-mode equivalent of the filesystem hot-reload watcher. NOT
 *  called by short-lived CLI commands: the reactive WebSocket client would
 *  hold the process open. Idempotent; pair with
 *  `disableConfigLiveRefresh()` on shutdown. No-op in filesystem mode,
 *  where the existing fs.watch hot-reload already covers this. */
export function enableConfigLiveRefresh(): void {
	const ctx = tryGetRuntimeContext();
	if (!ctx || ctx.mode !== "convex") return;
	if (_configLiveUnsub) return; // already live
	_configLiveUnsub = ctx.store.config.subscribe((cfg) => {
		primeConfigCache(cfg);
	});
}

export function disableConfigLiveRefresh(): void {
	try {
		_configLiveUnsub?.();
	} finally {
		_configLiveUnsub = undefined;
	}
}

/** Test-only — clear the in-flight slot alongside
 *  `__resetRuntimeContextForTests()`. */
export function __resetBootForTests(): void {
	_inflight = undefined;
}
