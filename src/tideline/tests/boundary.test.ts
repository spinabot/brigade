import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tidelineRoot = path.join(repositoryRoot, "src", "tideline");

function implementationFiles(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === "tests" ? [] : implementationFiles(absolute);
		return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [absolute] : [];
	});
}

it("engine modules use direct dependencies and keep transport and evaluation at the edges", () => {
	const entries = new Set(["index.ts", "advanced.ts", "eval.ts"]);
	const violations: string[] = [];
	for (const file of implementationFiles(tidelineRoot)) {
		const relative = path.relative(tidelineRoot, file);
		if (entries.has(relative)) continue; // Published entries assemble the surface.
		const imports = ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true).importedFiles;
		for (const { fileName: specifier } of imports) {
			if (!specifier.startsWith(".")) continue;
			const target = path.relative(tidelineRoot, path.resolve(path.dirname(file), specifier)).replace(/\.js$/, ".ts");
			const targetGroup = target.split(path.sep)[0];
			const sourceGroup = relative.split(path.sep)[0];
			if (entries.has(target) || targetGroup === "tests" ||
				(targetGroup === "transports" && sourceGroup !== "transports") ||
				(targetGroup === "eval" && sourceGroup !== "eval")) {
				violations.push(`${relative} -> ${target}`);
			}
		}
	}
	// These are dependency-direction rules, not a claim that the legacy engine
	// is acyclic. Existing store/recall/lifecycle collaboration remains intact.
	assert.deepEqual(violations.sort(), []);
});

it("the complete Tideline implementation graph has no Brigade runtime or compatibility back-imports", () => {
	// Use every implementation root, not just curated package entries: a type-only
	// dependency in an unexported module can otherwise escape bundler graph checks.
	const roots = implementationFiles(tidelineRoot);
	assert.ok(roots.includes(path.join(tidelineRoot, "extraction", "relationship-extract.ts")));
	assert.ok(roots.includes(path.join(tidelineRoot, "eval", "gold.ts")));
	const config = ts.readConfigFile(path.join(repositoryRoot, "tsconfig.json"), ts.sys.readFile);
	assert.equal(config.error, undefined, "repository TypeScript configuration must be readable");
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot);
	assert.deepEqual(parsed.errors, []);
	const program = ts.createProgram({ rootNames: roots, options: { ...parsed.options, noEmit: true, skipLibCheck: true } });
	const allowedPureUtilities = new Set([
		path.join(repositoryRoot, "src", "security", "injection-patterns.ts"),
		path.join(repositoryRoot, "src", "system-prompt", "sanitize.ts"),
		path.join(repositoryRoot, "src", "infra", "fs", "atomic-rename.ts"),
	]);
	const forbidden = program.getSourceFiles()
		.filter((source) => !source.isDeclarationFile || (!program.isSourceFileDefaultLibrary(source) && !program.isSourceFileFromExternalLibrary(source)))
		.map((source) => path.resolve(source.fileName))
		.filter((filename) => !filename.startsWith(`${tidelineRoot}${path.sep}`) && !allowedPureUtilities.has(filename))
		.map((filename) => path.relative(repositoryRoot, filename))
		.sort();
	assert.deepEqual(forbidden, [], "Tideline must own its entire implementation and type dependency graph; host adapters point inward only");
});
