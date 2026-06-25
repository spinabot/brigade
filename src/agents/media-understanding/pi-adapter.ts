/**
 * Pi-SDK media-understanding adapter — the GENERAL image path.
 *
 * The bespoke google/anthropic REST adapters only cover two providers, so an
 * operator whose only key is OpenAI / Groq / Mistral / OpenRouter / xAI /
 * Ollama would get NO image understanding. This adapter closes that gap by
 * running a ONE-SHOT completion through the Pi SDK (`completeSimple` from
 * `@earendil-works/pi-ai`): it resolves an image-capable `Model` for the
 * provider, ships the media as an `ImageContent` block + the prompt, and
 * returns the assistant's TEXT — exactly the same shape the REST adapters
 * return. Pi's content model is text + image, so this covers IMAGE for every
 * provider that declares image input.
 *
 * AUDIO is NOT served here. Pi's `Model.input` is `("text"|"image")[]` — there
 * is no audio modality anywhere in the SDK content model — so a voice note
 * routed through this path would be packed into an IMAGE block and rejected by
 * the provider (HTTP 400). Audio understanding is Gemini-only (its real inline-
 * audio capability); the audio chain in `index.ts` excludes `pi` accordingly.
 *
 * VIDEO (Gemini Files API) and native PDF (Anthropic `document` block) are NOT
 * served here either — Pi has no video or document content block — so those
 * stay on the bespoke adapters.
 *
 * The actual model call is injected as `cfg.piComplete` (defaulting to the
 * `completeSimple` wrapper below) so the whole subsystem stays testable with
 * zero real model traffic.
 */

import {
	MediaUnderstandingProviderError,
	MediaUnderstandingUnavailableError,
	type MediaUnderstandingConfig,
	type MediaUnderstandingKind,
	type MediaUnderstandingModel,
	type PiCompleteRequest,
	type RunMediaUnderstandingResult,
} from "./types.js";

/** Per-kind default instruction when the caller supplies no prompt. */
const DEFAULT_PROMPTS: Partial<Record<MediaUnderstandingKind, string>> = {
	image: "Describe this image in detail.",
};

/** True when a resolved model declares image input. */
export function modelAcceptsImage(model: MediaUnderstandingModel | undefined): boolean {
	return Array.isArray(model?.input) && model!.input!.includes("image");
}

/**
 * Pick the provider + image-capable model the Pi path should use.
 *   • An explicit `provider` override is tried first (must resolve a model).
 *   • Otherwise walk `cfg.listKeyedProviders()` (most-preferred first) and pick
 *     the first provider whose `cfg.resolveModel` yields an image-capable model.
 * Returns `undefined` when the Pi path is unwired (no `resolveModel`) or no
 * keyed provider has an image-capable model.
 *
 * The Pi path is image-only (Pi carries no audio block), so a resolved model
 * MUST declare image input regardless of `kind` — there is no audio escape
 * hatch. Audio never reaches here (the audio chain in `index.ts` excludes
 * `pi`); the image gate below is the defensive backstop.
 */
export function resolvePiModel(
	kind: MediaUnderstandingKind,
	cfg: MediaUnderstandingConfig,
	providerOverride?: string,
): MediaUnderstandingModel | undefined {
	if (typeof cfg.resolveModel !== "function") return undefined;
	const tryProvider = (provider: string | undefined): MediaUnderstandingModel | undefined => {
		let model: MediaUnderstandingModel | undefined;
		try {
			model = cfg.resolveModel!(provider, kind);
		} catch {
			return undefined;
		}
		// The Pi path can only carry an IMAGE block, so require image input for
		// every kind — a non-image model (or an audio request) cannot be served.
		if (!model) return undefined;
		return modelAcceptsImage(model) ? model : undefined;
	};

	if (providerOverride) return tryProvider(providerOverride);

	const candidates =
		typeof cfg.listKeyedProviders === "function" ? cfg.listKeyedProviders() : [];
	for (const provider of candidates) {
		const model = tryProvider(provider);
		if (model) return model;
	}
	return undefined;
}

export interface RunPiParams {
	kind: MediaUnderstandingKind;
	bytes: Buffer;
	mimeType: string;
	cfg: MediaUnderstandingConfig;
	prompt?: string;
	/** Explicit provider override (else the first keyed provider with a model). */
	provider?: string;
	/** Pre-resolved model (selection already done by the caller). */
	model?: MediaUnderstandingModel;
	signal?: AbortSignal;
}

/**
 * Run a one-shot image/audio understanding via the Pi SDK. Resolves a model
 * (unless one was passed), resolves its provider key, and calls `cfg.piComplete`
 * (the `completeSimple` wrapper by default). Throws
 * `MediaUnderstandingUnavailableError` when no capable model resolves, or
 * `MediaUnderstandingProviderError` when the model call fails / returns empty.
 */
export async function runPi(params: RunPiParams): Promise<RunMediaUnderstandingResult> {
	const model =
		params.model ?? resolvePiModel(params.kind, params.cfg, params.provider);
	if (!model) {
		throw new MediaUnderstandingUnavailableError(
			params.kind,
			`No image-capable model is configured for the Pi path (${params.kind}).`,
		);
	}
	const complete = params.cfg.piComplete ?? defaultPiComplete;
	// Resolve the provider key (keyless local providers like Ollama legitimately
	// return ""); pass it through so `completeSimple` authenticates.
	let apiKey = "";
	try {
		apiKey = params.cfg.resolveKey(model.provider) || "";
	} catch {
		apiKey = "";
	}
	const prompt = params.prompt?.trim() || DEFAULT_PROMPTS[params.kind] || "Describe the attached media.";
	const req: PiCompleteRequest = {
		model,
		bytes: params.bytes,
		mimeType: params.mimeType,
		prompt,
		apiKey,
		...(params.signal ? { signal: params.signal } : {}),
	};
	let text: string;
	try {
		text = await complete(req);
	} catch (err) {
		if (
			err instanceof MediaUnderstandingProviderError ||
			err instanceof MediaUnderstandingUnavailableError
		) {
			throw err;
		}
		throw new MediaUnderstandingProviderError(
			"pi",
			`Pi model call failed (${model.provider}/${model.id}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!text || !text.trim()) {
		throw new MediaUnderstandingProviderError(
			"pi",
			`Model ${model.provider}/${model.id} returned no text for the ${params.kind}.`,
		);
	}
	return { text: text.trim(), provider: "pi", model: `${model.provider}/${model.id}` };
}

/**
 * Default `PiCompleteFn` — lazily imports `completeSimple` from
 * `@earendil-works/pi-ai` and runs a single user turn carrying the media as an
 * image content block + the prompt. Lazy import keeps the SDK off the
 * subsystem's cold-start path and lets tests inject a stub without loading it.
 */
export async function defaultPiComplete(req: PiCompleteRequest): Promise<string> {
	const { completeSimple } = await import("@earendil-works/pi-ai");
	const context = {
		messages: [
			{
				role: "user" as const,
				content: [
					// Pi's ImageContent: raw base64 (no data: prefix) + mimeType. Audio
					// rides the same inline block on providers whose models accept it.
					{ type: "image" as const, data: req.bytes.toString("base64"), mimeType: req.mimeType },
					{ type: "text" as const, text: req.prompt },
				],
				timestamp: Date.now(),
			},
		],
	};
	const options: Record<string, unknown> = {};
	if (req.apiKey) options.apiKey = req.apiKey;
	if (req.signal) options.signal = req.signal;
	const result = await completeSimple(req.model as never, context as never, options as never);
	const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
	return content
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => (b.text ?? "").trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}
