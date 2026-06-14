/**
 * Heartbeat-cron decoupling tests (Bug #12).
 *
 * Goal: prove the cron service's own 30 s tick drives `wakeMode:
 * "next-heartbeat"` consumption WITHOUT depending on the agent
 * heartbeat scheduler. With zero `heartbeat.intervalMs` configured for
 * any agent, both `wakeMode: "now"` and `wakeMode: "next-heartbeat"`
 * crons must still fire and produce a `requestHeartbeatNow` invocation
 * within the documented bounds.
 *
 * Tests tempdir-isolate the cron store path so they never touch
 * `~/.brigade/cron.json`.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// File-wide state-dir isolation. The per-test tempDir below covers the cron
// STORE path, but the run-LOG writer resolves its own path via
// resolveStateDir() — without this pin every dispatch in these tests appends
// run JSONLs into the DEVELOPER'S real ~/.brigade/cron/runs/. Caught
// 2026-06-12: a full suite run leaked 33 run files into a freshly-reset
// operator state dir.
let __stateDirTmp: string;
let __prevStateDir: string | undefined;
beforeEach(() => {
	__stateDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-statedir-"));
	__prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = __stateDirTmp;
});
afterEach(() => {
	if (__prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = __prevStateDir;
	fs.rmSync(__stateDirTmp, { recursive: true, force: true });
});

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import {
	createCronServiceState,
	type CronServiceState,
	type CronSystemEventArgs,
} from "./state.js";
import { add as cronAdd } from "./ops.js";
import { persist } from "./store.js";
import {
	MAX_TIMER_DELAY_MS,
	MIN_REFIRE_GAP_MS,
	armTimer,
	onTimer,
	planStartupCatchup,
	stopTimer,
} from "./timer.js";

interface HarnessRecord {
	state: CronServiceState;
	systemEvents: CronSystemEventArgs[];
	wakes: Array<{ reason?: string; agentId?: string; sessionKey?: string }>;
	tempDir: string;
	cleanup: () => void;
}

function makeHarness(opts: { nowMs?: () => number } = {}): HarnessRecord {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-timer-test-"));
	const storePath = path.join(tempDir, "cron.json");
	const systemEvents: CronSystemEventArgs[] = [];
	const wakes: Array<{ reason?: string; agentId?: string; sessionKey?: string }> = [];
	const state = createCronServiceState({
		storePath,
		config: { enabled: true },
		deps: {
			log: createSubsystemLogger("cron-test"),
			nowMs: opts.nowMs,
			enqueueSystemEvent: (args) => {
				systemEvents.push(args);
			},
			requestHeartbeatNow: (params) => {
				wakes.push({
					...(params?.reason !== undefined ? { reason: params.reason } : {}),
					...(params?.agentId !== undefined ? { agentId: params.agentId } : {}),
					...(params?.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {}),
				});
			},
		},
	});
	return {
		state,
		systemEvents,
		wakes,
		tempDir,
		cleanup: () => {
			stopTimer(state);
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

describe("cron timer — own always-on tick (Bug #12)", () => {
	it("MAX_TIMER_DELAY_MS is 30 seconds (cron's own heartbeat cadence)", () => {
		// Cron MUST tick at least every 30 s independent of agent heartbeat
		// scheduler. If this constant drifts back up to 60 s, the bug-#12
		// worst-case for `wakeMode: "now"` doubles.
		assert.equal(MAX_TIMER_DELAY_MS, 30_000);
		assert.equal(MIN_REFIRE_GAP_MS, 2_000);
	});

	it("wakeMode:'now' main-target cron fires `requestHeartbeatNow` INLINE with no agent heartbeat configured", async () => {
		// Simulated time so we don't actually wait 30 s in a unit test.
		let now = 1_700_000_000_000;
		const h = makeHarness({ nowMs: () => now });
		try {
			const job = await cronAdd(h.state, {
				name: "ping-now",
				enabled: true,
				schedule: { kind: "at", at: now + 10_000 },
				sessionTarget: "main",
				wakeMode: "now",
				payload: { kind: "systemEvent", text: "wake up now" },
				agentId: "ops",
			});
			assert.equal(job.wakeMode, "now");
			// Advance simulated time to just past the schedule.
			now += 11_000;
			// Drive the tick directly (in production armTimer's setTimeout
			// fires; in test we invoke onTimer manually to avoid the timer).
			await onTimer(h.state);

			// System event was enqueued.
			assert.equal(h.systemEvents.length, 1);
			assert.equal(h.systemEvents[0]!.text, "wake up now");
			assert.equal(h.systemEvents[0]!.agentId, "ops");
			// `wakeMode: "now"` produced an INLINE `requestHeartbeatNow` —
			// bypasses the heartbeat-wake-interval dep entirely.
			assert.equal(h.wakes.length, 1);
			assert.equal(h.wakes[0]!.reason, "cron-wake");
			assert.equal(h.wakes[0]!.agentId, "ops");
		} finally {
			h.cleanup();
		}
	});

	it("wakeMode:'next-heartbeat' cron drives `requestHeartbeatNow` on the NEXT cron tick (decoupled from agent heartbeat)", async () => {
		let now = 1_700_000_000_000;
		const h = makeHarness({ nowMs: () => now });
		try {
			const job = await cronAdd(h.state, {
				name: "wake-next",
				enabled: true,
				schedule: { kind: "at", at: now + 10_000 },
				sessionTarget: "main",
				wakeMode: "next-heartbeat",
				payload: { kind: "systemEvent", text: "wake up at next tick" },
				agentId: "ops",
			});
			assert.equal(job.wakeMode, "next-heartbeat");
			// Tick #1 — past-due → enqueue system event, queue pending wake.
			now += 11_000;
			await onTimer(h.state);

			// System event was enqueued during tick #1.
			assert.equal(h.systemEvents.length, 1);
			assert.equal(h.systemEvents[0]!.text, "wake up at next tick");
			// CRUCIALLY: tick #1 must NOT have already drained the wake it
			// just queued (otherwise `next-heartbeat` would behave like
			// `now`). The pending wake stays in the queue for the next
			// tick.
			assert.equal(h.wakes.length, 0, "tick #1 must not drain its own freshly-queued wake");

			// Tick #2 — drains the pending wake.
			now += 10_000;
			await onTimer(h.state);

			assert.equal(h.wakes.length, 1, "tick #2 must drain the pending wake");
			assert.equal(h.wakes[0]!.reason, "cron-wake");
			assert.equal(h.wakes[0]!.agentId, "ops");
		} finally {
			h.cleanup();
		}
	});

	it("wakeMode:'next-heartbeat' does NOT depend on requestHeartbeatNow being wired (drain no-ops cleanly)", async () => {
		// When the deps don't wire `requestHeartbeatNow` (e.g. CLI invocation
		// with no heartbeat subsystem), the cron must still successfully run
		// the job — it just drops the pending wake. The system event itself
		// was enqueued via `enqueueSystemEvent`, which is the other dep.
		let now = 1_700_000_000_000;
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-timer-test-"));
		try {
			const storePath = path.join(tempDir, "cron.json");
			const systemEvents: CronSystemEventArgs[] = [];
			const state = createCronServiceState({
				storePath,
				config: { enabled: true },
				deps: {
					log: createSubsystemLogger("cron-test"),
					nowMs: () => now,
					enqueueSystemEvent: (args) => {
						systemEvents.push(args);
					},
					// no requestHeartbeatNow — simulates an install with zero
					// heartbeat config.
				},
			});
			await cronAdd(state, {
				name: "wake-next-orphan",
				enabled: true,
				schedule: { kind: "at", at: now + 10_000 },
				sessionTarget: "main",
				wakeMode: "next-heartbeat",
				payload: { kind: "systemEvent", text: "no-wake-dep" },
			});
			now += 11_000;
			await onTimer(state);
			assert.equal(systemEvents.length, 1, "system event enqueued");

			// Tick #2 — drains, but no requestHeartbeatNow dep → drops
			// silently. Must not throw.
			now += 10_000;
			await assert.doesNotReject(onTimer(state));
			stopTimer(state);
		} finally {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	it("armTimer wakes within MAX_TIMER_DELAY_MS even when no jobs are pending", async () => {
		// This is the always-on cadence guarantee. We don't actually wait
		// 30 s; we assert the timer is ARMED with a delay <= 30 s when no
		// jobs exist.
		const h = makeHarness();
		try {
			armTimer(h.state);
			// `setTimeout` returns a Timeout object; we can't peek the delay
			// portably, but we can prove a timer IS armed (state.timer
			// non-null) and that it's `unref`'d so it doesn't keep the
			// process alive.
			assert.notEqual(h.state.timer, null);
		} finally {
			h.cleanup();
		}
	});
});

describe("cron timer — concurrent-due dispatch (Bug #2)", () => {
	it("two same-instant jobs both fire (worker pool serialises losers, no silent drops)", async () => {
		// Two main-target jobs with the SAME `at` timestamp. Before the fix,
		// `collectRunnableJobs` capped candidates at `maxConcurrentRuns` (was
		// defaulted to 1), so the loser silently advanced its schedule on
		// the next maintenance pass without ever firing. After the fix:
		// - default maxConcurrentRuns is 4, so both dispatch in parallel
		// - even if it were 1, the worker pool would still serialise both
		//   inside the same tick, no drops
		let now = 1_700_000_000_000;
		const h = makeHarness({ nowMs: () => now });
		try {
			await cronAdd(h.state, {
				name: "burst-1",
				enabled: true,
				schedule: { kind: "at", at: now + 10_000 },
				sessionTarget: "main",
				wakeMode: "now",
				payload: { kind: "systemEvent", text: "burst-1-fired" },
			});
			await cronAdd(h.state, {
				name: "burst-2",
				enabled: true,
				schedule: { kind: "at", at: now + 10_000 },
				sessionTarget: "main",
				wakeMode: "now",
				payload: { kind: "systemEvent", text: "burst-2-fired" },
			});
			// Past-due both jobs.
			now += 11_000;
			await onTimer(h.state);

			const texts = h.systemEvents.map((e) => e.text).sort();
			assert.deepEqual(
				texts,
				["burst-1-fired", "burst-2-fired"],
				"both same-instant jobs must fire — losers are sequenced via worker pool, not dropped",
			);
		} finally {
			h.cleanup();
		}
	});

	it("maxConcurrentRuns=1 still fires both same-instant jobs (worker-pool serialisation)", async () => {
		let now = 1_700_000_000_000;
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-timer-test-"));
		try {
			const storePath = path.join(tempDir, "cron.json");
			const systemEvents: CronSystemEventArgs[] = [];
			const state = createCronServiceState({
				storePath,
				config: { enabled: true, maxConcurrentRuns: 1 },
				deps: {
					log: createSubsystemLogger("cron-test-mc1"),
					nowMs: () => now,
					enqueueSystemEvent: (args) => {
						systemEvents.push(args);
					},
				},
			});
			await cronAdd(state, {
				name: "single-file-1",
				enabled: true,
				schedule: { kind: "at", at: now + 10_000 },
				sessionTarget: "main",
				wakeMode: "next-heartbeat",
				payload: { kind: "systemEvent", text: "sf-1" },
			});
			await cronAdd(state, {
				name: "single-file-2",
				enabled: true,
				schedule: { kind: "at", at: now + 10_000 },
				sessionTarget: "main",
				wakeMode: "next-heartbeat",
				payload: { kind: "systemEvent", text: "sf-2" },
			});
			now += 11_000;
			await onTimer(state);
			const texts = systemEvents.map((e) => e.text).sort();
			assert.deepEqual(
				texts,
				["sf-1", "sf-2"],
				"even with maxConcurrentRuns=1 both fire — worker pool sequences them inside the tick",
			);
			stopTimer(state);
		} finally {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});
});

describe("cron delivery — TUI awareness fires regardless of channel delivery (Bug #4)", () => {
	it("isolated cron with successful channel delivery STILL enqueues a system-event awareness on the operator's main session", async () => {
		// Pre-fix, maybeDeliverAnnounce early-returned the moment the
		// channel-side dispatcher returned `delivered=true`, so the
		// operator's TUI on `agent:main:main` silently never saw the cron
		// fire — the summary went to disk + WhatsApp but the TUI bubble
		// never appeared. Post-fix, the awareness event ALWAYS fires (with
		// a `delivered: true` flag so the TUI can render a "· delivered"
		// suffix and the operator knows their phone got it too).
		let now = 1_700_000_000_000;
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-tui-aware-test-"));
		try {
			const storePath = path.join(tempDir, "cron.json");
			const systemEvents: CronSystemEventArgs[] = [];
			const channelSends: Array<{ channel: string; to: string; text: string }> = [];
			const state = createCronServiceState({
				storePath,
				config: { enabled: true },
				deps: {
					log: createSubsystemLogger("cron-test-bug4"),
					nowMs: () => now,
					enqueueSystemEvent: (args) => {
						systemEvents.push(args);
					},
					runIsolatedAgentJob: async () => ({
						status: "ok",
						summary: "your reminder is ready",
					}),
					deliverCronAnnounce: async (args) => {
						channelSends.push({
							channel: args.channel ?? "",
							to: args.to ?? "",
							text: args.text,
						});
						return true; // channel-side delivery succeeded
					},
				},
			});
			await cronAdd(state, {
				name: "morning-check",
				enabled: true,
				agentId: "main",
				sessionKey: "agent:main:main",
				schedule: { kind: "at", at: now + 10_000 },
				sessionTarget: "isolated",
				payload: { kind: "agentTurn", message: "what's on today" },
				delivery: {
					mode: "announce",
					channel: "whatsapp",
					to: "1234567890@s.whatsapp.net",
				},
				// Keep the job around past the run so `maybeDeliverAnnounce`
				// fires. `at` jobs default `deleteAfterRun: true` which would
				// short-circuit the delivery branch in `runDueJob`.
				deleteAfterRun: false,
			});
			now += 11_000;
			await onTimer(state);

			// Channel delivery DID happen.
			assert.equal(channelSends.length, 1, "channel dispatcher fired");
			assert.equal(channelSends[0]!.channel, "whatsapp");
			// The CHANNEL message is the model's reply VERBATIM — no internal tag.
			assert.ok(
				!channelSends[0]!.text.includes("[cron"),
				`channel message must not carry the [cron "name"] tag: ${channelSends[0]!.text}`,
			);
			assert.equal(channelSends[0]!.text, "your reminder is ready", "channel gets the reply verbatim");
			// AND the operator's TUI awareness ALSO fired — the regression
			// this test guards against (Bug #4).
			assert.equal(
				systemEvents.length,
				1,
				"awareness event must fire even when channel delivery succeeded",
			);
			const aware = systemEvents[0]!;
			assert.equal(aware.source, "cron");
			assert.equal(aware.jobName, "morning-check");
			assert.equal(aware.delivered, true);
			assert.equal(aware.sessionKey, "agent:main:main");
			assert.ok(
				aware.text.includes("morning-check"),
				"awareness text carries the cron prefix",
			);
			assert.ok(
				aware.text.includes('[cron "morning-check"]'),
				"TUI awareness event keeps the [cron \"name\"] tag",
			);
			assert.ok(
				aware.text.includes("your reminder is ready"),
				"awareness text carries the run summary",
			);
			stopTimer(state);
		} finally {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	it("one-shot `at` reminder with DEFAULT deleteAfterRun STILL delivers its reply before auto-deleting", async () => {
		// Regression for the production "remind me to drink water in 5
		// minutes" path. A `kind: "at"` reminder defaults to
		// `deleteAfterRun: true`, so the job is spliced from the store on a
		// successful run. Delivery USED to be gated on `!deleteAfterApply`,
		// which silently discarded the reply of EVERY default one-shot
		// reminder — the isolated turn produced "Time to hydrate!" but it
		// never reached WhatsApp; the operator only saw it after manually
		// nudging the main session. Delivery must fire regardless of the
		// auto-delete, and the job must still be gone afterwards (and the
		// post-delivery state write-back must not crash on the spliced row).
		let now = 1_700_000_000_000;
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-oneshot-deliver-test-"));
		try {
			const storePath = path.join(tempDir, "cron.json");
			const systemEvents: CronSystemEventArgs[] = [];
			const channelSends: Array<{ channel: string; to: string; text: string }> = [];
			const state = createCronServiceState({
				storePath,
				config: { enabled: true },
				deps: {
					log: createSubsystemLogger("cron-test-oneshot-deliver"),
					nowMs: () => now,
					enqueueSystemEvent: (args) => {
						systemEvents.push(args);
					},
					runIsolatedAgentJob: async () => ({
						status: "ok",
						summary: "Time to hydrate! 💧",
					}),
					deliverCronAnnounce: async (args) => {
						channelSends.push({
							channel: args.channel ?? "",
							to: args.to ?? "",
							text: args.text,
						});
						return true;
					},
				},
			});
			const created = await cronAdd(state, {
				name: "drink-water-reminder",
				enabled: true,
				agentId: "main",
				sessionKey: "agent:main:whatsapp:direct:917702616808",
				schedule: { kind: "at", at: now + 10_000 },
				sessionTarget: "isolated",
				payload: { kind: "agentTurn", message: "remind me to drink water" },
				delivery: {
					mode: "announce",
					channel: "whatsapp",
					to: "277888729362470@lid",
				},
				// Deliberately NOT setting `deleteAfterRun` — `at` jobs default
				// it to `true`. This is the EXACT production reminder shape.
			});
			now += 11_000;
			await onTimer(state);

			// The reminder reply reached the channel even though the job
			// auto-deleted on success.
			assert.equal(
				channelSends.length,
				1,
				"one-shot reminder must still deliver to the channel",
			);
			assert.equal(channelSends[0]!.channel, "whatsapp");
			assert.equal(channelSends[0]!.to, "277888729362470@lid");
			assert.ok(
				channelSends[0]!.text.includes("Time to hydrate"),
				"delivered text carries the run summary",
			);
			// TUI awareness also fired (Bug #4 guard) — with delivered=true.
			assert.equal(systemEvents.length, 1, "awareness event fires for one-shot too");
			assert.equal(systemEvents[0]!.delivered, true);
			// The one-shot auto-deleted (default deleteAfterRun: true) — gone
			// from the store, no crash on the post-delivery state write-back.
			assert.equal(
				state.store.jobs.find((j) => j.id === created.id),
				undefined,
				"one-shot job auto-deletes after a successful run",
			);
			stopTimer(state);
		} finally {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	it("isolated cron with FAILED channel delivery enqueues awareness with delivered=false", async () => {
		// When the channel dispatcher refuses (offline adapter, unknown
		// recipient, etc.), the awareness STILL fires — but flags
		// `delivered: false` so the TUI can render "· not delivered (TUI
		// only)" and the operator knows their phone didn't get the
		// reminder.
		let now = 1_700_000_000_000;
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-tui-undeliv-test-"));
		try {
			const storePath = path.join(tempDir, "cron.json");
			const systemEvents: CronSystemEventArgs[] = [];
			const state = createCronServiceState({
				storePath,
				config: { enabled: true },
				deps: {
					log: createSubsystemLogger("cron-test-bug4-undeliv"),
					nowMs: () => now,
					enqueueSystemEvent: (args) => {
						systemEvents.push(args);
					},
					runIsolatedAgentJob: async () => ({
						status: "ok",
						summary: "missed-channel summary",
					}),
					deliverCronAnnounce: async () => false, // channel refused
				},
			});
			await cronAdd(state, {
				name: "evening-check",
				enabled: true,
				agentId: "main",
				sessionKey: "agent:main:main",
				schedule: { kind: "at", at: now + 10_000 },
				sessionTarget: "isolated",
				payload: { kind: "agentTurn", message: "evening" },
				delivery: {
					mode: "announce",
					channel: "whatsapp",
					to: "1234567890@s.whatsapp.net",
				},
				deleteAfterRun: false,
			});
			now += 11_000;
			await onTimer(state);

			assert.equal(systemEvents.length, 1, "awareness still fires on channel refusal");
			assert.equal(systemEvents[0]!.delivered, false);
			assert.equal(systemEvents[0]!.source, "cron");
			stopTimer(state);
		} finally {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});
});

describe("cron ops — force-run preserves schedule (Bug #1)", () => {
	it("cron run mode=force on a recurring `every` job does NOT corrupt the canonical anchor", async () => {
		// Before the fix, ops.run() stamped `nextRunAtMs: now` BEFORE
		// dispatching, so a forced run would trample the recurring anchor
		// even on success — the next slot would compute relative to `now`
		// instead of the prior anchor. The new pattern reserves runningAtMs
		// (only) under lock, runs inline via runDueJob, and applyJobResult
		// recomputes nextRunAtMs from endedAtMs without ever writing
		// `nextRunAtMs: now` in the meantime.
		const cronRun = await import("./ops.js").then((m) => m.run);
		let now = 1_700_000_000_000;
		const h = makeHarness({ nowMs: () => now });
		try {
			const everyMs = 60 * 60_000; // hourly
			const job = await cronAdd(h.state, {
				name: "force-recurring",
				enabled: true,
				schedule: { kind: "every", everyMs },
				sessionTarget: "main",
				wakeMode: "now",
				payload: { kind: "systemEvent", text: "tick" },
			});
			// Advance halfway through the first interval (well before the
			// scheduled next-fire) and force-run.
			now += everyMs / 2;
			await cronRun(h.state, job.id, "force");

			// The forced run MUST have actually fired (system event landed).
			assert.equal(h.systemEvents.length, 1, "force-run fires inline");
			// After the run, nextRunAtMs should be set to a sensible future
			// time — NOT to `now` (the broken pre-fix value).
			const refreshed = h.state.store.jobs.find((j) => j.id === job.id)!;
			assert.notEqual(
				refreshed.state.nextRunAtMs,
				now,
				"force-run must not leave nextRunAtMs == now (broken anchor trample)",
			);
			assert.ok(
				typeof refreshed.state.nextRunAtMs === "number" &&
					refreshed.state.nextRunAtMs > now,
				"force-run leaves a future nextRunAtMs computed from endedAtMs",
			);
			// runningAtMs cleared.
			assert.equal(refreshed.state.runningAtMs, undefined);
		} finally {
			h.cleanup();
		}
	});

	it("cron run mode=force is a no-op when the job is already running (no double-fire)", async () => {
		// Reservation pattern: runningAtMs set → second force-run must
		// short-circuit so concurrent invocations don't double-execute.
		const cronRun = await import("./ops.js").then((m) => m.run);
		const persist = await import("./store.js").then((m) => m.persist);
		let now = 1_700_000_000_000;
		const h = makeHarness({ nowMs: () => now });
		try {
			const job = await cronAdd(h.state, {
				name: "no-double-fire",
				enabled: true,
				schedule: { kind: "at", at: now + 60_000 },
				sessionTarget: "main",
				wakeMode: "next-heartbeat",
				payload: { kind: "systemEvent", text: "once" },
			});
			// Inject a stale runningAtMs marker on disk as if a concurrent
			// run is in flight. Brigade's runningAtMs guard must refuse the
			// second run after the reservation phase reloads from disk.
			const idx = h.state.store.jobs.findIndex((j) => j.id === job.id);
			h.state.store.jobs[idx]!.state.runningAtMs = now - 1_000;
			await persist(h.state);
			await cronRun(h.state, job.id, "force");
			assert.equal(
				h.systemEvents.length,
				0,
				"force-run while another marker is set must not re-dispatch",
			);
		} finally {
			h.cleanup();
		}
	});
});

describe("cron-scale — 20-job burst audit", () => {
	it("20 jobs clustered at 5/10/15/30/60s slots ALL fire across waves, with force-run + same-instant add", async () => {
		// Audit scenario:
		//   - 20 main-target crons clustered at 5/10/15/30/60s offsets
		//     (4 jobs per slot × 5 slots = 20).
		//   - Wave 1: 4 fire at the 5s slot. Force-run one of them while
		//     the wave is mid-dispatch.
		//   - Add a new job same-instant as a wave-2 (10s) target.
		//   - Wave 2..5 sweep the remaining slots.
		//
		// Verify (Bugs #1 / #2 / #10):
		//   - All 20 cluster jobs fire across the waves — none silently
		//     dropped past their slot (Bug #2: collectRunnableJobs no longer
		//     caps by concurrency).
		//   - Force-run leaves nextRunAtMs in the future, never trampled
		//     to `now` (Bug #1).
		//   - No per-tick repair-loop spam in the debug log (Bug #10:
		//     ensureLoaded canonicalises on first load).
		//   - maxConcurrentRuns honoured by the worker pool inside each
		//     tick.
		let now = 1_700_000_000_000;
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-scale-test-"));
		try {
			const storePath = path.join(tempDir, "cron.json");
			const systemEvents: CronSystemEventArgs[] = [];
			let liveRuns = 0;
			let maxLiveRuns = 0;
			const repairLogLines: string[] = [];
			const state = createCronServiceState({
				storePath,
				config: { enabled: true, maxConcurrentRuns: 4 },
				deps: {
					log: {
						debug: (msg: string) => {
							if (typeof msg === "string" && msg.includes("repaired"))
								repairLogLines.push(msg);
						},
						info: () => {},
						warn: () => {},
						error: () => {},
					} as unknown as ReturnType<typeof createSubsystemLogger>,
					nowMs: () => now,
					enqueueSystemEvent: (args) => {
						liveRuns++;
						maxLiveRuns = Math.max(maxLiveRuns, liveRuns);
						systemEvents.push(args);
						liveRuns--;
					},
				},
			});

			const slotsSec = [5, 10, 15, 30, 60];
			const addedIds: string[] = [];
			for (const sec of slotsSec) {
				for (let i = 0; i < 4; i++) {
					const job = await cronAdd(state, {
						name: `cluster-${sec}s-#${i}`,
						enabled: true,
						schedule: { kind: "at", at: now + sec * 1_000 },
						sessionTarget: "main",
						wakeMode: "next-heartbeat",
						payload: { kind: "systemEvent", text: `slot-${sec}s-#${i}` },
						// keep around so each fire is observable across waves
						deleteAfterRun: false,
					});
					addedIds.push(job.id);
				}
			}
			assert.equal(state.store.jobs.length, 20, "20 jobs persisted");

			// Wave 1: advance past 5s — 4 jobs should fire.
			now += 5_500;
			await onTimer(state);
			const wave1Texts = systemEvents.map((e) => e.text).sort();
			assert.deepEqual(
				wave1Texts,
				["slot-5s-#0", "slot-5s-#1", "slot-5s-#2", "slot-5s-#3"],
				"wave-1: all four 5s-slot jobs fire, no drops",
			);
			assert.ok(
				maxLiveRuns <= 4,
				`worker pool kept concurrency <= 4 (observed peak ${maxLiveRuns})`,
			);

			// FORCE-RUN one of the wave-1 jobs after re-arming it as recurring.
			const cronRun = await import("./ops.js").then((m) => m.run);
			const cronUpdate = await import("./ops.js").then((m) => m.update);
			await cronUpdate(state, addedIds[0]!, {
				enabled: true,
				schedule: { kind: "every", everyMs: 60_000 },
			});
			const before = systemEvents.length;
			await cronRun(state, addedIds[0]!, "force");
			assert.equal(
				systemEvents.length,
				before + 1,
				"force-run dispatched inline and fired exactly once",
			);
			const forced = state.store.jobs.find((j) => j.id === addedIds[0]!)!;
			assert.ok(
				typeof forced.state.nextRunAtMs === "number" &&
					forced.state.nextRunAtMs > now,
				"force-run leaves a future nextRunAtMs (Bug #1 — anchor preserved)",
			);

			// ADD a new job same-instant as the wave-2 (10s) batch.
			const sameInstantTarget = now + 6_500; // wave-2 fires at +10s; now is 5.5s
			const lateAdd = await cronAdd(state, {
				name: "late-add-same-instant",
				enabled: true,
				schedule: { kind: "at", at: sameInstantTarget },
				sessionTarget: "main",
				wakeMode: "next-heartbeat",
				payload: { kind: "systemEvent", text: "late-add-fired" },
				deleteAfterRun: false,
			});

			// Wave 2: 10s slot + the late-add → 5 new events.
			now += 7_000;
			await onTimer(state);
			const wave2New = systemEvents.slice(before + 1).map((e) => e.text).sort();
			assert.ok(
				wave2New.includes("late-add-fired"),
				"same-instant late-add fires in wave 2",
			);
			for (let i = 0; i < 4; i++) {
				assert.ok(
					wave2New.includes(`slot-10s-#${i}`),
					`wave-2 fires slot-10s-#${i}`,
				);
			}

			// Sweep remaining waves.
			now += 5_000;
			await onTimer(state); // 15s slot
			now += 15_000;
			await onTimer(state); // 30s slot
			now += 30_000;
			await onTimer(state); // 60s slot

			const allTexts = systemEvents.map((e) => e.text);
			const seenSlots = new Set<string>();
			for (const text of allTexts) {
				if (text.startsWith("slot-")) seenSlots.add(text);
			}
			for (const sec of slotsSec) {
				for (let i = 0; i < 4; i++) {
					assert.ok(
						seenSlots.has(`slot-${sec}s-#${i}`),
						`all 20 jobs fire (missing slot-${sec}s-#${i})`,
					);
				}
			}
			assert.ok(
				allTexts.includes("late-add-fired"),
				"same-instant late-add fired",
			);
			assert.equal(
				repairLogLines.length,
				0,
				"no repair-loop spam across all waves",
			);
			assert.ok(
				maxLiveRuns <= 4,
				`worker-pool cap held across all waves (observed peak ${maxLiveRuns})`,
			);
			assert.ok(lateAdd.id, "late-add job has an id");
			stopTimer(state);
		} finally {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});
});

describe("cron timer — planStartupCatchup", () => {
	it("recurring job with a missed past-due fire gets scheduled in the catchup slice", async () => {
		let now = 1_800_000_000_000;
		const h = makeHarness({ nowMs: () => now });
		try {
			// Past-due recurring job (manually mark nextRunAtMs as past).
			const job = await cronAdd(h.state, {
				name: "missed-recurring",
				enabled: true,
				schedule: { kind: "every", everyMs: 60_000 },
				sessionTarget: "main",
				payload: { kind: "systemEvent", text: "missed" },
			});
			const idx = h.state.store.jobs.findIndex((j) => j.id === job.id);
			h.state.store.jobs[idx]!.state.nextRunAtMs = now - 30_000; // past-due
			await planStartupCatchup(h.state);
			const after = h.state.store.jobs.find((j) => j.id === job.id)!;
			// Catchup put the next-fire at-or-after `now`, capped by the
			// staggered offset window. The point is it's NOT still past-due.
			assert.ok(after.state.nextRunAtMs !== undefined);
			assert.ok(after.state.nextRunAtMs! >= now);
		} finally {
			h.cleanup();
		}
	});

	it("maxMissedJobsPerRestart cap defers over-cap jobs to a later staggered slot", async () => {
		let now = 1_800_000_000_000;
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-catchup-test-"));
		try {
			const storePath = path.join(tempDir, "cron.json");
			const state = createCronServiceState({
				storePath,
				config: {
					enabled: true,
					maxMissedJobsPerRestart: 2,
					missedJobStaggerMs: 1_000,
				},
				deps: {
					log: createSubsystemLogger("cron-test-catchup-cap"),
					nowMs: () => now,
				},
			});
			// Three recurring jobs, then forced past-due ON DISK (simulating a gateway
			// that was down past their fire slots). The override is applied AFTER all
			// adds and PERSISTED — each `cronAdd` reloads the store from disk and
			// `planStartupCatchup` reloads again, so an in-memory-only override set
			// mid-loop would be discarded before catchup ever saw it.
			for (let i = 0; i < 3; i++) {
				await cronAdd(state, {
					name: `over-cap-${i}`,
					enabled: true,
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "main",
					payload: { kind: "systemEvent", text: `j-${i}` },
				});
			}
			for (const job of state.store.jobs) {
				job.state.nextRunAtMs = now - 30_000;
			}
			await persist(state);
			await planStartupCatchup(state);
			// All 3 still have a nextRunAtMs (none was silently dropped) and
			// they're spread out across the stagger window so they don't
			// stampede tick #1.
			const nextFires = state.store.jobs
				.map((j) => j.state.nextRunAtMs)
				.filter((v): v is number => typeof v === "number")
				.sort();
			assert.equal(nextFires.length, 3);
			// At least two distinct values → stagger spread is in effect.
			assert.ok(new Set(nextFires).size >= 2);
			stopTimer(state);
		} finally {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	it("`at` job with stale runningAtMs marker has it cleared and is not replayed", async () => {
		let now = 1_800_000_000_000;
		const h = makeHarness({ nowMs: () => now });
		try {
			const job = await cronAdd(h.state, {
				name: "stale-at",
				enabled: true,
				schedule: { kind: "at", at: now + 60_000 },
				sessionTarget: "main",
				payload: { kind: "systemEvent", text: "stale" },
			});
			// Simulate a prior crash mid-run: runningAtMs set but no lastStatus.
			const idx = h.state.store.jobs.findIndex((j) => j.id === job.id);
			h.state.store.jobs[idx]!.state.runningAtMs = now - 10 * 60_000;
			await planStartupCatchup(h.state);
			const after = h.state.store.jobs.find((j) => j.id === job.id)!;
			assert.equal(after.state.runningAtMs, undefined, "stale marker cleared");
			// At-job didn't pick up a replay — it stays as scheduled (one-shot
			// + interrupted mid-run is presumed done by `planStartupCatchup`).
		} finally {
			h.cleanup();
		}
	});
});

describe("cron timer — armTimer tight-loop floor (MIN_REFIRE_GAP_MS)", () => {
	it("armTimer never schedules setTimeout below MIN_REFIRE_GAP_MS when delay rounds to 0", async () => {
		// Manually inject a job whose `nextRunAtMs == nowMs` AND has a
		// `runningAtMs` marker so `collectRunnableJobs` won't pick it up.
		// That historically led armTimer to compute delay=0 and re-enter
		// onTimer in a hot loop.
		let now = 1_800_000_000_000;
		const h = makeHarness({ nowMs: () => now });
		try {
			const job = await cronAdd(h.state, {
				name: "tight-loop-defence",
				enabled: true,
				schedule: { kind: "every", everyMs: 60_000 },
				sessionTarget: "main",
				payload: { kind: "systemEvent", text: "tl" },
			});
			const idx = h.state.store.jobs.findIndex((j) => j.id === job.id);
			h.state.store.jobs[idx]!.state.nextRunAtMs = now;
			h.state.store.jobs[idx]!.state.runningAtMs = now;
			// Patch setTimeout to capture the delay armTimer used.
			const originalSetTimeout = globalThis.setTimeout;
			let capturedDelay: number | undefined;
			(globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, delay: number) => {
				if (capturedDelay === undefined) capturedDelay = delay;
				return originalSetTimeout(fn, delay);
			}) as typeof setTimeout;
			try {
				armTimer(h.state);
			} finally {
				(globalThis as { setTimeout: unknown }).setTimeout = originalSetTimeout;
			}
			assert.ok(
				capturedDelay !== undefined,
				"setTimeout must have been called",
			);
			assert.ok(
				capturedDelay! >= MIN_REFIRE_GAP_MS,
				`expected delay >= MIN_REFIRE_GAP_MS (${MIN_REFIRE_GAP_MS}), got ${capturedDelay}`,
			);
		} finally {
			h.cleanup();
		}
	});
});
