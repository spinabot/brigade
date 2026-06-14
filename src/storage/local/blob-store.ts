// src/storage/local/blob-store.ts
//
// LocalBlobStore — content-addressed byte store under
// `<stateDir>/blobs/<sha256[:2]>/<sha256[2:]>` (sharded so a single dir
// doesn't accumulate tens of thousands of entries on heavy media use).
// Implements `BlobStore`.
//
// In filesystem mode this is a fresh helper layer: there's no existing
// shared blob storage today (channels write media into their own dirs, org
// writes chart PNGs into its own cache). PR8 + PR13 use this for backing
// content-addressed storage when they need it; primitive code that wants
// "give me bytes for this hash" calls through here.
//
// Locator format: `sha256:<hex>` so callers carry an opaque string that's
// portable across modes (convex mode rewrites the same locator over a
// Convex File Storage id internally).

import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { resolveStateDir } from "../../config/paths.js";

import type { BlobStore } from "../store.js";

function resolveBlobsRoot(): string {
	return path.join(resolveStateDir(), "blobs");
}

function pathForHash(sha256: string): string {
	// Defensive: ensure we never traverse outside the blobs dir.
	if (!/^[0-9a-f]{64}$/i.test(sha256)) {
		throw new Error(`LocalBlobStore: invalid sha256 "${sha256}" (must be 64 lowercase hex chars)`);
	}
	const lower = sha256.toLowerCase();
	return path.join(resolveBlobsRoot(), lower.slice(0, 2), lower.slice(2));
}

export class LocalBlobStore implements BlobStore {
	constructor(private readonly _stateDir: string) {}

	async put(
		bytes: Uint8Array,
		_opts?: { contentType?: string },
	): Promise<{ sha256: string; url: string }> {
		const sha = createHash("sha256").update(bytes).digest("hex");
		const target = pathForHash(sha);
		// Idempotent — if the content-addressed file already exists, skip the
		// write. sha256 collisions don't happen in practice; same hash means
		// same bytes by construction.
		if (fs.existsSync(target)) {
			return { sha256: sha, url: `sha256:${sha}` };
		}
		await fsAsync.mkdir(path.dirname(target), { recursive: true });
		const tmp = `${target}.tmp.${process.pid}.${Date.now().toString(36)}`;
		await fsAsync.writeFile(tmp, Buffer.from(bytes));
		await fsAsync.rename(tmp, target);
		// File-permissions hardening on POSIX — blobs may carry private media,
		// so the same 0o600 discipline the auth files use applies here.
		if (process.platform !== "win32") {
			try {
				await fsAsync.chmod(target, 0o600);
			} catch {
				// Best-effort — some filesystems (FAT32, network mounts) reject chmod.
			}
		}
		return { sha256: sha, url: `sha256:${sha}` };
	}

	async get(sha256: string): Promise<Uint8Array | null> {
		const target = pathForHash(sha256);
		try {
			const bytes = await fsAsync.readFile(target);
			return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}

	async delete(sha256: string): Promise<void> {
		const target = pathForHash(sha256);
		try {
			await fsAsync.unlink(target);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
	}
}
