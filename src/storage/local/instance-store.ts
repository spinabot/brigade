// src/storage/local/instance-store.ts
//
// LocalInstanceStore — filesystem-mode wrapper around the gateway-liveness
// trio: `gateway.pid` / `gateway.heartbeat` / `gateway.lock` plus the
// supervisor's `checkGatewayHealth`. Implements `InstanceStore`.
//
// Filesystem mode is the canonical home for these files — the `fs.open("wx")`
// atomic-exclusive-create primitive used by `acquireGatewayLock` has no
// Convex equivalent, so even in convex mode the lock stays local (per the
// Phase 2 design's "5 carve-outs that always stay local").
//
// The public `writePid` / `writeHeartbeat` interfaces accept explicit args
// but the underlying writers use `process.pid` / `process.uptime()` directly.
// That matches today's behaviour — the lone production caller is the
// gateway itself, which IS the current process. We accept the slight
// contract relaxation as the price of byte-for-byte wrap discipline.

import {
	clearHeartbeatFile,
	clearPidFile,
	readHeartbeatFile,
	readPidFile,
	writeHeartbeatFile,
	writePidFile,
} from "../../core/gateway-probe.js";
import {
	acquireGatewayLock,
	type GatewayLockHandle as InternalLockHandle,
} from "../../core/gateway-lock.js";
import { checkGatewayHealth } from "../../cli/commands/gateway-supervise.js";

import type {
	GatewayLockHandle,
	InstanceStore,
	SuperviseDecision,
} from "../store.js";

export class LocalInstanceStore implements InstanceStore {
	constructor(private readonly _stateDir: string) {}

	async writePid(_pid: number): Promise<void> {
		// Underlying writer captures process.pid — matches today's behaviour;
		// the lone production caller IS the gateway process. Tests that want
		// a controlled PID write directly to the path the writer uses.
		await writePidFile();
	}

	async readPid(): Promise<number | undefined> {
		return readPidFile();
	}

	async clearPid(): Promise<void> {
		await clearPidFile();
	}

	async writeHeartbeat(_beat: { ts: number; pid: number; uptimeMs: number }): Promise<void> {
		// Same shape as writePid — internal helper captures live process
		// state. Caller's payload is ignored; today's gateway always writes
		// from its own process.
		await writeHeartbeatFile();
	}

	async readHeartbeat(): Promise<{ ts: number; pid: number; uptimeMs: number } | undefined> {
		const beat = readHeartbeatFile();
		return beat ?? undefined;
	}

	async clearHeartbeat(): Promise<void> {
		await clearHeartbeatFile();
	}

	async acquireLock(args: {
		port: number;
		timeoutMs?: number;
		pollIntervalMs?: number;
		staleMs?: number;
	}): Promise<GatewayLockHandle> {
		const handle: InternalLockHandle = await acquireGatewayLock({
			port: args.port,
			...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
			...(args.pollIntervalMs !== undefined ? { pollIntervalMs: args.pollIntervalMs } : {}),
			...(args.staleMs !== undefined ? { staleMs: args.staleMs } : {}),
		});
		// Map internal handle to the public shape — the internal carries
		// path/pid/release; port lives in the lock payload (not the handle).
		// We surface the port the caller asked for, which by construction
		// matches what landed in the file.
		return {
			port: args.port,
			release: () => handle.release(),
		};
	}

	async checkHealth(opts?: { maxStaleMs?: number; nowMs?: number }): Promise<SuperviseDecision> {
		// Internal `SuperviseOptions.nowMs` is a CLOCK FN (`() => number`),
		// not a timestamp. The public interface takes a literal ms timestamp
		// for ergonomics; wrap it in a constant clock when supplied.
		const decision = await checkGatewayHealth({
			...(opts?.maxStaleMs !== undefined ? { maxStaleMs: opts.maxStaleMs } : {}),
			...(opts?.nowMs !== undefined ? { nowMs: () => opts.nowMs as number } : {}),
		});
		// `SuperviseDecision` internal type is a tagged union (healthy /
		// dead-pid / no-heartbeat / stale / no-pid) — surface `.ok` plus
		// the raw decision for callers that need to drill in.
		return {
			ok: decision.kind === "healthy",
			...(decision as unknown as Record<string, unknown>),
		} as SuperviseDecision;
	}
}
