import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	coerceScheduleInput,
	defaultCronJobCreate,
} from "./normalize.js";
import type { CronJobCreate } from "./types.js";

describe("coerceScheduleInput — ISO + epoch + atMs acceptance", () => {
	it("accepts schedule.at as number (epoch ms) — back-compat", () => {
		const s = coerceScheduleInput({ kind: "at", at: 1_735_689_600_000 });
		assert.deepEqual(s, { kind: "at", at: 1_735_689_600_000 });
	});

	it("accepts schedule.at as ISO-8601 string with Z", () => {
		const s = coerceScheduleInput({ kind: "at", at: "2026-12-31T23:59:00Z" });
		assert.equal(s.kind, "at");
		if (s.kind !== "at") throw new Error("unreachable");
		assert.equal(s.at, Date.UTC(2026, 11, 31, 23, 59, 0));
	});

	it("accepts schedule.at as bare date — UTC midnight fallback", () => {
		const s = coerceScheduleInput({ kind: "at", at: "2026-12-31" });
		assert.equal(s.kind, "at");
		if (s.kind !== "at") throw new Error("unreachable");
		assert.equal(s.at, Date.UTC(2026, 11, 31, 0, 0, 0));
	});

	it("accepts schedule.at as naive date-time — UTC fallback", () => {
		const s = coerceScheduleInput({ kind: "at", at: "2026-12-31T23:59:00" });
		assert.equal(s.kind, "at");
		if (s.kind !== "at") throw new Error("unreachable");
		assert.equal(s.at, Date.UTC(2026, 11, 31, 23, 59, 0));
	});

	it("accepts atMs as string (digit form)", () => {
		const s = coerceScheduleInput({ kind: "at", atMs: "1735689600000" });
		assert.equal(s.kind, "at");
		if (s.kind !== "at") throw new Error("unreachable");
		assert.equal(s.at, 1_735_689_600_000);
	});

	it("infers kind:at from a bare ISO string on .at when kind omitted", () => {
		const s = coerceScheduleInput({ at: "2026-12-31T23:59:00Z" });
		assert.equal(s.kind, "at");
	});

	it("throws on malformed ISO with no fallback", () => {
		assert.throws(
			() => coerceScheduleInput({ kind: "at", at: "not-a-real-date" }),
			/cron schedule kind "at" requires/,
		);
	});
});

describe("defaultCronJobCreate — sessionTarget 'current' resolver", () => {
	function buildAgentTurn(target?: string): CronJobCreate {
		return {
			name: "ctx-test",
			schedule: { kind: "every", everyMs: 60_000 },
			sessionTarget: target as never,
			payload: { kind: "agentTurn", message: "do thing" },
		} as CronJobCreate;
	}

	it("resolves sessionTarget:'current' to session:<sessionKey> when context supplied", () => {
		const defaulted = defaultCronJobCreate(buildAgentTurn("current"), {
			sessionContext: { sessionKey: "agent:main:peer-7" },
		});
		assert.equal(defaulted.sessionTarget, "session:agent:main:peer-7");
	});

	it("falls back to 'isolated' when no session context is supplied", () => {
		const defaulted = defaultCronJobCreate(buildAgentTurn("current"));
		assert.equal(defaulted.sessionTarget, "isolated");
	});

	it("falls back to 'isolated' when sessionKey is empty / whitespace", () => {
		const defaulted = defaultCronJobCreate(buildAgentTurn("current"), {
			sessionContext: { sessionKey: "   " },
		});
		assert.equal(defaulted.sessionTarget, "isolated");
	});

	it("throws on path-special sessionKey ('/') even when 'current' is requested", () => {
		assert.throws(
			() =>
				defaultCronJobCreate(buildAgentTurn("current"), {
					sessionContext: { sessionKey: "evil/../escape" },
				}),
			/path separators|InvalidCronSessionTargetIdError|must not/,
		);
	});

	it("does NOT auto-pick 'current' when sessionTarget is omitted", () => {
		// Default policy: agentTurn → isolated (NOT current). Operator must
		// opt in to session binding explicitly.
		const create: CronJobCreate = {
			name: "no-target",
			schedule: { kind: "every", everyMs: 60_000 },
			payload: { kind: "agentTurn", message: "x" },
		} as CronJobCreate;
		const defaulted = defaultCronJobCreate(create, {
			sessionContext: { sessionKey: "agent:main:peer-7" },
		});
		assert.equal(defaulted.sessionTarget, "isolated");
	});

	it("leaves explicit 'session:<id>' untouched", () => {
		const create = buildAgentTurn("session:project-alpha");
		const defaulted = defaultCronJobCreate(create, {
			sessionContext: { sessionKey: "agent:main:peer-7" },
		});
		assert.equal(defaulted.sessionTarget, "session:project-alpha");
	});
});
