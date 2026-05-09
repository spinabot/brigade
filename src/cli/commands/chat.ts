/**
 * `brigade chat` — in-process TUI + Pi session in a single process.
 *
 * This is the default subcommand and the simplest path: one terminal, one
 * process, no gateway, full feature set. Everything the user sees in the
 * conversation runs through the local Pi loop with the 6-layer wrapper
 * composition wired in src/ui/chat.ts.
 *
 * Wraps the original boot flow (auth + model resolution → onboarding-if-needed
 * → buildAgent → runChat) and surfaces a clean SIGINT chain so Ctrl+C aborts
 * a turn first, exits second.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";

import { type AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import chalk from "chalk";

import { buildAgent } from "../../core/agent.js";
import { loadBrigadeAuthStorage } from "../../core/auth-bridge.js";
import { BRIGADE_DIR, getBrigadeWorkspaceDir, loadConfig } from "../../core/config.js";
import { attachEventLogger, getTodayLogPath } from "../../core/event-logger.js";
import { findProvider } from "../../providers/catalog.js";
import { EXIT_CONFIG_ERROR } from "../../protocol.js";
import { type ChatHandle, runChat } from "../../ui/chat.js";
import { restoreTerminal } from "../../ui/terminal-cleanup.js";

export interface ChatCommandOptions {
	/** Override cwd. Defaults to process.cwd(). Used by tests. */
	cwd?: string;
	/**
	 * When true, the onboarding wizard ignores any API keys exported in the
	 * user's shell environment. Forces the typed-key prompt for every provider.
	 * Threaded through from the `--no-env-detect` CLI flag on `brigade chat`
	 * and `brigade onboard`.
	 */
	noEnvDetect?: boolean;
}

/**
 * Boot the in-process chat TUI. Returns once the editor is ready; the chat
 * runs until SIGINT/Ctrl+D/`/exit`. Resolves with the chat handle in case
 * the caller wants to introspect or wire additional signal handlers.
 */
export async function runChatCommand(opts: ChatCommandOptions = {}): Promise<ChatHandle> {
	const cwd = opts.cwd ?? process.cwd();

	// Refuse to boot in a non-TTY environment (CI, piped stdin, redirected
	// stdout) — the onboarding wizard would block forever waiting for keystrokes
	// that never arrive. Better to fail loudly with a fixable instruction than
	// hang the parent process indefinitely.
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error(chalk.red("brigade chat needs an interactive terminal."));
		console.error(
			chalk.dim(
				"For non-interactive use, set up your provider first via env vars or `brigade config set`, then call brigade in a TTY.",
			),
		);
		// Sysexits 78: this is a configuration/usage error that won't fix on
		// retry. Supervisors should STOP, not restart-loop.
		process.exit(EXIT_CONFIG_ERROR);
	}

	// Boot the TUI renderer FIRST. From this point on, addChild/requestRender
	// actually paint to the screen. Onboarding, splash, and chat all depend on it.
	const tui = new TUI(new ProcessTerminal());
	tui.start();

	// Wire the SIGINT handler IMMEDIATELY — before splash, onboarding, or chat.
	// Without this, Ctrl+C during the splash or onboarding wizard would crash with
	// `chat is undefined`. We hold a mutable ChatHandle reference that gets filled
	// in once runChat() returns, and the handler delegates to it when present.
	let chatHandle: ChatHandle | null = null;
	// Re-entrant SIGINT handler: first Ctrl+C aborts a running turn (handler
	// stays attached so a SECOND Ctrl+C in idle state quits). We re-arm with
	// process.once after each turn-abort so handlers never stack across
	// re-invocations of runChatCommand within the same process (matters for
	// tests and for any future supervisor that might restart the chat).
	const onSigint = (): void => {
		if (chatHandle) {
			const wasRunning = chatHandle.abort();
			if (!wasRunning) {
				tui.stop();
				// Belt-and-braces: tui.stop() runs Pi-TUI's cleanup which
				// covers the kitty pop in the happy path. We follow it with
				// an explicit restoreTerminal() so the broader safety net
				// (focus reporting, mouse, alt-screen, modifyOtherKeys)
				// also fires before we hand control back to the shell.
				restoreTerminal();
				process.exit(0);
			}
			// A turn was aborted — re-arm so the next Ctrl+C is heard.
			process.once("SIGINT", onSigint);
			return;
		}
		// During splash / onboarding (no chat yet): clean exit.
		tui.stop();
		restoreTerminal();
		process.exit(130); // 128 + SIGINT
	};
	process.once("SIGINT", onSigint);

	// Read auth from Brigade's `~/.brigade/agents/main/agent/auth-profiles.json`
	// (where `brigade onboard` actually writes), NOT from Pi's vanilla
	// `${BRIGADE_DIR}/auth.json` default. Without the bridge, chat would never
	// see the keys onboarding produced.
	const authStorage = loadBrigadeAuthStorage() as AuthStorage;
	const modelRegistry = ModelRegistry.create(authStorage, `${BRIGADE_DIR}/models.json`);

	// Try saved config + existing key first.
	// F:\Brigade's brigade.json (post 2026-05-02 wizard refactor) stores the
	// default model under `agents.defaults.{provider, model.primary}` to
	// mirror the reference shape. The lifted code expected the older
	// flat `config.defaultProvider` / `config.defaultModelId` fields, so we
	// read the new shape here and project to local string vars.
	const config = await loadConfig();
	const wizardDefaults = (config.agents as { defaults?: { provider?: string; model?: { primary?: string } } } | undefined)?.defaults;
	let provider: string | undefined = wizardDefaults?.provider;
	let modelId: string | undefined = wizardDefaults?.model?.primary;
	let model = provider && modelId ? modelRegistry.find(provider, modelId) : undefined;

	if (model && provider) {
		// Skip the saved-key check for noAuth providers (Ollama, LM Studio) —
		// they don't store anything in AuthStorage. The model registration in
		// models.json is itself the persistence mechanism.
		const providerInfo = findProvider(provider);
		if (!providerInfo?.noAuth) {
			const apiKey = await authStorage.getApiKey(provider);
			if (!apiKey) {
				model = undefined; // saved model but no key — re-onboard
			}
		}
	}

	// Snapshot whether BOOTSTRAP.md exists BEFORE we touch the workspace.
	// `buildAgent` calls `seedDefaultPrompts` (idempotent — only writes files
	// that don't exist), which means by the time the chat is wired BOOTSTRAP.md
	// will exist regardless. Capturing the pre-boot state is the only honest
	// way to tell "this is the user's very first run" from "the user previously
	// completed bootstrap and explicitly deleted BOOTSTRAP.md to mark it done."
	// We only fire the first-run kickoff in the former case.
	const bootstrapPathBefore = path.join(getBrigadeWorkspaceDir(), "BOOTSTRAP.md");
	let bootstrapExistedBeforeBoot = true;
	try {
		await fs.stat(bootstrapPathBefore);
	} catch {
		bootstrapExistedBeforeBoot = false;
	}

	// Refuse to chat without a configured model. Brigade used to inline the
	// onboarding wizard here as a convenience, but that bundled "set up the
	// agent" with "talk to the agent" in a single command — making the
	// gateway+connect path harder to test in isolation (you'd never get a
	// chance to JUST onboard without ending up in a chat TUI). Now the
	// lifecycle is explicit:
	//
	//   brigade onboard      → wizard, then exit
	//   brigade chat         → refuses if no model, points at `brigade onboard`
	//   brigade gateway      → same refusal
	//
	// Mirrors the reference's onboard / gateway / TUI separation.
	if (!model || !provider || !modelId) {
		tui.stop();
		restoreTerminal();
		console.error(chalk.red("✗ Brigade isn't set up yet — no provider/model configured."));
		console.error(chalk.dim(`Run ${chalk.bold("brigade onboard")} first to pick a provider + model.`));
		process.exit(EXIT_CONFIG_ERROR);
	}
	// After the guard, all three are definitely defined — narrow for the
	// runChat() call below which expects `string` for provider + modelId.
	const providerStr: string = provider;
	const modelIdStr: string = modelId;
	// No first-run kickoff. Brigade used to auto-fire "Wake up, my friend!" on
	// fresh-workspace boots so the agent's BOOTSTRAP.md flow would trigger
	// without the user having to type. Removed to mirror OpenClaw — its TUI
	// never auto-sends a synthetic first turn; the user types the first
	// message themselves.

	// Build the Pi agent session. Note: do NOT overwrite session.agent.streamFn —
	// createAgentSession installs an auth-aware wrapper that resolves the API key
	// from modelRegistry and attaches Authorization headers per request. Replacing
	// it with raw streamSimple strips the auth and requests silently 401.
	const session = await buildAgent({
		authStorage,
		modelRegistry,
		model,
		cwd,
	});

	// Stream every Pi event to ~/.brigade/logs/<date>.jsonl. Brigade's only
	// log sink — when something goes wrong (hang, hallucination, mid-turn
	// switch confusion) the user can grep today's file.
	attachEventLogger(session);
	process.stderr.write(`\x1b[2mlogs: ${getTodayLogPath()}\x1b[0m\n`);

	// Hand off to the chat TUI. runChat returns a ChatHandle synchronously once
	// the UI is wired — the editor's onSubmit drives subsequent turns until
	// /exit, Ctrl+D, or SIGINT (already wired above) tears it down.
	chatHandle = await runChat({
		session,
		tui,
		provider: providerStr,
		modelId: modelIdStr,
		authStorage,
		modelRegistry,
		// First-run discoverability tip ONLY when the workspace is truly
		// fresh (BOOTSTRAP.md didn't exist before this boot). Returning
		// users never see the slash-command hint on every boot.
		firstRun: !bootstrapExistedBeforeBoot,
	});
	return chatHandle;
}
