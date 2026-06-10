/**
 * `brigade backup …` — snapshot, verify, and restore `~/.brigade/`.
 *
 * Operators need a one-shot way to move a Brigade install between hosts and a
 * disaster-recovery path. This packs the full `~/.brigade` tree (config, auth,
 * channel creds, memory, sessions) into a single `.tar.gz` with a sha256
 * manifest so corrupted backups are caught before you trust them.
 *
 * Excludes by default:
 *   - rotating `.bak.*` snapshots (already redundant)
 *   - `logs/` (operational noise, not state — restore would just recreate them)
 *   - `cache/` (regeneratable)
 *
 * Stop the gateway before backing up (the file lock in the pairing store would
 * fight an active write). `brigade backup create` warns + refuses if the
 * gateway is running, unless `--force`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as tar from "tar";

import { resolveStateDir } from "../../config/paths.js";
import { isProcessAlive, readPid } from "../../core/gateway-probe.js";

const MANIFEST_NAME = ".brigade-backup-manifest.json";
const EXCLUDE_DIRS = ["logs", "cache"];
const EXCLUDE_FILE_RE = /\.bak(\.\d+)?$|\.clobbered\.\d+$|gateway\.pid$|\.brigade-backup-manifest\.json$/;

interface ManifestEntry {
	path: string; // relative to ~/.brigade
	sha256: string;
	bytes: number;
}

interface Manifest {
	version: 1;
	createdAt: string;
	stateDir: string;
	entries: ManifestEntry[];
}

async function gatewayIsRunning(): Promise<boolean> {
	const pid = await readPid();
	return pid != null && isProcessAlive(pid);
}

function shouldInclude(relPath: string): boolean {
	const parts = relPath.split(/[/\\]/);
	if (parts.some((p) => EXCLUDE_DIRS.includes(p))) return false;
	if (EXCLUDE_FILE_RE.test(parts[parts.length - 1] ?? "")) return false;
	return true;
}

/** Walk a directory and return relative file paths that pass `shouldInclude`. */
function walk(root: string): string[] {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const full = path.join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			const rel = path.relative(root, full).split(path.sep).join("/"); // POSIX paths in manifest
			if (st.isDirectory()) {
				if (!shouldInclude(rel)) continue;
				stack.push(full);
			} else if (st.isFile() && shouldInclude(rel)) {
				out.push(rel);
			}
		}
	}
	return out;
}

function sha256File(filePath: string): { hex: string; bytes: number } {
	const buf = readFileSync(filePath);
	return { hex: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

/* ─────────────────────────── create ─────────────────────────── */

export async function runBackupCreate(
	args: { output?: string; force?: boolean },
	opts: { json?: boolean } = {},
): Promise<number> {
	const stateDir = resolveStateDir();
	if (!existsSync(stateDir)) {
		const msg = `Nothing to back up — ${stateDir} doesn't exist.`;
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}
	if ((await gatewayIsRunning()) && !args.force) {
		const msg = "The Brigade gateway is running. Stop it first (`brigade gateway stop`) or pass --force to back up live state.";
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outPath = path.resolve(args.output ?? `brigade-backup-${stamp}.tar.gz`);

	const entries: string[] = walk(stateDir);
	const manifest: Manifest = {
		version: 1,
		createdAt: new Date().toISOString(),
		stateDir,
		entries: entries.map((rel) => {
			const { hex, bytes } = sha256File(path.join(stateDir, rel));
			return { path: rel, sha256: hex, bytes };
		}),
	};

	// Write the manifest into the state dir tree (under the temp prefix) so it
	// gets tarred alongside the rest, then remove it after archiving.
	const manifestPath = path.join(stateDir, MANIFEST_NAME);
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	const allFiles = [...entries, MANIFEST_NAME];
	try {
		await tar.c(
			{
				gzip: true,
				file: outPath,
				cwd: stateDir,
				portable: true,
				mtime: new Date(),
			},
			allFiles,
		);
	} finally {
		try {
			rmSync(manifestPath, { force: true });
		} catch {
			/* ignore */
		}
	}

	const archiveBytes = statSync(outPath).size;
	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify(
				{ ok: true, output: outPath, entries: manifest.entries.length, bytes: archiveBytes },
				null,
				2,
			)}\n`,
		);
	} else {
		process.stdout.write(`Wrote ${outPath} (${manifest.entries.length} files, ${formatBytes(archiveBytes)}).\n`);
	}
	return 0;
}

/* ─────────────────────────── verify ─────────────────────────── */

export async function runBackupVerify(
	args: { archive: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const archivePath = path.resolve(args.archive);
	if (!existsSync(archivePath)) {
		process.stderr.write(`Archive not found: ${archivePath}\n`);
		return 1;
	}
	const extractDir = mkdtempSync(path.join(tmpdir(), "brigade-verify-"));
	const result = { ok: true as boolean, entries: 0, mismatches: [] as string[], reason: "" as string };
	try {
		await tar.x({ file: archivePath, cwd: extractDir });
		const manifestPath = path.join(extractDir, MANIFEST_NAME);
		if (!existsSync(manifestPath)) {
			result.ok = false;
			result.reason = "Archive is missing the Brigade manifest (was it created by `brigade backup create`?)";
		} else {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
			for (const e of manifest.entries) {
				const onDisk = path.join(extractDir, e.path);
				if (!existsSync(onDisk)) {
					result.ok = false;
					result.mismatches.push(`${e.path}: missing`);
					continue;
				}
				const { hex } = sha256File(onDisk);
				if (hex !== e.sha256) {
					result.ok = false;
					result.mismatches.push(`${e.path}: sha256 mismatch`);
				}
			}
			result.entries = manifest.entries.length;
		}
	} catch (err) {
		result.ok = false;
		result.reason = err instanceof Error ? err.message : String(err);
	} finally {
		rmSync(extractDir, { recursive: true, force: true });
	}

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.ok) {
		process.stdout.write(`Verified ${archivePath} (${result.entries} files, all sha256 match).\n`);
	} else {
		const detail = result.reason || `${result.mismatches.length} mismatch(es): ${result.mismatches.slice(0, 5).join(", ")}`;
		process.stderr.write(`Archive failed verification: ${detail}\n`);
	}
	return result.ok ? 0 : 1;
}

/* ─────────────────────────── restore ─────────────────────────── */

export async function runBackupRestore(
	args: { archive: string; target?: string; force?: boolean },
	opts: { json?: boolean } = {},
): Promise<number> {
	const archivePath = path.resolve(args.archive);
	if (!existsSync(archivePath)) {
		process.stderr.write(`Archive not found: ${archivePath}\n`);
		return 1;
	}
	const target = path.resolve(args.target ?? resolveStateDir());
	if ((await gatewayIsRunning()) && !args.force) {
		process.stderr.write("The Brigade gateway is running. Stop it first (`brigade gateway stop`) or pass --force.\n");
		return 1;
	}
	if (existsSync(target) && !args.force) {
		process.stderr.write(`Target ${target} already exists. Pass --force to overwrite.\n`);
		return 1;
	}
	mkdirSync(target, { recursive: true });
	try {
		await tar.x({ file: archivePath, cwd: target });
		// Drop the manifest after restore — it's not Brigade state.
		const manifestPath = path.join(target, MANIFEST_NAME);
		if (existsSync(manifestPath)) rmSync(manifestPath, { force: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`Restore failed: ${msg}\n`);
		return 1;
	}
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, target })}\n`);
	} else {
		process.stdout.write(`Restored to ${target}.\n`);
	}
	return 0;
}

/* ─────────────────────────── helpers ─────────────────────────── */

function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

