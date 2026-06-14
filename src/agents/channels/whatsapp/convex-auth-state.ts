// src/agents/channels/whatsapp/convex-auth-state.ts
//
// useConvexAuthState — the convex-mode replacement for Baileys'
// useMultiFileAuthState. Returns the exact `{ state: { creds, keys },
// saveCreds }` shape and mirrors the reference implementation
// (node_modules/@whiskeysockets/baileys/lib/Utils/use-multi-file-auth-state.js)
// semantic-for-semantic:
//
//   • creds: loaded blob or `initAuthCreds()` for a fresh account
//   • keys.get: served from the in-process cache (pre-hydrated in one
//     query at connect — Baileys awaits get() inside the Signal decrypt
//     path, so a network round-trip per key would wreck handshakes);
//     app-state-sync-key values re-hydrate through the proto factory
//     exactly like the reference
//   • keys.set: cache write-through + write-behind flush to the
//     whatsappAuthKeys table (value=null deletes, like the reference's
//     removeData); Baileys' own addTransactionCapability already batches
//     sets inside transactions, so flushes carry whole SignalDataSets
//   • saveCreds: serialises the live creds object (BufferJSON) and chains
//     the blob write
//
// Serialisation matches the reference byte-for-byte: BufferJSON
// replacer/reviver. Sealing happens in the ChannelStore adapter — key
// material never leaves the process unencrypted when the operator key is
// set. Oversized values (LTHashState) spill to File Storage inside the
// adapter, invisible here.

import type { BrigadeStore } from "../../../storage/store.js";

interface BaileysAuthModule {
	initAuthCreds: () => Record<string, unknown>;
	BufferJSON: {
		replacer: (k: string, value: unknown) => unknown;
		reviver: (k: string, value: unknown) => unknown;
	};
	proto: {
		Message: {
			AppStateSyncKeyData: { fromObject: (o: unknown) => unknown };
		};
	};
}

export interface ConvexAuthState {
	state: {
		creds: Record<string, unknown>;
		keys: {
			get: (type: string, ids: string[]) => Promise<Record<string, unknown>>;
			set: (data: Record<string, Record<string, unknown | null>>) => Promise<void>;
		};
	};
	saveCreds: () => Promise<void>;
	/** Resolves when every auth write enqueued so far reached the backend. */
	flush: () => Promise<void>;
}

const FLUSH_DELAY_MS = 400;
const FLUSH_MAX_PENDING = 64;

// LID → phone reverse lookup (`lid-mapping` keyType, `<lid>_reverse` ids).
// Baileys writes these through keys.set like every other key; connection.ts
// needs a SYNC read for inbound sender resolution, so the auth-state keeps
// this module-level mirror current (populated at load + on every set).
const lidReverseMirror = new Map<string, string>(); // `${accountId}|${lid}` -> phone digits

function mirrorLidEntry(accountId: string, keyId: string, value: unknown): void {
	if (!keyId.endsWith("_reverse")) return;
	const lid = keyId.slice(0, -"_reverse".length);
	if (value === null || value === undefined) {
		lidReverseMirror.delete(`${accountId}|${lid}`);
		return;
	}
	// The reverse-mapping value is the phone digits — historically either a
	// bare string or an object carrying it; normalise to digits.
	const raw =
		typeof value === "string"
			? value
			: typeof (value as { phoneNumber?: unknown }).phoneNumber === "string"
				? ((value as { phoneNumber: string }).phoneNumber as string)
				: JSON.stringify(value);
	const digits = raw.replace(/\D/g, "");
	if (digits.length >= 7) lidReverseMirror.set(`${accountId}|${lid}`, digits);
}

/** Sync LID → phone lookup for convex mode (connection.ts inbound path). */
export function lookupLidReverseSync(accountId: string, lidDigits: string): string | null {
	return lidReverseMirror.get(`${accountId}|${lidDigits}`) ?? null;
}

/** Test-only. */
export function __resetLidMirrorForTests(): void {
	lidReverseMirror.clear();
}

export async function useConvexAuthState(
	store: BrigadeStore,
	accountId: string,
	baileys: BaileysAuthModule,
): Promise<ConvexAuthState> {
	const { initAuthCreds, BufferJSON, proto } = baileys;

	// One query pre-hydrates the whole keystore + creds.
	const loaded = await store.channels.loadWhatsAppAuth(accountId);
	const creds: Record<string, unknown> = loaded.creds
		? (JSON.parse(loaded.creds, BufferJSON.reviver) as Record<string, unknown>)
		: initAuthCreds();

	const cache = new Map<string, unknown>();
	for (const k of loaded.keys) {
		try {
			const value = JSON.parse(k.valueJson, BufferJSON.reviver);
			cache.set(`${k.keyType}:${k.keyId}`, value);
			if (k.keyType === "lid-mapping") mirrorLidEntry(accountId, k.keyId, value);
		} catch {
			// One undecodable key (rotated-away seal, corrupt row) must not
			// poison the whole keystore — skip it; Baileys treats a missing
			// key as absent and re-establishes the session.
		}
	}

	// Write-behind queue. `${type}:${id}` → serialised value or null
	// (delete). Later writes to the same key coalesce.
	const pending = new Map<string, { keyType: string; keyId: string; valueJson: string | null }>();
	let flushChain: Promise<void> = Promise.resolve();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	const flushNow = (): Promise<void> => {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (pending.size === 0) return flushChain;
		const entries = Array.from(pending.values());
		pending.clear();
		flushChain = flushChain
			.then(() => store.channels.writeWhatsAppKeys(accountId, entries))
			.catch((err) => {
				console.error(
					`brigade: whatsapp auth key flush to convex failed (account ${accountId}) — ${(err as Error).message}`,
				);
			});
		return flushChain;
	};

	const scheduleFlush = (): void => {
		if (pending.size >= FLUSH_MAX_PENDING) {
			void flushNow();
			return;
		}
		if (flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			void flushNow();
		}, FLUSH_DELAY_MS);
		flushTimer.unref?.();
	};

	return {
		state: {
			creds,
			keys: {
				get: async (type: string, ids: string[]) => {
					const data: Record<string, unknown> = {};
					for (const id of ids) {
						let value = cache.get(`${type}:${id}`);
						if (type === "app-state-sync-key" && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(value);
						}
						data[id] = value ?? null;
					}
					return data;
				},
				set: async (data: Record<string, Record<string, unknown | null>>) => {
					for (const category in data) {
						for (const id in data[category]) {
							const value = data[category][id];
							const cacheKey = `${category}:${id}`;
							if (category === "lid-mapping") mirrorLidEntry(accountId, id, value);
							if (value === null || value === undefined) {
								cache.delete(cacheKey);
								pending.set(cacheKey, { keyType: category, keyId: id, valueJson: null });
							} else {
								cache.set(cacheKey, value);
								pending.set(cacheKey, {
									keyType: category,
									keyId: id,
									valueJson: JSON.stringify(value, BufferJSON.replacer),
								});
							}
						}
					}
					scheduleFlush();
				},
			},
		},
		saveCreds: async () => {
			const serialised = JSON.stringify(creds, BufferJSON.replacer);
			flushChain = flushChain
				.then(() => store.channels.writeWhatsAppCreds(accountId, serialised))
				.catch((err) => {
					console.error(
						`brigade: whatsapp creds flush to convex failed (account ${accountId}) — ${(err as Error).message}`,
					);
				});
			await flushChain;
		},
		flush: flushNow,
	};
}
