# Brigade — Agent Instructions

From-scratch rebuild whose architecture is informed by an internal reference
codebase audit. Brigade borrows that prior system's *patterns* and *invariants*
— never its name, paths, or branding.

## Naming rules (MUST follow)

- The product is **Brigade**. Never write the prior reference codebase's name
  anywhere — code, comments, user-facing output, env vars, daemon labels,
  paths, or docs.
- Storage dir: `~/.brigade/` (env override: `BRIGADE_STATE_DIR`)
- Config file: `~/.brigade/brigade.json` (env override: `BRIGADE_CONFIG_PATH`)
- Daemon labels:
  - macOS: `ai.brigade.gateway` (launchd plist `com.brigade.gateway.plist`)
  - Linux: `brigade-gateway` (systemd unit)
  - Windows: `Brigade Gateway` (Task Scheduler + HKCU\...\Run)
- Agent SDK in code/docs is **only** `pi` / `@mariozechner/pi-coding-agent`.
  Never name any other 3rd-party AI coding agent project — in source,
  comments, copy, or docs.

## Architecture invariants (mirrored from the reference audit)

- **Auth files** live at `<agentDir>/agent/{auth-profiles,auth-state,models}.json`
  with mode `0600` — NOT under a hidden `.brigade/` subfolder.
- **Sessions** are Pi SDK JSONL transcripts: `<agentDir>/sessions/<sessionId>.jsonl`.
  One file per session. The session-key index lives at
  `<agentDir>/sessions/sessions.json`.
- **Workspace** in a fresh install has **7 files**: `AGENTS.md`, `BOOTSTRAP.md`,
  `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md`. `MEMORY.md`
  is created lazily on the first dream cycle, not at onboard.
- **Tasks** are SQLite-persisted at `~/.brigade/tasks/runs.sqlite` (+ WAL/SHM).
  Never store task runs only in memory.
- **Config rotation**: 5 forensic snapshots — `.bak` + `.bak.{1..4}` — with all backup files hardened to mode 0600 on POSIX after each rotation.
- **Secrets** in `brigade.json`: `${VAR_NAME}` references must be RESTORED on
  write — the resolved value never persists to disk.
- **Heartbeat**: workspace-driven via `HEARTBEAT.md`, default 30m, strip the
  `HEARTBEAT_OK` token from agent output before sending.

## Build & package management

- **Brigade is an npm project — never `pnpm` / `pnpx`.** All scripts, README,
  error messages, and chat-side suggestions must use `npm` / `npx`.
- TypeScript → `dist/` via `tsc`. No bundler at this stage.
- `npm run dev -- onboard` runs `src/entry.ts` directly via `tsx` for fast iteration.
- `npm run brigade -- <args>` runs the built `dist/entry.js` via the `brigade.mjs` shim.

## Commit policy

- Never add a `Co-Authored-By: Claude` trailer (per user's repo-wide rule).
- Commit messages explain *why*, not *what*.

## Convex (local self-hosted backend)

Brigade Phase 2 uses Convex as a swap-in storage adapter. The dev loop is
**fully self-hosted** — no Convex Cloud account, no telemetry, no `npx convex
dev` cloud handshake.

- `npm run convex:install` — downloads the standalone `convex-local-backend`
  Rust binary + static dashboard from the official GitHub release (pin
  `precompiled-2026-06-03-7eff2e7`) into `bin/`. Skipped if already present.
  License: FSL-1.1-Apache-2.0 (see `bin/LICENSE.md`).
- `npm run convex:dev` — runs install (no-op if cached) then starts:
  - backend  → `http://127.0.0.1:3210` (Convex API)
  - site proxy → `http://127.0.0.1:3211` (http actions)
  - dashboard → `http://127.0.0.1:6791` (static SPA — add the local deployment
    by URL `http://127.0.0.1:3210` + the contents of `.convex-data/admin-key.txt`)
- `npm run convex:codegen` — regenerates `convex/_generated/` against the
  running local backend using the derived admin key.

Per-machine state lives under `F:\Brigade\.convex-data\` (gitignored):
  - `identity.json`              — stable instance name + secret (generated once)
  - `admin-key.txt`              — derived from identity at every run
  - `convex_local_backend.sqlite3` — Convex's SQLite engine file
  - `storage/`                   — Convex File Storage objects (local fs)
  - `logs/`                      — backend stderr captures

`.env.local` is also generated per-run (gitignored) and exports:
  - `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY` (for `npx convex` CLI)
  - `CONVEX_URL` (for client-side code)

**Auditor notes:**
- The backend binary phones home to a Convex beacon by default. Brigade does
  **not** disable it (the dev loop should reflect what OSS users see), but
  `--disable-beacon` / `DISABLE_BEACON=1` is available if a deployment needs
  to stay strictly air-gapped.
- `npx convex dev` IS allowed in this repo — but ONLY when the self-hosted
  env vars are active (`CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY`,
  both written to `.env.local` by `scripts/convex-dev.mjs`). Then the Convex
  CLI talks straight to `http://127.0.0.1:3210` and never touches cloud.
  Without those env vars, `npx convex dev` will try to create/claim a cloud
  project — DON'T run it in that state. Quick check: `npm run convex:dev` must
  be running first, so `.env.local` is present and current.
