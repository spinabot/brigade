// src/storage/convex/blob-store.ts
//
// Convex File Storage integration. Upload flow:
//   1. Call `generateUploadUrl(sha256)` mutation → returns a one-time URL
//      (or `existed: true` if the sha is already stored).
//   2. HTTP PUT the bytes to that URL — Convex serves the byte channel.
//   3. Call `recordUpload(sha256, storageId, ...)` to insert/refcount the
//      brigadeBlobs metadata row.
//
// Download is `storage.getUrl(storageId)` via the `getDownloadUrl` query;
// callers HTTP GET the resulting short-lived URL.

import { createHash } from "node:crypto";

import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import type { BlobStore } from "../store.js";

interface Deps { client: ConvexHttpClient; ownerId: string }

export class ConvexBlobStore implements BlobStore {
	constructor(private readonly deps: Deps) {}

	async put(
		bytes: Uint8Array,
		opts?: { contentType?: string },
	): Promise<{ sha256: string; url: string }> {
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const uploadInfo = (await this.deps.client.mutation(api.blobs.generateUploadUrl, {
			ownerId: this.deps.ownerId,
			sha256,
		})) as { uploadUrl: string; existed: boolean; storageId: string | null };

		if (uploadInfo.existed && uploadInfo.storageId) {
			// Bump refcount on the existing row.
			await this.deps.client.mutation(api.blobs.recordUpload, {
				ownerId: this.deps.ownerId,
				sha256,
				storageId: uploadInfo.storageId as never,
				...(opts?.contentType !== undefined ? { contentType: opts.contentType } : {}),
				size: bytes.byteLength,
			});
			return { sha256, url: `convex-file:${sha256}` };
		}

		// Upload the bytes to the signed URL.
		const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		const res = await fetch(uploadInfo.uploadUrl, {
			method: "POST",
			headers: { "Content-Type": opts?.contentType ?? "application/octet-stream" },
			body: buf,
		});
		if (!res.ok) {
			throw new Error(
				`ConvexBlobStore.put: upload failed (HTTP ${res.status} ${res.statusText})`,
			);
		}
		const { storageId } = (await res.json()) as { storageId: string };

		// Record the metadata row.
		await this.deps.client.mutation(api.blobs.recordUpload, {
			ownerId: this.deps.ownerId,
			sha256,
			storageId: storageId as never,
			...(opts?.contentType !== undefined ? { contentType: opts.contentType } : {}),
			size: bytes.byteLength,
		});
		return { sha256, url: `convex-file:${sha256}` };
	}

	async get(sha256: string): Promise<Uint8Array | null> {
		const url = (await this.deps.client.query(api.blobs.getDownloadUrl, { sha256 })) as
			| string
			| null;
		if (!url) return null;
		const res = await fetch(url);
		if (!res.ok) {
			if (res.status === 404) return null;
			throw new Error(`ConvexBlobStore.get: HTTP ${res.status} ${res.statusText}`);
		}
		const ab = await res.arrayBuffer();
		return new Uint8Array(ab);
	}

	async delete(sha256: string): Promise<void> {
		await this.deps.client.mutation(api.blobs.remove, { sha256 });
	}
}
