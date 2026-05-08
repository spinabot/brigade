/**
 * `brigade doctor` — health checks. Brigade-sized port of openclaw's
 * `openclaw doctor` (`src/flows/doctor-health.ts`). Openclaw runs 26 checks
 * across plugins, daemons, OAuth, sandboxes, browser MCP, etc. — Brigade has
 * none of that surface yet, so the doctor here covers exactly what Brigade
 * has built: node, dirs, config, providers, workspace, log sink, gateway.
 *
 * Each check returns `{ status, message }` where status is "ok" | "warn" |
 * "fail". The runner prints them with color-coded glyphs and exits 0 — even
 * when there are warnings — to mirror openclaw's exit semantics
 * (`register.maintenance.ts:39 — exit(0)` regardless). `brigade doctor`
 * REPORTS, it doesn't gate. `brigade doctor --strict` flips that: any
 * warn/fail becomes a non-zero exit so CI / supervisor scripts can fail
 * fast.
 *
 * No --repair / --fix flags (yet). Brigade's surface is small enough that
 * each problem has a one-line "run X to fix" hint embedded in the message.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import {
	DEFAULT_AGENT_ID,
	resolveAgentWorkspaceDir,
	resolveAuthProfilesPath,
	resolveSessionsDir,
} from "../../config/paths.js";
import { BRIGADE_DIR, loadConfig } from "../../core/config.js";
import { loadBrigadeAuthStorage } from "../../core/auth-bridge.js";
import { getTodayLogPath } from "../../core/event-logger.js";
import { probeGateway, readPidFile, isProcessAlive } from "../../core/gateway-probe.js";
import { findProvider, PROVIDERS } from "../../providers/catalog.js";

export interface DoctorCommandOptions {
	json?: boolean;
	strict?: boolean;
	host?: string;
	port?: number;
}

type CheckStatus = "ok" | "warn" | "fail";

interface CheckResult {
	name: string;
	status: CheckStatus;
	message: string;
	hint?: string;
}

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 12;

export async function runDoctorCommand(opts: DoctorCommandOptions = {}): Promise<number> {
	const checks: CheckResult[] = [];
	checks.push(checkNodeVersion());
	checks.push(checkBrigadeDir());
	checks.push(await checkBrigadeConfig());
	checks.push(checkAuthProfiles());
	checks.push(checkConfiguredProvider(await safeLoadConfig()));
	checks.push(checkWorkspace());
	checks.push(checkLogDirWritable());
	checks.push(await checkGateway(opts));

	if (opts.json) {
		const failed = checks.filter((c) => c.status === "fail").length;
		const warned = checks.filter((c) => c.status === "warn").length;
		process.stdout.write(
			`${JSON.stringify({ ok: failed === 0 && (!opts.strict || warned === 0), checks }, null, 2)}\n`,
		);
	} else {
		printChecksText(checks);
	}

	const failed = checks.some((c) => c.status === "fail");
	const warned = checks.some((c) => c.status === "warn");
	if (failed) return 1;
	if (warned && opts.strict) return 1;
	return 0;
}

function checkNodeVersion(): CheckResult {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(process.versions.node);
	if (!m) {
		return { name: "node version", status: "warn", message: `unrecognised version string: ${process.versions.node}` };
	}
	const major = Number(m[1]);
	const minor = Number(m[2]);
	if (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)) {
		return { name: "node version", status: "ok", message: `Node ${process.versions.node}` };
	}
	return {
		name: "node version",
		status: "fail",
		message: `Node ${process.versions.node} is below the required ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`,
		hint: `nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`,
	};
}

function checkBrigadeDir(): CheckResult {
	if (!fs.existsSync(BRIGADE_DIR)) {
		return {
			name: "brigade dir",
			status: "warn",
			message: `${BRIGADE_DIR} doesn't exist yet`,
			hint: "run `brigade onboard` to create it",
		};
	}
	try {
		fs.accessSync(BRIGADE_DIR, fs.constants.R_OK | fs.constants.W_OK);
		return { name: "brigade dir", status: "ok", message: BRIGADE_DIR };
	} catch (err) {
		return {
			name: "brigade dir",
			status: "fail",
			message: `${BRIGADE_DIR} is not readable/writable: ${(err as Error).message}`,
		};
	}
}

async function checkBrigadeConfig(): Promise<CheckResult> {
	try {
		await loadConfig();
		return { name: "brigade.json", status: "ok", message: "parses cleanly" };
	} catch (err) {
		return {
			name: "brigade.json",
			status: "fail",
			message: `failed to load: ${(err as Error).message}`,
			hint: "inspect ~/.brigade/brigade.json or restore from ~/.brigade/brigade.json.bak.*",
		};
	}
}

function checkAuthProfiles(): CheckResult {
	const profilesPath = resolveAuthProfilesPath(DEFAULT_AGENT_ID);
	if (!fs.existsSync(profilesPath)) {
		return {
			name: "auth profiles",
			status: "warn",
			message: "no profiles file yet",
			hint: "run `brigade onboard` to add an API key",
		};
	}
	try {
		const parsed = JSON.parse(fs.readFileSync(profilesPath, "utf8")) as {
			profiles?: Record<string, unknown>;
		};
		const count = Object.keys(parsed.profiles ?? {}).length;
		if (count === 0) {
			return {
				name: "auth profiles",
				status: "warn",
				message: "profiles file exists but is empty",
				hint: "run `brigade onboard` to add an API key",
			};
		}
		return { name: "auth profiles", status: "ok", message: `${count} profile${count === 1 ? "" : "s"}` };
	} catch (err) {
		return {
			name: "auth profiles",
			status: "fail",
			message: `failed to parse: ${(err as Error).message}`,
		};
	}
}

function checkConfiguredProvider(config: Awaited<ReturnType<typeof loadConfig>> | undefined): CheckResult {
	if (!config) {
		return { name: "default provider", status: "warn", message: "no config to read" };
	}
	const wizardDefaults = (config.agents as { defaults?: { provider?: string; model?: { primary?: string } } } | undefined)?.defaults;
	const provider = wizardDefaults?.provider;
	const modelId = wizardDefaults?.model?.primary;
	if (!provider || !modelId) {
		return {
			name: "default provider",
			status: "warn",
			message: "no default provider/model selected",
			hint: "run `brigade onboard`",
		};
	}
	const info = findProvider(provider);
	if (!info) {
		const known = PROVIDERS.map((p) => p.id).join(", ");
		return {
			name: "default provider",
			status: "warn",
			message: `provider "${provider}" not in built-in catalog (${known})`,
			hint: "may be a custom provider — verify ~/.brigade/models.json",
		};
	}
	if (info.noAuth) {
		return {
			name: "default provider",
			status: "ok",
			message: `${provider}/${modelId} (local — no auth required)`,
		};
	}
	// Read auth and check the configured provider has a usable key.
	const storage = loadBrigadeAuthStorage() as { getApiKey?: (id: string) => Promise<string | undefined> };
	if (typeof storage.getApiKey === "function") {
		// Best-effort sync-ish probe: schedule but don't block doctor on the
		// promise. Instead inline-resolve the env var directly — same logic
		// the auth-bridge applies, kept inline so the check stays sync-shaped.
		if (info.envVar && process.env[info.envVar]) {
			return {
				name: "default provider",
				status: "ok",
				message: `${provider}/${modelId} (env-backed key from ${info.envVar})`,
			};
		}
	}
	const profilesPath = resolveAuthProfilesPath(DEFAULT_AGENT_ID);
	if (fs.existsSync(profilesPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(profilesPath, "utf8")) as {
				profiles?: Record<string, { provider?: string; key?: string }>;
			};
			const hasKey = Object.values(parsed.profiles ?? {}).some(
				(p) => p?.provider === provider && typeof p.key === "string" && p.key.length > 0,
			);
			if (hasKey) {
				return { name: "default provider", status: "ok", message: `${provider}/${modelId}` };
			}
		} catch {
			// fall through
		}
	}
	return {
		name: "default provider",
		status: "warn",
		message: `${provider}/${modelId} but no API key found`,
		hint: info.envVar ? `export ${info.envVar}=... or run \`brigade onboard\`` : "run `brigade onboard`",
	};
}

function checkWorkspace(): CheckResult {
	const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
	if (!fs.existsSync(workspaceDir)) {
		return {
			name: "workspace",
			status: "warn",
			message: `${workspaceDir} doesn't exist yet`,
			hint: "run `brigade onboard` (or any subcommand) to seed it",
		};
	}
	const expected = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "USER.md", "BOOTSTRAP.md", "HEARTBEAT.md"];
	const missing = expected.filter((name) => !fs.existsSync(path.join(workspaceDir, name)));
	if (missing.length === expected.length) {
		return {
			name: "workspace",
			status: "warn",
			message: `${workspaceDir} exists but no persona files`,
			hint: "run `brigade onboard` to scaffold the workspace",
		};
	}
	if (missing.length > 0) {
		return {
			name: "workspace",
			status: "warn",
			message: `${expected.length - missing.length}/${expected.length} persona files present (missing: ${missing.join(", ")})`,
		};
	}
	const sessionsDir = resolveSessionsDir(DEFAULT_AGENT_ID);
	const sessionCount = fs.existsSync(sessionsDir)
		? fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl")).length
		: 0;
	return { name: "workspace", status: "ok", message: `7/7 persona files, ${sessionCount} session(s)` };
}

function checkLogDirWritable(): CheckResult {
	const logPath = getTodayLogPath();
	const logDir = path.dirname(logPath);
	try {
		fs.mkdirSync(logDir, { recursive: true });
		fs.accessSync(logDir, fs.constants.W_OK);
		return { name: "log sink", status: "ok", message: logDir };
	} catch (err) {
		return {
			name: "log sink",
			status: "fail",
			message: `${logDir} not writable: ${(err as Error).message}`,
		};
	}
}

async function checkGateway(opts: DoctorCommandOptions): Promise<CheckResult> {
	const probe = await probeGateway({ host: opts.host, port: opts.port });
	const pid = readPidFile();
	if (probe.reachable) {
		return {
			name: "gateway",
			status: "ok",
			message: `running at ${probe.url}${pid ? ` (pid ${pid})` : ""}`,
		};
	}
	if (pid && isProcessAlive(pid)) {
		return {
			name: "gateway",
			status: "warn",
			message: `pid ${pid} is alive but ${probe.url} is unreachable (${probe.error})`,
			hint: "the daemon may be misconfigured — `brigade gateway stop` then retry",
		};
	}
	if (pid) {
		return {
			name: "gateway",
			status: "warn",
			message: `stale pid file (${pid} no longer running)`,
			hint: "the gateway exited unexpectedly — clear with `brigade gateway stop` or restart",
		};
	}
	return { name: "gateway", status: "ok", message: "not running (this is fine for in-process `brigade`)" };
}

async function safeLoadConfig(): Promise<Awaited<ReturnType<typeof loadConfig>> | undefined> {
	try {
		return await loadConfig();
	} catch {
		return undefined;
	}
}

const GLYPH = {
	ok: chalk.green("✔"),
	warn: chalk.yellow("⚠"),
	fail: chalk.red("✖"),
} as const;

function printChecksText(checks: CheckResult[]): void {
	const lines: string[] = [];
	lines.push(chalk.bold("brigade doctor"));
	lines.push("");
	const nameWidth = Math.max(...checks.map((c) => c.name.length));
	for (const c of checks) {
		const padded = c.name.padEnd(nameWidth, " ");
		lines.push(`  ${GLYPH[c.status]}  ${padded}  ${c.message}`);
		if (c.hint) {
			lines.push(`     ${" ".repeat(nameWidth)}  ${chalk.dim(`→ ${c.hint}`)}`);
		}
	}
	lines.push("");
	const failed = checks.filter((c) => c.status === "fail").length;
	const warned = checks.filter((c) => c.status === "warn").length;
	if (failed > 0) {
		lines.push(chalk.red(`${failed} check${failed === 1 ? "" : "s"} failed.`));
	} else if (warned > 0) {
		lines.push(chalk.yellow(`${warned} warning${warned === 1 ? "" : "s"}.`));
	} else {
		lines.push(chalk.green("all checks passed."));
	}
	lines.push("");
	process.stdout.write(lines.join("\n"));
}

export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("Run health checks against ~/.brigade/, providers, workspace, and the gateway")
		.option("-h, --host <host>", "gateway host to probe (default: 127.0.0.1)")
		.option("-p, --port <port>", "gateway port to probe (default: 7777)", (v) => parseInt(v, 10))
		.option("--json", "emit JSON instead of human-readable text", false)
		.option("--strict", "exit non-zero on warnings (CI mode)", false)
		.action(async (opts: { host?: string; port?: number; json?: boolean; strict?: boolean }) => {
			const code = await runDoctorCommand({
				host: opts.host,
				port: opts.port,
				json: opts.json,
				strict: opts.strict,
			});
			process.exit(code);
		});
}
