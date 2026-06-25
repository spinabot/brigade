/**
 * Media-understanding subsystem — single entry point + provider selection.
 *
 * `runMediaUnderstanding({ kind, bytes, mimeType, prompt, provider?, model?,
 * cfg, fetchImpl? })` resolves a capable provider that has a configured key,
 * calls its REST API directly with the media + prompt, and returns the model's
 * TEXT answer. This is what lets `analyze_media` understand VIDEO (Gemini Files
 * API) and native/scanned PDFs (Anthropic document blocks / Gemini) even though
 * Pi's tool-result channel carries only text + image.
 *
 * Selection (`resolveMediaUnderstandingProvider`):
 *   • video → Gemini (the only adapter with video; via the Files API).
 *   • pdf   → prefer Anthropic (native + OCR for scanned), else Gemini.
 *   • image → Anthropic, then Gemini (bespoke REST), then the Pi path (`pi`) —
 *     a one-shot `completeSimple` against ANY keyed provider with an
 *     image-capable model (OpenAI / Groq / Mistral / OpenRouter / xAI / Ollama
 *     / …), so image understanding is no longer limited to google + anthropic.
 *   • audio → Gemini ONLY. Pi's content model is text + image (`Model.input` is
 *     `("text"|"image")[]`) — NO provider Pi can drive accepts an audio block,
 *     so the Pi path is deliberately NOT in the audio chain: routing a voice
 *     note through it would stuff audio bytes into an IMAGE block and the
 *     provider would reject it (HTTP 400). Audio understanding is Gemini's real
 *     capability (inline audio); with no Google key the caller gets a clean
 *     "needs a Google/Gemini key" message instead of a 400.
 * A `cfg.preferredProvider[kind]` override wins when that provider has a key.
 * When NO provider with a key can handle the kind, a clear
 * `MediaUnderstandingUnavailableError` is thrown.
 */

import { runAnthropic } from "./anthropic-adapter.js";
import { runGemini } from "./gemini-adapter.js";
import { resolvePiModel, runPi } from "./pi-adapter.js";
import {
	MediaUnderstandingProviderError,
	MediaUnderstandingUnavailableError,
	type MediaUnderstandingConfig,
	type MediaUnderstandingKind,
	type MediaUnderstandingProviderId,
	type RunMediaUnderstandingRequest,
	type RunMediaUnderstandingResult,
} from "./types.js";

export {
	MediaUnderstandingProviderError,
	MediaUnderstandingUnavailableError,
	type MediaUnderstandingConfig,
	type MediaUnderstandingKind,
	type MediaUnderstandingModel,
	type MediaUnderstandingProviderId,
	type PiCompleteFn,
	type PiCompleteRequest,
	type RunMediaUnderstandingRequest,
	type RunMediaUnderstandingResult,
} from "./types.js";
export { DEFAULT_GEMINI_MODELS, DEFAULT_GEMINI_BASE_URL } from "./gemini-adapter.js";
export { DEFAULT_ANTHROPIC_MODEL, DEFAULT_ANTHROPIC_BASE_URL } from "./anthropic-adapter.js";
export { resolvePiModel, runPi, modelAcceptsImage, defaultPiComplete } from "./pi-adapter.js";

/**
 * Built-in provider preference per kind. The FIRST provider in the list that
 * has a resolved key wins. Order encodes "best tool for the job":
 *   • video — only Gemini can.
 *   • pdf   — Anthropic first (native ingestion + OCR for scanned), Gemini next.
 *   • image — Anthropic first, Gemini next (both capable; arbitrary tie-break),
 *     then the Pi catch-all.
 *   • audio — only Gemini. The Pi path is NOT here: Pi carries text + image
 *     only, so no Pi-drivable provider can ingest audio (it would 400).
 */
const PREFERENCE: Record<MediaUnderstandingKind, MediaUnderstandingProviderId[]> = {
	video: ["google"],
	pdf: ["anthropic", "google"],
	// `pi` is listed LAST for image: the bespoke google/anthropic REST adapters
	// stay the default when keyed (they're proven + cheap), and the Pi path is
	// the catch-all that makes every OTHER provider work. `pi` is keyed (hasKey)
	// only when `resolvePiModel` can resolve a capable model.
	image: ["anthropic", "google", "pi"],
	// Audio is Gemini-only: Pi's content model (text + image) has no audio block,
	// so the Pi path is intentionally excluded — see the file header.
	audio: ["google"],
};

/**
 * True when the provider is usable for selection. For the bespoke REST
 * providers this means a NON-EMPTY resolved key. The virtual `pi` provider is
 * "available" iff the Pi path can resolve an image-capable model for some keyed
 * provider — it has no key of its own (the per-model provider key is resolved
 * inside the Pi adapter). `kind` is needed for the Pi probe (image vs audio).
 */
function hasKey(
	cfg: MediaUnderstandingConfig,
	provider: MediaUnderstandingProviderId,
	kind: MediaUnderstandingKind,
): boolean {
	if (provider === "pi") {
		return Boolean(resolvePiModel(kind, cfg));
	}
	try {
		return Boolean(cfg.resolveKey(provider));
	} catch {
		return false;
	}
}

/** Human-friendly "configure a key" hint per kind, naming the capable providers. */
function unavailableMessage(kind: MediaUnderstandingKind): string {
	switch (kind) {
		case "video":
			return (
				"Video understanding needs a Google/Gemini API key. " +
				"Add one with `brigade onboard` (or set GEMINI_API_KEY) and try again."
			);
		case "pdf":
			return (
				"Native/scanned-PDF understanding needs an Anthropic or Google/Gemini API key. " +
				"Add one with `brigade onboard` (the text-extraction fallback is used otherwise)."
			);
		case "audio":
			return (
				"Audio understanding needs a Google/Gemini API key (the only provider here that ingests audio). " +
				"Add one with `brigade onboard` (or set GEMINI_API_KEY) and try again."
			);
		case "image":
		default:
			return (
				"Image understanding via a provider needs an Anthropic or Google/Gemini key, or any provider " +
				"(OpenAI / OpenRouter / Groq / xAI / Mistral / Ollama / …) whose model accepts image input. " +
				"Add one with `brigade onboard`."
			);
	}
}

/**
 * Pick a provider that (a) can handle `kind` and (b) has a resolved key.
 * Honors `cfg.preferredProvider[kind]` first when that provider is both
 * capable and keyed. For IMAGE / AUDIO, when neither google nor anthropic is
 * keyed but the Pi path can resolve a capable model for SOME keyed provider,
 * returns the virtual `"pi"` provider so every configured provider works.
 * Returns `undefined` when nothing qualifies.
 */
export function resolveMediaUnderstandingProvider(
	kind: MediaUnderstandingKind,
	cfg: MediaUnderstandingConfig,
): MediaUnderstandingProviderId | undefined {
	const capable = PREFERENCE[kind] ?? [];
	// Config-pinned preference wins when it is capable for this kind AND keyed.
	const pinned = cfg.preferredProvider?.[kind];
	if (pinned && capable.includes(pinned) && hasKey(cfg, pinned, kind)) return pinned;
	for (const provider of capable) {
		if (hasKey(cfg, provider, kind)) return provider;
	}
	return undefined;
}

/**
 * Run a media-understanding request against a capable, keyed provider and
 * return the textual answer. Throws `MediaUnderstandingUnavailableError` when
 * no provider can serve the kind, or `MediaUnderstandingProviderError` when the
 * chosen provider's API call fails.
 */
export async function runMediaUnderstanding(
	req: RunMediaUnderstandingRequest,
): Promise<RunMediaUnderstandingResult> {
	const { kind, cfg } = req;
	// An explicit provider override must still be capable for the kind AND keyed.
	let provider: MediaUnderstandingProviderId | undefined;
	if (req.provider) {
		const capable = PREFERENCE[kind] ?? [];
		if (!capable.includes(req.provider)) {
			throw new MediaUnderstandingUnavailableError(
				kind,
				`Provider "${req.provider}" cannot handle ${kind}. Capable: ${capable.join(", ") || "none"}.`,
			);
		}
		if (!hasKey(cfg, req.provider, kind)) {
			throw new MediaUnderstandingUnavailableError(
				kind,
				`Provider "${req.provider}" has no configured API key. ${unavailableMessage(kind)}`,
			);
		}
		provider = req.provider;
	} else {
		provider = resolveMediaUnderstandingProvider(kind, cfg);
	}
	if (!provider) {
		throw new MediaUnderstandingUnavailableError(kind, unavailableMessage(kind));
	}

	// Build the ordered provider CHAIN to try. An explicit override pins exactly
	// one provider (honour the operator's pick — no cross-provider fallback). Auto
	// selection walks every capable+keyed provider in preference order, so a 429 /
	// 5xx on the first (e.g. Anthropic) fails over to the next (e.g. Gemini) before
	// giving up. Each provider still gets a bounded retry (below).
	const chain: MediaUnderstandingProviderId[] = req.provider
		? [provider]
		: orderedKeyedProviders(kind, cfg, provider);

	let lastError: unknown;
	for (let i = 0; i < chain.length; i++) {
		const candidate = chain[i] as MediaUnderstandingProviderId;
		try {
			return await runOneProviderWithRetry(candidate, req);
		} catch (err) {
			lastError = err;
			// Only fall over to the NEXT provider on a transient/availability error;
			// a non-retryable provider error (e.g. a 400 bad request) on the LAST
			// provider propagates. A retryable error on a non-last provider falls
			// through to the next candidate.
			const isLast = i === chain.length - 1;
			if (isLast) throw err;
			if (!isRetryableError(err)) throw err;
			// else: try the next provider in the chain.
		}
	}
	// Chain was non-empty (provider resolved), so we either returned or threw
	// above; this is unreachable, but satisfy the type checker.
	throw lastError ?? new MediaUnderstandingUnavailableError(kind, unavailableMessage(kind));
}

/**
 * The capable+keyed providers for `kind`, in preference order, starting from the
 * resolved `first`. De-duplicates and keeps only providers that currently have a
 * key (or, for `pi`, a resolvable model).
 */
function orderedKeyedProviders(
	kind: MediaUnderstandingKind,
	cfg: MediaUnderstandingConfig,
	first: MediaUnderstandingProviderId,
): MediaUnderstandingProviderId[] {
	const ordered: MediaUnderstandingProviderId[] = [];
	const push = (p: MediaUnderstandingProviderId) => {
		if (!ordered.includes(p) && hasKey(cfg, p, kind)) ordered.push(p);
	};
	push(first);
	for (const p of PREFERENCE[kind] ?? []) push(p);
	return ordered;
}

/** Run ONE provider with a bounded retry on transient (429/5xx/transport) errors. */
async function runOneProviderWithRetry(
	provider: MediaUnderstandingProviderId,
	req: RunMediaUnderstandingRequest,
): Promise<RunMediaUnderstandingResult> {
	const maxRetries = Math.max(0, req.maxRetries ?? 1);
	const sleep = req.sleepFn ?? defaultSleep;
	let attempt = 0;
	for (;;) {
		try {
			return await runOneProvider(provider, req);
		} catch (err) {
			if (attempt >= maxRetries || !isRetryableError(err)) throw err;
			attempt += 1;
			// Exponential backoff: 250ms, 500ms, … (bounded by attempt count).
			await sleep(250 * 2 ** (attempt - 1));
		}
	}
}

/** Dispatch a single attempt to the chosen provider's adapter. */
function runOneProvider(
	provider: MediaUnderstandingProviderId,
	req: RunMediaUnderstandingRequest,
): Promise<RunMediaUnderstandingResult> {
	const { kind, cfg } = req;
	// Pi path (the general image/audio route — any provider with an image-capable
	// model). Resolves its own per-model provider key inside the adapter.
	if (provider === "pi") {
		return runPi({
			kind,
			bytes: req.bytes,
			mimeType: req.mimeType,
			cfg,
			...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
			...(req.signal !== undefined ? { signal: req.signal } : {}),
		});
	}

	const model = req.model ?? cfg.defaultModels?.[kind];
	const apiKey = cfg.resolveKey(provider);

	if (provider === "google") {
		return runGemini({
			kind,
			bytes: req.bytes,
			mimeType: req.mimeType,
			apiKey,
			...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
			...(model !== undefined ? { model } : {}),
			...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
			...(cfg.geminiBaseUrl !== undefined ? { baseUrl: cfg.geminiBaseUrl } : {}),
			...(req.fetchImpl !== undefined ? { fetchFn: req.fetchImpl } : {}),
			...(req.signal !== undefined ? { signal: req.signal } : {}),
		});
	}
	// anthropic
	return runAnthropic({
		kind,
		bytes: req.bytes,
		mimeType: req.mimeType,
		apiKey,
		...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
		...(model !== undefined ? { model } : {}),
		...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
		...(cfg.anthropicBaseUrl !== undefined ? { baseUrl: cfg.anthropicBaseUrl } : {}),
		...(req.fetchImpl !== undefined ? { fetchFn: req.fetchImpl } : {}),
		...(req.signal !== undefined ? { signal: req.signal } : {}),
	});
}

/** Default inter-retry sleep (unref'd so it never holds the event loop open). */
const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * A provider error is RETRYABLE (worth a retry / a fallover) when it is a rate
 * limit (429) or a server/transport error (5xx, or a transport throw with no
 * status). A 4xx other than 429 (bad request, auth) is NOT retryable — retrying
 * or falling over wouldn't help and would waste calls. `Unavailable` errors are
 * retryable in the fallover sense (the NEXT provider might serve the kind).
 */
export function isRetryableError(err: unknown): boolean {
	if (err instanceof MediaUnderstandingUnavailableError) return true;
	if (err instanceof MediaUnderstandingProviderError) {
		const status = err.status;
		if (status === undefined) return true; // transport throw — no HTTP status
		if (status === 429) return true;
		return status >= 500 && status <= 599;
	}
	return false;
}
