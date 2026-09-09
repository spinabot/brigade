import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("../../../scripts/test-tideline-live-convex.mjs", import.meta.url));

test("Convex probe persists fixed failure evidence without network-controlled error text", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tideline-convex-report-test-"));
  const networkText = "network-controlled-report-canary";
  const preload = "data:text/javascript," + encodeURIComponent(
    'globalThis.fetch = async () => ({ ok: false, status: "network-controlled-report-canary" });',
  );
  try {
    // Download fails before any backend, imports or deployment. The injected
    // response tests the complete catch/cleanup/report path without a network.
    const child = spawnSync(process.execPath, ["--import", preload, probe, "--download"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TMPDIR: temporaryRoot,
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
      },
    });
    assert.equal(child.status, 1, child.stderr);
    const [artifact] = fs.readdirSync(temporaryRoot);
    assert.ok(artifact);
    assert.ok(artifact.startsWith("brigade-live-convex-"));
    const artifactDir = path.join(temporaryRoot, artifact);
    const resultText = fs.readFileSync(path.join(artifactDir, "result.json"), "utf8");
    const result = JSON.parse(resultText) as { status: string; error: { phase: string; category: string }; checks: string[] };
    assert.equal(result.status, "failed");
    assert.deepEqual(result.error, { phase: "resolving-backend", category: "operation" });
    assert.ok(result.checks.some((check) => check.includes("ephemeral keys and database removed")));
    assert.equal(fs.existsSync(path.join(artifactDir, "runtime")), false);
    for (const file of fs.readdirSync(artifactDir)) {
      assert.equal(fs.readFileSync(path.join(artifactDir, file), "utf8").includes(networkText), false);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
