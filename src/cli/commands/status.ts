/**
 * `brigade status` — runtime snapshot. Mirrors openclaw's `openclaw status`
 * but Brigade-sized: 5 sections instead of 9, no plugin compatibility, no
 * pairing recovery, no security audit (those Phase-2/3 surfaces don't exist
 * here yet).
 *
 * Reports:
 *   - Configured provider/model + workspace dir
 *   - Auth: how many provider profiles are present, where the file lives
 *   - Sessions: count of session files under ~/.brigade/agents/<id>/sessions/
 *   - Gateway: probe ws://127.0.0.1:7777 (or --host/--port), report state
 *   - Last log path
 *
 * --json emits the same data as a single object; useful for shell scripts.
 *
 * Standalone — does NOT require the gateway to be up. The gateway probe is
 * a best-effort optional check.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import { DEFAULT_AGENT_ID, resolveAuthProfilesPath, resolveSessionsDir } from "../../config/paths.js";
import { BRIGADE_DIR, getBrigadeWorkspaceDir, loadConfig } from "../../core/config.js";
import { getTodayLogPath } from "../../core/event-logger.js";
import { probeGateway } from "../../core/gateway-probe.js";

export interface StatusCommandOptions {
	host?: string;
	port?: number;
	json?: boolean;
}

interface StatusReport {
	provider: string | undefined;
	modelId: string | undefined;
	workspaceDir: string;
	brigadeDir: string;
	authProfilesPath: string;
	authProfileCount: number;
	authProfileProviders: string[];
	sessionsDir: string;
	sessionCount: number;
	gateway: {
		url: string;
		reachable: boolean;
		error?: string;
		provider?: string;
		modelId?: string;
		isAgentRunning?: boolean;
		messageCount?: number;
	};
	logPath: string;
}

export async function runStatusCommand(opts: StatusCommandOptions = {}): Promise<void> {
	const report = await collectStatusReport(opts);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}
	process.stdout.write(formatStatusText(report));
}

async function collectStatusReport(opts: StatusCommandOptions): Promise<StatusReport> {
	const config = await loadConfig();
	const wizardDefaults = (config.agents as { defaults?: { provider?: string; model?: { primary?: string } } } | undefined)?.defaults;
	const provider = wizardDefaults?.provider;
	const modelId = wizardDefaults?.model?.primary;

	const authProfilesPath = resolveAuthProfilesPath(DEFAULT_AGENT_ID);
	const { count: authProfileCount, providers: authProfileProviders } = readAuthProfileSummary(authProfilesPath);

	const sessionsDir = resolveSessionsDir(DEFAULT_AGENT_ID);
	const sessionCount = countSessionFiles(sessionsDir);

	const probe = await probeGateway({ host: opts.host, port: opts.port });

	return {
		provider,
		modelId,
		workspaceDir: getBrigadeWorkspaceDir(),
		brigadeDir: BRIGADE_DIR,
		authProfilesPath,
		authProfileCount,
		authProfileProviders,
		sessionsDir,
		sessionCount,
		gateway: {
			url: probe.url,
			reachable: probe.reachable,
			error: probe.error,
			provider: probe.state?.provider,
			modelId: probe.state?.modelId,
			isAgentRunning: probe.state?.isAgentRunning,
			messageCount: probe.state?.messageCount,
		},
		logPath: getTodayLogPath(),
	};
}

function readAuthProfileSummary(profilesPath: string): { count: number; providers: string[] } {
	if (!fs.existsSync(profilesPath)) return { count: 0, providers: [] };
	try {
		const parsed = JSON.parse(fs.readFileSync(profilesPath, "utf8")) as {
			profiles?: Record<string, { provider?: string }>;
		};
		const list = Object.values(parsed.profiles ?? {})
			.map((p) => p?.provider)
			.filter((p): p is string => typeof p === "string" && p.length > 0);
		// De-dupe — multiple aliases per provider count as one provider for status purposes.
		const providers = Array.from(new Set(list)).sort();
		return { count: list.length, providers };
	} catch {
		return { count: 0, providers: [] };
	}
}

function countSessionFiles(sessionsDir: string): number {
	try {
		return fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl")).length;
	} catch {
		return 0;
	}
}

function formatStatusText(r: StatusReport): string {
	const lines: string[] = [];
	lines.push(chalk.bold("brigade status"));
	lines.push("");
	lines.push(chalk.dim("Configuration"));
	lines.push(`  provider:      ${r.provider ?? chalk.yellow("(not set — run `brigade onboard`)")}`);
	lines.push(`  model:         ${r.modelId ?? chalk.yellow("(not set)")}`);
	lines.push(`  workspace:     ${r.workspaceDir}`);
	lines.push(`  brigade dir:   ${r.brigadeDir}`);
	lines.push("");
	lines.push(chalk.dim("Auth"));
	if (r.authProfileCount === 0) {
		lines.push(`  profiles:      ${chalk.yellow("none")}`);
	} else {
		lines.push(`  profiles:      ${r.authProfileCount} (${r.authProfileProviders.join(", ")})`);
	}
	lines.push(`  store:         ${path.relative(r.brigadeDir, r.authProfilesPath) || r.authProfilesPath}`);
	lines.push("");
	lines.push(chalk.dim("Sessions"));
	lines.push(`  count:         ${r.sessionCount}`);
	lines.push(`  dir:           ${path.relative(r.brigadeDir, r.sessionsDir) || r.sessionsDir}`);
	lines.push("");
	lines.push(chalk.dim("Gateway"));
	if (r.gateway.reachable) {
		lines.push(`  status:        ${chalk.green("reachable")} at ${r.gateway.url}`);
		if (r.gateway.provider && r.gateway.modelId) {
			lines.push(`  active model:  ${r.gateway.provider}/${r.gateway.modelId}`);
		}
		if (typeof r.gateway.isAgentRunning === "boolean") {
			lines.push(`  agent:         ${r.gateway.isAgentRunning ? chalk.yellow("running") : "idle"}`);
		}
		if (typeof r.gateway.messageCount === "number") {
			lines.push(`  messages:      ${r.gateway.messageCount}`);
		}
	} else {
		lines.push(`  status:        ${chalk.dim("not running")} (${r.gateway.url})`);
		if (r.gateway.error) {
			lines.push(`  reason:        ${chalk.dim(r.gateway.error)}`);
		}
	}
	lines.push("");
	lines.push(chalk.dim("Logs"));
	lines.push(`  today:         ${r.logPath}`);
	lines.push("");
	return lines.join("\n");
}

export function registerStatusCommand(program: Command): void {
	program
		.command("status")
		.description("Print a snapshot of Brigade configuration, sessions, and gateway state")
		.option("-h, --host <host>", "gateway host to probe (default: 127.0.0.1)")
		.option("-p, --port <port>", "gateway port to probe (default: 7777)", (v) => parseInt(v, 10))
		.option("--json", "emit JSON instead of human-readable text", false)
		.action(async (opts: { host?: string; port?: number; json?: boolean }) => {
			await runStatusCommand({ host: opts.host, port: opts.port, json: opts.json });
		});
}
