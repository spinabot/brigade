/**
 * The lint rule that keeps the dialect class closed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SOURCE SCAN AND NOT A TYPE
 * ─────────────────────────────────────────────────────────────────────────
 * `pi-dialect.ts` makes the spelling compiler-owned for every caller that goes
 * through it. What it cannot do is stop the next author from skipping it and
 * hand-writing the cast again:
 *
 *     const b = block as { type?: unknown; input?: unknown };  // compiles fine
 *
 * That is precisely how four bugs shipped in one day. A cast to a shape you
 * invented at the point of use is checked against your invention, not against
 * Pi, so the compiler has nothing to say. The only thing that can catch it is a
 * rule about the SOURCE — hence this test.
 *
 * The rule: a file that speaks the dialect must import the module that owns it.
 * New file speaking the dialect → this test fails → the author finds
 * `pi-dialect.ts` and its header, which is the whole point. The failure message
 * is written for that person, not for us.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** The literals that mean "this file speaks the Pi/Anthropic tool dialect". */
const DIALECT_LITERALS = [
	'"toolCall"',
	'"toolResult"',
	'"tool_use"',
	'"tool_result"',
];

/**
 * Files allowed to name the dialect without importing the module.
 *
 * Kept SHORT and justified. Anything added here is a place the compiler is not
 * helping, so each entry needs a reason that is about the file's job — not
 * about the migration being inconvenient.
 */
const ALLOWED = new Set([
	// Owns the definitions. Importing itself would be circular.
	"agents/pi-dialect.ts",
	// Declares the wire contract, and already ties `arguments` to Pi's own type
	// via `PiToolCall["arguments"]` — a stronger guarantee than the import.
	"protocol.ts",
	// FALSE POSITIVE, and worth naming. Anthropic uses the string "tool_use" in
	// two unrelated namespaces: as a content-block `type`, and as a message's
	// `stop_reason`. This file only ever means the second — it is a set of
	// benign stop reasons and never touches a content block. Importing the
	// dialect module here would imply a relationship that does not exist.
	"agents/stream-wrappers.ts",
]);

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* walk(full);
			continue;
		}
		if (!entry.endsWith(".ts")) continue;
		if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
		yield full;
	}
}

test("every file that speaks the tool dialect imports pi-dialect", () => {
	const offenders: string[] = [];

	for (const file of walk(SRC)) {
		const rel = file.slice(SRC.length);
		if (ALLOWED.has(rel)) continue;

		const source = readFileSync(file, "utf8");
		const speaks = DIALECT_LITERALS.filter((lit) => source.includes(lit));
		if (speaks.length === 0) continue;

		if (!source.includes("pi-dialect.js")) {
			offenders.push(`${rel} — uses ${speaks.join(", ")} without importing pi-dialect`);
		}
	}

	assert.deepEqual(
		offenders,
		[],
		`These files spell the tool dialect by hand instead of importing it:\n\n` +
			`${offenders.map((o) => `  • ${o}`).join("\n")}\n\n` +
			`Pi spells a tool call { type: "toolCall", arguments } in memory; Anthropic\n` +
			`spells the same thing { type: "tool_use", input } on the wire. Mixing them\n` +
			`up compiles cleanly and returns undefined forever — it caused four\n` +
			`production bugs in one day, including silently disabling compaction on a\n` +
			`153,000-token transcript.\n\n` +
			`Import the accessors from src/agents/pi-dialect.ts (isToolCall,\n` +
			`toolCallArguments, isToolResultMessage, PI_TOOL_CALL, …) so the compiler\n` +
			`owns the spelling. Read that file's header first — it explains which\n` +
			`dialect belongs in which layer, and the wire spelling IS correct in the\n` +
			`stream converters and the outbound payload mutators.\n\n` +
			`If this file genuinely cannot use the module, add it to ALLOWED above\n` +
			`with a reason about the file's job.`,
	);
});

test("the allowlist stays small and every entry still exists", () => {
	// An allowlist that grows silently is how a lint rule dies. Six is already
	// generous for a codebase with one legitimate definition site and one wire
	// contract; a larger number means the rule is being worked around.
	assert.ok(
		ALLOWED.size <= 6,
		`The pi-dialect allowlist has grown to ${ALLOWED.size}. Each entry is a ` +
			`place the compiler cannot help. Migrate the file instead.`,
	);
	for (const rel of ALLOWED) {
		assert.doesNotThrow(
			() => statSync(join(SRC, rel)),
			`Allowlisted file no longer exists: ${rel} — remove it from ALLOWED.`,
		);
	}
});
