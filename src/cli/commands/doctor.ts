/**
 * `brigade doctor` — health checks. Brigade-sized: covers exactly what
 * Brigade has built today (node, dirs, config, providers, workspace, log
 * sink, gateway). No plugins / daemons / OAuth / sandboxes / browser MCP
 * surface to check yet.
 *
 * Each check returns `{ status, message }` where status is "ok" | "warn" |
 * "fail". The runner prints them with color-coded glyphs and exits 0 — even
 * when there are warnings — by default: `brigade doctor` REPORTS, it
 * doesn't gate. `brigade doctor --strict` flips that: any warn/fail
 * becomes a non-zero exit so CI / supervisor scripts can fail fast.
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
	resolveSessionsDir,
} from "../../config/paths.js";
import { readProfiles } from "../../auth/profiles.js";
import { detectUnrefreshableSubscriptions } from "../../auth/auth-health.js";
import { isClaudeCliAvailable } from "../../agents/claude-cli/availability.js";
import { hasBrigadeClaudeLogin } from "../../agents/claude-cli/claude-config.js";
import { readClaudeCliLogin } from "../../integrations/cli-login.js";
import { FileMemoryStore } from "../../agents/memory/storage.js";
import { FactStore } from "../../agents/memory/records.js";
import { discoverEligibleSkills } from "../../agents/skills/index.js";
import { probeMediaUnderstanding } from "../../agents/media-understanding/config.js";
import {
	collectChannelSecurityAudit,
	listChannelSecurityAdapters,
} from "../../agents/channels/channel-security-registry.js";
import { readConfigOrInit } from "../../config/io.js";
import { BRIGADE_DIR, loadConfig } from "../../core/config.js";
import { loadBrigadeAuthStorage } from "../../core/auth-bridge.js";
import { getTodayLogPath } from "../../core/event-logger.js";
import { readApprovalsSummary } from "../../core/exec-approvals.js";
import { probeGateway, readPid, isProcessAlive } from "../../core/gateway-probe.js";
import { resolveClientToken } from "../../core/gateway-auth.js";
import { findProvider, PROVIDERS } from "../../providers/catalog.js";
import { readSentinel, sentinelExists } from "../../storage/sentinel.js";

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
	checks.push(checkTlsCaBundle());
	checks.push(checkBrigadeDir());
	checks.push(await checkBrigadeConfig());
	checks.push(checkAuthProfiles());
	checks.push(checkConfiguredProvider(await safeLoadConfig()));
	checks.push(checkSubscriptionRefresh());
	checks.push(checkClaudeCliBackend());
	checks.push(checkWorkspace());
	checks.push(await checkMemory());
	checks.push(checkSkills());
	checks.push(checkMediaUnderstanding());
	checks.push(checkLogDirWritable());
	checks.push(checkExecApprovals());
	checks.push(await checkChannelSecurity(await safeLoadConfig()));
	checks.push(await checkStorageMode());
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

/**
 * Validate operator-set TLS CA-bundle env vars point at readable files. Unset =
 * ok (the system trust store is used). Set-but-unreadable is a corporate-proxy /
 * custom-CA misconfiguration that otherwise surfaces only as an opaque mid-call
 * connection failure — surface it here, actionably, instead.
 */
function checkTlsCaBundle(): CheckResult {
	const vars = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"];
	const set = vars.filter((v) => (process.env[v] ?? "").trim().length > 0);
	if (set.length === 0) {
		return { name: "tls ca bundle", status: "ok", message: "using the system trust store" };
	}
	const unreadable: string[] = [];
	for (const v of set) {
		const p = (process.env[v] ?? "").trim();
		try {
			fs.accessSync(p, fs.constants.R_OK);
		} catch {
			unreadable.push(`${v} → ${p}`);
		}
	}
	if (unreadable.length > 0) {
		return {
			name: "tls ca bundle",
			status: "warn",
			message: `custom CA bundle not readable: ${unreadable.join(", ")}`,
			hint: "point the variable at a readable PEM bundle, or unset it to use the system trust store",
		};
	}
	return { name: "tls ca bundle", status: "ok", message: `${set.join(", ")} → readable` };
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
	// Mode-aware read: in convex mode this returns the boot-primed in-memory
	// profiles cache (auth-profiles.json is never materialised to disk), in
	// filesystem mode it falls through to the same on-disk read as before.
	// Reading the raw file directly would false-warn on a healthy convex
	// deployment and trip `brigade doctor --strict`.
	let file: ReturnType<typeof readProfiles>;
	try {
		file = readProfiles(DEFAULT_AGENT_ID);
	} catch (err) {
		return {
			name: "auth profiles",
			status: "fail",
			message: `failed to parse: ${(err as Error).message}`,
		};
	}
	const count = Object.keys(file.profiles ?? {}).length;
	if (count === 0) {
		return {
			name: "auth profiles",
			status: "warn",
			message: "no profiles yet",
			hint: "run `brigade onboard` to add an API key",
		};
	}
	return { name: "auth profiles", status: "ok", message: `${count} profile${count === 1 ? "" : "s"}` };
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
				message: `${provider}/${modelId} (using a key from your environment)`,
			};
		}
	}
	// Mode-aware read: serves the boot-primed convex profiles cache when the
	// deployment stores the key in convex (auth-profiles.json is never written
	// to disk in convex mode), and reads the same on-disk file in filesystem
	// mode. Reading the raw file directly false-warned "no API key found" on a
	// healthy convex deployment and tripped `brigade doctor --strict`.
	try {
		const file = readProfiles(DEFAULT_AGENT_ID);
		// Plaintext profiles: any non-empty `key` field counts.
		const profile = Object.values(file.profiles ?? {}).find(
			(p) => p?.provider === provider,
		);
		if (profile) {
			// Subscription-login (OAuth) profiles carry an `access` token, not a
			// `key`. Without this branch a healthy `brigade login` deployment would
			// fall through to the "no API key found" warning below and trip
			// `brigade doctor --strict`.
			if (profile.type === "oauth" && typeof profile.access === "string" && profile.access.length > 0) {
				return {
					name: "default provider",
					status: "ok",
					message: `${provider}/${modelId} (subscription login)`,
				};
			}
			// Setup-token profiles (e.g. Anthropic's token flow) carry a `token`.
			if (profile.type === "token" && typeof profile.token === "string" && profile.token.length > 0) {
				return {
					name: "default provider",
					status: "ok",
					message: `${provider}/${modelId} (token)`,
				};
			}
			if (typeof profile.key === "string" && profile.key.length > 0) {
				return { name: "default provider", status: "ok", message: `${provider}/${modelId}` };
			}
			// Ref profiles: resolve the env var the keyRef points at and
			// surface a precise message (helps the user diagnose
			// "I have a profile but the env is unset" without grepping).
			const ref: { source?: string; id?: string } | string | undefined = profile.keyRef;
			if (ref && typeof ref === "object" && ref.source === "env" && ref.id) {
				const envValue = process.env[ref.id];
				if (typeof envValue === "string" && envValue.length > 0) {
					return {
						name: "default provider",
						status: "ok",
						message: `${provider}/${modelId} (the saved credential points at an environment value)`,
					};
				}
				return {
					name: "default provider",
					status: "warn",
					message: `${provider}/${modelId} — the saved credential points at an environment value that isn't set`,
					hint: "set that value in your environment, or run `brigade onboard` to switch the credential shape.",
				};
			}
			if (typeof ref === "string") {
				// Legacy `${VAR}` literal form.
				const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(ref);
				if (m && m[1] && process.env[m[1]]) {
					return {
						name: "default provider",
						status: "ok",
						message: `${provider}/${modelId} (the saved credential points at an environment value)`,
					};
				}
			}
		}
	} catch {
		// fall through
	}
	return {
		name: "default provider",
		status: "warn",
		message: `${provider}/${modelId} but no API key found`,
		hint: info.envVar ? "set a key in your environment, or run `brigade onboard`" : "run `brigade onboard`",
	};
}

/**
 * Subscription-login refresh health — flags a Claude/ChatGPT/Copilot login
 * stored in a form that CAN'T auto-refresh (a bare token, or an `sk-ant-oat`
 * subscription token pasted as a static key, or an OAuth profile with no
 * refresh token). Those silently 401 a day or two after onboarding. The fix is
 * `brigade login`. Mode-aware (reads via the same choke point as everything
 * else), so it never false-warns on a healthy Convex deployment.
 */
function checkSubscriptionRefresh(): CheckResult {
	let list: ReturnType<typeof detectUnrefreshableSubscriptions>;
	try {
		list = detectUnrefreshableSubscriptions(DEFAULT_AGENT_ID);
	} catch (err) {
		return { name: "subscription refresh", status: "ok", message: `could not check: ${(err as Error).message}` };
	}
	if (list.length === 0) {
		return { name: "subscription refresh", status: "ok", message: "subscription logins are refreshable (or none configured)" };
	}
	const names = list.map((c) => c.label).join(", ");
	return {
		name: "subscription refresh",
		status: "warn",
		message: `${names} can't auto-refresh and will eventually 401`,
		hint: "run `brigade login` to replace it with a refreshable credential",
	};
}

function checkClaudeCliBackend(): CheckResult {
	// Reports the claude-cli subscription backend's readiness: binary on PATH +
	// a detectable login. "ok" when both, "warn" (not fail) when partial — the
	// backend is optional, so absence is informational, not an error.
	let installed = false;
	try {
		installed = isClaudeCliAvailable({ force: true });
	} catch {
		installed = false;
	}
	if (!installed) {
		return {
			name: "claude-cli backend",
			status: "ok",
			message: "not installed (optional — run turns on your Claude subscription via the CLI)",
			hint: "install with `npm i -g @anthropic-ai/claude-code`, then `claude` to sign in",
		};
	}
	let loggedIn = false;
	let viaBrigade = false;
	try {
		viaBrigade = hasBrigadeClaudeLogin();
		loggedIn = viaBrigade || readClaudeCliLogin() !== null;
	} catch {
		loggedIn = false;
	}
	if (!loggedIn) {
		return {
			name: "claude-cli backend",
			status: "warn",
			message: "`claude` is installed but no login was detected",
			hint: "run `brigade onboard` and pick 'Claude (via Claude Code CLI)' to sign in via browser (no key)",
		};
	}
	return {
		name: "claude-cli backend",
		status: "ok",
		message: `installed + signed in (${viaBrigade ? "Brigade-managed login" : "your Claude Code login"}) — select with \`/provider claude-cli\``,
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

async function checkMemory(): Promise<CheckResult> {
	const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
	const store = new FileMemoryStore(workspaceDir);
	let summary: Awaited<ReturnType<FileMemoryStore["status"]>>;
	try {
		summary = await store.status();
	} catch (err) {
		return {
			name: "memory",
			status: "warn",
			message: `could not read memory: ${(err as Error).message}`,
		};
	}
	// Structured fact count — lets `doctor` show whether extraction/write_memory
	// is actually populating facts.jsonl (useful when verifying memory manually).
	let factCount = 0;
	try {
		factCount = new FactStore(workspaceDir).list().length;
	} catch {
		/* no fact store yet */
	}
	const embedder = process.env.BRIGADE_MEMORY_EMBEDDER ?? "model-free";
	// When a non-default embedder is configured, note that the gateway
	// resolves it and may fall back to model-free HRR if the key or dep is
	// missing. The CLI sees only the configured intent, not the resolved state.
	const embedderLabel =
		embedder === "model-free"
			? "model-free"
			: `${embedder} (configured; gateway resolves — may run model-free if key or dep is missing)`;
	if (summary.fileCount === 0 && factCount === 0) {
		// "ok" — an empty memory corpus is the normal fresh state. The agent
		// populates it as it learns durable facts.
		return {
			name: "memory",
			status: "ok",
			message: `no memory yet — facts auto-extract after every turn (embedder: ${embedderLabel})`,
		};
	}
	const kb = (summary.totalBytes / 1024).toFixed(1);
	// factCount covers all origins; recall is owner-scoped, so the number
	// can exceed what a single-owner recall query returns.
	return {
		name: "memory",
		status: "ok",
		message: `${factCount} fact${factCount === 1 ? "" : "s"} across all origins · ${summary.fileCount} note file${summary.fileCount === 1 ? "" : "s"}, ${kb} KB (embedder: ${embedderLabel})`,
	};
}

function checkSkills(): CheckResult {
	const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
	let result: ReturnType<typeof discoverEligibleSkills>;
	try {
		result = discoverEligibleSkills({ workspaceDir, config: readConfigOrInit() });
	} catch (err) {
		return {
			name: "skills",
			status: "warn",
			message: `could not scan skills: ${(err as Error).message}`,
		};
	}
	const count = result.skills.length;
	if (count === 0) {
		// "ok" — no skills is the normal fresh state. Drop a folder to add one.
		return {
			name: "skills",
			status: "ok",
			message: "no skills yet — drop a folder in workspace/skills/<name>/SKILL.md",
		};
	}
	const hidden = result.totalDiscovered - count;
	const suffix = hidden > 0 ? ` (${hidden} not eligible here)` : "";
	return {
		name: "skills",
		status: "ok",
		message: `${count} skill${count === 1 ? "" : "s"} available${suffix}`,
	};
}

/**
 * Media-understanding readiness — which provider keys back `analyze_media`'s
 * direct-provider paths (video / native-PDF / text-only-model images). Pure
 * read of the credential store; never makes a network call. "ok" in every
 * case — this is informational (video just needs a key when first used).
 */
function checkMediaUnderstanding(): CheckResult {
	let probe: ReturnType<typeof probeMediaUnderstanding>;
	try {
		probe = probeMediaUnderstanding(DEFAULT_AGENT_ID);
	} catch (err) {
		return {
			name: "media understanding",
			status: "warn",
			message: `could not probe provider keys: ${(err as Error).message}`,
		};
	}
	if (!probe.video && !probe.pdf && !probe.image) {
		return {
			name: "media understanding",
			status: "ok",
			message:
				"no Google/Anthropic key — video + native-PDF understanding unavailable (PDF/Office still extract text)",
			hint: "add a Google/Gemini key (video) or Anthropic key (scanned PDF) with `brigade onboard`",
		};
	}
	const have: string[] = [];
	if (probe.video) have.push("video (Gemini)");
	if (probe.pdf) have.push("native PDF");
	if (probe.image) have.push("provider images");
	return {
		name: "media understanding",
		status: "ok",
		message: `enabled: ${have.join(", ")}`,
	};
}

function checkExecApprovals(): CheckResult {
	const s = readApprovalsSummary();
	// Schema-version mismatch is reported via `s.error` (the loader threw,
	// readApprovalsSummary caught + surfaced). Render it as `fail` so the
	// operator sees clearly that the gate WILL refuse every bash call until
	// they take action.
	if (s.error) {
		return {
			name: "exec approvals",
			status: "fail",
			message: `${s.filePath} — ${s.error}`,
			hint: "the gate refuses every bash call while the file is unreadable — repair or move it aside",
		};
	}
	if (!s.fileExists) {
		// "ok" because an empty allowlist is a SECURE default in v1 — bash
		// is refused until the operator approves. We just want the operator
		// to know the gate exists and how to feed it.
		return {
			name: "exec approvals",
			status: "ok",
			message: "no approvals yet — bash is refused until you approve a command",
			hint: 'run `brigade exec allow "ls -la"` (or your common safe commands) to feed the allowlist',
		};
	}
	const total = s.commandCount + s.patternCount;
	if (total === 0) {
		return {
			name: "exec approvals",
			status: "ok",
			message: `allowlist file exists at ${s.filePath} but is empty`,
			hint: 'run `brigade exec allow "<cmd>"` to add an exact approval, or `brigade exec allow-pattern <regex>` for a family',
		};
	}
	const parts: string[] = [];
	if (s.commandCount > 0) parts.push(`${s.commandCount} command${s.commandCount === 1 ? "" : "s"}`);
	if (s.patternCount > 0) parts.push(`${s.patternCount} pattern${s.patternCount === 1 ? "" : "s"}`);
	return {
		name: "exec approvals",
		status: "ok",
		message: `${parts.join(", ")} approved (${s.filePath})`,
		hint: "list with `brigade exec list`, classify a command with `brigade exec deny-test <cmd>`",
	};
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
	const probe = await probeGateway({ host: opts.host, port: opts.port, token: resolveClientToken(readConfigOrInit().gateway?.auth) });
	const pid = await readPid();
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

/**
 * Per-channel security audit — surfaces findings from any registered
 * `ChannelSecurityAdapter` (`collectAuditFindings` / `collectWarnings`).
 *
 * Non-invasive by design: channel security adapters register only when a
 * channel plugin opts in (at gateway boot via the plugin engine), so an
 * in-process `brigade doctor` with no adapters registered reports a clean "no
 * channel security adapters registered" — never a false warning. When adapters
 * ARE present, the worst finding severity drives the check status (critical →
 * fail, warn → warn, info → ok) and the message summarises the counts.
 */
async function checkChannelSecurity(
	config: Awaited<ReturnType<typeof loadConfig>> | undefined,
): Promise<CheckResult> {
	if (listChannelSecurityAdapters().length === 0) {
		return {
			name: "channel security",
			status: "ok",
			message: "no channel security adapters registered",
		};
	}
	let groups: Awaited<ReturnType<typeof collectChannelSecurityAudit>>;
	try {
		groups = await collectChannelSecurityAudit({
			cfg: (config ?? {}) as Parameters<typeof collectChannelSecurityAudit>[0]["cfg"],
		});
	} catch (err) {
		return {
			name: "channel security",
			status: "warn",
			message: `could not collect channel security audit: ${(err as Error).message}`,
		};
	}
	const findings = groups.flatMap((g) => g.findings);
	if (findings.length === 0) {
		const channels = groups.length > 0 ? groups.map((g) => g.channelId).join(", ") : "registered channels";
		return {
			name: "channel security",
			status: "ok",
			message: `no security findings (${channels})`,
		};
	}
	const critical = findings.filter((f) => f.severity === "critical").length;
	const warn = findings.filter((f) => f.severity === "warn").length;
	const info = findings.filter((f) => f.severity === "info").length;
	const parts: string[] = [];
	if (critical > 0) parts.push(`${critical} critical`);
	if (warn > 0) parts.push(`${warn} warn`);
	if (info > 0) parts.push(`${info} info`);
	// Surface the first actionable remediation as the hint, when present.
	const firstRemediation = findings.find((f) => f.remediation)?.remediation;
	const byChannel = groups.map((g) => `${g.channelId} (${g.findings.length})`).join(", ");
	const status: CheckStatus = critical > 0 ? "fail" : warn > 0 ? "warn" : "ok";
	return {
		name: "channel security",
		status,
		message: `${parts.join(", ")} across ${byChannel}`,
		...(firstRemediation ? { hint: firstRemediation } : {}),
	};
}

const GLYPH = {
	ok: chalk.green("✔"),
	warn: chalk.yellow("⚠"),
	fail: chalk.red("✖"),
} as const;

/**
 * Storage-mode check — reports the active mode (filesystem vs convex) from
 * `~/.brigade/mode.sentinel`. For convex mode, probes the deployment URL so
 * an operator who's run `brigade onboard` against a now-dead local backend
 * gets a clear "convex is unreachable" warning instead of a cryptic boot
 * failure later.
 */
async function checkStorageMode(): Promise<CheckResult> {
	let sentinel;
	try {
		sentinel = readSentinel();
	} catch (err) {
		return {
			name: "storage mode",
			status: "fail",
			message: `mode.sentinel is unreadable: ${(err as Error).message}`,
			hint: "fix the file by hand or delete ~/.brigade/mode.sentinel then re-run `brigade onboard`",
		};
	}

	if (!sentinel) {
		const hasOnboarded = sentinelExists();
		if (hasOnboarded) {
			// Should be impossible — readSentinel returned undefined but
			// the file exists. Treat as warn rather than crash.
			return {
				name: "storage mode",
				status: "warn",
				message: "mode.sentinel exists but didn't parse cleanly",
			};
		}
		return {
			name: "storage mode",
			status: "ok",
			message: "filesystem (default — no mode.sentinel pinned yet)",
			hint: "run `brigade onboard` to pick filesystem vs convex explicitly",
		};
	}

	if (sentinel.mode === "filesystem") {
		return {
			name: "storage mode",
			status: "ok",
			message: `filesystem · pinned ${sentinel.migratedAt ?? "?"}`,
		};
	}

	// Convex mode — probe the URL.
	const url = sentinel.convexUrl!;
	try {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 5_000);
		const res = await fetch(`${url.replace(/\/+$/, "")}/instance_name`, { signal: controller.signal });
		clearTimeout(t);
		if (!res.ok) {
			return {
				name: "storage mode",
				status: "fail",
				message: `convex (${url}) — HTTP ${res.status}`,
				hint: "ensure `npm run convex:dev` is running, or check the deployment URL",
			};
		}
		const instance = (await res.text()).trim();
		return {
			name: "storage mode",
			status: "ok",
			message: `convex (${url}) · instance ${instance || "(unknown)"}`,
		};
	} catch (err) {
		const msg = (err as Error)?.name === "AbortError" ? "timed out after 5s" : (err as Error).message;
		const localHint =
			url.includes("127.0.0.1") || url.includes("localhost")
				? "start the local backend with `npm run convex:dev` in another terminal"
				: "check network connectivity to the deployment URL";
		return {
			name: "storage mode",
			status: "fail",
			message: `convex (${url}) unreachable: ${msg}`,
			hint: localHint,
		};
	}
}

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
