/**
 * Atomic JSON file loader + saver.
 *
 * Both are sync (fs.* sync APIs) to keep the per-storePath FIFO lock queue
 * in `session-store-lock.ts` simple — the queue serialises operations at
 * the API boundary, so the file I/O does not need to be async-aware.
 *
 * Save semantics (`tmp + rename`):
 *   1. Write the new content to a unique temp file from `atomicTempPath`
 *      with `0o600` perms.
 *   2. `fs.renameSync(tmp, <path>)` — atomic on every supported
 *      filesystem (POSIX rename, NTFS MoveFileTransacted under the hood).
 *
 * A crash between step 1 and step 2 leaves the temp file behind but
 * the existing `<path>` is untouched. A crash after step 2 has nothing
 * to recover — the rename was atomic.
 *
 * Load semantics:
 *   - Missing file → returns `null`.
 *   - Empty file → returns `null` (treated as "no state yet").
 *   - Malformed JSON → throws. The caller (session-store) catches and
 *     decides whether to back up + reset or propagate.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Monotonic per-process tiebreaker — see `atomicTempPath`. */
let tempSequence = 0;

/**
 * A collision-free temp path for an atomic tmp+rename write:
 * `<target>.tmp-<pid>-<base36 ms>-<seq>`.
 *
 * A bare `<target>.tmp` is only safe when exactly ONE process ever writes
 * the target. Several Brigade stores are written from more than one process
 * (the gateway and a `brigade` CLI invocation both persist the session store,
 * auth profiles, cron store, …): two writers computing the SAME temp path can
 * interleave their bytes, and the second rename then publishes a torn file —
 * atomicity is decided by whoever renames last, not by the writer whose data
 * survived.
 *
 * The pid separates processes, the base36 millisecond stamp separates writes
 * seconds apart, and the sequence counter separates bursts inside one
 * millisecond of one process. Matches the convention the careful writers
 * already use (`workspace/state.ts`, `agents/memory/extract.ts`), plus the
 * counter. Files matching `*.tmp-*` are crash leftovers; nothing reads them —
 * success renames them away.
 */
export function atomicTempPath(target: string): string {
	tempSequence += 1;
	return `${target}.tmp-${process.pid}-${Date.now().toString(36)}-${tempSequence}`;
}

export function loadJsonFile<T>(filePath: string): T | null {
	if (!fs.existsSync(filePath)) return null;
	const raw = fs.readFileSync(filePath, "utf8");
	if (!raw.trim()) return null;
	return JSON.parse(raw) as T;
}

export function saveJsonFile(filePath: string, value: unknown): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = atomicTempPath(filePath);
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		fs.chmodSync(tmp, 0o600);
	} catch {
		/* best-effort on platforms without chmod */
	}
	fs.renameSync(tmp, filePath);
}
