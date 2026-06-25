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
 *   • image → whichever has a key (Anthropic preferred, then Gemini).
 *   • audio → Gemini.
 * A `cfg.preferredProvider[kind]` override wins when that provider has a key.
 * When NO provider with a key can handle the kind, a clear
 * `MediaUnderstandingUnavailableError` is thrown.
 */

import { runAnthropic } from "./anthropic-adapter.js";
import { runGemini } from "./gemini-adapter.js";
import {
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
	type MediaUnderstandingProviderId,
	type RunMediaUnderstandingRequest,
	type RunMediaUnderstandingResult,
} from "./types.js";
export { DEFAULT_GEMINI_MODELS, DEFAULT_GEMINI_BASE_URL } from "./gemini-adapter.js";
export { DEFAULT_ANTHROPIC_MODEL, DEFAULT_ANTHROPIC_BASE_URL } from "./anthropic-adapter.js";

/**
 * Built-in provider preference per kind. The FIRST provider in the list that
 * has a resolved key wins. Order encodes "best tool for the job":
 *   • video — only Gemini can.
 *   • pdf   — Anthropic first (native ingestion + OCR for scanned), Gemini next.
 *   • image — Anthropic first, Gemini next (both capable; arbitrary tie-break).
 *   • audio — only Gemini here.
 */
const PREFERENCE: Record<MediaUnderstandingKind, MediaUnderstandingProviderId[]> = {
	video: ["google"],
	pdf: ["anthropic", "google"],
	image: ["anthropic", "google"],
	audio: ["google"],
};

/** True when the config resolves a NON-EMPTY key for the provider. */
function hasKey(cfg: MediaUnderstandingConfig, provider: MediaUnderstandingProviderId): boolean {
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
			return "Audio understanding needs a Google/Gemini API key. Add one with `brigade onboard` (or set GEMINI_API_KEY).";
		case "image":
		default:
			return (
				"Image understanding via a provider needs an Anthropic or Google/Gemini API key. " +
				"Add one with `brigade onboard`."
			);
	}
}

/**
 * Pick a provider that (a) can handle `kind` and (b) has a resolved key.
 * Honors `cfg.preferredProvider[kind]` first when that provider is both
 * capable and keyed. Returns `undefined` when nothing qualifies.
 */
export function resolveMediaUnderstandingProvider(
	kind: MediaUnderstandingKind,
	cfg: MediaUnderstandingConfig,
): MediaUnderstandingProviderId | undefined {
	const capable = PREFERENCE[kind] ?? [];
	// Config-pinned preference wins when it is capable for this kind AND keyed.
	const pinned = cfg.preferredProvider?.[kind];
	if (pinned && capable.includes(pinned) && hasKey(cfg, pinned)) return pinned;
	for (const provider of capable) {
		if (hasKey(cfg, provider)) return provider;
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
		if (!hasKey(cfg, req.provider)) {
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
		...(cfg.anthropicBaseUrl !== undefined ? { baseUrl: cfg.anthropicBaseUrl } : {}),
		...(req.fetchImpl !== undefined ? { fetchFn: req.fetchImpl } : {}),
		...(req.signal !== undefined ? { signal: req.signal } : {}),
	});
}
