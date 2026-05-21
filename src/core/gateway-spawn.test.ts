import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { ensureGatewayRunning } from "./gateway-spawn.js";

/**
 * These tests exercise the spawn + readiness machinery WITHOUT a real
 * gateway. They use:
 *   - a high, almost-certainly-free port so the initial probe ECONNREFUSEs
 *     fast (proving "not already running" → we proceed to spawn), and
 *   - `BRIGADE_GATEWAY_SPAWN_ARGV` to substitute a cheap, deterministic
 *     child process for the real `node brigade.mjs gateway run` re-exec.
 *
 * They cover the two fail-fast paths the per-turn refactor added (the audit
 * flagged these as previously-uncovered): a child that exits immediately,
 * and a child that lives but never binds the port (timeout).
 */

// A port that nothing should be listening on during tests.
const DEAD_PORT = 47291;

function withSpawnArgv<T>(argv: string[], fn: () => Promise<T>): Promise<T> {
	const prev = process.env.BRIGADE_GATEWAY_SPAWN_ARGV;
	process.env.BRIGADE_GATEWAY_SPAWN_ARGV = JSON.stringify(argv);
	return fn().finally(() => {
		if (prev === undefined) delete process.env.BRIGADE_GATEWAY_SPAWN_ARGV;
		else process.env.BRIGADE_GATEWAY_SPAWN_ARGV = prev;
	});
}

describe("ensureGatewayRunning — fail-fast on a daemon that exits immediately", () => {
	it("throws with the child's exit code instead of dead-waiting the timeout", async () => {
		// Child exits 3 right away → the exit watcher should short-circuit the
		// poll loop well before the (generous) spawn timeout.
		await withSpawnArgv(
			[process.execPath, "-e", "process.exit(3)"],
			async () => {
				const startedAt = Date.now();
				await assert.rejects(
					() =>
						ensureGatewayRunning({
							port: DEAD_PORT,
							spawnTimeoutMs: 10_000,
						}),
					/stopped right after starting \(exit code 3\)/,
				);
				// Proven fast-fail: nowhere near the 10s timeout.
				assert.ok(
					Date.now() - startedAt < 5_000,
					"should fail fast on early child exit, not wait for the full timeout",
				);
			},
		);
	});
});

describe("ensureGatewayRunning — timeout when the daemon never binds the port", () => {
	it("throws a 'didn't come online' error after the spawn timeout", async () => {
		// Child stays alive (sleeps) but never opens a listener → the probe
		// keeps refusing and we hit the timeout path. Keep the timeout short.
		await withSpawnArgv(
			[process.execPath, "-e", "setTimeout(() => {}, 60000)"],
			async () => {
				await assert.rejects(
					() =>
						ensureGatewayRunning({
							port: DEAD_PORT,
							spawnTimeoutMs: 700,
						}),
					/didn't come online within/,
				);
			},
		);
	});
});
