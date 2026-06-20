/**
 * Build the publishable `brigade-tideline` package.
 *
 * The in-repo extraction layer (src/tideline/) re-exports the memory core from
 * src/agents/memory/*, which reaches Brigade host code through ONE seam —
 * `agents/memory/host-ports.ts`. This build produces a self-contained npm package by:
 *   1. esbuild-bundling the 3 entries (index/advanced/eval) with that seam aliased to
 *      the filesystem-only `host-ports.standalone.ts` → self-contained ESM, zero `../` escapes.
 *   2. emitting .d.ts from a TEMP source tree where the seam is PHYSICALLY swapped, so the
 *      types are self-contained and Brigade-free too.
 *   3. writing the package.json (paths repointed at the bundles) + README.
 *
 * Output: dist/tideline/  (npm pack-able).  Run: `npm run build:tideline`.
 */
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "dist", "tideline");
const TMP = path.join(ROOT, "dist", ".tideline-build");
const STANDALONE = path.join(SRC, "tideline", "host-ports.standalone.ts");
const log = (m) => console.log(`▌ ${m}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── 1. bundle JS, swapping the host seam ──────────────────────────────────────
const swap = {
	name: "host-ports-swap",
	setup(b) {
		b.onResolve({ filter: /\/host-ports\.js$/ }, () => ({ path: STANDALONE }));
	},
};
const entries = {
	index: path.join(SRC, "tideline", "index.ts"),
	advanced: path.join(SRC, "tideline", "advanced.ts"),
	eval: path.join(SRC, "tideline", "eval.ts"),
};
const result = await esbuild.build({
	entryPoints: entries,
	outdir: OUT,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	metafile: true,
	plugins: [swap],
	logLevel: "warning",
});
if (result.warnings.length) {
	console.error("esbuild warnings:", result.warnings);
}
log(`bundled index/advanced/eval → dist/tideline (warnings: ${result.warnings.length})`);

// ── 2. derive the exact graph source set from the metafile ────────────────────
const inputs = Object.keys(result.metafile.inputs)
	.map((p) => path.resolve(ROOT, p))
	.filter((p) => p.startsWith(SRC) && p.endsWith(".ts"));
log(`graph: ${inputs.length} source files`);

// ── 3. temp tree with the seam physically swapped → emit .d.ts ────────────────
for (const abs of inputs) {
	if (abs === STANDALONE) continue; // becomes agents/memory/host-ports.ts below
	const dest = path.join(TMP, path.relative(SRC, abs));
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(abs, dest);
}
const standaloneSrc = fs
	.readFileSync(STANDALONE, "utf8")
	.replace(/\.\.\/agents\/memory\/records\.js/g, "./records.js");
const hpDest = path.join(TMP, "agents", "memory", "host-ports.ts");
fs.mkdirSync(path.dirname(hpDest), { recursive: true });
fs.writeFileSync(hpDest, standaloneSrc);

const tsconfig = {
	compilerOptions: {
		target: "es2022",
		module: "nodenext",
		moduleResolution: "nodenext",
		declaration: true,
		emitDeclarationOnly: true,
		skipLibCheck: true,
		// Keep strictNullChecks (the core's discriminated-union narrowing — e.g. WriteGateVerdict —
		// depends on it) but disable noImplicitAny: the standalone seam types the never-reached
		// convex store as `any`, so the core's dead convex branch infers a few implicit-any params.
		strict: true,
		noImplicitAny: false,
		outDir: path.join(OUT, "types"),
		rootDir: TMP,
	},
	include: ["**/*.ts"],
	exclude: ["**/*.test.ts"],
};
fs.writeFileSync(path.join(TMP, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
log("emitting .d.ts …");
execFileSync("node", [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(TMP, "tsconfig.json")], {
	stdio: "inherit",
	cwd: ROOT,
});
log("✔ .d.ts → dist/tideline/types");

// ── 4. package.json (repointed) + README ──────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "tideline", "package.json"), "utf8"));
pkg.main = "./index.js";
pkg.types = "./types/tideline/index.d.ts";
pkg.exports = {
	".": { types: "./types/tideline/index.d.ts", import: "./index.js" },
	"./advanced": { types: "./types/tideline/advanced.d.ts", import: "./advanced.js" },
	"./eval": { types: "./types/tideline/eval.d.ts", import: "./eval.js" },
};
pkg.files = ["index.js", "advanced.js", "eval.js", "types", "README.md"];
// Entries run registerBuiltInEmbedderAdapters() at import — mark them as having side
// effects so a consumer's bundler can't tree-shake the registration away.
pkg.sideEffects = ["./index.js", "./advanced.js", "./eval.js"];
fs.writeFileSync(path.join(OUT, "package.json"), `${JSON.stringify(pkg, null, "\t")}\n`);
fs.copyFileSync(path.join(SRC, "tideline", "README.md"), path.join(OUT, "README.md"));
log("wrote package.json + README");

fs.rmSync(TMP, { recursive: true, force: true });
log("✔ build complete → dist/tideline");
