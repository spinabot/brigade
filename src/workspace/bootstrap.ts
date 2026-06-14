import fs from "node:fs/promises";
import path from "node:path";

import { workspaceIdFromDir } from "../storage/facts-cache.js";
import { ensureAgentInWorkspaceLiveMirror } from "../storage/workspace-live-mirror.js";
import { tryLoadWorkspaceTemplate } from "./template-loader.js";
import { markBootstrapSeeded } from "./state.js";
import { fileExists } from "./fs-utils.js";
import { ensureWorkspaceGitRepo } from "./git-init.js";

// The 7 files a fresh brigade install drops into <agentDir>/workspace/.
// MEMORY.md is intentionally absent — it materialises lazily on the first
// dream cycle, not at onboard time.
//
// Content for each file lives on disk under templates/workspace/<name> so
// users can edit a single source-of-truth without recompiling. The loader
// resolves the templates dir lazily (package-root → cwd → fallback) and
// caches the result for the process lifetime.

export const WORKSPACE_FILE_NAMES = [
  "AGENTS.md",
  "BOOTSTRAP.md",
  "IDENTITY.md",
  "SOUL.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "USER.md",
] as const;

export type WorkspaceFileName = (typeof WORKSPACE_FILE_NAMES)[number];

export interface BootstrapResult {
  workspaceDir: string;
  // Absolute paths of files this run created.
  created: string[];
  // Absolute paths of files that were already present (left untouched).
  preserved: string[];
  // Names of templates the loader couldn't find — surfaced so the caller
  // can warn the user that their templates dir is incomplete.
  missingTemplates: WorkspaceFileName[];
  // True only when this run ran `git init` on a truly fresh workspace.
  // False on re-onboard, on workspaces that already have `.git/`, and on
  // hosts where `git` isn't available.
  gitInitialised: boolean;
  // True when the workspace looked freshly created (no persona files,
  // no `memory/`, no `.git/`). Drives whether BOOTSTRAP.md gets seeded
  // — a customised workspace skips the BOOTSTRAP write so the user's
  // first-run script doesn't get resurrected.
  brandNewWorkspace: boolean;
}

export async function bootstrapWorkspace(workspaceDir: string): Promise<BootstrapResult> {
  await fs.mkdir(workspaceDir, { recursive: true });

  // Brand-new probe: a workspace counts as "freshly created" only when
  // none of the persona files, memory dir, or git repo are present yet.
  // On a customised workspace we skip BOOTSTRAP.md (so re-onboard doesn't
  // resurrect the first-run script) and skip the git init (the user's
  // existing repo state is theirs).
  const brandNewWorkspace = await isBrandNewWorkspace(workspaceDir);

  // Create memory/ early so a partial failure in the persona-file loop
  // still leaves a usable workspace skeleton; the dream cycle populates
  // it lazily on first run.
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });

  const created: string[] = [];
  const preserved: string[] = [];
  const missingTemplates: WorkspaceFileName[] = [];

  for (const name of WORKSPACE_FILE_NAMES) {
    // BOOTSTRAP.md is special: only seed it when the workspace is truly
    // brand-new. A user who's already gone through the first-run flow
    // (and deleted BOOTSTRAP.md) shouldn't see it reappear when re-running
    // onboard for any other reason.
    if (name === "BOOTSTRAP.md" && !brandNewWorkspace) continue;

    const filePath = path.join(workspaceDir, name);

    const template = await tryLoadWorkspaceTemplate(name);
    if (!template) {
      missingTemplates.push(name);
      continue;
    }

    // flag:"wx" creates the file only if it doesn't exist. EEXIST means a
    // concurrent process (or a prior onboard run) wrote the file first —
    // preserve their copy rather than racing into a clobber.
    try {
      await fs.writeFile(filePath, template.content, {
        encoding: "utf-8",
        flag: "wx",
      });
      created.push(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        preserved.push(filePath);
        continue;
      }
      throw err;
    }
  }

  // Stamp the lifecycle marker if BOOTSTRAP.md is now on disk (whether
  // we just wrote it or it was already there). The agent kernel uses this
  // to decide whether the next turn is a first-run greeting or business
  // as usual.
  const bootstrapPath = path.join(workspaceDir, "BOOTSTRAP.md");
  if (await fileExists(bootstrapPath)) {
    await markBootstrapSeeded(workspaceDir);
  }

  // git init only on truly brand-new workspaces. The git-init helper
  // additionally guards on `.git/` already existing, so this is doubly
  // safe against clobbering an existing repo.
  let gitInitialised = false;
  if (brandNewWorkspace) {
    const result = await ensureWorkspaceGitRepo(workspaceDir);
    gitInitialised = result.initialised;
  }

  // Convex-mode durability: register this workspace with the LIVE mirror
  // and push the just-seeded persona files immediately. The mirror's watch
  // set was built at gateway boot from the config — an agent created
  // MID-SESSION (manage_agent add / org init) wasn't in it, so its
  // personas existed only on disk until the next boot and a wipe in that
  // window lost them (skills, which dual-write, were durably mirrored;
  // personas were not). No-op in filesystem mode / when the mirror isn't
  // running; idempotent for already-watched agents.
  ensureAgentInWorkspaceLiveMirror(workspaceIdFromDir(workspaceDir));

  return {
    workspaceDir,
    created,
    preserved,
    missingTemplates,
    gitInitialised,
    brandNewWorkspace,
  };
}

// A workspace is "brand new" iff none of the canonical persona files,
// the memory dir, the git dir, or the lifecycle marker exist yet. Any
// of those signals indicates the user has already worked in this
// workspace and we shouldn't re-seed BOOTSTRAP.md or run `git init`.
async function isBrandNewWorkspace(workspaceDir: string): Promise<boolean> {
  const probes = [
    ...WORKSPACE_FILE_NAMES.map((n) => path.join(workspaceDir, n)),
    path.join(workspaceDir, "memory"),
    path.join(workspaceDir, ".git"),
    path.join(workspaceDir, ".brigade", "workspace-state.json"),
  ];
  for (const p of probes) {
    if (await fileExists(p)) return false;
  }
  return true;
}


