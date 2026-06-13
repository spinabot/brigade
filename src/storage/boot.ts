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
				// Stale-bundle gate FIRST: a backend serving an older function
				// push must fail boot with one clear operator action, not limp
				// through hydration with per-domain "Could not find public
				// function" spam + broken transcript flushes every turn.
				await verifyConvexBundleVersion();
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
				// The boot reconcile above is point-in-time; the live mirror
				// watches each agent's workspace for persona edits mid-session
				// and pushes them as they happen, so a `rm -rf ~/.brigade`
				// no longer loses everything written since the last boot.
				// Lifecycle stamps + manage_skill writes ride the same chain.
				const { startWorkspaceLiveMirror } = await import("./workspace-live-mirror.js");
				startWorkspaceLiveMirror(ctx.store, cfg as Record<string, unknown>);
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

				// Read lifecycle state up-front: BOOTSTRAP.md is CONSUMED (deleted
				// from disk) once first-run setup completes. Without this guard the
				// restore-on-missing branch below would resurrect the first-run
				// script on every boot — and the delete-propagation cleans the
				// stale convex row so a fresh machine never restores it either.
				const diskState = dirExists
					? await readWorkspaceState(workspaceDir)
					: { version: 1 };
				const convexState = await store.workspace.readState(agentId);
				const bootstrapConsumed = Boolean(
					(diskState as { setupCompletedAt?: string }).setupCompletedAt ||
						convexState.setupCompletedAt,
				);

				for (const name of PERSONA_NAMES) {
					const filePath = path.join(workspaceDir, name);
					const onDisk = existsSync(filePath);
					const inConvex = byName.get(name);
					// Consumed BOOTSTRAP.md: never restore it, and reap the stale
					// mirror row so restore-on-missing can't bring it back later.
					if (name === "BOOTSTRAP.md" && bootstrapConsumed) {
						if (inConvex && !onDisk) {
							await store.workspace.deletePersona(agentId, name);
						}
						continue;
					}
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
					const { skillContentFromParts } = await import("./convex/skill-store.js");
					const skillsDir = path.join(workspaceDir, "skills");
					// Scope to THIS agent's WORKSPACE skills only — without the
					// scope every agent's skills would bleed into every workspace.
					const convexSkills = await store.skills.list({
						workspaceDir,
						agentId,
						source: "workspace",
					});
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
							// Reconstruct with `---` fences so the compare matches the
							// on-disk shape (no fences → churn + malformed restores).
							const convexContent = inConvex
								? skillContentFromParts(inConvex.frontmatter, inConvex.body)
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
							skillContentFromParts(record.frontmatter, record.body),
							"utf8",
						);
					}
				} catch {
					// Skills mirror is best-effort — discovery still works from
					// disk; a fresh machine simply re-installs skills.
				}

				// Lifecycle marker — same two-way rule. (diskState + convexState
				// were read up-front for the BOOTSTRAP consumed-guard.)
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
/** Twin of `BUNDLE_VERSION` in convex/health.ts — bump BOTH together
 *  whenever convex/ functions or the schema change shape. */
const EXPECTED_CONVEX_BUNDLE_VERSION = 6;

function buildStaleBundleError(remote: string): Error {
	return Object.assign(
		new Error(
			`The Convex backend is running an OLDER Brigade function bundle ` +
				`(backend: ${remote}, this build needs: v${EXPECTED_CONVEX_BUNDLE_VERSION}).\n` +
				`  Push the current functions, then retry:\n` +
				`    npm run convex:push\n` +
				`  (restarting \`npm run convex:dev\` also pushes automatically at startup)`,
		),
		{ brigadeStaleBundle: true as const },
	);
}

/** Refuse to boot against a backend whose deployed function bundle is older
 *  than this build expects. Nothing used to push functions automatically, so
 *  the deployed bundle silently drifted from the code — every NEW function
 *  then failed at runtime with "Could not find public function" while the
 *  gateway limped along half-broken. One deterministic check → one clear fix.
 *  Transient/network failures never block boot (the store's init()
 *  healthcheck already proved the backend reachable). */
async function verifyConvexBundleVersion(): Promise<void> {
	let staleErr: Error | undefined;
	try {
		const { getConvexClient } = await import("./convex/client.js");
		const { api } = await import("../../convex/_generated/api.js");
		const client = getConvexClient({});
		const remote = (await client.query(api.health.bundleVersion, {})) as number;
		if (typeof remote === "number" && remote >= EXPECTED_CONVEX_BUNDLE_VERSION) return;
		staleErr = buildStaleBundleError(`v${String(remote)}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// A reachable backend that doesn't know the function = pre-versioning
		// (stale) bundle. Anything else is transient — don't block boot.
		if (msg.includes("Could not find public function")) {
			staleErr = buildStaleBundleError("pre-versioning push");
		}
	}
	if (staleErr) throw staleErr;
}

async function verifyEncryptionFingerprint(store: BrigadeStore): Promise<void> {
	const { encryptionStatus } = await import("./encryption.js");
	const status = encryptionStatus();
	if (!status.enabled || !status.primaryKeyFingerprint) {
		// Convex mode with NO active encryption key: seal() degrades to a
		// plaintext pass-through, so provider keys + other secrets would be
		// written UNSEALED to the backend. The happy path always has a key
		// (onboard / `store mode set convex` mint one), so reaching here means
		// the key file was deleted or BRIGADE_ENCRYPTION_KEY is unset. Warn
		// LOUDLY so the operator restores the key before saving credentials. (A
		// hard boot-refuse is the stronger guard but risks bricking a
		// recoverable install — flagged as a follow-up.)
		console.error(
			"brigade: WARNING — convex mode is active but NO at-rest encryption key is " +
				"loaded. Provider keys and other secrets will be stored UNSEALED in the backend. " +
				"Set BRIGADE_ENCRYPTION_KEY to your recovery key (or restore the key file) before " +
				"saving credentials.",
		);
		return; // no key — nothing to pin
	}
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
		// Tag the deliberate mismatch so the catch below re-throws it without
		// substring-matching the human-facing message. The previous guard
		// matched "BRIGADE_ENCRYPTION_KEY does not match" — a string this error
		// never contains — so the tripwire was DEAD: a wrong key was swallowed
		// and boot proceeded, the exact corrupt-on-write scenario it guards.
		throw Object.assign(
			new Error(
				`This backend holds Brigade data protected by a DIFFERENT encryption key.\n` +
					`  Your options:\n` +
					`    • Provide the original key — set BRIGADE_ENCRYPTION_KEY to the recovery\n` +
					`      key you saved when this Brigade was created (or restore its key file).\n` +
					`    • Rotating on purpose? Set BRIGADE_ENCRYPTION_KEY_OLD to the previous\n` +
					`      key alongside the new BRIGADE_ENCRYPTION_KEY.\n` +
					`    • Start over — \`brigade store reset\` permanently erases the backend\n` +
					`      so you can onboard fresh.\n` +
					`  (key fingerprints: stored ${stored}, current ${status.primaryKeyFingerprint}; ` +
					`active key source: ${status.source})`,
			),
			{ brigadeKeyMismatch: true as const },
		);
	} catch (err) {
		// Re-throw only the deliberate key-mismatch error (tagged above) — a
		// transient meta read failure must not block boot (the healthcheck
		// already passed). Tag check, not substring match, so the message can
		// change freely without silently disarming the tripwire again.
		if ((err as { brigadeKeyMismatch?: boolean }).brigadeKeyMismatch) throw err;
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
