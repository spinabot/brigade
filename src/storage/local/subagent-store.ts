// src/storage/local/subagent-store.ts
//
// LocalSubagentStore — filesystem-mode wrapper around
// `src/agents/subagent-registry.ts`. Implements `SubagentStore`.
//
// In filesystem mode, sub-agent runs live entirely in-memory (a process-
// wide Map keyed by runId). There is NO on-disk persistence — when the
// gateway restarts the registry resets. This is intentional: sub-agent
// runs are scoped to the parent run that spawned them; a crashed parent
// has no way to "resume" its child.
//
// In convex mode (later PR16), the same surface persists rows in the
// `subagentRuns` table so the dashboard can show a fleet view.

import {
	countActiveRunsForSession,
	getSpawnedKeysForSession,
	getSubagentRun,
	getSubagentRunByChildSessionKey,
	listActiveSubagentRunsForController,
	listSubagentRunsForRequester,
	markSubagentRunCompleted,
	registerSubagentRun,
	releaseSubagentRun,
} from "../../agents/subagent-registry.js";
import type { SubagentRunRecord as InternalRunRecord } from "../../agents/subagent-registry.types.js";
import type { SubagentLifecycleEndedReason } from "../../agents/subagent-lifecycle-events.js";

import type {
	SubagentLifecycleEndedReason as PublicEndedReason,
	SubagentRunOutcome,
	SubagentRunRecord,
	SubagentStore,
} from "../store.js";

function toPublic(record: InternalRunRecord): SubagentRunRecord {
	return record as unknown as SubagentRunRecord;
}

function toPublicArr(records: InternalRunRecord[]): SubagentRunRecord[] {
	return records.map(toPublic);
}

export class LocalSubagentStore implements SubagentStore {
	async put(record: SubagentRunRecord): Promise<void> {
		registerSubagentRun(record as unknown as InternalRunRecord);
	}

	async get(runId: string): Promise<SubagentRunRecord | undefined> {
		const entry = getSubagentRun(runId);
		return entry ? toPublic(entry) : undefined;
	}

	async getByChildSessionKey(childSessionKey: string): Promise<SubagentRunRecord | undefined> {
		const entry = getSubagentRunByChildSessionKey(childSessionKey);
		return entry ? toPublic(entry) : undefined;
	}

	async listByRequester(requesterSessionKey: string): Promise<SubagentRunRecord[]> {
		return toPublicArr(listSubagentRunsForRequester(requesterSessionKey));
	}

	async listActiveByController(controllerSessionKey: string): Promise<SubagentRunRecord[]> {
		return toPublicArr(listActiveSubagentRunsForController(controllerSessionKey));
	}

	async countActiveByRequester(requesterSessionKey: string): Promise<number> {
		return countActiveRunsForSession(requesterSessionKey);
	}

	async spawnedKeysFor(parentSessionKey: string): Promise<Set<string>> {
		return getSpawnedKeysForSession(parentSessionKey);
	}

	async markCompleted(args: {
		runId: string;
		outcome: SubagentRunOutcome;
		reason: PublicEndedReason;
		endedAt: number;
		error?: string;
		endedHookEmittedAt?: number;
	}): Promise<SubagentRunRecord | undefined> {
		// The internal `markSubagentRunCompleted` requires `lifecycleOutcome`
		// (the SUBAGENT_ENDED_OUTCOME_* constant) AND the `reason`. The public
		// interface only carries `reason` because callers in storage adapter
		// land don't have to know about lifecycle hook constants. Derive a
		// sensible lifecycle outcome from the public outcome.status when the
		// caller hasn't supplied one — `ok` / `error` / `timeout` / `abort`
		// all map straight through.
		const lifecycleOutcome = (args.outcome as { status?: string }).status ?? "ok";
		// `InternalRunRecord["outcome"]` is optional but the internal
		// `markSubagentRunCompleted` typing requires it. Cast through `never`
		// — the public interface guarantees outcome is supplied.
		const entry = await markSubagentRunCompleted({
			runId: args.runId,
			outcome: args.outcome as never,
			reason: args.reason as SubagentLifecycleEndedReason,
			lifecycleOutcome: lifecycleOutcome as never,
			endedAt: args.endedAt,
			...(args.error !== undefined ? { error: args.error } : {}),
		});
		return entry ? toPublic(entry) : undefined;
	}

	async delete(runId: string): Promise<boolean> {
		return releaseSubagentRun(runId);
	}
}
