// src/storage/convex/instance-store.ts
//
// Heartbeat + PID land in Convex; the gateway LOCK stays local —
// `fs.open("wx")` has no Convex equivalent and is one of the five
// always-local carve-outs (see `project_brigade_phase_2_user_flow`).
// In convex mode we delegate the lock to the existing filesystem-mode
// helpers; everything else round-trips through Convex.

import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";
import { acquireSessionWriteLock } from "../../sessions/session-write-lock.js";
import * as path from "node:path";
import { resolveOsCacheDir } from "../../config/paths.js";

import type {
	GatewayLockHandle,
	InstanceStore,
	SuperviseDecision,
} from "../store.js";

interface Deps { client: ConvexHttpClient; instanceId: string; stateDir: string }

export class ConvexInstanceStore implements InstanceStore {
	constructor(private readonly deps: Deps) {}

	async writePid(pid: number): Promise<void> {
		await this.deps.client.mutation(api.instance.writePid, {
			instanceId: this.deps.instanceId,
			pid,
		});
	}

	async readPid(): Promise<number | undefined> {
		const row = (await this.deps.client.query(api.instance.getCoord, {
			instanceId: this.deps.instanceId,
		})) as { pid?: number } | null;
		return row?.pid ?? undefined;
	}

	async clearPid(): Promise<void> {
		await this.deps.client.mutation(api.instance.clearPid, {
			instanceId: this.deps.instanceId,
		});
	}

	async writeHeartbeat(beat: { ts: number; pid: number; uptimeMs: number }): Promise<void> {
		await this.deps.client.mutation(api.instance.writeHeartbeat, {
			instanceId: this.deps.instanceId,
			ts: beat.ts,
			pid: beat.pid,
			uptimeMs: beat.uptimeMs,
		});
	}

	async readHeartbeat(): Promise<{ ts: number; pid: number; uptimeMs: number } | undefined> {
		const row = (await this.deps.client.query(api.instance.getCoord, {
			instanceId: this.deps.instanceId,
		})) as { heartbeatTs?: number; heartbeatPid?: number; heartbeatUptimeMs?: number } | null;
		if (!row || row.heartbeatTs === undefined || row.heartbeatPid === undefined) return undefined;
		return {
			ts: row.heartbeatTs,
			pid: row.heartbeatPid,
			uptimeMs: row.heartbeatUptimeMs ?? 0,
		};
	}

	async clearHeartbeat(): Promise<void> {
		await this.deps.client.mutation(api.instance.clearHeartbeat, {
			instanceId: this.deps.instanceId,
		});
	}

	async acquireLock(args: {
		port: number;
		timeoutMs?: number;
		pollIntervalMs?: number;
		staleMs?: number;
	}): Promise<GatewayLockHandle> {
		// Lock stays local. The session-write-lock helper uses fs.open("wx")
		// which is the safest atomic exclusive-create primitive available.
		const lockFile = path.join(resolveOsCacheDir(), "gateway.lock");
		const handle = await acquireSessionWriteLock({
			sessionFile: lockFile,
			...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
		});
		return { port: args.port, release: () => handle.release() };
	}

	async checkHealth(opts?: { maxStaleMs?: number; nowMs?: number }): Promise<SuperviseDecision> {
		const row = (await this.deps.client.query(api.instance.getCoord, {
			instanceId: this.deps.instanceId,
		})) as {
			pid?: number;
			heartbeatTs?: number;
		} | null;
		const now = opts?.nowMs ?? Date.now();
		const maxStale = opts?.maxStaleMs ?? 90_000;
		if (!row || row.pid === undefined) {
			return { ok: false, kind: "no-pid", reason: "no gateway recorded" } as SuperviseDecision;
		}
		if (row.heartbeatTs === undefined) {
			return { ok: false, kind: "no-heartbeat", reason: "no heartbeat recorded" } as SuperviseDecision;
		}
		const ageMs = now - row.heartbeatTs;
		if (ageMs > maxStale) {
			return { ok: false, kind: "stale", ageMs, pid: row.pid, reason: `heartbeat ${ageMs}ms old` } as SuperviseDecision;
		}
		return { ok: true, kind: "healthy", ageMs, pid: row.pid } as SuperviseDecision;
	}
}
