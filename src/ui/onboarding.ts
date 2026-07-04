/**
 * First-run onboarding wizard.
 *
 * Flow:
 *   1. Welcome screen
 *   2. Provider picker (SelectList of curated providers)
 *   3. API key entry (or detect existing env var)
 *   4. Model picker (SelectList of models for that provider)
 *   5. Persist to AuthStorage + Brigade config
 *   6. Return chosen { provider, modelId }
 *
 * Uses Pi-TUI components — same components the chat UI uses, so the visual
 * language is consistent across the app.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";

import { getEnvApiKey, getModels, type KnownProvider, type Model } from "@earendil-works/pi-ai";
// `getOAuthProvider` lives ONLY on the "./oauth" subpath export — the package's
// main "." entry (base + register-builtins) does NOT re-export the OAuth
// registry, so importing it from "@earendil-works/pi-ai" resolves to undefined.
// The package.json "exports" map exposes "./oauth", so this is the supported
// path (verified against node_modules @ pi-ai 0.79.9).
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Input, type SelectItem, SelectList, Text, TUI } from "@earendil-works/pi-tui";

import {
	upsertApiKeyProfile,
	upsertApiKeyRefProfile,
	upsertOAuthProfile,
	upsertTokenProfile,
} from "../auth/profiles.js";
import { DEFAULT_AGENT_ID, resolveAuthProfilesPath, resolveModelsPath } from "../config/paths.js";
import { BRIGADE_DIR, saveConfig } from "../core/config.js";
import { readClaudeCliLogin, readCodexCliLogin } from "../integrations/cli-login.js";
import { writeCustomProviderToModelsJson } from "../integrations/custom-provider.js";
import { discoverOllamaModels, writeOllamaToModelsJson } from "../integrations/ollama.js";
import {
	findProvider,
	PROVIDERS,
	readProviderEnvKey,
	resolveProviderEnvVarSource,
	type ProviderInfo,
} from "../providers/catalog.js";
import { validateApiKeyOnline } from "../providers/validate-key.js";
import { renderBrandHeader } from "./brand.js";
import { brand, selectListTheme } from "./theme.js";
import { pickStorageMode, type StorageModeResult } from "./onboard-storage-mode.js";
import { SearchableSelectList } from "./searchable-select.js";
import {
	describeModelProbe,
	fetchOpenAICompatibleModelIds,
	getCachedSubscriptionModels,
	listOpenRouterModels,
	prefetchSubscriptionModels,
	probeModelReachable,
} from "../integrations/provider-discovery.js";

export interface OnboardingResult {
	provider: string;
	modelId: string;
	/** Storage backend the operator picked in Step 0. The caller writes the
	 *  mode.sentinel after the rest of the wizard finishes. */
	storage: StorageModeResult;
}

/* ────────────────────────────── public API ────────────────────────────── */

/**
 * Strip terminal paste artifacts (bracketed-paste markers + stray control chars)
 * from a typed/pasted value before use. `String.trim()` does NOT remove the
 * `ESC[200~ … ESC[201~` wrapper some terminals add to a paste, so a valid key
 * arrives as `<ESC>[200~sk-…` and fails validation. Keys / URLs / model ids are
 * printable, so dropping control chars is safe.
 */
function sanitizePastedValue(value: string): string {
	const esc = String.fromCharCode(27); // ESC (0x1b) from a code point — no control byte in source
	const unwrapped = value.split(`${esc}[200~`).join("").split(`${esc}[201~`).join("");
	let cleaned = "";
	for (const ch of unwrapped) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 0x20 && code !== 0x7f) cleaned += ch; // drop C0 control chars + DEL
	}
	return cleaned.trim();
}

/**
 * Resolve the model list for a provider. Pi's static `getModels()` only knows
 * built-in catalogs (Anthropic, OpenAI, Google, etc.); custom providers we
 * register at runtime via models.json (Ollama) are exposed through
 * `modelRegistry.getAll()`. Try the static catalog first, then fall back to
 * the dynamic registry — that way both code paths produce the same `Model<any>[]`
 * shape that the picker expects.
 */
async function getProviderModels(modelRegistry: ModelRegistry, providerId: string): Promise<Array<Model<any>>> {
	const staticModels: Array<Model<any>> = (() => {
		// Subscription providers (e.g. GitHub Copilot) are filtered to the
		// account's enabled models by the registry's `modifyModels` after login —
		// prefer the refreshed registry so the picker shows exactly what the plan
		// allows. Falls through to the static catalog when the registry is empty
		// (e.g. pre-login).
		if (findProvider(providerId)?.subscription || findProvider(providerId)?.custom) {
			// Live fetch (warmed at login by `prefetchSubscriptionModels`) is
			// authoritative for the SET of models the account can use. Join the
			// static catalog by id for richer metadata (cost, context window) where
			// Pi knows the model; live-only ids pass through as the loose live shape.
			const live = getCachedSubscriptionModels(providerId);
			if (live && live.length > 0) {
				let catalog: Array<Model<any>> = [];
				try {
					catalog = getModels(providerId as KnownProvider) as Array<Model<any>>;
				} catch {
					/* unknown provider — no catalog to join against */
				}
				const byId = new Map(catalog.map((m) => [m.id, m]));
				return live.map((lm) => byId.get(lm.id) ?? (lm as unknown as Model<any>));
			}
			const fromRegistry = modelRegistry
				.getAll()
				.filter((m) => m.provider === providerId) as Array<Model<any>>;
			if (fromRegistry.length > 0) return fromRegistry;
			// Curated catalog list (subscription/custom provider not in Pi's bundled
			// catalog and has no live models endpoint). Surfacing it here gives a real
			// PICKER — same UX as claude-code (whose list is likewise a bundled set) —
			// instead of dead-ending to a "type the model name" free-text prompt.
			const curated = findProvider(providerId)?.models;
			if (curated && curated.length > 0) {
				return curated.map(
					(id) => ({ id, provider: providerId, name: id, api: findProvider(providerId)?.api }) as unknown as Model<any>,
				);
			}
		}
		try {
			const fromCatalog = getModels(providerId as KnownProvider) as Array<Model<any>>;
			if (fromCatalog && fromCatalog.length > 0) return fromCatalog;
		} catch {
			/* unknown provider — fall through */
		}
		return modelRegistry.getAll().filter((m) => m.provider === providerId) as Array<Model<any>>;
	})();

	// Live-merge OpenRouter's CURRENT catalog so models newer than Pi's bundled
	// snapshot (e.g. the latest Opus/GPT/Gemini) show up in the picker. Best-
	// effort, cached, short timeout — on ANY failure we keep the static list so
	// offline onboarding still works. Static/catalogued entries win (richer
	// metadata); live-only ids are appended.
	if (providerId !== "openrouter") return staticModels;
	try {
		const live = await listOpenRouterModels();
		if (live.length === 0) return staticModels;
		const seen = new Set(staticModels.map((m) => m.id));
		const merged = [...staticModels];
		for (const lm of live) {
			if (!seen.has(lm.id)) merged.push(lm as unknown as Model<any>);
		}
		return merged;
	} catch {
		return staticModels;
	}
}

export interface OnboardingOptions {
	/**
	 * Disable detection of API keys exported in the user's shell environment.
	 * When `true`, Brigade pretends no env credential is present even if one
	 * is — onboarding skips the env-confirmation prompt entirely and goes
	 * straight to the typed-key path.
	 *
	 * Designed for enterprise / CI flows where the operator wants TYPED-only
	 * auth and never wants Brigade to silently consult a shell-exported var.
	 */
	noEnvDetect?: boolean;
	/**
	 * Storage shape for accepted env-key credentials. Modeled on the
	 * `--secret-input-mode` flag pattern.
	 *
	 *   - "plaintext" (DEFAULT) — accepted env value is COPIED into Brigade's
	 *     own state (brigade.json::env + auth-profiles.json with literal `key`).
	 *     Persists across shell restarts and machine moves. Same as today's
	 *     behaviour and the established default.
	 *
	 *   - "ref" — accepted env value is NEVER written to disk. Auth-profiles.json
	 *     stores `keyRef: { source: "env", id: "OPENROUTER_API_KEY" }`; the
	 *     runtime re-reads `process.env.OPENROUTER_API_KEY` on every request.
	 *     The shell env stays the canonical home of the secret. Use this for
	 *     CI / Vault-backed / paranoid-operator flows where literal keys must
	 *     not leave their original storage location.
	 *
	 * Pass-through: the wizard plumbs this into the env-accept branch only.
	 * The typed-key (paste) path always writes plaintext — there's nothing to
	 * reference because the value originated from a TUI input box, not the
	 * environment.
	 */
	secretInputMode?: "plaintext" | "ref";
	/**
	 * Storage mode the CALLER already picked (and for which it already
	 * established the runtime context). When set, the wizard SKIPS its own
	 * Step 0 storage picker. The `brigade onboard` command hoists Step 0 so it
	 * can boot the convex context before any secret/config write — without
	 * this, every wizard write would run context-less in filesystem mode and
	 * land plaintext on disk even for a convex pick.
	 */
	storage?: StorageModeResult;
}

export async function runOnboarding(
	tui: TUI,
	authStorage: AuthStorage,
	modelRegistry: ModelRegistry,
	opts: OnboardingOptions = {},
): Promise<OnboardingResult> {
	// Tiny step state machine so each step can resolve to "ok" or "back".
	// Esc on provider picker exits onboarding entirely; Esc on later steps
	// just rewinds to the previous step. This is what makes invalid keys
	// recoverable instead of a one-shot abort.
	//
	// No "auto-select from env" shortcut. Even when EXACTLY ONE provider
	// has an env key set, the user goes through the picker → `ensureApiKey`
	// → "Use existing X?" Yes/No prompt (with default = Yes). Skipping
	// silently to "we picked for you" was explicitly rejected because it
	// removes the explicit choice the user expects.

	// Step 0 — storage mode. Throws "onboarding-cancelled" if the user Escs
	// the mode picker (we treat that as bail-out, same as Esc on provider).
	// The storage-mode UI handles its own retry loop for the convex URL probe
	// and throws a special "storage-mode-revert-to-filesystem" when the user
	// Escs the convex sub-flow — we catch and default to filesystem so the
	// rest of the wizard always sees a settled choice.
	let storage: StorageModeResult;
	if (opts.storage) {
		// Caller already picked the mode AND booted the matching runtime context
		// (the onboard command hoists Step 0 so convex writes seal into the
		// backend). Don't re-run the picker or we'd prompt twice and risk a
		// second, conflicting mode pick.
		storage = opts.storage;
	} else {
		try {
			storage = await pickStorageMode(tui);
		} catch (err) {
			if ((err as Error).message === "storage-mode-revert-to-filesystem") {
				storage = { mode: "filesystem" };
			} else {
				throw err; // "onboarding-cancelled" propagates to caller
			}
		}
	}

	let step: "provider" | "key" | "model" = "provider";
	let provider = "";
	let modelId = "";

	while (true) {
		if (step === "provider") {
			renderScreen(tui, "Step 2 of 5 · Pick a provider");
			provider = await pickProvider(tui); // throws "onboarding-cancelled" on Esc
			step = "key";
			continue;
		}

		if (step === "key") {
			// Local providers (Ollama) skip API-key entry entirely. Instead we
			// validate the local server is up, discover its model list, and
			// register the provider in Pi's models.json so step 3 picks it up.
			const providerInfo = findProvider(provider);
			if (providerInfo?.local && providerInfo.id === "ollama") {
				const result = await ensureLocalOllama(tui, modelRegistry, providerInfo.baseUrl ?? "http://localhost:11434");
				if (result === "back") {
					step = "provider";
					continue;
				}
				step = "model";
				continue;
			}

			// CLI-login reuse — if the provider can adopt an already-logged-in
			// vendor CLI's token on this machine (Claude Code, Codex), offer the
			// one-keystroke "reuse this login" path FIRST. "other" means no CLI
			// login present (or the user opted for a key / fresh login), so we
			// fall through to the subscription / key path below.
			if (providerInfo?.cliLogin) {
				const r = await ensureCliLogin(tui, authStorage, providerInfo);
				if (r === "ok") {
					modelRegistry.refresh();
					step = "model";
					continue;
				}
				if (r === "back") {
					step = "provider";
					continue;
				}
				// r === "other" → fall through to the subscription/key path below
			}

			// Subscription providers (Claude Pro/Max, ChatGPT Plus/Pro, GitHub
			// Copilot) log in through a browser OAuth flow instead of pasting an
			// API key. The credential lands under the catalog `id` (which equals
			// the oauthProviderId for these), so Pi routes their models to the
			// right provider.
			// Codex + Copilot model menus come from Pi's bundled catalog
			// automatically; Copilot is further filtered to the account's enabled
			// models via the `availableModelIds` persisted on login.
			if (providerInfo?.subscription) {
				const result = await ensureSubscriptionLogin(tui, authStorage, providerInfo);
				if (result === "back") {
					step = "provider";
					continue;
				}
				modelRegistry.refresh();
				step = "model";
				continue;
			}

			// Custom (catalog-defined) providers — a key + a known
			// Anthropic-compatible endpoint (GLM, Kimi, Qwen, MiniMax, DeepSeek).
			// Paste the key, register the endpoint + models into models.json, done.
			// Also handles the generic "Custom (OpenAI-compatible)" entry, which
			// has `custom: true` but no pre-set `baseUrl`. `ensureCustomProvider`
			// prompts for the URL when it's missing. Without this, the generic
			// custom path falls through to `ensureApiKey`, which never writes
			// `models.json` — leaving the model unresolvable at gateway startup.
			if (providerInfo?.custom) {
				const r = await ensureCustomProvider(tui, authStorage, modelRegistry, providerInfo);
				if (r === "back") {
					step = "provider";
					continue;
				}
				step = "model";
				continue;
			}

			const result = await ensureApiKey(tui, authStorage, provider, {
				noEnvDetect: opts.noEnvDetect,
				secretInputMode: opts.secretInputMode,
			});
			if (result === "back") {
				step = "provider";
				continue;
			}
			modelRegistry.refresh(); // re-evaluate available models with the new key
			step = "model";
			continue;
		}

		// step === "model"
		renderScreen(tui, "Step 4 of 5 · Default model");
		const result = await pickModel(tui, modelRegistry, findProvider(provider)?.providerId ?? provider);
		if (result === "back") {
			step = "provider"; // go all the way back so they can change provider too
			continue;
		}
		modelId = result.modelId;
		// Selection precheck: for live-catalog custom providers (e.g. NVIDIA NIM), a
		// LISTED model can still hang — the catalog advertises models the account
		// can't actually serve. Probe the picked model now so the operator isn't left
		// discovering it's dead only on their first turn. Scoped to liveModels
		// providers; a quick, bounded request that verifies the model responds.
		const pinfo = findProvider(provider);
		if (pinfo?.liveModels && pinfo.baseUrl && modelId) {
			const probeKey =
				(await authStorage.getApiKey(pinfo.providerId ?? pinfo.id).catch(() => undefined)) ??
				readProviderEnvKey(pinfo);
			if (probeKey) {
				renderScreen(tui, "Step 4 of 5 · Default model");
				tui.addChild(new Text(brand.dim(`  Checking ${modelId} responds on ${pinfo.name}…`), 0, 0));
				tui.requestRender();
				const warning = describeModelProbe(
					await probeModelReachable(pinfo.baseUrl, probeKey, modelId),
					pinfo.name,
					modelId,
				);
				if (warning) {
					renderScreen(tui, "Step 4 of 5 · Default model");
					tui.addChild(new Text(`  ${brand.amber("⚠")} ${brand.amber(warning)}`, 0, 0));
					tui.addChild(new Text("", 0, 0));
					const choice = new SelectList(
						[
							{ value: "pick", label: "Pick another" },
							{ value: "keep", label: "Use it anyway" },
						],
						2,
						selectListTheme,
						{ minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 16 },
					);
					choice.setSelectedIndex(0); // default: pick another
					tui.addChild(choice);
					tui.setFocus(choice);
					tui.requestRender();
					let decision: "pick" | "keep" = "pick";
					try {
						const chosen = await new Promise<SelectItem>((resolve, reject) => {
							choice.onSelect = (item) => resolve(item);
							choice.onCancel = () => reject(new Error("back"));
						});
						decision = chosen.value === "keep" ? "keep" : "pick";
					} catch {
						decision = "pick";
					}
					tui.removeChild(choice);
					if (decision === "pick") {
						step = "model"; // loop back to the picker
						continue;
					}
				}
			}
		}
		break;
	}

	// No agent-naming step. The wizard ends at provider+auth+model — the
	// agent's identity is left for the agent itself to discover via
	// BOOTSTRAP.md on first turn. Workspace scaffolding still happens at
	// agent boot via `buildAgent → seedDefaultPrompts`.
	// A picker entry may resolve to a different Pi provider for routing — e.g.
	// "Claude Code" (subscription) stores under and routes through "anthropic".
	// Persist the REAL provider id so the runtime resolves the model + credential.
	const effectiveProvider = findProvider(provider)?.providerId ?? provider;
	await saveConfig({ defaultProvider: effectiveProvider, defaultModelId: modelId });

	// Step 5 of 5 — web-search backend. Same Pi-TUI components, same brand
	// header. Re-runnable via `brigade onboard web`.
	try {
		const { runWebSetupStep } = await import("../cli/flows/web-setup.js");
		await runWebSetupStep(tui, {
			stepLabel: "Step 5 of 5 · Web search",
			secretInputMode: opts.secretInputMode,
		});
	} catch {
		// Don't gate onboarding success on web-setup tripping — the user
		// can always run `brigade onboard web` later.
	}

	renderScreen(tui, ""); // brand-only frame for the "Ready." moment
	renderDone(tui, provider, modelId);
	await delay(900);
	clear(tui);

	return { provider: effectiveProvider, modelId, storage };
}

/* ────────────────────────── screen scaffolding ────────────────────────── */

/** Wipe everything, render the chunky brand header, then a sub-header line. */
function renderScreen(tui: TUI, subheader: string): void {
	clear(tui);
	renderBrandHeader(tui);
	if (subheader) {
		tui.addChild(new Text(brand.dim("  " + "─".repeat(54)), 0, 0));
		tui.addChild(new Text("", 0, 0));
		tui.addChild(new Text(`  ${brand.amber(subheader)}`, 0, 0));
		tui.addChild(new Text("", 0, 0));
		tui.requestRender();
	}
}

/* ────────────────────────────── steps ─────────────────────────────────── */

async function pickProvider(tui: TUI): Promise<string> {
	// Build the picker LOGIN-FIRST. The ranking surfaces, in order:
	//   0. Already connected — a vendor CLI login already on this machine
	//      (Claude Code / Codex) the user can reuse with no browser, no key.
	//   1. Already connected — a key already in the user's environment.
	//   2. Log in with a subscription (browser approval) — Claude Pro/Max,
	//      ChatGPT Plus/Pro, GitHub Copilot.
	//   3. Use a coding-plan subscription key — GLM, Kimi, Qwen, MiniMax, DeepSeek.
	//   4. Standard API-key providers.
	//   5. Local (Ollama) and 6. bring-your-own endpoint.
	// A type-to-filter box sits on top so the full list (18+) is searchable and
	// nothing — including Anthropic at the top — ever hides below the fold.
	const ranked: Array<{ rank: number; item: SelectItem }> = [];
	for (const p of PROVIDERS) {
		// A login the matching vendor CLI already minted on this machine?
		let cliReady = false;
		if (p.cliLogin) {
			const cred = p.cliLogin.read === "claude" ? readClaudeCliLogin() : readCodexCliLogin();
			cliReady = cred !== null;
		}
		const hasEnvKey = !!readProviderEnvKey(p);
		const isSubscription = !!p.subscription;
		const isCodingPlan = !!(p.custom && p.baseUrl);
		const isLocal = p.local === true || p.noAuth === true;
		const isBYO = p.custom === true && !p.baseUrl;

		let rank: number;
		let badge: string;
		// A subscription provider stays "log in" (browser-first, multi-account) even
		// when a CLI login is on disk — reuse is offered as a secondary option inside
		// the flow. Only a pure CLI-login provider gets the rank-0 "reuse" treatment.
		if (cliReady && !isSubscription) {
			rank = 0;
			badge = "logged in — reuse, no key";
		} else if (hasEnvKey) {
			rank = 1;
			badge = "detected — ready to use";
		} else if (isSubscription) {
			rank = 2;
			badge = "log in with your subscription";
		} else if (isCodingPlan) {
			rank = 3;
			badge = "use your coding-plan key";
		} else if (isLocal) {
			rank = 5;
			badge = "runs locally — no key";
		} else if (isBYO) {
			rank = 6;
			badge = "bring your own endpoint";
		} else {
			rank = 4;
			badge = ""; // standard API-key provider — its description says enough
		}

		ranked.push({
			rank,
			item: {
				value: p.id,
				label: p.name,
				description: badge ? `${p.description} · ${badge}` : p.description,
			},
		});
	}
	// Stable sort (V8) keeps catalog order within a rank.
	ranked.sort((a, b) => a.rank - b.rank);
	const items = ranked.map((r) => r.item);

	const list = new SearchableSelectList(items, 12, selectListTheme, {
		minPrimaryColumnWidth: 18,
		maxPrimaryColumnWidth: 24,
		formatHeader: (q, matchCount, total) =>
			brand.dim(
				q.length > 0
					? `  search: ${q}▌  (${matchCount}/${total} match${matchCount === 1 ? "" : "es"})`
					: `  ${total} providers · type to filter · ↑↓ move · Enter select · Esc back`,
			),
	});
	tui.addChild(list);
	tui.setFocus(list);
	tui.requestRender();

	const chosen = await new Promise<SelectItem>((resolve, reject) => {
		list.onSelect = (item) => resolve(item);
		list.onCancel = () => reject(new Error("onboarding-cancelled"));
	});

	return chosen.value;
}

/**
 * Prompt for the API key, validate it (locally + online), persist on success.
 * Returns:
 *   - "ok"   → key is valid and saved (or already existed)
 *   - "back" → user pressed Esc; caller should rewind to the previous step
 *
 * Loops on validation failure: the user sees "Wrong key — <reason>" inline
 * and re-enters the field with their previous attempt pre-filled. Esc on
 * the input bails out of the loop with "back" instead of throwing.
 */
export async function ensureApiKey(
	tui: TUI,
	authStorage: AuthStorage,
	providerId: string,
	opts: { noEnvDetect?: boolean; secretInputMode?: "plaintext" | "ref" } = {},
): Promise<"ok" | "back"> {
	const provider = findProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);

	// Already configured? (saved on disk OR set in shell env)
	//
	// Two sources, checked in order:
	//   1. `authStorage.getApiKey(providerId)` — Pi's stored credentials
	//      (~/.brigade/auth.json). Saved keys passed validation when first
	//      written, so we can fast-accept without re-pinging the provider.
	//   2. `readProviderEnvKey(provider)` — Brigade's shell-env reader. Honors
	//      the primary `envVar` PLUS `envVarFallbacks` (e.g. ANTHROPIC_OAUTH_TOKEN
	//      as a fallback for ANTHROPIC_API_KEY). Pi's `authStorage.getApiKey`
	//      does NOT consult shell env, so this fallback is what makes the
	//      env-confirmation flow below actually fire — without it, a user
	//      with `OPENROUTER_API_KEY` exported sees the paste-key prompt
	//      instead of "Use existing OPENROUTER_API_KEY?". `process.env`
	//      is read directly at key-entry time (post-provider-selection).
	//
	// CRITICAL: an env var being PRESENT doesn't mean it WORKS — stale
	// leftover values silently auto-completed onboarding before, letting
	// users reach chat with a dead key. The confirm-then-validate path
	// below catches that.
	//
	// `noEnvDetect` short-circuits the env path entirely: when true we
	// pretend no credential exists. This is the enterprise / CI escape
	// hatch — operators wanting TYPED-only auth flip the flag and Brigade
	// never silently consults `$env:OPENROUTER_API_KEY` or its peers.
	// Env-key detection — read process.env directly, prompt to confirm
	// whenever found, fall through to typed-paste on No or no-env.
	//
	// CRITICAL: env-confirm fires WHENEVER a shell env var is present, even
	// if a saved profile from a previous onboard already exists. The user
	// gets to re-affirm the env value (default Yes) or switch to a freshly
	// typed key. Skipping the prompt when "already saved" was explicitly
	// rejected because it removes that choice.
	//
	// `noEnvDetect` short-circuits env entirely (CI / typed-only operators).
	const envKey = opts.noEnvDetect ? undefined : readProviderEnvKey(provider);
	if (envKey) {
		// Env-supplied key: confirm with the user before adopting it. The
		// canonical form is `Use existing OPENROUTER_API_KEY (env:
		// OPENROUTER_API_KEY, sk-o…52b5)?`. Single line, default = Yes.
		// No explanatory paragraphs.
		const envVar = provider.envVar ?? "the env var";
		renderScreen(tui, `Step 3 of 5 · ${provider.name}`);
		tui.addChild(
			new Text(
				`  ${brand.amber("?")} We found a saved ${provider.name} key on this computer (${formatApiKeyPreview(envKey)}). Use it?`,
				0,
				0,
			),
		);
		tui.addChild(new Text("", 0, 0));

		const confirmList = new SelectList(
			[
				{ value: "yes", label: "Yes" },
				{ value: "no", label: "No" },
			],
			2,
			selectListTheme,
			{ minPrimaryColumnWidth: 6, maxPrimaryColumnWidth: 8 },
		);
		confirmList.setSelectedIndex(0); // default Yes
		tui.addChild(confirmList);
		tui.setFocus(confirmList);
		tui.requestRender();

		let confirmChoice: "yes" | "no";
		try {
			const chosen = await new Promise<SelectItem>((resolve, reject) => {
				confirmList.onSelect = (item) => resolve(item);
				confirmList.onCancel = () => reject(new Error("back"));
			});
			confirmChoice = chosen.value === "yes" ? "yes" : "no";
		} catch {
			return "back";
		}
		tui.removeChild(confirmList);

		if (confirmChoice === "no") {
			// User declined the env key — skip the validation path entirely
			// and let them paste their own. The typed-key loop below treats
			// `lastError === null` as a clean first iteration, so no stale
			// error text leaks in.
			renderScreen(tui, `Step 3 of 5 · ${provider.name}`);
			// Fall through to typed-key loop without `lastError` set.
			// (Variable declared just below the env block.)
			return await promptTypedKey(tui, authStorage, provider, providerId, null);
		}

		// User confirmed — verify the env key actually works before accepting.
		tui.addChild(
			new Text(
				`  ${brand.dim(`Checking your ${provider.name} key…`)}`,
				0,
				0,
			),
		);
		const envLoader = new CancellableLoader(
			tui,
			(s) => brand.amber(s),
			(s) => brand.dim(s),
			`Verifying ${provider.name}…`,
		);
		tui.addChild(envLoader);
		tui.requestRender();

		const envCheck = await validateApiKeyOnline(providerId, envKey);
		tui.removeChild(envLoader);

		if (envCheck.ok) {
			// Two persistence shapes, switched by `secretInputMode`. Both
			// write to `~/.brigade/agents/<id>/agent/auth-profiles.json`
			// under the same `profileId(provider)`; the shape on disk
			// differs:
			//
			//   PLAINTEXT (default):
			//     { type: "api_key", provider, key: "sk-or-v1-abc…" }
			//
			//   REF:
			//     { type: "api_key", provider,
			//       keyRef: { source: "env", provider: "default", id: "<MATCHED_VAR>" } }
			//
			// Critical for ref mode: the `id` MUST be the env var that
			// actually held the value (could be `provider.envVar` OR a
			// `provider.envVarFallbacks[i]` like `ANTHROPIC_OAUTH_TOKEN`).
			// Pinning to `provider.envVar` blindly would leave the agent unable
			// to resolve the key at runtime when a fallback satisfied the read.
			//
			// In-process seeding (so the wizard can immediately use the key):
			//   - PLAINTEXT: `authStorage.set` writes Pi's in-memory store AND
			//     ~/.brigade/auth.json. Fine — it's the same literal value
			//     auth-profiles.json holds.
			//   - REF: `authStorage.set` would persist the LITERAL value to
			//     ~/.brigade/auth.json, defeating ref mode (literal would land
			//     in TWO files on disk). Skip it; rely on `process.env` already
			//     holding the value (it's where we read it from). The runtime
			//     reads via `loadBrigadeAuthStorage` → `resolveProfileKey` →
			//     `process.env[keyRef.id]` (auth-bridge.ts:101-117).
			const mode = opts.secretInputMode ?? "plaintext";
			const envSource = resolveProviderEnvVarSource(provider);
			if (mode === "ref" && envSource) {
				upsertApiKeyRefProfile(DEFAULT_AGENT_ID, {
					provider: providerId,
					keyRef: { source: "env", provider: "default", id: envSource.name },
				});
				// process.env already has it (we just read from it). Belt-and-
				// suspenders: ensure it sticks for the in-process agent.
				process.env[envSource.name] = envSource.value;
			} else {
				upsertApiKeyProfile(DEFAULT_AGENT_ID, {
					provider: providerId,
					key: envKey,
				});
				authStorage.set(providerId, { type: "api_key", key: envKey });
			}
			const pinShape = mode === "ref" ? "the key already on this computer" : "your saved key";
			tui.addChild(
				new Text(
					`  ${brand.amber("✓")} ${provider.name} is already connected (using ${brand.white(pinShape)}).`,
					0,
					0,
				),
			);
			tui.requestRender();
			await delay(600);
			return "ok";
		}

		// Stale env var (user confirmed but it failed validation). Don't auto-
		// skip — drop into the typed-key path with the failure seeded so the
		// user immediately sees WHY their env key didn't work and can paste a
		// fresh one.
		const staleReason = `That saved ${provider.name} key didn't work: ${envCheck.reason}`;
		return await promptTypedKey(tui, authStorage, provider, providerId, staleReason);
	}

	return await promptTypedKey(tui, authStorage, provider, providerId, null);
}

/**
 * Typed-key entry loop, extracted so both the env-confirm-no path and the
 * no-env-key path can share it without duplicating the retry/validate dance.
 *
 * `seedError` lets the caller pre-render an error line above the input —
 * used when a confirmed env key fails online validation, so the user sees
 * "the env var didn't work" reason instead of a blank "paste your key" prompt.
 *
 * Returns:
 *   - "ok"   → key validated and persisted
 *   - "back" → user pressed Esc; caller rewinds to provider picker
 */
async function promptTypedKey(
	tui: TUI,
	authStorage: AuthStorage,
	provider: ProviderInfo,
	providerId: string,
	seedError: string | null,
): Promise<"ok" | "back"> {
	// Retry loop. Each iteration re-renders the screen so old error lines and
	// stale loader frames don't pile up vertically.
	let lastError: string | null = seedError;

	while (true) {
		renderScreen(tui, `Step 3 of 5 · ${provider.name}`);

		if (lastError) {
			tui.addChild(new Text(`  ${brand.error("✗")} ${brand.error(lastError)}`, 0, 0));
			tui.addChild(new Text(brand.dim("  Press Enter to try again, or Esc to choose a different provider."), 0, 0));
			tui.addChild(new Text("", 0, 0));
		}

		tui.addChild(new Text(`  Paste your ${provider.name} API key.`, 0, 0));
		tui.addChild(new Text(brand.dim(`  We'll keep it private to this device.  Need a key? ${provider.keyUrl}`), 0, 0));
		tui.addChild(new Text(brand.dim("  Enter to continue  ·  Esc to go back"), 0, 0));
		tui.addChild(new Text("", 0, 0));

		const input = new Input();
		tui.addChild(input);
		tui.setFocus(input);
		tui.requestRender();

		let key: string;
		try {
			key = await new Promise<string>((resolve, reject) => {
				input.onSubmit = (value: string) => resolve(sanitizePastedValue(value));
				input.onEscape = () => reject(new Error("back"));
			});
		} catch {
			return "back"; // user pressed Esc — caller rewinds to provider picker
		}

		// Step 1: cheap, format-agnostic sanity check (length, whitespace only).
		const localCheck = validateApiKey(key);
		if (!localCheck.ok) {
			lastError = localCheck.reason;
			continue;
		}

		// Step 2: live online validation against the provider's /v1/models endpoint.
		// This catches revoked / wrong-provider / typo'd keys BEFORE we persist.
		tui.addChild(new Text("", 0, 0));
		const loader = new CancellableLoader(
			tui,
			(s) => brand.amber(s),
			(s) => brand.dim(s),
			`Verifying with ${provider.name}…`,
		);
		tui.addChild(loader);
		tui.requestRender();

		const onlineCheck = await validateApiKeyOnline(providerId, key);
		tui.removeChild(loader);

		if (!onlineCheck.ok) {
			lastError = onlineCheck.reason;
			continue;
		}

		// Step 3: only persist after both checks pass.
		// Wizard owns ALL persistence (no post-wizard bridge mirror that
		// could clobber a keyRef profile):
		//   - upsertApiKeyProfile → ~/.brigade/agents/<id>/agent/auth-profiles.json
		//     (the canonical credential store; `rm -rf ~/.brigade` wipes it)
		//   - authStorage.set → Pi's in-memory store + ~/.brigade/auth.json
		//     (so the wizard process can immediately use the key for the model
		//     picker that runs next; on disk it's a redundant mirror of the
		//     same literal value, fine for plaintext)
		// Typed-paste is always plaintext — there's no env var to reference,
		// the value originated in a TUI input box.
		upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: providerId, key });
		authStorage.set(providerId, { type: "api_key", key });
		authStorage.reload();

		const successLine = onlineCheck.modelCount
			? `${provider.name} connected · ${onlineCheck.modelCount} model${onlineCheck.modelCount === 1 ? "" : "s"} available`
			: `${provider.name} connected`;
		tui.addChild(new Text(`  ${brand.amber("✓")} ${successLine}.`, 0, 0));
		if (onlineCheck.warning) {
			tui.addChild(new Text(`  ${brand.dim("Note: " + onlineCheck.warning)}`, 0, 0));
		}
		tui.requestRender();
		await delay(500);
		return "ok";
	}
}

/**
 * Cheap, provider-AGNOSTIC sanity check on the pasted key.
 * Catches only the universal mistakes (empty, obviously truncated, stray
 * whitespace/newline) BEFORE we persist garbage to disk. It deliberately does
 * NOT guess at per-provider key prefixes: key formats change over time (e.g.
 * Google now issues both "AIza…" and "AQ.…" Gemini keys), and hard-coding the
 * expected letters wrongly rejects perfectly valid keys. Whether the key is
 * actually accepted is decided *dynamically* by `validateApiKeyOnline`, which
 * fires a real request at the provider and judges by the live response.
 */
function validateApiKey(key: string): { ok: true } | { ok: false; reason: string } {
	if (!key) return { ok: false, reason: "Please enter an API key." };
	if (key.length < 16) return { ok: false, reason: `That looks incomplete (only ${key.length} characters). Try copying the key again.` };
	if (/\s/.test(key)) return { ok: false, reason: "The key has extra spaces or line breaks. Copy just the key value." };
	return { ok: true };
}

/**
 * Local-provider variant of `ensureApiKey`. For Ollama:
 *   1. Ping `/api/tags` to confirm the daemon is running.
 *   2. List the user's locally-pulled models.
 *   3. Write the provider config (and inferred model definitions) into
 *      `~/.brigade/models.json` so Pi's `ModelRegistry` exposes them.
 *   4. Refresh the registry so the next step's model picker can see them.
 *
 * If discovery fails, show a friendly error with the next step the user
 * needs to take (start the daemon, pull a model). Esc returns "back".
 */
async function ensureLocalOllama(
	tui: TUI,
	modelRegistry: ModelRegistry,
	baseUrl: string,
): Promise<"ok" | "back"> {
	let lastError: string | null = null;

	while (true) {
		renderScreen(tui, "Step 3 of 5 · Connect Ollama");

		if (lastError) {
			tui.addChild(new Text(`  ${brand.error("✗")} ${brand.error(lastError)}`, 0, 0));
			tui.addChild(new Text(brand.dim("  Press Enter to try again, or Esc to choose a different provider."), 0, 0));
			tui.addChild(new Text("", 0, 0));
		}

		tui.addChild(new Text(`  Brigade will scan your local Ollama for available models.`, 0, 0));
		tui.addChild(new Text(brand.dim(`  Don't have Ollama yet? Get it at https://ollama.com/download`), 0, 0));
		tui.addChild(new Text(brand.dim("  Enter to scan  ·  Esc to go back"), 0, 0));

		// Use an Input as a confirm-prompt — user just hits Enter (or Esc).
		const confirm = new Input();
		tui.addChild(confirm);
		tui.setFocus(confirm);
		tui.requestRender();

		try {
			await new Promise<void>((resolve, reject) => {
				confirm.onSubmit = () => resolve();
				confirm.onEscape = () => reject(new Error("back"));
			});
		} catch {
			return "back";
		}

		// Discover models with a loader spinner.
		const loader = new CancellableLoader(
			tui,
			(s) => brand.amber(s),
			(s) => brand.dim(s),
			"Scanning Ollama…",
		);
		tui.addChild(loader);
		tui.requestRender();

		let discovered;
		try {
			discovered = await discoverOllamaModels(baseUrl);
		} catch (err) {
			tui.removeChild(loader);
			lastError = err instanceof Error ? err.message : String(err);
			continue;
		}

		// Persist the provider entry so Pi sees the models from now on.
		const modelsJsonPath = resolveModelsPath(DEFAULT_AGENT_ID);
		try {
			await writeOllamaToModelsJson(modelsJsonPath, baseUrl, discovered);
			modelRegistry.refresh();
		} catch (err) {
			tui.removeChild(loader);
			lastError = `Couldn't save the connection: ${err instanceof Error ? err.message : String(err)}`;
			continue;
		}

		tui.removeChild(loader);
		tui.addChild(new Text(`  ${brand.amber("✓")} Ollama connected · ${brand.white(String(discovered.length))} model${discovered.length === 1 ? "" : "s"} available.`, 0, 0));
		tui.requestRender();
		await delay(500);
		return "ok";
	}
}

/**
 * Subscription-login variant of `ensureApiKey`. For providers that carry a
 * `subscription` descriptor (Anthropic, OpenAI Codex, GitHub Copilot) we run
 * Pi's OAuth login flow instead of asking for an API key:
 *   1. Confirm with the user (Enter to start the browser flow, Esc to go back).
 *   2. Drive `oauthProvider.login(...)` — Pi does NOT open the browser, so our
 *      `onAuth` callback does (best-effort, per-platform).
 *   3. On success, persist the returned credential to BOTH credential stores
 *      (auth-profiles.json via `upsertOAuthProfile` + auth.json via
 *      `authStorage.set`) so the wizard process and every future boot can use it.
 *
 * Modeled on `ensureLocalOllama`: a retry `while(true)` loop with a `lastError`
 * line and Esc → "back". Any thrown error (including the user aborting the
 * flow) is caught and surfaced inline so the user can retry or pick a different
 * provider.
 */
export async function ensureSubscriptionLogin(
	tui: TUI,
	authStorage: AuthStorage,
	provider: ProviderInfo,
): Promise<"ok" | "back"> {
	const sub = provider.subscription!;
	const oauthProvider = getOAuthProvider(sub.oauthProviderId);
	if (!oauthProvider) {
		// Pi build doesn't know this provider — fail cleanly back to the picker
		// rather than crashing the wizard.
		renderScreen(tui, `Step 3 of 5 · ${provider.name}`);
		tui.addChild(
			new Text(`  ${brand.error("✗")} ${brand.error(`${provider.name} sign-in isn't supported yet.`)}`, 0, 0),
		);
		tui.addChild(new Text(brand.dim("  Taking you back to choose another provider…"), 0, 0));
		tui.requestRender();
		await delay(900);
		return "back";
	}

	let lastError: string | null = null;

	while (true) {
		renderScreen(tui, `Step 3 of 5 · ${provider.name}`);

		if (lastError) {
			tui.addChild(new Text(`  ${brand.error("✗")} ${brand.error(lastError)}`, 0, 0));
			tui.addChild(new Text(brand.dim("  Press Enter to try again, or Esc to choose a different provider."), 0, 0));
			tui.addChild(new Text("", 0, 0));
		}

		tui.addChild(new Text(`  ${brand.white(sub.label)}`, 0, 0));
		tui.addChild(new Text(brand.dim("  We'll open your browser to sign in. Approve it there — we'll wait."), 0, 0));
		tui.addChild(new Text(brand.dim("  Enter to start  ·  Esc to go back"), 0, 0));

		// Confirm-gate (mirrors ensureLocalOllama) so the user can Esc out BEFORE
		// the browser opens. Just hits Enter to proceed, or Esc to rewind.
		const confirm = new Input();
		tui.addChild(confirm);
		tui.setFocus(confirm);
		tui.requestRender();

		try {
			await new Promise<void>((resolve, reject) => {
				confirm.onSubmit = () => resolve();
				confirm.onEscape = () => reject(new Error("back"));
			});
		} catch {
			return "back";
		}
		tui.removeChild(confirm);

		// Drive the OAuth flow. `controller` lets the callbacks (and an Esc) abort
		// the in-flight login; Pi honors `signal` across its loopback wait.
		const controller = new AbortController();
		let creds;
		try {
			creds = await oauthProvider.login({
				// Pi does NOT open the browser — we do. onAuth is fire-and-forget
				// (void), so don't await here; just kick the browser + show the URL
				// and a waiting spinner.
				onAuth: (info) => {
					tui.addChild(new Text(`  ${brand.amber("→")} Opening your browser to sign in…`, 0, 0));
					openSubscriptionBrowser(info.url);
					tui.addChild(new Text("", 0, 0));
					tui.addChild(new Text("  " + brand.amber(info.url), 0, 0));
					tui.addChild(
						new Text(brand.dim("  If your browser didn't open, copy the link above. Paste the code here if asked."), 0, 0),
					);
					if (info.instructions) tui.addChild(new Text(brand.dim("  " + info.instructions), 0, 0));
					// Wire Escape to abort the in-flight login. The loader only
					// receives key input (handleInput) while it holds focus, so set
					// focus AND point onAbort at the login controller.
					const waitLoaderAuth = new CancellableLoader(tui, (s) => brand.amber(s), (s) => brand.dim(s), "Waiting for you to authorize…");
					waitLoaderAuth.onAbort = () => controller.abort();
					tui.addChild(waitLoaderAuth);
					tui.setFocus(waitLoaderAuth);
					tui.requestRender();
				},
				// Loopback-callback providers (anthropic, openai-codex) also let the
				// user paste the redirect URL / code by hand — this races the local
				// callback server internally. Resolve from an Input; Esc rejects to
				// abort the whole login.
				onManualCodeInput: () =>
					new Promise<string>((resolve, reject) => {
						tui.addChild(new Text("", 0, 0));
						tui.addChild(new Text(brand.dim("  Paste the code or redirect URL, then press Enter  ·  Esc to cancel"), 0, 0));
						const input = new Input();
						tui.addChild(input);
						tui.setFocus(input);
						tui.requestRender();
						input.onSubmit = (value: string) => resolve(sanitizePastedValue(value));
						input.onEscape = () => reject(new Error("cancelled"));
					}),
				// Device-code providers (github-copilot): show the verification URL +
				// user code, plus a waiting spinner while Pi polls for completion.
				onDeviceCode: (info) => {
					openSubscriptionBrowser(info.verificationUri);
					tui.addChild(new Text("", 0, 0));
					tui.addChild(
						new Text(`  Go to ${brand.amber(info.verificationUri)} and enter code: ${brand.amber(info.userCode)}`, 0, 0),
					);
					tui.addChild(new Text(brand.dim("  If your browser didn't open, copy the link above."), 0, 0));
					// Wire Escape to abort the in-flight login (device-code path). The
					// loader only receives key input while focused, so set focus AND
					// point onAbort at the login controller.
					const waitLoaderDevice = new CancellableLoader(tui, (s) => brand.amber(s), (s) => brand.dim(s), "Waiting for you to authorize…");
					waitLoaderDevice.onAbort = () => controller.abort();
					tui.addChild(waitLoaderDevice);
					tui.setFocus(waitLoaderDevice);
					tui.requestRender();
				},
				// Free-form prompt (rare). Render the message + an Input; honor
				// allowEmpty so a blank submit is accepted when the provider allows it.
				onPrompt: (p) =>
					new Promise<string>((resolve, reject) => {
						tui.addChild(new Text("", 0, 0));
						tui.addChild(new Text(`  ${p.message}`, 0, 0));
						const input = new Input();
						tui.addChild(input);
						tui.setFocus(input);
						tui.requestRender();
						input.onSubmit = (value: string) => {
							const v = value.trim();
							if (!v && !p.allowEmpty) return; // keep waiting for a value
							resolve(v);
						};
						input.onEscape = () => reject(new Error("cancelled"));
					}),
				// Best-effort progress line.
				onProgress: (msg) => {
					tui.addChild(new Text(brand.dim("  " + msg), 0, 0));
					tui.requestRender();
				},
				// REQUIRED for openai-codex: it calls onSelect FIRST (browser vs
				// device-code) and throws if absent. Render a SelectList; resolve the
				// chosen id, or undefined on cancel.
				onSelect: (p) =>
					new Promise<string | undefined>((resolve) => {
						tui.addChild(new Text("", 0, 0));
						tui.addChild(new Text(`  ${p.message}`, 0, 0));
						const list = new SelectList(
							p.options.map((o) => ({ value: o.id, label: o.label })),
							Math.min(p.options.length, 6),
							selectListTheme,
							{ minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 28 },
						);
						tui.addChild(list);
						tui.setFocus(list);
						tui.requestRender();
						list.onSelect = (item) => resolve(item.value);
						list.onCancel = () => resolve(undefined);
					}),
				signal: controller.signal,
			});
		} catch (err) {
			controller.abort();
			const reason = err instanceof Error ? err.message : String(err);
			// "cancelled" / "back" are user-initiated aborts — surface a soft line
			// and let them retry; anything else is a real failure. NEVER render
			// the raw Pi reason (it can leak a URL / status / internal detail) —
			// map it to a friendly, generic line. The soft-cancel branch also
			// matches Pi's "Login cancelled" wording so a user abort reads clean.
			const softCancel =
				/^login cancelled$/i.test(reason) || reason === "cancelled" || reason === "back";
			lastError = softCancel
				? "Login cancelled. Start again, or pick a different provider."
				: "We couldn't finish signing you in. Check your connection and try again.";
			continue;
		}

		// Persist to BOTH stores (NOT authStorage.login, which would only write
		// auth.json): auth-profiles.json is the canonical credential store the
		// agent boots from; auth.json is Pi's in-process mirror so the model
		// picker that runs next can use the token immediately.
		// Resolve to the real Pi provider for storage — e.g. the "claude-code"
		// entry stores its OAuth credential under "anthropic".
		const providerId = provider.providerId ?? provider.id;
		// Preserve provider-specific extras the login returned — notably GitHub
		// Copilot's `availableModelIds` (the exact models THIS account's plan
		// enabled), which Pi's `modifyModels` uses to filter the model menu. Hand
		// the whole credential to Pi's in-memory store and stash the extras in the
		// profile metadata so they survive a reboot.
		const { access, refresh, expires, ...extras } = creds;
		upsertOAuthProfile(DEFAULT_AGENT_ID, {
			provider: providerId,
			access,
			refresh,
			expires,
			metadata: Object.keys(extras).length > 0 ? extras : undefined,
		});
		authStorage.set(providerId, { type: "oauth", ...creds });
		authStorage.reload();

		// Warm the live model cache with THIS account's current models so the
		// model picker (next step) shows exactly what the subscription enables,
		// not just Pi's bundled snapshot. Best-effort — `prefetchSubscriptionModels`
		// swallows its own errors, and the picker falls back to the catalog if the
		// cache is empty (codex, or an unauthorized/failed fetch).
		try {
			await prefetchSubscriptionModels(providerId, creds.access);
		} catch {
			/* best-effort — picker falls back to the catalog */
		}

		tui.addChild(new Text("", 0, 0));
		tui.addChild(new Text(`  ${brand.amber("✓")} ${provider.name} connected.`, 0, 0));
		tui.requestRender();
		await delay(600);
		return "ok";
	}
}

/**
 * Connect a subscription provider that ALSO has a vendor CLI login on disk
 * (Claude Code / Codex). When such a login exists we present a choice that LEADS
 * with browser sign-in — the right default when several people each use their own
 * account — and offers reusing this machine's existing login as the convenience
 * second option.
 *
 * Returns:
 *   - "ok"    → reused the on-disk CLI login and persisted it
 *   - "back"  → user pressed Esc; caller rewinds to the provider picker
 *   - "other" → no CLI login present, OR the user chose browser sign-in; caller
 *               falls through to the subscription (browser OAuth) / key path
 */
async function ensureCliLogin(
	tui: TUI,
	authStorage: AuthStorage,
	provider: ProviderInfo,
): Promise<"ok" | "back" | "other"> {
	const cred = provider.cliLogin!.read === "claude" ? readClaudeCliLogin() : readCodexCliLogin();
	if (!cred) return "other"; // no CLI login present on this machine

	// A login is already on this machine — but LEAD with browser sign-in: it works
	// for ANY account, which is what you want when different people each use their
	// own subscription. Reuse is the second, convenience option.
	renderScreen(tui, `Step 3 of 5 · ${provider.name}`);
	tui.addChild(new Text(`  ${brand.amber(`How do you want to connect ${provider.name}?`)}`, 0, 0));
	tui.addChild(new Text("", 0, 0));

	const choiceList = new SelectList(
		[
			{ value: "login", label: "Log in with your account", description: "Opens your browser — works for any account" },
			{ value: "reuse", label: "Reuse this machine's login", description: "The account already signed in here" },
		],
		2,
		selectListTheme,
		{ minPrimaryColumnWidth: 26, maxPrimaryColumnWidth: 32 },
	);
	tui.addChild(choiceList);
	tui.setFocus(choiceList);
	tui.requestRender();

	let choice: "reuse" | "other";
	try {
		const picked = await new Promise<string>((resolve, reject) => {
			choiceList.onSelect = (item) => resolve(item.value);
			choiceList.onCancel = () => reject(new Error("back"));
		});
		choice = picked === "reuse" ? "reuse" : "other";
	} catch {
		return "back";
	}

	// Browser sign-in → caller runs the subscription (OAuth) login next.
	if (choice === "other") return "other";

	// Reuse path — persist to BOTH stores (auth-profiles.json is canonical; the
	// authStorage mirror lets the wizard's model picker use the credential now).
	if (cred.type === "oauth") {
		upsertOAuthProfile(DEFAULT_AGENT_ID, {
			provider: cred.provider,
			access: cred.access,
			refresh: cred.refresh,
			expires: cred.expires,
		});
		authStorage.set(cred.provider, {
			type: "oauth",
			access: cred.access,
			refresh: cred.refresh,
			// Pi's in-memory oauth shape requires a numeric `expires`. When the CLI
			// file carried no expiry, seed 0 so Pi treats the access token as
			// expired and refreshes via the refresh token on first use. The durable
			// profile (above) keeps the real value (possibly undefined).
			expires: cred.expires ?? 0,
		});
	} else if (provider.subscription) {
		// The reused CLI login has NO refresh token (Claude Code didn't store one).
		// Persisting it would create a credential that expires in a day or two and
		// CAN'T auto-refresh — the silent 401 the operator hit. Since this provider
		// supports a browser OAuth login (which DOES return a refresh token), steer
		// there instead of saving a dead-end token. The caller falls through to
		// `ensureSubscriptionLogin` when we return "other".
		tui.addChild(new Text("", 0, 0));
		tui.addChild(
			new Text(`  ${brand.dim("This machine's login has no refresh token, so it would expire and couldn't refresh.")}`, 0, 0),
		);
		tui.addChild(
			new Text(`  ${brand.dim("Doing a quick browser sign-in instead so the crew stays connected.")}`, 0, 0),
		);
		tui.requestRender();
		await delay(1200);
		return "other";
	} else {
		// No OAuth fallback for this provider — keep the legacy token behaviour.
		// Durable store keeps the type:"token" shape (upsertTokenProfile). Mirror
		// it into Pi's in-memory store as type:"oauth" for shape-consistency with
		// the refresh-capable path — a credential with an access token but no
		// refresh token. expires:0 makes Pi treat the access token as expired and
		// refresh on first use when a refresh token later exists.
		upsertTokenProfile(DEFAULT_AGENT_ID, { provider: cred.provider, token: cred.token });
		// Pi's in-memory OAuthCredential requires a `refresh` string; this CLI
		// credential carries no refresh token, so seed "".
		authStorage.set(cred.provider, { type: "oauth", access: cred.token, refresh: "", expires: cred.expires ?? 0 });
	}
	authStorage.reload();

	// Warm the live model cache (best-effort — picker falls back to the catalog).
	try {
		await prefetchSubscriptionModels(cred.provider, cred.type === "oauth" ? cred.access : cred.token);
	} catch {
		/* best-effort */
	}

	tui.addChild(new Text("", 0, 0));
	tui.addChild(new Text(`  ${brand.amber("✓")} ${provider.name} connected (using your existing login).`, 0, 0));
	tui.requestRender();
	await delay(600);
	return "ok";
}

/**
 * Custom (catalog-defined) provider entry. For providers that carry a key + a
 * known Anthropic-compatible endpoint (GLM, Kimi, Qwen, MiniMax, DeepSeek): ask
 * for the key, persist it, register the endpoint + catalog models into
 * models.json, then refresh the registry so the model picker sees them.
 *
 * Returns:
 *   - "ok"   → key saved, provider registered
 *   - "back" → user pressed Esc; caller rewinds to the provider picker
 */
async function ensureCustomProvider(
	tui: TUI,
	authStorage: AuthStorage,
	modelRegistry: ModelRegistry,
	provider: ProviderInfo,
): Promise<"ok" | "back"> {
	// Generic custom provider — the catalog entry has `custom: true` but no
	// pre-set `baseUrl` (it varies per user). Prompt for the URL before the
	// key-entry loop, then attach it to a shallow copy so the downstream
	// write path sees a fully resolved provider without mutating the catalog.
	if (!provider.baseUrl) {
		while (true) {
			renderScreen(tui, `Step 3 of 5 · ${provider.name}`);
			tui.addChild(new Text(`  Enter your OpenAI-compatible base URL.`, 0, 0));
			tui.addChild(new Text(brand.dim("  Example: https://api.example.com/v1"), 0, 0));
			tui.addChild(new Text(brand.dim("  Enter to continue  ·  Esc to go back"), 0, 0));
			tui.addChild(new Text("", 0, 0));
			const urlInput = new Input();
			tui.addChild(urlInput);
			tui.setFocus(urlInput);
			tui.requestRender();
			let rawUrl: string;
			try {
				rawUrl = await new Promise<string>((resolve, reject) => {
					urlInput.onSubmit = (value: string) => resolve(value.trim());
					urlInput.onEscape = () => reject(new Error("back"));
				});
			} catch {
				return "back";
			}
			if (!rawUrl) {
				// Empty submit — re-render with a hint.
				continue;
			}
			// Minimal URL sanity check — must start with http(s)://.
			if (!/^https?:\/\//i.test(rawUrl)) {
				renderScreen(tui, `Step 3 of 5 · ${provider.name}`);
				tui.addChild(new Text(`  ${brand.error("✗")} ${brand.error("URL must start with http:// or https://")}`, 0, 0));
				tui.addChild(new Text("", 0, 0));
				continue;
			}
			provider = { ...provider, baseUrl: rawUrl, api: provider.api ?? "openai-completions" };
			break;
		}
	}
	let lastError: string | null = null;
	// If the operator already has this provider's key in their environment (e.g.
	// NVIDIA_API_KEY), OFFER it — confirm-then-validate, never silent-adopt. A
	// present env var isn't proof it works, and the operator may want to paste a
	// different key; this mirrors the standard-provider env-confirm flow (a past
	// bug let stale env values silently complete onboarding). On "No" (or a key
	// that fails validation) we fall through to the normal paste prompt.
	const envKeyRaw = readProviderEnvKey(provider);
	let pendingEnvKey: string | null =
		typeof envKeyRaw === "string" && envKeyRaw.trim().length > 0 ? envKeyRaw.trim() : null;
	while (true) {
		let key: string;
		if (pendingEnvKey) {
			const candidate = pendingEnvKey;
			pendingEnvKey = null; // offer once; on decline/failure fall through to paste
			renderScreen(tui, `Step 3 of 5 · ${provider.name}`);
			tui.addChild(
				new Text(
					`  ${brand.amber("?")} We found a saved ${provider.name} key on this computer (${formatApiKeyPreview(candidate)}). Use it?`,
					0,
					0,
				),
			);
			tui.addChild(new Text("", 0, 0));
			const confirmList = new SelectList(
				[
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
				2,
				selectListTheme,
				{ minPrimaryColumnWidth: 6, maxPrimaryColumnWidth: 8 },
			);
			confirmList.setSelectedIndex(0); // default Yes
			tui.addChild(confirmList);
			tui.setFocus(confirmList);
			tui.requestRender();
			let useEnv: boolean;
			try {
				const chosen = await new Promise<SelectItem>((resolve, reject) => {
					confirmList.onSelect = (item) => resolve(item);
					confirmList.onCancel = () => reject(new Error("back"));
				});
				useEnv = chosen.value === "yes";
			} catch {
				return "back";
			}
			tui.removeChild(confirmList);
			if (!useEnv) continue; // declined → paste prompt on the next pass
			key = candidate;
		} else {
			renderScreen(tui, `Step 3 of 5 · ${provider.name}`);

			if (lastError) {
				tui.addChild(new Text(`  ${brand.error("✗")} ${brand.error(lastError)}`, 0, 0));
				tui.addChild(new Text(brand.dim("  Press Enter to try again, or Esc to choose a different provider."), 0, 0));
				tui.addChild(new Text("", 0, 0));
			}

			tui.addChild(new Text(`  Paste your ${provider.name} key.`, 0, 0));
			tui.addChild(new Text(brand.dim(`  Get one at ${provider.keyUrl}`), 0, 0));
			tui.addChild(new Text(brand.dim("  Enter to continue  ·  Esc to go back"), 0, 0));
			tui.addChild(new Text("", 0, 0));

			const input = new Input();
			tui.addChild(input);
			tui.setFocus(input);
			tui.requestRender();

			try {
				key = await new Promise<string>((resolve, reject) => {
					input.onSubmit = (value: string) => resolve(sanitizePastedValue(value));
					input.onEscape = () => reject(new Error("back"));
				});
			} catch {
				return "back";
			}

			// Empty submit — show a one-line hint instead of silently re-rendering.
			if (!key) {
				lastError = "Please enter an API key.";
				continue;
			}
		}

		// Cheap, format-agnostic sanity check (length / whitespace). Custom
		// endpoints vary, so we do NOT online-validate here — but an obviously
		// malformed key is rejected with feedback rather than persisted.
		const localCheck = validateApiKey(key);
		if (!localCheck.ok) {
			lastError = localCheck.reason;
			continue;
		}

		// LIVE model discovery (e.g. NVIDIA NIM): fetch the served set from the
		// provider's OpenAI-compatible /models endpoint BEFORE persisting anything.
		// The fetch also online-validates the key — a bad key returns nothing, so we
		// re-prompt instead of saving a dead provider with a stale hardcoded list.
		let models = provider.models ?? [];
		if (provider.liveModels && provider.baseUrl) {
			tui.addChild(new Text(brand.dim(`  Fetching ${provider.name} models…`), 0, 0));
			tui.requestRender();
			const ids = await fetchOpenAICompatibleModelIds(provider.baseUrl, key);
			if (!ids || ids.length === 0) {
				// A null/empty result means either a rejected key OR an unreachable
				// endpoint (firewall/proxy/offline) — don't accuse the key outright.
				lastError = `Couldn't reach ${provider.name}, or the key was rejected. Check your connection and the key, then try again.`;
				continue;
			}
			models = ids;
		}

		upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: provider.id, key });
		authStorage.set(provider.id, { type: "api_key", key });
		authStorage.reload();
		await writeCustomProviderToModelsJson(resolveModelsPath(DEFAULT_AGENT_ID), {
			id: provider.id,
			baseUrl: provider.baseUrl!,
			api: provider.api!,
			apiKey: key,
			models,
		});
		modelRegistry.refresh();

		const countNote = provider.liveModels ? ` · ${brand.white(String(models.length))} models` : "";
		tui.addChild(new Text(`  ${brand.amber("✓")} ${provider.name} connected.${countNote}`, 0, 0));
		tui.requestRender();
		await delay(500);
		return "ok";
	}
}

/**
 * Best-effort open the system browser at `url`. Detached + unref'd so the child
 * never keeps the wizard process alive, and every error is swallowed — a failed
 * launch just means the user copies the URL we printed above. NOT exported;
 * only the subscription-login flow uses it.
 */
function openSubscriptionBrowser(url: string): void {
	try {
		const child =
			process.platform === "win32"
				? spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" })
				: process.platform === "darwin"
					? spawn("open", [url], { detached: true, stdio: "ignore" })
					: spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
		child.unref();
	} catch {
		// Couldn't launch a browser — the URL is already on screen for manual use.
	}
}

async function pickModel(tui: TUI, modelRegistry: ModelRegistry, providerId: string): Promise<"back" | { modelId: string }> {
	const models = await getProviderModels(modelRegistry, providerId);

	if (models.length === 0) {
		tui.addChild(new Text(brand.dim("  Type the model name you'd like to use, then press Enter. Esc to go back."), 0, 0));
		const input = new Input();
		tui.addChild(input);
		tui.setFocus(input);
		tui.requestRender();
		try {
			const id = await new Promise<string>((resolve, reject) => {
				input.onSubmit = (value: string) => resolve(sanitizePastedValue(value));
				input.onEscape = () => reject(new Error("back"));
			});
			return { modelId: id };
		} catch {
			return "back";
		}
	}

	const items: SelectItem[] = models.map((m) => ({
		value: m.id,
		label: m.id,
		description: describeModel(m),
	}));

	// Default-first ordering: reasoning > non-reasoning, then larger context first.
	items.sort((a, b) => {
		const ma = models.find((m) => m.id === a.value);
		const mb = models.find((m) => m.id === b.value);
		if (!ma || !mb) return 0;
		if (!!ma.reasoning !== !!mb.reasoning) return ma.reasoning ? -1 : 1;
		return (mb.contextWindow ?? 0) - (ma.contextWindow ?? 0);
	});

	// Searchable picker — providers like OpenRouter expose 270+ models, so a
	// type-to-filter box on top of the list is the difference between usable
	// and unusable. Fuzzy-matches across id + description (so "opus" finds
	// claude-opus-*, "gpt mini" finds gpt-*-mini). Falls back to a plain
	// scrollable list when the query is empty.
	const list = new SearchableSelectList(items, 12, selectListTheme, {
		minPrimaryColumnWidth: 26,
		maxPrimaryColumnWidth: 38,
		formatHeader: (q, matchCount, total) =>
			brand.dim(
				q.length > 0
					? `  search: ${q}▌  (${matchCount}/${total} match${matchCount === 1 ? "" : "es"})`
					: `  ${total} models · type to filter · ↑↓ move · Enter select · Esc back`,
			),
	});
	tui.addChild(list);
	tui.setFocus(list);
	tui.requestRender();

	try {
		const chosen = await new Promise<SelectItem>((resolve, reject) => {
			list.onSelect = (item) => resolve(item);
			list.onCancel = () => reject(new Error("back"));
		});
		return { modelId: chosen.value };
	} catch {
		return "back";
	}
}

function renderDone(tui: TUI, provider: string, modelId: string): void {
	const p = findProvider(provider)?.name ?? provider;
	tui.addChild(new Text("", 0, 0));
	tui.addChild(new Text(`  ${brand.amber("●")} ${brand.white("Ready.")}  ${brand.dim(`${p} · ${modelId}`)}`, 0, 0));
	tui.addChild(new Text("", 0, 0));
	tui.requestRender();
}

/* ────────────────────────────── helpers ───────────────────────────────── */

/**
 * Render an API key in a form safe to splat to the terminal/log: shows the
 * first 4 and last 4 characters separated by an ellipsis, e.g. `sk-o…2b5x`.
 *
 * Anything shorter than `head + tail + 4` is rejected as `<too short>` so we
 * never reveal a meaningful fraction of an 8-char key. Empty/whitespace-only
 * input returns `<empty>`. The user invokes this in a confirm prompt so they
 * can recognize *which* key is sitting in their env without us echoing the
 * whole thing into scrollback (or worse, a bug-report copy-paste).
 */
export function formatApiKeyPreview(raw: string, opts: { head?: number; tail?: number } = {}): string {
	const head = opts.head ?? 4;
	const tail = opts.tail ?? 4;
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "<empty>";
	// Don't show ANY characters of a key that's too short to safely split —
	// a 6-char key with head=4/tail=4 would otherwise leak the entire value.
	if (trimmed.length < head + tail + 4) return "<too short>";
	return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}

/**
 * Persist a validated API key into `~/.brigade/brigade.json::env.<envVar>`.
 * Goes through `loadBrigadeConfig` + `writeBrigadeConfig` so writes are
 * atomic + .bak-rotated; never touches the file directly.
 *
 * Also pokes `process.env[envVar]` so the in-process agent that's about to
 * boot sees the credential without needing a restart. (The next boot will
 * pick it up via `loadEnvIntoProcess` from brigade.json.)
 *
 * No-op when the provider has no documented env var (Ollama, custom OpenAI-
 * compatible) — those are not credential-driven and shouldn't pollute the
 * env block.
 *
 * Failure is non-fatal: a write error here would leave the user with a
 * working chat session backed by `auth.json` (typed-key path) or the live
 * env var (env-key path) — better to log and continue than abort the
 * onboarding the user has already invested time in.
 */

/**
 * Read auth-profiles.json synchronously and return the resolved API key for
 * `providerId` if a profile exists, or "" otherwise.
 *
 * Mirrors `core/auth-bridge.ts:resolveProfileKey` so the wizard's
 * fast-accept path treats keyRef profiles the same as plaintext ones —
 * without this, ref-stored profiles look "missing" because Pi's authStorage
 * (which reads ~/.brigade/auth.json) doesn't see them and the operator
 * gets re-prompted on every onboard run.
 *
 * Sync read is fine here: the file is at most a few KB, the wizard has
 * already opened a TUI session (so we're past hot-cold-start), and async
 * would force the caller into a chain of awaits in tight UI logic.
 */
function readKeyRefFromProfilesFile(providerId: string): string {
	try {
		const profilesPath = resolveAuthProfilesPath(DEFAULT_AGENT_ID);
		const fsSync = require("node:fs") as typeof import("node:fs");
		if (!fsSync.existsSync(profilesPath)) return "";
		const raw = fsSync.readFileSync(profilesPath, "utf8");
		const parsed = JSON.parse(raw) as {
			profiles?: Record<
				string,
				{
					provider?: string;
					key?: string;
					keyRef?: { source?: string; id?: string } | string;
				}
			>;
		};
		const profile = Object.values(parsed.profiles ?? {}).find(
			(p) => p?.provider === providerId,
		);
		if (!profile) return "";
		// Plaintext wins if both shapes are somehow present (shouldn't happen).
		if (typeof profile.key === "string" && profile.key.length > 0) return profile.key;
		const ref = profile.keyRef;
		if (!ref) return "";
		if (typeof ref === "string") {
			const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(ref);
			if (m && m[1]) return process.env[m[1]] ?? "";
			return "";
		}
		if (ref.source === "env" && ref.id) {
			return process.env[ref.id] ?? "";
		}
		return "";
	} catch {
		return "";
	}
}

function clear(tui: TUI): void {
	for (const child of [...tui.children]) tui.removeChild(child);
	tui.requestRender();
}

function describeModel(m: Model<any>): string {
	const parts: string[] = [];
	if (m.reasoning) parts.push("reasoning");
	if (m.contextWindow) parts.push(`${Math.round(m.contextWindow / 1000)}k ctx`);
	if (m.cost?.input) parts.push(`$${m.cost.input.toFixed(2)}/Mtok in`);
	return parts.join(" · ");
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
