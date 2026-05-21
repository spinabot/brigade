/**
 * `brigade chat` — the default surface. A thin WebSocket client to the
 * Brigade gateway (the single per-turn runtime).
 *
 * As of the single-path refactor, `brigade chat` no longer hosts its own Pi
 * session. It mirrors OpenClaw, where the TUI is always a client and the
 * gateway daemon owns the agent loop. The boot flow is:
 *
 *   1. Refuse non-TTY environments (the TUI needs a real terminal).
 *   2. Require a configured provider/model (point at `brigade onboard`).
 *   3. Ensure a gateway is running — spawn a DETACHED one if none is up.
 *      The spawned daemon persists after this chat exits, so the next
 *      `brigade chat` / `brigade connect` reattaches instantly.
 *   4. Hand off to the shared connect TUI (`runConnectCommand`), which opens
 *      the WebSocket, renders the live chat, and forwards input as requests.
 *
 * Every turn therefore runs through the gateway's per-turn execution path —
 * the same `runResilientTurn` that `brigade agent` uses — so exec-gating,
 * memory tools, persona injection, and model-family identity guidance behave
 * identically on every surface. There is no second runtime.
 */

import process from "node:process";

import chalk from "chalk";

import { loadConfig } from "../../core/config.js";
import { ensureGatewayRunning } from "../../core/gateway-spawn.js";
import { DEFAULT_PORT, EXIT_CONFIG_ERROR } from "../../protocol.js";
import { type ConnectHandle, runConnectCommand } from "./connect.js";

export interface ChatCommandOptions {
	/** Gateway host to connect to / spawn on. Default: 127.0.0.1 */
	host?: string;
	/** Gateway port. Default: BRIGADE_PORT env or 7777. */
	port?: number;
	/**
	 * Retained for CLI back-compat (`--no-env-detect`). Onboarding now lives
	 * in `brigade onboard`, so chat no longer runs the wizard — this flag is
	 * accepted but has no effect on the client path.
	 */
	noEnvDetect?: boolean;
}

/**
 * Boot `brigade chat`: ensure a gateway is up, then attach the connect TUI.
 * Resolves with the connect handle once the UI is wired; the chat runs until
 * SIGINT / Ctrl+D / `/exit` (handled inside `runConnectCommand`).
 */
export async function runChatCommand(opts: ChatCommandOptions = {}): Promise<ConnectHandle> {
	const host = opts.host ?? "127.0.0.1";
	const port = opts.port ?? (Number(process.env.BRIGADE_PORT) || DEFAULT_PORT);

	// A TUI needs a real terminal on both ends. In a non-TTY environment
	// (CI, piped stdin, redirected stdout) the editor would block forever, so
	// fail loudly with a fixable instruction instead of hanging the process.
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error(chalk.red("brigade chat needs an interactive terminal."));
		console.error(
			chalk.dim(
				"For non-interactive use, drive the gateway directly: `brigade gateway`, then `brigade agent -m \"…\"`.",
			),
		);
		// Sysexits 78: a usage/config error that won't fix on retry — supervisors
		// should STOP, not restart-loop.
		process.exit(EXIT_CONFIG_ERROR);
	}

	// Refuse to chat without a configured model. The gateway also enforces
	// this on boot, but checking here lets us give a clean message BEFORE we
	// spawn a daemon that would immediately exit on missing config.
	//
	// F:\Brigade's brigade.json (post-2026-05 wizard) stores the default under
	// `agents.defaults.{provider, model.primary}`.
	const config = await loadConfig();
	const wizardDefaults = (config.agents as { defaults?: { provider?: string; model?: { primary?: string } } } | undefined)?.defaults;
	const provider = wizardDefaults?.provider;
	const modelId = wizardDefaults?.model?.primary;
	if (!provider || !modelId) {
		console.error(chalk.red("✗ Brigade isn't set up yet — no provider/model configured."));
		console.error(chalk.dim(`Run ${chalk.bold("brigade onboard")} first to pick a provider + model.`));
		process.exit(EXIT_CONFIG_ERROR);
	}

	// Ensure a gateway is running, spawning a detached one if needed. The
	// spawned daemon persists after we exit (the OpenClaw-style lifecycle).
	try {
		const result = await ensureGatewayRunning({
			host,
			port,
			onStatus: (message) => process.stderr.write(chalk.dim(`${message}\n`)),
		});
		if (!result.alreadyRunning) {
			process.stderr.write(chalk.dim(`Brigade service ready on ws://${host}:${port}\n`));
		}
	} catch (err) {
		console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
		process.exit(EXIT_CONFIG_ERROR);
	}

	// Hand off to the shared connect TUI. From here `brigade chat` and
	// `brigade connect` are the same client; the only difference is chat
	// auto-spawned the gateway it talks to.
	return runConnectCommand({ host, port });
}
