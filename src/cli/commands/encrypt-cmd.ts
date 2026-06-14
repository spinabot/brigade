// src/cli/commands/encrypt-cmd.ts
//
// `brigade encrypt` — operator-facing surface for at-rest encryption.
//
//   brigade encrypt status     — check whether a key is configured + round-trip
//   brigade encrypt init       — generate a fresh 32-byte hex key (just prints)
//   brigade encrypt test       — encrypt+decrypt a sample string

import chalk from "chalk";
import type { Command } from "commander";

import {
	encryptionStatus,
	generateMasterKeyHex,
	openToString,
	sealString,
	isEncryptionEnabled,
} from "../../storage/encryption.js";

export async function runEncryptStatus(opts: { json?: boolean } = {}): Promise<number> {
	const status = encryptionStatus();
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: !status.error, status }, null, 2)}\n`);
		return status.error ? 1 : 0;
	}
	if (!status.enabled) {
		process.stdout.write(`${chalk.dim("Brigade at-rest encryption:")} ${chalk.bold("OFF")}\n`);
		process.stdout.write(
			chalk.dim(
				`  No key in the environment and no key file on this computer.\n` +
					`  Onboarding in convex mode creates one automatically, or generate one\n` +
					`  yourself with: ${chalk.bold("brigade encrypt init")}\n`,
			),
		);
		return 0;
	}
	if (status.error) {
		process.stdout.write(`${chalk.red("✗")} encryption configured but ${status.error}\n`);
		return 1;
	}
	process.stdout.write(`${chalk.green("✓")} Brigade at-rest encryption: ${chalk.bold("ON")}\n`);
	process.stdout.write(chalk.dim(`  Algorithm:    ${status.algorithm}\n`));
	process.stdout.write(chalk.dim(`  Fingerprint:  ${status.primaryKeyFingerprint}\n`));
	process.stdout.write(
		chalk.dim(
			`  Key source:   ${status.source === "env" ? "environment variable" : "key file on this computer"}\n`,
		),
	);
	if (status.hasOldKey) {
		process.stdout.write(chalk.dim(`  Old key:      present (key rotation in progress)\n`));
	}
	return 0;
}

export async function runEncryptInit(opts: { json?: boolean } = {}): Promise<number> {
	const hex = generateMasterKeyHex();
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, key: hex }, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(`${chalk.green("✓")} Generated a fresh master encryption key.\n\n`);
	process.stdout.write(`  ${chalk.bold(hex)}\n\n`);
	process.stdout.write(chalk.dim(`Activate it by setting BRIGADE_ENCRYPTION_KEY in your environment:\n\n`));
	if (process.platform === "win32") {
		process.stdout.write(`  ${chalk.bold(`$env:BRIGADE_ENCRYPTION_KEY = "${hex}"`)}   (PowerShell)\n`);
	} else {
		process.stdout.write(`  ${chalk.bold(`export BRIGADE_ENCRYPTION_KEY=${hex}`)}\n`);
	}
	process.stdout.write(chalk.dim(
		`\nKeep this key safe. Without it you can't decrypt your existing Convex data.\n` +
			`We do NOT save it to disk. Add it to your password manager / 1Password / Vault.\n` +
			`Rotate later with: BRIGADE_ENCRYPTION_KEY_OLD=<current> BRIGADE_ENCRYPTION_KEY=<new>\n`,
	));
	return 0;
}

export async function runEncryptTest(opts: { json?: boolean } = {}): Promise<number> {
	const sample = `brigade-encrypt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	try {
		const sealed = sealString(sample);
		const opened = openToString(sealed);
		const ok = opened === sample;
		const result = {
			ok,
			encryptionEnabled: isEncryptionEnabled(),
			sampleBytes: sealed.byteLength,
			roundTrip: ok,
		};
		if (opts.json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			return ok ? 0 : 1;
		}
		if (ok) {
			process.stdout.write(`${chalk.green("✓")} encryption round-trip succeeded\n`);
			process.stdout.write(
				chalk.dim(
					`  Mode:         ${result.encryptionEnabled ? "encrypted" : "passthrough (no key set)"}\n` +
						`  Sample bytes: ${result.sampleBytes}\n`,
				),
			);
		} else {
			process.stdout.write(`${chalk.red("✗")} round-trip MISMATCH — your data may be corrupt\n`);
		}
		return ok ? 0 : 1;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
		} else {
			process.stdout.write(`${chalk.red("✗")} ${msg}\n`);
		}
		return 1;
	}
}

export function registerEncryptCommand(program: Command): void {
	const enc = program
		.command("encrypt")
		.description("Manage Brigade's at-rest encryption key (AES-256-GCM)");

	enc
		.command("status")
		.description("Report whether the encryption key is configured + run a self-check")
		.option("--json", "emit JSON instead of human text", false)
		.action(async (opts: { json?: boolean }) => {
			process.exit(await runEncryptStatus(opts));
		});

	enc
		.command("init")
		.description("Generate a fresh 32-byte master key (prints to stdout; YOU save it securely)")
		.option("--json", "emit JSON instead of human text", false)
		.action(async (opts: { json?: boolean }) => {
			process.exit(await runEncryptInit(opts));
		});

	enc
		.command("test")
		.description("Round-trip a sample string through seal/open to confirm the key is good")
		.option("--json", "emit JSON instead of human text", false)
		.action(async (opts: { json?: boolean }) => {
			process.exit(await runEncryptTest(opts));
		});
}
