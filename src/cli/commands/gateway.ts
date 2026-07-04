/**
 * `brigade gateway` — start the WebSocket gateway server, no TUI.
 *
 * Long-running headless process that owns the Pi session and broadcasts
 * events to any connected clients (Brigade TUI, future web/mobile, etc.).
 * One server per machine is the assumed model — bind defaults to localhost
 * to avoid LAN exposure.
 *
 * Logging defaults to ON at `info` level — when you run `brigade gateway`
 * you SEE what's happening (Pi events, WS req/res, client connect/disconnect)
 * in real time. The same events also land in the JSONL log file. Use
 * `--verbose` for token-level detail, or `--quiet` for a near-silent
 * supervisor-friendly boot.
 *
 * Flags:
 *   --port <n>           Port (default: BRIGADE_PORT env or 7777)
 *   --host <addr>        Bind address (default: 127.0.0.1; use 0.0.0.0 for LAN)
 *   --verbose            Bump log level to `debug` — adds message_update
 *                        deltas (one per token) and message_start/end. Useful
 *                        when debugging streaming or thinking blocks.
 *   --log-level <level>  error | warn | info | debug. Overrides --verbose
 *                        and the default. Use `warn` for retries+errors only.
 *   --quiet              Disable the console stream entirely. Just two boot
 *                        lines on stderr, then silence. Use under systemd /
 *                        nohup / tmux when you want JSONL only.
 */

import process from "node:process";

import chalk from "chalk";

import { createConsoleStream, type LogLevel } from "../../core/console-stream.js";
import { getLastLoggedError, getTodayLogPath } from "../../core/event-logger.js";
import { isGatewayLockError } from "../../core/gateway-lock.js";
import { isProcessAlive, probeGateway, readPid, GATEWAY_PID_PATH } from "../../core/gateway-probe.js";
import { clientAuthHeaders, generateGatewayToken, maskToken, resolveClientToken, resolveGatewayTokens } from "../../core/gateway-auth.js";
import { loadConfig } from "../../core/config.js";
import { mutateConfigAtomic } from "../../config/io.js";
import { formatPortListener, inspectPortListeners } from "../../core/port-inspect.js";
import { EXIT_CONFIG_ERROR, EXIT_FAILURE } from "../../protocol.js";
import { startServer } from "../../core/server.js";
import { restoreTerminal } from "../../ui/terminal-cleanup.js";

// Commander wrapper — `brigade gateway` registers the long-running WebSocket
// daemon. Same single-touch pattern the TUI command uses: the action handler
// holds open with `new Promise(() => {})` so `entry.ts` doesn't reach
// `process.exit(0)` and tear the listening socket down. The gateway itself
// resolves clean shutdown via SIGINT/SIGTERM handlers.
//
// Subcommand layout:
//
//   brigade gateway          — run (back-compat — `gateway` alone is `gateway run`)
//   brigade gateway run      — same as above; explicit form
//   brigade gateway status   — probe ws://host:port, report state
//   brigade gateway stop     — read PID, send SIGTERM, wait for socket release
//
// `install-daemon` / `uninstall-daemon` not yet ported — Brigade v1 doesn't
// ship an OS-service installer; that lands when channels do.
export function registerGatewayCommand(program: import("commander").Command): void {
	const gw = program
		.command("gateway")
		.description("Run or manage the Brigade gateway (WebSocket daemon)")
		// Default action when the user types `brigade gateway` with no
		// subcommand: dispatch to `run` so old invocations keep working.
		.option("-p, --port <port>", "TCP port to bind", (v) => parseInt(v, 10))
		.option("-h, --host <host>", "host/interface to bind")
		.option("-v, --verbose", "raise log level to debug")
		.option("-q, --quiet", "disable the console stream entirely")
		.option("--log-level <level>", "trace|debug|info|warn|error|fatal")
		.action(async (opts: { port?: number; host?: string; verbose?: boolean; quiet?: boolean; logLevel?: string }) => {
			await runGatewayCommand({
				port: opts.port,
				host: opts.host,
				verbose: opts.verbose,
				quiet: opts.quiet,
				logLevel: opts.logLevel as LogLevel | undefined,
			});
			await new Promise<void>(() => {});
		});

	gw.command("run")
		.description("Run the Brigade gateway in the foreground (long-lived WebSocket daemon)")
		.option("-p, --port <port>", "TCP port to bind", (v) => parseInt(v, 10))
		.option("-h, --host <host>", "host/interface to bind")
		.option("-v, --verbose", "raise log level to debug")
		.option("-q, --quiet", "disable the console stream entirely")
		.option("--log-level <level>", "trace|debug|info|warn|error|fatal")
		.action(async (opts: { port?: number; host?: string; verbose?: boolean; quiet?: boolean; logLevel?: string }) => {
			await runGatewayCommand({
				port: opts.port,
				host: opts.host,
				verbose: opts.verbose,
				quiet: opts.quiet,
				logLevel: opts.logLevel as LogLevel | undefined,
			});
			await new Promise<void>(() => {});
		});

	gw.command("status")
		.description("Probe a running gateway and print its state")
		.option("-h, --host <host>", "gateway host (default: 127.0.0.1)")
		.option("-p, --port <port>", "gateway port (default: 7777)", (v) => parseInt(v, 10))
		.option("--json", "emit JSON instead of human-readable text", false)
		.action(async (opts: { host?: string; port?: number; json?: boolean }) => {
			const code = await runGatewayStatusCommand(opts);
			process.exit(code);
		});

	gw.command("stop")
		.description("Send SIGTERM to the running gateway and wait for it to exit")
		.option("--timeout <ms>", "max ms to wait for shutdown (default: 5000)", (v) => parseInt(v, 10))
		.option("--json", "emit JSON instead of human-readable text", false)
		.action(async (opts: { timeout?: number; json?: boolean }) => {
			const code = await runGatewayStopCommand(opts);
			process.exit(code);
		});
}

/* ───────────────────── token management ───────────────────── */

/** Atomically mutate `gateway.auth` (mode-aware — filesystem or Convex). */
async function mutateGatewayAuth(
	fn: (auth: { mode?: "none" | "token" | "password"; token?: string; tokens?: string[]; password?: string }) => void,
): Promise<void> {
	await mutateConfigAtomic((current) => {
		const next = { ...current };
		const gateway = { ...(next.gateway ?? {}) };
		const auth = { ...(gateway.auth ?? {}) };
		fn(auth);
		gateway.auth = auth;
		next.gateway = gateway;
		return next;
	});
}

/** `brigade gateway token list` — show configured tokens (masked) + status. */
export async function runGatewayTokenListCommand(opts: { json?: boolean } = {}): Promise<number> {
	const auth = loadConfig().gateway?.auth;
	const stored = [...(auth?.token ? [auth.token] : []), ...(auth?.tokens ?? [])];
	const envCount = (process.env.BRIGADE_GATEWAY_TOKENS ?? "").split(/[\s,]+/).filter(Boolean).length;
	const effective = resolveGatewayTokens(auth, process.env);
	const enforced = effective.length > 0 && auth?.mode !== "none";

	if (opts.json) {
		console.log(JSON.stringify({ enforced, effectiveCount: effective.length, stored: stored.map(maskToken), envCount }, null, 2));
		return 0;
	}
	if (effective.length === 0) {
		console.log("Gateway authentication is OFF — no tokens configured. The gateway is open on localhost.");
		console.log(chalk.dim("Create one with:  brigade gateway token new"));
		return 0;
	}
	console.log(
		enforced
			? chalk.green(`Gateway authentication is ON — ${effective.length} token(s) accepted.`)
			: chalk.yellow(`${effective.length} token(s) configured, but auth.mode is "none" — NOT enforced.`),
	);
	stored.forEach((t, i) => console.log(`  ${i + 1}. ${maskToken(t)}`));
	if (envCount > 0) console.log(chalk.dim(`  + ${envCount} more from BRIGADE_GATEWAY_TOKENS (this shell only)`));
	return 0;
}

/** `brigade gateway token new` — generate, store, print once. */
export async function runGatewayTokenNewCommand(opts: { json?: boolean } = {}): Promise<number> {
	const token = generateGatewayToken();
	await mutateGatewayAuth((auth) => {
		auth.tokens = [...(auth.tokens ?? []), token];
	});
	if (opts.json) {
		console.log(JSON.stringify({ token }));
		return 0;
	}
	console.log(chalk.green("New gateway token created:"));
	console.log(`\n  ${chalk.bold(token)}\n`);
	console.log(chalk.dim("This is the only time it's shown in full — copy it now."));
	console.log(
		chalk.dim("Clients on this machine read it from config automatically; elsewhere pass --token <t> or set BRIGADE_GATEWAY_TOKEN."),
	);
	if (loadConfig().gateway?.auth?.mode === "none") {
		console.log(chalk.yellow('Heads up: auth.mode is "none", so tokens are stored but NOT enforced. Clear it to turn auth on.'));
	} else {
		console.log(
			chalk.yellow("Authentication is now ON for the next gateway start. Restart to apply:  brigade gateway stop && brigade gateway"),
		);
	}
	return 0;
}

/** `brigade gateway token add <token>` — accept an externally-supplied token. */
export async function runGatewayTokenAddCommand(token: string): Promise<number> {
	const value = token.trim();
	if (!value) {
		console.error(chalk.red("Provide a non-empty token."));
		return 1;
	}
	if (resolveGatewayTokens(loadConfig().gateway?.auth, {}).includes(value)) {
		console.log("That token is already configured — nothing to do.");
		return 0;
	}
	await mutateGatewayAuth((auth) => {
		auth.tokens = [...(auth.tokens ?? []), value];
	});
	console.log(chalk.green(`Added token ${maskToken(value)}.`));
	console.log(chalk.yellow("Restart the gateway to apply:  brigade gateway stop && brigade gateway"));
	return 0;
}

/** `brigade gateway token revoke <token|index>` — remove one token. */
export async function runGatewayTokenRevokeCommand(arg: string): Promise<number> {
	const auth = loadConfig().gateway?.auth;
	const stored = [...(auth?.token ? [auth.token] : []), ...(auth?.tokens ?? [])];
	if (stored.length === 0) {
		console.log("No tokens are configured.");
		return 0;
	}
	// Target a 1-based index from `token list`, or an exact token value.
	let target: string | undefined;
	const asIndex = Number(arg);
	if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= stored.length) {
		target = stored[asIndex - 1];
	} else if (stored.includes(arg.trim())) {
		target = arg.trim();
	}
	if (!target) {
		console.error(
			chalk.red(`No token matches "${arg}". Use its number from \`brigade gateway token list\`, or its exact value.`),
		);
		return 1;
	}
	const victim = target;
	await mutateGatewayAuth((a) => {
		if (a.token === victim) delete a.token;
		a.tokens = (a.tokens ?? []).filter((t) => t !== victim);
	});
	console.log(chalk.green(`Revoked token ${maskToken(victim)}.`));
	console.log(chalk.yellow("Restart the gateway to apply:  brigade gateway stop && brigade gateway"));
	return 0;
}

/* ───────────────────── status subcommand ───────────────────── */

export async function runGatewayStatusCommand(opts: { host?: string; port?: number; json?: boolean }): Promise<number> {
	const port = opts.port ?? 7777;
	const probe = await probeGateway({ host: opts.host, port: opts.port, token: resolveClientToken(loadConfig().gateway?.auth) });
	const pid = await readPid();
	const logPath = getTodayLogPath();
	// Inspect the port even when the probe says reachable — surfaces a
	// stale process when a different PID is bound (port hijack /
	// supervisor mismatch) so "stale gateway" failures are caught.
	const listeners = inspectPortListeners(port);
	// Only fetch last error when the gateway is NOT reachable — operators
	// looking at a healthy gateway don't want stale errors front-and-centre.
	const lastError = probe.reachable ? undefined : getLastLoggedError();

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					reachable: probe.reachable,
					url: probe.url,
					pid,
					pidAlive: pid ? isProcessAlive(pid) : false,
					state: probe.state,
					error: probe.error,
					errorKind: probe.errorKind,
					logFile: logPath,
					listeners,
					lastError,
				},
				null,
				2,
			)}\n`,
		);
		return probe.reachable ? 0 : 1;
	}
	if (probe.reachable) {
		process.stdout.write(`${chalk.green("running")} at ${probe.url}${pid ? ` (pid ${pid})` : ""}\n`);
		if (probe.state?.provider && probe.state?.modelId) {
			process.stdout.write(`  model: ${probe.state.provider}/${probe.state.modelId}\n`);
		}
		if (typeof probe.state?.isAgentRunning === "boolean") {
			process.stdout.write(`  agent: ${probe.state.isAgentRunning ? chalk.yellow("running") : "idle"}\n`);
		}
		if (typeof probe.state?.messageCount === "number") {
			process.stdout.write(`  messages: ${probe.state.messageCount}\n`);
		}
		// "Stale-runtime" detection: probe is reachable but the listener PID
		// doesn't match our PID file. Means an unrelated process is on 7777
		// (e.g. user re-onboarded and forgot to stop the old gateway).
		if (pid && listeners.length > 0 && !listeners.some((l) => l.pid === pid)) {
			process.stdout.write(
				`  ${chalk.yellow("warning")}: PID file says ${pid} but port ${port} is held by ` +
					`${listeners.map((l) => `pid ${l.pid}`).join(", ")}\n`,
			);
		}
		process.stdout.write(`  log:   ${chalk.dim(logPath)}\n`);
		return 0;
	}
	// Unreachable paths — describe the most actionable thing we can.
	if (pid && isProcessAlive(pid)) {
		process.stdout.write(
			`${chalk.yellow("partial")}: pid ${pid} alive but ${probe.url} unreachable ` +
				`(${chalk.dim(`${probe.errorKind ?? "other"}: ${probe.error}`)})\n`,
		);
	} else if (pid) {
		process.stdout.write(`${chalk.yellow("stale-pid")}: ${GATEWAY_PID_PATH} points at dead pid ${pid}\n`);
	} else {
		process.stdout.write(
			`${chalk.dim("not running")} (${probe.url}: ${chalk.dim(`${probe.errorKind ?? "other"}: ${probe.error}`)})\n`,
		);
	}
	if (listeners.length > 0) {
		process.stdout.write(`  port ${port} held by:\n`);
		for (const l of listeners) {
			process.stdout.write(`    - ${formatPortListener(l)}\n`);
		}
	}
	process.stdout.write(`  log:   ${chalk.dim(logPath)}\n`);
	if (lastError) {
		process.stdout.write(
			`  ${chalk.dim("last error:")} ${lastError.message} ${chalk.dim(`(${lastError.ts})`)}\n`,
		);
	}
	return 1;
}

/* ───────────────────── stop subcommand ────────────────────── */

const STOP_DEFAULT_TIMEOUT_MS = 5000;
const STOP_POLL_INTERVAL_MS = 100;

/**
 * Open a WebSocket to the running gateway, send a `shutdown` request, and
 * wait for the ack. Returns true when the gateway acknowledged the shutdown,
 * false on any failure (no listener, malformed reply, timeout). Used by
 * `runGatewayStopCommand` to attempt a graceful stop before falling back to
 * SIGTERM. Brigade has no service manager, so a self-administered RPC is
 * the cross-platform-clean equivalent of service-manager-mediated stop.
 */
async function sendShutdownRpc(args: { host?: string; port?: number; timeoutMs: number }): Promise<boolean> {
	const { WebSocket } = await import("ws");
	const host = args.host ?? "127.0.0.1";
	const port = args.port ?? 7777;
	const url = `ws://${host}:${port}`;
	return await new Promise<boolean>((resolve) => {
		let settled = false;
		const token = resolveClientToken(loadConfig().gateway?.auth);
		const ws = new WebSocket(url, { handshakeTimeout: args.timeoutMs, headers: clientAuthHeaders(token) });
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			try {
				ws.removeAllListeners();
				// Closing a socket that hasn't finished connecting makes `ws` emit an
				// 'error' ("WebSocket was closed before the connection was
				// established"). We just removed our listeners, so absorb it with a
				// no-op sink — otherwise Node turns it into an unhandled 'error' and
				// crashes the CLI (same class as the probeGateway teardown crash).
				ws.on("error", () => {});
				ws.close();
			} catch {
				/* ignore */
			}
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), args.timeoutMs);
		const reqId = `stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		ws.on("open", () => {
			try {
				ws.send(JSON.stringify({ type: "req", id: reqId, method: "shutdown" }));
			} catch {
				clearTimeout(timer);
				finish(false);
			}
		});
		ws.on("error", () => {
			clearTimeout(timer);
			finish(false);
		});
		ws.on("message", (data) => {
			try {
				const parsed = JSON.parse(typeof data === "string" ? data : data.toString());
				if (parsed?.type === "res" && parsed?.id === reqId) {
					clearTimeout(timer);
					finish(parsed.ok === true);
				}
				// Any other frame (initial state, events) — keep waiting for the ack.
			} catch {
				// Non-JSON frame — keep waiting.
			}
		});
	});
}

export async function runGatewayStopCommand(opts: { timeout?: number; json?: boolean; host?: string; port?: number }): Promise<number> {
	const timeoutMs = opts.timeout ?? STOP_DEFAULT_TIMEOUT_MS;
	const resolvedPort = opts.port ?? 7777;
	let pid = await readPid();
	// True when `pid` was recovered from the PORT owner rather than our PID
	// file. A PID-file PID is TRUSTED (we wrote it for our own gateway); a
	// port-owner PID is NOT — some unrelated app could hold 7777 — so we only
	// hard-kill it if it proves itself a Brigade gateway via the shutdown
	// handshake (see the SIGTERM guard below).
	let pidFromPort = false;
	if (!pid) {
		// No PID file recorded — but a gateway can still be bound to the port
		// with its PID + lock files gone: a foreground start that never recorded
		// them, or an unclean exit that left the process alive holding the
		// socket. The PID file alone would make us give up while port 7777 stays
		// stuck. Fall back to the actual port owner so `gateway stop` recovers
		// the port instead of stranding it. The recovered PID then flows through
		// the same graceful-shutdown → SIGTERM → cleanup path below.
		const owner = inspectPortListeners(resolvedPort).find((l) => Number.isInteger(l.pid) && l.pid > 0);
		if (owner) {
			pid = owner.pid;
			pidFromPort = true;
			const note = `no PID file recorded, but port ${resolvedPort} is held by ${formatPortListener(owner)} — trying a graceful Brigade shutdown`;
			if (!opts.json) process.stdout.write(`${chalk.yellow(note)}\n`);
		}
	}
	if (!pid) {
		const msg = `no running gateway recorded (checked ${GATEWAY_PID_PATH}) and nothing is listening on port ${resolvedPort} — gateway is probably not running`;
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, reason: msg })}\n`);
		else process.stdout.write(`${chalk.dim(msg)}\n`);
		return 0;
	}
	if (!isProcessAlive(pid)) {
		const msg = `pid ${pid} not alive — clearing stale PID + lock files`;
		// Clear both stale files so the next status/stop is clean and the
		// next `gateway run` doesn't have to walk the 30s stale-window check.
		try {
			const { clearPidFile } = await import("../../core/gateway-probe.js");
			await clearPidFile();
		} catch {
			// Ignore; the file may have vanished concurrently.
		}
		try {
			const { resolveGatewayLockPath } = await import("../../core/gateway-lock.js");
			const fsAsync = await import("node:fs/promises");
			await fsAsync.unlink(resolveGatewayLockPath());
		} catch {
			/* best-effort */
		}
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, reason: msg })}\n`);
		else process.stdout.write(`${chalk.yellow(msg)}\n`);
		return 0;
	}
	// Step 1 — try graceful WS shutdown FIRST. The gateway acks the
	// `shutdown` request, runs its full cleanup chain (close clients, unwind
	// Pi session, clear PID+lock, close the JSONL log handle), then exits
	// cleanly. This is the only reliable way to get a clean stop on Windows
	// (where `process.kill(pid, "SIGTERM")` is a forceful kill that skips
	// every Node-installed signal handler).
	let gracefulSucceeded = false;
	try {
		gracefulSucceeded = await sendShutdownRpc({
			host: opts.host,
			port: opts.port,
			// Cap the graceful attempt at 1/3 of the total budget so we still
			// have time for the SIGTERM fallback if the WS path hangs.
			timeoutMs: Math.max(500, Math.floor(timeoutMs / 3)),
		});
	} catch {
		// WS path threw (e.g. import failure) — fall through to SIGTERM.
	}
	// Step 2 — if the graceful path failed (gateway already half-dead, no
	// listener, RPC method unsupported on an old daemon, etc.), fall back to
	// SIGTERM. Forceful on Windows; clean on POSIX. Either way we then poll
	// for the process to exit and clean up files.
	if (!gracefulSucceeded) {
		// Safety gate: if the PID came from the PORT (not our PID file) and the
		// Brigade `shutdown` handshake did NOT ack, we cannot confirm this is even
		// a Brigade gateway — it could be an unrelated process that happens to
		// hold the port. Since SIGTERM is a forceful kill on Windows, refuse to
		// signal an unidentified process and tell the operator how to kill it by
		// hand if they're sure. A PID-file PID is trusted and still falls through.
		if (pidFromPort) {
			const msg = `port ${resolvedPort} is held by pid ${pid}, but it didn't answer the Brigade shutdown handshake — not force-killing an unidentified process. If you're sure it's a stuck gateway, stop it manually (e.g. \`taskkill /PID ${pid} /F\` on Windows, \`kill ${pid}\` on macOS/Linux).`;
			if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, pid, reason: msg })}\n`);
			else process.stderr.write(`${chalk.yellow(msg)}\n`);
			return 1;
		}
		try {
			process.kill(pid, "SIGTERM");
		} catch (err) {
			const msg = `failed to signal pid ${pid}: ${(err as Error).message}`;
			if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
			else process.stderr.write(`${chalk.red(msg)}\n`);
			return 1;
		}
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			const msg = `gateway (pid ${pid}) stopped`;
			// On Windows, `process.kill(pid, "SIGTERM")` is a forceful kill —
			// the gateway's own SIGTERM handler never runs, so the PID file
			// and gateway.lock linger on disk. POSIX gets clean shutdown via
			// the handler, but we ALSO unconditionally clean here so a
			// successful `gateway stop` always leaves a clean state. Stale
			// lock files would otherwise survive until the 30s window or the
			// next gateway boot triggers the auto-recovery path.
			try {
				const { clearPidFile } = await import("../../core/gateway-probe.js");
				await clearPidFile();
			} catch {
				/* best-effort */
			}
			try {
				const { resolveGatewayLockPath } = await import("../../core/gateway-lock.js");
				const fsAsync = await import("node:fs/promises");
				await fsAsync.unlink(resolveGatewayLockPath());
			} catch {
				/* best-effort — file may already be gone if the gateway cleaned up */
			}
			if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, pid })}\n`);
			else process.stdout.write(`${chalk.green(msg)}\n`);
			return 0;
		}
		await new Promise((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
	}
	const msg = `pid ${pid} still running after ${timeoutMs}ms — try \`kill -9 ${pid}\``;
	if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, pid, reason: msg })}\n`);
	else process.stderr.write(`${chalk.red(msg)}\n`);
	return 1;
}

export interface GatewayCommandOptions {
	port?: number;
	host?: string;
	/** Bump default `info` to `debug` (token deltas + intra-message events). */
	verbose?: boolean;
	/** Disable the console stream entirely. Implicit when piped to a non-TTY? No — explicit only. */
	quiet?: boolean;
	/** Explicit log level override. Wins over both --verbose and the default. */
	logLevel?: LogLevel;
}

/**
 * Boot the gateway. Resolves once the port is bound. Wires SIGINT/SIGTERM
 * to a clean shutdown so the listening socket is released even on Ctrl+C.
 *
 * Returns a stop() function so callers (tests, cli supervisor) can shut
 * the server down without sending a signal.
 */
export async function runGatewayCommand(opts: GatewayCommandOptions = {}): Promise<() => Promise<void>> {
	// Console stream is ON by default. Operators expect to SEE what their
	// daemon is doing without flipping a flag — that was the point of moving
	// from `npm run server` to `brigade gateway`. Precedence:
	//   --quiet           → no stream at all (silent supervisor mode)
	//   --log-level X     → explicit level X
	//   --verbose         → debug
	//   (default)         → info
	const level: LogLevel | "off" = opts.quiet
		? "off"
		: (opts.logLevel ?? (opts.verbose ? "debug" : "info"));
	const consoleStream = level === "off" ? undefined : createConsoleStream({ level });

	let handle: Awaited<ReturnType<typeof startServer>>;
	try {
		handle = await startServer({
			port: opts.port,
			host: opts.host,
			consoleStream,
		});
	} catch (err) {
		// Translate the most common boot failures into actionable messages.
		// EADDRINUSE = something already on the port (often a leftover gateway
		// from a prior run, or another app). Tell the user how to recover
		// instead of dumping a Node stack trace.
		const msg = err instanceof Error ? err.message : String(err);
		const port = opts.port ?? (Number(process.env.BRIGADE_PORT) || 7777);
		// "no saved config" is a config error — exit with sysexits 78 so
		// supervisors (systemd, launchd) STOP restarting. Restarting will
		// produce the exact same error until the operator runs onboarding.
		//
		// Interactive enhancement (TTY only): rather than dead-ending the
		// developer in their terminal with "go run another command", offer
		// to launch chat (which handles onboarding inline) right now. Non-
		// interactive supervisors get the message + exit 78 as before, so
		// systemd doesn't sit waiting for stdin that will never come.
		if (/no saved config|model .+ not in registry/i.test(msg)) {
			// Point straight at onboarding. We used to offer to launch
			// `brigade chat` here "to onboard", but chat is now a thin client
			// to THIS gateway — it doesn't run the wizard, it just refuses
			// without config the same way. `brigade onboard` is the one true
			// setup path, so send the user there directly instead of through a
			// hand-off that dead-ends.
			process.stderr.write(
				chalk.yellow(`brigade-gateway: this gateway hasn't been set up yet.\n`) +
					chalk.dim(`  Run ${chalk.bold("brigade onboard")} to pick a provider + model, then re-launch.\n`),
			);
			process.exit(EXIT_CONFIG_ERROR);
		}
		// Lock-held — another `brigade gateway` is already running and the
		// 5000ms acquire window expired. The error message already names the
		// holder PID; we add operator-facing recovery hints + a port-owner
		// listing (cross-platform via netstat / lsof / ss) so the user can
		// see exactly which process is holding the port. The canonical
		// shape is `Gateway failed to start: ...\nIf the gateway is
		// supervised, stop it with: brigade gateway stop`.
		if (isGatewayLockError(err)) {
			const listeners = inspectPortListeners(port);
			let body =
				`brigade-gateway: failed to start: ${chalk.red(msg)}\n` +
				chalk.dim(`  If the gateway is supervised, stop it with: ${chalk.bold("brigade gateway stop")}\n`) +
				`Port ${port} is already in use.\n`;
			if (listeners.length > 0) {
				for (const l of listeners) {
					body += `  - ${formatPortListener(l)}\n`;
				}
			} else if (err.holderPid) {
				body += `  - pid ${err.holderPid}: brigade gateway (held lock at ${chalk.dim("~/.brigade/gateway.lock")})\n`;
			} else {
				body += `  - holder PID unknown — inspect ${chalk.dim("~/.brigade/gateway.lock")}\n`;
			}
			process.stderr.write(body);
			process.exit(EXIT_FAILURE);
		}
		if (/EADDRINUSE/.test(msg)) {
			const listeners = inspectPortListeners(port);
			let body = `brigade-gateway: port ${port} is already in use.\n`;
			if (listeners.length > 0) {
				for (const l of listeners) {
					body += `  - ${formatPortListener(l)}\n`;
				}
				body += `  - or pick a different port: brigade gateway --port ${port + 1}\n`;
			} else {
				body +=
					`  - find the process: PowerShell> Get-NetTCPConnection -LocalPort ${port}\n` +
					`  - or pick a different port: brigade gateway --port ${port + 1}\n`;
			}
			process.stderr.write(body);
			process.exit(EXIT_FAILURE);
		}
		if (/EACCES/.test(msg)) {
			// Privileged-port permission is a config issue (won't fix on retry).
			process.stderr.write(
				`brigade-gateway: permission denied binding port ${port} (privileged ports require admin).\n` +
					`  - pick an unprivileged port: brigade gateway --port 7777\n`,
			);
			process.exit(EXIT_CONFIG_ERROR);
		}
		if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
			// Bad --host config (won't fix on retry).
			process.stderr.write(
				`brigade-gateway: couldn't resolve host "${opts.host ?? "default"}". Check the --host value and your DNS.\n`,
			);
			process.exit(EXIT_CONFIG_ERROR);
		}
		if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
			// Transient network — supervisor may retry.
			process.stderr.write(
				`brigade-gateway: no network route to ${opts.host ?? "default"}. Check your network / firewall / VPN.\n`,
			);
			process.exit(EXIT_FAILURE);
		}
		// Unrecognized failure — short message line; raw `msg` only when the
		// operator opts into BRIGADE_DEBUG=1.
		process.stderr.write(`brigade-gateway: failed to start the server.\n`);
		if (process.env.BRIGADE_DEBUG === "1") {
			process.stderr.write(`  (debug: ${msg})\n`);
		}
		process.exit(EXIT_FAILURE);
	}

	// Banner already printed by startServer (verbose path uses consoleStream;
	// quiet path writes the two plain lines). No additional banner needed here.

	// A subscription login stored without a refresh token dies a day or two after
	// onboarding (silent 401 mid-turn). First try to SELF-HEAL it from the vendor
	// CLI login (Claude Code) so it becomes auto-refreshing with no user action;
	// only warn about what we couldn't heal. Best-effort; never blocks boot.
	try {
		const { autoHealSubscriptions, detectUnrefreshableSubscriptions, formatUnrefreshableWarning } = await import(
			"../../auth/auth-health.js"
		);
		const healed = autoHealSubscriptions();
		if (healed.length > 0) {
			process.stderr.write(
				`brigade-gateway: re-synced ${healed.join(", ")} from your Claude Code login — auto-refreshing now (no action needed).\n`,
			);
		}
		const stale = detectUnrefreshableSubscriptions();
		if (stale.length > 0) {
			process.stderr.write(`\nbrigade-gateway: ${formatUnrefreshableWarning(stale)}\n\n`);
		}
	} catch {
		/* health check must never block gateway startup */
	}

	// Wire signal handlers so the listening socket gets released cleanly. The
	// shared chat command's SIGINT handler is process-wide; we install our own
	// here because the gateway runs without the TUI and never reaches that path.
	const onSignal = (sig: string): void => {
		process.stderr.write(`brigade-gateway: ${sig} received, shutting down\n`);
		void handle.stop().then(() => {
			// Gateway is headless and never enables raw mode itself, but the
			// readline prompt above (the no-config Y/N) momentarily borrows the
			// TTY. restoreTerminal() is idempotent and always safe — call it
			// before exit so the next shell prompt is clean even if we ever
			// add a richer interactive path here.
			restoreTerminal();
			process.exit(0);
		});
	};
	process.once("SIGTERM", () => onSignal("SIGTERM"));
	process.once("SIGINT", () => onSignal("SIGINT"));

	return handle.stop;
}
