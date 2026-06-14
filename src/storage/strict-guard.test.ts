import { strict as assert } from "node:assert";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	__resetStrictGuardForTests,
	getStrictViolations,
	installStrictGuard,
} from "./strict-guard.js";

describe("strict-zero guard", () => {
	let stateDir: string;
	let savedMode: string | undefined;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-strict-"));
		savedMode = process.env.BRIGADE_STRICT_MODE;
	});

	afterEach(() => {
		__resetStrictGuardForTests();
		if (savedMode === undefined) delete process.env.BRIGADE_STRICT_MODE;
		else process.env.BRIGADE_STRICT_MODE = savedMode;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("warn mode records violations for state-dir writes but lets them through", () => {
		process.env.BRIGADE_STRICT_MODE = "warn";
		installStrictGuard(stateDir);

		fs.writeFileSync(path.join(stateDir, "brigade.json"), "{}", "utf8");
		const v = getStrictViolations();
		assert.ok(v.some((x) => x.target.includes("brigade.json")));
		// Write went through in warn mode.
		assert.ok(fs.existsSync(path.join(stateDir, "brigade.json")));
	});

	it("enforce mode throws on state-dir writes", () => {
		process.env.BRIGADE_STRICT_MODE = "enforce";
		installStrictGuard(stateDir);

		assert.throws(
			() => fs.writeFileSync(path.join(stateDir, "cron.json"), "{}", "utf8"),
			/strict-zero/,
		);
		assert.equal(fs.existsSync(path.join(stateDir, "cron.json")), false);
	});

	it("allowlist: mode.sentinel and workspace/** pass silently", () => {
		process.env.BRIGADE_STRICT_MODE = "enforce";
		installStrictGuard(stateDir);

		fs.writeFileSync(path.join(stateDir, "mode.sentinel"), '{"mode":"convex"}', "utf8");
		fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
		fs.writeFileSync(path.join(stateDir, "workspace", "SOUL.md"), "# soul", "utf8");
		fs.mkdirSync(path.join(stateDir, "agents", "inventory", "workspace"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(stateDir, "agents", "inventory", "workspace", "AGENTS.md"),
			"# agents",
			"utf8",
		);
		assert.equal(getStrictViolations().length, 0);
	});

	it("writes OUTSIDE the state dir are never touched", () => {
		process.env.BRIGADE_STRICT_MODE = "enforce";
		installStrictGuard(stateDir);

		const outside = mkdtempSync(path.join(tmpdir(), "brigade-outside-"));
		try {
			fs.writeFileSync(path.join(outside, "free.txt"), "ok", "utf8");
			assert.equal(getStrictViolations().length, 0);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("off mode installs nothing", () => {
		process.env.BRIGADE_STRICT_MODE = "off";
		installStrictGuard(stateDir);
		fs.writeFileSync(path.join(stateDir, "anything.json"), "{}", "utf8");
		assert.equal(getStrictViolations().length, 0);
	});
});
