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

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getEnvApiKey, getModels, type KnownProvider, type Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { CancellableLoader, Input, type SelectItem, SelectList, Text, TUI } from "@mariozechner/pi-tui";

import { loadBrigadeConfig, writeBrigadeConfig } from "../core/brigade-config.js";
import { BRIGADE_DIR, getBrigadeWorkspaceDir, saveConfig } from "../core/config.js";
import { isIdentityNameUnset, seedDefaultPrompts } from "../core/system-prompt.js";
import { discoverOllamaModels, writeOllamaToModelsJson } from "../integrations/ollama.js";
import { findProvider, PROVIDERS, type ProviderInfo } from "../providers/catalog.js";
import { validateApiKeyOnline } from "../providers/validate-key.js";
import { renderBrandHeader } from "./brand.js";
import { brand, selectListTheme } from "./theme.js";

export interface OnboardingResult {
	provider: string;
	modelId: string;
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
function getProviderModels(modelRegistry: ModelRegistry, providerId: string): Array<Model<any>> {
	try {
		const fromCatalog = getModels(providerId as KnownProvider) as Array<Model<any>>;
		if (fromCatalog && fromCatalog.length > 0) return fromCatalog;
	} catch {
		/* unknown provider — fall through */
	}
	return modelRegistry.getAll().filter((m) => m.provider === providerId) as Array<Model<any>>;
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
	let step: "provider" | "key" | "model" = "provider";
	let provider = "";
	let modelId = "";

	while (true) {
		if (step === "provider") {
			renderScreen(tui, "Step 1 of 4 · Pick a provider");
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

			const result = await ensureApiKey(tui, authStorage, provider, { noEnvDetect: opts.noEnvDetect });
			if (result === "back") {
				step = "provider";
				continue;
			}
			modelRegistry.refresh(); // re-evaluate available models with the new key
			step = "model";
			continue;
		}

		// step === "model"
		renderScreen(tui, "Step 3 of 4 · Default model");
		const result = await pickModel(tui, modelRegistry, provider);
		if (result === "back") {
			step = "provider"; // go all the way back so they can change provider too
			continue;
		}
		modelId = result.modelId;
		break;
	}

	// Step 4 — name the agent. Done LAST so it lands on a workspace whose
	// IDENTITY.md has been seeded (seedDefaultPrompts is idempotent + cheap).
	// Skipped entirely when IDENTITY.md already has a Name — re-onboarding
	// shouldn't pester established agents.
	//
	// Why we collect the name here, not by conversation: empirically (May 2026,
	// Sonnet 4.6 + Gemini), strong instruction-tuned models default to
	// "I'm a coding assistant" on greeting/identity questions and ignore
	// BOOTSTRAP.md's name-discovery script. Setting the Name field directly
	// in IDENTITY.md sidesteps that entire failure mode — when the model
	// reads the workspace files on first turn, it sees a real Name and
	// adopts it. clawdbot ships the same answer (`clawdbot agents identity
	// set --name`) for the same empirical reason.
	await seedDefaultPrompts(); // idempotent; ensures IDENTITY.md exists to write into
	await pickAgentName(tui);

	await saveConfig({ defaultProvider: provider, defaultModelId: modelId });

	renderScreen(tui, ""); // brand-only frame for the "Ready." moment
	renderDone(tui, provider, modelId);
	await delay(900);
	clear(tui);

	return { provider, modelId };
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

/**
 * Step 4 — name the agent. Writes the chosen name into IDENTITY.md's Name
 * field. Skipped silently when IDENTITY.md already has a Name (re-onboarding
 * shouldn't rename an established agent without explicit user action).
 *
 * Behaviour:
 *   - Already-named workspace → no-op, returns immediately, no UI shown.
 *   - Empty input + Enter → uses fallback "friend" so the workspace is never
 *     left in the broken "no Name set" state where the model defaults to
 *     "I'm a coding assistant" and ignores BOOTSTRAP.md.
 *   - Esc → also accepts "friend" as the fallback. We do NOT bail to the
 *     model picker; by this point the user has invested 3 wizard steps
 *     and we want them to land in a usable state. They can edit
 *     ~/.brigade/workspace/IDENTITY.md directly later.
 *
 * Why "friend" as the fallback: it's neutral, warm, and obviously a
 * placeholder the user can change. Anything more specific (a generated
 * name, a model-derived name) would feel like a decision was made FOR them.
 */
async function pickAgentName(tui: TUI): Promise<void> {
	const identityPath = path.join(getBrigadeWorkspaceDir(), "IDENTITY.md");
	let identityText: string;
	try {
		identityText = await fs.readFile(identityPath, "utf8");
	} catch {
		// IDENTITY.md missing — the seedDefaultPrompts call before us should
		// have created it. If it didn't (permission error, race), bail out
		// quietly; the workspace is in an unusual state but we don't want
		// to crash the wizard at the finish line.
		return;
	}

	if (!isIdentityNameUnset(identityText)) {
		// Already named — re-onboard shouldn't rename. Silent no-op.
		return;
	}

	renderScreen(tui, "Step 4 of 4 · Name your agent");
	tui.addChild(new Text("  What should we call your agent?", 0, 0));
	tui.addChild(
		new Text(
			brand.dim("  Pick anything you like — a name, a creature, a vibe. You can change it later by editing IDENTITY.md."),
			0,
			0,
		),
	);
	tui.addChild(new Text(brand.dim("  Enter to confirm  ·  blank line accepts \"friend\""), 0, 0));
	tui.addChild(new Text("", 0, 0));

	const input = new Input();
	tui.addChild(input);
	tui.setFocus(input);
	tui.requestRender();

	const raw = await new Promise<string>((resolve) => {
		input.onSubmit = (value: string) => resolve(value.trim());
		input.onEscape = () => resolve(""); // Esc → fallback
	});
	const chosen = raw.length > 0 ? raw : "friend";

	// Write the Name back into IDENTITY.md. Match the exact `**Name:**` line
	// format the default template ships with so isIdentityNameUnset's parser
	// recognises it (literal `**Name:**` token, name on the same line after
	// a space — see isIdentityNameUnset for the matching rules).
	const updated = writeNameIntoIdentity(identityText, chosen);
	try {
		await fs.writeFile(identityPath, updated, "utf8");
	} catch {
		// I/O error — don't crash the wizard. The user lands in chat with an
		// unnamed agent, same as before this step existed.
	}
}

/**
 * Replace the entire IDENTITY.md content with a clean, model-friendly
 * declaration of the chosen name. Empirically (Sonnet 4.6, May 2026) the
 * default placeholder-littered template confused models into ignoring
 * the Name even when it was set — too many "*(pick something you like)*"
 * lines made the file look "still being filled in." This produces a
 * minimal file with one assertion the model can't miss, plus optional
 * fields at the bottom the user can edit later.
 *
 * Idempotent: re-running with the same name produces identical output.
 */
function writeNameIntoIdentity(_existingText: string, name: string): string {
	// Two redundant assertions of the name:
	//   1. A direct sentence at the top — empirically the most reliable signal
	//      to the model. Sonnet 4.6 was observed to ignore the bullet-list
	//      `- **Name:**` format when surrounded by placeholder lines.
	//   2. A `- **Name:** Felix` line — preserves compatibility with
	//      `isIdentityNameUnset`'s parser, which scans for that token.
	// Optional fields below are blank but unambiguously named (no italic
	// placeholders to confuse the model into thinking they're still TBD).
	return `# IDENTITY

Your name is **${name}**.

When asked who you are or what to call you, identify yourself as ${name}. Do not introduce yourself by the runtime, the project, the underlying model, or a generic role label like "AI assistant" or "coding assistant".

- **Name:** ${name}
- **Creature:**
- **Vibe:**
- **Emoji:**
- **Avatar:**

*(Edit the optional fields above to flesh out the persona. Blank fields are fine.)*
`;
}

async function pickProvider(tui: TUI): Promise<string> {
	// Re-order providers so any with a credential the user already has —
	// either an env var Pi can read, OR a noAuth provider like Ollama —
	// floats to the top. Without this, PROVIDERS[0] = anthropic always wins
	// the highlight, and a user with only OPENROUTER_API_KEY exported picks
	// anthropic by reflex (then fails when they send a message).
	const detected: SelectItem[] = [];
	const undetected: SelectItem[] = [];
	for (const p of PROVIDERS) {
		const hasEnvKey = !!getEnvApiKey(p.id as KnownProvider);
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
	opts: { noEnvDetect?: boolean } = {},
): Promise<"ok" | "back"> {
	const provider = findProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);

	// Already configured? (env var OR previously stored)
	// CRITICAL: an env var being PRESENT doesn't mean it WORKS — stale leftover
	// values (from old experiments, exported by .bashrc, etc.) silently auto-
	// completed onboarding and let users reach chat with a dead key. We now
	// always run the online validation. Stored credentials get the fast accept
	// only if they previously passed validation when first saved (which is
	// always — see the typed-key path below — so saved keys are trustworthy
	// enough to skip the re-check).
	//
	// `noEnvDetect` short-circuits the entire env-detection path: when true we
	// pretend no credential exists, regardless of what `authStorage` returns
	// from a shell env fallback. The typed-key prompt fires immediately. This
	// is the enterprise / CI escape hatch — operators who want TYPED-only auth
	// can flip the flag and Brigade never silently consults `$env:OPENROUTER_API_KEY`
	// or its peers.
	const existing = opts.noEnvDetect ? "" : await authStorage.getApiKey(providerId);
	if (existing) {
		const fromEnv = !!getEnvApiKey(providerId as KnownProvider);
		if (!fromEnv) {
			// Saved credential — passed validation when first stored. Fast accept.
			renderScreen(tui, `Step 2 of 4 · ${provider.name}`);
			tui.addChild(
				new Text(
					`  ${brand.amber("✓")} ${provider.name} is already connected (using ${brand.white("your saved credentials")}).`,
					0,
					0,
				),
			);
			tui.requestRender();
			await delay(600);
			return "ok";
		}

		// Env-supplied key: ALWAYS confirm with the user before adopting it.
		// Just because OPENROUTER_API_KEY (etc.) is exported in the user's
		// shell does NOT mean they want this onboarding session to consume it.
		// Auto-accepting silently led to the "I never typed a key, why is it
		// already connected?" footgun. Default to No (defensive opt-in) so
		// pressing Enter falls through to the typed-key prompt.
		//
		// Wording rationale: "shell environment" is portable across PowerShell,
		// bash, zsh, fish, cmd, etc. The previous "(env, sk-…)" label was too
		// cryptic — "env" could be read as brigade.json::env OR shell env, and
		// users who had just run `Remove-Item -Recurse ~/.brigade` (or the bash
		// equivalent) couldn't tell where the credential was coming from. Be
		// explicit so they immediately know the key originated from THEIR shell,
		// not from a stale brigade.json.
		const envVar = provider.envVar ?? "the env var";
		renderScreen(tui, `Step 2 of 4 · ${provider.name}`);
		tui.addChild(
			new Text(
				brand.dim(`  Brigade detected this key in your shell environment.`),
				0,
				0,
			),
		);
		tui.addChild(
			new Text(
				brand.dim(`  Picking "Yes" persists it to ~/.brigade/brigade.json (so it survives shell restarts and machine moves).`),
				0,
				0,
			),
		);
		tui.addChild(new Text("", 0, 0));
		tui.addChild(
			new Text(
				`  ${brand.amber("?")} Use ${envVar} from your shell environment (${formatApiKeyPreview(existing)})?`,
				0,
				0,
			),
		);
		tui.addChild(
			new Text(
				brand.dim(`  Pick "No" to paste a different ${provider.name} key instead.`),
				0,
				0,
			),
		);
		tui.addChild(new Text("", 0, 0));

		const confirmList = new SelectList(
			[
				{ value: "no", label: "No, let me paste a different key" },
				{ value: "yes", label: "Yes, use the shell-env value" },
			],
			2,
			selectListTheme,
			{ minPrimaryColumnWidth: 36, maxPrimaryColumnWidth: 48 },
		);
		confirmList.setSelectedIndex(0); // defensive: default = No
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
			renderScreen(tui, `Step 2 of 4 · Connect ${provider.name}`);
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

		const envCheck = await validateApiKeyOnline(providerId, existing);
		tui.removeChild(envLoader);

		if (envCheck.ok) {
			// State-isolation contract: everything Brigade needs lives under
			// `~/.brigade/`. The env var that fed us this key is owned by the
			// user's shell, so without persisting it here, `rm -rf ~/.brigade`
			// would NOT actually wipe auth — the key would sneak back in via
			// env detection on the next boot. Mirror it into brigade.json::env
			// so the file is the canonical home for the credential.
			await persistEnvKeyToBrigadeConfig(provider, existing);
			tui.addChild(
				new Text(
					`  ${brand.amber("✓")} ${provider.name} is already connected (using ${brand.white("your environment")}).`,
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
		renderScreen(tui, `Step 2 of 4 · Connect ${provider.name}`);

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
		authStorage.set(providerId, { type: "api_key", key });
		authStorage.reload();
		// Mirror the credential into brigade.json::env so the unified
		// super-config remains the canonical state-isolation boundary —
		// `rm -rf ~/.brigade` reliably wipes everything, including any env
		// fallback Pi might pick up on a future boot. No-op for providers
		// that don't have a documented env var (custom OpenAI-compatible).
		await persistEnvKeyToBrigadeConfig(provider, key);

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
		renderScreen(tui, "Step 2 of 4 · Connect Ollama");

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
		const modelsJsonPath = path.join(BRIGADE_DIR, "models.json");
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
	const models = getProviderModels(modelRegistry, providerId);

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

	const list = new SelectList(items, Math.min(items.length, 12), selectListTheme, {
		minPrimaryColumnWidth: 26,
		maxPrimaryColumnWidth: 38,
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
async function persistEnvKeyToBrigadeConfig(provider: ProviderInfo, key: string): Promise<void> {
	const envVar = provider.envVar;
	if (!envVar || envVar.length === 0) return;
	if (!key || key.length === 0) return;
	try {
		const cfg = await loadBrigadeConfig(BRIGADE_DIR);
		const env = { ...(cfg.env ?? {}) };
		// Skip a redundant write if the value is already pinned correctly —
		// avoids a useless .bak rotation (and a useless fsync) when the user
		// re-runs onboarding with an unchanged env-supplied credential.
		if (env[envVar] === key) {
			process.env[envVar] = key;
			return;
		}
		env[envVar] = key;
		await writeBrigadeConfig(BRIGADE_DIR, { ...cfg, env });
		// Make the credential visible to the about-to-boot agent without a
		// restart. brigade.json is now the canonical source; this just
		// short-circuits "wait for the next process to load it."
		process.env[envVar] = key;
	} catch (err) {
		// Surface to stderr but don't crash onboarding — the credential is
		// already valid in the running process, so the user can keep chatting.
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`brigade: warning: couldn't persist ${envVar} to brigade.json (${msg})\n`);
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
