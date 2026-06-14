#!/usr/bin/env node
// scripts/install-convex.mjs
//
// Auto-download the self-hosted Convex backend + dashboard binaries into
// F:\Brigade\bin\ (or wherever the repo lives). Zero Convex Cloud account
// needed. Runs as `npm run convex:install` and also fires on first run of
// `npm run convex:dev` if binaries are missing.
//
// What it downloads:
//   convex-local-backend-<platform>.zip   (~46 MB)
//   dashboard.zip                          (~3 MB)
//   LICENSE.md
//
// Source: github.com/get-convex/convex-backend releases.
// License (verified): FSL-1.1-Apache-2.0 — Permitted Purpose for Brigade.

import { existsSync, mkdirSync, createWriteStream, readFileSync } from "node:fs";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(ROOT, "bin");
const BACKEND_BIN = join(BIN_DIR, process.platform === "win32" ? "convex-local-backend.exe" : "convex-local-backend");
const DASHBOARD_DIR = join(BIN_DIR, "dashboard");

// ---------------------------------------------------------------------------
// Pin to a known-good release. Update this when a new Convex backend is needed.
// Find latest tags at:
//   https://github.com/get-convex/convex-backend/releases
// ---------------------------------------------------------------------------
const RELEASE_TAG = "precompiled-2026-06-03-7eff2e7";
const RELEASE_BASE = `https://github.com/get-convex/convex-backend/releases/download/${RELEASE_TAG}`;

function platformAsset() {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32"  && a === "x64")   return "convex-local-backend-x86_64-pc-windows-msvc.zip";
  if (p === "darwin" && a === "arm64") return "convex-local-backend-aarch64-apple-darwin.zip";
  if (p === "darwin" && a === "x64")   return "convex-local-backend-x86_64-apple-darwin.zip";
  if (p === "linux"  && a === "x64")   return "convex-local-backend-x86_64-unknown-linux-gnu.zip";
  if (p === "linux"  && a === "arm64") return "convex-local-backend-aarch64-unknown-linux-gnu.zip";
  throw new Error(`Unsupported platform ${p}/${a}. Brigade ships Convex backend binaries for: win-x64, mac-x64, mac-arm64, linux-x64, linux-arm64.`);
}

async function download(url, destPath) {
  console.log(`  → ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

async function unzip(zipPath, destDir) {
  // Cross-platform unzip via PowerShell on Windows, `unzip` elsewhere.
  await mkdir(destDir, { recursive: true });
  if (process.platform === "win32") {
    await runCmd("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destDir}'`,
    ]);
  } else {
    await runCmd("unzip", ["-o", zipPath, "-d", destDir]);
  }
}

function runCmd(cmd, args) {
  return new Promise((resolveProm, rejectProm) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => code === 0 ? resolveProm() : rejectProm(new Error(`${cmd} exited ${code}`)));
    child.on("error", rejectProm);
  });
}

async function main() {
  mkdirSync(BIN_DIR, { recursive: true });
  const asset = platformAsset();
  const backendZip = join(BIN_DIR, "_backend.zip");
  const dashboardZip = join(BIN_DIR, "_dashboard.zip");
  const licensePath = join(BIN_DIR, "LICENSE.md");

  const haveBackend = existsSync(BACKEND_BIN);
  const haveDashboard = existsSync(DASHBOARD_DIR) && existsSync(join(DASHBOARD_DIR, "index.html"));
  const haveLicense = existsSync(licensePath);

  if (haveBackend && haveDashboard && haveLicense) {
    console.log(`✓ Convex binaries already present in ${BIN_DIR}`);
    return;
  }

  console.log(`Installing Convex local backend + dashboard for ${process.platform}/${process.arch}`);
  console.log(`  Release: ${RELEASE_TAG}`);
  console.log(`  Bin dir: ${BIN_DIR}`);
  console.log();

  if (!haveBackend) {
    await download(`${RELEASE_BASE}/${asset}`, backendZip);
    await unzip(backendZip, BIN_DIR);
    await unlink(backendZip).catch(() => {});
  }

  if (!haveDashboard) {
    await download(`${RELEASE_BASE}/dashboard.zip`, dashboardZip);
    await unzip(dashboardZip, DASHBOARD_DIR);
    await unlink(dashboardZip).catch(() => {});
  }

  if (!haveLicense) {
    await download(`${RELEASE_BASE}/LICENSE.md`, licensePath);
  }

  console.log();
  console.log(`✓ Installed Convex backend + dashboard.`);
  console.log(`  License: FSL-1.1-Apache-2.0 (see bin/LICENSE.md)`);
  console.log(`  Next:   npm run convex:dev`);
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
