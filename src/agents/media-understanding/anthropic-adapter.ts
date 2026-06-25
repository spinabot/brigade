/**
 * Anthropic media-understanding adapter — talks to the Messages API at
 * `api.anthropic.com/v1/messages` directly.
 *
 * Two paths:
 *   • native / scanned PDF → a `document` content block
 *     `{ type:"document", source:{ type:"base64", media_type:"application/pdf",
 *     data } }` + the prompt. Anthropic ingests the PDF natively: it reads the
 *     text layer AND runs OCR over scanned pages, and it sees the page layout —
 *     so a scanned, no-text-layer PDF that `unpdf` can't read works here.
 *   • image → an `image` content block + the prompt.
 *
 * Auth follows Brigade's existing validator (`providers/validate-key.ts`):
 * a normal console key (`sk-ant-api…`) uses `x-api-key`; an OAuth /
 * setup-token (`sk-ant-oat…`) uses `Authorization: Bearer` + the OAuth beta
 * gate. Both send `anthropic-version`. Every call takes an injectable
 * `fetchFn` so the adapter is exercised with zero real network.
 */

import {
	MediaUnderstandingProviderError,
	type MediaUnderstandingKind,
	type RunMediaUnderstandingResult,
} from "./types.js";

/** Canonical Anthropic API base. */
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
/** Anthropic API version header — matches the rest of the Brigade tree. */
const ANTHROPIC_VERSION = "2023-06-01";
/** OAuth beta gate used when authenticating with an `sk-ant-oat…` token. */
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

/** Default model — a current Claude model that reads images + documents. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";

/** Max tokens for the description response. Bounded — this is a summary, not a doc. */
const MAX_TOKENS = 4096;

const GENERATE_TIMEOUT_MS = 180_000;

const DEFAULT_PROMPTS: Partial<Record<MediaUnderstandingKind, string>> = {
	pdf: "Read this document and summarize its contents, preserving key facts, figures, tables, and structure.",
	image: "Describe this image in detail.",
};

export interface AnthropicAdapterParams {
	kind: MediaUnderstandingKind;
	bytes: Buffer;
	mimeType: string;
	apiKey: string;
	prompt?: string;
	model?: string;
	baseUrl?: string;
	fetchFn?: typeof fetch;
	signal?: AbortSignal;
}

function resolveModel(model?: string): string {
	return model?.trim() || DEFAULT_ANTHROPIC_MODEL;
}

function resolvePrompt(kind: MediaUnderstandingKind, prompt?: string): string {
	const trimmed = prompt?.trim();
	if (trimmed) return trimmed;
	return DEFAULT_PROMPTS[kind] ?? "Describe the attached media in detail.";
}

/** Compose the caller signal with a per-request timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(ms);
	if (!signal) return timeoutSignal;
	return AbortSignal.any([signal, timeoutSignal]);
}

/** Build the auth headers, branching on key shape (OAuth token vs console key). */
function buildAuthHeaders(apiKey: string): Record<string, string> {
	const isOAuth = apiKey.includes("sk-ant-oat");
	if (isOAuth) {
		return {
			authorization: `Bearer ${apiKey}`,
			"anthropic-version": ANTHROPIC_VERSION,
			"anthropic-beta": ANTHROPIC_OAUTH_BETA,
		};
	}
	return {
		"x-api-key": apiKey,
		"anthropic-version": ANTHROPIC_VERSION,
	};
}

/** Build the media content block for the request, per kind. */
function buildMediaBlock(params: AnthropicAdapterParams): Record<string, unknown> {
	const data = params.bytes.toString("base64");
	if (params.kind === "pdf") {
		return {
			type: "document",
			source: { type: "base64", media_type: "application/pdf", data },
		};
	}
	// image
	return {
		type: "image",
		source: { type: "base64", media_type: params.mimeType, data },
	};
}

/** Extract the concatenated text from a Messages API response. */
function extractMessageText(payload: unknown): string {
	const content = (payload as { content?: Array<{ type?: string; text?: string }> })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => (b.text ?? "").trim())
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

/**
 * Run an Anthropic media-understanding request. PDFs go as a `document` block
 * (native + OCR), images as an `image` block. Returns the model's text answer.
 */
export async function runAnthropic(
	params: AnthropicAdapterParams,
): Promise<RunMediaUnderstandingResult> {
	if (!params.apiKey) {
		throw new MediaUnderstandingProviderError("anthropic", "No Anthropic API key configured.");
	}
	if (params.kind !== "pdf" && params.kind !== "image") {
		throw new MediaUnderstandingProviderError(
			"anthropic",
			`Anthropic media understanding supports image + pdf only (got ${params.kind}).`,
		);
	}
	const fetchFn = params.fetchFn ?? fetch;
	const baseUrl = (params.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
	const model = resolveModel(params.model);
	const prompt = resolvePrompt(params.kind, params.prompt);
	const url = `${baseUrl}/messages`;
	const body = {
		model,
		max_tokens: MAX_TOKENS,
		messages: [
			{
				role: "user",
				content: [buildMediaBlock(params), { type: "text", text: prompt }],
			},
		],
	};
	let res: Response;
	try {
		res = await fetchFn(url, {
			method: "POST",
			headers: { ...buildAuthHeaders(params.apiKey), "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: withTimeout(params.signal, GENERATE_TIMEOUT_MS),
		});
	} catch (err) {
		throw new MediaUnderstandingProviderError(
			"anthropic",
			`Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!res.ok) {
		throw new MediaUnderstandingProviderError(
			"anthropic",
			`Anthropic error: ${await readErrorMessage(res)}`,
			res.status,
		);
	}
	const payload = await res.json().catch(() => ({}));
	const text = extractMessageText(payload);
	if (!text) {
		throw new MediaUnderstandingProviderError("anthropic", "Anthropic returned no text for the media.");
	}
	return { text, provider: "anthropic", model };
}

// Exported for tests.
export { extractMessageText, buildAuthHeaders, buildMediaBlock };
