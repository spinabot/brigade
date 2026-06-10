// src/storage/encryption.ts
//
// Brigade at-rest encryption. The operator supplies a 32-byte master key
// via `BRIGADE_ENCRYPTION_KEY` (hex-encoded, 64 chars). When set, every
// Convex byte column the storage layer writes goes through this module's
// `seal` first; reads run through `open`. The Convex backend never sees
// plaintext.
//
// Format (binary, written into Convex `Enc()` byte columns):
//
//   [0]      magic byte = 0x42 ('B' for Brigade)
//   [1]      version = 0x01
//   [2..14)  12-byte nonce (random per write)
//   [14..30) 16-byte GCM auth tag
//   [30..]   ciphertext
//
// When the magic byte is absent, the value is treated as plaintext bytes —
// this preserves the old un-encrypted shape and lets a key be turned on
// later without a flag day. Reads decrypt sealed values automatically; if
// the key is missing or wrong, decryption fails closed (throws).
//
// Algorithm: AES-256-GCM via Node's built-in `crypto` (no native deps —
// the design doc referenced libsodium, but native AES-GCM is FIPS-able,
// well-audited, and ships zero extra bytes).
//
// Key rotation: write a new key into BRIGADE_ENCRYPTION_KEY, set the OLD
// one in BRIGADE_ENCRYPTION_KEY_OLD. Reads try the new key first then the
// old. Once everything has been re-sealed, drop the OLD env var.
//
// Customer-facing surface: a CLI command (`brigade encrypt status`) reports
// whether the key is set + a sample round-trip. Operators rotate keys with
// `brigade encrypt rotate --to <new-hex>` (calls re-seal across all
// sensitive columns; lands as a follow-up).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const MAGIC = 0x42;
const VERSION = 0x01;
const HEADER_LEN = 2;
const NONCE_LEN = 12;
const TAG_LEN = 16;

const KEY_ENV_PRIMARY = "BRIGADE_ENCRYPTION_KEY";
const KEY_ENV_OLD = "BRIGADE_ENCRYPTION_KEY_OLD";

function parseHexKey(name: string, raw: string | undefined): Buffer | undefined {
	if (!raw || raw.trim().length === 0) return undefined;
	const hex = raw.trim();
	if (!/^[0-9a-f]{64}$/i.test(hex)) {
		throw new Error(
			`${name} must be a 64-char hex string (32 bytes). Got ${hex.length} chars. ` +
				`Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`,
		);
	}
	return Buffer.from(hex, "hex");
}

let cachedPrimary: Buffer | undefined;
let cachedOld: Buffer | undefined;
let cacheStamp = 0;

function getKeys(): { primary?: Buffer; old?: Buffer } {
	// Re-resolve keys when env vars might have changed (cheap; env reads are
	// fast). Tests + the rotate CLI need this so they don't have to restart
	// the process.
	const stamp = (process.env[KEY_ENV_PRIMARY] ?? "") + "|" + (process.env[KEY_ENV_OLD] ?? "");
	const stampHash = stamp.length * 31 + (stamp.length > 0 ? stamp.charCodeAt(0) : 0);
	if (stampHash !== cacheStamp) {
		cachedPrimary = parseHexKey(KEY_ENV_PRIMARY, process.env[KEY_ENV_PRIMARY]);
		cachedOld = parseHexKey(KEY_ENV_OLD, process.env[KEY_ENV_OLD]);
		cacheStamp = stampHash;
	}
	return {
		...(cachedPrimary !== undefined ? { primary: cachedPrimary } : {}),
		...(cachedOld !== undefined ? { old: cachedOld } : {}),
	};
}

/** Is at-rest encryption configured? */
export function isEncryptionEnabled(): boolean {
	return getKeys().primary !== undefined;
}

/** Encrypt arbitrary bytes. When no key is configured, returns the bytes
 *  unchanged (so existing data and freshly-onboarded operators without a
 *  key continue to work). */
export function seal(
	plaintext: Uint8Array | ArrayBuffer | Buffer | string,
	aad?: string,
): ArrayBuffer {
	const key = getKeys().primary;
	const buf = toBuffer(plaintext);
	if (!key) {
		// Return the raw plaintext (no magic header) — `open` will see no
		// magic byte and pass through.
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
	}
	const nonce = randomBytes(NONCE_LEN);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
	const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
	const tag = cipher.getAuthTag();
	const out = Buffer.alloc(HEADER_LEN + NONCE_LEN + TAG_LEN + ct.length);
	out[0] = MAGIC;
	out[1] = VERSION;
	nonce.copy(out, HEADER_LEN);
	tag.copy(out, HEADER_LEN + NONCE_LEN);
	ct.copy(out, HEADER_LEN + NONCE_LEN + TAG_LEN);
	return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/** Decrypt bytes if they carry the magic prefix; otherwise return as-is. */
export function open(
	payload: Uint8Array | ArrayBuffer | Buffer | undefined | null,
	aad?: string,
): Buffer {
	if (!payload) return Buffer.alloc(0);
	const buf = toBuffer(payload);
	if (buf.length < HEADER_LEN || buf[0] !== MAGIC) {
		// Not a sealed payload — treat as plaintext bytes.
		return buf;
	}
	const version = buf[1];
	if (version !== VERSION) {
		throw new Error(
			`brigade encryption: unknown sealed-payload version ${version} (expected ${VERSION})`,
		);
	}
	const { primary, old: oldKey } = getKeys();
	if (!primary) {
		throw new Error(
			`brigade encryption: sealed payload received but ${KEY_ENV_PRIMARY} is not set. ` +
				"Set the matching key to read this row, or rotate via `brigade encrypt rotate`.",
		);
	}
	const nonce = buf.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN);
	const tag = buf.subarray(HEADER_LEN + NONCE_LEN, HEADER_LEN + NONCE_LEN + TAG_LEN);
	const ct = buf.subarray(HEADER_LEN + NONCE_LEN + TAG_LEN);

	const tryDecrypt = (key: Buffer): Buffer | undefined => {
		try {
			const dec = createDecipheriv("aes-256-gcm", key, nonce);
			if (aad) dec.setAAD(Buffer.from(aad, "utf8"));
			dec.setAuthTag(tag);
			return Buffer.concat([dec.update(ct), dec.final()]);
		} catch {
			return undefined;
		}
	};

	const primaryResult = tryDecrypt(primary);
	if (primaryResult !== undefined) return primaryResult;
	if (oldKey) {
		const oldResult = tryDecrypt(oldKey);
		if (oldResult !== undefined) return oldResult;
	}
	throw new Error(
		`brigade encryption: failed to decrypt sealed payload — wrong key or corrupted data`,
	);
}

// =============================================================================
// Convenience helpers
// =============================================================================

/** Encrypt a UTF-8 string. Returns the sealed ArrayBuffer ready to send
 *  into a Convex `v.bytes()` column. */
export function sealString(text: string, aad?: string): ArrayBuffer {
	return seal(Buffer.from(text, "utf8"), aad);
}

/** Decrypt a sealed-or-plain ArrayBuffer back into a UTF-8 string. */
export function openToString(
	payload: ArrayBuffer | Uint8Array | undefined | null,
	aad?: string,
): string {
	if (!payload) return "";
	return open(payload, aad).toString("utf8");
}

/** Encrypt a JSON-serialisable value. */
export function sealJson(value: unknown): ArrayBuffer {
	return seal(Buffer.from(JSON.stringify(value ?? null), "utf8"));
}

/** Decrypt a sealed JSON payload. Returns `undefined` when the input is
 *  empty / undecodable. */
export function openJson<T = unknown>(payload: ArrayBuffer | Uint8Array | undefined | null): T | undefined {
	if (!payload) return undefined;
	const text = open(payload).toString("utf8");
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

// =============================================================================
// Internals
// =============================================================================

function toBuffer(value: Uint8Array | ArrayBuffer | Buffer | string): Buffer {
	if (typeof value === "string") return Buffer.from(value, "utf8");
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof ArrayBuffer) return Buffer.from(value);
	return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Generate a fresh master key as 64-char hex. Used by `brigade encrypt init`. */
export function generateMasterKeyHex(): string {
	return randomBytes(32).toString("hex");
}

// =============================================================================
// Status / diagnostics
// =============================================================================

export interface EncryptionStatus {
	enabled: boolean;
	hasOldKey: boolean;
	algorithm: "aes-256-gcm" | null;
	primaryKeyFingerprint?: string;
	error?: string;
}

/** Self-check: confirms the key is parseable AND a round-trip works. */
export function encryptionStatus(): EncryptionStatus {
	const keys = getKeys();
	if (!keys.primary) {
		return { enabled: false, hasOldKey: keys.old !== undefined, algorithm: null };
	}
	try {
		const sample = "brigade-encryption-self-check";
		const sealed = sealString(sample);
		const opened = openToString(sealed);
		if (opened !== sample) {
			return {
				enabled: true,
				hasOldKey: keys.old !== undefined,
				algorithm: "aes-256-gcm",
				error: "round-trip mismatch",
			};
		}
		// First 8 hex chars of a sha256 of the key — gives operators a
		// short, non-revealing fingerprint to confirm two installs share
		// the same key.
		const fp = createHash("sha256").update(keys.primary).digest("hex").slice(0, 8);
		return {
			enabled: true,
			hasOldKey: keys.old !== undefined,
			algorithm: "aes-256-gcm",
			primaryKeyFingerprint: fp,
		};
	} catch (err) {
		return {
			enabled: true,
			hasOldKey: keys.old !== undefined,
			algorithm: "aes-256-gcm",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
