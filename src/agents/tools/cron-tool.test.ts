/**
 * cron-tool — focused tests for the flat-params recovery branch + the
 * `contextMessages` attachment path. Wider end-to-end coverage lives in
 * the gateway / cron service test suites; here we exercise the tool's
 * own per-action branches with a stub cron service.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setActiveCronService } from "../../cron/active-service.js";
import {
	createCronServiceState,
	type CronServiceState,
} from "../../cron/service/state.js";
import { stopTimer } from "../../cron/service/timer.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { makeCronTool } from "./cron-tool.js";

function setupCronService(): { state: CronServiceState; cleanup: () => void } {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-tool-test-"));
	const storePath = path.join(tempDir, "cron.json");
	const state = createCronServiceState({
		storePath,
		config: { enabled: true },
		deps: {
			log: createSubsystemLogger("cron-tool-test"),
		},
	});
	setActiveCronService(state);
	return {
		state,
		cleanup: () => {
			stopTimer(state);
			setActiveCronService(null);
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

async function callTool(tool: ReturnType<typeof makeCronTool>, params: unknown) {
	return tool.execute("call-id", params as never);
}

describe("cron-tool — flat-params recovery (add)", () => {
	it("synthesizes `job` from top-level keys when schedule + payload are present", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			const res = await callTool(tool, {
				action: "add",
				name: "flat-recovery-job",
				schedule: { kind: "every", everyMs: 60_000 },
				sessionTarget: "isolated",
				payload: { kind: "agentTurn", message: "do thing" },
			});
			assert.equal((res as { isError?: boolean }).isError !== true, true);
			const text = JSON.stringify(res);
			assert.equal(text.includes("flat-recovery-job"), true);
		} finally {
			fx.cleanup();
		}
	});

	it("synthesizes `job` when params.job is an empty object {}", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			const res = await callTool(tool, {
				action: "add",
				job: {},
				name: "empty-job-recovered",
				schedule: { kind: "every", everyMs: 30_000 },
				sessionTarget: "isolated",
				payload: { kind: "agentTurn", message: "x" },
			});
			const text = JSON.stringify(res);
			assert.equal(text.includes("empty-job-recovered"), true);
		} finally {
			fx.cleanup();
		}
	});

	it("does NOT promote without minimum-signal keys (name/enabled alone is insufficient)", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			const res = await callTool(tool, {
				action: "add",
				name: "only-name",
				enabled: true,
				// no schedule / payload / message / text → recovery refuses
			});
			const text = JSON.stringify(res);
			assert.equal(text.includes("`job` parameter required"), true);
		} finally {
			fx.cleanup();
		}
	});

	it("nested `job` wins outright when both nested and flat siblings are present", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "nested-wins",
					schedule: { kind: "every", everyMs: 30_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "nested" },
				},
				name: "flat-loses",
				schedule: { kind: "every", everyMs: 60_000 },
			});
			const text = JSON.stringify(res);
			assert.equal(text.includes("nested-wins"), true);
			assert.equal(text.includes("flat-loses"), false);
		} finally {
			fx.cleanup();
		}
	});
});

describe("cron-tool — flat-params recovery (update)", () => {
	it("synthesizes `patch` from top-level keys without minimum-signal gate", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			// First add a job.
			const addRes = await callTool(tool, {
				action: "add",
				job: {
					name: "to-update",
					schedule: { kind: "every", everyMs: 30_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "hi" },
				},
			});
			const m = JSON.stringify(addRes).match(/"id":"([^"]+)"/);
			assert.ok(m, "expected job id in add result");
			const id = m![1]!;
			// Patch via flat top-level `enabled` only — update's recovery has
			// NO minimum-signal gate, so this should land.
			const updRes = await callTool(tool, {
				action: "update",
				jobId: id,
				enabled: false,
			});
			const txt = JSON.stringify(updRes);
			assert.equal(txt.includes('"enabled":false'), true);
		} finally {
			fx.cleanup();
		}
	});
});

describe("cron-tool — sessionTarget 'current' resolution", () => {
	it("resolves 'current' to session:<sessionKey> at create time", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool({ agentSessionKey: "agent:main:peer-9" });
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "current-binder",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "current",
					payload: { kind: "agentTurn", message: "x" },
				},
			});
			const text = JSON.stringify(res);
			assert.equal(text.includes('"sessionTarget":"session:agent:main:peer-9"'), true);
		} finally {
			fx.cleanup();
		}
	});

	it("falls back to 'isolated' when no agentSessionKey is supplied", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "current-fallback",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "current",
					payload: { kind: "agentTurn", message: "x" },
				},
			});
			const text = JSON.stringify(res);
			assert.equal(text.includes('"sessionTarget":"isolated"'), true);
		} finally {
			fx.cleanup();
		}
	});
});
