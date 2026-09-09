#!/usr/bin/env node
/**
 * Opt-in integration probe against a disposable, self-hosted Convex backend.
 *
 *   node --import tsx scripts/test-tideline-live-convex.mjs --backend /path/to/convex-local-backend
 *   node --import tsx scripts/test-tideline-live-convex.mjs --download
 *
 * TIDELINE_CONVEX_BACKEND may supply the binary instead of --backend. This does
 * not use convex:dev, contact Convex Cloud, load provider credentials, change
 * repository environment files, or retain backend data/keys. Only redacted
 * results and logs remain in the printed temporary artifact directory. Error
 * details are printed to the console; reports retain fixed failure categories
 * and local operation phases only. This is
 * a correctness/recovery probe with bounded load, not a scalability benchmark.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = "precompiled-2026-06-03-7eff2e7";
const HELP = "Usage: node --import tsx scripts/test-tideline-live-convex.mjs (--backend <binary> | --download)\nAlternatively set TIDELINE_CONVEX_BACKEND. No cloud deployment or model calls.";
let suppliedBinary = process.env.TIDELINE_CONVEX_BACKEND;
let download = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--help" || arg === "-h") { console.log(HELP); process.exit(0); }
  if (arg === "--backend" && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) suppliedBinary = process.argv[++i];
  else if (arg === "--download") download = true;
  else throw new Error(`Unknown or incomplete argument: ${arg}\n${HELP}`);
}
if (Boolean(suppliedBinary) === download) throw new Error(`Choose exactly one backend source.\n${HELP}`);

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-live-convex-"));
const RUN = path.join(WORK, "runtime");
const project = path.join(RUN, "project");
const stateDir = path.join(RUN, "brigade-state");
const require = createRequire(path.join(ROOT, "package.json"));
const results = { release: suppliedBinary ? "externally-supplied-binary" : RELEASE, started: new Date().toISOString(), checks: [], timings: {} };
const instanceSecret = randomBytes(32).toString("hex");
const instanceName = "brigade-memory-probe";
// An allowlist, not a provider denylist: OPENROUTER and future provider/auth
// variables are excluded automatically. The CLI gets an inert access-token
// override so it never consults a user's cloud login configuration.
const inheritedKeys = new Set(["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => inheritedKeys.has(key)));
Object.assign(safeEnv, {
  CI: "1", BRIGADE_STATE_DIR: stateDir,
  BRIGADE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  BRIGADE_ENCRYPTION_KEY_FILE: path.join(RUN, "unused-key"),
  CONVEX_OVERRIDE_ACCESS_TOKEN: "isolated-self-hosted-probe-unused-token",
  DISABLE_BEACON: "1",
});
let binary = suppliedBinary ? path.resolve(suppliedBinary) : undefined;
let backend;
let backendLog = "";
let port;
let sitePort;
let adminKey;
let url;
let ctx;
let resetRuntimeContext;
let activeChild;
let cleaning;
let phase = "setup";
const sensitive = () => [instanceSecret, adminKey, safeEnv.BRIGADE_ENCRYPTION_KEY].filter(Boolean);
const redact = (value) => sensitive().reduce((out, token) => out.split(token).join("[redacted]"), String(value));
const envFiles = [".env.local", ".env"].map((file) => path.join(ROOT, file));
const hashEnv = () => envFiles.map((file) => fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null);
const beforeEnv = hashEnv();
const check = (name) => { results.checks.push(name); console.log(`PASS ${name}`); };

// Error messages/stacks can contain network response data. Persist only fixed
// categories; their full redacted diagnostics remain available in the console.
const failureCategory = (error) => {
  if (error?.name === "AssertionError") return "assertion";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  return "operation";
};

function platformAsset() {
  const platforms = {
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu", "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  const platform = platforms[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error(`No pinned binary for ${process.platform}/${process.arch}; use --backend.`);
  return `convex-local-backend-${platform}.zip`;
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return value;
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: project, env: safeEnv, stdio: ["ignore", "pipe", "pipe"], ...options });
  activeChild = child;
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-100000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-100000); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  try {
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error(`Probe child failed (${code}): ${redact(output.slice(-7000))}`);
    return redact(output);
  } finally {
    clearTimeout(timer);
    if (activeChild === child) activeChild = undefined;
  }
}

async function resolveBinary() {
  if (binary) { fs.accessSync(binary, fs.constants.X_OK); return; }
  const asset = platformAsset();
  const archive = path.join(RUN, "backend.zip");
  const downloadUrl = `https://github.com/get-convex/convex-backend/releases/download/${RELEASE}/${asset}`;
  console.log(`Downloading pinned self-hosted backend: ${RELEASE} (${process.platform}/${process.arch})`);
  const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Backend download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
  if (process.platform === "win32") {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    await run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(RUN)}`]);
  } else {
    await run("unzip", ["-q", archive, "-d", RUN]);
  }
  binary = path.join(RUN, process.platform === "win32" ? "convex-local-backend.exe" : "convex-local-backend");
  fs.accessSync(binary, fs.constants.X_OK);
}

async function startBackend() {
  backend = spawn(binary, ["--interface", "127.0.0.1", "--port", String(port), "--site-proxy-port", String(sitePort), "--instance-name", instanceName, "--instance-secret", instanceSecret, "--local-storage", path.join(RUN, "object-storage"), "--disable-beacon", "--do-not-require-ssl", path.join(RUN, "backend.sqlite3")], { cwd: RUN, env: safeEnv, stdio: ["ignore", "pipe", "pipe"] });
  let spawnError;
  backend.on("error", (error) => { spawnError = error; });
  backend.stdout.on("data", (chunk) => { backendLog = (backendLog + chunk).slice(-100000); });
  backend.stderr.on("data", (chunk) => { backendLog = (backendLog + chunk).slice(-100000); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (backend.exitCode !== null || backend.signalCode !== null) throw new Error(`Backend exited during startup: ${redact(backendLog.slice(-5000))}`);
    try { if ((await fetch(`${url}/version`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend startup timed out: ${redact(backendLog.slice(-3000))}`);
}

async function stopBackend(signal = "SIGTERM") {
  if (!backend?.pid || backend.exitCode !== null || backend.signalCode !== null) return;
  const stopped = once(backend, "exit");
  backend.kill(signal);
  const timeout = setTimeout(() => backend.kill("SIGKILL"), 8000);
  try { await stopped; } finally { clearTimeout(timeout); }
}

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      const stopped = once(activeChild, "exit");
      activeChild.kill("SIGKILL");
      await stopped.catch(() => {});
    }
    try {
      resetRuntimeContext?.();
      try { await ctx?.store.close(); } finally { await stopBackend(); }
    } finally {
      // RUN is an exact child of this invocation's mkdtemp directory, never a
      // caller-supplied directory. Delete ephemeral keys, copied project and DB.
      fs.rmSync(RUN, { recursive: true, force: true });
    }
  })();
  return cleaning;
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code));
  });
}

try {
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  phase = "resolving-backend";
  await resolveBinary();
  phase = "preparing-backend";
  fs.cpSync(path.join(ROOT, "convex"), path.join(project, "convex"), { recursive: true, filter: (source) => {
    const rel = path.relative(path.join(ROOT, "convex"), source);
    // Keep generated API bindings; omit tsc's root-level JS/declaration copies
    // so Convex does not see duplicate TS + JS deployment entry points.
    return rel.includes(path.sep) || !/\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(rel);
  } });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "brigade-isolated-convex-probe", private: true, type: "module", dependencies: { convex: require("convex/package.json").version } }));
  port = await freePort();
  do { sitePort = await freePort(); } while (sitePort === port);
  url = `http://127.0.0.1:${port}`;
  const keygen = spawnSync(binary, ["keygen", "admin-key", "--instance-name", instanceName, "--instance-secret", instanceSecret], { encoding: "utf8", env: safeEnv, timeout: 10000 });
  assert.equal(keygen.status, 0, "local admin key generation must succeed");
  adminKey = keygen.stdout.trim();
  assert.ok(adminKey, "local admin key must be nonempty");
  Object.assign(safeEnv, { CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey, BRIGADE_CONVEX_URL: url });
  const envFile = path.join(project, "probe.env");
  fs.writeFileSync(envFile, `CONVEX_SELF_HOSTED_URL=${url}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`, { mode: 0o600 });
  await startBackend();
  phase = "deploying-functions";
  console.log("Backend ready on isolated loopback ports; deploying current copied functions.");
  const deploy = await run(process.execPath, [path.join(ROOT, "node_modules", "convex", "bin", "main.js"), "deploy", "--yes", "--env-file", envFile, "--typecheck", "disable", "--codegen", "disable"]);
  fs.writeFileSync(path.join(WORK, "deploy.log"), deploy);
  check("current Convex functions deployed only to disposable self-hosted backend");

  // Imports below see only this disposable environment, never provider keys or
  // the operator's BRIGADE_STATE_DIR. tsx resolves .js specifiers to TS sources.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, safeEnv);
  const source = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);
  const { ConvexHttpClient } = require("convex/browser");
  const { api } = await source("convex/_generated/api.js");
  const { ConvexMemoryStore } = await source("src/storage/convex/memory-store.js");
  const { FactStore: StandaloneFactStore } = await source("src/tideline/store/records.js");
  const { FactStore: HostFactStore } = await source("src/agents/memory/records.js");
  const runtime = await source("src/storage/runtime-context.js");
  resetRuntimeContext = runtime.__resetRuntimeContextForTests;
  const cache = await source("src/storage/facts-cache.js");
  const client = new ConvexHttpClient(url, { logger: false, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(2500) }) });
  const memory = new ConvexMemoryStore({ client, workspaceId: "workspace-a" });
  const seedStore = new StandaloneFactStore(path.join(RUN, "seed-source"));
  const owner = { kind: "owner" };
  const peer = { kind: "channel", channelId: "chat", conversationId: "room", sessionKey: "session" };
  const template = seedStore.write({ content: "Amber release gate is Friday.", segment: "project", sourceType: "owner_message", createdBy: owner, metadata: { approved: "amber-proof" } });
  const rootRecord = { ...template, memoryId: "root-record" };
  phase = "encryption-origin-isolation";
  await memory.upsertFactRecordRaw("workspace-a", rootRecord);
  await memory.upsertFactRecordRaw("workspace-a", { ...template, memoryId: "peer-record", content: "Amber private channel gate is Monday.", createdBy: peer });
  await memory.upsertFactRecordRaw("workspace-b", { ...template, memoryId: "other-workspace", content: "Amber other workspace gate is Tuesday." });
  const rawRows = await client.query(api.memory.listFacts, { workspaceId: "workspace-a" });
  assert.equal(rawRows.length, 2);
  assert.ok(rawRows.every((row) => !Buffer.from(row.content).toString("utf8").includes("Amber")));
  assert.ok(rawRows.every((row) => typeof row.metadata?.__enc === "string"));
  assert.equal((await memory.listAllFactRecordsRaw("workspace-a")).find((record) => record.memoryId === "root-record").content, template.content);
  assert.deepEqual((await memory.listFacts({ origin: owner })).map((record) => record.memoryId), ["root-record"]);
  assert.deepEqual((await memory.listFacts({ origin: peer })).map((record) => record.memoryId), ["peer-record"]);
  for (const field of ["channelId", "conversationId", "sessionKey"]) assert.deepEqual(await memory.listFacts({ origin: { ...peer, [field]: "other" } }), []);
  check("real stored bytes encrypted; metadata encrypted; workspace and exact-origin reads isolated");

  phase = "cold-hydration";
  ctx = await runtime.createRuntimeContext({ override: { mode: "convex", convexUrl: url }, stateDir });
  runtime.setRuntimeContext(ctx);
  const hostWorkspace = path.join(stateDir, "agents", "probe-a", "workspace");
  const workspaceId = cache.workspaceIdFromDir(hostWorkspace);
  await memory.upsertFactRecordRaw(workspaceId, rootRecord);
  const host = new HostFactStore(hostWorkspace);
  assert.throws(() => host.list(), (error) => error.name === "FactsHydrationPendingError");
  await host.ready();
  assert.equal(host.search("Amber Friday", { origin: owner })[0]?.memoryId, "root-record");
  assert.equal(cache.getFactsHydrationState(workspaceId).status, "ready");
  check("cold host store fails pending, explicitly hydrates and recalls durable evidence");

  phase = "bounded-load";
  const count = 240;
  const started = performance.now();
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < count) {
      const i = cursor++;
      await memory.upsertFactRecordRaw("workspace-a", { ...template, memoryId: `load-${i}`, content: `Amber load sample ${i} ${createHash("sha256").update(String(i)).digest("hex")}`, createdAt: template.createdAt + i + 1 });
    }
  }));
  results.timings.load240WritesMs = Math.round(performance.now() - started);
  assert.equal((await memory.listAllFactRecordsRaw("workspace-a")).length, 242);
  assert.equal((await memory.listFacts({ origin: owner })).length, 241);
  assert.equal((await memory.listFacts({ origin: peer })).length, 1);
  assert.equal((await memory.listAllFactRecordsRaw("workspace-b")).length, 1);
  check("240 bounded writes at concurrency 8; hydration and selective-origin reads complete beyond 200 rows");

  phase = "durable-write-recovery";
  await stopBackend("SIGKILL");
  const pending = host.write({ content: "Cobalt recovery milestone is Thursday.", segment: "project", createdBy: owner });
  await assert.rejects(host.flush());
  check("real backend outage makes flush reject, not report durable success");
  await startBackend();
  await host.flush();
  assert.ok((await memory.listAllFactRecordsRaw(workspaceId)).some((record) => record.memoryId === pending.memoryId));
  assert.equal((await memory.listAllFactRecordsRaw("workspace-a")).length, 242);
  check("SIGKILL restart preserves accepted rows and retry flush persists retained pending write");

  phase = "hydration-recovery";
  cache.__resetFactsCacheForTests();
  await stopBackend("SIGKILL");
  const cold = new HostFactStore(hostWorkspace);
  await assert.rejects(cold.ready());
  assert.equal(cache.getFactsHydrationState(workspaceId).status, "error");
  await startBackend();
  await cold.ready();
  assert.ok(cold.search("Cobalt Thursday", { origin: owner }).some((record) => record.memoryId === pending.memoryId));
  check("cold hydration outage is explicit error; later ready retries and recovers after restart");
  await cold.flush();
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.error = { phase, category: failureCategory(error) };
  console.error(redact(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
    assert.deepEqual(hashEnv(), beforeEnv, "repo environment files must remain byte-identical");
    check("repository .env/.env.local unchanged; backend stopped; ephemeral keys and database removed");
  } catch (error) {
    results.status = "failed";
    results.cleanupError = { phase: "cleanup", category: failureCategory(error) };
    console.error(redact(error?.stack ?? error));
    process.exitCode = 1;
  }
  results.finished = new Date().toISOString();
  fs.writeFileSync(path.join(WORK, "result.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(WORK, "backend.log"), redact(backendLog));
  console.log(`Result artifact: ${path.join(WORK, "result.json")}`);
}
