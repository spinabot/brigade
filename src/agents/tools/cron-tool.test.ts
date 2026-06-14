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
import { describeFireTime, makeCronTool } from "./cron-tool.js";

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

// Pi's tool-result shape has no `isError` field. The cron tool's gate
// refusals each carry a distinctive substring in their `text` content;
// successes never include any of these phrases.
const REFUSAL_KEYWORDS =
	/your own chat|workspace-owner privilege|approved channel|agent answering you|not scheduled by this chat|no job with id/i;
const wasRefused = (res: unknown): boolean => REFUSAL_KEYWORDS.test(JSON.stringify(res));

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
			assert.equal(text.includes("needs `job` as an inline OBJECT"), true);
		} finally {
			fx.cleanup();
		}
	});

	it("parses a JSON-STRINGIFIED `job` (OpenRouter double-encoding quirk)", async () => {
		// Regression for the exact production failure (2026-06-11): the model
		// sent a perfectly valid job but as a STRING — '{"name": …}' — and the
		// old required-error misled it into retrying identically 7 times.
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			const res = await callTool(tool, {
				action: "add",
				job: JSON.stringify({
					name: "gym-reminder",
					schedule: { kind: "in", inMinutes: 3 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "Time to hit the gym!" },
				}),
			});
			const text = JSON.stringify(res);
			assert.equal(text.includes("gym-reminder"), true);
			assert.equal(text.includes("inline OBJECT"), false); // no error reply
		} finally {
			fx.cleanup();
		}
	});

	it("an unparseable string job still fails — with the actionable example", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			const res = await callTool(tool, { action: "add", job: "{not valid json" });
			const text = JSON.stringify(res);
			assert.equal(text.includes("needs `job` as an inline OBJECT"), true);
			assert.equal(text.includes("gym-reminder"), true); // the example shape is shown
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

describe("describeFireTime — server-formatted fire time (model quotes this, never computes)", () => {
	it("formats an epoch to a local 12-hour string in the given timezone", () => {
		// 2026-06-03T11:27:00Z == 4:57 PM in Asia/Kolkata (+05:30) — the exact
		// "5 minutes from 4:52 PM" case the model used to mis-announce as 4:43 PM.
		const epoch = Date.UTC(2026, 5, 3, 11, 27, 0);
		const out = describeFireTime(epoch, "Asia/Kolkata");
		assert.ok(out, "returns a string");
		assert.ok(out.includes("4:57"), `expected "4:57" in ${JSON.stringify(out)}`);
		assert.match(out, /PM/);
	});
	it("returns undefined for missing or non-finite input", () => {
		assert.equal(describeFireTime(undefined, "UTC"), undefined);
		assert.equal(describeFireTime(Number.NaN, "UTC"), undefined);
	});
});

describe("cron-tool — senderIsOwner per-call gate", () => {
	// Build a channelContext shape that mirrors what an approved-peer turn
	// would thread through registry.ts (whatsapp DM from a single peer).
	const channelContext = {
		channelId: "whatsapp",
		conversationId: "14057144199@s.whatsapp.net",
	} as unknown as import("../channels/approval-router.js").ChannelApprovalRoute;

	it("non-owner: `add` for own chat is ALLOWED", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool({ senderIsOwner: false, channelContext, agentId: "main" });
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "interview-reminder",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "remind me" },
				},
			});
			assert.equal(wasRefused(res), false, `expected success, got ${JSON.stringify(res)}`);
		} finally {
			fx.cleanup();
		}
	});

	it("non-owner: `add` with delivery pointing at a DIFFERENT channel REFUSES", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool({ senderIsOwner: false, channelContext, agentId: "main" });
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "cross-channel-attempt",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "x" },
					delivery: { channel: "slack", to: "C12345" },
				},
			});
			assert.equal(wasRefused(res), true);
			assert.match(JSON.stringify(res), /your own chat/i);
		} finally {
			fx.cleanup();
		}
	});

	it("non-owner: `add` with delivery to a DIFFERENT conversation REFUSES", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool({ senderIsOwner: false, channelContext, agentId: "main" });
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "cross-conv-attempt",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "x" },
					delivery: { channel: "whatsapp", to: "99999@s.whatsapp.net" },
				},
			});
			assert.equal(wasRefused(res), true);
			assert.match(JSON.stringify(res), /your own chat/i);
		} finally {
			fx.cleanup();
		}
	});

	it("non-owner: `wake` REFUSES (operator's main-session injection has no per-peer target)", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool({ senderIsOwner: false, channelContext, agentId: "main" });
			const res = await callTool(tool, { action: "wake", text: "ping" });
			assert.equal(wasRefused(res), true);
			assert.match(JSON.stringify(res), /workspace-owner privilege/i);
		} finally {
			fx.cleanup();
		}
	});

	it("non-owner: `update`/`remove`/`run`/`runs` on an UNKNOWN job refuses cleanly", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool({ senderIsOwner: false, channelContext, agentId: "main" });
			for (const action of ["update", "remove", "run", "runs"]) {
				const res = await callTool(tool, { action, jobId: "no-such-id" });
				assert.equal(wasRefused(res), true, `${action} should refuse`);
				// "no job with id …" matches; not the privilege text.
				assert.match(
					JSON.stringify(res),
					/no job with id/i,
					`${action} should explain the missing job`,
				);
			}
		} finally {
			fx.cleanup();
		}
	});

	it("non-owner: read actions (`status` / `list`) are ALLOWED", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool({ senderIsOwner: false, channelContext, agentId: "main" });
			for (const action of ["status", "list"]) {
				const res = await callTool(tool, { action });
				assert.equal(wasRefused(res), false, `${action} should not refuse`);
			}
		} finally {
			fx.cleanup();
		}
	});

	it("non-owner without channelContext REFUSES every action (defensive)", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool({ senderIsOwner: false });
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "no-ctx",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "x" },
				},
			});
			assert.equal(wasRefused(res), true);
			assert.match(JSON.stringify(res), /approved channel/i);
		} finally {
			fx.cleanup();
		}
	});

	it("non-owner: cross-agent `add` (different job.agentId) REFUSES", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool({ senderIsOwner: false, channelContext, agentId: "main" });
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "cross-agent",
					agentId: "another-agent",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "x" },
				},
			});
			assert.equal(wasRefused(res), true);
			assert.match(JSON.stringify(res), /agent answering you/i);
		} finally {
			fx.cleanup();
		}
	});

	it("owner (default): full access — no gate applied", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool({ /* no senderIsOwner = defaults to owner */ });
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "owner-job",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "x" },
				},
			});
			assert.equal(wasRefused(res), false);
		} finally {
			fx.cleanup();
		}
	});
});

describe("cron-tool — createdBy ownership tracking", () => {
	const peerA = {
		channelId: "whatsapp",
		conversationId: "14057144199@s.whatsapp.net",
	} as unknown as import("../channels/approval-router.js").ChannelApprovalRoute;
	const peerB = {
		channelId: "whatsapp",
		conversationId: "918888888888@s.whatsapp.net",
	} as unknown as import("../channels/approval-router.js").ChannelApprovalRoute;

	// Add a job as peerA, return the persisted job's id.
	async function addAsPeerA(): Promise<{ tool: ReturnType<typeof makeCronTool>; jobId: string }> {
		const tool = makeCronTool({ senderIsOwner: false, channelContext: peerA, agentId: "main" });
		const res = await callTool(tool, {
			action: "add",
			job: {
				name: "peer-a-reminder",
				schedule: { kind: "every", everyMs: 60_000 },
				sessionTarget: "isolated",
				payload: { kind: "agentTurn", message: "ping peer A" },
			},
		});
		const m = JSON.stringify(res).match(/"id":"([^"]+)"/);
		assert.ok(m, "expected jobId in add result");
		return { tool, jobId: m![1]! };
	}

	it("peerA: `add` stamps createdBy with their channel + conversation", async () => {
		const fx = setupCronService();
		try {
			const { jobId } = await addAsPeerA();
			const persisted = fx.state.store.jobs.find((j) => j.id === jobId);
			assert.ok(persisted);
			assert.deepEqual(persisted!.createdBy, {
				kind: "channel",
				channelId: peerA.channelId,
				conversationId: peerA.conversationId,
			});
		} finally {
			fx.cleanup();
		}
	});

	it("peerA: can `update` their OWN job (ALLOWED)", async () => {
		const fx = setupCronService();
		try {
			const { tool, jobId } = await addAsPeerA();
			const res = await callTool(tool, {
				action: "update",
				jobId,
				patch: { enabled: false },
			});
			assert.equal(wasRefused(res), false, `expected allow, got ${JSON.stringify(res)}`);
		} finally {
			fx.cleanup();
		}
	});

	it("peerA: can `remove` their OWN job (ALLOWED)", async () => {
		const fx = setupCronService();
		try {
			const { tool, jobId } = await addAsPeerA();
			const res = await callTool(tool, { action: "remove", jobId });
			assert.equal(wasRefused(res), false, `expected allow, got ${JSON.stringify(res)}`);
		} finally {
			fx.cleanup();
		}
	});

	it("peerA: can read `runs` for their OWN job (ALLOWED)", async () => {
		const fx = setupCronService();
		try {
			const { tool, jobId } = await addAsPeerA();
			const res = await callTool(tool, { action: "runs", jobId });
			assert.equal(wasRefused(res), false, `expected allow, got ${JSON.stringify(res)}`);
		} finally {
			fx.cleanup();
		}
	});

	it("peerB: `update`/`remove`/`run` peerA's job REFUSES", async () => {
		const fx = setupCronService();
		try {
			const { jobId } = await addAsPeerA();
			const toolB = makeCronTool({
				senderIsOwner: false,
				channelContext: peerB,
				agentId: "main",
			});
			for (const action of ["update", "remove", "run", "runs"]) {
				const res = await callTool(toolB, {
					action,
					jobId,
					...(action === "update" ? { patch: { enabled: false } } : {}),
				});
				assert.equal(wasRefused(res), true, `${action} should refuse peerB on peerA's job`);
				assert.match(JSON.stringify(res), /not scheduled by this chat/i);
			}
		} finally {
			fx.cleanup();
		}
	});

	it("peerB: `list` does NOT see peerA's jobs (per-chat filtered)", async () => {
		const fx = setupCronService();
		try {
			await addAsPeerA();
			const toolB = makeCronTool({
				senderIsOwner: false,
				channelContext: peerB,
				agentId: "main",
			});
			const res = await callTool(toolB, { action: "list" });
			const text = JSON.stringify(res);
			assert.equal(
				text.includes("peer-a-reminder"),
				false,
				"peerB must not see peerA's job in list",
			);
			// Result still well-formed (empty jobs, total=0).
			assert.match(text, /"jobs":\[\]/);
			assert.match(text, /"total":0/);
		} finally {
			fx.cleanup();
		}
	});

	it("peerA: `list` sees only their OWN job (not the operator's)", async () => {
		const fx = setupCronService();
		try {
			// Operator schedules a job first.
			const ownerTool = makeCronTool();
			await callTool(ownerTool, {
				action: "add",
				job: {
					name: "operator-job",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "operator's task" },
				},
			});
			// Then peerA schedules their own.
			const { tool } = await addAsPeerA();
			const res = await callTool(tool, { action: "list" });
			const text = JSON.stringify(res);
			assert.equal(text.includes("peer-a-reminder"), true);
			assert.equal(
				text.includes("operator-job"),
				false,
				"peerA must not see the operator's job",
			);
		} finally {
			fx.cleanup();
		}
	});

	it("owner: `list` sees ALL jobs (peer's + their own)", async () => {
		const fx = setupCronService();
		try {
			await addAsPeerA();
			const ownerTool = makeCronTool();
			await callTool(ownerTool, {
				action: "add",
				job: {
					name: "operator-job",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "x" },
				},
			});
			const res = await callTool(ownerTool, { action: "list" });
			const text = JSON.stringify(res);
			assert.equal(text.includes("peer-a-reminder"), true);
			assert.equal(text.includes("operator-job"), true);
		} finally {
			fx.cleanup();
		}
	});

	it("legacy: a job without createdBy (pre-tracking) is treated as owner-only", async () => {
		const fx = setupCronService();
		try {
			// Inject a job directly into the store with no `createdBy` —
			// simulates a job persisted before ownership tracking shipped.
			const legacyId = "legacy-no-createdBy";
			fx.state.store.jobs.push({
				id: legacyId,
				name: "legacy-job",
				enabled: true,
				schedule: { kind: "every", everyMs: 60_000 },
				sessionTarget: "isolated",
				payload: { kind: "agentTurn", message: "legacy" },
				createdAtMs: Date.now() - 1_000_000,
				updatedAtMs: Date.now() - 1_000_000,
				state: {},
			});
			const tool = makeCronTool({ senderIsOwner: false, channelContext: peerA, agentId: "main" });
			const res = await callTool(tool, { action: "remove", jobId: legacyId });
			assert.equal(wasRefused(res), true);
			assert.match(JSON.stringify(res), /not scheduled by this chat/i);
		} finally {
			fx.cleanup();
		}
	});
});

describe("cron-tool — stagger surfacing in add/update results", () => {
	// Production failure (2026-06-11): a "7 PM daily" job silently fired at
	// 7:04 (top-of-hour default staggerMs: 300000) and, asked why, the model
	// improvised from the raw job JSON — "random" (it's deterministic) and
	// "can't be disabled" (it can). The result now carries a ready-to-say
	// `staggerNote` grounding the WHY + the staggerMs: 0 opt-out.
	it("top-of-hour cron add → result carries a plain-language staggerNote", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "gym-7pm",
					schedule: { kind: "cron", expr: "0 19 * * *", tz: "Asia/Kolkata" },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "gym time" },
				},
			});
			const details = (res as { details?: { staggerNote?: string } }).details;
			assert.ok(details?.staggerNote, "expected staggerNote on a staggered job");
			assert.match(details.staggerNote, /staggerMs: 0/);
			assert.match(details.staggerNote, /PLAIN LANGUAGE/i);
			assert.match(details.staggerNote, /not\s+random/i);
		} finally {
			fx.cleanup();
		}
	});

	it("explicit staggerMs: 0 → fires exact, NO staggerNote", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "gym-7pm-exact",
					schedule: { kind: "cron", expr: "0 19 * * *", tz: "Asia/Kolkata", staggerMs: 0 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "gym time" },
				},
			});
			const details = (res as { details?: { staggerNote?: string } }).details;
			assert.equal(details?.staggerNote, undefined);
		} finally {
			fx.cleanup();
		}
	});

	it("non-top-of-hour expressions get no default stagger and no note", async () => {
		const fx = setupCronService();
		try {
			const tool = makeCronTool();
			const res = await callTool(tool, {
				action: "add",
				job: {
					name: "gym-730pm",
					schedule: { kind: "cron", expr: "30 19 * * *", tz: "Asia/Kolkata" },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "gym time" },
				},
			});
			const details = (res as { details?: { staggerNote?: string } }).details;
			assert.equal(details?.staggerNote, undefined);
		} finally {
			fx.cleanup();
		}
	});
});
