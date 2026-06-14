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

import * as path from "node:path";

import { getEnvApiKey, getModels, type KnownProvider, type Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { CancellableLoader, Input, type SelectItem, SelectList, Text, TUI } from "@mariozechner/pi-tui";

import { upsertApiKeyProfile, upsertApiKeyRefProfile } from "../auth/profiles.js";
import { DEFAULT_AGENT_ID, resolveAuthProfilesPath, resolveModelsPath } from "../config/paths.js";
import { BRIGADE_DIR, saveConfig } from "../core/config.js";
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
import { listOpenRouterModels } from "../integrations/provider-discovery.js";

export interface OnboardingResult {
	provider: string;
	modelId: string;
	/** Storage backend the operator picked in Step 0. The caller writes the
	 *  mode.sentinel after the rest of the wizard finishes. */
	storage: StorageModeResult;
}

/* ────────────────────────────── public API ────────────────────────────── */

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
			renderScreen(tui, "Step 1 of 5 · Pick a provider");
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
		renderScreen(tui, "Step 3 of 5 · Default model");
		const result = await pickModel(tui, modelRegistry, provider);
		if (result === "back") {
			step = "provider"; // go all the way back so they can change provider too
			continue;
		}
		modelId = result.modelId;
		break;
	}

	// No agent-naming step. The wizard ends at provider+auth+model — the
	// agent's identity is left for the agent itself to discover via
	// BOOTSTRAP.md on first turn. Workspace scaffolding still happens at
	// agent boot via `buildAgent → seedDefaultPrompts`.
	await saveConfig({ defaultProvider: provider, defaultModelId: modelId });

	// Step 4 of 5 — web-search backend. Same Pi-TUI components, same brand
	// header. Re-runnable via `brigade onboard web`.
	try {
		const { runWebSetupStep } = await import("../cli/flows/web-setup.js");
		await runWebSetupStep(tui, {
			stepLabel: "Step 4 of 5 · Web search",
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

	return { provider, modelId, storage };
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
	// Re-order providers so any with a credential the user already has —
	// either an env var Pi can read, OR a noAuth provider like Ollama —
	// floats to the top. Without this, PROVIDERS[0] = anthropic always wins
	// the highlight, and a user with only OPENROUTER_API_KEY exported picks
	// anthropic by reflex (then fails when they send a message).
	const detected: SelectItem[] = [];
	const undetected: SelectItem[] = [];
	for (const p of PROVIDERS) {
		// `readProviderEnvKey` checks `envVar` AND any `envVarFallbacks` —
		// Anthropic users with `ANTHROPIC_OAUTH_TOKEN` set get the detected
		// badge alongside the standard `ANTHROPIC_API_KEY` path.
		const hasEnvKey = !!readProviderEnvKey(p);
		const noAuth = p.noAuth === true;
		const item: SelectItem = {
			value: p.id,
			label: p.name,
			description:
				hasEnvKey
					? `${p.description} · detected ${p.envVar ?? "env var"}`
					: noAuth
						? `${p.description} · no auth required`
						: p.description,
		};
		(hasEnvKey || noAuth ? detected : undetected).push(item);
	}
	const items = [...detected, ...undetected];

	const list = new SelectList(items, Math.min(items.length, 9), selectListTheme, {
		minPrimaryColumnWidth: 18,
		maxPrimaryColumnWidth: 22,
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
		renderScreen(tui, `Step 2 of 5 · ${provider.name}`);
		tui.addChild(
			new Text(
				`  ${brand.amber("?")} Use existing ${envVar} (env: ${envVar}, ${formatApiKeyPreview(envKey)})?`,
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
			renderScreen(tui, `Step 2 of 5 · ${provider.name}`);
			// Fall through to typed-key loop without `lastError` set.
			// (Variable declared just below the env block.)
			return await promptTypedKey(tui, authStorage, provider, providerId, null);
		}

		// User confirmed — verify the env key actually works before accepting.
		tui.addChild(
			new Text(
				`  ${brand.dim(`Verifying ${envVar} with ${provider.name}…`)}`,
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
			const pinShape = mode === "ref" ? "your environment (kept as a reference)" : "your environment";
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
		const staleReason = `The ${provider.envVar ?? "env var"} for ${provider.name} doesn't work: ${envCheck.reason}`;
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
		renderScreen(tui, `Step 2 of 5 · ${provider.name}`);

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
				input.onSubmit = (value: string) => resolve(value.trim());
				input.onEscape = () => reject(new Error("back"));
			});
		} catch {
			return "back"; // user pressed Esc — caller rewinds to provider picker
		}

		// Step 1: cheap local format check (length, whitespace, prefix).
		const localCheck = validateApiKey(providerId, key);
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
 * Cheap, provider-aware sanity check on the pasted key.
 * Catches obvious mistakes (empty, accidental newline, wrong provider's key)
 * BEFORE we persist garbage to disk. Doesn't validate against the real API —
 * that happens implicitly on the first model call.
 */
function validateApiKey(providerId: string, key: string): { ok: true } | { ok: false; reason: string } {
	if (!key) return { ok: false, reason: "Please enter an API key." };
	if (key.length < 16) return { ok: false, reason: `That looks incomplete (only ${key.length} characters). Try copying the key again.` };
	if (/\s/.test(key)) return { ok: false, reason: "The key has extra spaces or line breaks. Copy just the key value." };

	// Provider-specific prefix hints. Hard reject only when we have a stable, well-known prefix
	// for that provider — we never want to block someone with a freshly-rotated format.
	// For providers without a stable prefix (cerebras, mistral) we fall through to length+whitespace
	// only, which is intentional.
	const prefixHints: Record<string, string> = {
		anthropic: "sk-ant-",
		openai: "sk-",
		google: "AIza", // Google API keys (Gemini Studio) all start with AIza
		groq: "gsk_",
		openrouter: "sk-or-",
		xai: "xai-",
		deepseek: "sk-", // DeepSeek mirrors OpenAI's prefix convention
	};
	const expected = prefixHints[providerId];
	const providerName = findProvider(providerId)?.name ?? providerId;
	if (expected && !key.startsWith(expected)) {
		return {
			ok: false,
			reason: `That doesn't look like a ${providerName} key (${providerName} keys start with "${expected}"). Make sure you picked the right provider.`,
		};
	}
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
		renderScreen(tui, "Step 2 of 5 · Connect Ollama");

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
				input.onSubmit = (value: string) => resolve(value.trim());
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
