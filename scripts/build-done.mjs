#!/usr/bin/env node
/**
 * Postbuild step. Two jobs, both after a successful `tsc` (which prints
 * nothing on success), wired via the `postbuild` npm lifecycle hook:
 *
 *   1. Write a BUILD STAMP — `dist/buildstamp.json = { builtAt, head }` (git
 *      commit + timestamp). The runtime reads it (see `src/version.ts`) so
 *      `brigade --version` and the gateway boot banner report the EXACT build
 *      that's running. Brigade uses a non-dot filename
 *      (`dist/buildstamp.json`) so it's reliably included by the
 *      `files: ["dist/**\/*"]` package glob.
 *   2. Print a gold "Build complete" banner pointing at what to run next.
 *
 * Cosmetic/best-effort — wrapped so it can NEVER fail the build, and
 * colour-aware (chalk auto-disables on non-TTY / NO_COLOR).
 */

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import chalk from "chalk";

const GOLD = "#fbbf24"; // Brigade amber — matches src/ui/theme.ts

/** Current git commit, or null outside a repo / when git is unavailable. */
function gitHead() {
	try {
		const r = spawnSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (r.status !== 0) return null;
		return (r.stdout ?? "").trim() || null;
	} catch {
		return null;
	}
}

/** Count compiled .js files in dist/ as a light "what got built" signal. */
function countJs(dir) {
	let n = 0;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		if (e.isDirectory()) n += countJs(join(dir, e.name));
		else if (e.name.endsWith(".js")) n++;
	}
	return n;
}

/**
 * Recursively copy a directory tree (best-effort, returns file count).
 * Used for non-TS assets — tsc compiles .ts → .js but ignores .png, .svg,
 * .woff, etc. that live alongside source modules.
 */
function copyTree(src, dst) {
	if (!existsSync(src)) return 0;
	let n = 0;
	mkdirSync(dst, { recursive: true });
	for (const e of readdirSync(src, { withFileTypes: true })) {
		const s = join(src, e.name);
		const d = join(dst, e.name);
		if (e.isDirectory()) {
			n += copyTree(s, d);
		} else if (e.isFile()) {
			copyFileSync(s, d);
			n++;
		}
	}
	return n;
}

// 1. Build stamp — best-effort.
let head = null;
try {
	head = gitHead();
	mkdirSync("dist", { recursive: true });
	writeFileSync("dist/buildstamp.json", `${JSON.stringify({ builtAt: Date.now(), head })}\n`, "utf8");
} catch {
	// Stamp is optional — a build without it just reports the bare version.
}

// 2. Asset copy — mirror non-TS files under src/**/assets/ into dist/.
// tsc only emits .js for .ts inputs; binary assets (PNG mascots,
// brand SVGs, fonts) need a separate copy step to end up in the
// shipped package. The `files: ["dist/**\/*"]` package glob then
// picks them up automatically.
try {
	const ASSET_TREES = [
		// Pride org-chart mascot PNGs + any other org-chart static assets.
		["src/agents/org/assets", "dist/agents/org/assets"],
		// Brand assets: the Brigade favicon shown on the OAuth callback page
		// (and reusable by any future surface).
		["src/assets", "dist/assets"],
	];
	for (const [src, dst] of ASSET_TREES) copyTree(src, dst);
} catch {
	// Asset copy is best-effort; missing assets just produce a chart
	// without the mascot (text fallback still works).
}

// 3. Banner — best-effort, never fails the build.
try {
	const gold = chalk.hex(GOLD);
	const files = countJs("dist");
	const sha = head ? ` ${chalk.dim(`· ${head.slice(0, 7)}`)}` : "";
	const count = files > 0 ? ` (${files} files)` : "";
	process.stdout.write(
		`\n${gold.bold("🦁 Build complete")}${chalk.dim(` — dist/ ready${count}.`)}${sha}\n` +
			`${chalk.dim("  Run:")} ${gold("brigade")}${chalk.dim(" chat · ")}${gold("brigade gateway")}${chalk.dim(" daemon · ")}${gold("brigade onboard")}${chalk.dim(" setup")}\n\n`,
	);
} catch {
	// Cosmetic only.
}
