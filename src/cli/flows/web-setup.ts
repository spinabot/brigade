/**
 * Web-tools setup step — Pi-TUI screen.
 *
 * Visually + structurally identical to `pickProvider` / `ensureApiKey` in
 * `src/ui/onboarding.ts`. Lives in the same wizard, uses the same brand
 * header, sub-header line, `SelectList` for picking, and `Input` for key
 * paste. No `prompts` library — that was the UX regression the user
 * called out in screenshot #2.
 *
 * Two entry points:
 *   - `runWebSetupStep(tui, …)` — called by `runOnboarding` as Step 5 of 5.
 *   - `runWebSetupStandalone()` — used by `brigade onboard web`; spins up
 *     its own TUI, runs the step, tears down.
 *
 * After the user picks a provider:
 *   - Key-free providers (DuckDuckGo, Wikipedia, HN, arXiv, npm, etc.) →
 *     pin as default, no key prompt.
 *   - Already-configured / env-detected providers → pin (no re-prompt).
 *   - Providers needing a key → render an Input, paste, save.
 */

import process from "node:process";

import { Input, type SelectItem, SelectList, Text, TUI } from "@earendil-works/pi-tui";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import chalk from "chalk";

import { BrigadeExtensionRegistry } from "../../agents/extensions/registry.js";
import { BUNDLED_MODULES } from "../../agents/extensions/modules/index.js";
import { DEFAULT_AGENT_ID } from "../../config/paths.js";
import { loadConfig, saveConfig } from "../../core/config.js";
import { probeTerminalAnimationSupport } from "../../ui/animations.js";
import { renderBrandHeader } from "../../ui/brand.js";
import { markTuiActive, restoreTerminal } from "../../ui/terminal-cleanup.js";
import { brand, selectListTheme } from "../../ui/theme.js";
import type { WebSearchProvider } from "../../agents/extensions/types.js";

/* ─────────────────────────── options ─────────────────────────── */

export interface RunWebSetupOptions {
	/**
	 * `plaintext` (default) writes the key into `brigade.json`.
	 * `ref` writes an env-var reference; the literal value stays in the
	 * shell environment. Mirrors `brigade onboard --secret-input-mode`.
	 */
	secretInputMode?: "plaintext" | "ref";
	/**
	 * The header label rendered above the picker. Default
	 * "Step 5 of 5 · Web search" when called from the main wizard;
	 * "Web search" when called standalone.
	 */
	stepLabel?: string;
}

export type WebSetupResult = "ok" | "skipped" | "back";

/* ─────────────────────────── public entry points ─────────────────────────── */

export async function runWebSetupStep(
	tui: TUI,
	opts: RunWebSetupOptions = {},
): Promise<WebSetupResult> {
	const stepLabel = opts.stepLabel ?? "Step 5 of 5 · Web search";

	const rows = await classifyProviders();
	if (rows.length === 0) {
		// No bundled providers registered — exotic build. Skip cleanly.
		return "skipped";
	}

	// Picker screen.
	renderScreen(tui, stepLabel);
	tui.addChild(new Text("  Pick a default backend for web_search.", 0, 0));
	tui.addChild(
		new Text(
			brand.dim("  Some are key-free, others need an API key. You can re-run with `brigade onboard web`."),
			0,
			0,
		),
	);
	tui.addChild(new Text("", 0, 0));

	const SKIP_VALUE = "__skip__";
	const items: SelectItem[] = [
		...rows.map((r) => ({
			value: r.provider.id,
			label: r.provider.label,
			description: r.description,
		})),
		{
			value: SKIP_VALUE,
			label: "Skip for now",
			description: "DuckDuckGo (keyless) stays the fallback. Re-run with `brigade onboard web`.",
		},
	];

	const list = new SelectList(items, Math.min(items.length, 11), selectListTheme, {
		minPrimaryColumnWidth: 22,
		maxPrimaryColumnWidth: 28,
	});
	tui.addChild(list);
	tui.setFocus(list);
	tui.requestRender();

	const chosen = await new Promise<SelectItem | "back">((resolve) => {
		list.onSelect = (item) => resolve(item);
		list.onCancel = () => resolve("back");
	});

	if (chosen === "back") return "back";
	if (chosen.value === SKIP_VALUE) return "skipped";

	const row = rows.find((r) => r.provider.id === chosen.value);
	if (!row) return "skipped";

	return await wireUpProvider(tui, row, opts, stepLabel);
}

/**
 * Standalone entry for `brigade onboard web`. Owns its own TUI lifecycle.
 */
export async function runWebSetupStandalone(opts: RunWebSetupOptions = {}): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error(chalk.red("brigade onboard web needs an interactive terminal."));
		return 1;
	}
	markTuiActive();
	// Terminal capability probe (animated vs static chrome) — see animations.ts.
	await probeTerminalAnimationSupport();
	const tui = new TUI(new ProcessTerminal());
	tui.start();
	const onSigint = (): void => {
		tui.stop();
		restoreTerminal();
		process.exit(130);
	};
	process.once("SIGINT", onSigint);
	try {
		const result = await runWebSetupStep(tui, { ...opts, stepLabel: "Web search" });
		tui.stop();
		restoreTerminal();
		if (result === "ok") {
			console.error(chalk.dim("\n✓ web-search backend configured."));
		} else if (result === "skipped") {
			console.error(chalk.dim("\nSkipped — DuckDuckGo (keyless) stays the default."));
		}
		return 0;
	} catch (err) {
		tui.stop();
		restoreTerminal();
		console.error(chalk.red(`Web setup failed: ${err instanceof Error ? err.message : String(err)}`));
		return 1;
	} finally {
		process.removeListener("SIGINT", onSigint);
	}
}

/* ─────────────────────────── provider classification ─────────────────────────── */

interface ProviderRow {
	provider: WebSearchProvider;
	state: "configured" | "key-free" | "env-detected" | "needs-key";
	description: string;
}

async function classifyProviders(): Promise<ProviderRow[]> {
	const reg = buildRegistry();
	const cfg = loadConfig();
	const env = process.env;
	const sorted = [...reg.webSearchProviders].sort(
		(a, b) => (a.autoDetectOrder ?? 100) - (b.autoDetectOrder ?? 100) || a.id.localeCompare(b.id),
	);
	return sorted.map((p) => classify(p, cfg, env));
}

function buildRegistry(): BrigadeExtensionRegistry {
	const r = new BrigadeExtensionRegistry();
	const ctx = r.context({
		agentId: DEFAULT_AGENT_ID,
		workspaceDir: process.cwd(),
		cwd: process.cwd(),
		config: {} as never,
		moduleConfig: undefined,
	});
	for (const m of BUNDLED_MODULES) {
		try {
			m.register(ctx);
		} catch {
			/* a module that can't enumerate itself isn't relevant here */
		}
	}
	return r;
}

function classify(provider: WebSearchProvider, cfg: unknown, env: NodeJS.ProcessEnv): ProviderRow {
	const hint = provider.hint;
	if (provider.requiresCredential === false) {
		return { provider, state: "key-free", description: `${hint} · key-free` };
	}
	if (configuredInJson(cfg, provider.id)) {
		return { provider, state: "configured", description: `${hint} · configured` };
	}
	if (envHasAny(provider.envVars, env)) {
		const which = provider.envVars?.find((v) => !!env[v]?.trim()) ?? provider.envVars?.[0];
		return { provider, state: "env-detected", description: `${hint} · detected ${which}` };
	}
	return { provider, state: "needs-key", description: `${hint} · needs key` };
}

function configuredInJson(cfg: unknown, providerId: string): boolean {
	const slot = (cfg as {
		tools?: { web?: { search?: { providers?: Record<string, { apiKey?: unknown }> } } };
	}).tools?.web?.search?.providers?.[providerId];
	if (!slot) return false;
	return typeof slot.apiKey === "string" && slot.apiKey.trim().length > 0;
}

function envHasAny(envVars: ReadonlyArray<string> | undefined, env: NodeJS.ProcessEnv): boolean {
	if (!envVars || envVars.length === 0) return false;
	return envVars.some((v) => !!env[v]?.trim());
}

/* ─────────────────────────── selection → save ─────────────────────────── */

async function wireUpProvider(
	tui: TUI,
	row: ProviderRow,
	opts: RunWebSetupOptions,
	stepLabel: string,
): Promise<WebSetupResult> {
	const { provider, state } = row;

	// Keyless → pin + done.
	if (state === "key-free") {
		pinSearchProvider(provider.id);
		await flashStatus(tui, `${provider.label} set as default · no key needed`, stepLabel);
		return "ok";
	}

	// Already-configured → pin + done.
	if (state === "configured") {
		pinSearchProvider(provider.id);
		await flashStatus(tui, `${provider.label} set as default · using existing key`, stepLabel);
		return "ok";
	}

	// Env-detected — copy the value or write a ref pointer per mode.
	if (state === "env-detected") {
		const envVar = (provider.envVars ?? []).find((v) => !!process.env[v]?.trim()) ?? (provider.envVars ?? [])[0];
		if (envVar) {
			if (opts.secretInputMode === "ref") {
				writeSearchEnvRef({ providerId: provider.id, envVar, pinAsDefault: true });
				await flashStatus(tui, `${provider.label} set as default · reading ${envVar} at runtime`, stepLabel);
				return "ok";
			}
			const envValue = (process.env[envVar] ?? "").trim();
			if (envValue) {
				writeSearchKey({ providerId: provider.id, apiKey: envValue, pinAsDefault: true });
				await flashStatus(tui, `${provider.label} set as default · key copied from ${envVar}`, stepLabel);
				return "ok";
			}
		}
	}

	// Needs key — paste prompt, validate non-empty.
	return await promptForKey(tui, row, stepLabel);
}

async function promptForKey(
	tui: TUI,
	row: ProviderRow,
	stepLabel: string,
): Promise<WebSetupResult> {
	const { provider } = row;
	const envVar = (provider.envVars ?? [])[0];

	renderScreen(tui, stepLabel);
	tui.addChild(new Text(`  Paste your ${provider.label} API key.`, 0, 0));
	const helpLine = envVar
		? `  Leave blank to use ${envVar}.  Need a key? ${provider.signupUrl ?? ""}`
		: `  We'll keep it private to this device.  Need a key? ${provider.signupUrl ?? ""}`;
	tui.addChild(new Text(brand.dim(helpLine), 0, 0));
	tui.addChild(new Text(brand.dim("  Enter to continue  ·  Esc to go back"), 0, 0));
	tui.addChild(new Text("", 0, 0));

	const input = new Input();
	tui.addChild(input);
	tui.setFocus(input);
	tui.requestRender();

	let raw: string;
	try {
		raw = await new Promise<string>((resolve, reject) => {
			input.onSubmit = (value: string) => resolve(value.trim());
			input.onEscape = () => reject(new Error("back"));
		});
	} catch {
		return "back";
	}

	if (raw.length === 0) {
		// Blank paste — fall back to env var if present.
		const envValue = envVar ? (process.env[envVar] ?? "").trim() : "";
		if (envValue) {
			writeSearchKey({ providerId: provider.id, apiKey: envValue, pinAsDefault: true });
			await flashStatus(tui, `${provider.label} set as default · key copied from ${envVar}`, stepLabel);
			return "ok";
		}
		pinSearchProvider(provider.id);
		await flashStatus(
			tui,
			`${provider.label} pinned without a key — set ${envVar ?? "the env var"} or re-run \`brigade onboard web\``,
			stepLabel,
		);
		return "ok";
	}

	writeSearchKey({ providerId: provider.id, apiKey: raw, pinAsDefault: true });
	await flashStatus(tui, `${provider.label} configured + set as default`, stepLabel);
	return "ok";
}

/* ─────────────────────────── visuals ─────────────────────────── */

async function flashStatus(tui: TUI, message: string, stepLabel: string): Promise<void> {
	renderScreen(tui, stepLabel);
	tui.addChild(new Text(`  ${brand.amber("●")} ${message}`, 0, 0));
	tui.requestRender();
	await delay(600);
}

function renderScreen(tui: TUI, subheader: string): void {
	clear(tui);
	renderBrandHeader(tui);
	if (subheader) {
		tui.addChild(new Text(brand.dim("  " + "─".repeat(54)), 0, 0));
		tui.addChild(new Text("", 0, 0));
		tui.addChild(new Text(`  ${brand.amber(subheader)}`, 0, 0));
		tui.addChild(new Text("", 0, 0));
	}
}

function clear(tui: TUI): void {
	for (const child of [...tui.children]) {
		try {
			tui.removeChild(child);
		} catch {
			/* ignore */
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/* ─────────────────────────── config writers ─────────────────────────── */

function writeSearchKey(args: { providerId: string; apiKey: string; pinAsDefault: boolean }): void {
	const cfg = loadConfig() as Record<string, unknown>;
	const tools = (cfg.tools as Record<string, unknown> | undefined) ?? {};
	const web = (tools.web as Record<string, unknown> | undefined) ?? {};
	const search = (web.search as Record<string, unknown> | undefined) ?? {};
	const providers = (search.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
	providers[args.providerId] = { ...providers[args.providerId], apiKey: args.apiKey };
	search.providers = providers;
	if (args.pinAsDefault) search.provider = args.providerId;
	web.search = search;
	tools.web = web;
	cfg.tools = tools;
	saveConfig(cfg as never);
}

function writeSearchEnvRef(args: { providerId: string; envVar: string; pinAsDefault: boolean }): void {
	const cfg = loadConfig() as Record<string, unknown>;
	const tools = (cfg.tools as Record<string, unknown> | undefined) ?? {};
	const web = (tools.web as Record<string, unknown> | undefined) ?? {};
	const search = (web.search as Record<string, unknown> | undefined) ?? {};
	const providers = (search.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
	providers[args.providerId] = { ...providers[args.providerId], apiKeyEnv: args.envVar };
	search.providers = providers;
	if (args.pinAsDefault) search.provider = args.providerId;
	web.search = search;
	tools.web = web;
	cfg.tools = tools;
	saveConfig(cfg as never);
}

function pinSearchProvider(providerId: string): void {
	const cfg = loadConfig() as Record<string, unknown>;
	const tools = (cfg.tools as Record<string, unknown> | undefined) ?? {};
	const web = (tools.web as Record<string, unknown> | undefined) ?? {};
	const search = (web.search as Record<string, unknown> | undefined) ?? {};
	search.provider = providerId;
	web.search = search;
	tools.web = web;
	cfg.tools = tools;
	saveConfig(cfg as never);
}

/* ─────────────────────────── legacy export ─────────────────────────── */

/**
 * Back-compat alias — earlier turn shipped a `prompts`-based flow under
 * this name. Now routes to the standalone Pi-TUI version.
 */
export async function runWebSetupFlow(opts: RunWebSetupOptions = {}): Promise<void> {
	await runWebSetupStandalone(opts);
}
