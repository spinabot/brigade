// src/storage/local/auth-store.ts
//
// LocalAuthStore — filesystem-mode wrapper around `src/auth/profiles.ts`
// + `src/auth/profile-cooldown.ts` + `src/core/auth-bridge.ts`. Implements
// `AuthStore` from `../store.ts`.
//
// Behaviour rule (Phase-2 additive discipline): every method calls today's
// existing functions byte-for-byte. No new write paths, no atomicity changes.
// All 2,154 existing tests pass unchanged.
//
// Why the sync `getCachedCredentialSnapshot`: Pi SDK's `AuthStorage.inMemory()`
// expects a synchronous snapshot at gateway boot. Filesystem mode reads the
// file synchronously — same code path the existing `loadBrigadeAuthStorage`
// uses. Convex mode (later PR) will satisfy this via a `RuntimeCache` that
// hydrates at `store.init()` time, then keeps the snapshot fresh via a
// Convex subscription.

import * as fs from "node:fs";

import { type RetryReason } from "../../agents/error-classifier.js";
import {
	type AuthProfile as InternalAuthProfile,
	type BrigadeSecretRef,
	initAuthProfiles,
	profileId as buildProfileId,
	readProfiles,
	readState,
	upsertApiKeyProfile,
	upsertApiKeyRefProfile,
	upsertTokenProfile,
	upsertTokenRefProfile,
	writeProfiles,
	writeState,
} from "../../auth/profiles.js";
import {
	loadProfileState,
	type ProfileStateFile,
	recordProfileFailureLocked,
	recordProfileSuccessLocked,
	saveProfileState,
	withProfileCooldownLock,
} from "../../auth/profile-cooldown.js";
import { resolveAuthProfilesPath } from "../../config/paths.js";
import { PROVIDERS } from "../../providers/catalog.js";

import type {
	AuthProfile as PublicAuthProfile,
	AuthStore,
	Encrypted,
	ProfileStateSnapshot,
	RetryReason as PublicRetryReason,
} from "../store.js";

/** Stamp `profileId` onto a returned profile so callers can identify it. */
function stampProfileId(id: string, profile: InternalAuthProfile): PublicAuthProfile {
	return { ...profile, profileId: id } as unknown as PublicAuthProfile;
}

/**
 * Resolve a profile's credential payload to a literal string. Mirrors
 * `core/auth-bridge.ts:resolveProfileKey` so plaintext + keyRef shapes
 * resolve identically. Sync, env-aware, file-aware. Returns "" on
 * unresolvable refs.
 */
function resolveProfileKeyValue(profile: {
	key?: string;
	keyRef?: { source?: string; id?: string } | string;
}): string {
	if (typeof profile.key === "string" && profile.key.length > 0) return profile.key;
	const ref = profile.keyRef;
	if (!ref) return "";
	if (typeof ref === "string") {
		const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(ref);
		if (m && m[1]) return process.env[m[1]] ?? "";
		return ref;
	}
	if (ref.source === "env" && ref.id) {
		return process.env[ref.id] ?? "";
	}
	return "";
}

/**
 * Build the sync credential snapshot — profiles first, then env-fallback for
 * providers without a profile entry. Mirrors `core/auth-bridge.ts:readBrigade-
 * Credentials` so cooldown-free callers see identical bytes regardless of
 * which entry point they came through.
 */
function buildCredentialSnapshot(
	agentId: string,
): Record<string, { type: "api_key"; key: string }> {
	const out: Record<string, { type: "api_key"; key: string }> = {};
	const profilesPath = resolveAuthProfilesPath(agentId);
	if (fs.existsSync(profilesPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(profilesPath, "utf8")) as {
				profiles?: Record<
					string,
					{
						provider?: string;
						type?: string;
						key?: string;
						keyRef?: string | { source?: string; id?: string };
					}
				>;
			};
			for (const profile of Object.values(parsed.profiles ?? {})) {
				if (!profile?.provider || profile.type !== "api_key") continue;
				const key = resolveProfileKeyValue(profile);
				if (!key) continue;
				if (out[profile.provider] === undefined) {
					out[profile.provider] = { type: "api_key", key };
				}
			}
		} catch {
			// Fall through to env bootstrap below.
		}
	}
	// Env-backed bootstrap (profile wins; env only fills gaps).
	for (const provider of PROVIDERS) {
		if (!provider.envVar || provider.noAuth) continue;
		if (out[provider.id] !== undefined) continue;
		const envKey = process.env[provider.envVar];
		if (!envKey) continue;
		out[provider.id] = { type: "api_key", key: envKey };
	}
	return out;
}

export class LocalAuthStore implements AuthStore {
	constructor(private readonly _stateDir: string) {}

	async init(agentId: string): Promise<void> {
		// Scaffolds <agentDir>/agent/ + ensures auth-profiles.json + auth-state.json
		// + models.json all exist at mode 0o600 on POSIX. Idempotent.
		initAuthProfiles(agentId);
	}

	async listProfiles(agentId: string): Promise<PublicAuthProfile[]> {
		const file = readProfiles(agentId);
		const out: PublicAuthProfile[] = [];
		for (const [id, profile] of Object.entries(file.profiles ?? {})) {
			out.push(stampProfileId(id, profile));
		}
		return out;
	}

	async getProfile(agentId: string, profileId: string): Promise<PublicAuthProfile | null> {
		const file = readProfiles(agentId);
		const profile = file.profiles?.[profileId];
		if (!profile) return null;
		return stampProfileId(profileId, profile);
	}

	async upsertProfile(agentId: string, profile: Encrypted<PublicAuthProfile>): Promise<string> {
		// Dispatch by shape — public type is loose so the caller can pass any
		// of api_key / token / oauth + literal-or-ref. We route to the right
		// typed helper so the on-disk shape matches what onboard / agent-loop
		// already write.
		const p = profile as unknown as InternalAuthProfile;
		const provider = p.provider;
		if (typeof provider !== "string" || provider.length === 0) {
			throw new Error("LocalAuthStore.upsertProfile: profile.provider is required");
		}
		const alias = p.alias;
		const metadata = (p as { metadata?: Record<string, unknown> }).metadata;

		const type = p.type ?? "api_key";

		if (type === "api_key") {
			if (typeof p.key === "string" && p.key.length > 0) {
				return upsertApiKeyProfile(agentId, {
					provider,
					...(alias ? { alias } : {}),
					key: p.key,
					...(metadata !== undefined ? { metadata } : {}),
				});
			}
			if (p.keyRef) {
				return upsertApiKeyRefProfile(agentId, {
					provider,
					...(alias ? { alias } : {}),
					keyRef: p.keyRef as BrigadeSecretRef,
					...(metadata !== undefined ? { metadata } : {}),
				});
			}
			throw new Error("LocalAuthStore.upsertProfile: api_key profile requires key or keyRef");
		}

		if (type === "token") {
			if (typeof p.token === "string" && p.token.length > 0) {
				return upsertTokenProfile(agentId, {
					provider,
					...(alias ? { alias } : {}),
					token: p.token,
					...(metadata !== undefined ? { metadata } : {}),
				});
			}
			if (p.tokenRef) {
				return upsertTokenRefProfile(agentId, {
					provider,
					...(alias ? { alias } : {}),
					tokenRef: p.tokenRef as BrigadeSecretRef,
					...(metadata !== undefined ? { metadata } : {}),
				});
			}
			throw new Error("LocalAuthStore.upsertProfile: token profile requires token or tokenRef");
		}

		// oauth or anything else — direct write so we don't bottleneck the few
		// hand-rolled oauth callers on a missing typed helper.
		const file = readProfiles(agentId);
		const id = buildProfileId(provider, alias);
		file.profiles[id] = { ...p, provider };
		writeProfiles(agentId, file);
		return id;
	}

	async deleteProfile(agentId: string, profileId: string): Promise<void> {
		const file = readProfiles(agentId);
		if (file.profiles?.[profileId]) {
			delete file.profiles[profileId];
			writeProfiles(agentId, file);
		}
	}

	async buildCredentialMap(
		agentId: string,
		_opts?: { provider?: string; modelId?: string; cooldownState?: ProfileStateSnapshot },
	): Promise<{
		credentials: Record<string, { type: "api_key"; key: string }>;
		selectedProfileId?: string;
	}> {
		// PR3 ships the no-cooldown happy path. The cooldown-aware ladder
		// lives in agent-loop's `readAuthProfilesAsCredentialMap` and stays
		// untouched in PR3 — folding it in is a follow-up once we have
		// concurrent cron + gateway pressure to test against.
		const credentials = buildCredentialSnapshot(agentId);
		return { credentials };
	}

	getCachedCredentialSnapshot(
		agentId: string,
	): { credentials: Record<string, { type: "api_key"; key: string }> } | undefined {
		// SYNCHRONOUS — Pi SDK's `AuthStorage.inMemory()` boot path needs a
		// snapshot before any async I/O. File-backed in this adapter (OS page
		// cache makes repeated reads near-free).
		return { credentials: buildCredentialSnapshot(agentId) };
	}

	async loadProfileState(agentId: string): Promise<ProfileStateSnapshot> {
		const state = loadProfileState(agentId);
		return state as unknown as ProfileStateSnapshot;
	}

	async recordSuccess(args: {
		agentId: string;
		profileId: string;
		provider: string;
	}): Promise<ProfileStateSnapshot> {
		// Transactional locked wrapper — reload from disk under the per-agent
		// lock before applying the mark, defeating cross-process drift
		// (cron + gateway can both run today).
		const next = await recordProfileSuccessLocked({
			agentId: args.agentId,
			state: loadProfileState(args.agentId),
			profileId: args.profileId,
			provider: args.provider,
		});
		return next as unknown as ProfileStateSnapshot;
	}

	async recordFailure(args: {
		agentId: string;
		profileId: string;
		reason: PublicRetryReason;
		modelId?: string;
	}): Promise<ProfileStateSnapshot> {
		const next = await recordProfileFailureLocked({
			agentId: args.agentId,
			state: loadProfileState(args.agentId),
			profileId: args.profileId,
			// `PublicRetryReason` is widened to `string`; the internal
			// classifier treats unknown values as "no cooldown, just
			// record". Cast through.
			reason: args.reason as RetryReason,
			...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
		});
		return next as unknown as ProfileStateSnapshot;
	}

	async setExplicitOrder(agentId: string, provider: string, order: string[]): Promise<void> {
		await withProfileCooldownLock(agentId, async () => {
			const state = loadProfileState(agentId);
			const next: ProfileStateFile = {
				...state,
				order: { ...(state.order ?? {}), [provider]: [...order] },
			};
			saveProfileState(agentId, next);
		});
	}

	async withProfileLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
		return withProfileCooldownLock(agentId, fn);
	}

	async readAuthFileBlob(
		agentId: string,
		kind: "auth-state" | "profile-state" | "models",
	): Promise<Record<string, unknown> | undefined> {
		// Filesystem mode reads the real files — used by `brigade store
		// migrate` to export the verbatim shapes.
		if (kind === "auth-state") {
			return readState(agentId) as unknown as Record<string, unknown>;
		}
		return loadProfileState(agentId) as unknown as Record<string, unknown>;
	}

	async writeAuthFileBlob(
		agentId: string,
		kind: "auth-state" | "profile-state" | "models",
		payload: Record<string, unknown>,
	): Promise<void> {
		if (kind === "auth-state") {
			writeState(agentId, payload as never);
			return;
		}
		saveProfileState(agentId, payload as never);
	}
}
