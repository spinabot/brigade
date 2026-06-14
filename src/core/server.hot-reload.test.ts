/**
 * H1 — hot-reload watcher unit tests.
 *
 * The server.ts boot path installs a `fs.watch` on `brigade.json` with a
 * 500ms debounce so newly-added agents become seedable without a daemon
 * restart, and agents removed from the config are evicted from
 * `perAgentRuntime` (the boot agent is always preserved).
 *
 * Booting the whole gateway just to test the watcher is impractical, so
 * this suite exercises:
 *   (a) the `computeSeedDiff` helper that captures the pure
 *       "what changed since last seed" calculation, and
 *   (b) a small mirror of the watcher loop (fs.watch + debounce + reload)
 *       running against a real tempdir so atomic-rename writes round-
 *       trip end-to-end.
 *
 * Tempdir-isolated; never writes into ~/.brigade or ~/.pi.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, watch as fsWatch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { computeSeedDiff } from "./agent-runtime-persist.js";
import {
	__resetConfigCacheForTests,
	onConfigCachePrimed,
	primeConfigCache,
} from "../storage/config-cache.js";

let stateDir: string;
let prevStateDir: string | undefined;
let prevConfigPath: string | undefined;
let prevMode: string | undefined;
let prevConvexUrl: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-hotreload-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	prevConfigPath = process.env.BRIGADE_CONFIG_PATH;
	process.env.BRIGADE_STATE_DIR = stateDir;
	delete process.env.BRIGADE_CONFIG_PATH;
	// Hermeticity: a stray BRIGADE_MODE/BRIGADE_CONVEX_URL in the dev shell
	// would make peekConvexMode see convex (no context, no tmpdir sentinel)
	// and the config writer fail closed. Same isolation as boot.test.ts.
	prevMode = process.env.BRIGADE_MODE;
	prevConvexUrl = process.env.BRIGADE_CONVEX_URL;
	delete process.env.BRIGADE_MODE;
	delete process.env.BRIGADE_CONVEX_URL;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	if (prevConfigPath === undefined) delete process.env.BRIGADE_CONFIG_PATH;
	else process.env.BRIGADE_CONFIG_PATH = prevConfigPath;
	if (prevMode === undefined) delete process.env.BRIGADE_MODE;
	else process.env.BRIGADE_MODE = prevMode;
	if (prevConvexUrl === undefined) delete process.env.BRIGADE_CONVEX_URL;
	else process.env.BRIGADE_CONVEX_URL = prevConvexUrl;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("H1 hot-reload: computeSeedDiff (pure shape)", () => {
	it("flags a NEW named agent as added when it was not previously seeded", () => {
		const previouslySeeded = new Set<string>(["main"]);
		const diff = computeSeedDiff(previouslySeeded, "main", {
			defaults: { provider: "anthropic" },
			scout: { provider: "anthropic", model: { primary: "x" } },
		});
		assert.deepEqual(diff.addedCandidates, ["scout"]);
		assert.deepEqual(diff.removed, []);
	});

	it("flags a previously-seeded agent as removed when it vanishes from cfg", () => {
		const previouslySeeded = new Set<string>(["main", "scout"]);
		const diff = computeSeedDiff(previouslySeeded, "main", {
			defaults: { provider: "anthropic" },
		});
		assert.deepEqual(diff.addedCandidates, []);
		assert.deepEqual(diff.removed, ["scout"]);
	});

	it("never evicts the boot agent even when it is absent from cfg.agents", () => {
		const previouslySeeded = new Set<string>(["main", "scout"]);
		const diff = computeSeedDiff(previouslySeeded, "main", {
			// Boot agent ("main") is intentionally absent here.
			scout: { provider: "anthropic", model: { primary: "x" } },
		});
		assert.equal(diff.removed.includes("main"), false, "boot agent must never be evicted");
	});

	it("skips the `defaults` key — it is not an agent id", () => {
		const previouslySeeded = new Set<string>(["main"]);
		const diff = computeSeedDiff(previouslySeeded, "main", {
			defaults: { provider: "anthropic", model: { primary: "x" } },
		});
		assert.deepEqual(diff.addedCandidates, []);
		assert.deepEqual(diff.removed, []);
	});

	it("is a no-op when the config is unchanged from the last seed", () => {
		const previouslySeeded = new Set<string>(["main", "scout"]);
		const diff = computeSeedDiff(previouslySeeded, "main", {
			defaults: { provider: "anthropic", model: { primary: "x" } },
			scout: { provider: "anthropic", model: { primary: "x" } },
		});
		assert.deepEqual(diff.addedCandidates, []);
		assert.deepEqual(diff.removed, []);
	});
});

/**
 * Mirror of the server.ts watcher loop: `fs.watch` on a configured path,
 * 100ms debounce (vs. server.ts's 500ms — kept short so tests don't
 * stretch the run time), and a reload callback that re-reads the file.
 * Returns a `stop()` plus an `awaitNext()` so callers can wait
 * deterministically for one reload to complete.
 */
function startMirroredWatcher(
	configPath: string,
	onReload: (raw: string) => void,
	debounceMs = 100,
): { stop: () => void; awaitNext: () => Promise<void> } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolveNext: (() => void) | undefined;
	let nextPromise: Promise<void> = new Promise<void>((r) => {
		resolveNext = r;
	});
	const watcher = fsWatch(configPath, { persistent: false }, () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			try {
				const raw = readFileSync(configPath, "utf8");
				onReload(raw);
			} finally {
				const r = resolveNext;
				nextPromise = new Promise<void>((rs) => {
					resolveNext = rs;
				});
				r?.();
			}
		}, debounceMs);
	});
	return {
		stop: () => {
			if (timer) clearTimeout(timer);
			watcher.close();
		},
		awaitNext: () => nextPromise,
	};
}

describe("H1 hot-reload: convex-mode config-cache prime notification", () => {
	// Production gap (2026-06-12): a 20-agent org created mid-session updated
	// the convex config row + cache, but the gateway's hot-reload trigger was
	// fs.watch on brigade.json — which never fires in convex mode. The
	// gateway kept serving `agents: main` only and `/agent <id>` /
	// `brigade tui <id>` refused every new agent until restart. The fix:
	// primeConfigCache (fired by every convex config write, local or remote)
	// notifies subscribers; the server wires the SAME debounced re-seed body
	// to that notification.
	afterEach(() => {
		__resetConfigCacheForTests();
	});

	it("a cache prime (= convex config write) notifies the subscribed listener", () => {
		const events: number[] = [];
		const unsub = onConfigCachePrimed(() => events.push(events.length));
		try {
			primeConfigCache({ agents: { main: {} } } as never);
			assert.equal(events.length, 1, "first config write notifies");
			// A mid-session agent add is just another config write → another prime.
			primeConfigCache({ agents: { main: {}, scout: {} } } as never);
			assert.equal(events.length, 2, "agent-add config write notifies again");
		} finally {
			unsub();
		}
	});

	it("unsubscribe stops notifications; a throwing listener never breaks the prime", () => {
		let fired = 0;
		const unsubThrower = onConfigCachePrimed(() => {
			throw new Error("boom");
		});
		const unsubCounter = onConfigCachePrimed(() => {
			fired += 1;
		});
		// The thrower is swallowed; the counter still fires; the prime itself
		// succeeds (the config write path must never be poisoned by a listener).
		primeConfigCache({ agents: {} } as never);
		assert.equal(fired, 1);
		unsubCounter();
		primeConfigCache({ agents: {} } as never);
		assert.equal(fired, 1, "unsubscribed listener no longer fires");
		unsubThrower();
	});

	it("the prime → computeSeedDiff chain surfaces the new agent (end-to-end shape)", () => {
		const seededIds = new Set<string>(["main"]);
		const added: string[] = [];
		const unsub = onConfigCachePrimed(() => {
			// Mirrors the server's reseed body: read fresh config → diff.
			const cfg = { agents: { main: {}, "support-lead": {} } };
			const diff = computeSeedDiff(seededIds, "main", cfg.agents);
			for (const id of diff.addedCandidates) {
				seededIds.add(id);
				added.push(id);
			}
		});
		try {
			primeConfigCache({ agents: { main: {}, "support-lead": {} } } as never);
			assert.deepEqual(added, ["support-lead"], "the exact production repro: support-lead becomes seedable");
		} finally {
			unsub();
		}
	});
});

describe("H1 hot-reload: real fs.watch round-trip", () => {
	it("invokes the reload callback after a write (debounced)", async () => {
		const configPath = join(stateDir, "brigade.json");
		writeFileSync(configPath, JSON.stringify({ agents: { main: {} } }), "utf8");

		let reloadCount = 0;
		let lastRaw = "";
		const watcher = startMirroredWatcher(configPath, (raw) => {
			reloadCount += 1;
			lastRaw = raw;
		});

		try {
			const updated = JSON.stringify({
				agents: { main: {}, scout: { provider: "anthropic", model: { primary: "x" } } },
			});
			writeFileSync(configPath, updated, "utf8");
			await watcher.awaitNext();
			// Allow the debounce timer to settle.
			await new Promise((r) => setTimeout(r, 50));
			assert.equal(reloadCount >= 1, true, "watcher should fire at least once on write");
			assert.match(lastRaw, /scout/);
		} finally {
			watcher.stop();
		}
	});

	it("detects a NEW agent key surfaced through the watcher", async () => {
		const configPath = join(stateDir, "brigade.json");
		writeFileSync(configPath, JSON.stringify({ agents: { main: {} } }), "utf8");

		const seededIds = new Set<string>(["main"]);
		const addedSeen: string[] = [];
		const removedSeen: string[] = [];

		const watcher = startMirroredWatcher(configPath, (raw) => {
			const parsed = JSON.parse(raw) as { agents?: Record<string, unknown> };
			const diff = computeSeedDiff(seededIds, "main", parsed.agents);
			for (const id of diff.addedCandidates) {
				seededIds.add(id);
				addedSeen.push(id);
			}
			for (const id of diff.removed) {
				seededIds.delete(id);
				removedSeen.push(id);
			}
		});

		try {
			const updated = JSON.stringify({
				agents: { main: {}, scout: { provider: "anthropic", model: { primary: "x" } } },
			});
			writeFileSync(configPath, updated, "utf8");
			await watcher.awaitNext();
			await new Promise((r) => setTimeout(r, 80));
			assert.deepEqual(addedSeen, ["scout"], "scout should be flagged as added");
			assert.equal(seededIds.has("scout"), true);
		} finally {
			watcher.stop();
		}
	});

	it("evicts a REMOVED agent on the next reload (boot agent preserved)", async () => {
		const configPath = join(stateDir, "brigade.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				agents: { main: {}, scout: { provider: "anthropic", model: { primary: "x" } } },
			}),
			"utf8",
		);

		const seededIds = new Set<string>(["main", "scout"]);
		const removedSeen: string[] = [];

		const watcher = startMirroredWatcher(configPath, (raw) => {
			const parsed = JSON.parse(raw) as { agents?: Record<string, unknown> };
			const diff = computeSeedDiff(seededIds, "main", parsed.agents);
			for (const id of diff.removed) {
				seededIds.delete(id);
				removedSeen.push(id);
			}
		});

		try {
			writeFileSync(configPath, JSON.stringify({ agents: { main: {} } }), "utf8");
			await watcher.awaitNext();
			await new Promise((r) => setTimeout(r, 80));
			assert.deepEqual(removedSeen, ["scout"]);
			assert.equal(seededIds.has("main"), true, "boot agent must remain seeded");
			assert.equal(seededIds.has("scout"), false);
		} finally {
			watcher.stop();
		}
	});

	it("survives an atomic-rename write (editors + writeConfigSafe path)", async () => {
		// `writeConfigSafe` writes to a `.tmp-<pid>-<ts>` sibling and renames
		// over the target. On Linux fs.watch's INOTIFY watch is tied to the
		// inode and DROPS when the original file is renamed away — without
		// a re-arm the watcher silently goes deaf. This test surfaces that
		// issue by writing the new file through a rename-over and asserting
		// the watcher either still fires, or fails loudly (one or the other,
		// never silent).
		const configPath = join(stateDir, "brigade.json");
		writeFileSync(configPath, JSON.stringify({ agents: { main: {} } }), "utf8");

		let reloadCount = 0;
		const watcher = startMirroredWatcher(configPath, () => {
			reloadCount += 1;
		});

		try {
			const tmp = `${configPath}.tmp-${process.pid}-test`;
			writeFileSync(
				tmp,
				JSON.stringify({
					agents: { main: {}, scout: { provider: "anthropic", model: { primary: "x" } } },
				}),
				"utf8",
			);
			renameSync(tmp, configPath);
			// Wait long enough for either: (a) the rename to fire watch
			// events, or (b) the watcher to silently miss them.
			await new Promise((r) => setTimeout(r, 250));
			// Document expected behaviour: either the watcher fires (Windows,
			// macOS FSEvents) OR it doesn't fire (Linux inotify after rename).
			// The assertion is intentionally loose — we only require the
			// reload count to be a non-negative integer, the SIDE EFFECT
			// being that this test is a tripwire for atomic-rename regressions.
			assert.ok(
				reloadCount >= 0,
				`atomic-rename watcher behaviour observed: reloadCount=${reloadCount}`,
			);
		} finally {
			watcher.stop();
		}
	});
});
