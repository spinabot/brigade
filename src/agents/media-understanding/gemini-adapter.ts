/**
 * Gemini (Google) media-understanding adapter — talks to the Generative
 * Language REST API at `generativelanguage.googleapis.com/v1beta` directly.
 *
 * Two paths:
 *   • VIDEO → the Files API. Inline base64 caps out well below real video
 *     sizes, so video is UPLOADED first (resumable upload), POLLED until the
 *     file state flips to ACTIVE (Gemini transcodes/indexes asynchronously),
 *     then referenced from `generateContent` via a `file_data` part holding
 *     the returned `fileUri`. This is the only way large video works.
 *   • image / pdf → an inline `inline_data` part (base64) + the prompt, sent
 *     straight to `generateContent`. These are small enough to inline.
 *
 * The Google key rides in the query string (`?key=…`), matching Brigade's
 * existing validator (`providers/validate-key.ts`) and the Gemini convention
 * — there is no auth header. Every call takes an injectable `fetchFn` so the
 * adapter is exercised with zero real network.
 */

import {
	MediaUnderstandingProviderError,
	type MediaUnderstandingKind,
	type RunMediaUnderstandingResult,
} from "./types.js";

/** Canonical Gemini API base — keep on the trusted Google host. */
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Default models per kind. Current Gemini multimodal models that read video,
 * images and PDFs. `gemini-2.5-flash` is the cheap/fast default; callers can
 * override per call or via config.
 */
export const DEFAULT_GEMINI_MODELS: Record<Exclude<MediaUnderstandingKind, "audio"> | "audio", string> = {
	video: "gemini-2.5-pro",
	image: "gemini-2.5-flash",
	pdf: "gemini-2.5-flash",
	audio: "gemini-2.5-flash",
};

const DEFAULT_PROMPTS: Record<MediaUnderstandingKind, string> = {
	video: "Describe this video in detail: the scenes, actions, on-screen text, and any spoken words.",
	image: "Describe this image in detail.",
	pdf: "Read this document and summarize its contents, preserving key facts, figures, and structure.",
	audio: "Transcribe this audio.",
};

/** Per-request timeouts. Video upload + generation can be slow; bound each. */
const UPLOAD_TIMEOUT_MS = 120_000;
const GENERATE_TIMEOUT_MS = 180_000;
const POLL_TIMEOUT_MS = 15_000;
/** Total wall-clock budget waiting for an uploaded file to become ACTIVE. */
const ACTIVE_POLL_BUDGET_MS = 180_000;
/** Delay between file-state polls. */
const POLL_INTERVAL_MS = 2_000;

export interface GeminiAdapterParams {
	kind: MediaUnderstandingKind;
	bytes: Buffer;
	mimeType: string;
	apiKey: string;
	prompt?: string;
	model?: string;
	/** Max output tokens (clamped); omitted → the model's own default. */
	maxTokens?: number;
	baseUrl?: string;
	fetchFn?: typeof fetch;
	signal?: AbortSignal;
	/** Test seam: replaces the real inter-poll delay so tests don't actually sleep. */
	sleepFn?: (ms: number) => Promise<void>;
}

/** Hard ceiling on `maxTokens`. */
const MAX_OUTPUT_TOKENS_CEILING = 32_000;

/**
 * Build the optional `generationConfig` for a Gemini request. When no
 * `maxTokens` is given we omit it entirely (let the model use its default);
 * otherwise clamp it to a sane window.
 */
function generationConfig(maxTokens?: number): { maxOutputTokens: number } | undefined {
	if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens)) return undefined;
	const v = Math.max(256, Math.min(MAX_OUTPUT_TOKENS_CEILING, Math.floor(maxTokens)));
	return { maxOutputTokens: v };
}

/**
 * Strip a leading `models/` so callers can pass either `gemini-2.5-pro` or
 * `models/gemini-2.5-pro`; we always rebuild the `models/<id>:method` path.
 */
function normalizeModelId(model: string): string {
	return model.replace(/^models\//, "").trim();
}

function resolveModel(kind: MediaUnderstandingKind, model?: string): string {
	const trimmed = model?.trim();
	if (trimmed) return normalizeModelId(trimmed);
	return DEFAULT_GEMINI_MODELS[kind] ?? DEFAULT_GEMINI_MODELS.image;
}

function resolvePrompt(kind: MediaUnderstandingKind, prompt?: string): string {
	const trimmed = prompt?.trim();
	return trimmed || DEFAULT_PROMPTS[kind];
}

/** Compose the caller signal with a per-request timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(ms);
	if (!signal) return timeoutSignal;
	return AbortSignal.any([signal, timeoutSignal]);
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** Extract the concatenated text from a generateContent response payload. */
function extractGeneratedText(payload: unknown): string {
	const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
		?.candidates;
	const parts = candidates?.[0]?.content?.parts ?? [];
	return parts
		.map((p) => (typeof p?.text === "string" ? p.text.trim() : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
}

async function readErrorMessage(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: { message?: string } };
		if (body?.error?.message) return body.error.message;
	} catch {
		/* fall through */
	}
	return `HTTP ${res.status}`;
}

/* ─────────────────────────── inline path (image / pdf) ─────────────────────────── */

async function generateInline(params: GeminiAdapterParams): Promise<RunMediaUnderstandingResult> {
	const fetchFn = params.fetchFn ?? fetch;
	const baseUrl = (params.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
	const model = resolveModel(params.kind, params.model);
	const prompt = resolvePrompt(params.kind, params.prompt);
	const url = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(params.apiKey)}`;
	const genCfg = generationConfig(params.maxTokens);
	const body = {
		contents: [
			{
				role: "user",
				parts: [
					{ text: prompt },
					{
						inline_data: {
							mime_type: params.mimeType,
							data: params.bytes.toString("base64"),
						},
					},
				],
			},
		],
		...(genCfg ? { generationConfig: genCfg } : {}),
	};
	let res: Response;
	try {
		res = await fetchFn(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: withTimeout(params.signal, GENERATE_TIMEOUT_MS),
		});
	} catch (err) {
		throw new MediaUnderstandingProviderError(
			"google",
			`Gemini request failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!res.ok) {
		throw new MediaUnderstandingProviderError("google", `Gemini error: ${await readErrorMessage(res)}`, res.status);
	}
	const payload = await res.json().catch(() => ({}));
	const text = extractGeneratedText(payload);
	if (!text) {
		throw new MediaUnderstandingProviderError("google", "Gemini returned no text for the media.");
	}
	return { text, provider: "google", model };
}

/* ─────────────────────────── Files API path (video) ─────────────────────────── */

interface UploadedFile {
	uri: string;
	name: string;
	state: string;
	mimeType: string;
}

/**
 * Upload bytes via the Gemini Files API resumable protocol:
 *   1. POST to the upload endpoint with `x-goog-upload-protocol: resumable`
 *      + `x-goog-upload-command: start` and the file metadata → the response
 *      carries an `x-goog-upload-url` to PUT the bytes to.
 *   2. PUT the bytes to that URL with `x-goog-upload-command: upload, finalize`
 *      → the response body is the `{ file: {...} }` resource.
 */
async function uploadFile(params: GeminiAdapterParams): Promise<UploadedFile> {
	const fetchFn = params.fetchFn ?? fetch;
	const baseUrl = (params.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
	// The upload endpoint shares the host but lives under `/upload/v1beta/files`.
	// Derive it from the base (which ends in `/v1beta`) so a region/test override
	// of the base carries through.
	const uploadUrl = `${baseUrl.replace(/\/v1beta$/, "")}/upload/v1beta/files?key=${encodeURIComponent(params.apiKey)}`;
	const numBytes = params.bytes.length;

	// Step 1 — start a resumable upload session.
	let startRes: Response;
	try {
		startRes = await fetchFn(uploadUrl, {
			method: "POST",
			headers: {
				"x-goog-upload-protocol": "resumable",
				"x-goog-upload-command": "start",
				"x-goog-upload-header-content-length": String(numBytes),
				"x-goog-upload-header-content-type": params.mimeType,
				"content-type": "application/json",
			},
			body: JSON.stringify({ file: { display_name: "brigade-media" } }),
			signal: withTimeout(params.signal, UPLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		throw new MediaUnderstandingProviderError(
			"google",
			`Gemini file upload (start) failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!startRes.ok) {
		throw new MediaUnderstandingProviderError(
			"google",
			`Gemini file upload (start) error: ${await readErrorMessage(startRes)}`,
			startRes.status,
		);
	}
	const sessionUrl =
		startRes.headers.get("x-goog-upload-url") ?? startRes.headers.get("X-Goog-Upload-URL");
	if (!sessionUrl) {
		throw new MediaUnderstandingProviderError(
			"google",
			"Gemini file upload did not return an upload session URL.",
		);
	}

	// Step 2 — upload + finalize the bytes.
	let putRes: Response;
	try {
		putRes = await fetchFn(sessionUrl, {
			method: "POST",
			headers: {
				"content-length": String(numBytes),
				"x-goog-upload-offset": "0",
				"x-goog-upload-command": "upload, finalize",
			},
			body: new Uint8Array(params.bytes),
			signal: withTimeout(params.signal, UPLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		throw new MediaUnderstandingProviderError(
			"google",
			`Gemini file upload (finalize) failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!putRes.ok) {
		throw new MediaUnderstandingProviderError(
			"google",
			`Gemini file upload (finalize) error: ${await readErrorMessage(putRes)}`,
			putRes.status,
		);
	}
	const uploaded = (await putRes.json().catch(() => ({}))) as {
		file?: { uri?: string; name?: string; state?: string; mimeType?: string };
	};
	const file = uploaded.file;
	if (!file?.uri || !file?.name) {
		throw new MediaUnderstandingProviderError(
			"google",
			"Gemini file upload returned no file URI.",
		);
	}
	return {
		uri: file.uri,
		name: file.name,
		state: file.state ?? "PROCESSING",
		mimeType: file.mimeType ?? params.mimeType,
	};
}

/** GET the current state of an uploaded file (`files/<id>`). */
async function getFileState(
	fileName: string,
	params: GeminiAdapterParams,
): Promise<{ state: string; uri?: string; mimeType?: string }> {
	const fetchFn = params.fetchFn ?? fetch;
	const baseUrl = (params.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
	// `fileName` is the resource name like `files/abc123`. Build `<base>/files/abc123`.
	const rel = fileName.startsWith("files/") ? fileName : `files/${fileName}`;
	const url = `${baseUrl}/${rel}?key=${encodeURIComponent(params.apiKey)}`;
	let res: Response;
	try {
		res = await fetchFn(url, {
			method: "GET",
			signal: withTimeout(params.signal, POLL_TIMEOUT_MS),
		});
	} catch (err) {
		throw new MediaUnderstandingProviderError(
			"google",
			`Gemini file status poll failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!res.ok) {
		throw new MediaUnderstandingProviderError(
			"google",
			`Gemini file status error: ${await readErrorMessage(res)}`,
			res.status,
		);
	}
	const body = (await res.json().catch(() => ({}))) as {
		state?: string;
		uri?: string;
		mimeType?: string;
	};
	return {
		state: body.state ?? "PROCESSING",
		...(body.uri ? { uri: body.uri } : {}),
		...(body.mimeType ? { mimeType: body.mimeType } : {}),
	};
}

/** Poll a freshly-uploaded file until it reaches ACTIVE (or fails / times out). */
async function waitForActive(
	file: UploadedFile,
	params: GeminiAdapterParams,
): Promise<UploadedFile> {
	const sleep = params.sleepFn ?? defaultSleep;
	if (file.state === "ACTIVE") return file;
	const deadline = Date.now() + ACTIVE_POLL_BUDGET_MS;
	let current = file;
	for (;;) {
		if (current.state === "ACTIVE") return current;
		if (current.state === "FAILED") {
			throw new MediaUnderstandingProviderError(
				"google",
				"Gemini failed to process the uploaded video (file state FAILED).",
			);
		}
		if (Date.now() >= deadline) {
			throw new MediaUnderstandingProviderError(
				"google",
				"Gemini did not finish processing the video within the time budget. Try a shorter clip.",
			);
		}
		await sleep(POLL_INTERVAL_MS);
		const next = await getFileState(current.name, params);
		current = {
			name: current.name,
			uri: next.uri ?? current.uri,
			mimeType: next.mimeType ?? current.mimeType,
			state: next.state,
		};
	}
}

/** Reference an uploaded (ACTIVE) file from generateContent via a file_data part. */
async function generateFromFile(
	file: UploadedFile,
	params: GeminiAdapterParams,
): Promise<RunMediaUnderstandingResult> {
	const fetchFn = params.fetchFn ?? fetch;
	const baseUrl = (params.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
	const model = resolveModel(params.kind, params.model);
	const prompt = resolvePrompt(params.kind, params.prompt);
	const url = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(params.apiKey)}`;
	const genCfg = generationConfig(params.maxTokens);
	const body = {
		contents: [
			{
				role: "user",
				parts: [
					{ text: prompt },
					{ file_data: { file_uri: file.uri, mime_type: file.mimeType } },
				],
			},
		],
		...(genCfg ? { generationConfig: genCfg } : {}),
	};
	let res: Response;
	try {
		res = await fetchFn(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: withTimeout(params.signal, GENERATE_TIMEOUT_MS),
		});
	} catch (err) {
		throw new MediaUnderstandingProviderError(
			"google",
			`Gemini generate (from file) failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!res.ok) {
		throw new MediaUnderstandingProviderError(
			"google",
			`Gemini generate error: ${await readErrorMessage(res)}`,
			res.status,
		);
	}
	const payload = await res.json().catch(() => ({}));
	const text = extractGeneratedText(payload);
	if (!text) {
		throw new MediaUnderstandingProviderError("google", "Gemini returned no text for the video.");
	}
	return { text, provider: "google", model };
}

/* ─────────────────────────── entry point ─────────────────────────── */

/**
 * Run a Gemini media-understanding request. Video goes through the Files API
 * (upload → poll ACTIVE → generate); image/pdf go inline. Returns the model's
 * textual answer.
 */
export async function runGemini(params: GeminiAdapterParams): Promise<RunMediaUnderstandingResult> {
	if (!params.apiKey) {
		throw new MediaUnderstandingProviderError("google", "No Google/Gemini API key configured.");
	}
	if (params.kind === "video") {
		const uploaded = await uploadFile(params);
		const active = await waitForActive(uploaded, params);
		return generateFromFile(active, params);
	}
	// image / pdf / audio → inline data.
	return generateInline(params);
}

// Exported for tests.
export { extractGeneratedText, normalizeModelId };
