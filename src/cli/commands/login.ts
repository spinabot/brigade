/**
 * `brigade login [provider]` — subscription / OAuth login, standalone.
 *
 * For providers that carry a `subscription` descriptor (Claude Pro/Max,
 * ChatGPT, GitHub Copilot) we drive Pi's browser OAuth flow and persist the
 * returned credential to Brigade's auth store — no API key required.
 *
 * Deliberately LIGHTER than `brigade onboard`: no storage-mode picker, no
 * model picker, no ModelRegistry. The runtime context is already booted by
 * build-program's `preAction` hook (login is a normal command, not in
 * BOOT_SKIP), so this command just:
 *   1. Resolves the target subscription provider (arg or interactive picker).
 *   2. Runs `ensureSubscriptionLogin` — the same flow the onboard wizard uses,
 *      which fully persists the credential (upsertOAuthProfile + authStorage.set
 *      + reload + prefetchSubscriptionModels).
 *   3. Drains the convex write-behind chain and prints a next-step hint.
 *
 * Pick the model afterwards with `brigade onboard` or `/model` in chat.
 */

import process from "node:process";

import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, SelectList, type SelectItem, Text, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";

import { initAuthProfiles } from "../../auth/profiles.js";
import { DEFAULT_AGENT_ID } from "../../config/paths.js";
import { EXIT_CONFIG_ERROR } from "../../protocol.js";
import { findProvider, PROVIDERS, type ProviderInfo } from "../../providers/catalog.js";
import { flushAllPendingWrites } from "../../storage/flush.js";
import { ensureSubscriptionLogin } from "../../ui/onboarding.js";
import { markTuiActive, restoreTerminal } from "../../ui/terminal-cleanup.js";
import { brand, selectListTheme } from "../../ui/theme.js";

/** Friendly aliases → the provider that carries the subscription descriptor. */
const SUBSCRIPTION_LOGIN_ALIASES: Record<string, string> = {
	claude: "claude-code",
	"claude-pro": "claude-code",
	"claude-max": "claude-code",
	anthropic: "claude-code",
	chatgpt: "openai-codex",
	openai: "openai-codex",
	codex: "openai-codex",
	copilot: "github-copilot",
	github: "github-copilot",
};

/**
 * Resolve a subscription-login provider from a CLI arg, tolerantly. Accepts the
 * provider's own id (`claude-code`), its underlying OAuth id (`anthropic`), or a
 * friendly alias (`claude` / `chatgpt` / `copilot`). Returns undefined when
 * nothing maps to a SUBSCRIPTION provider.
 *
 * Without this, `brigade login anthropic` failed: `anthropic` is the API-KEY
 * provider (no `subscription` descriptor) — the Claude Pro/Max login lives under
 * the `claude-code` provider whose `oauthProviderId` is `anthropic`.
 */
function resolveSubscriptionProvider(arg: string): ProviderInfo | undefined {
	const a = arg.trim().toLowerCase();
	// 1. Direct id match that actually carries a subscription descriptor.
	const direct = findProvider(a);
	if (direct?.subscription) return direct;
	// 2. A subscription provider whose underlying OAuth id matches (anthropic → claude-code).
	const byOauth = PROVIDERS.find(
		(p) => p.subscription && p.subscription.oauthProviderId.toLowerCase() === a,
	);
	if (byOauth) return byOauth;
	// 3. A friendly alias.
	const aliased = SUBSCRIPTION_LOGIN_ALIASES[a];
	if (aliased) {
		const p = findProvider(aliased);
		if (p?.subscription) return p;
	}
	return undefined;
}

/**
 * Run the subscription-login flow and exit. Resolves once the flow completes
 * (success or cancellation) — no long-running event loop to keep alive.
 */
export async function runLoginCommand(opts: { provider?: string } = {}): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error(chalk.red("brigade login needs an interactive terminal."));
		console.error(
			chalk.dim(
				"Signing in opens your browser, so it needs a real terminal.\n" +
					"Running headless? Set up a provider API key with `brigade onboard` instead.",
			),
		);
		return EXIT_CONFIG_ERROR;
	}

	// claude-cli backend — its own zero-key browser-login flow (installs the
	// binary if needed, drives the OAuth, writes Brigade's managed Claude grant).
	// Recognized by its id or a few natural aliases. Handled BEFORE the
	// subscription picker since it isn't a `subscription` provider.
	const cliArg = opts.provider?.trim().toLowerCase();
	if (cliArg && ["claude-cli", "cli", "claude-code-cli", "claudecli"].includes(cliArg)) {
		markTuiActive();
		initAuthProfiles(DEFAULT_AGENT_ID);
		const authStorage = AuthStorage.inMemory();
		const tui = new TUI(new ProcessTerminal());
		tui.start();
		const onSigintCli = (): void => {
			tui.stop();
			restoreTerminal();
			const t = setTimeout(() => process.exit(130), 2000);
			t.unref?.();
			void flushAllPendingWrites().finally(() => process.exit(130));
		};
		process.once("SIGINT", onSigintCli);
		try {
			const { ensureClaudeCli } = await import("../../ui/onboarding.js");
			const result = await ensureClaudeCli(tui, authStorage);
			tui.stop();
			restoreTerminal();
			await flushAllPendingWrites();
			if (result === "back") {
				console.error(chalk.dim("Login cancelled."));
				return 0;
			}
			console.error(chalk.green("✓ Claude subscription connected (via the Claude Code CLI backend)."));
			console.error(chalk.dim("Select it in chat with `/provider claude-cli`, or set it as default with `brigade onboard`."));
			return 0;
		} finally {
			restoreTerminal();
		}
	}

	const subs = PROVIDERS.filter((p) => p.subscription);

	// Resolve an explicit provider arg BEFORE touching the terminal: a bad arg
	// then errors cleanly instead of starting the TUI (raw mode + a device-
	// attributes query) and leaking a `\x1b[?…c` escape into the shell under the
	// error text. Accepts the provider id, the OAuth id (`anthropic`), or aliases.
	let info: ProviderInfo | undefined;
	if (opts.provider) {
		info = resolveSubscriptionProvider(opts.provider);
		if (!info) {
			console.error(chalk.red(`'${opts.provider}' isn't a subscription provider.`));
			console.error(chalk.dim(`  Try one of: ${subs.map((s) => `${s.name} (${s.id})`).join(", ")}`));
			return EXIT_CONFIG_ERROR;
		}
	}

	// Login drives a browser OAuth flow through a TUI confirm-gate (raw mode +
	// cursor manipulation) — opt into the on-exit terminal cleanup so a Ctrl+C
	// mid-flow doesn't leave the terminal in raw mode.
	markTuiActive();

	// The runtime context was already booted by build-program's preAction hook
	// (login is a normal mutating command — NOT in BOOT_SKIP — so a dead backend
	// fails loudly there rather than silently dropping the credential here).
	// Prime the auth-profile store + an in-memory auth.json the OAuth flow can
	// reuse; ALL durable persistence happens inside `ensureSubscriptionLogin`.
	initAuthProfiles(DEFAULT_AGENT_ID);
	const authStorage = AuthStorage.inMemory();

	const tui = new TUI(new ProcessTerminal());
	tui.start();

	// SIGINT during the flow — clean exit, no half-written credential (the OAuth
	// flow only persists on a completed login). Drain any in-flight write-behind
	// before exiting so Ctrl+C can't silently drop a just-persisted credential.
	const onSigint = (): void => {
		tui.stop();
		restoreTerminal();
		const t = setTimeout(() => process.exit(130), 2000);
		t.unref?.();
		void flushAllPendingWrites().finally(() => process.exit(130));
	};
	process.once("SIGINT", onSigint);

	try {
		// Interactive picker — only when no (valid) provider arg was supplied (an
		// explicit arg was already resolved to `info` above, before the TUI
		// started, so a bad arg never reaches here).
		if (!info) {
			tui.addChild(new Text("", 0, 0));
			tui.addChild(new Text(`  ${brand.amber("Log in to a subscription provider")}`, 0, 0));
			tui.addChild(
				new Text(brand.dim("  We'll open your browser to sign in — no API key needed."), 0, 0),
			);
			tui.addChild(new Text("", 0, 0));

			const items: SelectItem[] = subs.map((p) => ({
				value: p.id,
				label: p.name,
				description: p.subscription!.label,
			}));
			const list = new SelectList(items, Math.min(items.length, 9), selectListTheme, {
				minPrimaryColumnWidth: 16,
				maxPrimaryColumnWidth: 22,
			});
			tui.addChild(list);
			tui.setFocus(list);
			tui.requestRender();

			let pickedId: string;
			try {
				pickedId = await new Promise<string>((resolve, reject) => {
					list.onSelect = (item) => resolve(item.value);
					list.onCancel = () => reject(new Error("cancelled"));
				});
			} catch {
				tui.stop();
				restoreTerminal();
				console.error(chalk.dim("Login cancelled."));
				return 0;
			}

			const picked = findProvider(pickedId);
			if (!picked?.subscription) {
				// Defensive — the picker only ever offers subscription providers.
				tui.stop();
				restoreTerminal();
				console.error(chalk.red(`'${pickedId}' isn't a subscription provider.`));
				return EXIT_CONFIG_ERROR;
			}
			info = picked;
		}

		if (!info) {
			// Unreachable — the picker either assigns info or returns above — but
			// this keeps TypeScript's narrowing happy and is a safe fallback.
			tui.stop();
			restoreTerminal();
			return EXIT_CONFIG_ERROR;
		}
		const result = await ensureSubscriptionLogin(tui, authStorage, info);

		tui.stop();
		restoreTerminal();

		// Commit the convex write-behind chain before exit so the credential the
		// OAuth flow just persisted is durably stored. No-op in filesystem mode.
		await flushAllPendingWrites();

		if (result === "back") {
			console.error(chalk.dim("Login cancelled."));
			return 0;
		}

		console.error(chalk.green(`✓ Logged in to ${info.name}.`));
		console.error(chalk.dim("Pick a model with `brigade onboard` or `/model` in chat."));
		return 0;
	} finally {
		// Always tear the TUI down on the way out — a throw must never leave the
		// terminal in raw mode.
		restoreTerminal();
	}
}
