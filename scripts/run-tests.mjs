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
// TYPECHECK FIRST — `npm test` DOES NOT TYPECHECK ON ITS OWN.
//
// The suite runs under `tsx`, which STRIPS types and never checks them. That
// makes every compile-time guard in this repo invisible to `npm test`:
// a `Record<BrigadeOwnKeys, true>` conformance guard, a `satisfies keyof
// ToolCall` tripwire, a discriminant pinned to Pi's own literal type — all of
// them can be violated and the suite still reports a confident green.
//
// Proven, not assumed: adding a field to `BrigadeTool` (which the tool-boundary
// guard exists to catch) left all six of its tests passing. CI caught it only
// because `ci.yml` runs `npm run typecheck` as a SEPARATE step — so the guards
// worked in CI and were decorative locally, which is precisely backwards. The
// whole point of a compile-time guard is to fail fast for the person editing.
//
// 6 seconds against a 4-minute suite. Skip with BRIGADE_SKIP_TYPECHECK=1 for a
// tight edit loop; CI never skips.
if (process.env.BRIGADE_SKIP_TYPECHECK !== "1") {
  const tc = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
    stdio: "inherit",
    shell: true,
  });
  if (tc.status !== 0) {
    console.error(
      "\ntypecheck failed — the suite was NOT run.\n" +
        "`tsx` strips types, so these errors would not have failed any test.\n" +
        "Set BRIGADE_SKIP_TYPECHECK=1 to run the suite anyway.",
    );
    process.exit(tc.status ?? 1);
  }
}

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
