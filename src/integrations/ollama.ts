/**
 * Ollama integration.
 *
 * Ollama runs locally and exposes two parallel APIs:
 *   1. Native Ollama API (`/api/tags`, `/api/generate`) — easiest for discovery.
 *   2. OpenAI-compatible API at `/v1/...` — what we point Pi-AI at for streaming.
 *
 * Pi-AI doesn't ship Ollama as a built-in provider. We register it dynamically
 * via the `~/.brigade/models.json` mechanism Pi exposes for custom providers.
 * Each model the user has pulled becomes a Pi `Model<"openai-completions">`.
 *
 * Capability inference is best-effort — Ollama doesn't tell us a model's
 * context window or whether it reasons. We pattern-match the model name
 * against well-known families and fall back to safe defaults.
 */

import * as fs from "node:fs/promises";

const DEFAULT_BASE_URL = "http://localhost:11434";
const TIMEOUT_MS = 5000;

/** Shape returned by Ollama's `/api/tags` endpoint. */
interface OllamaTagsResponse {
	models?: Array<{
		name: string;
		model?: string;
		size?: number;
		details?: {
			family?: string;
			parameter_size?: string;
			quantization_level?: string;
		};
	}>;
}

export interface OllamaModelSummary {
	id: string;
	name: string;
	sizeBytes?: number;
	family?: string;
	parameterSize?: string;
}

/**
 * Hit Ollama's `/api/tags` and return the user's locally-installed models.
 * Throws a friendly error if the server isn't running or returns no models.
 */
export async function discoverOllamaModels(baseUrl: string = DEFAULT_BASE_URL): Promise<OllamaModelSummary[]> {
	const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(url, { signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(`Couldn't reach Ollama within ${TIMEOUT_MS / 1000} seconds. Make sure it's running.`);
		}
		throw new Error(`Couldn't reach Ollama. Is it running on this machine?`);
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		throw new Error(`Ollama replied with an unexpected error (status ${response.status}).`);
	}

	const body = (await response.json()) as OllamaTagsResponse;
	const models = body.models ?? [];

	if (models.length === 0) {
		throw new Error(
			`Ollama is running but no models are installed yet. Install one (for example: ollama pull llama3.2) and try again.`,
		);
	}

	return models.map((m) => ({
		id: m.model ?? m.name,
		name: m.name,
		sizeBytes: m.size,
		family: m.details?.family,
		parameterSize: m.details?.parameter_size,
	}));
}

/**
 * Best-effort capability guesses based on model id. Ollama exposes no metadata
 * for context window or reasoning — we infer from the family name. Wrong
 * guesses are non-fatal: contextWindow only affects display, and `reasoning`
 * just means we'll set thinkingLevel="low" instead of "off" by default.
 */
export interface InferredCapabilities {
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
}

export function inferOllamaModelCapabilities(modelId: string): InferredCapabilities {
	const id = modelId.toLowerCase();

	// Reasoning families. EXTREMELY conservative — only mark a model as
	// reasoning when the name UNAMBIGUOUSLY signals it. False positives here
	// are user-visible failures: marking a non-reasoning model as reasoning
	// makes the loop send `thinking: low` which Ollama rejects with
	// `400 "<model>" does not support thinking`. The runtime has a
	// runWithThinkingFallback wrapper that auto-downgrades, but it's a
	// wasted round trip on the first turn.
	//
	// Specifically EXCLUDED from previous heuristics (the regression case):
	//   - `qwen3-coder*` — code model, no thinking
	//   - `qwen3.5*`     — base chat, not the reasoning fork
	// Originally `^qwen3\b` matched all of these and triggered the bug.
	//
	// Reasoning patterns that ARE safe to mark:
	//   - `deepseek-r1*`  — explicit r1 (reasoning) line
	//   - `qwq*`          — Qwen with Questions (reasoning fork)
	//   - `*-thinking*`   — explicit thinking variant naming convention
	//   - `o1*` / `o3*`   — OpenAI o-series via Ollama (rare)
	const reasoning =
		/^deepseek-r1\b/.test(id) ||
		/^qwq\b/.test(id) ||
		/-thinking\b/.test(id) ||
		/\bo1\b/.test(id) ||
		/\bo3\b/.test(id);

	// Vision-capable families — text+image input.
	const vision =
		/^llava\b/.test(id) ||
		/^bakllava\b/.test(id) ||
		/^moondream\b/.test(id) ||
		/^llama3\.2-vision\b/.test(id) ||
		/^minicpm-v\b/.test(id) ||
		/-vision\b/.test(id) ||
		/^gemma[34](?:\.\d+)?[-:]/.test(id); // Gemma 3+ has vision variants

	// Context window — Ollama's defaults vary wildly. Common ranges:
	//   - Most modern open models: 32k-128k
	//   - Older models: 4k-8k
	// We use 32k as a safe middle ground — Pi only uses this for display, not
	// for actual API limits (Ollama itself enforces those server-side).
	const contextWindow = 32_768;
	const maxTokens = 8_192;

	const input: ("text" | "image")[] = vision ? ["text", "image"] : ["text"];

	return { reasoning, contextWindow, maxTokens, input };
}

/**
 * Write Brigade's Ollama provider entry into Pi's `~/.brigade/models.json`.
 * Pi's `ModelRegistry.refresh()` picks this up and exposes the models as
 * regular Pi models from then on.
 *
 * We MERGE rather than overwrite — the user (or other providers) may have
 * existing entries in the file we shouldn't clobber.
 */
export async function writeOllamaToModelsJson(
	modelsJsonPath: string,
	baseUrl: string,
	models: OllamaModelSummary[],
): Promise<void> {
	let existing: { providers?: Record<string, any> } = { providers: {} };
	try {
		const raw = await fs.readFile(modelsJsonPath, "utf8");
		existing = JSON.parse(raw);
		if (!existing.providers) existing.providers = {};
	} catch {
		// File missing or unparseable — start fresh. Pi treats an absent file as no config.
	}

	const modelDefs = models.map((m) => {
		const caps = inferOllamaModelCapabilities(m.id);
		return {
			id: m.id,
			name: m.name + (m.parameterSize ? ` (${m.parameterSize})` : ""),
			reasoning: caps.reasoning,
			input: caps.input,
			contextWindow: caps.contextWindow,
			maxTokens: caps.maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // local = free
		};
	});

	existing.providers!["ollama"] = {
		baseUrl: `${baseUrl.replace(/\/$/, "")}/v1`,
		api: "openai-completions",
		// Ollama ignores the API key but Pi requires apiKey to be set when defining
		// custom models for non-built-in providers. Use a sentinel value.
		apiKey: "ollama-local-no-auth-required",
		models: modelDefs,
	};

	await fs.writeFile(modelsJsonPath, JSON.stringify(existing, null, 2), "utf8");
}
