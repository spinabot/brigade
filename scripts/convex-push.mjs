#!/usr/bin/env node
// scripts/convex-push.mjs — deploy convex/ functions to the LOCAL backend.
//
//   npm run convex:push
//
// Reads the admin key minted by convex-dev.mjs and runs `convex deploy`
// against the self-hosted backend (default http://127.0.0.1:3210). Idempotent
// — run any time the functions or schema change. `npm run convex:dev` also
// runs this automatically once the backend is up, so the deployed bundle can
// no longer silently drift from the code (the exact production failure:
// per-domain "Could not find public function 'auth:readAuthFile'" spam while
// the gateway limps along half-broken).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, ".convex-data");

// Pre-clean: compiled .js/.js.map artifacts INSIDE convex/ make the bundler
// fail with "Two output files share the same path" (it treats both the .ts
// and the stray .js as entry points). Historically the convex CLI's own
// deploy-time typecheck planted them (no convex/tsconfig.json → emitting
// mode — fixed by the noEmit tsconfig now in that folder), so pushes broke
// the NEXT push. Sweep them before every deploy as a belt-and-suspenders so
// no future emitter can re-break deploys. `_generated/` is the CLI's own
// output and is exempt.
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
const keyFile = join(DATA_DIR, "admin-key.txt");
const url = process.env.CONVEX_SELF_HOSTED_URL?.trim() || "http://127.0.0.1:3210";

if (!existsSync(keyFile) && !process.env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
  console.error(
    "✖ No admin key found (.convex-data/admin-key.txt). Start the backend once first: npm run convex:dev",
  );
  process.exit(1);
}
const adminKey =
  process.env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim() || readFileSync(keyFile, "utf8").trim();

console.log(`▌ Pushing convex/ functions → ${url}`);
const res = spawnSync("npx", ["convex", "deploy", "--yes"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: true, // resolves npx.cmd on Windows
  env: {
    ...process.env,
    CONVEX_SELF_HOSTED_URL: url,
    CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
  },
});
if (res.status === 0) {
  console.log("✓ Convex functions are up to date.");
} else {
  console.error(`✖ convex deploy exited with code ${res.status ?? "unknown"}.`);
}
process.exit(res.status ?? 1);
