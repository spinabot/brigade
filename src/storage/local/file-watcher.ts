// src/storage/local/file-watcher.ts
//
// Shared file-watcher helper for `LocalBrigadeStore` subscribe methods.
//
// Same pattern as `core/server.ts:H1` hot-reload watcher:
//   1. `fs.watch` on each target path (non-persistent so the watcher doesn't
//      keep the event loop alive when the user wants to exit)
//   2. 500 ms debounce — editor atomic-write bursts (rename + write + close)
//      and tools that touch the file in rapid succession coalesce into one
//      callback
//   3. Idempotent unsubscribe — safe to call multiple times
//   4. Best-effort: a `fs.watch` failure logs once and returns a dead unsub
//      rather than throwing (matches existing watcher semantics in server.ts)
//
// Implementation note: Node's `fs.watch` is platform-dependent (inotify on
// Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows). It can
// occasionally miss events on edge filesystem operations (NFS / SMB /
// CIFS), so the storage subscribe contract is "callback is best-effort, not
// guaranteed every change". Callers that need exact event delivery should
// re-poll inside their callback.

import { watch, type FSWatcher } from "node:fs";

export interface FileWatcherOptions {
	/** Coalesce-debounce window in ms. Default 500 ms — matches the existing
	 *  brigade.json hot-reload watcher in core/server.ts. */
	debounceMs?: number;
	/** Optional error sink. Defaults to silent (the storage layer doesn't have
	 *  a logger handle this deep; callers that care wire one through). */
	onError?: (err: Error) => void;
}

/**
 * Watch a single file path. Returns an idempotent unsubscribe handle.
 *
 * The callback fires AFTER the debounce window, NOT on the raw `fs.watch`
 * event — same as the brigade.json hot-reload pattern.
 */
export function watchFile(
	filePath: string,
	onChange: () => void,
	opts: FileWatcherOptions = {},
): () => void {
	const debounceMs = opts.debounceMs ?? 500;
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const fire = (): void => {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (stopped) return;
			try {
				onChange();
			} catch (err) {
				opts.onError?.(err instanceof Error ? err : new Error(String(err)));
			}
		}, debounceMs);
	};

	try {
		// `persistent: false` so the watcher doesn't keep the event loop alive.
		// `recursive: false` (default) — single file, no need to walk.
		watcher = watch(filePath, { persistent: false }, () => fire());
		watcher.on("error", (err: Error) => {
			opts.onError?.(err);
		});
	} catch (err) {
		opts.onError?.(err instanceof Error ? err : new Error(String(err)));
		// Return a dead unsub so callers stay compositional.
		return () => undefined;
	}

	return () => {
		if (stopped) return;
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		try {
			watcher?.close();
		} catch {
			// Idempotent close — ignore any "already closed" / ENOENT noise.
		}
	};
}

/**
 * Watch a directory for any-file change. The callback fires (debounced) on
 * the FIRST event in a burst — receives the affected filename. Useful for
 * "did anything under this dir change?" use cases like persona files
 * (`<workspaceDir>/*.md`) where individual `fs.watch(filePath)` would need
 * N watchers.
 */
export function watchDirectory(
	dirPath: string,
	onChange: (filename: string | undefined) => void,
	opts: FileWatcherOptions = {},
): () => void {
	const debounceMs = opts.debounceMs ?? 500;
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pendingFilename: string | undefined;
	let stopped = false;

	const fire = (filename: string | undefined): void => {
		if (stopped) return;
		// Keep the most recent filename — debounce wins on the latest event.
		pendingFilename = filename ?? pendingFilename;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (stopped) return;
			const f = pendingFilename;
			pendingFilename = undefined;
			try {
				onChange(f);
			} catch (err) {
				opts.onError?.(err instanceof Error ? err : new Error(String(err)));
			}
		}, debounceMs);
	};

	try {
		watcher = watch(dirPath, { persistent: false }, (_event, filename) => {
			fire(typeof filename === "string" ? filename : undefined);
		});
		watcher.on("error", (err: Error) => {
			opts.onError?.(err);
		});
	} catch (err) {
		opts.onError?.(err instanceof Error ? err : new Error(String(err)));
		return () => undefined;
	}

	return () => {
		if (stopped) return;
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		try {
			watcher?.close();
		} catch {
			// Idempotent close.
		}
	};
}
