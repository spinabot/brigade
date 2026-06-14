import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";

// We have to set HOME *before* importing the module under test, because
// `BRIGADE_DIR` is computed at module-load time. Node's ESM cache doesn't
// honor `?t=...` query strings, so we point HOME at a single shared tempdir
// for the whole file, then reset on-disk state + in-memory cache between
// tests via `_resetApprovalsCacheForTests` and `fs.rm`.

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-approvals-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalBrigadeHome = process.env.BRIGADE_HOME;
const originalBrigadeStateDir = process.env.BRIGADE_STATE_DIR;

process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome; // Windows-equivalent
delete process.env.BRIGADE_HOME;
// The hermetic suite runner (scripts/run-tests.mjs) pins BRIGADE_STATE_DIR
// globally, which OUTRANKS the home redirect above in resolveStateDir().
// This file's legacy-migration test plants files under tmpHome/.brigade, so
// pin the state dir to the SAME location — the test stays faithful to its
// original intent regardless of ambient env.
process.env.BRIGADE_STATE_DIR = path.join(tmpHome, ".brigade");

// Static import works now that HOME is set.
const mod = await import("./exec-approvals.js");

before(() => {
	process.on("exit", () => {
		if (originalHome !== undefined) process.env.HOME = originalHome;
		else delete process.env.HOME;
		if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
		else delete process.env.USERPROFILE;
		if (originalBrigadeHome !== undefined) process.env.BRIGADE_HOME = originalBrigadeHome;
		else delete process.env.BRIGADE_HOME;
		if (originalBrigadeStateDir !== undefined) process.env.BRIGADE_STATE_DIR = originalBrigadeStateDir;
		else delete process.env.BRIGADE_STATE_DIR;
		try {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});
});

beforeEach(() => {
	mod._resetApprovalsCacheForTests();
	const file = mod.getApprovalsFilePath();
	try {
		fs.rmSync(file, { force: true });
	} catch {
		/* ignore */
	}
});

afterEach(() => {
	mod._resetApprovalsCacheForTests();
});

describe("per-agent allowlist isolation", () => {
	it("default agent + non-default agent see independent allowlists", () => {
		mod.recordApproval("ls -la", "exact"); // default = "main"
		mod.recordApproval("rm dist", "exact", "scratch");
		assert.equal(mod.decideApproval("ls -la"), "allow");
		assert.equal(mod.decideApproval("ls -la", "scratch"), "prompt");
		assert.equal(mod.decideApproval("rm dist", "scratch"), "allow");
		assert.equal(mod.decideApproval("rm dist"), "prompt");
		// Paths actually differ.
		assert.notEqual(mod.getApprovalsFilePath(), mod.getApprovalsFilePath("scratch"));
	});

	it("removeApproval is scoped per agent", () => {
		mod.recordApproval("ls", "exact");
		mod.recordApproval("ls", "exact", "other");
		const r = mod.removeApproval("ls", "other");
		assert.equal(r.removedCommands, 1);
		assert.equal(mod.decideApproval("ls", "other"), "prompt");
		// Default agent untouched.
		assert.equal(mod.decideApproval("ls"), "allow");
	});

	it("legacy ~/.brigade/exec-approvals.json migrates into the default agent slot", () => {
		// Plant a legacy global file BEFORE the per-agent slot exists.
		// Compute the legacy path off the state-dir root, mirroring the
		// module's resolveLegacyExecApprovalsPath helper.
		mod._resetApprovalsCacheForTests();
		const legacy = path.join(tmpHome, ".brigade", "exec-approvals.json");
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		fs.writeFileSync(
			legacy,
			JSON.stringify({ version: 1, commands: ["legacy-cmd"], patterns: [] }),
			"utf8",
		);
		// Per-agent file does NOT exist yet — wipe defensively.
		try {
			fs.rmSync(mod.getApprovalsFilePath(), { force: true });
		} catch {
			/* ignore */
		}
		// First read triggers the migration.
		assert.equal(mod.decideApproval("legacy-cmd"), "allow");
		assert.ok(fs.existsSync(mod.getApprovalsFilePath()), "per-agent file should exist after migration");
		assert.ok(
			fs.existsSync(`${legacy}.migrated`) || !fs.existsSync(legacy),
			"legacy file should be renamed",
		);
	});
});

describe("decideApproval — hard-deny patterns", () => {
	it("blocks rm -rf /", () => {
		assert.equal(mod.decideApproval("rm -rf /"), "deny");
		assert.equal(mod.decideApproval("rm -rf / "), "deny");
		assert.equal(mod.decideApproval("rm -fr /"), "deny");
		assert.equal(mod.decideApproval("rm --recursive --force /"), "deny");
	});

	it("blocks dd to raw disks", () => {
		assert.equal(mod.decideApproval("dd if=/dev/zero of=/dev/sda"), "deny");
		assert.equal(mod.decideApproval("dd if=foo.iso of=/dev/nvme0n1"), "deny");
	});

	it("blocks fork bomb", () => {
		assert.equal(mod.decideApproval(":(){ :|:& };:"), "deny");
	});

	it("blocks mkfs on raw disk", () => {
		assert.equal(mod.decideApproval("mkfs.ext4 /dev/sdb1"), "deny");
	});

	it("does NOT block legitimate rm in a project", () => {
		assert.equal(mod.decideApproval("rm -rf node_modules"), "prompt");
		assert.equal(mod.decideApproval("rm dist/foo.js"), "prompt");
	});
});

describe("decideApproval — allowlist", () => {
	it("returns prompt for unknown commands", () => {
		assert.equal(mod.decideApproval("ls -la"), "prompt");
	});

	it("allows exact-match approved commands", () => {
		mod.recordApproval("ls -la", "exact");
		assert.equal(mod.decideApproval("ls -la"), "allow");
		// Whitespace difference still resolves via trim.
		assert.equal(mod.decideApproval("  ls -la  "), "allow");
	});

	it("allows pattern-match approved commands", () => {
		mod.recordApproval("^git (status|diff|log)( |$)", "pattern");
		assert.equal(mod.decideApproval("git status"), "allow");
		assert.equal(mod.decideApproval("git diff HEAD"), "allow");
		assert.equal(mod.decideApproval("git log --oneline"), "allow");
		assert.equal(mod.decideApproval("git push"), "prompt");
	});

	it("hard-deny REFUSES at recordApproval — never lands on disk for exact kind", () => {
		assert.throws(
			() => mod.recordApproval("rm -rf /", "exact"),
			(err: unknown) => err instanceof mod.BrigadeApprovalRefusedError,
		);
		// And the gate still says deny (file shouldn't contain it).
		assert.equal(mod.decideApproval("rm -rf /"), "deny");
	});

	it("malformed regex pattern is skipped, not crashed", () => {
		mod.recordApproval("[unclosed", "pattern");
		assert.equal(mod.decideApproval("foo"), "prompt");
	});
});

describe("recordApproval — persistence", () => {
	it("writes to disk + reloads on cache reset", () => {
		mod.recordApproval("npm test", "exact");
		assert.equal(mod.decideApproval("npm test"), "allow");
		// Drop the cache and read again — should reload from disk.
		mod._resetApprovalsCacheForTests();
		assert.equal(mod.decideApproval("npm test"), "allow");
	});

	it("dedupes repeated approvals", () => {
		mod.recordApproval("ls", "exact");
		mod.recordApproval("ls", "exact");
		mod.recordApproval("ls", "exact");
		const filePath = mod.getApprovalsFilePath();
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { commands: string[] };
		assert.equal(parsed.commands.filter((c: string) => c === "ls").length, 1);
	});

	it("ignores empty / whitespace-only approvals", () => {
		mod.recordApproval("   ", "exact");
		mod.recordApproval("", "exact");
		assert.equal(mod.decideApproval("   "), "prompt");
	});

	it("writes the file with operator-only perms (0o600) on POSIX", function (t) {
		if (process.platform === "win32") {
			t.skip("chmod fidelity is partial on NTFS — POSIX-only assertion");
			return;
		}
		mod.recordApproval("ls", "exact");
		const stat = fs.statSync(mod.getApprovalsFilePath());
		// Mode low bits = 0o600 (owner rw, no group, no world)
		assert.equal(stat.mode & 0o777, 0o600);
	});
});

describe("decideApproval — mtime cache invalidation (second-shell flow)", () => {
	it("reloads from disk when another process writes the file", () => {
		// Simulate "long-lived TUI process" reading the gate before any
		// approval exists.
		assert.equal(mod.decideApproval("ls -la"), "prompt");
		// Now another process writes the file directly (this is the
		// `brigade exec allow` flow run from a second shell). We mimic
		// that by writing the JSON manually with a bumped mtime, since
		// we're inside one process and want to bypass the in-memory cache.
		const filePath = mod.getApprovalsFilePath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 1, commands: ["ls -la"], patterns: [] }, null, 2),
			"utf8",
		);
		// Bump mtime by 100ms to ensure stat detects the change even on
		// filesystems with coarse mtime resolution.
		const future = new Date(Date.now() + 100);
		fs.utimesSync(filePath, future, future);
		// The original TUI's cache is now stale. The next decideApproval
		// MUST see the new mtime and reload.
		assert.equal(
			mod.decideApproval("ls -la"),
			"allow",
			"mtime change must invalidate the cache",
		);
	});

	it("loads from disk when the file is created out-of-band (cache miss path)", () => {
		// Cache starts empty; first call after beforeEach has no file.
		assert.equal(mod.decideApproval("ls"), "prompt");
		// Another process plants the file. The first decideApproval already
		// loaded into cache (with mtimeMs = -1 for missing). Next call
		// stats → mtime is now real → mismatch → reload.
		const filePath = mod.getApprovalsFilePath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 1, commands: ["ls"], patterns: [] }, null, 2),
			"utf8",
		);
		assert.equal(mod.decideApproval("ls"), "allow");
	});
});

describe("readApprovalsSummary", () => {
	it("reports fileExists=false when nothing has been written", () => {
		const s = mod.readApprovalsSummary();
		assert.equal(s.fileExists, false);
		assert.equal(s.commandCount, 0);
		assert.equal(s.patternCount, 0);
		assert.match(s.filePath, /exec-approvals\.json$/);
	});

	it("counts commands + patterns after writes", () => {
		mod.recordApproval("ls", "exact");
		mod.recordApproval("git status", "exact");
		mod.recordApproval("^npm ", "pattern");
		const s = mod.readApprovalsSummary();
		assert.equal(s.fileExists, true);
		assert.equal(s.commandCount, 2);
		assert.equal(s.patternCount, 1);
	});
});

describe("isHardDenied", () => {
	it("returns true for canonical POSIX foot-guns", () => {
		assert.equal(mod.isHardDenied("rm -rf /"), true);
		assert.equal(mod.isHardDenied("dd if=foo of=/dev/sda"), true);
		assert.equal(mod.isHardDenied(":(){ :|:& };:"), true);
	});

	it("returns true for Windows foot-guns (cmd.exe family)", () => {
		assert.equal(mod.isHardDenied("rd /s /q C:\\"), true);
		assert.equal(mod.isHardDenied("rd /S /Q C:\\"), true);
		assert.equal(mod.isHardDenied("del /f /s /q C:\\*"), true);
		assert.equal(mod.isHardDenied("DEL /F /S /Q C:\\"), true);
		// Quoted path variants (round-4 audit gap fix).
		assert.equal(mod.isHardDenied('rd /s /q "C:\\Users"'), true);
		assert.equal(mod.isHardDenied("rd /s /q 'C:\\'"), true);
	});

	it("returns false for safe single-file del variants (the round-4 audit del-false-positive regression)", () => {
		// `del /q C:\file` is a SAFE single-file quiet-delete — must NOT be
		// hard-denied. The previous regex matched any `del /<letter>` then
		// drive root, which over-rejected.
		assert.equal(mod.isHardDenied("del /q C:\\file.txt"), false);
		assert.equal(mod.isHardDenied("del /p C:\\file.txt"), false);
		assert.equal(mod.isHardDenied("del /a C:\\file.txt"), false);
		// But /s variants STILL match — they delete recursively.
		assert.equal(mod.isHardDenied("del /s C:\\folder"), true);
		assert.equal(mod.isHardDenied("del /q /s C:\\*"), true);
	});

	it("returns true for Windows foot-guns (PowerShell family)", () => {
		assert.equal(mod.isHardDenied("Remove-Item -Recurse -Force C:\\"), true);
		assert.equal(mod.isHardDenied("Remove-Item -Force -Recurse C:\\"), true);
		assert.equal(mod.isHardDenied("remove-item -recurse -force c:\\"), true);
		assert.equal(mod.isHardDenied("Format-Volume -DriveLetter C"), true);
		assert.equal(mod.isHardDenied("Clear-Disk -Number 0 -RemoveData"), true);
		// PowerShell alias `ri` and short flag `-r` (round-4 audit gap fix).
		assert.equal(mod.isHardDenied("ri -Recurse -Force C:\\"), true);
		assert.equal(mod.isHardDenied("ri -r -Force C:\\"), true);
		// Quoted destinations.
		assert.equal(mod.isHardDenied('Remove-Item -Recurse -Force "C:\\Users"'), true);
	});

	it("returns false for safe commands across platforms", () => {
		assert.equal(mod.isHardDenied("ls"), false);
		assert.equal(mod.isHardDenied("rm -rf node_modules"), false);
		assert.equal(mod.isHardDenied("Remove-Item .\\temp.txt"), false); // no -Recurse
		assert.equal(mod.isHardDenied("rd subdir"), false); // no /s flag
		assert.equal(mod.isHardDenied("ri .\\temp"), false); // alias without destructive flags
		assert.equal(mod.isHardDenied(""), false);
	});
});

describe("decideApproval — whitespace normalization (exact match)", () => {
	it("matches allowlisted command despite extra internal whitespace from the model", () => {
		mod.recordApproval("ls -la", "exact");
		assert.equal(mod.decideApproval("ls  -la"), "allow");
		assert.equal(mod.decideApproval("ls   -la"), "allow");
		assert.equal(mod.decideApproval("  ls -la  "), "allow");
		assert.equal(mod.decideApproval("ls\t-la"), "allow"); // tab also normalised
	});

	it("does NOT match different commands that happen to whitespace-collapse the same", () => {
		mod.recordApproval("ls -la", "exact");
		assert.equal(mod.decideApproval("ls -lah"), "prompt");
		assert.equal(mod.decideApproval("ls"), "prompt");
	});
});

describe("patternMatchesHardDeny", () => {
	it("returns true for patterns that match a hard-deny probe", () => {
		assert.equal(mod.patternMatchesHardDeny(".*"), true);
		assert.equal(mod.patternMatchesHardDeny("rm -rf /"), true);
		assert.equal(mod.patternMatchesHardDeny("^Remove-Item"), true); // matches Remove-Item -Recurse...
	});

	it("returns false for patterns that don't match any probe", () => {
		assert.equal(mod.patternMatchesHardDeny("^git (status|diff|log)"), false);
		assert.equal(mod.patternMatchesHardDeny("^ls"), false);
		assert.equal(mod.patternMatchesHardDeny("^npm test$"), false);
	});

	it("returns false for malformed regex (caller handles invalid syntax up-front)", () => {
		assert.equal(mod.patternMatchesHardDeny("[unclosed"), false);
	});
});

describe("loadApprovals — malformed file tolerance", () => {
	it("returns empty allowlist when file is unparseable JSON", () => {
		fs.writeFileSync(mod.getApprovalsFilePath(), "{not json", "utf8");
		assert.equal(mod.decideApproval("ls"), "prompt");
	});

	it("returns empty allowlist when file is empty", () => {
		fs.writeFileSync(mod.getApprovalsFilePath(), "", "utf8");
		assert.equal(mod.decideApproval("ls"), "prompt");
	});

	it("returns empty allowlist when file is whitespace only", () => {
		fs.writeFileSync(mod.getApprovalsFilePath(), "   \n\n  ", "utf8");
		assert.equal(mod.decideApproval("ls"), "prompt");
	});

	it("tolerates top-level JSON array (shape violation)", () => {
		fs.writeFileSync(mod.getApprovalsFilePath(), "[]", "utf8");
		assert.equal(mod.decideApproval("ls"), "prompt");
	});

	it("tolerates top-level JSON null", () => {
		fs.writeFileSync(mod.getApprovalsFilePath(), "null", "utf8");
		assert.equal(mod.decideApproval("ls"), "prompt");
	});

	it("tolerates commands that aren't arrays", () => {
		fs.writeFileSync(
			mod.getApprovalsFilePath(),
			JSON.stringify({ version: 1, commands: "ls", patterns: {} }),
			"utf8",
		);
		assert.equal(mod.decideApproval("ls"), "prompt");
	});
});

describe("loadApprovals — schema version gate", () => {
	it("decideApproval throws BrigadeApprovalFileVersionError on v2 file", () => {
		fs.writeFileSync(
			mod.getApprovalsFilePath(),
			JSON.stringify({ version: 2, commands: ["ls"] }),
			"utf8",
		);
		assert.throws(
			() => mod.decideApproval("ls"),
			(err: unknown) => err instanceof mod.BrigadeApprovalFileVersionError,
		);
	});

	it("recordApproval throws on v99 file (caller can't append silently)", () => {
		fs.writeFileSync(
			mod.getApprovalsFilePath(),
			JSON.stringify({ version: 99, commands: [] }),
			"utf8",
		);
		assert.throws(
			() => mod.recordApproval("ls", "exact"),
			(err: unknown) => err instanceof mod.BrigadeApprovalFileVersionError,
		);
	});

	it("readApprovalsSummary reports version-mismatch via error field, doesn't throw", () => {
		fs.writeFileSync(
			mod.getApprovalsFilePath(),
			JSON.stringify({ version: 2, commands: [] }),
			"utf8",
		);
		const s = mod.readApprovalsSummary();
		assert.equal(s.fileExists, true);
		assert.equal(s.commandCount, 0);
		assert.match(s.error ?? "", /schema version/);
	});

	it("missing version field is treated as v1 (back-compat for old files)", () => {
		fs.writeFileSync(
			mod.getApprovalsFilePath(),
			JSON.stringify({ commands: ["ls"], patterns: [] }),
			"utf8",
		);
		assert.equal(mod.decideApproval("ls"), "allow");
	});
});

describe("recordApproval + removeApproval — concurrent-write safety", () => {
	it("recordApproval merges with sibling-process additions (no entries lost)", () => {
		// Sibling process writes "x" to disk while THIS process knows nothing.
		fs.writeFileSync(
			mod.getApprovalsFilePath(),
			JSON.stringify({ version: 1, commands: ["x"], patterns: [] }),
			"utf8",
		);
		// We bump mtime to invalidate any cached snapshot from an earlier test.
		const future = new Date(Date.now() + 100);
		fs.utimesSync(mod.getApprovalsFilePath(), future, future);
		// THIS process adds "y". Without merge-from-disk, "x" would be lost.
		mod.recordApproval("y", "exact");
		// Read raw — both entries MUST be there.
		const parsed = JSON.parse(fs.readFileSync(mod.getApprovalsFilePath(), "utf8")) as {
			commands: string[];
		};
		assert.deepEqual(parsed.commands.sort(), ["x", "y"]);
	});

	it("removeApproval merges with sibling-process additions before deleting", () => {
		// Sibling writes "x", "y", "z" — three entries.
		fs.writeFileSync(
			mod.getApprovalsFilePath(),
			JSON.stringify({ version: 1, commands: ["x", "y", "z"], patterns: [] }),
			"utf8",
		);
		const future = new Date(Date.now() + 100);
		fs.utimesSync(mod.getApprovalsFilePath(), future, future);
		// THIS process removes "y" — must drop ONLY "y", keep the others
		// (last writer doesn't clobber x and z).
		const result = mod.removeApproval("y");
		assert.equal(result.removedCommands, 1);
		const parsed = JSON.parse(fs.readFileSync(mod.getApprovalsFilePath(), "utf8")) as {
			commands: string[];
		};
		assert.deepEqual(parsed.commands.sort(), ["x", "z"]);
	});

	it("removeApproval is a no-op when value isn't in either list", () => {
		mod.recordApproval("ls", "exact");
		const result = mod.removeApproval("not-there");
		assert.equal(result.removedCommands, 0);
		assert.equal(result.removedPatterns, 0);
		// File still has "ls".
		const parsed = JSON.parse(fs.readFileSync(mod.getApprovalsFilePath(), "utf8")) as {
			commands: string[];
		};
		assert.deepEqual(parsed.commands, ["ls"]);
	});

	it("removeApproval preserves 0o600 perms (regression test for the CLI's old umask leak)", function (t) {
		if (process.platform === "win32") {
			t.skip("chmod fidelity is partial on NTFS — POSIX-only assertion");
			return;
		}
		mod.recordApproval("ls", "exact");
		mod.recordApproval("git status", "exact");
		mod.removeApproval("ls");
		const stat = fs.statSync(mod.getApprovalsFilePath());
		assert.equal(stat.mode & 0o777, 0o600);
	});
});

describe("recordApproval — symlink guard", () => {
	it("refuses to write through a symlink at the file path", function (t) {
		// Skip on Windows hosts without Dev Mode (symlink creation requires admin
		// or developer mode; many CI runners lack it).
		const filePath = mod.getApprovalsFilePath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const fakeTarget = path.join(path.dirname(filePath), "decoy.json");
		fs.writeFileSync(fakeTarget, "{}", "utf8");
		try {
			fs.symlinkSync(fakeTarget, filePath);
		} catch (err) {
			t.skip(`symlink creation not permitted on this host: ${(err as Error).message}`);
			return;
		}
		try {
			assert.throws(
				() => mod.recordApproval("ls", "exact"),
				(err: unknown) => err instanceof mod.BrigadeApprovalRefusedError && /symlink/i.test((err as Error).message),
			);
			// Decoy file untouched.
			assert.equal(fs.readFileSync(fakeTarget, "utf8"), "{}");
		} finally {
			try {
				fs.unlinkSync(filePath);
			} catch {
				/* ignore */
			}
		}
	});
});

describe("recordApproval — large input tolerance", () => {
	it("accepts a 1MB exact command without OOM", () => {
		const big = "echo " + "a".repeat(1_000_000);
		mod.recordApproval(big, "exact");
		assert.equal(mod.decideApproval(big), "allow");
	});
});

describe("decideApproval — hard-deny wins over a matching pattern", () => {
	it("an operator-supplied pattern that DOES match a hard-denied command can't override hard-deny", () => {
		// Plant a pattern by writing directly to disk (bypassing recordApproval's
		// pattern-hard-deny pre-check, which would refuse this pattern). This
		// simulates the case where an older Brigade version (without the pre-
		// check) had stored such a pattern OR an operator hand-edited the file.
		fs.writeFileSync(
			mod.getApprovalsFilePath(),
			JSON.stringify({ version: 1, commands: [], patterns: [".*"] }),
			"utf8",
		);
		// Hard-deny check runs FIRST in decideApproval.
		assert.equal(mod.decideApproval("rm -rf /"), "deny");
		assert.equal(mod.decideApproval("Remove-Item -Recurse -Force C:\\"), "deny");
		// And safe commands STILL get "allow" from the permissive pattern.
		assert.equal(mod.decideApproval("ls"), "allow");
	});

	it("recordApproval REFUSES to persist a permissive pattern that matches hard-deny probes", () => {
		assert.throws(
			() => mod.recordApproval(".*", "pattern"),
			(err: unknown) => err instanceof mod.BrigadeApprovalRefusedError,
		);
		assert.throws(
			() => mod.recordApproval("^Remove-Item", "pattern"),
			(err: unknown) => err instanceof mod.BrigadeApprovalRefusedError,
		);
	});

	it("recordApproval ALLOWS a pattern that doesn't match any hard-deny probe", () => {
		mod.recordApproval("^git (status|diff|log)", "pattern");
		assert.equal(mod.decideApproval("git status"), "allow");
		assert.equal(mod.decideApproval("git log --oneline"), "allow");
	});
});
