#!/usr/bin/env node
// Brigade entry shim — mirrors openclaw.mjs's shape. The bin file is small
// on purpose; src/entry.ts (compiled to dist/entry.js) does the real work.
//
// Three responsibilities live here intentionally:
//
//   1. Reject unsupported Node versions before anything else loads. Pi SDK
//      uses `using` / `AsyncDisposable` and other 22.12+ features, and Node
//      18/20 will fail with a confusing SyntaxError far from the cause.
//
//   2. Enable Node's compile cache as early as possible to trim warm-start
//      latency for the CLI. entry.ts re-enables defensively in case this
//      shim is bypassed.
//
//   3. Filter known-noisy process warnings (DEP0040 punycode, DEP0060
//      util._extend, SQLite ExperimentalWarning) so they don't drown the
//      real signal on every invocation.
//
//   4. Dispatch to dist/entry.js with proper direct-vs-transitive
//      ERR_MODULE_NOT_FOUND distinction.
//
// dist-only by design — no tsx fallback. For dev iteration use
// `npm run dev`, which routes through scripts/run-brigade.mjs (the smart
// dev runner that builds-then-runs).

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";

const MIN_NODE = { major: 22, minor: 12 };

function ensureSupportedNodeVersion() {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(process.versions.node);
  if (!m) return;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (
    major > MIN_NODE.major ||
    (major === MIN_NODE.major && minor >= MIN_NODE.minor)
  ) {
    return;
  }
  process.stderr.write(
    `brigade requires Node ${MIN_NODE.major}.${MIN_NODE.minor} or newer ` +
      `(running ${process.versions.node}).\n` +
      `If you're on nvm: \`nvm install ${MIN_NODE.major}\` then \`nvm use ${MIN_NODE.major}\`.\n`,
  );
  process.exit(1);
}

ensureSupportedNodeVersion();

try {
  const mod = await import("node:module");
  if (typeof mod.enableCompileCache === "function" && !process.env.NODE_DISABLE_COMPILE_CACHE) {
    mod.enableCompileCache();
  }
} catch {
  // Older Node minors silently skip — not fatal.
}

function shouldIgnoreWarning(warning) {
  if (warning.code === "DEP0040" && warning.message?.includes("punycode")) {
    return true;
  }
  if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) {
    return true;
  }
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message?.includes("SQLite is an experimental feature")
  ) {
    return true;
  }
  return false;
}

function normalizeWarningArgs(args) {
  const [first, second, third] = args;
  let name;
  let code;
  let message;
  if (first instanceof Error) {
    name = first.name;
    message = first.message;
    code = first.code;
  } else if (typeof first === "string") {
    message = first;
  }
  if (second && typeof second === "object" && !Array.isArray(second)) {
    if (typeof second.type === "string") name = second.type;
    if (typeof second.code === "string") code = second.code;
  } else {
    if (typeof second === "string") name = second;
    if (typeof third === "string") code = third;
  }
  return { name, code, message };
}

function installProcessWarningFilter() {
  const original = process.emitWarning.bind(process);
  process.emitWarning = (...args) => {
    if (shouldIgnoreWarning(normalizeWarningArgs(args))) return;
    original(...args);
  };
}

installProcessWarningFilter();

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, "dist", "entry.js");
const srcEntry = join(here, "src", "entry.ts");

// Distinguish "the entry file itself is missing" from "the entry loaded but
// hit ERR_MODULE_NOT_FOUND on a transitive import". Without this, a real
// dependency-resolution bug would silently turn into "missing dist" and the
// user would chase the wrong error. Mirrors openclaw.mjs's
// `isDirectModuleNotFoundError`.
function isDirectMissing(err, specifierUrl) {
  if (!err || typeof err !== "object" || err.code !== "ERR_MODULE_NOT_FOUND") {
    return false;
  }
  if (err.url === specifierUrl.href) return true;
  const expected = fileURLToPath(specifierUrl);
  const message = typeof err.message === "string" ? err.message : "";
  return (
    message.includes(`Cannot find module '${expected}'`) ||
    message.includes(`Cannot find module "${expected}"`)
  );
}

async function tryImport(filePath) {
  const url = pathToFileURL(filePath);
  try {
    await import(url.href);
    return true;
  } catch (err) {
    if (isDirectMissing(err, url)) return false;
    throw err;
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildMissingEntryError() {
  const lines = ["brigade: missing dist/entry.js (build output)."];
  if (existsSync(srcEntry)) {
    lines.push("This install looks like an unbuilt source tree or GitHub source archive.");
    lines.push("Build locally: `npm install && npm run build`,");
    lines.push("or for development: `npm run dev <args>` (uses the smart dev runner).");
    lines.push("For releases, install from npm: `npm install -g brigade`.");
  } else {
    lines.push("Reinstall brigade: `npm install -g brigade`.");
  }
  return lines.join("\n");
}

if (await exists(distEntry)) {
  if (!(await tryImport(distEntry))) {
    process.stderr.write(`${buildMissingEntryError()}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write(`${buildMissingEntryError()}\n`);
  process.exit(1);
}
