/**
 * Cron runs must reach the usage ledger.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SOURCE-STRUCTURE TEST
 * ─────────────────────────────────────────────────────────────────────────
 * Cron calls `runSingleTurn` directly rather than going through the gateway's
 * `runGatewayTurn`, so `attachTurnSession` never ran for it and the ledger was
 * never written. The event-bus fallback that catches everything else explicitly
 * skips depth-0 runs, so nothing caught it either: a nightly job on a frontier
 * model reported ZERO on the footer, in `/usage` and in `sessions.list`, for
 * ever, while appearing in full on the provider's invoice.
 *
 * The wiring is a callback threaded across three modules, and `runSingleTurn`
 * is a dynamic import inside the executor — so a runtime test would need to
 * mock the module graph, and would mostly assert that the mock was called. What
 * actually needs guarding is that the three ends stay connected, which is a
 * property of the source. This is the same approach `connect-slash-commands`
 * uses for its registry, for the same reason: the failure is silent, and it is
 * a disconnection rather than a wrong value.
 *
 * Each check asserts its own anchor is still findable, so a refactor that
 * renames something fails loudly here instead of passing vacuously.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXECUTOR = readFileSync(path.join(HERE, "run-executor.ts"), "utf8");
const SERVER = readFileSync(path.join(HERE, "..", "..", "core", "server.ts"), "utf8");
const STATE = readFileSync(path.join(HERE, "..", "service", "state.ts"), "utf8");

describe("cron usage metering wiring", () => {
	it("the run args carry a session-ready hook", () => {
		assert.match(
			STATE,
			/onSessionReady\?:\s*\(/,
			"CronIsolatedRunArgs must expose onSessionReady — without it the gateway cannot meter a cron run",
		);
	});

	it("the executor forwards that hook to runSingleTurn", () => {
		// The call must actually pass it through; declaring the arg and dropping
		// it is exactly the silent failure this guards.
		const call = EXECUTOR.slice(EXECUTOR.indexOf("await runSingleTurn({"));
		assert.ok(call.length > 0, "runSingleTurn call not found — this test needs updating");
		const body = call.slice(0, call.indexOf("\n\t\t});"));
		assert.match(
			body,
			/onSessionReady/,
			"runSingleTurn must receive onSessionReady, or the cron session is never metered",
		);
		assert.match(
			body,
			/args\.onSessionReady\?\.\(session, agentId, sessionKey\)/,
			"the hook must be called with the run's own agentId and sessionKey, not the gateway's defaults",
		);
	});

	it("the gateway supplies the hook and attaches the session", () => {
		const idx = SERVER.indexOf("runIsolatedAgentJob:");
		assert.ok(idx > 0, "runIsolatedAgentJob injection not found — this test needs updating");
		const block = SERVER.slice(idx, idx + 1600);
		assert.match(block, /onSessionReady/, "the gateway must pass onSessionReady to the cron runner");
		assert.match(
			block,
			/attachTurnSession\(/,
			"the hook must attach the session, which is what writes the ledger",
		);
	});

	it("a metering failure is logged, not swallowed", () => {
		// A silent catch here reproduces the bug being fixed: spend quietly going
		// unrecorded while every surface reports zero.
		const idx = SERVER.indexOf("runIsolatedAgentJob:");
		const block = SERVER.slice(idx, idx + 1600);
		assert.match(block, /cron usage metering failed to attach/);
	});
});
