// src/cli/commands/store-cmd.ts
//
// `brigade store mode show|set` — operator-facing CLI for inspecting and
// flipping the storage-mode sentinel without re-running `brigade onboard`.
//
// Read path: parses `~/.brigade/mode.sentinel`.
// Write path: writes the sentinel with `writeSentinelNow`. Idempotent.
//
// Migration ISN'T part of this command; flipping the sentinel just changes
// where Brigade will read/write on next boot. `brigade store migrate` (a
// later PR) handles the data copy.

import readline from "node:readline/promises";

import chalk from "chalk";

import { resolveStateDir } from "../../config/paths.js";
import { isProcessAlive, readPid } from "../../core/gateway-probe.js";
import {
	encryptionKeySource,
	generateMasterKeyHex,
	retireEncryptionKeyFile,
	saveEncryptionKeyToFile,
} from "../../storage/encryption.js";
import {
	inspectConvexInstance,
	resetConvexInstance,
	type ConvexInstanceSummary,
} from "../../storage/instance-admin.js";
import { wipeLocalBrigadeState } from "../../storage/factory-reset.js";
import { runStoreMigrate } from "../../storage/migrate.js";
import { deleteSentinel, readSentinel, sentinelExists, writeSentinelNow } from "../../storage/sentinel.js";
import type { StorageMode } from "../../storage/runtime-context.js";

export interface StoreModeShowOptions {
	json?: boolean;
}

export interface StoreModeSetOptions {
	mode: string;
	convexUrl?: string;
	json?: boolean;
}

// ---------------------------------------------------------------------------
// brigade store mode show
// ---------------------------------------------------------------------------

export async function runStoreModeShow(opts: StoreModeShowOptions = {}): Promise<number> {
	let sentinel;
	try {
		sentinel = readSentinel();
	} catch (err) {
		const msg = (err as Error).message;
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
		} else {
			process.stderr.write(chalk.red(`brigade store mode show: ${msg}\n`));
		}
		return 1;
	}

	if (!sentinel) {
		const message = "filesystem (default — no mode.sentinel pinned yet)";
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify({ ok: true, mode: "filesystem", pinned: false }, null, 2)}\n`,
			);
		} else {
			process.stdout.write(`${chalk.bold("Storage mode:")} ${chalk.bold("filesystem")}\n`);
			process.stdout.write(chalk.dim(`  ${message}\n`));
			process.stdout.write(
				chalk.dim(`  Pin it with: brigade store mode set filesystem (or convex --convex-url <url>)\n`),
			);
		}
		return 0;
	}

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, mode: sentinel.mode, pinned: true, sentinel }, null, 2)}\n`,
		);
		return 0;
	}

	process.stdout.write(`${chalk.bold("Storage mode:")} ${chalk.bold(sentinel.mode)}\n`);
	if (sentinel.mode === "convex") {
		process.stdout.write(chalk.dim(`  Convex URL:   ${sentinel.convexUrl}\n`));
	}
	if (sentinel.migratedAt) {
		process.stdout.write(chalk.dim(`  Pinned at:    ${sentinel.migratedAt}\n`));
	}
	if (sentinel.manifestSha256) {
		process.stdout.write(chalk.dim(`  Manifest:     ${sentinel.manifestSha256}\n`));
	}
	return 0;
}

// ---------------------------------------------------------------------------
// brigade store mode set <mode>
// ---------------------------------------------------------------------------

export async function runStoreModeSet(opts: StoreModeSetOptions): Promise<number> {
	const mode = opts.mode.trim();
	if (mode !== "filesystem" && mode !== "convex") {
		const msg = `mode must be "filesystem" or "convex", got "${mode}"`;
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
		} else {
			process.stderr.write(chalk.red(`brigade store mode set: ${msg}\n`));
		}
		return 1;
	}

	if (mode === "convex") {
		const url = opts.convexUrl?.trim();
		if (!url || url.length === 0) {
			const msg = "convex mode requires --convex-url <http(s)://...>";
			if (opts.json) {
				process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
			} else {
				process.stderr.write(chalk.red(`brigade store mode set: ${msg}\n`));
			}
			return 1;
		}
		if (!/^https?:\/\//i.test(url)) {
			const msg = `convex URL must start with http:// or https://, got "${url}"`;
			if (opts.json) {
				process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
			} else {
				process.stderr.write(chalk.red(`brigade store mode set: ${msg}\n`));
			}
			return 1;
		}
	}

	// Convex mode is encrypted by default: make sure a key is active BEFORE
	// the first sealed write. Env var wins; else the key file; else generate
	// + persist + print ONCE (recovery-code framing). Mirrors the onboarding
	// wizard's key step so the power-user path gets the same posture.
	let generatedKeyHex: string | undefined;
	if (mode === "convex" && encryptionKeySource() === "none") {
		generatedKeyHex = generateMasterKeyHex();
		saveEncryptionKeyToFile(generatedKeyHex);
	}

	// `store mode set` is the command meant to (re-)pin the mode, so a corrupt
	// prior sentinel must not abort it — treat an unreadable prior as unknown
	// and let writeSentinelNow below heal the file (matches runStoreModeShow's
	// tolerance). modeChanged then reads false, skipping the no-data-moved warn.
	let priorSentinel: ReturnType<typeof readSentinel>;
	try {
		priorSentinel = readSentinel();
	} catch {
		priorSentinel = undefined;
	}
	const existed = sentinelExists();
	const modeChanged = priorSentinel?.mode !== undefined && priorSentinel.mode !== mode;
	const sentinel = writeSentinelNow(mode as StorageMode, {
		...(opts.convexUrl ? { convexUrl: opts.convexUrl.trim() } : {}),
	});

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					ok: true,
					mode: sentinel.mode,
					previouslyPinned: existed,
					sentinel,
					...(mode === "convex"
						? {
								encryption: {
									source: encryptionKeySource(),
									...(generatedKeyHex !== undefined
										? { generated: true, key: generatedKeyHex }
										: { generated: false }),
								},
							}
						: {}),
				},
				null,
				2,
			)}\n`,
		);
		return 0;
	}

	process.stdout.write(`${chalk.green("✓")} storage mode pinned to ${chalk.bold(sentinel.mode)}\n`);
	if (sentinel.mode === "convex") {
		process.stdout.write(chalk.dim(`  Convex URL:  ${sentinel.convexUrl}\n`));
	}
	if (generatedKeyHex !== undefined) {
		process.stdout.write(`\n${chalk.green("✓")} Created an encryption key for your data:\n\n`);
		process.stdout.write(`  ${chalk.bold(generatedKeyHex)}\n\n`);
		process.stdout.write(
			chalk.dim(
				"  Save this key in your password manager. It's also stored safely on this\n" +
					"  computer so Brigade starts automatically — but if this computer is ever\n" +
					"  lost, this key is the ONLY way to read your data.\n",
			),
		);
	}
	if (!existed) {
		const urlHint = sentinel.mode === "convex" ? " --convex-url <url>" : "";
		process.stdout.write(
			chalk.dim(`  Fresh pin — ${sentinel.mode} starts EMPTY. Flipping the mode does NOT move data.\n`),
		);
		process.stdout.write(
			chalk.dim(`  To copy your existing data across (the source mode is left intact), run:\n`),
		);
		process.stdout.write(
			chalk.dim(`    brigade store migrate --to ${sentinel.mode}${urlHint} --dry-run   # preview first\n`),
		);
		process.stdout.write(chalk.dim(`    brigade store migrate --to ${sentinel.mode}${urlHint}\n`));
	} else if (modeChanged) {
		// A re-flip moves NO data, and the previous mode's local files persist. On
		// the next boot the disk-authoritative workspace reconcile ("disk wins")
		// can push a STALE local persona/skill over the backend's correct copy.
		// Warn loudly and point at the safe paths (this used to be silent).
		const urlHint = sentinel.mode === "convex" ? " --convex-url <url>" : "";
		process.stdout.write(
			chalk.yellow(`  ⚠ Mode changed ${priorSentinel?.mode} → ${sentinel.mode}, but NO data was moved.\n`),
		);
		process.stdout.write(
			chalk.dim(
				`    ${sentinel.mode} uses whatever it already holds; a stale local workspace/skill can\n` +
					`    overwrite the backend mirror on the next boot. To bring your data across:\n` +
					`      brigade store migrate --to ${sentinel.mode}${urlHint}\n` +
					`    Or for a clean ${sentinel.mode} start: brigade store reset${urlHint}  then  brigade onboard\n`,
			),
		);
	}
	return 0;
}

// ---------------------------------------------------------------------------
// brigade store reset — factory reset of the convex instance
// ---------------------------------------------------------------------------

export interface StoreResetOptions {
	convexUrl?: string;
	yes?: boolean;
	purgeLocal?: boolean;
	json?: boolean;
}

function describeResetSummary(s: ConvexInstanceSummary): string {
	const n = (v: number): string => (v >= 1000 ? "1000+" : String(v));
	const parts = [
		`${n(s.counts.memories)} memories`,
		`${n(s.counts.sessions)} sessions`,
		`${n(s.counts.cronJobs)} scheduled jobs`,
		`${n(s.counts.personas)} persona files`,
	];
	if (s.hasActivity) parts.push("session & log history");
	if (s.whatsappLinked) parts.push("a linked WhatsApp");
	return parts.join(" · ");
}

/**
 * The honest "start over" for convex mode. Wiping `~/.brigade` is RESTORE
 * (the backend brings everything back) — erasing the backend is what a
 * fresh start actually means. Erases every row (+ stored files), removes
 * the mode pin, and sets the encryption key file aside (never deleted) so
 * the next onboard mints a fresh one.
 */
export async function runStoreReset(opts: StoreResetOptions = {}): Promise<number> {
	const fail = (msg: string): number => {
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
		else process.stderr.write(chalk.red(`brigade store reset: ${msg}\n`));
		return 1;
	};

	// The gateway holds caches + write-behind chains — erasing under it
	// would race. Same gate the link/unlink commands use.
	const pid = await readPid();
	if (pid && isProcessAlive(pid)) {
		return fail("the gateway is running — stop it first with `brigade gateway stop`");
	}

	const sentinel = readSentinel();
	const url =
		opts.convexUrl?.trim() || sentinel?.convexUrl || process.env.BRIGADE_CONVEX_URL?.trim();

	// Filesystem mode (or never-onboarded) has NO backend to erase — the state IS
	// the local ~/.brigade tree. A factory reset WIPES it (delete-outright) so the
	// next onboard starts VIRGIN, identical to a first-ever onboard, then retires
	// the encryption key. (Convex mode falls through to the backend-erase flow.)
	if ((sentinel?.mode ?? "filesystem") !== "convex" && !url) {
		if (!opts.yes) {
			if (!process.stdin.isTTY) {
				return fail("refusing to erase without --yes in a non-interactive shell");
			}
			process.stderr.write(
				`${chalk.red("This permanently erases your LOCAL Brigade data")} (workspace, skills, sessions, memory).\n` +
					`${chalk.dim("There is no undo.")}\n`,
			);
			const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
			try {
				const answer = (await rl.question(`Type ${chalk.bold("erase")} to continue: `)).trim().toLowerCase();
				if (answer !== "erase") {
					process.stderr.write("Cancelled.\n");
					return 1;
				}
			} finally {
				rl.close();
			}
		}
		// Retire the key BEFORE the wipe (it lives outside the state dir, so the
		// wipe can't touch it — but order it first so a wipe failure can't strand a
		// renamed key). The wipe also removes the sentinel (it's under the state dir).
		const retired = retireEncryptionKeyFile();
		try {
			wipeLocalBrigadeState();
		} catch (err) {
			return fail(`couldn't remove the local Brigade folder — ${(err as Error).message}`);
		}
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify(
					{
						ok: true,
						mode: "filesystem",
						wipedLocal: true,
						sentinelRemoved: true,
						...(retired.backedUpTo !== undefined ? { keySetAsideAt: retired.backedUpTo } : {}),
					},
					null,
					2,
				)}\n`,
			);
			return 0;
		}
		process.stdout.write(`${chalk.green("✓")} Local Brigade data erased — your next onboard starts fresh.\n`);
		if (retired.backedUpTo) {
			process.stdout.write(
				chalk.dim(`  Your old encryption key was set aside (not deleted): ${retired.backedUpTo}\n`),
			);
		}
		return 0;
	}

	if (!url) {
		return fail("no Convex deployment known — pass --convex-url <http(s)://...>");
	}

	let summary: ConvexInstanceSummary;
	try {
		summary = await inspectConvexInstance(url);
	} catch (err) {
		return fail(`couldn't reach the Convex backend at ${url} — ${(err as Error).message}`);
	}

	if (!opts.yes) {
		if (!process.stdin.isTTY) {
			return fail("refusing to erase without --yes in a non-interactive shell");
		}
		process.stderr.write(
			`${chalk.red("This permanently erases the Brigade stored in this backend:")}\n` +
				`  ${describeResetSummary(summary)}\n` +
				`${chalk.dim("There is no undo.")}\n`,
		);
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		try {
			const answer = (await rl.question(`Type ${chalk.bold("erase")} to continue: `)).trim().toLowerCase();
			if (answer !== "erase") {
				process.stderr.write("Cancelled.\n");
				return 1;
			}
		} finally {
			rl.close();
		}
	}

	const { deletedTotal } = await resetConvexInstance(url, {
		onProgress: (table, deleted) => {
			if (!opts.json) process.stderr.write(chalk.dim(`  cleared ${table} (${deleted})\n`));
		},
	});

	// Local teardown: drop the mode pin; set the key file aside (the data it
	// sealed is gone — next onboard mints a fresh key; the old file is kept
	// as a .bak in case an old backup of the erased data still needs it).
	deleteSentinel();
	const retired = retireEncryptionKeyFile();

	let purgedLocal = false;
	if (opts.purgeLocal) {
		try {
			// Preserve the bundled runtime (Node + `brigade` binary can live under
			// the state dir); a raw rm -rf ~/.brigade would uninstall the CLI.
			wipeLocalBrigadeState();
			purgedLocal = true;
		} catch (err) {
			return fail(`backend erased, but couldn't remove the local folder — ${(err as Error).message}`);
		}
	}

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					ok: true,
					deletedRecords: deletedTotal,
					sentinelRemoved: true,
					...(retired.backedUpTo !== undefined ? { keySetAsideAt: retired.backedUpTo } : {}),
					purgedLocal,
				},
				null,
				2,
			)}\n`,
		);
		return 0;
	}

	process.stdout.write(`${chalk.green("✓")} Erased ${deletedTotal} records from the backend.\n`);
	if (retired.backedUpTo) {
		process.stdout.write(
			chalk.dim(`  Your old encryption key was set aside (not deleted): ${retired.backedUpTo}\n`),
		);
	}
	if (purgedLocal) {
		process.stdout.write(chalk.dim("  Local Brigade folder removed.\n"));
	} else {
		process.stdout.write(
			chalk.dim("  Local files were left in place — delete the Brigade folder yourself or re-run with --purge-local.\n"),
		);
	}
	process.stdout.write(`\nRun ${chalk.bold("brigade onboard")} to start fresh.\n`);
	return 0;
}

// ---------------------------------------------------------------------------
// brigade store migrate --to <mode>
// ---------------------------------------------------------------------------

export interface StoreMigrateOptions {
	to: string;
	convexUrl?: string;
	dryRun?: boolean;
	skipVerify?: boolean;
	/** Keep the local filesystem source after a `--to convex` migrate instead of
	 *  wiping it (the default). Trades a clean footprint for an instant rollback. */
	keepSource?: boolean;
	json?: boolean;
}

export async function runStoreMigrateCmd(opts: StoreMigrateOptions): Promise<number> {
	const to = opts.to.trim();
	if (to !== "filesystem" && to !== "convex") {
		const msg = `--to must be "filesystem" or "convex", got "${to}"`;
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
		else process.stderr.write(chalk.red(`brigade store migrate: ${msg}\n`));
		return 1;
	}

	const report = await runStoreMigrate({
		to: to as StorageMode,
		stateDir: resolveStateDir(),
		...(opts.convexUrl !== undefined ? { convexUrl: opts.convexUrl } : {}),
		...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
		...(opts.skipVerify !== undefined ? { skipVerify: opts.skipVerify } : {}),
		...(opts.keepSource ? { cleanSource: false } : {}),
		onProgress: opts.json
			? undefined
			: (e) => {
					if (e.phase === "done") {
						process.stdout.write(
							chalk.dim(`  ${e.domain.padEnd(16)} ${e.count ?? 0} item${e.count === 1 ? "" : "s"}\n`),
						);
					} else if (e.phase === "skip") {
						process.stdout.write(chalk.yellow(`  ${e.domain.padEnd(16)} skipped: ${e.note}\n`));
					}
				},
	});

	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, report }, null, 2)}\n`);
		return 0;
	}

	const total = report.domains.reduce((acc, d) => acc + d.copied, 0);
	const skipped = report.domains.filter((d) => d.skipped).length;
	process.stdout.write(
		`\n${chalk.green("✓")} migrated ${chalk.bold(report.from)} → ${chalk.bold(report.to)} · ` +
			`${chalk.bold(String(total))} items across ${report.domains.length} domains · ` +
			`${report.durationMs}ms\n`,
	);
	if (skipped > 0) {
		process.stdout.write(chalk.yellow(`  ${skipped} domain${skipped === 1 ? "" : "s"} reported errors (see above)\n`));
	}
	if (report.dryRun) {
		process.stdout.write(chalk.dim(`  --dry-run: no data was written, no sentinel flipped\n`));
	} else if (report.sentinelWritten) {
		process.stdout.write(chalk.dim(`  ~/.brigade/mode.sentinel now points to ${report.to}\n`));
	} else {
		process.stdout.write(
			chalk.yellow(`  ⚠ sentinel write failed — flip manually with brigade store mode set ${report.to}\n`),
		);
	}
	// Report the local-source cleanup so "where did my filesystem copy go?" is
	// never a surprise — and so the rollback escape hatch is discoverable.
	if (!report.dryRun && report.to === "convex") {
		if (report.sourceCleaned) {
			process.stdout.write(
				chalk.dim(`  local filesystem copy cleared — Convex is now the only source (re-run with --keep-source to keep it)\n`),
			);
		} else if (skipped > 0) {
			process.stdout.write(
				chalk.yellow(`  local filesystem copy kept — a domain errored, so the source is preserved\n`),
			);
		} else if (opts.keepSource) {
			process.stdout.write(chalk.dim(`  local filesystem copy kept (--keep-source) — delete it when you're confident\n`));
		}
	}
	return 0;
}

