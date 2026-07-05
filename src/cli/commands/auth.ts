/**
 * `brigade auth` — the unified login surface.
 *
 *   brigade auth                 → status: which logins are healthy vs will-expire
 *   brigade auth login [prov]    → sign in / re-auth a provider (browser OAuth for
 *                                  subscriptions, API-key prompt for the rest)
 *   brigade auth fix             → re-login every credential that can't auto-refresh
 *   brigade auth logout <prov>   → remove a provider's stored login
 *
 * `brigade login` stays as a thin alias for the subscription path.
 *
 * Dual-mode (filesystem + Convex) throughout: status reads via the mode-aware
 * `readProfiles`; writes go through the same sync profile helpers the wizard uses
 * (`ensureSubscriptionLogin`/`ensureApiKey` → upsert*Profile, `writeProfiles`),
 * and every mutating path drains `flushAllPendingWrites()` before exit so a
 * Convex write-behind never gets dropped.
 */

import process from "node:process";

import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, SelectList, type SelectItem, Text, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";

import { detectUnrefreshableSubscriptions } from "../../auth/auth-health.js";
import { initAuthProfiles, readProfiles, writeProfiles } from "../../auth/profiles.js";
import { DEFAULT_AGENT_ID } from "../../config/paths.js";
import { loadConfig } from "../../core/config.js";
import { handleConfigSet } from "../../core/config-ops.js";
import { EXIT_CONFIG_ERROR } from "../../protocol.js";
import { findProvider, PROVIDERS, type ProviderInfo } from "../../providers/catalog.js";
import { flushAllPendingWrites } from "../../storage/flush.js";
import { ensureApiKey, ensureSubscriptionLogin } from "../../ui/onboarding.js";
import { markTuiActive, restoreTerminal } from "../../ui/terminal-cleanup.js";
import { brand, selectListTheme } from "../../ui/theme.js";

export type AuthAction = "status" | "login" | "fix" | "logout" | "use";

export async function runAuthCommand(
	opts: { action?: AuthAction; provider?: string; model?: string } = {},
): Promise<number> {
	switch (opts.action ?? "status") {
		case "login":
			return runAuthLogin(opts.provider);
		case "fix":
			return runAuthFix();
		case "logout":
			return runAuthLogout(opts.provider);
		case "use":
			return runAuthUse(opts.provider, opts.model);
		default:
			return runAuthStatus();
	}
}

// ── status ────────────────────────────────────────────────────────────────────
async function runAuthStatus(): Promise<number> {
	initAuthProfiles(DEFAULT_AGENT_ID);
	let file: ReturnType<typeof readProfiles>;
	try {
		file = readProfiles(DEFAULT_AGENT_ID);
	} catch (err) {
		console.error(chalk.red(`Couldn't read your logins: ${(err as Error).message}`));
		return EXIT_CONFIG_ERROR;
	}
	const profiles = Object.values(file.profiles ?? {});
	const stale = detectUnrefreshableSubscriptions(DEFAULT_AGENT_ID);
	const staleSet = new Set(stale.map((s) => s.provider));

	let defProvider: string | undefined;
	let defModel: string | undefined;
	try {
		const cfg = await loadConfig();
		const d = (cfg.agents as { defaults?: { provider?: string; model?: { primary?: string } } } | undefined)?.defaults;
		defProvider = d?.provider;
		defModel = d?.model?.primary;
	} catch {
		/* no config yet */
	}

	const lines: string[] = [chalk.bold("brigade auth"), ""];
	if (profiles.length === 0) {
		lines.push(chalk.dim("  no logins yet — run `brigade auth login`"));
	} else {
		for (const p of profiles) {
			const prov = p.provider ?? "?";
			const type = String(p.type ?? "?");
			const marker = prov === defProvider ? chalk.bold("→") : " ";
			const health = staleSet.has(prov)
				? chalk.yellow("⚠ can't auto-refresh — run `brigade auth login`")
				: type === "oauth"
					? chalk.green("✓ subscription (auto-refreshes)")
					: type === "api_key"
						? chalk.green("✓ API key")
						: chalk.green("✓ token");
			lines.push(`  ${marker} ${prov.padEnd(18)} ${type.padEnd(8)} ${health}`);
		}
	}
	if (defProvider && defModel) {
		lines.push("");
		lines.push(chalk.dim(`  default model: ${defProvider}/${defModel}`));
	}
	if (stale.length > 0) {
		lines.push("");
		lines.push(
			chalk.yellow(`  ${stale.length} login(s) will expire and can't refresh — fix all with \`brigade auth fix\``),
		);
	}
	lines.push("");
	process.stdout.write(lines.join("\n") + "\n");
	return 0;
}

// ── login ─────────────────────────────────────────────────────────────────────
async function runAuthLogin(provider?: string): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error(chalk.red("brigade auth login needs an interactive terminal."));
		console.error(chalk.dim("It opens your browser (subscription) or asks for a key. Headless? Use `brigade onboard`."));
		return EXIT_CONFIG_ERROR;
	}
	markTuiActive();
	initAuthProfiles(DEFAULT_AGENT_ID);
	const authStorage = AuthStorage.inMemory();
	const tui = new TUI(new ProcessTerminal());
	tui.start();
	const onSigint = (): void => {
		tui.stop();
		restoreTerminal();
		const t = setTimeout(() => process.exit(130), 2000);
		t.unref?.();
		void flushAllPendingWrites().finally(() => process.exit(130));
	};
	process.once("SIGINT", onSigint);
	try {
		// claude-cli backend — its own zero-key browser-login flow (installs the
		// binary if needed, drives the OAuth, writes Brigade's managed grant). It's
		// a noAuth provider so it can't go through the subscription/key path below.
		const cliArg = provider?.trim().toLowerCase();
		if (cliArg && ["claude-cli", "cli", "claude-code-cli", "claudecli"].includes(cliArg)) {
			const { ensureClaudeCli } = await import("../../ui/onboarding.js");
			const r = await ensureClaudeCli(tui, authStorage);
			tui.stop();
			restoreTerminal();
			await flushAllPendingWrites();
			if (r === "back") {
				console.error(chalk.dim("Cancelled."));
				return 0;
			}
			console.error(chalk.green("✓ Claude subscription connected (via the Claude Code CLI backend)."));
			console.error(chalk.dim("Select it in chat with `/provider claude-cli`."));
			return 0;
		}
		let info: ProviderInfo | null;
		if (provider) {
			const found = findProvider(provider);
			if (!found || found.noAuth) {
				tui.stop();
				restoreTerminal();
				console.error(chalk.red(`'${provider}' isn't a provider that needs a login.`));
				return EXIT_CONFIG_ERROR;
			}
			info = found;
		} else {
			info = await pickAuthProvider(tui);
			if (!info) {
				tui.stop();
				restoreTerminal();
				console.error(chalk.dim("Cancelled."));
				return 0;
			}
		}

		const result = info.subscription
			? await ensureSubscriptionLogin(tui, authStorage, info)
			: await ensureApiKey(tui, authStorage, info.id);

		tui.stop();
		restoreTerminal();
		await flushAllPendingWrites();
		if (result === "back") {
			console.error(chalk.dim("Cancelled."));
			return 0;
		}
		console.error(chalk.green(`✓ ${info.name} connected.`));
		return 0;
	} finally {
		process.removeListener("SIGINT", onSigint);
		restoreTerminal();
	}
}

async function pickAuthProvider(tui: TUI): Promise<ProviderInfo | null> {
	const choices = PROVIDERS.filter((p) => !p.noAuth);
	tui.addChild(new Text("", 0, 0));
	tui.addChild(new Text(`  ${brand.amber("Log in to a provider")}`, 0, 0));
	tui.addChild(new Text(brand.dim("  Subscriptions open your browser; others ask for an API key."), 0, 0));
	tui.addChild(new Text("", 0, 0));
	const items: SelectItem[] = choices.map((p) => ({
		value: p.id,
		label: p.name,
		description: p.subscription ? p.subscription.label : "API key",
	}));
	const list = new SelectList(items, Math.min(items.length, 9), selectListTheme, {
		minPrimaryColumnWidth: 16,
		maxPrimaryColumnWidth: 22,
	});
	tui.addChild(list);
	tui.setFocus(list);
	tui.requestRender();
	try {
		const id = await new Promise<string>((resolve, reject) => {
			list.onSelect = (item) => resolve(item.value);
			list.onCancel = () => reject(new Error("cancel"));
		});
		return findProvider(id) ?? null;
	} catch {
		return null;
	}
}

// ── fix ───────────────────────────────────────────────────────────────────────
async function runAuthFix(): Promise<number> {
	const stale = detectUnrefreshableSubscriptions(DEFAULT_AGENT_ID);
	if (stale.length === 0) {
		console.error(chalk.green("✓ All logins can auto-refresh — nothing to fix."));
		return 0;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error(chalk.red("brigade auth fix needs an interactive terminal (browser sign-in)."));
		return EXIT_CONFIG_ERROR;
	}
	// Map each stale stored-provider to its catalog subscription entry.
	const targets: ProviderInfo[] = [];
	for (const s of stale) {
		const info = PROVIDERS.find(
			(p) => !!p.subscription && (((p as { providerId?: string }).providerId ?? p.id) === s.provider),
		);
		if (info && !targets.includes(info)) targets.push(info);
	}
	if (targets.length === 0) {
		console.error(
			chalk.yellow("Found logins that can't refresh, but none support browser sign-in — re-key with `brigade onboard`."),
		);
		return EXIT_CONFIG_ERROR;
	}

	markTuiActive();
	initAuthProfiles(DEFAULT_AGENT_ID);
	const authStorage = AuthStorage.inMemory();
	const tui = new TUI(new ProcessTerminal());
	tui.start();
	const onSigint = (): void => {
		tui.stop();
		restoreTerminal();
		const t = setTimeout(() => process.exit(130), 2000);
		t.unref?.();
		void flushAllPendingWrites().finally(() => process.exit(130));
	};
	process.once("SIGINT", onSigint);
	let done = 0;
	try {
		for (const info of targets) {
			const r = await ensureSubscriptionLogin(tui, authStorage, info);
			if (r === "back") break;
			done++;
		}
		tui.stop();
		restoreTerminal();
		await flushAllPendingWrites();
		console.error(chalk.green(`✓ Re-logged in to ${done} provider${done === 1 ? "" : "s"}.`));
		return 0;
	} finally {
		process.removeListener("SIGINT", onSigint);
		restoreTerminal();
	}
}

// ── logout ──────────────────────────────────────────────────────────────────
async function runAuthLogout(provider?: string): Promise<number> {
	if (!provider) {
		console.error(chalk.red("Usage: brigade auth logout <provider>"));
		return EXIT_CONFIG_ERROR;
	}
	initAuthProfiles(DEFAULT_AGENT_ID);
	const file = readProfiles(DEFAULT_AGENT_ID);
	const profiles = { ...(file.profiles ?? {}) };
	const removed = Object.keys(profiles).filter((k) => profiles[k]?.provider === provider);
	if (removed.length === 0) {
		console.error(chalk.dim(`No login stored for '${provider}'.`));
		return 0;
	}
	for (const k of removed) delete profiles[k];
	writeProfiles(DEFAULT_AGENT_ID, { ...file, profiles });
	await flushAllPendingWrites();
	console.error(chalk.green(`✓ Logged out of ${provider} (${removed.length} profile${removed.length === 1 ? "" : "s"} removed).`));
	return 0;
}

// ── use (set the default provider + model the crew runs on) ──────────────────
async function runAuthUse(provider?: string, model?: string): Promise<number> {
	if (!provider) {
		console.error(chalk.red("Usage: brigade auth use <provider> [model]"));
		return EXIT_CONFIG_ERROR;
	}
	const info = findProvider(provider);
	if (!info) {
		console.error(chalk.yellow(`'${provider}' isn't in the built-in catalog — setting it anyway (custom provider?).`));
	}
	// Mode-aware: handleConfigSet loads + saves through the same config layer as
	// the gateway's config.* RPCs, so this persists in filesystem AND Convex.
	handleConfigSet({ path: "agents.defaults.provider", value: provider });
	if (model) handleConfigSet({ path: "agents.defaults.model.primary", value: model });
	await flushAllPendingWrites();

	console.error(chalk.green(`✓ Default set to ${model ? `${provider}/${model}` : provider}.`));
	if (!model) {
		console.error(chalk.dim(`  No model given — set one with \`brigade auth use ${provider} <model>\` or \`/model\` in chat.`));
	}
	// Nudge if there's no credential for this provider yet.
	try {
		initAuthProfiles(DEFAULT_AGENT_ID);
		const file = readProfiles(DEFAULT_AGENT_ID);
		const hasCred = Object.values(file.profiles ?? {}).some((p) => p.provider === provider);
		if (!hasCred && !info?.noAuth) {
			console.error(chalk.yellow(`  No login stored for ${provider} yet — run \`brigade auth login ${provider}\`.`));
		}
	} catch {
		/* best-effort nudge */
	}
	return 0;
}
