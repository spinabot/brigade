import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { BrigadeConfig } from "../config/io.js";
import { primeConfigCache } from "../storage/config-cache.js";
import { handleAgentsBind, handleAgentsBindings, handleAgentsUnbind } from "./agents-ops.js";

let prevStateDir: string | undefined;

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "brigade-agents-ops-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
	primeConfigCache({ agents: {} } as BrigadeConfig);
});
afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	primeConfigCache({ agents: {} } as BrigadeConfig);
});

test("bindings: empty config → no bindings", () => {
	assert.deepEqual(handleAgentsBindings({}).bindings, []);
});

test("bind: unknown agent → ok:false 'not found'", () => {
	const r = handleAgentsBind({ agentId: "ghost", specs: ["whatsapp"] });
	assert.equal(r.ok, false);
	assert.match((r.errors ?? []).join(" "), /not found/);
});

test("bind: empty specs → ok:false", () => {
	assert.equal(handleAgentsBind({ agentId: "main", specs: [] }).ok, false);
});

test("bind 'main' → added; bindings lists it; unbind --all clears", () => {
	const bound = handleAgentsBind({ agentId: "main", specs: ["whatsapp"] });
	assert.equal(bound.ok, true, `bind errors: ${JSON.stringify(bound.errors)}`);
	assert.ok(bound.added.length >= 1);
	const list = handleAgentsBindings({});
	assert.ok(list.bindings.some((b) => b.agentId === "main"));
	const cleared = handleAgentsUnbind({ agentId: "main", all: true });
	assert.equal(cleared.ok, true);
	assert.ok(cleared.removed.length >= 1);
	assert.deepEqual(handleAgentsBindings({}).bindings, []);
});

test("unbind: no specs and no --all → ok:false", () => {
	assert.equal(handleAgentsUnbind({ agentId: "main", specs: [] }).ok, false);
});
