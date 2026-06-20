import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { executeCronScriptRun } from "./run-executor.js";
import type { CronJob, CronJobOrigin } from "../types.js";

function scriptJob(args: { command: string; cwd: string; wakeAgent?: boolean; createdBy?: CronJobOrigin }): CronJob {
	return {
		id: "job-1",
		name: "probe",
		enabled: true,
		schedule: { kind: "every", everyMs: 60_000 },
		sessionTarget: "isolated",
		payload: {
			kind: "script",
			command: args.command,
			cwd: args.cwd,
			...(args.wakeAgent !== undefined ? { wakeAgent: args.wakeAgent } : {}),
		},
		...(args.createdBy ? { createdBy: args.createdBy } : {}),
		createdAtMs: 0,
		updatedAtMs: 0,
		state: {},
	};
}

describe("executeCronScriptRun (cron cost-saver)", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cronscript-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("runs a script and delivers stdout with NO model turn (zero tokens)", async () => {
		const out = await executeCronScriptRun({ job: scriptJob({ command: `node -e "console.log('probe-ok')"`, cwd: dir }), runAtMs: 0 });
		assert.equal(out.status, "ok");
		assert.match(out.summary ?? "", /probe-ok/);
	});

	it("reports an error when the script exits non-zero", async () => {
		const out = await executeCronScriptRun({ job: scriptJob({ command: `node -e "process.exit(3)"`, cwd: dir }), runAtMs: 0 });
		assert.equal(out.status, "error");
		assert.match(out.error ?? "", /exited 3/);
	});

	it("REFUSES a channel-origin script job (owner-only — RCE guard)", async () => {
		const out = await executeCronScriptRun({
			job: scriptJob({
				command: `node -e "console.log(1)"`,
				cwd: dir,
				createdBy: { kind: "channel", channelId: "wa", conversationId: "c1" },
			}),
			runAtMs: 0,
		});
		assert.equal(out.status, "error");
		assert.match(out.error ?? "", /owner-only/);
	});

	it("wake-gate: a {\"wakeAgent\":false} final line keeps it no-turn even with wakeAgent:true", async () => {
		const out = await executeCronScriptRun({
			job: scriptJob({ command: `node -e "console.log(JSON.stringify({wakeAgent:false}))"`, cwd: dir, wakeAgent: true }),
			runAtMs: 0,
		});
		// No agent run (the veto held) → delivered as a plain ok with the output.
		assert.equal(out.status, "ok");
		assert.match(out.summary ?? "", /wakeAgent/);
	});
});
