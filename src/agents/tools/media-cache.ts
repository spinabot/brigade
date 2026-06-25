/**
 * Tiny disk-backed LRU cache for `analyze_media` PROVIDER results.
 *
 * A provider understanding call (Gemini / Anthropic over the media bytes) is the
 * one expensive, billable step in the tool. When the SAME bytes + question +
 * provider + model + token budget are analyzed again (e.g. the operator re-asks,
 * or a cron re-runs over an unchanged attachment), we can return the cached TEXT
 * instead of paying for the call again.
 *
 * Storage model — ONE small JSON file per key under
 * `resolveCacheDir()/analyze-media/`:
 *   • mode-aware: `resolveCacheDir()` already returns the OS cache root in
 *     convex/strict-zero mode (keeps `~/.brigade` clean) and the state cache dir
 *     in filesystem mode.
 *   • per-key files (not one shared file) → concurrent agents never clobber each
 *     other's writes; a corrupt entry only loses itself.
 *   • LRU bound: on write, if the directory exceeds the entry cap, the
 *     oldest-by-mtime files are deleted. A TTL also expires stale entries on read.
 *
 * The cache is BEST-EFFORT: any fs error (read, write, mkdir) is swallowed — a
 * cache miss just means the provider gets called, never a tool failure.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveCacheDir } from "../../config/paths.js";

/** Max entries kept on disk before LRU eviction (by mtime). */
const DEFAULT_MAX_ENTRIES = 200;
/** Entry TTL — a cached provider answer older than this is ignored + cleaned. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** The cached value shape. */
export interface MediaCacheValue {
	text: string;
	provider: string;
	model: string;
}

/** Inputs that uniquely identify a provider understanding result. */
export interface MediaCacheKeyParts {
	bytes: Buffer;
	question: string;
	provider: string;
	model?: string;
	maxTokens?: number;
	kind: string;
}

/** Compute the cache key = sha256 over the identifying parts (hex). */
export function mediaCacheKey(parts: MediaCacheKeyParts): string {
	const h = createHash("sha256");
	h.update(parts.kind);
	h.update("\0");
	h.update(parts.provider);
	h.update("\0");
	h.update(parts.model ?? "");
	h.update("\0");
	h.update(String(parts.maxTokens ?? ""));
	h.update("\0");
	h.update(parts.question);
	h.update("\0");
	// Hash the bytes last (largest input). The content hash is what makes the
	// key change when the underlying media changes.
	h.update(parts.bytes);
	return h.digest("hex");
}

/** Resolve (and lazily create) the cache directory. Returns undefined on failure. */
function cacheDir(): string | undefined {
	try {
		const dir = path.join(resolveCacheDir(), "analyze-media");
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	} catch {
		return undefined;
	}
}

/**
 * Read a cached provider result. Returns `undefined` on a miss, a corrupt entry,
 * or an expired entry (which is also unlinked). Never throws.
 */
export async function readMediaCache(
	key: string,
	opts: { ttlMs?: number; dir?: string } = {},
): Promise<MediaCacheValue | undefined> {
	const dir = opts.dir ?? cacheDir();
	if (!dir) return undefined;
	const file = path.join(dir, `${key}.json`);
	try {
		const stat = await fsp.stat(file);
		const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
		if (Date.now() - stat.mtimeMs > ttl) {
			void fsp.unlink(file).catch(() => {});
			return undefined;
		}
		const raw = await fsp.readFile(file, "utf8");
		const parsed = JSON.parse(raw) as Partial<MediaCacheValue>;
		if (typeof parsed.text === "string" && parsed.text.length > 0) {
			// Touch mtime so LRU treats a cache HIT as recently-used.
			void fsp.utimes(file, new Date(), new Date()).catch(() => {});
			return {
				text: parsed.text,
				provider: typeof parsed.provider === "string" ? parsed.provider : "",
				model: typeof parsed.model === "string" ? parsed.model : "",
			};
		}
	} catch {
		/* miss / corrupt / unreadable → undefined */
	}
	return undefined;
}

/**
 * Write a provider result to the cache + evict the oldest entries when over the
 * cap. Best-effort: any failure is swallowed. Returns nothing.
 */
export async function writeMediaCache(
	key: string,
	value: MediaCacheValue,
	opts: { maxEntries?: number; dir?: string } = {},
): Promise<void> {
	const dir = opts.dir ?? cacheDir();
	if (!dir) return;
	const file = path.join(dir, `${key}.json`);
	try {
		await fsp.writeFile(file, JSON.stringify(value), "utf8");
	} catch {
		return; // could not persist — give up silently
	}
	// LRU eviction: if the directory holds more than the cap, delete the oldest
	// by mtime. Cheap (a stat per entry) and only runs on writes.
	try {
		const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
		const names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".json"));
		if (names.length <= max) return;
		const stats = await Promise.all(
			names.map(async (n) => {
				try {
					const s = await fsp.stat(path.join(dir, n));
					return { n, mtime: s.mtimeMs };
				} catch {
					return { n, mtime: 0 };
				}
			}),
		);
		stats.sort((a, b) => a.mtime - b.mtime); // oldest first
		const toDelete = stats.slice(0, names.length - max);
		await Promise.all(toDelete.map((e) => fsp.unlink(path.join(dir, e.n)).catch(() => {})));
	} catch {
		/* eviction is best-effort */
	}
}
