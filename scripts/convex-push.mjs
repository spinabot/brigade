#!/usr/bin/env node
// scripts/convex-push.mjs — deploy convex/ functions to the target backend.
//
//   npm run convex:push
//
// TWO targets, auto-detected:
//   • CLOUD  — when CONVEX_DEPLOY_KEY is set (Convex dashboard → deployment →
//     Settings → "Deploy key"). Runs `convex deploy` against the cloud
//     deployment the key belongs to. No admin key, no self-hosted env.
//   • SELF-HOSTED (default) — reads the admin key minted by convex-dev.mjs and
//     deploys to the local backend (default http://127.0.0.1:3210).
//
// Idempotent — run any time the functions or schema change. `npm run convex:dev`
// runs the self-hosted path automatically once the backend is up. WITHOUT a push,
// a fresh deployment has NO functions and every call fails with "Could not find
// public function 'health:ping'" — which the runtime otherwise surfaces as the
// misleading "backend unreachable". This is exactly why pointing Brigade at a
// *.convex.cloud URL "didn't work": the cloud deployment was empty.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Honor the data dir `brigade convex` resolves + exports — matching
// convex-dev.mjs. A GLOBAL install mints the self-hosted admin key at
// ~/.brigade/convex/data (via BRIGADE_CONVEX_DATA_DIR); without reading it here,
// `brigade convex dev`'s auto-push looked at <pkg>/.convex-data, missed the
// admin key, and died with "No Convex target" — so the backend booted with ZERO
// functions deployed and onboarding later crashed at health:ping.
const DATA_DIR = process.env.BRIGADE_CONVEX_DATA_DIR?.trim() || join(ROOT, ".convex-data");

// Pre-clean: compiled .js/.js.map artifacts INSIDE convex/ make the bundler
// fail with "Two output files share the same path" (it treats both the .ts
// and the stray .js as entry points). Sweep them before every deploy so no
// future emitter can re-break deploys. `_generated/` is the CLI's own output
// and is exempt (readdir is non-recursive).
const convexDir = join(ROOT, "convex");
let cleaned = 0;
for (const name of readdirSync(convexDir)) {
  if (name.endsWith(".js") || name.endsWith(".js.map")) {
    rmSync(join(convexDir, name), { force: true });
    cleaned += 1;
  }
}
if (cleaned > 0) {
  console.log(`▌ Removed ${cleaned} stray compiled artifact(s) from convex/ (deploy-breaking).`);
}

const deployKey = process.env.CONVEX_DEPLOY_KEY?.trim();

let env;
let target;
if (deployKey) {
  // CLOUD: the deploy key encodes the deployment, so `convex deploy` resolves
  // the URL from it. Crucially, DO NOT pass CONVEX_SELF_HOSTED_* — setting them
  // forces the CLI into self-hosted mode and it would ignore the deploy key.
  env = { ...process.env, CONVEX_DEPLOY_KEY: deployKey };
  delete env.CONVEX_SELF_HOSTED_URL;
  delete env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  target = "Convex Cloud (via deploy key)";
} else {
  // SELF-HOSTED (local backend).
  const keyFile = join(DATA_DIR, "admin-key.txt");
  const url = process.env.CONVEX_SELF_HOSTED_URL?.trim() || "http://127.0.0.1:3210";
  if (!existsSync(keyFile) && !process.env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    console.error(
      "✖ No Convex target. Either:\n" +
        "   • CLOUD — set CONVEX_DEPLOY_KEY (Convex dashboard → deployment → Settings → Deploy key), or\n" +
        "   • SELF-HOSTED — start the local backend once: npm run convex:dev",
    );
    process.exit(1);
  }
  const adminKey =
    process.env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim() || readFileSync(keyFile, "utf8").trim();
  env = { ...process.env, CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey };
  target = url;
}

console.log(`▌ Pushing convex/ functions → ${target}`);
const res = spawnSync("npx", ["convex", "deploy", "--yes"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: true, // resolves npx.cmd on Windows
  env,
});
if (res.status === 0) {
  console.log("✓ Convex functions are up to date.");
} else {
  console.error(`✖ convex deploy exited with code ${res.status ?? "unknown"}.`);
}
process.exit(res.status ?? 1);
