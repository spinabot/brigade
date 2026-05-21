/**
 * Gateway auto-spawn — ensure a Brigade gateway daemon is running, starting a
 * detached one if not.
 *
 * `brigade chat` is a thin WebSocket client to the gateway (the single
 * per-turn runtime). When the user runs `brigade chat` and no gateway is up,
 * we spawn one as a DETACHED background process so it survives the chat
 * session — later `brigade chat` / `brigade connect` reattach to the same
 * daemon instantly. This mirrors OpenClaw, whose native apps manage a
 * long-lived gateway subprocess (macOS `GatewayProcessManager`) and whose
 * TUI is always a client, never the agent host.
 *
 * The spawned daemon is independent: we `unref()` it so the parent (chat)
 * can exit without tearing it down. Stopping it is explicit:
 * `brigade gateway stop`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";

import { DEFAULT_PORT } from "../protocol.js";
import { probeGateway } from "./gateway-probe.js";

const SPAWN_POLL_INTERVAL_MS = 250;
const DEFAULT_SPAWN_TIMEOUT_MS = 20_000;
/** Quick probe budget — local boot answers fast; keep the wait responsive. */
const PROBE_TIMEOUT_MS = 1000;

export interface EnsureGatewayOptions {
	host?: string;
	port?: number;
	/** Max ms to wait for a freshly-spawned gateway to accept connections. */
	spawnTimeoutMs?: number;
	/** Surface boot progress (e.g. to stderr) while we wait for readiness. */
	onStatus?: (message: string) => void;
}

export interface EnsureGatewayResult {
	/** True when a gateway was already running (we did NOT spawn one). */
	alreadyRunning: boolean;
	host: string;
	port: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve the argv that re-execs THIS brigade install as a gateway daemon.
 *
 * Installed mode: `process.argv[1]` is `brigade.mjs`, so the daemon is
 * `node brigade.mjs gateway run …` — the exact same binary the user invoked.
 *
 * Escape hatch (dev + tests): `BRIGADE_GATEWAY_SPAWN_ARGV`, a JSON string
 * array `[cmd, ...args]`, overrides the command entirely. Dev runs from a
 * `.ts` entry under tsx can't be re-exec'd by plain `node`, so we detect that
 * and surface a clear "start it manually" error instead of spawning a process
 * that would crash on the TypeScript syntax.
 */
function resolveGatewaySpawnArgv(host: string, port: number): { cmd: string; args: string[] } {
	const override = process.env.BRIGADE_GATEWAY_SPAWN_ARGV?.trim();
	if (override) {
		try {
			const parsed = JSON.parse(override) as unknown;
			if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string") {
				const cmd: string = parsed[0];
				const rest = (parsed.slice(1) as unknown[]).map((v) => String(v));
				// Override is taken VERBATIM — we do NOT append --port/--host.
				// The port reaches the override via the `BRIGADE_PORT` env var
				// (set in spawnDetachedGateway), which the gateway honours. This
				// keeps the override usable with arbitrary launchers (and test
				// stubs like `node -e "…"` that would choke on trailing flags).
				return { cmd, args: rest };
			}
		} catch {
			// Malformed override — fall through to the default re-exec.
		}
	}
	const entry = process.argv[1] ?? "";
	if (/\.tsx?$/.test(entry)) {
		throw new Error(
			"can't auto-start the Brigade service from a TypeScript dev entry. " +
				"Start it manually in another terminal: `npm run dev gateway run` " +
				"(or set BRIGADE_GATEWAY_SPAWN_ARGV).",
		);
	}
	return {
		cmd: process.execPath,
		args: [entry, "gateway", "run", "--quiet", "--port", String(port), "--host", host],
	};
}

function spawnDetachedGateway(host: string, port: number): ChildProcess {
	const { cmd, args } = resolveGatewaySpawnArgv(host, port);
	return spawn(cmd, args, {
		// Detach so the daemon outlives the chat process (the user chose the
		// persistent, OpenClaw-style lifecycle). `stdio: "ignore"` because the
		// daemon writes to its own JSONL log + console stream, not our TTY.
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: { ...process.env, BRIGADE_PORT: String(port) },
	});
	// NOTE: caller attaches error/exit listeners and `unref()`s once readiness
	// is established (see ensureGatewayRunning). We must NOT unref here, or a
	// spawn `error` event would go unhandled and crash the parent.
}

/**
 * Ensure a gateway is reachable at host:port. If one is already up, return
 * immediately. Otherwise spawn a detached daemon and poll until it accepts
 * connections (or the timeout elapses). Throws a friendly error on timeout.
 *
 * The caller is expected to have already verified a provider/model is
 * configured — a gateway with no config exits on boot, which would surface
 * here as a readiness timeout.
 */
export async function ensureGatewayRunning(opts: EnsureGatewayOptions = {}): Promise<EnsureGatewayResult> {
	const host = opts.host ?? "127.0.0.1";
	const port = opts.port ?? (Number(process.env.BRIGADE_PORT) || DEFAULT_PORT);
	const timeoutMs = opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;

	const existing = await probeGateway({ host, port, timeoutMs: PROBE_TIMEOUT_MS });
	if (existing.reachable) return { alreadyRunning: true, host, port };

	opts.onStatus?.("starting Brigade service…");
	const child = spawnDetachedGateway(host, port);

	// Watch the child for failure signals so we fail FAST + LOUD instead of
	// dead-waiting the full timeout. Without an `error` listener the event is
	// unhandled and crashes the parent (chat); without the `exit` watch, a
	// daemon that dies on boot (bad key, port held by a non-Brigade process,
	// model not in registry) would just silently never appear and we'd time out.
	// `stdio` is "ignore", so the exit CODE is the only signal we get — point
	// the user at `brigade gateway` (foreground, verbose) for the real reason.
	let spawnError: Error | undefined;
	let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	const onError = (err: Error): void => {
		spawnError = err;
	};
	const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
		earlyExit = { code, signal };
	};
	child.once("error", onError);
	child.once("exit", onExit);

	try {
		const deadline = Date.now() + timeoutMs;
		let lastError = existing.error;
		while (Date.now() < deadline) {
			if (spawnError) {
				throw new Error(
					`couldn't start the Brigade service: ${spawnError.message}. ` +
						"Try starting it manually: `brigade gateway`.",
				);
			}
			if (earlyExit) {
				const detail =
					earlyExit.code != null ? `exit code ${earlyExit.code}` : `signal ${earlyExit.signal}`;
				throw new Error(
					`the Brigade service stopped right after starting (${detail}). ` +
						"Run `brigade gateway` in this terminal to see why " +
						"(usually an auth/key, port, or model-config issue).",
				);
			}
			await sleep(SPAWN_POLL_INTERVAL_MS);
			const probe = await probeGateway({ host, port, timeoutMs: PROBE_TIMEOUT_MS });
			if (probe.reachable) return { alreadyRunning: false, host, port };
			lastError = probe.error;
		}
		throw new Error(
			`the Brigade service didn't come online within ${Math.round(timeoutMs / 1000)}s` +
				(lastError ? ` (last error: ${lastError})` : "") +
				". Try starting it manually to see why: `brigade gateway`.",
		);
	} finally {
		// Stop tracking the child and release the parent's handle so chat can
		// exit independently of the (now detached, persistent) daemon. Done in
		// `finally` so success, early-exit, and timeout paths all unref cleanly.
		child.removeListener("error", onError);
		child.removeListener("exit", onExit);
		// Keep a no-op error sink so a LATE async spawn error (after we've
		// stopped watching) can't resurface as an unhandled 'error' crash.
		child.on("error", () => {});
		child.unref();
	}
}
