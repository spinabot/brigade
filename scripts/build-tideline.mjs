/** Build the canonical Tideline engine, without swapping or stubbing host code. */
import esbuild from "esbuild";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const ENGINE = path.join(SRC, "tideline");
// Brigade's normal tsc build owns dist/tideline. Never replace that directory.
const OUT = path.join(ROOT, "dist", "packages", "tideline");
const brigadeOutput = path.join(ROOT, "dist", "tideline");
if (OUT === brigadeOutput || brigadeOutput.startsWith(`${OUT}${path.sep}`)) {
	throw new Error("Standalone output must not replace Brigade's compiled engine");
}
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tideline-package-build-"));
const staged = path.join(workDir, "package");
const entries = Object.fromEntries(["index", "advanced", "eval"].map((name) => [name, path.join(ENGINE, `${name}.ts`)]));

// Shared helpers, not Brigade runtime bindings. Both runtime and erased
// type-only dependency closures must stay inside this explicit boundary.
const sharedHelpers = new Set([
	path.join(SRC, "security", "injection-patterns.ts"),
	path.join(SRC, "system-prompt", "sanitize.ts"),
	path.join(SRC, "infra", "fs", "atomic-rename.ts"),
]);
function assertEngineSource(file) {
	const resolved = fs.realpathSync(file);
	if (!(resolved.startsWith(`${ENGINE}${path.sep}`) || sharedHelpers.has(resolved)) || resolved.endsWith(".test.ts")) {
		throw new Error(`Tideline package boundary violation: ${path.relative(ROOT, resolved)}`);
	}
}

try {
	// An esbuild metafile omits erased type-only imports. TypeScript discovers
	// that declaration graph too, and checks it at the same strictness as Brigade.
	const program = ts.createProgram(Object.values(entries), {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		strict: true,
		noUncheckedIndexedAccess: true,
		noImplicitOverride: true,
		forceConsistentCasingInFileNames: true,
		esModuleInterop: true,
		skipLibCheck: true,
		declaration: true,
		emitDeclarationOnly: true,
		noEmitOnError: true,
		rootDir: SRC,
		outDir: path.join(staged, "types"),
		types: ["node"],
		typeRoots: [path.join(ROOT, "node_modules", "@types")],
		lib: ["lib.es2022.d.ts"],
	});
	const sources = program.getSourceFiles().filter((source) => !source.isDeclarationFile);
	const boundarySources = program.getSourceFiles().filter((source) =>
		!source.isDeclarationFile || (!program.isSourceFileDefaultLibrary(source) && !program.isSourceFileFromExternalLibrary(source)),
	);
	// Project-local declarations are part of the boundary too; only external
	// type libraries (such as Node's declarations) are exempt from source ownership.
	for (const source of boundarySources) assertEngineSource(source.fileName);
	const diagnostics = ts.getPreEmitDiagnostics(program);
	if (diagnostics.length) {
		throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCanonicalFileName: (file) => file,
			getCurrentDirectory: () => ROOT,
			getNewLine: () => "\n",
		}));
	}
	if (program.emit().emitSkipped) throw new Error("Tideline declaration emit was skipped");

	const result = await esbuild.build({
		absWorkingDir: ROOT,
		entryPoints: entries,
		outdir: staged,
		bundle: true,
		splitting: true,
		chunkNames: "chunks/[name]-[hash]",
		format: "esm",
		platform: "node",
		target: "node22",
		metafile: true,
		logLevel: "warning",
		plugins: [{
			name: "tideline-source-boundary",
			setup(build) {
				build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
					assertEngineSource(args.path);
					return undefined;
				});
			},
		}],
	});
	if (result.warnings.length) throw new Error("Tideline bundle produced warnings");
	for (const input of Object.keys(result.metafile.inputs)) assertEngineSource(path.resolve(ROOT, input));
	for (const output of Object.values(result.metafile.outputs)) {
		for (const dependency of output.imports) {
			if (dependency.external && !isBuiltin(dependency.path)) {
				throw new Error(`Unexpected runtime dependency: ${dependency.path}`);
			}
		}
	}

	const pkg = JSON.parse(fs.readFileSync(path.join(ENGINE, "package.json"), "utf8"));
	pkg.main = "./index.js";
	pkg.types = "./types/tideline/index.d.ts";
	pkg.exports = Object.fromEntries(["index", "advanced", "eval"].map((name) => [
		name === "index" ? "." : `./${name}`,
		{ types: `./types/tideline/${name}.d.ts`, import: `./${name}.js` },
	]));
	pkg.files = ["index.js", "advanced.js", "eval.js", "chunks", "types", "README.md"];
	// Shared chunks preserve class identity and module-level embedder state across
	// entry points. Provider registration is an intentional import-time effect.
	pkg.sideEffects = ["./index.js", "./advanced.js", "./eval.js", "./chunks/*.js"];
	fs.writeFileSync(path.join(staged, "package.json"), `${JSON.stringify(pkg, null, "\t")}\n`);
	fs.copyFileSync(path.join(ENGINE, "README.md"), path.join(staged, "README.md"));
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	// Validation and compilation finish before replacing the generated package.
	fs.rmSync(OUT, { recursive: true, force: true });
	fs.cpSync(staged, OUT, { recursive: true });
	console.log(`Tideline package built: ${sources.length} declaration sources; shared ESM chunks; strict types.`);
	console.log("Output: dist/packages/tideline (no Brigade runtime, Convex client, or scan stubs).");
} finally {
	fs.rmSync(workDir, { recursive: true, force: true });
}
