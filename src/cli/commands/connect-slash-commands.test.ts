/**
 * The slash-command registry must cover every command the TUI dispatches.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A TEST AND NOT A CODE REVIEW NOTE
 * ─────────────────────────────────────────────────────────────────────────
 * `connect.ts` carries three lists that describe the same set of commands:
 * the handler chain that dispatches them, `SLASH_COMMANDS` (which drives
 * autocomplete AND `isKnownSlashCommand`), and the hand-written `/help` text.
 * Nothing tied them together, so they drifted — nine commands were dispatched
 * without being registered, and `isKnownSlashCommand` is the gate deciding
 * whether mid-turn input is a COMMAND or steering text for the model. An
 * unregistered command does not merely lack autocomplete: it stops working
 * mid-turn and is delivered to the model as prose.
 *
 * Reading the source is the only way to catch that, because the drift is
 * between two literals in one file — there is no runtime moment where the two
 * disagree observably until an operator types the command at the wrong time.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SOURCE = readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "connect.ts"),
	"utf8",
);

/** Commands the handler chain actually dispatches on. */
function dispatchedCommands(): Set<string> {
	const out = new Set<string>();
	for (const m of SOURCE.matchAll(/trimmed === "\/([a-z][a-z-]*)"/g)) out.add(m[1]!);
	for (const m of SOURCE.matchAll(/trimmed\.startsWith\("\/([a-z][a-z-]*) "\)/g)) out.add(m[1]!);
	return out;
}

/** Commands registered in `SLASH_COMMANDS`. */
function registeredCommands(): Set<string> {
	const start = SOURCE.indexOf("const SLASH_COMMANDS: SlashCommand[] = [");
	assert.ok(start > 0, "SLASH_COMMANDS literal not found — this test needs updating");
	// Stop at the closing bracket of the array literal.
	const end = SOURCE.indexOf("\n\t];", start);
	assert.ok(end > start, "could not find the end of the SLASH_COMMANDS literal");
	const body = SOURCE.slice(start, end);
	const out = new Set<string>();
	for (const m of body.matchAll(/name: "([a-z][a-z-]*)"/g)) out.add(m[1]!);
	return out;
}

describe("connect — slash command registry", () => {
	it("finds both lists (guards the parser itself)", () => {
		// If either extraction silently returned nothing, the real assertion
		// below would pass vacuously and this test would protect nothing.
		assert.ok(dispatchedCommands().size > 20, "expected the handler chain to dispatch many commands");
		assert.ok(registeredCommands().size > 20, "expected SLASH_COMMANDS to register many commands");
	});

	it("registers every command the handler chain dispatches", () => {
		const dispatched = dispatchedCommands();
		const registered = registeredCommands();
		const missing = [...dispatched].filter((c) => !registered.has(c)).sort();
		assert.deepEqual(
			missing,
			[],
			`These commands are dispatched but not in SLASH_COMMANDS, so they have no ` +
				`autocomplete and are treated as steering text mid-turn: ${missing.join(", ")}`,
		);
	});
});
