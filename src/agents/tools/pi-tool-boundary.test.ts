/**
 * The tool boundary is a contract, and this is what enforces it.
 *
 * Pi's tool wrapper copies seven named fields into the object its loop sees and
 * drops everything else — silently, with no type error, because `BrigadeTool`
 * extends `AgentTool` and adding a field to it compiles fine.
 *
 * The contract needs BOTH halves below, because each catches what the other
 * structurally cannot:
 *
 *   • COMPILE-TIME — `BOUNDARY_DECLARED` is typed `Record<BrigadeOwnKeys, true>`,
 *     so a new field on `BrigadeTool` fails `tsc` as a missing property and a
 *     field removed from the type fails as an excess one. That pins the runtime
 *     list to the type in BOTH directions, which is why nothing here is written
 *     out by hand: a list a human retypes is a list that restates the answer.
 *
 *   • RUNTIME — the suite runs under `tsx`, which STRIPS types and never
 *     typechecks. So the compile-time half is invisible to `npm test`, and a
 *     tool assembled at runtime (an extension's, an MCP server's) never met the
 *     compiler at all. The sweeps below walk Brigade's REAL tool surface and
 *     fail on any field that is neither carried by Pi nor consumed by Brigade.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

// HOME → tempdir BEFORE importing the tool registry: several modules on that
// import graph (exec-approvals and friends) pin paths at load time, and a test
// that assembles the real toolset must not read the developer's own state.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-pi-boundary-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.BRIGADE_HOME;
// Composio and render_video are availability-gated. Neither gate changes what
// this file asserts (it sweeps whatever tools exist), but pinning them keeps
// the swept set identical on a developer box that happens to have them.
delete process.env.COMPOSIO_API_KEY;
process.env.BRIGADE_HYPERFRAMES_PATH = path.join(tmpHome, "no-such-hyperframes");

const {
	BRIGADE_LOCAL_TOOL_FIELDS,
	PI_CARRIED_TOOL_FIELDS,
	fieldsPiWillDrop,
	unhandledPiDroppedFields,
	warnUnhandledPiDroppedFields,
} = await import("./pi-tool-boundary.js");
const { assembleBrigadeToolset } = await import("../session-wiring.js");
const { makeFetchUrlTool } = await import("./web-fetch.js");
const { makeBrowserTool } = await import("./browser.js");

import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { BrigadeTool } from "./types.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-pi-boundary-ws-"));
fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });

after(() => {
	if (originalHome !== undefined) process.env.HOME = originalHome;
	else delete process.env.HOME;
	if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
	else delete process.env.USERPROFILE;
	for (const dir of [workspace, tmpHome]) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

/**
 * COMPILE-TIME half of the contract, and the only list of Brigade-own fields
 * in this file.
 *
 * `BrigadeOwnKeys` is derived from the type — every key `BrigadeTool` adds on
 * top of Pi's `AgentTool`. `Record<BrigadeOwnKeys, true>` then rejects both a
 * missing key (a new `BrigadeTool` field nobody classified) and an excess one
 * (a field deleted from the type but left behind here), so `Object.keys` of it
 * is a compiler-verified projection of the type rather than a hand-copy.
 */
type BrigadeOwnKeys = Exclude<keyof BrigadeTool, keyof AgentTool>;
const BOUNDARY_DECLARED: Record<BrigadeOwnKeys, true> = {
	ownerOnly: true,
	displaySummary: true,
};

test("every Brigade-only tool field is declared on one side of the boundary", () => {
	// The whole point. A field that is neither carried by Pi nor consumed by
	// Brigade is a field that vanishes with no symptom.
	const carried = new Set<string>(PI_CARRIED_TOOL_FIELDS);
	const local = new Set<string>(BRIGADE_LOCAL_TOOL_FIELDS);
	const declared = Object.keys(BOUNDARY_DECLARED);
	assert.ok(declared.length > 0, "BrigadeTool should add at least one field over AgentTool");
	for (const field of declared) {
		assert.ok(
			carried.has(field) || local.has(field),
			`\`${field}\` is on BrigadeTool but declared on neither side of the Pi boundary.\n` +
				`Pi's tool wrapper copies only: ${PI_CARRIED_TOOL_FIELDS.join(", ")}.\n` +
				`Either consume it Brigade-side (add to BRIGADE_LOCAL_TOOL_FIELDS) or carry it across yourself.`,
		);
	}
});

test("no field Brigade declares local is one Pi already carries", () => {
	// A field in both lists means someone "handled" Brigade-side something Pi
	// delivers anyway — harmless today, but it makes the boundary lie about
	// which side owns the field.
	const carried = new Set<string>(PI_CARRIED_TOOL_FIELDS);
	assert.deepEqual(
		BRIGADE_LOCAL_TOOL_FIELDS.filter((f) => carried.has(f)),
		[],
		"a field cannot be both carried by Pi and consumed Brigade-side",
	);
});

/**
 * Locate Pi's tool wrapper on disk by walking up to the installing
 * `node_modules`. A Pi upgrade that MOVES or renames this file should be as
 * loud as one that changes its field list, so a miss throws rather than skips.
 */
function resolvePiWrapperSource(): string {
	const rel = path.join(
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"core",
		"tools",
		"tool-definition-wrapper.js",
	);
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidate = path.join(dir, rel);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		`Could not find Pi's ${rel}. If a Pi upgrade moved it, re-verify ` +
			`PI_CARRIED_TOOL_FIELDS against the new wrapper and update this path.`,
	);
}

test("PI_CARRIED_TOOL_FIELDS still matches Pi's tool wrapper source", () => {
	// The module claims this list is "verified against
	// tool-definition-wrapper.js". Verify it against that file, not against a
	// sample tool — a sample only proves the fields a given tool happens to set,
	// while the wrapper source is the actual copy list. A Pi upgrade that adds
	// or drops a carried field lands here instead of in a dead feature.
	// Read the file directly rather than resolving it: Pi's `exports` map
	// publishes only ".", so every deep subpath is unresolvable by design.
	const wrapperPath = resolvePiWrapperSource();
	const src = fs.readFileSync(wrapperPath, "utf8");
	// Both exported wrappers build their object from the same fixed field list;
	// `createToolDefinitionFromAgentTool` is the one Brigade's `customTools`
	// actually go through. Read the first object literal of each and compare.
	const bodies = src.match(/return\s*\{[\s\S]*?\n\s*\};/g) ?? [];
	assert.ok(bodies.length >= 2, "expected both wrapper functions in Pi's wrapper source");
	for (const body of bodies.slice(0, 2)) {
		const copied = [...body.matchAll(/^\s{8}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]);
		assert.deepEqual(
			[...copied].sort(),
			[...PI_CARRIED_TOOL_FIELDS].sort(),
			`Pi's wrapper now copies a different field list than PI_CARRIED_TOOL_FIELDS.\n` +
				`Wrapper: ${copied.join(", ")}\nBrigade: ${PI_CARRIED_TOOL_FIELDS.join(", ")}`,
		);
	}
});

test("every tool Brigade hands to Pi survives the boundary", () => {
	// RUNTIME conformance, derived from the real objects rather than from a
	// list of field names. `tsx` strips types, so this is the ONLY half of the
	// contract that `npm test` can see — and the only one that can catch a
	// field on a tool the compiler never inspected.
	const toolset = assembleBrigadeToolset({ workspaceDir: workspace, agentId: "main", cwd: workspace });
	assert.ok(toolset.customTools.length > 0, "expected a real Brigade tool surface to sweep");
	const offenders: string[] = [];
	for (const tool of toolset.customTools) {
		const unhandled = unhandledPiDroppedFields(tool);
		if (unhandled.length > 0) offenders.push(`${tool.name}: ${unhandled.join(", ")}`);
	}
	assert.deepEqual(
		offenders,
		[],
		`These tools carry fields Pi drops and Brigade does not consume:\n  ${offenders.join("\n  ")}\n` +
			`Add each to BRIGADE_LOCAL_TOOL_FIELDS (and consume it Brigade-side) or carry it across yourself.`,
	);
});

test("the web tools appended after toolset assembly survive it too", () => {
	// `fetch_url` / `web_search` / the browser tool are pushed onto the custom
	// tool array in the agent loop, AFTER `assembleBrigadeToolset` returns — so
	// the sweep above never sees them. They reach Pi all the same.
	const late = [makeFetchUrlTool({}), makeBrowserTool({})];
	for (const tool of late) {
		assert.deepEqual(
			unhandledPiDroppedFields(tool),
			[],
			`${tool.name} carries a field Pi drops that Brigade does not consume`,
		);
	}
});

test("fieldsPiWillDrop names exactly what Pi discards", () => {
	const tool = {
		name: "read",
		description: "d",
		parameters: {},
		execute: () => {},
		ownerOnly: true,
		displaySummary: "reading",
		somethingNew: 1,
	};
	const dropped = fieldsPiWillDrop(tool).sort();
	assert.deepEqual(dropped, ["displaySummary", "ownerOnly", "somethingNew"]);
});

test("unhandledPiDroppedFields ignores fields Brigade consumes itself", () => {
	// `ownerOnly` and `displaySummary` are dropped by Pi and that is FINE —
	// Brigade reads them on its own side. Only a field nobody handles is a bug.
	const safe = {
		name: "read",
		execute: () => {},
		ownerOnly: true,
		displaySummary: "reading",
	};
	assert.deepEqual(unhandledPiDroppedFields(safe), []);

	const risky = { name: "read", execute: () => {}, retryPolicy: { max: 3 } };
	assert.deepEqual(
		unhandledPiDroppedFields(risky),
		["retryPolicy"],
		"a field nobody handles must be reported — Pi will drop it silently",
	);
});

test("a tool carrying only Pi-known fields reports nothing", () => {
	const plain = { name: "n", label: "l", description: "d", parameters: {}, execute: () => {} };
	assert.deepEqual(fieldsPiWillDrop(plain), []);
	assert.deepEqual(unhandledPiDroppedFields(plain), []);
});

test("the runtime reporter logs rather than throws, whatever it is handed", () => {
	// The production contract: report, never refuse. A tool the reporter cannot
	// even enumerate must not take the turn down with it — which is exactly the
	// shape a third-party extension can produce.
	const hostile = new Proxy(
		{ name: "hostile", execute: () => {} },
		{
			ownKeys() {
				throw new Error("ownKeys trap exploded");
			},
		},
	);
	assert.doesNotThrow(() => {
		warnUnhandledPiDroppedFields(
			[
				{ name: "fine", execute: () => {} },
				{ name: "leaky", execute: () => {}, retryPolicy: { max: 3 } },
				hostile,
				// Non-objects and nameless tools must not derail the sweep either.
				null as unknown as object,
				{ execute: () => {}, mystery: 1 },
			],
			"unit-test",
		);
	});
});
