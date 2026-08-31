/**
 * The tool boundary is a contract, and this is what enforces it.
 *
 * Pi's `wrapToolDefinition` copies seven named fields into the object its loop
 * sees and drops everything else — silently, with no type error, because
 * `BrigadeTool` extends `AgentTool` and adding a field to it compiles fine.
 *
 * The first test below fails the build if someone adds a `BrigadeTool` field
 * without deciding which side of the boundary it lives on. That turns a silent
 * drop into a compile-time conversation, which is the only reliable defence
 * against a failure mode whose symptom is nothing happening.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	BRIGADE_LOCAL_TOOL_FIELDS,
	PI_CARRIED_TOOL_FIELDS,
	fieldsPiWillDrop,
	unhandledPiDroppedFields,
} from "./pi-tool-boundary.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { BrigadeTool } from "./types.js";

/**
 * Every optional field `BrigadeTool` adds on top of Pi's `AgentTool`.
 *
 * This is written out by hand ON PURPOSE. TypeScript types are erased at
 * runtime, so nothing can derive this list automatically — and that is exactly
 * why the field was droppable in the first place. Adding a field to
 * `BrigadeTool` without adding it here fails the assertion below.
 */
const BRIGADE_TOOL_OWN_FIELDS = ["ownerOnly", "displaySummary"] as const;

/**
 * COMPILE-TIME half of the contract, and the load-bearing one.
 *
 * `BrigadeOwnKeys` is derived from the type itself — every key `BrigadeTool`
 * adds on top of Pi's `AgentTool`. `Record<BrigadeOwnKeys, true>` then fails to
 * type-check the moment a new field appears on `BrigadeTool` and is not listed
 * here, so the build stops before anyone can ship a field Pi silently drops.
 *
 * The runtime list below must stay in step; the test that follows asserts it.
 */
type BrigadeOwnKeys = Exclude<keyof BrigadeTool, keyof AgentTool>;
const BOUNDARY_DECLARED: Record<BrigadeOwnKeys, true> = {
	ownerOnly: true,
	displaySummary: true,
};

test("the runtime field list matches the type", () => {
	// The compile-time check above cannot be read at runtime (types are erased),
	// so the two lists are kept in step here. Drift means the boundary test
	// below is checking a stale set.
	assert.deepEqual(
		[...BRIGADE_TOOL_OWN_FIELDS].sort(),
		Object.keys(BOUNDARY_DECLARED).sort(),
		"BRIGADE_TOOL_OWN_FIELDS has drifted from BrigadeTool's actual keys",
	);
});

test("every Brigade-only tool field is declared on one side of the boundary", () => {
	// The whole point. A field that is neither carried by Pi nor consumed by
	// Brigade is a field that vanishes with no symptom.
	const carried = new Set<string>(PI_CARRIED_TOOL_FIELDS);
	const local = new Set<string>(BRIGADE_LOCAL_TOOL_FIELDS);
	for (const field of BRIGADE_TOOL_OWN_FIELDS) {
		assert.ok(
			carried.has(field) || local.has(field),
			`\`${field}\` is on BrigadeTool but declared on neither side of the Pi boundary.\n` +
				`Pi's wrapToolDefinition copies only: ${PI_CARRIED_TOOL_FIELDS.join(", ")}.\n` +
				`Either consume it Brigade-side (add to BRIGADE_LOCAL_TOOL_FIELDS) or carry it across yourself.`,
		);
	}
});

test("the carried-field list still matches Pi's wrapper", async () => {
	// If a Pi upgrade changes which fields survive, this is where we find out —
	// rather than in a feature that quietly stops working.
	const mod = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
	const create = mod.createReadTool as ((cwd: string) => object) | undefined;
	assert.equal(typeof create, "function", "createReadTool should exist to sample a real tool");
	const real = create!(process.cwd());
	// Every field Pi's own tool exposes must be one we know about — otherwise
	// our model of the boundary is stale.
	const unknown = fieldsPiWillDrop(real).filter(
		(f) => !(BRIGADE_LOCAL_TOOL_FIELDS as readonly string[]).includes(f),
	);
	assert.deepEqual(
		unknown,
		[],
		`Pi's own tool carries fields this boundary does not model: ${unknown.join(", ")}`,
	);
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
