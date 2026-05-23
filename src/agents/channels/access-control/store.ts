/**
 * Channel access-control store — atomic per-channel JSON files.
 *
 * Two files per channel under `~/.brigade/channels/<id>/`:
 *   - `allow-from.json` — list of approved sender ids.
 *   - `pairing.json` — pending pairing codes (sender → code, with TTL).
 *
 * Both writes go via temp-file + rename for atomicity; both reads are
 * defensive (missing/corrupt files degrade to empty + a logged warning, never
 * crash). The pairing store auto-prunes expired + over-capacity entries on
 * every read so callers see a consistent view.
 */

import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import {
	resolveChannelAllowFromPath,
	resolveChannelGroupAllowFromPath,
	resolveChannelPairingPath,
	resolveChannelStateDir,
} from "../../../config/paths.js";
import { createSubsystemLogger } from "../../../logging/subsystem-logger.js";
import type { PairingRequest } from "./types.js";

const log = createSubsystemLogger("channels/access-control");

// Code alphabet: deliberately drops `0/O/1/I` so an operator reading a code
// over voice or copying from a screenshot can't fumble it. 32^8 ≈ 1.1×10¹²
// combinations is plenty for a 1-hour, max-3-pending window.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
/** Pending codes expire after this long. */
export const PAIRING_TTL_MS = 60 * 60 * 1000; // 1h
/** Most pending codes per channel; LRU-evicted on overflow. */
export const PAIRING_MAX_PENDING = 3;

/* ─────────────────────────── atomic JSON ─────────────────────────── */

function ensureParentDir(filePath: string): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
	if (!existsSync(filePath)) return fallback;
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as T;
	} catch (err) {
		log.warn("access-control store unreadable — using empty state", {
			path: filePath,
			error: err instanceof Error ? err.message : String(err),
		});
		return fallback;
	}
}

function writeJsonAtomic(filePath: string, value: unknown): void {
	ensureParentDir(filePath);
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2));
	renameSync(tmp, filePath);
}

/**
 * Serialize every read-modify-write on `filePath` behind a real file lock so
 * the gateway and CLI can't race each other into a lost update. Atomic-rename
 * protects against torn writes; the lock protects against two processes
 * reading the same JSON, both pruning, and both writing — only the last write
 * would win, silently dropping the other's allow-from add. `proper-lockfile`
 * handles stale-lock recovery + retries (sync API keeps the store callers sync
 * so we don't propagate async through the CLI surface).
 */
function withFileLock<T>(filePath: string, fn: () => T): T {
	ensureParentDir(filePath);
	// proper-lockfile requires the target to exist; create an empty placeholder
	// if needed — the real content lands when fn() calls writeJsonAtomic.
	if (!existsSync(filePath)) writeFileSync(filePath, "");
	// proper-lockfile's `lockSync` doesn't accept `retries` (it can't sleep). The
	// contention windows here are microseconds (read + JSON.parse + write a tiny
	// file), so a busy-wait retry loop with a few jittered tries is enough. Each
	// attempt either acquires immediately or throws ELOCKED.
	const MAX_ATTEMPTS = 12;
	let attempt = 0;
	let release: () => void = () => {};
	while (attempt < MAX_ATTEMPTS) {
		try {
			release = lockfile.lockSync(filePath, { stale: 30_000 });
			break;
		} catch (err) {
			attempt += 1;
			if (attempt >= MAX_ATTEMPTS) throw err;
			// Cheap synchronous spin: a few microseconds of busywork; jittered.
			const spinUntil = Date.now() + (5 + Math.floor(Math.random() * 25));
			while (Date.now() < spinUntil) {
				/* spin */
			}
		}
	}
	try {
		return fn();
	} finally {
		try {
			release();
		} catch {
			/* best-effort release */
		}
	}
}

/* ─────────────────────────── allow-from list ─────────────────────────── */

interface AllowFromFile {
	version: 1;
	allowFrom: string[];
}

/** Read the deduped, normalized allow-from list for a channel. */
export function readAllowFrom(channelId: string): string[] {
	const data = readJson<AllowFromFile>(resolveChannelAllowFromPath(channelId), { version: 1, allowFrom: [] });
	return [...new Set((data.allowFrom ?? []).map((x) => normalizeId(x)))].filter(Boolean);
}

/** Add a sender to the allow-from list. Returns true if newly added. */
export function addAllowFrom(channelId: string, senderId: string): boolean {
	const id = normalizeId(senderId);
	if (!id) return false;
	const filePath = resolveChannelAllowFromPath(channelId);
	return withFileLock(filePath, () => {
		const current = readAllowFrom(channelId);
		if (current.includes(id)) return false;
		writeJsonAtomic(filePath, { version: 1, allowFrom: [...current, id] } satisfies AllowFromFile);
		return true;
	});
}

/** Remove a sender from the allow-from list. Returns true if it was present. */
export function removeAllowFrom(channelId: string, senderId: string): boolean {
	const id = normalizeId(senderId);
	if (!id) return false;
	const filePath = resolveChannelAllowFromPath(channelId);
	return withFileLock(filePath, () => {
		const current = readAllowFrom(channelId);
		if (!current.includes(id)) return false;
		writeJsonAtomic(filePath, { version: 1, allowFrom: current.filter((x) => x !== id) } satisfies AllowFromFile);
		return true;
	});
}

/** Read the deduped, normalized GROUP allow-from list for a channel. */
export function readGroupAllowFrom(channelId: string): string[] {
	const data = readJson<AllowFromFile>(resolveChannelGroupAllowFromPath(channelId), { version: 1, allowFrom: [] });
	return [...new Set((data.allowFrom ?? []).map((x) => normalizeId(x)))].filter(Boolean);
}

/** True when `senderId` is in the channel's allow-from list. */
export function isAllowed(channelId: string, senderId: string): boolean {
	const id = normalizeId(senderId);
	if (!id) return false;
	return readAllowFrom(channelId).includes(id);
}

/* ─────────────────────────── pairing codes ─────────────────────────── */

interface PairingFile {
	version: 1;
	requests: PairingRequest[];
}

/** Strip ASCII whitespace + uppercase; safe for both sender ids and codes. */
function normalizeId(value: string): string {
	return value.replace(/\s+/g, "").trim();
}
function normalizeCode(value: string): string {
	return value.replace(/[\s-]+/g, "").toUpperCase();
}

/** Generate one unique 8-char code that isn't already pending in this channel. */
function generateUniqueCode(existing: Iterable<string>): string {
	const taken = new Set(existing);
	for (let attempt = 0; attempt < 500; attempt++) {
		let out = "";
		for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
		if (!taken.has(out)) return out;
	}
	throw new Error("pairing-store: could not generate a unique code after 500 attempts");
}

/** Prune expired + over-cap entries. Returns the pruned list (oldest evicted first). */
function pruneRequests(requests: PairingRequest[], now = Date.now()): PairingRequest[] {
	const fresh = requests.filter((r) => now - Date.parse(r.createdAt) < PAIRING_TTL_MS);
	if (fresh.length <= PAIRING_MAX_PENDING) return fresh;
	// Newest by lastSeenAt wins on overflow; insertion order (later = newer)
	// is the tie-breaker when timestamps land in the same millisecond.
	return fresh
		.map((r, i) => ({ r, i }))
		.sort((a, b) => Date.parse(b.r.lastSeenAt) - Date.parse(a.r.lastSeenAt) || b.i - a.i)
		.slice(0, PAIRING_MAX_PENDING)
		.map((x) => x.r);
}

/** Read pending pairing requests; prunes expired/over-cap on read (under lock). */
export function readPendingPairings(channelId: string): PairingRequest[] {
	const filePath = resolveChannelPairingPath(channelId);
	return withFileLock(filePath, () => {
		const data = readJson<PairingFile>(filePath, { version: 1, requests: [] });
		const pruned = pruneRequests(data.requests ?? []);
		// If pruning changed anything, persist so the next read is consistent.
		if (pruned.length !== (data.requests ?? []).length) {
			writeJsonAtomic(filePath, { version: 1, requests: pruned } satisfies PairingFile);
		}
		return pruned;
	});
}

/**
 * Issue (or re-emit) a pairing code for `senderId`. If a non-expired code is
 * already pending for the same sender, the existing one is returned with
 * `lastSeenAt` refreshed — the operator must approve a stable code, even if
 * the stranger DMs repeatedly. Returns `{code, isNew}`.
 */
export function upsertPairingRequest(args: {
	channelId: string;
	senderId: string;
	senderName?: string;
}): { code: string; isNew: boolean } {
	const senderId = normalizeId(args.senderId);
	if (!senderId) throw new Error("upsertPairingRequest: senderId required");
	const filePath = resolveChannelPairingPath(args.channelId);
	return withFileLock(filePath, () => {
	const data = readJson<PairingFile>(filePath, { version: 1, requests: [] });
	const now = new Date().toISOString();
	const fresh = pruneRequests(data.requests ?? []);

	const existing = fresh.find((r) => r.senderId === senderId);
	if (existing) {
		existing.lastSeenAt = now;
		if (args.senderName) existing.senderName = args.senderName;
		writeJsonAtomic(filePath, { version: 1, requests: fresh } satisfies PairingFile);
		return { code: existing.code, isNew: false };
	}

	const code = generateUniqueCode(fresh.map((r) => r.code));
	const next: PairingRequest = {
		senderId,
		senderName: args.senderName,
		code,
		createdAt: now,
		lastSeenAt: now,
	};
	const combined = pruneRequests([...fresh, next]);
	writeJsonAtomic(filePath, { version: 1, requests: combined } satisfies PairingFile);
	return { code, isNew: true };
	});
}

/**
 * Approve a pairing code: looks up the pending request, removes it, and adds
 * its sender to the allow-from list. Returns the request that was approved,
 * or `null` if the code is unknown / expired.
 */
export function approvePairingCode(channelId: string, code: string): PairingRequest | null {
	const wanted = normalizeCode(code);
	const filePath = resolveChannelPairingPath(channelId);
	const approved = withFileLock(filePath, (): PairingRequest | null => {
		const data = readJson<PairingFile>(filePath, { version: 1, requests: [] });
		const fresh = pruneRequests(data.requests ?? []);
		const idx = fresh.findIndex((r) => r.code === wanted);
		if (idx === -1) return null;
		const a = fresh[idx] as PairingRequest;
		fresh.splice(idx, 1);
		writeJsonAtomic(filePath, { version: 1, requests: fresh } satisfies PairingFile);
		return a;
	});
	if (approved) addAllowFrom(channelId, approved.senderId); // separate lock, allow-from file
	return approved;
}

/** Drop a pending code without approving it (operator declines). Returns true if found. */
export function revokePairingCode(channelId: string, code: string): boolean {
	const wanted = normalizeCode(code);
	const filePath = resolveChannelPairingPath(channelId);
	return withFileLock(filePath, () => {
		const data = readJson<PairingFile>(filePath, { version: 1, requests: [] });
		const fresh = pruneRequests(data.requests ?? []);
		const idx = fresh.findIndex((r) => r.code === wanted);
		if (idx === -1) return false;
		fresh.splice(idx, 1);
		writeJsonAtomic(filePath, { version: 1, requests: fresh } satisfies PairingFile);
		return true;
	});
}

/* ─────────────────────────── housekeeping ─────────────────────────── */

/** Wipe access-control state for a channel (called by `channels unlink`). */
export function eraseAccessState(channelId: string): void {
	const dir = resolveChannelStateDir(channelId);
	// allow-from + pairing files live directly under the channel state dir, so
	// the existing `rm -rf <stateDir>` in `channels unlink` already covers them.
	// This helper exists for tests + future per-file resets.
	void dir;
}
