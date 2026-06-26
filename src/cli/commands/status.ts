/**
 * `brigade status` — runtime snapshot. Brigade-sized: 5 sections, no
 * plugin compatibility, no pairing recovery, no security audit (those
 * Phase-2/3 surfaces don't exist here yet).
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

import { FileMemoryStore } from "../../agents/memory/storage.js";
import { FactStore } from "../../agents/memory/records.js";
import { discoverEligibleSkills } from "../../agents/skills/index.js";
import { readConfigOrInit } from "../../config/io.js";
import { DEFAULT_AGENT_ID, resolveAuthProfilesPath, resolveSessionsDir } from "../../config/paths.js";
import { BRIGADE_DIR, getBrigadeWorkspaceDir, loadConfig } from "../../core/config.js";
import { resolveClientToken } from "../../core/gateway-auth.js";
import { getLastLoggedError, getTodayLogPath } from "../../core/event-logger.js";
import { readApprovalsSummary } from "../../core/exec-approvals.js";
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
	memory: {
		fileCount: number;
		totalBytes: number;
		factCount: number;
		embedder: string;
	};
	skills: {
		count: number;
	};
	execApprovals: {
		filePath: string;
		fileExists: boolean;
		commandCount: number;
		patternCount: number;
		error?: string;
	};
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
	lastError?: { ts: string; message: string; type?: string };
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

	const memoryStatus = await new FileMemoryStore(getBrigadeWorkspaceDir())
		.status()
		.catch(() => ({ fileCount: 0, totalBytes: 0 }));
	let factCount = 0;
	try {
		factCount = new FactStore(getBrigadeWorkspaceDir()).list().length;
	} catch {
		/* no fact store yet */
	}

	let skillCount = 0;
	try {
		skillCount = discoverEligibleSkills({
			workspaceDir: getBrigadeWorkspaceDir(),
			config: readConfigOrInit(),
		}).skills.length;
	} catch {
		/* no skills yet */
	}

	const execApprovals = readApprovalsSummary();

	const probe = await probeGateway({ host: opts.host, port: opts.port, token: resolveClientToken(readConfigOrInit().gateway?.auth) });

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
		memory: { fileCount: memoryStatus.fileCount, totalBytes: memoryStatus.totalBytes, factCount, embedder: process.env.BRIGADE_MEMORY_EMBEDDER ?? "model-free" },
		skills: { count: skillCount },
		execApprovals,
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
		lastError: getLastLoggedError(),
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

/**
 * Formats the memory embedder label for display.
 * The CLI reads the configured intent (BRIGADE_MEMORY_EMBEDDER env) but
 * cannot observe the gateway's resolved state. When a non-default value is
 * configured, note that the gateway resolves it at runtime and may fall back
 * to model-free HRR if the required key or dependency is absent.
 */
function formatEmbedderLabel(embedder: string): string {
	if (embedder === "model-free") {
		return "model-free";
	}
	return `${embedder} ${chalk.dim("(configured; gateway resolves — may run model-free if key or dep is missing)")}`;
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
	lines.push(chalk.dim("Memory"));
	if (r.memory.fileCount === 0 && r.memory.factCount === 0) {
		lines.push(`  stored:        ${chalk.dim("none yet (fills in as the agent learns)")}`);
	} else {
		const kb = (r.memory.totalBytes / 1024).toFixed(1);
		lines.push(`  notes:         ${r.memory.fileCount} file${r.memory.fileCount === 1 ? "" : "s"}, ${kb} KB`);
		lines.push(`  facts:         ${r.memory.factCount} across all origins (recall is owner-scoped)`);
	}
	lines.push(`  embedder:      ${formatEmbedderLabel(r.memory.embedder)}`);
	lines.push("");
	lines.push(chalk.dim("Skills"));
	if (r.skills.count === 0) {
		lines.push(`  available:     ${chalk.dim("none yet (drop a folder in workspace/skills/)")}`);
	} else {
		lines.push(`  available:     ${r.skills.count} skill${r.skills.count === 1 ? "" : "s"}`);
	}
	lines.push("");
	lines.push(chalk.dim("Exec gating"));
	if (r.execApprovals.error) {
		// Schema-version mismatch or unreadable file. Surface RED so the
		// operator can't miss it — the gate refuses every bash call while
		// the file is in this state.
		lines.push(`  approvals:     ${chalk.red("ERROR")} ${chalk.dim("(gate refuses every bash call)")}`);
		lines.push(`  reason:        ${chalk.red(r.execApprovals.error)}`);
		lines.push(`  file:          ${path.relative(r.brigadeDir, r.execApprovals.filePath) || r.execApprovals.filePath}`);
	} else if (!r.execApprovals.fileExists) {
		lines.push(`  approvals:     ${chalk.yellow("none yet")} ${chalk.dim("(bash refused until approved)")}`);
		lines.push(`  hint:          ${chalk.dim('run `brigade exec allow "<cmd>"` to approve a command')}`);
	} else {
		const total = r.execApprovals.commandCount + r.execApprovals.patternCount;
		if (total === 0) {
			lines.push(`  approvals:     ${chalk.yellow("0 (file exists but empty)")}`);
		} else {
			const parts: string[] = [];
			if (r.execApprovals.commandCount > 0) {
				parts.push(`${r.execApprovals.commandCount} command${r.execApprovals.commandCount === 1 ? "" : "s"}`);
			}
			if (r.execApprovals.patternCount > 0) {
				parts.push(`${r.execApprovals.patternCount} pattern${r.execApprovals.patternCount === 1 ? "" : "s"}`);
			}
			lines.push(`  approvals:     ${parts.join(", ")}`);
		}
		lines.push(`  file:          ${path.relative(r.brigadeDir, r.execApprovals.filePath) || r.execApprovals.filePath}`);
	}
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
		// Actionable next-step hint — helps the user know what to do
		// instead of staring at a bare error.
		lines.push(`  hint:          ${chalk.dim("run `brigade gateway` to start it, or `brigade doctor` for a full health check.")}`);
	}
	lines.push("");
	lines.push(chalk.dim("Logs"));
	lines.push(`  today:         ${r.logPath}`);
	// Surface the most-recent error from today's log so operators can
	// diagnose failures without `tail -f`. Only shown when an error
	// exists — keeps the happy-path output clean.
	if (r.lastError) {
		const ts = r.lastError.ts ? new Date(r.lastError.ts).toLocaleTimeString() : "";
		const tsStr = ts ? `${chalk.dim(ts)} ` : "";
		lines.push(`  last error:    ${tsStr}${chalk.red(r.lastError.message)}`);
	}
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
