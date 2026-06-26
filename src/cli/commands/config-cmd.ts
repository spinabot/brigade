/**
 * `brigade config <list|get|set|unset|file|schema|validate>` — config CRUD
 * over brigade.json.
 *
 * The path parsing, nested get/set/delete, value parsing, and secret redaction
 * all live in `core/config-ops.ts` — SHARED with the `config.*` gateway RPCs so
 * the CLI and a remote client mutate config (and redact secrets) identically.
 * This file is the thin CLI shell: arg handling + stdout/exit-code formatting.
 *
 *   - Dot-notation paths (+ escaped dots + bracket indices/keys).
 *   - JSON5 parsing for `set` values when --strict-json is off, raw-string fallback.
 *   - Atomic write + .bak rotation inherited from `saveConfig`.
 *   - Secrets redaction in `list`/`get`: any segment matching
 *     /^(key|apiKey|token|password|secret|...)$/i renders as `__BRIGADE_REDACTED__`.
 *
 * On-disk path: `~/.brigade/brigade.json` (resolved via BRIGADE_DIR).
 */

import * as path from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import {
	BrigadeConfigSchema,
	BRIGADE_CONFIG_FILENAME,
	collectBrigadeConfigErrors,
} from "../../core/brigade-config.js";
import { BRIGADE_DIR, loadConfig, saveConfig } from "../../core/config.js";
import {
	deleteNested,
	getNested,
	parseConfigValue,
	parsePath,
	redactDeep,
	setNested,
} from "../../core/config-ops.js";

export interface ConfigGetOptions {
	json?: boolean;
}
export interface ConfigSetOptions {
	json?: boolean;
	strictJson?: boolean;
	dryRun?: boolean;
}
export interface ConfigListOptions {
	json?: boolean;
	noRedact?: boolean;
}

/* ───────────────────────── runtime ───────────────────────────── */

export async function runConfigGet(rawPath: string, opts: ConfigGetOptions = {}): Promise<number> {
	const cfg = loadConfig() as Record<string, unknown>;
	const segments = parsePath(rawPath);
	const value = getNested(cfg, segments);
	if (value === undefined) {
		process.stderr.write(`brigade config: key "${rawPath}" not found\n`);
		process.stderr.write(
			`${chalk.dim("  hint: run `brigade config list` to see all keys, or `brigade config schema` for the shape.")}\n`,
		);
		return 1;
	}
	const redacted = redactDeep(value);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
	} else if (typeof redacted === "string" || typeof redacted === "number" || typeof redacted === "boolean") {
		process.stdout.write(`${redacted}\n`);
	} else {
		process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
	}
	return 0;
}

export async function runConfigSet(rawPath: string, rawValue: string, opts: ConfigSetOptions = {}): Promise<number> {
	const cfg = loadConfig() as Record<string, unknown>;
	const segments = parsePath(rawPath);
	let parsed: unknown;
	try {
		parsed = parseConfigValue(rawValue, { strictJson: opts.strictJson });
	} catch (err) {
		process.stderr.write(`brigade config: failed to parse value: ${(err as Error).message}\n`);
		process.stderr.write(
			`${chalk.dim("  hint: wrap strings in quotes (e.g. \\\"my value\\\"), or use --strict-json for arrays/objects.")}\n`,
		);
		return 1;
	}
	setNested(cfg as unknown as Record<string, unknown>, segments, parsed);
	if (opts.dryRun) {
		const preview = redactDeep(getNested(cfg, segments));
		process.stdout.write(
			`${chalk.dim("(dry-run, not written)")} ${rawPath} = ${JSON.stringify(preview)}\n`,
		);
		return 0;
	}
	saveConfig(cfg as never);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, path: rawPath, value: redactDeep(parsed) }, null, 2)}\n`);
	} else {
		process.stdout.write(
			`${chalk.green("set")} ${rawPath} = ${JSON.stringify(redactDeep(parsed))}\n`,
		);
	}
	return 0;
}

export async function runConfigUnset(rawPath: string, opts: { json?: boolean } = {}): Promise<number> {
	const cfg = loadConfig() as Record<string, unknown>;
	const segments = parsePath(rawPath);
	const removed = deleteNested(cfg as unknown as Record<string, unknown>, segments);
	if (!removed) {
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, path: rawPath, reason: "not found" })}\n`);
		} else {
			process.stderr.write(`brigade config: key "${rawPath}" not found\n`);
			process.stderr.write(
				`${chalk.dim("  hint: run `brigade config list` to see all keys.")}\n`,
			);
		}
		return 1;
	}
	saveConfig(cfg as never);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, path: rawPath })}\n`);
	} else {
		process.stdout.write(`${chalk.yellow("unset")} ${rawPath}\n`);
	}
	return 0;
}

export async function runConfigList(opts: ConfigListOptions = {}): Promise<number> {
	const cfg = loadConfig() as Record<string, unknown>;
	const view = opts.noRedact ? cfg : redactDeep(cfg);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
	} else {
		process.stdout.write(`${chalk.dim(`# ${path.join(BRIGADE_DIR, BRIGADE_CONFIG_FILENAME)}`)}\n`);
		process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
	}
	return 0;
}

export async function runConfigFile(opts: { json?: boolean } = {}): Promise<number> {
	const filePath = path.join(BRIGADE_DIR, BRIGADE_CONFIG_FILENAME);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ path: filePath })}\n`);
	} else {
		process.stdout.write(`${filePath}\n`);
	}
	return 0;
}

/**
 * Print the brigade.json TypeBox schema as JSON — useful for IDE /
 * external-tool autocompletion against the live shape.
 */
export async function runConfigSchema(_opts: {} = {}): Promise<number> {
	process.stdout.write(`${JSON.stringify(BrigadeConfigSchema, null, 2)}\n`);
	return 0;
}

/**
 * Validate the on-disk brigade.json against the TypeBox schema. Reports a
 * pass/fail line plus per-issue path + message when invalid.
 *
 * Exit codes: 0 — valid (or absent); 1 — invalid (issues listed).
 */
export async function runConfigValidate(opts: { json?: boolean } = {}): Promise<number> {
	const filePath = path.join(BRIGADE_DIR, BRIGADE_CONFIG_FILENAME);
	let cfg: unknown;
	try {
		cfg = loadConfig();
	} catch (err) {
		const message = (err as Error).message;
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ valid: false, path: filePath, error: message }, null, 2)}\n`);
		} else {
			process.stderr.write(`${chalk.red("✗")} couldn't read ${filePath}: ${message}\n`);
		}
		return 1;
	}

	const issues = collectBrigadeConfigErrors(cfg);

	if (issues.length === 0) {
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ valid: true, path: filePath }, null, 2)}\n`);
		} else {
			process.stdout.write(`${chalk.green("✓")} valid: ${filePath}\n`);
		}
		return 0;
	}

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ valid: false, path: filePath, issues }, null, 2)}\n`,
		);
	} else {
		process.stderr.write(`${chalk.red("✗")} ${issues.length} issue${issues.length === 1 ? "" : "s"} in ${filePath}:\n`);
		for (const issue of issues) {
			const where = issue.path || "(root)";
			process.stderr.write(`  ${chalk.dim("·")} ${chalk.yellow(where)}: ${issue.message}\n`);
		}
		process.stderr.write(`\n${chalk.dim("Tip: run `brigade config get <path>` to inspect a specific field.")}\n`);
	}
	return 1;
}

/* ───────────────────────── registration ──────────────────────── */

export function registerConfigCommand(program: Command): void {
	const cfgCmd = program.command("config").description("Read or modify brigade.json");

	cfgCmd
		.command("list")
		.description("Print the full config (secrets redacted)")
		.option("--json", "emit JSON only (no header)", false)
		.option("--no-redact", "show raw values including secrets (use carefully)", false)
		.action(async (opts: { json?: boolean; redact?: boolean }) => {
			const code = await runConfigList({ json: opts.json, noRedact: opts.redact === false });
			process.exit(code);
		});

	cfgCmd
		.command("get <path>")
		.description("Read a value by dot-notation key (e.g. agents.defaults.provider)")
		.option("--json", "emit JSON instead of bare-string output", false)
		.action(async (rawPath: string, opts: { json?: boolean }) => {
			const code = await runConfigGet(rawPath, { json: opts.json });
			process.exit(code);
		});

	cfgCmd
		.command("set <path> <value>")
		.description("Write a value (JSON5-parsed by default; falls back to string)")
		.option("--strict-json", "require strict JSON syntax for the value", false)
		.option("--dry-run", "show what would be written without persisting", false)
		.option("--json", "emit JSON status instead of human text", false)
		.action(async (rawPath: string, rawValue: string, opts: { strictJson?: boolean; dryRun?: boolean; json?: boolean }) => {
			const code = await runConfigSet(rawPath, rawValue, {
				strictJson: opts.strictJson,
				dryRun: opts.dryRun,
				json: opts.json,
			});
			process.exit(code);
		});

	cfgCmd
		.command("unset <path>")
		.description("Remove a key by dot-notation path")
		.option("--json", "emit JSON status instead of human text", false)
		.action(async (rawPath: string, opts: { json?: boolean }) => {
			const code = await runConfigUnset(rawPath, { json: opts.json });
			process.exit(code);
		});

	cfgCmd
		.command("file")
		.description("Print the absolute path to brigade.json")
		.option("--json", "emit JSON instead of bare-path output", false)
		.action(async (opts: { json?: boolean }) => {
			const code = await runConfigFile({ json: opts.json });
			process.exit(code);
		});
}
