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

/**
 * Provider ids this subsystem can route to.
 *   • `google` / `anthropic` — the bespoke REST adapters (Gemini Files API for
 *     VIDEO, Anthropic `document` block for native PDF, plus inline image).
 *   • `pi` — a VIRTUAL provider that routes a one-shot image (or audio)
 *     understanding call through the Pi SDK (`completeSimple`) against ANY
 *     resolved model+provider that declares image (or audio) input. This is
 *     what lets an operator with ONLY an OpenAI / Groq / Mistral / OpenRouter /
 *     Ollama key understand images — the bespoke REST adapters only know
 *     google + anthropic.
 */
export type MediaUnderstandingProviderId = "google" | "anthropic" | "pi";

/**
 * A resolved, image-capable model the Pi path can drive. Mirrors the load-
 * bearing subset of Pi's `Model` (the agent loop hands a full Pi Model here via
 * `cfg.resolveModel`). `input` is Pi's `("text"|"image")[]` — only a model whose
 * `input` includes `"image"` is eligible for image understanding.
 */
export interface MediaUnderstandingModel {
	/** Underlying Brigade/Pi provider id (e.g. "openai", "openrouter", "groq"). */
	provider: string;
	/** Model id (e.g. "gpt-4o", "anthropic/claude-sonnet-4-5"). */
	id: string;
	/** Pi input modalities — image understanding requires this to include "image". */
	input?: string[];
	/** Carry the remaining Pi Model fields (api/baseUrl/cost/…) opaquely. */
	[key: string]: unknown;
}

/**
 * One-shot completion seam for the Pi path. The default implementation calls
 * `completeSimple` from `@earendil-works/pi-ai`; tests inject a stub so no real
 * model call happens. Returns the concatenated assistant text.
 */
export type PiCompleteFn = (req: PiCompleteRequest) => Promise<string>;

/** Request shape for {@link PiCompleteFn}. */
export interface PiCompleteRequest {
	model: MediaUnderstandingModel;
	/** Raw media bytes (image/audio). */
	bytes: Buffer;
	/** Declared MIME (e.g. "image/png", "audio/ogg"). */
	mimeType: string;
	/** Instruction / question for the model. */
	prompt: string;
	/** Resolved API key for the model's provider (may be empty for keyless local providers). */
	apiKey: string;
	signal?: AbortSignal;
}

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
	/**
	 * Max output tokens for the provider answer (Anthropic `max_tokens` / Gemini
	 * `maxOutputTokens`). Omitted → the adapter's bounded default. Clamped by the
	 * adapter to a sane ceiling.
	 */
	maxTokens?: number;
	/** Resolved credential config — how the subsystem gets provider API keys. */
	cfg: MediaUnderstandingConfig;
	/** Test seam: replaces the global fetch for ALL provider HTTP. */
	fetchImpl?: typeof fetch;
	/** Caller's cancel signal (combined with each request's own timeout). */
	signal?: AbortSignal;
	/**
	 * Max RETRIES per provider on a transient failure (HTTP 429 / 5xx / transport
	 * error). Default 1 (so up to 2 attempts per provider). 0 disables retry.
	 */
	maxRetries?: number;
	/**
	 * Test seam: replaces the inter-retry backoff sleep so tests don't actually
	 * wait. Receives the planned delay in ms.
	 */
	sleepFn?: (ms: number) => Promise<void>;
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
	 * Resolve a provider's API key by Brigade catalog id. Accepts the bespoke
	 * ids (`"google"`, `"anthropic"`) AND any underlying provider id the Pi path
	 * uses (`"openai"`, `"openrouter"`, `"groq"`, …). Returns an empty string
	 * when no key is configured (keyless local providers like Ollama also return
	 * ""). The subsystem treats only a NON-EMPTY return as "key present" for the
	 * REST adapters; the Pi path tolerates "" for keyless local models.
	 */
	resolveKey: (providerId: string) => string;
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
	/**
	 * Pi-path model resolver. Given an underlying provider id (or, when
	 * `provider` is omitted, the subsystem's preferred/first keyed provider),
	 * return an IMAGE-capable Pi `Model` to drive via `completeSimple` — or
	 * `undefined` when this provider has no image-capable model. Wired from the
	 * agent loop's `ModelRegistry`; when ABSENT the Pi path is disabled and the
	 * subsystem falls back to the bespoke google/anthropic REST adapters
	 * (backward-compatible — legacy/test configs without this keep working).
	 *
	 * `kind` lets a resolver pick an audio-capable model for `kind:"audio"`
	 * (today resolvers may ignore it and return the image model).
	 */
	resolveModel?: (
		provider: string | undefined,
		kind: MediaUnderstandingKind,
	) => MediaUnderstandingModel | undefined;
	/**
	 * Providers that currently have a configured key (Brigade catalog probe),
	 * MOST-PREFERRED first. The Pi path picks the first one for which
	 * `resolveModel` yields an image-capable model. Empty/absent → the Pi path
	 * has no provider to try (it then reports unavailable for non-google/
	 * anthropic setups).
	 */
	listKeyedProviders?: () => string[];
	/**
	 * One-shot completion implementation for the Pi path. Defaults to a
	 * `completeSimple` wrapper; tests inject a stub to avoid real model calls.
	 */
	piComplete?: PiCompleteFn;
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
