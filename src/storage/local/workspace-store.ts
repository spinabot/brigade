// src/storage/local/workspace-store.ts
//
// LocalWorkspaceStore — filesystem-mode wrapper around `src/workspace/*` +
// `src/system-prompt/workspace-loader.ts`. Implements `WorkspaceStore`.
//
// PR6 scope (additive — every method calls existing functions byte-for-byte):
//   ✓ listPersona           — loadWorkspaceContextFiles (per-turn read path)
//   ✓ getHeartbeat          — loadHeartbeatFile (below the cache boundary)
//   ✓ writePersona          — atomic tmp+rename direct (no existing single-
//                              file writer; mirrors bootstrap's flag:"wx"
//                              semantics with createOnly opt-in)
//   ✓ readState             — readWorkspaceState
//   ✓ markBootstrapSeeded   — markBootstrapSeeded
//   ✓ markSetupCompleted    — markSetupCompleted
//   ✓ isBrandNewWorkspace   — evaluateBootstrapPhase mapped to bool
//   ✓ ensureScaffold        — bootstrapWorkspace
//   ✓ subscribePersona      — no-op (chokidar watch lands later)

import * as fsAsync from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { resolveAgentWorkspaceDir } from "../../config/paths.js";
import {
	loadHeartbeatFile,
	loadWorkspaceContextFiles,
} from "../../system-prompt/workspace-loader.js";
import { bootstrapWorkspace, WORKSPACE_FILE_NAMES } from "../../workspace/bootstrap.js";
import { fileExists } from "../../workspace/fs-utils.js";
import {
	evaluateBootstrapPhase,
	markBootstrapSeeded,
	markSetupCompleted,
	readWorkspaceState,
} from "../../workspace/state.js";

import { watchDirectory } from "./file-watcher.js";

import type {
	BootstrapResult as PublicBootstrapResult,
	ContextFile,
	PersonaName,
	RevToken,
	Unsub,
	WorkspaceState,
	WorkspaceStore,
	WriteResult,
} from "../store.js";

function revFor(content: string): RevToken {
	return createHash("sha256").update(content).digest("hex") as RevToken;
}

/** Internal `ContextFile` shape — system-prompt/workspace-loader returns
 *  raw objects with `name + path + content`. Stamp the optional `updatedAt`
 *  from disk for callers that need it. */
function stampUpdatedAt(file: {
	name: string;
	path: string;
	content: string;
}): ContextFile {
	let updatedAt = 0;
	try {
		const stat = fs.statSync(file.path);
		updatedAt = stat.mtimeMs;
	} catch {
		// File may have been read inline by the loader (template). Leave 0.
	}
	return {
		name: file.name as PersonaName,
		path: file.path,
		content: file.content,
		updatedAt,
	};
}

export class LocalWorkspaceStore implements WorkspaceStore {
	constructor(private readonly _stateDir: string) {}

	async listPersona(
		agentId: string,
		opts?: { subagentMode?: boolean },
	): Promise<ContextFile[]> {
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		const files = await loadWorkspaceContextFiles(workspaceDir, {
			subagentMode: opts?.subagentMode === true,
		});
		return files.map((f) =>
			stampUpdatedAt({ name: f.name, path: f.path, content: f.content }),
		);
	}

	async getHeartbeat(agentId: string): Promise<ContextFile | undefined> {
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		const file = await loadHeartbeatFile(workspaceDir);
		if (!file) return undefined;
		return stampUpdatedAt({ name: file.name, path: file.path, content: file.content });
	}

	async writePersona(
		agentId: string,
		name: PersonaName,
		content: string,
		opts?: { createOnly?: boolean },
	): Promise<WriteResult & { created: boolean }> {
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		await fsAsync.mkdir(workspaceDir, { recursive: true });
		const filePath = path.join(workspaceDir, name);

		const existedBefore = fs.existsSync(filePath);
		if (opts?.createOnly && existedBefore) {
			// Caller asked us not to clobber. Surface created:false with the
			// current rev so they can short-circuit.
			const existing = fs.readFileSync(filePath, "utf8");
			return {
				rev: revFor(existing),
				writtenAt: Date.now(),
				created: false,
			};
		}

		// Atomic write — tmp + rename so a crash mid-write doesn't leave a
		// torn file. Matches today's bootstrap semantics minus the flag:"wx"
		// since this is the explicit-overwrite path.
		const tmp = `${filePath}.tmp.${process.pid}.${Date.now().toString(36)}`;
		await fsAsync.writeFile(tmp, content, { encoding: "utf-8" });
		await fsAsync.rename(tmp, filePath);
		return {
			rev: revFor(content),
			writtenAt: Date.now(),
			created: !existedBefore,
		};
	}

	async deletePersona(agentId: string, name: PersonaName): Promise<boolean> {
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		const filePath = path.join(workspaceDir, name);
		try {
			await fsAsync.unlink(filePath);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw err;
		}
	}

	async readState(agentId: string): Promise<WorkspaceState> {
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		const state = await readWorkspaceState(workspaceDir);
		// Cast — public type has the right shape (version, bootstrapSeededAt,
		// setupCompletedAt) by name match, but the internal type may include
		// additional fields we don't surface.
		return state as unknown as WorkspaceState;
	}

	async markBootstrapSeeded(agentId: string): Promise<void> {
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		await markBootstrapSeeded(workspaceDir);
	}

	async markSetupCompleted(agentId: string): Promise<void> {
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		await markSetupCompleted(workspaceDir);
	}

	async isBrandNewWorkspace(agentId: string): Promise<boolean> {
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		// `evaluateBootstrapPhase` returns "unseeded" | "first-turn" |
		// "in-progress" | "complete". A workspace is brand-new only when
		// unseeded AND none of the persona files / memory dir / .git are
		// present (matching the same probes bootstrap.ts uses). This
		// preserves bootstrap's "don't resurrect BOOTSTRAP.md" semantics.
		const phase = await evaluateBootstrapPhase(workspaceDir);
		if (phase !== "unseeded") return false;
		const probes = [
			...WORKSPACE_FILE_NAMES.map((n) => path.join(workspaceDir, n)),
			path.join(workspaceDir, "memory"),
			path.join(workspaceDir, ".git"),
		];
		for (const p of probes) {
			if (await fileExists(p)) return false;
		}
		return true;
	}

	async ensureScaffold(agentId: string): Promise<PublicBootstrapResult> {
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		const result = await bootstrapWorkspace(workspaceDir);
		// Map internal BootstrapResult (absolute paths) to the public surface
		// (names only) — the public interface deliberately doesn't expose disk
		// paths so convex-mode callers don't have to fake them.
		const toNames = (paths: string[]): PersonaName[] =>
			paths
				.map((p) => path.basename(p))
				.filter((n): n is PersonaName =>
					(WORKSPACE_FILE_NAMES as readonly string[]).includes(n),
				);
		return {
			created: toNames(result.created),
			alreadyPresent: toNames(result.preserved),
		};
	}

	subscribePersona(agentId: string, cb: (files: ContextFile[]) => void): Unsub {
		// Watch the agent's workspace dir non-recursively. The persona files
		// live at the dir root (AGENTS.md, SOUL.md, ...); subdir noise from
		// memory/.dreams or .git is filtered out by name match. Standard
		// 500 ms debounce coalesces editor atomic-write bursts.
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		const personaSet: Set<string> = new Set(WORKSPACE_FILE_NAMES);
		return watchDirectory(workspaceDir, (filename) => {
			// Skip events for files we don't care about (memory/, .dreams,
			// hidden state). Filename may be `undefined` on platforms where
			// fs.watch doesn't surface it — in that case re-emit, since a
			// persona file could still be the cause.
			if (filename !== undefined && !personaSet.has(filename)) return;
			void this.listPersona(agentId)
				.then((files) => {
					try {
						cb(files);
					} catch {
						// Caller threw — swallow so one bad subscriber doesn't kill
						// the watcher.
					}
				})
				.catch(() => {
					// Workspace mid-rename, dir gone, etc. — skip this firing.
				});
		});
	}
}
