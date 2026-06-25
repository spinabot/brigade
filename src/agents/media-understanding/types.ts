/**
 * Shared types for the direct-provider media-understanding subsystem.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS SUBSYSTEM EXISTS (read before changing)
 * ─────────────────────────────────────────────────────────────────────────
 * Pi's SDK carries only TEXT + IMAGE content between a tool and the model —
 * there is no video or document content block, and Brigade has no aux-model
 * completion helper. So `analyze_media` cannot hand a video or a native /
 * scanned PDF to the CURRENT turn's model: those modalities never reach the
 * provider through the tool-result channel.
 *
 * This subsystem closes that gap by calling provider REST APIs DIRECTLY with
 * the media bytes + a prompt and returning TEXT the tool can put in front of
 * the current model. It is the same shape the reference codebase's
 * media-understanding providers use: a provider adapter takes bytes + a
 * prompt and returns a textual description. Nothing here touches Pi's content
 * model — the output is always a string.
 *
 * Two adapters ship today:
 *   • Gemini (Google) — VIDEO via the Files API (upload → poll ACTIVE →
 *     generateContent with a fileData part), plus image / PDF inline.
 *   • Anthropic — native + scanned PDF via a `document` content block (the
 *     provider OCRs internally), plus image blocks.
 *
 * Every HTTP call takes an injectable `fetchImpl` so the whole subsystem is
 * testable with zero real network. Keys are resolved through Brigade's
 * existing credential store (`readBrigadeCredentials`), never invented here.
 */

/** The media kinds this subsystem can drive against a provider. */
export type MediaUnderstandingKind = "image" | "pdf" | "video" | "audio";

/** Provider ids this subsystem can route to (Brigade catalog ids). */
export type MediaUnderstandingProviderId = "google" | "anthropic";

/**
 * A request to understand one piece of media. `bytes` are the raw file bytes
 * (already acquired + guarded by the caller); `mimeType` is the declared MIME
 * (e.g. `video/mp4`, `application/pdf`, `image/png`). `prompt` is the question
 * / instruction handed to the provider model alongside the media.
 */
export interface RunMediaUnderstandingRequest {
	kind: MediaUnderstandingKind;
	bytes: Buffer;
	mimeType: string;
	/** Question / instruction for the provider model. Falls back to a per-kind default. */
	prompt?: string;
	/** Force a specific provider (else `resolveMediaUnderstandingProvider` picks). */
	provider?: MediaUnderstandingProviderId;
	/** Override the provider model id (else the per-kind default for the provider). */
	model?: string;
	/** Resolved credential config — how the subsystem gets provider API keys. */
	cfg: MediaUnderstandingConfig;
	/** Test seam: replaces the global fetch for ALL provider HTTP. */
	fetchImpl?: typeof fetch;
	/** Caller's cancel signal (combined with each request's own timeout). */
	signal?: AbortSignal;
}

/** The text result of a media-understanding call, plus what produced it. */
export interface RunMediaUnderstandingResult {
	text: string;
	provider: MediaUnderstandingProviderId;
	model: string;
}

/**
 * Credential + default-model config the subsystem reads. Deliberately small:
 * a `resolveKey(providerId)` closure (so the subsystem never imports the auth
 * store directly — the caller wires Brigade's `readBrigadeCredentials`) plus
 * optional per-kind model/provider defaults from `cfg.tools.mediaUnderstanding`.
 */
export interface MediaUnderstandingConfig {
	/**
	 * Resolve a provider's API key by Brigade catalog id (`"google"`,
	 * `"anthropic"`). Returns an empty string when no key is configured.
	 * The subsystem treats only a NON-EMPTY return as "key present".
	 */
	resolveKey: (providerId: MediaUnderstandingProviderId) => string;
	/** Optional default model per kind (from config); overrides the built-in default. */
	defaultModels?: Partial<Record<MediaUnderstandingKind, string>>;
	/** Optional preferred provider per kind (from config); overrides the built-in preference order. */
	preferredProvider?: Partial<Record<MediaUnderstandingKind, MediaUnderstandingProviderId>>;
	/**
	 * Optional override of the Gemini API base. Must stay on
	 * `generativelanguage.googleapis.com` (a test seam / region override only).
	 */
	geminiBaseUrl?: string;
	/** Optional override of the Anthropic API base (test seam only). */
	anthropicBaseUrl?: string;
}

/** Raised when no provider with a resolved key can handle the requested kind. */
export class MediaUnderstandingUnavailableError extends Error {
	readonly kind: MediaUnderstandingKind;
	constructor(kind: MediaUnderstandingKind, message: string) {
		super(message);
		this.name = "MediaUnderstandingUnavailableError";
		this.kind = kind;
	}
}

/** Raised when a provider HTTP call fails (non-2xx or transport error). */
export class MediaUnderstandingProviderError extends Error {
	readonly provider: MediaUnderstandingProviderId;
	readonly status?: number;
	constructor(provider: MediaUnderstandingProviderId, message: string, status?: number) {
		super(message);
		this.name = "MediaUnderstandingProviderError";
		this.provider = provider;
		if (status !== undefined) this.status = status;
	}
}
