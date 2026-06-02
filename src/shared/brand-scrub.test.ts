/**
 * Brand-scrub guard for every Symbol.for() arg under src/.
 *
 * The global-singleton helper documents `Symbol.for("brigade.<area>.<purpose>")`
 * as the only allowed shape (so two builds sharing a Node realm collide on
 * intent + so the singleton key namespace stays brand-scrubbed). This test
 * walks src/ for every `*.ts` (excluding test files) and asserts each
 * `Symbol.for("...")` arg starts with `"brigade."`.
 *
 * Implementation: source-text regex sweep (not full AST — keeps this test
 * zero-dep). The regex matches `Symbol.for("foo")` AND `Symbol.for('foo')`
 * AND `Symbol.for(\`foo\`)`. Any match whose captured arg does NOT start
 * with `brigade.` fails the assert.
 */

import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYMBOL_FOR_RE = /Symbol\.for\(\s*(["'`])([^"'`]+)\1\s*\)/g;

function walk(dir: string): string[] {
	const out: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of entries) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === "node_modules" || ent.name === "dist") continue;
			out.push(...walk(full));
		} else if (
			ent.isFile() &&
			ent.name.endsWith(".ts") &&
			!ent.name.endsWith(".test.ts") &&
			!ent.name.endsWith(".d.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

describe("brand-scrub: Symbol.for() args", () => {
	it("every Symbol.for() arg under src/ starts with 'brigade.'", () => {
		const files = walk(SRC_DIR);
		assert.ok(files.length > 0, "expected at least one .ts file under src/");
		const violations: Array<{ file: string; key: string }> = [];
		for (const file of files) {
			let text: string;
			try {
				text = fs.readFileSync(file, "utf8");
			} catch {
				continue;
			}
			SYMBOL_FOR_RE.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = SYMBOL_FOR_RE.exec(text)) !== null) {
				const key = match[2] ?? "";
				if (!key.startsWith("brigade.")) {
					violations.push({ file: path.relative(SRC_DIR, file), key });
				}
			}
		}
		assert.deepEqual(
			violations,
			[],
			`Found Symbol.for() args not prefixed with 'brigade.': ${JSON.stringify(violations, null, 2)}`,
		);
	});
});
