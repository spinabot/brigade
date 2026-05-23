/**
 * `brigade onboard` — provider/model setup wizard, standalone.
 *
 * Boot the Pi-TUI wizard, write the chosen provider+model to brigade.json
 * and the API key to Brigade-native auth-profiles.json, tear down the TUI,
 * print a one-liner with what to do next, and exit.
 *
 * Mirrors the published v0.1.3 `src/cli/onboard-cmd.ts` UI shape exactly:
 * Pi-TUI arrow-key navigation, animated branding frames, the same step
 * sequence (provider → key → model → name), and the same success / cancel /
 * error messaging. The internals diverge in two small places, marked clearly
 * below — see "Brigade-native bridge".
 *
 * Re-onboarding: this command always runs the wizard. If a default model
 * is already saved, the wizard's existing flow lets the user pick a new one
 * (or Esc out without changes). We don't pre-emptively delete anything from
 * config — the wizard owns its own write semantics.
 */

import * as fsAsync from "node:fs/promises";
import process from "node:process";

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { Command } from "commander";

import { initAuthProfiles, upsertApiKeyProfile } from "../../auth/profiles.js";
import { DEFAULT_AGENT_ID, resolveAuthProfilesPath } from "../../config/paths.js";
import { BRIGADE_DIR, loadConfig, saveConfig } from "../../core/config.js";
import { EXIT_CONFIG_ERROR } from "../../protocol.js";
import { runOnboarding } from "../../ui/onboarding.js";
import { markTuiActive, restoreTerminal } from "../../ui/terminal-cleanup.js";

export interface OnboardCommandOptions {
	/**
	 * When true, the wizard ignores any API keys exported in the user's shell
	 * environment. Forces the typed-key prompt for every provider. Threaded
	 * through from the `--no-env-detect` CLI flag.
	 */
	noEnvDetect?: boolean;
	/**
	 * Storage shape for accepted env-key credentials. Mirrors OpenClaw's
	 * `--secret-input-mode` flag.
	 *   - "plaintext" (default) — copy the literal value into Brigade's state.
	 *   - "ref" — write a `keyRef` pointer; literal value never lands on disk.
	 * Threaded through from the `--secret-input-mode` CLI flag.
	 */
	secretInputMode?: "plaintext" | "ref";
}

/**
 * Run the onboarding wizard and exit. Resolves once the wizard completes
 * (success or cancellation) — no long-running event loop to keep alive.
 */
export async function runOnboardCommand(opts: OnboardCommandOptions = {}): Promise<number> {
	// Onboard uses prompts (raw mode + cursor manipulation) — opt into the
	// on-exit terminal cleanup so a Ctrl+C mid-wizard doesn't leave the
	// terminal in raw mode.
	markTuiActive();
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error(chalk.red("brigade onboard needs an interactive terminal."));
		console.error(
			chalk.dim(
				"To configure non-interactively, set provider env vars (e.g. OPENROUTER_API_KEY) and write\n" +
					"  ~/.brigade/brigade.json directly with `agents.defaults.model.primary` set.",
			),
		);
		return EXIT_CONFIG_ERROR;
	}

	const tui = new TUI(new ProcessTerminal());
	tui.start();

	// SIGINT during the wizard — clean exit, no half-written config (the
	// wizard's saveConfig only fires on a completed flow).
	const onSigint = (): void => {
		tui.stop();
		restoreTerminal();
		process.exit(130);
	};
	process.once("SIGINT", onSigint);

	// Ensure the auth-profiles.json scaffold exists before the wizard runs —
	// the bridge step at the end uses upsertApiKeyProfile which expects the
	// file to already be present at mode 0600. Cheap idempotent call.
	initAuthProfiles(DEFAULT_AGENT_ID);

	// One-shot prune of any leftover `~/.brigade/auth.json` from a prior
	// Brigade version that used Pi's `AuthStorage.create(<path>)` (which
	// writes `{}` on construction and mirrors set() to disk). The wizard now
	// uses `AuthStorage.inMemory()` so a fresh onboard never recreates this
	// file — but stale ones from older builds keep showing up in `ls
	// ~/.brigade/`, which surprised the user. Mirror OpenClaw: there's no
	// `auth.json`, only `auth-profiles.json`. Best-effort delete; missing
	// or unreadable file is fine.
	try {
		const fsSync = require("node:fs") as typeof import("node:fs");
		const stalePath = `${BRIGADE_DIR}/auth.json`;
		if (fsSync.existsSync(stalePath)) fsSync.unlinkSync(stalePath);
	} catch {
		/* best-effort */
	}

	// IN-MEMORY authStorage — never writes to disk. The wizard owns ALL
	// persistence by writing directly to `~/.brigade/agents/<id>/agent/auth-profiles.json`
	// (via `upsertApiKeyProfile` / `upsertApiKeyRefProfile`). Pi's
	// `AuthStorage.create(path)` would write `{}` to `~/.brigade/auth.json`
	// on construction AND mirror every `set()` to disk — that produced an
	// orphaned `auth.json` file on every onboard run AND leaked the literal
	// API key to a second on-disk location in ref mode. OpenClaw doesn't
	// have an `auth.json` at all; mirror that.
	//
	// `set()` in memory is still useful: it lets the wizard process see the
	// key for the rest of the run (online validation already takes the key
	// as a string, so it doesn't read authStorage; but `ModelRegistry` does
	// when discovering provider models for the picker).
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.create(authStorage, `${BRIGADE_DIR}/models.json`);

	try {
		const result = await runOnboarding(tui, authStorage, modelRegistry, {
			noEnvDetect: opts.noEnvDetect,
			secretInputMode: opts.secretInputMode,
		});
		tui.stop();
		restoreTerminal();

		// ─────────────────── Brigade-native bridge ───────────────────
		// The lifted runOnboarding writes:
		//   1. The API key into Pi's auth.json (via authStorage.set)
		//   2. brigade.json with the legacy flat keys defaultProvider /
		//      defaultModelId (line 144 in src/ui/onboarding.ts)
		//
		// Brigade's runtime (Primitive #1's agent-loop, the lifted chat/
		// gateway, doctor, status) all read:
		//   1. The API key from `~/.brigade/agents/main/agent/auth-profiles.json`
		//      (resolveAuthProfilesPath + readBrigadeCredentials)
		//   2. brigade.json's `agents.defaults.{provider, model.primary}` shape
		//
		// We bridge here so the chosen provider/model land in the canonical
		// places without requiring a patch to the byte-identical lifted UI.
		await bridgeOnboardingResultToBrigadeNative({
			provider: result.provider,
			modelId: result.modelId,
			authStorage,
		});

		console.error(
			chalk.dim(
				`\n✓ onboarded — provider: ${chalk.bold(result.provider)} · model: ${chalk.bold(result.modelId)}\n` +
					`Next: run ${chalk.bold("brigade gateway")} (then ${chalk.bold("brigade connect")} in a second terminal),\n` +
					`      or ${chalk.bold("brigade")} for the in-process TUI.\n` +
					`Shell access: ${chalk.bold("bash is gated")} — agents must ask before running commands.\n` +
					`              Approve with ${chalk.bold('brigade exec allow "<cmd>"')} ` +
					`(${chalk.bold("brigade exec list")} to see what's approved).\n` +
					`              Read/grep/find/ls are open — they never need approval.\n`,
			),
		);
		return 0;
	} catch (err) {
		tui.stop();
		restoreTerminal();
		const msg = err instanceof Error ? err.message : String(err);
		// `runOnboarding` throws "onboarding-cancelled" when the user hits Esc
		// on the provider picker — surface that as a friendly message, not a
		// crash. Any other error propagates as a real failure.
		if (msg === "onboarding-cancelled") {
			console.error(chalk.dim("Onboarding cancelled — run `brigade onboard` again any time."));
			return 0;
		}
		console.error(chalk.red(`Onboarding failed: ${msg}`));
		return 1;
	}
}

/**
 * Bridge the post-wizard state into Brigade-native storage.
 *
 *   - Pi auth.json → Brigade auth-profiles.json (so the runtime sees the key
 *     via auth-bridge / readAuthProfilesAsCredentialMap).
 *   - brigade.json `defaultProvider`/`defaultModelId` → `agents.defaults.
 *     {provider, model.primary}` (so chat/gateway/status read the right
 *     shape).
 *
 * Both writes are idempotent and tolerate a wizard re-run that flips
 * provider/model — first-wins semantics on the auth side keep things sane.
 */
async function bridgeOnboardingResultToBrigadeNative(args: {
	provider: string;
	modelId: string;
	authStorage: AuthStorage;
}): Promise<void> {
	// Credential-mirror step: the wizard now owns ALL credential persistence
	// (typed-paste, env-accept, env-auto-select all call `upsertApiKeyProfile`
	// or `upsertApiKeyRefProfile` directly inside `runOnboarding`). This bridge
	// used to re-write the profile by reading `authStorage.getApiKey` — but
	// that's a literal value, so re-writing would CLOBBER any keyRef profile
	// the wizard just persisted in `--secret-input-mode ref`, defeating ref
	// mode entirely.
	//
	// Defensive net only: if (and ONLY if) the wizard somehow didn't write a
	// profile for this provider (e.g. a code path that pre-dates the direct
	// upsert), do a one-time mirror so the user isn't left without a credential.
	// Any existing profile (literal `key` OR `keyRef`) is left untouched.
	try {
		const profilesPath = resolveAuthProfilesPath(DEFAULT_AGENT_ID);
		let providerHasProfile = false;
		try {
			const raw = await fsAsync.readFile(profilesPath, "utf8");
			const parsed = JSON.parse(raw) as {
				profiles?: Record<string, { provider?: string; key?: string; keyRef?: unknown }>;
			};
			providerHasProfile = Object.values(parsed.profiles ?? {}).some(
				(p) => p?.provider === args.provider && (p.key !== undefined || p.keyRef !== undefined),
			);
		} catch {
			// No file yet or unreadable — fall through; the upsert below creates it.
		}
		if (!providerHasProfile) {
			const key = await args.authStorage.getApiKey(args.provider);
			if (typeof key === "string" && key.length > 0) {
				upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: args.provider, key });
			}
		}
	} catch (err) {
		// Don't block onboarding success on the bridge failing — surface a
		// breadcrumb instead. The user can re-run `brigade onboard` to
		// retry, or hand-edit auth-profiles.json themselves.
		process.stderr.write(
			chalk.yellow(
				`\nbrigade: warning — couldn't verify auth-profiles.json: ${(err as Error).message}\n`,
			),
		);
	}

	// Migrate brigade.json's flat shape (written by ui/onboarding.ts:144) into
	// the agents.defaults shape that the rest of Brigade reads. We don't
	// delete the legacy keys — leaving them around as a no-op is safer than
	// touching fields the user may have hand-edited.
	try {
		const cfg = loadConfig() as Record<string, unknown>;
		const agents = (cfg.agents as Record<string, unknown> | undefined) ?? {};
		const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {};
		const model = (defaults.model as Record<string, unknown> | undefined) ?? {};
		defaults.provider = args.provider;
		model.primary = args.modelId;
		defaults.model = model;
		agents.defaults = defaults;
		cfg.agents = agents;
		saveConfig(cfg as never);
	} catch (err) {
		process.stderr.write(
			chalk.yellow(
				`\nbrigade: warning — couldn't update brigade.json: ${(err as Error).message}\n`,
			),
		);
	}
}

/**
 * Commander registrar — declared at the program level so `brigade --help`
 * lists the subcommand. The action handler is dynamic-imported in
 * build-program.ts to keep the command's import graph (Pi TUI + onboarding
 * wizard) out of the cold-start path for unrelated commands.
 */
export function registerOnboardCommand(program: Command): void {
	program
		.command("onboard")
		.description("Pick a provider and model — interactive Pi-TUI wizard")
		.option("--no-env-detect", "ignore API keys from the shell environment", false)
		.action(async (opts: { envDetect?: boolean }) => {
			const code = await runOnboardCommand({ noEnvDetect: opts.envDetect === false });
			process.exit(code);
		});
}
