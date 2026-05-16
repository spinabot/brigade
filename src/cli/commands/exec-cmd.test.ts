import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";

// Repoint HOME at a tempdir BEFORE the under-test module resolves
// BRIGADE_DIR (computed at import time). exec-approvals + exec-cmd both
// read/write `~/.brigade/exec-approvals.json`; without this they would
// clobber the operator's real allowlist on the dev machine.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-execcmd-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalBrigadeHome = process.env.BRIGADE_HOME;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.BRIGADE_HOME;

const approvalsMod = await import("../../core/exec-approvals.js");
const execCmd = await import("./exec-cmd.js");

// Capture stdout / stderr so we can assert on emitted text without
// polluting the test runner's output. Restored after each test.
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function captureIO(): void {
	stdoutChunks = [];
	stderrChunks = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as never;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as never;
}

function restoreIO(): void {
	process.stdout.write = originalStdoutWrite;
	process.stderr.write = originalStderrWrite;
}

function out(): string {
	return stdoutChunks.join("");
}
function err(): string {
	return stderrChunks.join("");
}

before(() => {
	process.on("exit", () => {
		if (originalHome !== undefined) process.env.HOME = originalHome;
		else delete process.env.HOME;
		if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
		else delete process.env.USERPROFILE;
		if (originalBrigadeHome !== undefined) process.env.BRIGADE_HOME = originalBrigadeHome;
		else delete process.env.BRIGADE_HOME;
		try {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});
});

beforeEach(() => {
	approvalsMod._resetApprovalsCacheForTests();
	try {
		fs.rmSync(approvalsMod.getApprovalsFilePath(), { force: true });
	} catch {
		/* ignore */
	}
	captureIO();
});

afterEach(() => {
	restoreIO();
});

describe("brigade exec list", () => {
	it("prints an empty-state hint when no commands or patterns are stored", async () => {
		const code = await execCmd.runExecList();
		assert.equal(code, 0);
		assert.match(out(), /\(empty/);
		assert.match(out(), /brigade exec allow/);
	});

	it("prints stored commands + patterns", async () => {
		approvalsMod.recordApproval("ls -la", "exact");
		approvalsMod.recordApproval("^git diff", "pattern");
		const code = await execCmd.runExecList();
		assert.equal(code, 0);
		assert.match(out(), /commands:/);
		assert.match(out(), /ls -la/);
		assert.match(out(), /patterns:/);
		assert.match(out(), /\^git diff/);
	});

	it("--json emits the raw approvals shape", async () => {
		approvalsMod.recordApproval("ls", "exact");
		await execCmd.runExecList({ json: true });
		const parsed = JSON.parse(out());
		assert.equal(parsed.version, 1);
		assert.deepEqual(parsed.commands, ["ls"]);
		assert.deepEqual(parsed.patterns, []);
	});
});

describe("brigade exec allow", () => {
	it("approves an exact command + persists to disk", async () => {
		const code = await execCmd.runExecAllow("ls -la");
		assert.equal(code, 0);
		assert.match(out(), /allowed.*ls -la/);
		assert.equal(approvalsMod.decideApproval("ls -la"), "allow");
	});

	it("refuses hard-deny patterns even when the operator asked to allow them", async () => {
		const code = await execCmd.runExecAllow("rm -rf /");
		assert.equal(code, 1);
		assert.match(err(), /hard-deny pattern/);
		assert.equal(approvalsMod.decideApproval("rm -rf /"), "deny");
	});

	it("rejects empty commands", async () => {
		const code = await execCmd.runExecAllow("   ");
		assert.equal(code, 1);
		assert.match(err(), /command is empty/);
	});

	it("--json emits ok+kind+command on success", async () => {
		const code = await execCmd.runExecAllow("ls", { json: true });
		assert.equal(code, 0);
		const parsed = JSON.parse(out());
		assert.equal(parsed.ok, true);
		assert.equal(parsed.kind, "exact");
		assert.equal(parsed.command, "ls");
	});
});

describe("brigade exec allow-pattern", () => {
	it("approves a valid regex pattern", async () => {
		const code = await execCmd.runExecAllowPattern("^git (status|diff)( |$)");
		assert.equal(code, 0);
		assert.equal(approvalsMod.decideApproval("git status"), "allow");
		assert.equal(approvalsMod.decideApproval("git diff HEAD"), "allow");
		assert.equal(approvalsMod.decideApproval("git push"), "prompt");
	});

	it("refuses invalid regex syntax", async () => {
		const code = await execCmd.runExecAllowPattern("[unclosed");
		assert.equal(code, 1);
		assert.match(err(), /invalid regex/i);
	});

	it("rejects empty patterns", async () => {
		const code = await execCmd.runExecAllowPattern("  ");
		assert.equal(code, 1);
		assert.match(err(), /pattern is empty/);
	});
});

describe("brigade exec remove", () => {
	it("removes an exact command", async () => {
		approvalsMod.recordApproval("ls", "exact");
		const code = await execCmd.runExecRemove("ls");
		assert.equal(code, 0);
		assert.match(out(), /removed.*1 command/);
		assert.equal(approvalsMod.decideApproval("ls"), "prompt");
	});

	it("removes a pattern", async () => {
		approvalsMod.recordApproval("^git ", "pattern");
		const code = await execCmd.runExecRemove("^git ");
		assert.equal(code, 0);
		assert.match(out(), /removed.*1 pattern/);
		assert.equal(approvalsMod.decideApproval("git status"), "prompt");
	});

	it("exits 1 when the value isn't found", async () => {
		const code = await execCmd.runExecRemove("not-there");
		assert.equal(code, 1);
		assert.match(err(), /not found/);
	});
});

describe("brigade exec deny-test", () => {
	it("classifies hard-deny commands as deny", async () => {
		const code = await execCmd.runExecDenyTest("rm -rf /");
		assert.equal(code, 0);
		assert.match(out(), /deny/);
		assert.match(out(), /CANNOT be allowlisted/);
	});

	it("classifies approved commands as allow", async () => {
		approvalsMod.recordApproval("ls", "exact");
		const code = await execCmd.runExecDenyTest("ls");
		assert.equal(code, 0);
		assert.match(out(), /allow/);
	});

	it("classifies unknown commands as prompt", async () => {
		const code = await execCmd.runExecDenyTest("npm test");
		assert.equal(code, 0);
		assert.match(out(), /prompt/);
		assert.match(out(), /brigade exec allow/);
	});

	it("--json emits {command, decision}", async () => {
		approvalsMod.recordApproval("ls", "exact");
		await execCmd.runExecDenyTest("ls", { json: true });
		const parsed = JSON.parse(out());
		assert.equal(parsed.command, "ls");
		assert.equal(parsed.decision, "allow");
	});
});

describe("brigade exec file", () => {
	it("prints the approvals file path", async () => {
		const code = await execCmd.runExecFile();
		assert.equal(code, 0);
		assert.match(out(), /exec-approvals\.json/);
	});

	it("--json wraps the path in JSON", async () => {
		await execCmd.runExecFile({ json: true });
		const parsed = JSON.parse(out());
		assert.match(parsed.path, /exec-approvals\.json/);
	});
});
