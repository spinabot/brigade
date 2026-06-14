// src/storage/workspace-live-mirror.ts
//
// Convex-mode LIVE workspace mirror. The boot-time reconcile
// (boot.ts syncWorkspaceMirrors) is point-in-time: a persona edit made
// mid-session (Pi `write`/`edit` on AGENTS.md, the consolidator rewriting
// MEMORY.md, the agent consuming BOOTSTRAP.md) used to reach Convex only at
// the NEXT gateway boot — so everything written since the last boot died
// with the disk. This module closes that window:
//
//   • a debounced watcher per agent workspace pushes persona-file changes to
//     the personaFiles table as they happen (push direction ONLY — restore-
//     on-missing stays a boot-time concern, and deletions are NOT propagated
//     here: the boot consumed-guard owns BOOTSTRAP.md reaping, and a
//     mistakenly deleted persona must stay restorable from Convex)
//   • `enqueueWorkspaceMirrorOp` lets other live writers (lifecycle stamps in
//     workspace/state.ts, manage_skill's table dual-write) ride the same
//     serial flush chain
//   • `awaitWorkspaceMirrorFlush` force-sweeps every watched agent first, so
//     an edit still inside the debounce window is captured at CLI exit /
//     gateway shutdown rather than lost
//
// The watcher fire-callback re-diffs ALL persona files for the agent (the
// debounce coalesces a burst into one callback that only carries the LAST
// filename — trusting it would drop siblings changed in the same burst).
// Content-diffing against the last content known to be in Convex absorbs
// the boot restore writes and editor no-op saves.
//
// Filesystem mode never starts this module. Workspace stays local-
// authoritative in both modes (operator decision 2026-06-10) — this is a
// durability mirror, not an ownership change; the convex-authoritative flip
// is scoped separately in .brigade-design-docs/workspace-convex-
// authoritative-flip.md (Phase 3).

import { promises as fsp } from "node:fs";
import path from "node:path";

import { resolveAgentWorkspaceDir } from "../config/paths.js";

import { watchDirectory } from "./local/file-watcher.js";
import type { BrigadeStore, PersonaName } from "./store.js";

// Same set the boot mirror syncs (boot.ts PERSONA_NAMES).
const PERSONA_NAMES: readonly PersonaName[] = [
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"TOOLS.md",
	"BOOTSTRAP.md",
	"MEMORY.md",
	"HEARTBEAT.md",
];

interface WatchedAgent {
	agentId: string;
	workspaceDir: string;
	unsub: () => void;
}

let _store: BrigadeStore | undefined;
let _started = false;
const _watched: WatchedAgent[] = [];
// agentId -> persona name -> content last known to be in Convex.
const _lastPushed = new Map<string, Map<string, string>>();
let _chain: Promise<void> = Promise.resolve();

/** Start the live mirror for every config agent (+ "main"). Convex-mode
 *  boot calls this AFTER syncWorkspaceMirrors so the reconcile has already
 *  settled; the per-agent prime below then snapshots what Convex holds so
 *  the first watcher fire doesn't re-push unchanged files. Idempotent. */
export function startWorkspaceLiveMirror(
	store: BrigadeStore,
	cfg: Record<string, unknown>,
): void {
	if (_started) return;
	_started = true;
	_store = store;

	const agents = cfg.agents as Record<string, unknown> | undefined;
	const ids = new Set<string>(["main"]);
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults" || !key.trim()) continue;
			ids.add(key.trim());
		}
	}

	for (const agentId of ids) {
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		// Prime the last-pushed cache from Convex. On failure the cache stays
		// empty and the first sweep re-pushes every file — writePersona is an
		// idempotent upsert, so that's redundant work, not corruption.
		_chain = _chain
			.then(async () => {
				const rows = await store.workspace.listPersona(agentId);
				const m = new Map<string, string>();
				for (const r of rows) m.set(r.name, r.content);
				_lastPushed.set(agentId, m);
			})
			.catch(() => {
				/* unprimed — first sweep pushes everything */
			});
		// A workspace that was never materialised has no dir; watchDirectory
		// returns a dead unsub on ENOENT. The agent stays in `_watched` so the
		// forced sweep at drain time (which does its own fs reads) still
		// covers it; mid-session it only syncs at drain points until the next
		// boot re-attaches a live watcher.
		const unsub = watchDirectory(workspaceDir, () => {
			enqueueSweep(agentId, workspaceDir);
		});
		_watched.push({ agentId, workspaceDir, unsub });
	}
}

/** Register an agent CREATED MID-SESSION (manage_agent add / org init) with
 *  the live mirror: an immediate sweep pushes the just-seeded persona files
 *  to Convex, and a watcher covers subsequent edits. Without this, a freshly
 *  created agent's personas existed ONLY on disk until the next gateway boot
 *  — the wipe-restore promise silently broke for new agents (found
 *  2026-06-12: a 20-agent org's personas were absent from personaFiles while
 *  their skills, which dual-write immediately, were present). No-op when the
 *  mirror isn't running (filesystem mode / pre-boot — the boot reconcile
 *  owns those cases). Idempotent per agent; calling it for an already-
 *  watched agent just forces a sweep. */
export function ensureAgentInWorkspaceLiveMirror(agentId: string): void {
	if (!_started || !_store) return;
	const id = agentId.trim();
	if (!id) return;
	const existing = _watched.find((w) => w.agentId === id);
	if (existing) {
		enqueueSweep(existing.agentId, existing.workspaceDir);
		return;
	}
	const workspaceDir = resolveAgentWorkspaceDir(id);
	const unsub = watchDirectory(workspaceDir, () => {
		enqueueSweep(id, workspaceDir);
	});
	_watched.push({ agentId: id, workspaceDir, unsub });
	// Initial push of the freshly seeded files.
	enqueueSweep(id, workspaceDir);
}

function enqueueSweep(agentId: string, workspaceDir: string): void {
	const store = _store;
	if (!store) return;
	_chain = _chain
		.then(() => sweepAgentPersonas(store, agentId, workspaceDir))
		.catch(() => {
			/* sweepAgentPersonas logs per-file; never poison the chain */
		});
}

/** Push every persona file whose on-disk content differs from the last
 *  content known to be in Convex. Missing files are skipped (no delete
 *  propagation — see module header). */
async function sweepAgentPersonas(
	store: BrigadeStore,
	agentId: string,
	workspaceDir: string,
): Promise<void> {
	let cache = _lastPushed.get(agentId);
	if (!cache) {
		cache = new Map();
		_lastPushed.set(agentId, cache);
	}
	for (const name of PERSONA_NAMES) {
		try {
			let content: string;
			try {
				content = await fsp.readFile(path.join(workspaceDir, name), "utf8");
			} catch {
				continue; // absent on disk — boot reconcile owns restores/reaps
			}
			if (cache.get(name) === content) continue;
			await store.workspace.writePersona(agentId, name, content);
			cache.set(name, content);
		} catch (err) {
			console.error(
				`brigade: live workspace mirror push failed (${agentId}/${name}) — ${(err as Error).message}`,
			);
		}
	}
}

/** Ride the mirror's serial flush chain with an arbitrary live-mirror write
 *  (lifecycle stamps, manage_skill table dual-writes). Errors are logged and
 *  never poison the chain. No-op outside convex mode only by virtue of the
 *  CALLER gating — this helper itself just enqueues. */
export function enqueueWorkspaceMirrorOp(op: () => Promise<unknown>): void {
	_chain = _chain
		.then(() => op())
		.then(() => undefined)
		.catch((err) => {
			console.error(
				`brigade: workspace mirror write to convex failed — ${(err as Error).message}`,
			);
		});
}

/** Resolves when every live-mirror write enqueued so far reached the
 *  backend. Force-sweeps all watched agents first so an edit still inside
 *  the watcher debounce window (or under a dead watcher) is captured at the
 *  drain point instead of lost. */
export function awaitWorkspaceMirrorFlush(): Promise<void> {
	for (const w of _watched) enqueueSweep(w.agentId, w.workspaceDir);
	return _chain;
}

/** Close all watchers (gateway shutdown). Pending chain work is unaffected —
 *  callers drain via awaitWorkspaceMirrorFlush BEFORE disposing. */
export function disposeWorkspaceLiveMirror(): void {
	for (const w of _watched) {
		try {
			w.unsub();
		} catch {
			/* idempotent */
		}
	}
	_watched.length = 0;
	_started = false;
	_store = undefined;
}

/** Test-only. */
export function __resetWorkspaceLiveMirrorForTests(): void {
	disposeWorkspaceLiveMirror();
	_lastPushed.clear();
	_chain = Promise.resolve();
}
