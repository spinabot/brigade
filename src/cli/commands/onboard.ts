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

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { Command } from "commander";

import { initAuthProfiles, readProfiles, upsertApiKeyProfile } from "../../auth/profiles.js";
import { DEFAULT_AGENT_ID, resolveModelsPath } from "../../config/paths.js";
import { BRIGADE_DIR, loadConfig, saveConfig } from "../../core/config.js";
import { EXIT_CONFIG_ERROR } from "../../protocol.js";
import { bootRuntimeContext } from "../../storage/boot.js";
import { flushAllPendingWrites } from "../../storage/flush.js";
import { deleteSentinel, readSentinel, sentinelExists, writeSentinel, writeSentinelNow } from "../../storage/sentinel.js";
import type { ModeSentinel } from "../../storage/runtime-context.js";
import { probeTerminalAnimationSupport } from "../../ui/animations.js";
import { pickStorageMode, type StorageModeResult } from "../../ui/onboard-storage-mode.js";
import { runOnboarding } from "../../ui/onboarding.js";
import { markTuiActive, restoreTerminal } from "../../ui/terminal-cleanup.js";
import { applyOnboardingSessionDefaults, ONBOARDING_DEFAULT_DM_SCOPE } from "./onboard-config.js";

export interface OnboardCommandOptions {
	/**
	 * When true, the wizard ignores any API keys exported in the user's shell
	 * environment. Forces the typed-key prompt for every provider. Threaded
	 * through from the `--no-env-detect` CLI flag.
	 */
	noEnvDetect?: boolean;
	/**
	 * Storage shape for accepted env-key credentials, switched by the
	 * `--secret-input-mode` CLI flag.
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

	// Ask the terminal whether it can repaint atomically (DECRQM 2026) while
	// stdin is still ours — decides animated vs static chrome. ≤150 ms once.
	await probeTerminalAnimationSupport();

	// Stop any running gateway BEFORE the wizard touches local state. The
	// factory-reset primitive (behind a "Clear it" / "Start fresh" pick) requires
	// it: a live daemon holds open handles under ~/.brigade, and on Windows
	// deleting an open file throws EPERM and aborts the wizard mid-wipe (POSIX
	// silently allows it — which is why this bit Windows and not macOS/Linux).
	// Lazy-imported so onboard's boot stays light; best-effort + quiet when
	// nothing is running. Onboard already tells the user to (re)start the gateway
	// at the end, so stopping a stale one here changes nothing they didn't expect.
	try {
		const { readPid, isProcessAlive } = await import("../../core/gateway-probe.js");
		const pid = await readPid();
		if (pid && isProcessAlive(pid)) {
			process.stdout.write(
				chalk.dim("Stopping the running gateway so onboarding can reset state cleanly…\n"),
			);
			const { runGatewayStopCommand } = await import("./gateway.js");
			await runGatewayStopCommand({ json: false });
		}
	} catch {
		// If we can't stop it, continue anyway — the wipe now preserves the runtime
		// + convex store, so a reset still can't uninstall the CLI or lose data.
	}

	const tui = new TUI(new ProcessTerminal());
	tui.start();

	// Snapshot the PRE-RUN sentinel so ANY aborted run (Esc, error, backend
	// connect failure, Ctrl+C) restores the machine's previous mode pin
	// exactly. persistStorageMode below OVERWRITES a pre-existing pin with the
	// new pick, so a delete-if-created rollback is not enough — a re-onboard
	// that switched modes and then cancelled would silently flip the machine's
	// mode (filesystem operator curiosity-picks convex, Escs out, next boot is
	// an empty convex crew). A corrupt pre-run sentinel reads as "none";
	// rollback then deletes — the same self-heal the old flow got by
	// overwriting the corrupt file at the end.
	let priorSentinel: ModeSentinel | undefined;
	try {
		priorSentinel = readSentinel();
	} catch {
		priorSentinel = undefined;
	}
	let onboardSettled = false;
	const rollbackSentinel = (): void => {
		if (onboardSettled) return;
		try {
			if (priorSentinel) writeSentinel(priorSentinel);
			else deleteSentinel();
		} catch {
			// Best-effort — a stuck pin surfaces on the next `store mode show`.
		}
	};

	// SIGINT during the wizard — clean exit, no half-written config (the
	// wizard's saveConfig only fires on a completed flow).
	const onSigint = (): void => {
		tui.stop();
		restoreTerminal();
		// An interrupted run must not leave a half-configured mode pin (same
		// rule as the cancel/error paths below); no-op after success.
		rollbackSentinel();
		// Once the convex context is up, a just-entered key rides a write-behind
		// chain — drain it before exiting so Ctrl+C can't silently drop it. 2s
		// safety net so a wedged flush never hangs the abort.
		const t = setTimeout(() => process.exit(130), 2000);
		t.unref?.();
		void flushAllPendingWrites().finally(() => process.exit(130));
	};
	process.once("SIGINT", onSigint);

	// ───────────────── Step 0 + runtime context (FIRST) ─────────────────
	// Pick the storage mode, pin the sentinel, and boot the runtime context
	// BEFORE any auth/config/model write. The wizard used to run end-to-end in
	// filesystem mode and flip the sentinel LAST — so a convex pick wrote the
	// provider key + config + web-search key PLAINTEXT under ~/.brigade and
	// left the convex backend empty. Establishing the context here means every
	// downstream upsertApiKeyProfile / saveConfig / models-catalog write
	// dispatches sealed into convex (filesystem mode is byte-identical).
	let storage: StorageModeResult;
	try {
		storage = await pickStorageMode(tui);
	} catch (err) {
		const m = (err as Error).message;
		if (m === "storage-mode-revert-to-filesystem") {
			storage = { mode: "filesystem" };
		} else {
			tui.stop();
			restoreTerminal();
			if (m === "onboarding-cancelled") {
				console.error(chalk.dim("Onboarding cancelled — run `brigade onboard` again any time."));
				return 0;
			}
			throw err;
		}
	}

	// Pin the sentinel, then boot. In convex mode bootRuntimeContext runs the
	// encryption-fingerprint check, installs the strict guard, and primes the
	// config cache (without which readConfigOrInit throws). The pre-run pin was
	// snapshotted above; every abort path below restores it via
	// rollbackSentinel so no aborted run can leave the mode switched.
	persistStorageMode(storage);
	// persistStorageMode is warn-only by design; but a convex pick whose
	// sentinel never landed would silently boot FILESYSTEM below (resolveMode
	// finds no pin) and run the whole wizard in the wrong mode. Fail loudly
	// instead — the warning above already printed the retry command.
	if (storage.mode === "convex" && !sentinelExists()) {
		tui.stop();
		restoreTerminal();
		return EXIT_CONFIG_ERROR;
	}
	try {
		await bootRuntimeContext();
	} catch (err) {
		tui.stop();
		restoreTerminal();
		rollbackSentinel();
		console.error(
			chalk.red(`Onboarding failed — couldn't connect the storage backend: ${(err as Error).message}`),
		);
		if (storage.mode === "convex") {
			console.error(
				chalk.dim(`Make sure your backend is running at ${storage.convexUrl}, then re-run brigade onboard.`),
			);
		}
		return EXIT_CONFIG_ERROR;
	}

	// Now mode-aware. Convex → initAuthProfiles primes empty in-memory caches
	// (no disk files); filesystem → scaffolds auth-profiles.json at 0600 as
	// before (the bridge's defensive upsert expects a readable profile store).
	initAuthProfiles(DEFAULT_AGENT_ID);

	// One-shot prune of any leftover `~/.brigade/auth.json` from a prior Brigade
	// version (Pi's `AuthStorage.create(<path>)` wrote `{}` on construction and
	// mirrored set() to disk). The wizard now uses `AuthStorage.inMemory()`, so
	// a fresh onboard never recreates it — but stale copies surprised the user
	// in `ls ~/.brigade/`. Best-effort async unlink. (The old `require("node:
	// fs")` here was dead code — this module is ESM, so `require` threw and the
	// prune never ran.)
	try {
		await fsAsync.unlink(`${BRIGADE_DIR}/auth.json`);
	} catch {
		/* missing / unreadable is fine */
	}

	// IN-MEMORY authStorage — never writes to disk. The wizard owns ALL
	// persistence via `upsertApiKeyProfile` / `upsertApiKeyRefProfile`, which
	// now dispatch into convex (sealed) because the context is live. `set()` in
	// memory still lets the wizard process reuse the key for model discovery.
	// The ModelRegistry is created AFTER the context so `resolveModelsPath`
	// resolves to the convex OS-cache location, not ~/.brigade/models.json.
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.create(authStorage, resolveModelsPath(DEFAULT_AGENT_ID));

	try {
		const result = await runOnboarding(tui, authStorage, modelRegistry, {
			noEnvDetect: opts.noEnvDetect,
			secretInputMode: opts.secretInputMode,
			storage,
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

		// The sentinel was pinned + the context booted up front (so writes
		// sealed into convex as they happened). Now drain the convex write-
		// behind chains so the provider key, config, and models catalog are
		// durably committed before we print "onboarded" and exit. No-op in
		// filesystem mode (writes were synchronous).
		await flushAllPendingWrites();
		// Onboarding is durable — from here the NEW pin is the real state; a
		// late Ctrl+C must not roll it back.
		onboardSettled = true;

		// Web-tools setup is now Step 4 of the Pi-TUI wizard above — runs
		// inside `runOnboarding` against the same TUI, so its look matches
		// the provider picker exactly. No post-wizard prompt here.

		const modeLine =
			result.storage.mode === "convex"
				? `Storage:     ${chalk.bold("convex")} (${chalk.bold(result.storage.convexUrl)})`
				: `Storage:     ${chalk.bold("filesystem")} (~/.brigade)`;

		console.error(
			chalk.dim(
				`\n✓ onboarded — provider: ${chalk.bold(result.provider)} · model: ${chalk.bold(result.modelId)}\n` +
					`${modeLine}\n` +
					`Next: run ${chalk.bold("brigade gateway")} (then ${chalk.bold("brigade connect")} in a second terminal),\n` +
					`      or ${chalk.bold("brigade")} for the in-process TUI.\n` +
					`Web tools:   ${chalk.bold("brigade onboard web")} to (re-)pick a search backend.\n` +
					`Memory:      facts auto-extract after every turn — run ${chalk.bold("brigade doctor")} to see the active embedder.\n` +
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
		//
		// Either way, restore the PRE-RUN pin: the sentinel now lands BEFORE
		// the wizard (so writes seal into the right backend), so an aborted
		// run must not leave the machine pinned to a mode it never finished
		// setting up — neither a fresh pin over an unconfigured backend NOR a
		// silently switched mode on a cancelled re-onboard. Any rows already
		// sealed into convex are harmless: idempotent, overwritten by the next
		// successful onboard.
		rollbackSentinel();
		if (msg === "onboarding-cancelled") {
			console.error(chalk.dim("Onboarding cancelled — run `brigade onboard` again any time."));
			return 0;
		}
		console.error(chalk.red(`Onboarding failed: ${msg}`));
		return 1;
	}
}

/**
 * Persist the storage-mode choice into `~/.brigade/mode.sentinel`. Idempotent —
 * writes the sentinel regardless of whether it already existed (a re-onboard
 * with the same answer is a no-op, a re-onboard that switches modes flips
 * the pin). Doesn't migrate data; that's a separate `brigade store migrate`
 * command.
 *
 * Failure here is non-fatal: the user has already burned wizard time, so we
 * log a yellow warning and let them re-run `brigade store mode set <mode>`
 * to retry.
 */
function persistStorageMode(storage: StorageModeResult): void {
	try {
		writeSentinelNow(storage.mode, {
			...(storage.convexUrl !== undefined ? { convexUrl: storage.convexUrl } : {}),
		});
	} catch (err) {
		process.stderr.write(
			chalk.yellow(
				`\nbrigade: warning — couldn't write ~/.brigade/mode.sentinel: ${(err as Error).message}\n` +
					`  Retry with: brigade store mode set ${storage.mode}` +
					(storage.convexUrl ? ` --convex-url ${storage.convexUrl}\n` : "\n"),
			),
		);
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
		let providerHasProfile = false;
		try {
			// Mode-aware: in convex mode there is NO disk auth-profiles.json —
			// readProfiles serves the in-memory cache (primed at boot / by the
			// wizard's sealed upsert). A raw disk read would always miss in
			// convex mode → a spurious "no profile" → redundant re-mirror.
			const { profiles } = readProfiles(DEFAULT_AGENT_ID);
			providerHasProfile = Object.values(profiles ?? {}).some(
				(p) =>
					(p as { provider?: string }).provider === args.provider &&
					((p as { key?: string }).key !== undefined ||
						(p as { keyRef?: unknown }).keyRef !== undefined),
			);
		} catch {
			// No profiles yet — fall through; the upsert below creates it.
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
		// Wave N3 (bug #5) — seed the secure DM-scope default. Without
		// this, a fresh onboard leaves `session.dmScope` undefined and the
		// runtime fallback in session-key.ts collapses every DM into the
		// agent's single `agent:<id>:main` lane (shared transcript +
		// memory across peers). Operator-explicit values are preserved.
		const seeded = applyOnboardingSessionDefaults(cfg as never);
		saveConfig(seeded as never);
		const finalScope = (seeded as { session?: { dmScope?: string } }).session?.dmScope;
		if (finalScope === ONBOARDING_DEFAULT_DM_SCOPE) {
			process.stderr.write(
				chalk.dim(
					`Set session.dmScope to "${ONBOARDING_DEFAULT_DM_SCOPE}" — every DM gets its own session/transcript/memory.\n`,
				),
			);
		}
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
	const onboardCmd = program
		.command("onboard")
		.description("Pick a provider and model — interactive Pi-TUI wizard")
		.option("--no-env-detect", "ignore API keys from the shell environment", false)
		.action(async (opts: { envDetect?: boolean }) => {
			const code = await runOnboardCommand({ noEnvDetect: opts.envDetect === false });
			process.exit(code);
		});

	// Sub-command: `brigade onboard web` — re-run JUST the web-tools section
	// of the wizard. Useful when the operator already configured provider/
	// model but skipped web setup, or wants to swap the default search backend.
	onboardCmd
		.command("web")
		.description("Pick a default web-search provider (re-runnable Pi-TUI wizard step)")
		.option("--secret-input-mode <mode>", "plaintext (default) or ref (store env-var pointer)", "plaintext")
		.action(async (opts: { secretInputMode?: string }) => {
			try {
				const { runWebSetupStandalone } = await import("../flows/web-setup.js");
				const mode = opts.secretInputMode === "ref" ? "ref" : "plaintext";
				const code = await runWebSetupStandalone({ secretInputMode: mode });
				process.exit(code);
			} catch (err) {
				console.error(chalk.red(`Web setup failed: ${err instanceof Error ? err.message : String(err)}`));
				process.exit(1);
			}
		});
}
