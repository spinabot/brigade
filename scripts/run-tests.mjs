#!/usr/bin/env node
// scripts/run-tests.mjs — hermetic test runner.
//
// Pins BRIGADE_STATE_DIR to a fresh tempdir for the WHOLE suite (unless the
// caller already pinned one), so no test can ever read or write the
// developer's real ~/.brigade. Individual tests that mkdtemp their own state
// dir still override per-test and restore to this suite-level pin.
//
// Why: tests exercise production code whose side effects (subsystem log
// sink, cron run-log appends, channel pairing writes) resolve paths via
// resolveStateDir(). Any test file without its own env pin silently leaked
// those writes into the REAL ~/.brigade — caught 2026-06-12 when a full
// suite run deposited 35 artifacts (fake-channel pairing, burst-test cron
// runs, subsystem logs) into a freshly-reset operator state dir.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pinned = process.env.BRIGADE_STATE_DIR?.trim();
const suiteDir = pinned || mkdtempSync(join(tmpdir(), "brigade-suite-statedir-"));

// Keep the event loop alive for the whole run so tests that await unref()'d
// production timers don't get cancelled when the runner thinks the loop has
// drained (see scripts/test-keepalive.mjs). Cleared after all tests settle.
const keepAlive = pathToFileURL(join(import.meta.dirname, "test-keepalive.mjs")).href;

// QUOTE THE GLOB. `shell: true` means a shell sees this argv first, and
// `/bin/sh` (macOS/Linux default) has no `globstar`: it expands `**` as a plain
// `*`, so `src/**/*.test.ts` matched only depth-2 files — 151 of 496. The other
// 345 test files, every one nested a level deeper (src/agents/compaction/,
// src/agents/memory/, src/storage/convex/ …), silently never ran, and `npm test`
// reported a confident green over 70% of the suite untouched.
//
// Double quotes stop the shell expanding it on POSIX and are stripped by cmd.exe
// on Windows, so in both cases Node's own test runner receives the pattern and
// does the globbing itself — and Node's globber does understand `**`.
const extra = process.argv.slice(2);
const res = spawnSync("npx", ["tsx", "--import", keepAlive, "--test", '"src/**/*.test.ts"', ...extra], {
  stdio: "inherit",
  shell: true, // resolves npx.cmd on Windows
  env: { ...process.env, BRIGADE_STATE_DIR: suiteDir },
});

if (!pinned) {
  try {
    rmSync(suiteDir, { recursive: true, force: true });
  } catch {
    /* tempdir cleanup is best-effort */
  }
}
process.exit(res.status ?? 1);
