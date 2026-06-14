import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { useConvexAuthState } from "./convex-auth-state.js";
import type { BrigadeStore } from "../../../storage/store.js";

// Verified against the REAL Baileys module — BufferJSON round-trips,
// initAuthCreds shape, and the app-state-sync-key proto re-hydration all
// run through @whiskeysockets/baileys itself, not mocks of it.

class FakeWaAuthApi {
	creds: string | null = null;
	keys = new Map<string, string>(); // `${type}:${id}` -> valueJson
	writes: Array<{ kind: "creds" | "keys"; detail: unknown }> = [];

	async loadWhatsAppAuth(): Promise<{
		creds: string | null;
		keys: Array<{ keyType: string; keyId: string; valueJson: string }>;
	}> {
		return {
			creds: this.creds,
			keys: Array.from(this.keys, ([k, valueJson]) => {
				const [keyType, ...rest] = k.split(":");
				return { keyType: keyType as string, keyId: rest.join(":"), valueJson };
			}),
		};
	}
	async writeWhatsAppCreds(_accountId: string, credsJson: string): Promise<void> {
		this.creds = credsJson;
		this.writes.push({ kind: "creds", detail: credsJson.length });
	}
	async writeWhatsAppKeys(
		_accountId: string,
		entries: Array<{ keyType: string; keyId: string; valueJson: string | null }>,
	): Promise<void> {
		for (const e of entries) {
			const k = `${e.keyType}:${e.keyId}`;
			if (e.valueJson === null) this.keys.delete(k);
			else this.keys.set(k, e.valueJson);
		}
		this.writes.push({ kind: "keys", detail: entries.map((e) => `${e.keyType}:${e.keyId}`) });
	}
	async clearWhatsAppAuth(): Promise<void> {
		this.creds = null;
		this.keys.clear();
	}
}

function makeStore(fake: FakeWaAuthApi): BrigadeStore {
	return { mode: "convex", channels: fake } as unknown as BrigadeStore;
}

async function loadBaileys() {
	const baileys = await import("@whiskeysockets/baileys");
	return {
		initAuthCreds: baileys.initAuthCreds as never,
		BufferJSON: baileys.BufferJSON as never,
		proto: baileys.proto as never,
	};
}

describe("useConvexAuthState (against real Baileys)", () => {
	afterEach(() => {
		// No module-level state to reset — each call owns its caches.
	});

	it("fresh account initialises creds via initAuthCreds and persists them", async () => {
		const fake = new FakeWaAuthApi();
		const auth = await useConvexAuthState(makeStore(fake), "default", await loadBaileys());

		// initAuthCreds shape: noiseKey + signedIdentityKey keypairs exist.
		const creds = auth.state.creds as {
			noiseKey?: { private?: Uint8Array; public?: Uint8Array };
			registrationId?: number;
		};
		assert.ok(creds.noiseKey?.private instanceof Uint8Array);
		assert.ok(typeof creds.registrationId === "number");

		await auth.saveCreds();
		assert.ok(fake.creds && fake.creds.length > 0, "creds persisted");
	});

	it("creds round-trip through BufferJSON — Buffers survive", async () => {
		const fake = new FakeWaAuthApi();
		const first = await useConvexAuthState(makeStore(fake), "default", await loadBaileys());
		const originalNoisePublic = (first.state.creds as { noiseKey: { public: Uint8Array } })
			.noiseKey.public;
		await first.saveCreds();

		// Second boot loads the persisted creds.
		const second = await useConvexAuthState(makeStore(fake), "default", await loadBaileys());
		const reloadedNoisePublic = (second.state.creds as { noiseKey: { public: Uint8Array } })
			.noiseKey.public;
		assert.ok(reloadedNoisePublic instanceof Uint8Array, "Buffer revived, not base64 string");
		assert.deepEqual(
			Buffer.from(reloadedNoisePublic),
			Buffer.from(originalNoisePublic),
			"key bytes identical across reload",
		);
	});

	it("keys.set → keys.get round-trip; null deletes; flush batches to the store", async () => {
		const fake = new FakeWaAuthApi();
		const auth = await useConvexAuthState(makeStore(fake), "default", await loadBaileys());

		const keyBytes = new Uint8Array([1, 2, 3, 4]);
		await auth.state.keys.set({
			"pre-key": { "1": { private: keyBytes, public: keyBytes } },
			session: { "917702616808.0": { fake: "session-blob" } },
		});

		const got = await auth.state.keys.get("pre-key", ["1", "999"]);
		assert.ok(got["1"], "stored key readable");
		assert.equal(got["999"], null, "missing key reads as null (reference parity)");

		await auth.flush();
		assert.ok(fake.keys.has("pre-key:1"));
		assert.ok(fake.keys.has("session:917702616808.0"));

		// Delete via null — reference removeData parity.
		await auth.state.keys.set({ "pre-key": { "1": null } });
		await auth.flush();
		assert.equal(fake.keys.has("pre-key:1"), false);
		const afterDelete = await auth.state.keys.get("pre-key", ["1"]);
		assert.equal(afterDelete["1"], null);
	});

	it("app-state-sync-key values re-hydrate through the proto factory (reference parity)", async () => {
		const fake = new FakeWaAuthApi();
		const baileys = await loadBaileys();
		const auth = await useConvexAuthState(makeStore(fake), "default", baileys);

		await auth.state.keys.set({
			"app-state-sync-key": {
				"AAAAAA==": { keyData: new Uint8Array([9, 9, 9]), timestamp: 123 },
			},
		});
		const got = await auth.state.keys.get("app-state-sync-key", ["AAAAAA=="]);
		const value = got["AAAAAA=="] as { keyData?: unknown } | null;
		assert.ok(value, "value present");
		// proto.fromObject output is a proto message instance, not the raw map.
		assert.ok(
			typeof (value as { constructor?: { name?: string } }).constructor?.name === "string",
		);
	});

	it("second boot pre-hydrates the keystore from the store (one query, no per-key reads)", async () => {
		const fake = new FakeWaAuthApi();
		const baileys = await loadBaileys();
		const first = await useConvexAuthState(makeStore(fake), "default", baileys);
		await first.state.keys.set({ session: { peer1: { blob: 42 } } });
		await first.flush();

		const second = await useConvexAuthState(makeStore(fake), "default", baileys);
		const got = await second.state.keys.get("session", ["peer1"]);
		assert.deepEqual(got["peer1"], { blob: 42 });
	});
});
