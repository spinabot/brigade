// src/storage/convex/auth-store.ts
//
// ConvexAuthStore — convex-mode adapter for authProfiles + profileState.
//
// Encryption is the load-bearing concern here. Each AuthProfile carries a
// literal `key` / `token` / `access` / `refresh` value at the interface
// boundary, but the schema columns are `keyEnc` / `tokenEnc` / etc — raw
// bytes. The DEK wrap/unwrap is implemented in a follow-up PR that adds
// the `brigadeKmsDekRegistry` table + libsodium seal/open helpers. PR16
// SHIPS WITHOUT ENCRYPTION — values land in the byte columns unencrypted
// (so the schema's typed contract is satisfied). The follow-up swaps the
// bytes for ciphertext with no interface change.
//
// Sync `getCachedCredentialSnapshot` — Pi SDK's `AuthStorage.inMemory()`
// expects a synchronous snapshot at gateway boot. Convex reads are async
// RPC, so this method returns the snapshot from a process-local cache
// that's hydrated by `init(agentId)`. If `init` hasn't run, returns
// `undefined` and the caller must wait for `buildCredentialMap` instead.

import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { NotImplementedYet } from "../store.js";
import type {
	AuthProfile,
	AuthStore,
	Encrypted,
	ProfileStateSnapshot,
	RetryReason,
} from "../store.js";

interface Deps {
	client: ConvexHttpClient;
	ownerId: string;
}

// AT-REST ENCRYPTION — when BRIGADE_ENCRYPTION_KEY is set, every value going
// into a `*Enc` column gets AES-256-GCM sealed. Read path decrypts
// transparently. When the key is absent, payloads pass through as plain
// bytes (no behaviour change). See [encryption.ts](../encryption.ts).
import { open, openJson, sealJson, sealString } from "../encryption.js";

// AAD binds each secret to its column — a row copied into a different
// column/table fails to decrypt even with the right key (GCM-native).
function plaintextToBytes(value: string | undefined, field?: string): ArrayBuffer | undefined {
	if (value === undefined || value === "") return undefined;
	return sealString(value, field ? `authProfiles|${field}` : undefined);
}

function bytesToPlaintext(
	value: ArrayBuffer | undefined | null,
	field?: string,
): string | undefined {
	if (!value) return undefined;
	try {
		return open(value, field ? `authProfiles|${field}` : undefined).toString("utf8");
	} catch {
		// Pre-AAD rows (sealed before this hardening landed) open without
		// the context — try once more so older data keeps working.
		return open(value).toString("utf8");
	}
}

/** Process-local cache for the sync getCachedCredentialSnapshot path. */
const credentialCache = new Map<string, Record<string, { type: "api_key"; key: string }>>();

function cacheKey(ownerId: string, agentId: string): string {
	return `${ownerId}::${agentId}`;
}

export class ConvexAuthStore implements AuthStore {
	constructor(private readonly deps: Deps) {}

	async init(agentId: string): Promise<void> {
		// Hydrate the sync snapshot so Pi SDK's AuthStorage.inMemory() boot
		// path can read it without an async RPC.
		const snap = await this._buildSnapshot(agentId);
		credentialCache.set(cacheKey(this.deps.ownerId, agentId), snap);
	}

	async listProfiles(agentId: string): Promise<AuthProfile[]> {
		const rows = (await this.deps.client.query(api.auth.listProfiles, {
			ownerId: this.deps.ownerId,
			agentId,
		})) as Array<Record<string, unknown>>;
		return rows.map((row) => this._rowToProfile(row));
	}

	async getProfile(agentId: string, profileId: string): Promise<AuthProfile | null> {
		const row = (await this.deps.client.query(api.auth.getProfile, {
			ownerId: this.deps.ownerId,
			agentId,
			profileId,
		})) as Record<string, unknown> | null;
		return row ? this._rowToProfile(row) : null;
	}

	async upsertProfile(
		agentId: string,
		profile: Encrypted<AuthProfile>,
	): Promise<string> {
		const p = profile as unknown as {
			profileId?: string;
			provider?: string;
			alias?: string;
			type?: "api_key" | "oauth" | "token";
			key?: string;
			keyRef?: { source: string; provider: string; id: string };
			token?: string;
			tokenRef?: { source: string; provider: string; id: string };
			access?: string;
			refresh?: string;
			expires?: number;
			metadata?: Record<string, unknown>;
		};
		const provider = p.provider;
		if (typeof provider !== "string" || provider.length === 0) {
			throw new Error("ConvexAuthStore.upsertProfile: profile.provider is required");
		}
		const profileId = p.profileId ?? `${provider}:${p.alias ?? "default"}`;
		await this.deps.client.mutation(api.auth.upsertProfile, {
			ownerId: this.deps.ownerId,
			agentId,
			profileId,
			provider,
			...(p.alias !== undefined ? { alias: p.alias } : {}),
			type: p.type ?? "api_key",
			...(plaintextToBytes(p.key, "keyEnc") !== undefined
				? { keyEnc: plaintextToBytes(p.key, "keyEnc") }
				: {}),
			...(p.keyRef !== undefined ? { keyRef: p.keyRef } : {}),
			...(plaintextToBytes(p.token, "tokenEnc") !== undefined
				? { tokenEnc: plaintextToBytes(p.token, "tokenEnc") }
				: {}),
			...(p.tokenRef !== undefined ? { tokenRef: p.tokenRef } : {}),
			...(plaintextToBytes(p.access, "accessEnc") !== undefined
				? { accessEnc: plaintextToBytes(p.access, "accessEnc") }
				: {}),
			...(plaintextToBytes(p.refresh, "refreshEnc") !== undefined
				? { refreshEnc: plaintextToBytes(p.refresh, "refreshEnc") }
				: {}),
			...(p.expires !== undefined ? { expires: p.expires } : {}),
			...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
		});
		// Refresh the sync cache so Pi sees the new credential immediately.
		credentialCache.set(
			cacheKey(this.deps.ownerId, agentId),
			await this._buildSnapshot(agentId),
		);
		return profileId;
	}

	async deleteProfile(agentId: string, profileId: string): Promise<void> {
		await this.deps.client.mutation(api.auth.deleteProfile, {
			ownerId: this.deps.ownerId,
			agentId,
			profileId,
		});
		credentialCache.set(
			cacheKey(this.deps.ownerId, agentId),
			await this._buildSnapshot(agentId),
		);
	}

	async buildCredentialMap(
		agentId: string,
		_opts?: { provider?: string; modelId?: string; cooldownState?: ProfileStateSnapshot },
	): Promise<{
		credentials: Record<string, { type: "api_key"; key: string }>;
		selectedProfileId?: string;
	}> {
		const credentials = await this._buildSnapshot(agentId);
		credentialCache.set(cacheKey(this.deps.ownerId, agentId), credentials);
		return { credentials };
	}

	getCachedCredentialSnapshot(
		agentId: string,
	): { credentials: Record<string, { type: "api_key"; key: string }> } | undefined {
		const cached = credentialCache.get(cacheKey(this.deps.ownerId, agentId));
		return cached ? { credentials: cached } : undefined;
	}

	async loadProfileState(agentId: string): Promise<ProfileStateSnapshot> {
		const rows = (await this.deps.client.query(api.auth.loadState, {
			ownerId: this.deps.ownerId,
			agentId,
		})) as Array<Record<string, unknown>>;
		// Reshape into the same `ProfileStateFile` shape filesystem mode
		// returns — `{ version: 1, usageStats: Record<profileId, stats> }`.
		const usageStats: Record<string, Record<string, unknown>> = {};
		const order: Record<string, string[]> = {};
		const lastGood: Record<string, string> = {};
		for (const row of rows) {
			const profileId = row.profileId as string;
			usageStats[profileId] = {
				...(row.lastUsed !== undefined ? { lastUsed: row.lastUsed } : {}),
				...(row.cooldownUntil !== undefined ? { cooldownUntil: row.cooldownUntil } : {}),
				...(row.cooldownReason !== undefined ? { cooldownReason: row.cooldownReason } : {}),
				...(row.cooldownModel !== undefined ? { cooldownModel: row.cooldownModel } : {}),
				...(row.disabledUntil !== undefined ? { disabledUntil: row.disabledUntil } : {}),
				...(row.disabledReason !== undefined ? { disabledReason: row.disabledReason } : {}),
				...(row.errorCount !== undefined ? { errorCount: row.errorCount } : {}),
				...(row.failureCounts !== undefined ? { failureCounts: row.failureCounts } : {}),
				...(row.lastFailureAt !== undefined ? { lastFailureAt: row.lastFailureAt } : {}),
			};
			if (row.isLastGood) {
				const provider = row.provider as string;
				lastGood[provider] = profileId;
			}
		}
		return { version: 1, usageStats, order, lastGood } as unknown as ProfileStateSnapshot;
	}

	async recordSuccess(args: {
		agentId: string;
		profileId: string;
		provider: string;
	}): Promise<ProfileStateSnapshot> {
		await this.deps.client.mutation(api.auth.upsertState, {
			ownerId: this.deps.ownerId,
			agentId: args.agentId,
			profileId: args.profileId,
			provider: args.provider,
			lastUsed: Date.now(),
			isLastGood: true,
		});
		return this.loadProfileState(args.agentId);
	}

	async recordFailure(args: {
		agentId: string;
		profileId: string;
		reason: RetryReason;
		modelId?: string;
	}): Promise<ProfileStateSnapshot> {
		// Convex-mode failure recording — PR16 is a thin wrapper. Cooldown
		// ladder calculations + per-reason tier mapping land in the
		// follow-up that ports `markProfileFailure` (the heavy filesystem
		// logic) into a Convex-side helper.
		await this.deps.client.mutation(api.auth.upsertState, {
			ownerId: this.deps.ownerId,
			agentId: args.agentId,
			profileId: args.profileId,
			provider: "unknown",
			lastFailureAt: Date.now(),
			cooldownReason: args.reason,
			...(args.modelId !== undefined ? { cooldownModel: args.modelId } : {}),
			isLastGood: false,
		});
		return this.loadProfileState(args.agentId);
	}

	async setExplicitOrder(agentId: string, provider: string, order: string[]): Promise<void> {
		// The failover order array lives VERBATIM inside the auth-state blob —
		// read-modify-write it there. (The per-row `explicitOrder` rank column
		// could not represent a per-provider array; this closes that gap.)
		const current = (await this.readAuthFileBlob(agentId, "auth-state")) ?? {
			version: 1,
			order: {},
			lastGood: {},
			usageStats: {},
		};
		const orderMap = (current.order as Record<string, string[]> | undefined) ?? {};
		orderMap[provider] = [...order];
		current.order = orderMap;
		await this.writeAuthFileBlob(agentId, "auth-state", current);
	}

	async withProfileLock<T>(_agentId: string, fn: () => Promise<T>): Promise<T> {
		// Convex transactions are linearised by the backend — no in-process
		// lock needed. Filesystem mode uses an explicit FIFO mutex; convex
		// mode achieves the same property via the mutation's OCC.
		return fn();
	}

	async readAuthFileBlob(
		agentId: string,
		kind: "auth-state" | "profile-state" | "models",
	): Promise<Record<string, unknown> | undefined> {
		const row = (await this.deps.client.query(api.auth.readAuthFile, {
			ownerId: this.deps.ownerId,
			agentId,
			kind,
		})) as { payload?: ArrayBuffer } | null;
		if (!row?.payload) return undefined;
		return openJson<Record<string, unknown>>(row.payload);
	}

	async writeAuthFileBlob(
		agentId: string,
		kind: "auth-state" | "profile-state" | "models",
		payload: Record<string, unknown>,
	): Promise<void> {
		await this.deps.client.mutation(api.auth.writeAuthFile, {
			ownerId: this.deps.ownerId,
			agentId,
			kind,
			payload: sealJson(payload),
		});
	}

	// =================================================================
	// Internals
	// =================================================================

	private _rowToProfile(row: Record<string, unknown>): AuthProfile {
		const out: Record<string, unknown> = {
			profileId: row.profileId,
			provider: row.provider,
			type: row.type,
		};
		if (row.alias !== undefined) out.alias = row.alias;
		const keyPlain = bytesToPlaintext(row.keyEnc as ArrayBuffer | undefined, "keyEnc");
		if (keyPlain !== undefined) out.key = keyPlain;
		if (row.keyRef !== undefined) out.keyRef = row.keyRef;
		const tokenPlain = bytesToPlaintext(row.tokenEnc as ArrayBuffer | undefined, "tokenEnc");
		if (tokenPlain !== undefined) out.token = tokenPlain;
		if (row.tokenRef !== undefined) out.tokenRef = row.tokenRef;
		const accessPlain = bytesToPlaintext(row.accessEnc as ArrayBuffer | undefined, "accessEnc");
		if (accessPlain !== undefined) out.access = accessPlain;
		const refreshPlain = bytesToPlaintext(row.refreshEnc as ArrayBuffer | undefined, "refreshEnc");
		if (refreshPlain !== undefined) out.refresh = refreshPlain;
		if (row.expires !== undefined) out.expires = row.expires;
		if (row.metadata !== undefined) out.metadata = row.metadata;
		return out as unknown as AuthProfile;
	}

	private async _buildSnapshot(
		agentId: string,
	): Promise<Record<string, { type: "api_key"; key: string }>> {
		const profiles = await this.listProfiles(agentId);
		const out: Record<string, { type: "api_key"; key: string }> = {};
		for (const profile of profiles) {
			const p = profile as unknown as {
				provider?: string;
				type?: string;
				key?: string;
				keyRef?: { source?: string; id?: string };
			};
			if (p.type !== "api_key") continue;
			if (typeof p.key === "string" && p.key.length > 0) {
				if (out[p.provider!] === undefined) {
					out[p.provider!] = { type: "api_key", key: p.key };
				}
				continue;
			}
			if (p.keyRef?.source === "env" && p.keyRef.id) {
				const envValue = process.env[p.keyRef.id];
				if (envValue) {
					if (out[p.provider!] === undefined) {
						out[p.provider!] = { type: "api_key", key: envValue };
					}
				}
			}
		}
		return out;
	}
}
