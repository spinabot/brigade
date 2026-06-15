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

import * as fs from "node:fs";
import readline from "node:readline/promises";

import chalk from "chalk";
import type { Command } from "commander";

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

	const existed = sentinelExists();
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
		process.stdout.write(
			chalk.dim(`  This is a fresh pin. To migrate existing data between modes use:\n`),
		);
		process.stdout.write(
			chalk.dim(`    brigade store migrate --to ${sentinel.mode}  (not yet shipped — Phase 2 PR17)\n`),
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
			fs.rmSync(resolveStateDir(), { recursive: true, force: true });
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
	return 0;
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export function registerStoreCommand(program: Command): void {
	const store = program
		.command("store")
		.description("Inspect or flip Brigade's storage backend (filesystem / convex)");

	const mode = store.command("mode").description("Manage the storage-mode sentinel");

	mode
		.command("show")
		.description("Print the active storage mode (and Convex URL if applicable)")
		.option("--json", "emit JSON instead of human-readable text", false)
		.action(async (opts: { json?: boolean }) => {
			process.exit(await runStoreModeShow({ json: opts.json }));
		});

	mode
		.command("set <mode>")
		.description(
			"Pin the storage mode for this machine.\n" +
				"  Examples:\n" +
				"    brigade store mode set filesystem\n" +
				"    brigade store mode set convex --convex-url http://127.0.0.1:3210",
		)
		.option("--convex-url <url>", "deployment URL (required when <mode> is convex)")
		.option("--json", "emit JSON instead of human-readable text", false)
		.action(async (modeArg: string, opts: { convexUrl?: string; json?: boolean }) => {
			process.exit(
				await runStoreModeSet({
					mode: modeArg,
					...(opts.convexUrl !== undefined ? { convexUrl: opts.convexUrl } : {}),
					...(opts.json !== undefined ? { json: opts.json } : {}),
				}),
			);
		});

	store
		.command("reset")
		.description(
			"Factory-reset the convex backend: permanently erase every stored record,\n" +
				"remove the mode pin, and set the encryption key aside so the next onboard\n" +
				"starts truly fresh. (Wiping ~/.brigade alone RESTORES — this erases.)",
		)
		.option("--convex-url <url>", "deployment URL (defaults to the pinned sentinel URL)")
		.option("--yes", "skip the interactive confirmation", false)
		.option("--purge-local", "also delete the local Brigade folder", false)
		.option("--json", "emit JSON instead of human-readable text", false)
		.action(async (opts: { convexUrl?: string; yes?: boolean; purgeLocal?: boolean; json?: boolean }) => {
			process.exit(
				await runStoreReset({
					...(opts.convexUrl !== undefined ? { convexUrl: opts.convexUrl } : {}),
					...(opts.yes !== undefined ? { yes: opts.yes } : {}),
					...(opts.purgeLocal !== undefined ? { purgeLocal: opts.purgeLocal } : {}),
					...(opts.json !== undefined ? { json: opts.json } : {}),
				}),
			);
		});

	store
		.command("migrate")
		.description(
			"Copy your Brigade data between storage backends.\n" +
				"  Examples:\n" +
				"    brigade store migrate --to convex --convex-url http://127.0.0.1:3210\n" +
				"    brigade store migrate --to filesystem\n" +
				"    brigade store migrate --to convex --dry-run\n",
		)
		.requiredOption("--to <mode>", "destination mode: filesystem | convex")
		.option("--convex-url <url>", "deployment URL (used when migrating to/from convex)")
		.option("--dry-run", "report what would be copied without writing", false)
		.option("--skip-verify", "skip sha256 verification (faster, less safe)", false)
		.option("--json", "emit JSON instead of human-readable text", false)
		.action(
			async (opts: {
				to: string;
				convexUrl?: string;
				dryRun?: boolean;
				skipVerify?: boolean;
				json?: boolean;
			}) => {
				process.exit(
					await runStoreMigrateCmd({
						to: opts.to,
						...(opts.convexUrl !== undefined ? { convexUrl: opts.convexUrl } : {}),
						...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
						...(opts.skipVerify !== undefined ? { skipVerify: opts.skipVerify } : {}),
						...(opts.json !== undefined ? { json: opts.json } : {}),
					}),
				);
			},
		);
}
