#!/usr/bin/env node
/**
 * Brigade dev runner — mirrors openclaw's `scripts/run-node.mjs`. Auto-rebuilds
 * `dist/` when source has drifted, then dispatches to `brigade.mjs` (the bin
 * shim) with the user's args.
 *
 * Used by:
 *   npm run dev                 — bare invocation (defaults to TUI)
 *   npm run dev -- onboard      — run any subcommand against current source
 *   npm run dev:gateway         — equivalent of `pnpm gateway:dev` in OpenClaw
 *
 * End-users running `npm install -g brigade` never touch this — they go
 * through `brigade.mjs` directly. This is a developer ergonomic only.
 *
 * Staleness check (cheaper than OpenClaw's full build-stamp + git-head model
 * because Brigade's surface is small):
 *   1. dist/entry.js missing            → build
 *   2. tsconfig.build.json newer        → build
 *   3. Any src/**\/*.ts mtime newer than dist/entry.js → build
 *   4. BRIGADE_FORCE_BUILD=1            → build
 *
 * Otherwise skip the build and dispatch immediately.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

function statMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function findLatestSrcMtime(srcRoot) {
  let latest = null;
  const queue = [srcRoot];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Skip test files — they don't ship in dist and shouldn't trigger rebuilds.
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
      if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const m = statMtime(full);
      if (m != null && (latest == null || m > latest)) latest = m;
    }
  }
  return latest;
}

function resolveBuildRequirement({ repoRoot, distEntry, srcRoot, configFiles, env }) {
  if (env.BRIGADE_FORCE_BUILD === "1") {
    return { shouldBuild: true, reason: "force_build" };
  }
  const distMtime = statMtime(distEntry);
  if (distMtime == null) {
    return { shouldBuild: true, reason: "missing_dist_entry" };
  }
  for (const config of configFiles) {
    const m = statMtime(path.join(repoRoot, config));
    if (m != null && m > distMtime) {
      return { shouldBuild: true, reason: `${config}_newer` };
    }
  }
  const srcMtime = findLatestSrcMtime(srcRoot);
  if (srcMtime != null && srcMtime > distMtime) {
    return { shouldBuild: true, reason: "src_mtime_newer" };
  }
  return { shouldBuild: false, reason: "clean" };
}

const REASON_LABELS = {
  force_build: "BRIGADE_FORCE_BUILD=1",
  missing_dist_entry: "dist/entry.js is missing",
  src_mtime_newer: "src/ has newer files than dist/entry.js",
  clean: "clean",
};

function logRunner(message) {
  if (process.env.BRIGADE_RUNNER_LOG === "0") return;
  process.stderr.write(`[brigade] ${message}\n`);
}

function isSignalKey(signal) {
  return Object.hasOwn(SIGNAL_EXIT_CODES, signal);
}

function getSignalExitCode(signal) {
  return isSignalKey(signal) ? SIGNAL_EXIT_CODES[signal] : 1;
}

async function waitForSpawnedProcess(child) {
  let forwardedSignal = null;
  const onSigInt = () => {
    if (!forwardedSignal) {
      forwardedSignal = "SIGINT";
      try {
        child.kill?.("SIGINT");
      } catch {
        // best effort — exit handling still happens on `exit`.
      }
    }
  };
  const onSigTerm = () => {
    if (!forwardedSignal) {
      forwardedSignal = "SIGTERM";
      try {
        child.kill?.("SIGTERM");
      } catch {
        // best effort.
      }
    }
  };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  try {
    return await new Promise((resolve) => {
      child.on("exit", (exitCode, exitSignal) => {
        resolve({ exitCode, exitSignal, forwardedSignal });
      });
    });
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }
}

function getInterruptedExitCode(res) {
  if (res.exitSignal) return getSignalExitCode(res.exitSignal);
  if (res.forwardedSignal) return getSignalExitCode(res.forwardedSignal);
  return null;
}

async function runChildProcess(cmd, args, opts) {
  const child = spawn(cmd, args, opts);
  const res = await waitForSpawnedProcess(child);
  const interrupted = getInterruptedExitCode(res);
  if (interrupted !== null) return interrupted;
  return res.exitCode ?? 1;
}

async function runBuild({ repoRoot }) {
  // Invoke the typescript package's `bin/tsc` JS entry directly via node.
  // Skipping `node_modules/.bin/tsc.cmd` avoids the Windows-shell hop and
  // the `spawn shell:true` deprecation warning. The bin script has a
  // node shebang and is plain JS, so node runs it cleanly cross-platform.
  const tscEntry = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  return await runChildProcess(process.execPath, [tscEntry, "-p", "tsconfig.build.json"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
}

async function runBrigadeBin({ repoRoot, args }) {
  const binPath = path.join(repoRoot, "brigade.mjs");
  return await runChildProcess(process.execPath, [binPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
}

export async function runDevMain(params = {}) {
  const repoRoot = params.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = params.args ?? process.argv.slice(2);
  const env = params.env ?? process.env;
  const distEntry = path.join(repoRoot, "dist", "entry.js");
  const srcRoot = path.join(repoRoot, "src");
  const configFiles = ["tsconfig.json", "tsconfig.build.json", "package.json"];

  const requirement = resolveBuildRequirement({ repoRoot, distEntry, srcRoot, configFiles, env });
  if (requirement.shouldBuild) {
    logRunner(`building (${REASON_LABELS[requirement.reason] ?? requirement.reason}).`);
    const buildExit = await runBuild({ repoRoot });
    if (buildExit !== 0) {
      logRunner(`build failed (exit ${buildExit}).`);
      return buildExit;
    }
  }
  return await runBrigadeBin({ repoRoot, args });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDevMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
