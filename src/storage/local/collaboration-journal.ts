import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { renameWithRetryAsync } from "../../infra/fs/atomic-rename.js";

const JOURNAL_VERSION = 1 as const;
const LOCK_POLL_INITIAL_MS = 25;
const LOCK_POLL_MAX_MS = 500;
const LOCK_TIMEOUT_MS = 30_000;
const INVALID_LOCK_GRACE_MS = 5_000;

export interface CollaborationJournalEntry<T> {
	version: typeof JOURNAL_VERSION;
	seq: number;
	txId: string;
	writtenAt: number;
	prevHash: string | null;
	payload: T;
	hash: string;
}

interface JournalLockContents {
	pid: number;
	acquiredAt: number;
	nonce: string;
}

export class CollaborationJournalCorruptError extends Error {
	constructor(
		message: string,
		public readonly line: number,
	) {
		super(message);
		this.name = "CollaborationJournalCorruptError";
	}
}

/**
 * Filesystem-mode transaction journal.
 *
 * A single newline-delimited entry is the commit unit. The entry can contain
 * state changes, public domain events, and outbox work together, so the local
 * backend never has to approximate a transaction across independent files.
 * The journal is the authority; any higher-level snapshot is only a cache.
 */
export class LocalCollaborationJournal<T> {
	readonly rootDir: string;
	readonly journalPath: string;
	readonly lockPath: string;

	private operationTail: Promise<unknown> = Promise.resolve();
	private watchers = new Set<() => void>();
	private watcher: import("node:fs").FSWatcher | undefined;

	constructor(stateDir: string) {
		this.rootDir = path.join(stateDir, "collaboration");
		this.journalPath = path.join(this.rootDir, "journal.jsonl");
		this.lockPath = path.join(this.rootDir, "journal.lock");
	}

	async init(): Promise<void> {
		await this.enqueue(async () => {
			await ensureSecureDirectory(this.rootDir);
			const lock = await acquireJournalLock(this.lockPath);
			try {
				await this.readEntriesAndRepairTornTail();
			} finally {
				await lock.release();
			}
		});
	}

	async close(): Promise<void> {
		await this.operationTail.catch(() => undefined);
		try {
			this.watcher?.close();
		} catch {
			// Idempotent close.
		}
		this.watcher = undefined;
		this.watchers.clear();
	}

	/** Read and validate the complete committed history. */
	readAll(): Promise<CollaborationJournalEntry<T>[]> {
		return this.enqueue(async () => {
			const lock = await acquireJournalLock(this.lockPath);
			try {
				// Await inside the lock scope. Returning the promise directly would
				// run `finally` first, releasing the cross-process lock while the read
				// and possible torn-tail repair were still in flight.
				return await this.readEntriesAndRepairTornTail();
			} finally {
				await lock.release();
			}
		});
	}

	/**
	 * Run a semantic mutation against the latest history and append at most one
	 * authoritative transaction. Re-reading under the cross-process lock keeps a
	 * short-lived CLI process from overwriting decisions made by the gateway.
	 */
	transact<R>(
		decide: (
			entries: readonly CollaborationJournalEntry<T>[],
		) =>
			| { payload: T; result: R; txId?: string; writtenAt?: number }
			| { result: R }
			| Promise<
					| { payload: T; result: R; txId?: string; writtenAt?: number }
					| { result: R }
			  >,
	): Promise<R> {
		return this.enqueue(async () => {
			const lock = await acquireJournalLock(this.lockPath);
			try {
				const entries = await this.readEntriesAndRepairTornTail();
				const decision = await decide(entries);
				if (!("payload" in decision)) return decision.result;

				const previous = entries[entries.length - 1];
				const body = {
					version: JOURNAL_VERSION,
					seq: (previous?.seq ?? 0) + 1,
					txId: decision.txId ?? randomUUID(),
					writtenAt: decision.writtenAt ?? Date.now(),
					prevHash: previous?.hash ?? null,
					payload: decision.payload,
				};
				const entry: CollaborationJournalEntry<T> = {
					...body,
					hash: hashJournalBody(body),
				};
				await appendDurably(this.journalPath, entry);
				return decision.result;
			} finally {
				await lock.release();
			}
		});
	}

	/**
	 * Best-effort change hint. Callers must always resume with their last
	 * sequence through the durable read API because fs.watch may coalesce.
	 */
	subscribe(onChange: () => void): () => void {
		this.watchers.add(onChange);
		this.ensureWatcher();
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			this.watchers.delete(onChange);
			if (this.watchers.size === 0) {
				try {
					this.watcher?.close();
				} catch {
					// Idempotent close.
				}
				this.watcher = undefined;
			}
		};
	}

	private ensureWatcher(): void {
		if (this.watcher) return;
		void ensureSecureDirectory(this.rootDir).then(async () => {
			if (this.watcher || this.watchers.size === 0) return;
			const fsSync = await import("node:fs");
			try {
				this.watcher = fsSync.watch(
					this.rootDir,
					{ persistent: false },
					(_event, filename) => {
						if (filename && filename.toString() !== path.basename(this.journalPath)) return;
						for (const cb of [...this.watchers]) {
							try {
								cb();
							} catch {
								// One subscriber must not break the rest.
							}
						}
					},
				);
				this.watcher.on("error", () => {
					try {
						this.watcher?.close();
					} catch {
						// Best effort.
					}
					this.watcher = undefined;
				});
			} catch {
				// Subscription is a hint only; reads remain authoritative.
			}
		});
	}

	private enqueue<R>(work: () => Promise<R>): Promise<R> {
		const previous = this.operationTail.catch(() => undefined);
		const next = previous.then(work);
		this.operationTail = next.catch(() => undefined);
		return next;
	}

	private async readEntriesAndRepairTornTail(): Promise<CollaborationJournalEntry<T>[]> {
		let bytes: Buffer;
		try {
			bytes = await fs.readFile(this.journalPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		if (bytes.length === 0) return [];

		const lastNewline = bytes.lastIndexOf(0x0a);
		if (lastNewline !== bytes.length - 1) {
			const committedLength = lastNewline + 1;
			const torn = bytes.subarray(committedLength);
			await preserveTornTail(this.rootDir, torn);
			const handle = await fs.open(this.journalPath, "r+");
			try {
				await handle.truncate(committedLength);
				await handle.sync();
			} finally {
				await handle.close();
			}
			bytes = bytes.subarray(0, committedLength);
		}

		const text = bytes.toString("utf8");
		const lines = text.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();

		const entries: CollaborationJournalEntry<T>[] = [];
		let previousHash: string | null = null;
		for (let index = 0; index < lines.length; index += 1) {
			const raw = lines[index];
			if (!raw) {
				throw new CollaborationJournalCorruptError(
					`collaboration journal contains an empty committed record at line ${index + 1}`,
					index + 1,
				);
			}
			let entry: CollaborationJournalEntry<T>;
			try {
				entry = JSON.parse(raw) as CollaborationJournalEntry<T>;
			} catch {
				throw new CollaborationJournalCorruptError(
					`collaboration journal contains invalid committed JSON at line ${index + 1}`,
					index + 1,
				);
			}
			validateEntry(entry, index + 1, previousHash);
			entries.push(entry);
			previousHash = entry.hash;
		}
		return entries;
	}
}

function validateEntry<T>(
	entry: CollaborationJournalEntry<T>,
	line: number,
	expectedPreviousHash: string | null,
): void {
	if (entry.version !== JOURNAL_VERSION) {
		throw new CollaborationJournalCorruptError(
			`unsupported collaboration journal version at line ${line}`,
			line,
		);
	}
	if (!Number.isSafeInteger(entry.seq) || entry.seq !== line) {
		throw new CollaborationJournalCorruptError(
			`collaboration journal sequence mismatch at line ${line}`,
			line,
		);
	}
	if (entry.prevHash !== expectedPreviousHash) {
		throw new CollaborationJournalCorruptError(
			`collaboration journal hash chain mismatch at line ${line}`,
			line,
		);
	}
	const actual = hashJournalBody({
		version: entry.version,
		seq: entry.seq,
		txId: entry.txId,
		writtenAt: entry.writtenAt,
		prevHash: entry.prevHash,
		payload: entry.payload,
	});
	if (entry.hash !== actual) {
		throw new CollaborationJournalCorruptError(
			`collaboration journal checksum mismatch at line ${line}`,
			line,
		);
	}
}

function hashJournalBody(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	const encoded = JSON.stringify(sortJson(value, new Set<object>()));
	if (encoded === undefined) throw new Error("collaboration journal payload is not JSON-serializable");
	return encoded;
}

function sortJson(value: unknown, seen: Set<object>): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("collaboration journal values must contain finite numbers");
		return value;
	}
	if (value === undefined) return undefined;
	if (typeof value !== "object") {
		throw new Error("collaboration journal values must be plain JSON values");
	}
	if (seen.has(value)) throw new Error("collaboration journal values must not contain cycles");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item, index) => {
				if (!(index in value) || item === undefined) {
					throw new Error("collaboration journal arrays must not contain missing values");
				}
				return sortJson(item, seen);
			});
		}
		const prototype = Object.getPrototypeOf(value) as unknown;
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("collaboration journal values must be plain JSON values");
		}
		const input = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(input).sort()) {
			const item = input[key];
			// Optional domain fields are represented as absent on disk, matching
			// JSON.stringify and ordinary wire-protocol behavior.
			if (item !== undefined) out[key] = sortJson(item, seen);
		}
		return out;
	} finally {
		seen.delete(value);
	}
}

async function ensureSecureDirectory(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await fs.chmod(dir, 0o700);
}

async function appendDurably<T>(
	journalPath: string,
	entry: CollaborationJournalEntry<T>,
): Promise<void> {
	const handle = await fs.open(journalPath, "a", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	if (process.platform !== "win32") await fs.chmod(journalPath, 0o600);
	await syncDirectory(path.dirname(journalPath));
}

async function preserveTornTail(rootDir: string, bytes: Buffer): Promise<void> {
	if (bytes.length === 0) return;
	const target = path.join(rootDir, `journal.torn-${Date.now()}-${randomUUID()}.bin`);
	const tmp = `${target}.tmp`;
	// Write AND fsync the same handle. This used to `fs.writeFile` and then
	// re-open the file READ-ONLY to sync it, which fails on Windows — fsync maps
	// to FlushFileBuffers, and that needs a write-capable handle, so a read-only
	// one gets EPERM. The repair is the recovery path (it only runs because an
	// earlier write was interrupted), so throwing here turned a recoverable torn
	// tail into a journal that cannot be opened at all. syncDirectory below has
	// always known Windows is different; the file sync has to as well.
	const handle = await fs.open(tmp, "w", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await renameWithRetryAsync(tmp, target);
	await syncDirectory(rootDir);
}

async function acquireJournalLock(
	lockPath: string,
	opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ release(): Promise<void> }> {
	await ensureSecureDirectory(path.dirname(lockPath));
	const nonce = randomUUID();
	const deadline = Date.now() + (opts.timeoutMs ?? LOCK_TIMEOUT_MS);
	let pollMs = LOCK_POLL_INITIAL_MS;

	while (true) {
		if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Lock acquisition aborted");
		try {
			const handle = await fs.open(lockPath, "wx", 0o600);
			try {
				const contents: JournalLockContents = {
					pid: process.pid,
					acquiredAt: Date.now(),
					nonce,
				};
				await handle.writeFile(JSON.stringify(contents), "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			return { release: () => releaseJournalLock(lockPath, nonce) };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}

		if (await maybeStealJournalLock(lockPath)) continue;
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for collaboration journal lock: ${lockPath}`);
		}
		await waitWithSignal(pollMs, opts.signal);
		pollMs = Math.min(LOCK_POLL_MAX_MS, Math.floor(pollMs * 1.5));
	}
}

async function maybeStealJournalLock(lockPath: string): Promise<boolean> {
	// Stale-lock removal itself needs a mutex. Without this guard, two waiters
	// can both inspect the old inode; the first removes it and acquires a fresh
	// lock, then the second unlinks that fresh lock using its stale decision.
	// That admits two journal writers and forks the hash chain.
	const reaperPath = `${lockPath}.reaper`;
	const reaperNonce = randomUUID();
	let reaper: Awaited<ReturnType<typeof fs.open>>;
	try {
		reaper = await fs.open(reaperPath, "wx", 0o600);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			// The previous reaper may itself have died. Its owner record and nonce
			// make that state recoverable without deleting a live contender's mutex.
			await maybeStealOrphanedReaper(reaperPath);
			return false;
		}
		throw err;
	}

	try {
		await reaper.writeFile(JSON.stringify({
			pid: process.pid,
			acquiredAt: Date.now(),
			nonce: reaperNonce,
		} satisfies JournalLockContents), "utf8");
		await reaper.sync();

		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(lockPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw err;
		}

		let contents: JournalLockContents | undefined;
		try {
			contents = parseLockContents(await fs.readFile(lockPath, "utf8"));
		} catch {
			// The creator may still be writing the lock body. Only steal an invalid
			// lock after a grace window, never immediately.
			if (Date.now() - stat.mtimeMs <= INVALID_LOCK_GRACE_MS) return false;
		}

		if (contents && isProcessAlive(contents.pid)) return false;
		try {
			await fs.unlink(lockPath);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
			return false;
		}
	} finally {
		await reaper.close().catch(() => undefined);
		await releaseJournalLock(reaperPath, reaperNonce);
	}
}

async function maybeStealOrphanedReaper(reaperPath: string): Promise<boolean> {
	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(reaperPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw err;
	}

	let raw: string;
	try {
		raw = await fs.readFile(reaperPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw err;
	}
	const contents = parseLockContents(raw);
	if (contents) {
		if (isProcessAlive(contents.pid)) return false;
		return unlinkLockWithNonce(reaperPath, contents.nonce);
	}

	// A crash between O_EXCL creation and writing the owner JSON leaves an empty
	// or partial file. Give a live creator time to finish, then remove only if the
	// same inode-sized record is still present after a second observation.
	if (Date.now() - stat.mtimeMs <= INVALID_LOCK_GRACE_MS) return false;
	let current: Awaited<ReturnType<typeof fs.stat>>;
	try {
		current = await fs.stat(reaperPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw err;
	}
	if (current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
		return false;
	}
	try {
		await fs.unlink(reaperPath);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}
}

function parseLockContents(raw: string): JournalLockContents | undefined {
	try {
		const parsed = JSON.parse(raw) as Partial<JournalLockContents>;
		if (
			!Number.isSafeInteger(parsed.pid) ||
			(parsed.pid as number) <= 0 ||
			!Number.isFinite(parsed.acquiredAt) ||
			(parsed.acquiredAt as number) < 0 ||
			typeof parsed.nonce !== "string" ||
			parsed.nonce.length === 0
		) return undefined;
		return parsed as JournalLockContents;
	} catch {
		return undefined;
	}
}

async function unlinkLockWithNonce(lockPath: string, nonce: string): Promise<boolean> {
	try {
		const current = parseLockContents(await fs.readFile(lockPath, "utf8"));
		if (current?.nonce !== nonce) return false;
		await fs.unlink(lockPath);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw err;
	}
}

async function releaseJournalLock(lockPath: string, nonce: string): Promise<void> {
	await unlinkLockWithNonce(lockPath, nonce);
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const finish = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason ?? new Error("Lock acquisition aborted"));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function syncDirectory(dir: string): Promise<void> {
	if (process.platform === "win32") return;
	try {
		const handle = await fs.open(dir, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// Some network filesystems reject fsync on directories. The journal file
		// itself was still fsynced; directory sync is the stronger POSIX path.
	}
}
