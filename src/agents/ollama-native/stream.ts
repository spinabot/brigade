// Native Ollama transport — talks to Ollama's own /api/chat endpoint instead of
// the OpenAI-compatible /v1 shim. The native endpoint runs the model's tool-aware
// chat template server-side and returns STRUCTURED `tool_calls` (plus native
// `thinking`), which the /v1 shim does not reliably do for local models. The
// producer maps the native NDJSON stream 1:1 onto pi-ai's
// `AssistantMessageEventStream`, so `api: "ollama"` models dispatch through this
// transport exactly like a Pi built-in provider.
//
// Shape: `createOllamaStreamFn(baseUrl)` returns a Pi `StreamFn`
// `(model, context, options) => AssistantMessageEventStream`. It returns the
// stream synchronously and fills it from an async producer, exactly as pi-ai's
// built-in providers do.

import { randomUUID } from "node:crypto";
import { PI_TOOL_CALL, PI_TOOL_RESULT, WIRE_TOOL_USE } from "../pi-dialect.js";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { classifyUrlForSsrf } from "../../infra/net/fetch-guard.js";
import {
	parseJsonObjectPreservingUnsafeIntegers,
	parseJsonPreservingUnsafeIntegers,
} from "./ollama-json.js";

export const OLLAMA_NATIVE_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_NUM_CTX = 65536;

// Local Ollama needs no credential; discovery seeds a sentinel apiKey purely to
// satisfy Pi's "custom provider needs a key" requirement. Never send it as a
// Bearer token (it's not a secret; only real cloud keys go on the wire).
const LOCAL_SENTINEL_KEYS: ReadonlySet<string> = new Set([
	"ollama-local-no-auth-required",
	"ollama-local",
	"ollama",
]);

// Models Ollama rejected tools for this process (a text/vision-only model 400s
// with `"<model>" does not support tools` when a tools array is present). Learned
// REACTIVELY from that 400 and cached so later turns skip tools proactively (≤1
// wasted round trip per model per process). Not persisted: Pi's ModelRegistry
// rebuilds each Model from a fixed field allow-list, so a per-model flag on the
// models.json def can't reach this stream — an in-process Set is the reliable seam.
// Reactive-only (never seeded from /api/show) so a capable tool-caller is NEVER
// pre-emptively stripped; the only removal happens after Ollama itself refused them.
const noToolsModels = new Set<string>();

/** Resolve num_ctx: env override (BRIGADE_OLLAMA_NUM_CTX) → model context window
 *  → default. The env knob lets an operator cap the KV-cache size on constrained
 *  hardware where a model's full context would OOM. */
function resolveNumCtx(model: { contextWindow?: unknown }): number {
	const raw = process.env.BRIGADE_OLLAMA_NUM_CTX;
	if (raw) {
		const n = Number.parseInt(raw, 10);
		if (Number.isFinite(n) && n > 0) return n;
	}
	const ctx = model.contextWindow;
	const window = typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : DEFAULT_NUM_CTX;
	// CAP the KV-cache request. The strongest open models report huge trained
	// windows via /api/show (llama3.1 128k, qwen3 256k, mistral-nemo up to 1M);
	// forwarding that verbatim as num_ctx makes Ollama allocate the full KV cache
	// up front → OOM / heavy CPU-spill on typical local hardware, right when the
	// user is trying to run the best models. 64k covers real agent turns; an
	// operator with the RAM/VRAM raises it (or sets the exact size) via
	// BRIGADE_OLLAMA_NUM_CTX. Sending an explicit num_ctx still beats Ollama's
	// tiny 4k/8k default for models that need room.
	return Math.min(window, DEFAULT_NUM_CTX);
}

/* ─────────────────────────── wire types ─────────────────────────── */

interface OllamaChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	images?: string[];
	tool_calls?: OllamaWireToolCall[];
	tool_name?: string;
}

interface OllamaWireToolCall {
	function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaWireTool {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OllamaChatRequest {
	model: string;
	messages: OllamaChatMessage[];
	stream: boolean;
	tools?: OllamaWireTool[];
	options?: Record<string, unknown>;
	think?: boolean;
}

interface OllamaChatResponse {
	model?: string;
	message?: {
		role?: string;
		content?: string;
		thinking?: string;
		reasoning?: string;
		tool_calls?: OllamaWireToolCall[];
	};
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
}

interface ModelDescriptor {
	api: string;
	provider: string;
	id: string;
}

/* ─────────────────────────── url + id normalization ─────────────────────────── */

/** Strip trailing slashes and a trailing `/v1`, then append `/api/chat`. */
export function resolveOllamaChatUrl(baseUrl: string): string {
	const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "");
	const base = trimmed.replace(/\/v1$/i, "");
	return `${base || OLLAMA_NATIVE_BASE_URL}/api/chat`;
}

/** Drop a leading `ollama/` provider prefix from the wire model id. */
function normalizeWireModelId(modelId: string): string {
	const trimmed = (modelId ?? "").trim();
	return trimmed.startsWith("ollama/") ? trimmed.slice("ollama/".length) : trimmed;
}

/* ─────────────────────────── request conversion ─────────────────────────── */

type InputContentPart =
	| { type: "text"; text: string }
	| { type: "image"; data: string }
	| { type: "toolCall"; id?: string; name: string; arguments: unknown }
	| { type: "tool_use"; id?: string; name: string; input: unknown };

function ensureArgsObject(value: unknown): Record<string, unknown> {
	return parseJsonObjectPreservingUnsafeIntegers(value) ?? {};
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as InputContentPart[])
		.filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("");
}

function extractImages(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return (content as InputContentPart[])
		.filter((p): p is { type: "image"; data: string } => p?.type === "image" && typeof p.data === "string")
		.map((p) => p.data);
}

function extractWireToolCalls(content: unknown): OllamaWireToolCall[] {
	if (!Array.isArray(content)) return [];
	const out: OllamaWireToolCall[] = [];
	for (const part of content as InputContentPart[]) {
		if (part?.type === PI_TOOL_CALL) {
			out.push({ function: { name: part.name, arguments: ensureArgsObject(part.arguments) } });
		} else if (part?.type === WIRE_TOOL_USE) {
			out.push({ function: { name: part.name, arguments: ensureArgsObject(part.input) } });
		}
	}
	return out;
}

/** Convert Pi's message array + system prompt into Ollama chat messages. */
export function convertToOllamaMessages(
	messages: Array<{ role: string; content: unknown; toolName?: unknown }>,
	systemPrompt?: string,
): OllamaChatMessage[] {
	const out: OllamaChatMessage[] = [];
	if (systemPrompt) out.push({ role: "system", content: systemPrompt });

	for (const msg of messages) {
		if (msg.role === "user") {
			const images = extractImages(msg.content);
			out.push({
				role: "user",
				content: extractTextContent(msg.content),
				...(images.length > 0 ? { images } : {}),
			});
			continue;
		}
		if (msg.role === "assistant") {
			const toolCalls = extractWireToolCalls(msg.content);
			out.push({
				role: "assistant",
				content: extractTextContent(msg.content),
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
			continue;
		}
		if (msg.role === "tool" || msg.role === PI_TOOL_RESULT) {
			const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
			out.push({
				role: "tool",
				content: extractTextContent(msg.content),
				...(toolName ? { tool_name: toolName } : {}),
			});
		}
	}
	return out;
}

/** Map Pi `Tool[]` to Ollama's function-tool wire shape (schema passed through). */
export function extractOllamaTools(tools: Tool[] | undefined): OllamaWireTool[] {
	if (!Array.isArray(tools)) return [];
	const out: OllamaWireTool[] = [];
	for (const tool of tools) {
		if (typeof tool?.name !== "string" || !tool.name) continue;
		out.push({
			type: "function",
			function: {
				name: tool.name,
				description: typeof tool.description === "string" ? tool.description : "",
				parameters: ((tool as { parameters?: unknown }).parameters ?? {}) as Record<string, unknown>,
			},
		});
	}
	return out;
}

function buildOllamaChatRequest(params: {
	modelId: string;
	messages: OllamaChatMessage[];
	tools?: OllamaWireTool[];
	options?: Record<string, unknown>;
	think?: boolean;
}): OllamaChatRequest {
	return {
		model: normalizeWireModelId(params.modelId),
		messages: params.messages,
		stream: true,
		...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
		...(params.options ? { options: params.options } : {}),
		...(params.think !== undefined ? { think: params.think } : {}),
	};
}

/* ─────────────────────────── message + usage builders ─────────────────────────── */

function buildUsageWithNoCost(params: { input?: number; output?: number }): Usage {
	const input = params.input ?? 0;
	const output = params.output ?? 0;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as Usage;
}

function buildAssistantMessageShell(params: {
	model: ModelDescriptor;
	content: (TextContent | ThinkingContent | ToolCall)[];
	stopReason: StopReason;
	usage: Usage;
	errorMessage?: string;
	/** STABLE per-turn timestamp. Must be constant across every partial + the final
	 *  message of one turn: the connect-mode render identity-keys an assistant block
	 *  by `<depth>:<timestamp>`, so a fresh Date.now() per streamed frame makes every
	 *  token render as a NEW "brigade" line instead of updating one in place. */
	timestamp: number;
}): AssistantMessage {
	return {
		role: "assistant",
		content: params.content,
		api: params.model.api,
		provider: params.model.provider,
		model: params.model.id,
		usage: params.usage,
		stopReason: params.stopReason,
		...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
		timestamp: params.timestamp,
	} as AssistantMessage;
}

/* ─────────────────────────── NDJSON reader ─────────────────────────── */

/** Line-buffered NDJSON reader. Skips blank/malformed lines (never fatal). */
export async function* parseNdjsonStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<OllamaChatResponse> {
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				yield parseJsonPreservingUnsafeIntegers(trimmed) as OllamaChatResponse;
			} catch {
				/* skip malformed line */
			}
		}
	}
	if (buffer.trim()) {
		try {
			yield parseJsonPreservingUnsafeIntegers(buffer.trim()) as OllamaChatResponse;
		} catch {
			/* skip malformed trailing data */
		}
	}
}

/* ─────────────────────────── the stream fn ─────────────────────────── */

/** Derive Ollama's native `think` flag from Pi's thinking level. Default OFF, and
 *  sent EXPLICITLY as `think:false` (never omitted): the Pi harness maps
 *  thinkingLevel "off" → reasoning:undefined, and OMITTING `think` lets Ollama
 *  fall back to the model's server-side default — which is thinking-ON for
 *  reasoning models, and makes local models narrate tool calls as prose instead
 *  of emitting structured calls. Only an explicit non-off level enables thinking. */
function resolveThink(reasoning: unknown): boolean {
	return typeof reasoning === "string" && reasoning !== "off";
}

/**
 * Build a Pi `StreamFn` that streams a turn against Ollama's native /api/chat.
 * The chat URL is resolved from the MODEL's baseUrl per call (so one registered
 * transport serves every Ollama endpoint — local or remote). `defaultHeaders`
 * merge under per-call `options.headers`.
 */
export function createOllamaStreamFn(defaultHeaders?: Record<string, string>): StreamFn {
	return ((model: Model<string>, context: unknown, options: Record<string, unknown> | undefined) => {
		const chatUrl = resolveOllamaChatUrl((model as { baseUrl?: string }).baseUrl ?? OLLAMA_NATIVE_BASE_URL);
		const stream = createAssistantMessageEventStream();
		const modelInfo: ModelDescriptor = { api: model.api, provider: model.provider, id: model.id };
		// ONE stable timestamp for the whole turn — every partial + the final message
		// must share it. The connect render identity-keys an assistant block by
		// `<depth>:<timestamp>`; a per-frame Date.now() renders each token as a new line.
		const messageTimestamp = Date.now();

		const run = async (): Promise<void> => {
			// accumulators
			let accumulatedThinking = "";
			let accumulatedContent = "";
			const accumulatedToolCalls: OllamaWireToolCall[] = [];
			let finalResponse: OllamaChatResponse | undefined;
			// event-ordering flags
			let started = false;
			let thinkingStarted = false;
			let thinkingEnded = false;
			let textStarted = false;
			let textClosed = false;
			// The text block's contentIndex is LATCHED on first use (when text_start
			// fires), never recomputed per call: a thinking delta arriving AFTER text
			// already started must not retroactively shift the index that text_delta /
			// text_end already emitted under — that would desync an index-keyed renderer.
			let latchedTextIndex: number | undefined;
			const textIndex = () => {
				if (latchedTextIndex === undefined) latchedTextIndex = thinkingStarted ? 1 : 0;
				return latchedTextIndex;
			};
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

			const currentContent = (): (TextContent | ThinkingContent | ToolCall)[] => {
				const parts: (TextContent | ThinkingContent | ToolCall)[] = [];
				if (accumulatedThinking) parts.push({ type: "thinking", thinking: accumulatedThinking } as ThinkingContent);
				if (accumulatedContent) parts.push({ type: "text", text: accumulatedContent } as TextContent);
				return parts;
			};
			const partial = (): AssistantMessage =>
				buildAssistantMessageShell({
					model: modelInfo,
					timestamp: messageTimestamp,
					content: currentContent(),
					stopReason: "stop",
					usage: buildUsageWithNoCost({}),
				});
			const ensureStarted = () => {
				if (started) return;
				started = true;
				stream.push({
					type: "start",
					partial: buildAssistantMessageShell({
						model: modelInfo,
						timestamp: messageTimestamp,
						content: [],
						stopReason: "stop",
						usage: buildUsageWithNoCost({}),
					}),
				});
			};
			const closeThinking = () => {
				if (!thinkingStarted || thinkingEnded) return;
				thinkingEnded = true;
				stream.push({ type: "thinking_end", contentIndex: 0, content: accumulatedThinking, partial: partial() });
			};
			const closeText = () => {
				if (!textStarted || textClosed) return;
				textClosed = true;
				stream.push({ type: "text_end", contentIndex: textIndex(), content: accumulatedContent, partial: partial() });
			};

			try {
				const ctx = (context ?? {}) as {
					systemPrompt?: string;
					messages?: Array<{ role: string; content: unknown; toolName?: unknown }>;
					tools?: Tool[];
				};
				const ollamaMessages = convertToOllamaMessages(ctx.messages ?? [], ctx.systemPrompt);
				const wireModelId = normalizeWireModelId(model.id);
				// Omit tools for a model Ollama already rejected them for this process:
				// a text/vision-only model 400s when a tools array is present, so a plain
				// answer beats a hard failure. buildOllamaChatRequest omits `tools` when
				// the array is empty.
				const ollamaTools = noToolsModels.has(wireModelId) ? [] : extractOllamaTools(ctx.tools);

				const ollamaOptions: Record<string, unknown> = { num_ctx: resolveNumCtx(model) };
				if (typeof options?.temperature === "number") ollamaOptions.temperature = options.temperature;
				if (typeof options?.maxTokens === "number") ollamaOptions.num_predict = options.maxTokens;

				let body: OllamaChatRequest = buildOllamaChatRequest({
					modelId: model.id,
					messages: ollamaMessages,
					tools: ollamaTools,
					options: ollamaOptions,
					think: resolveThink(options?.reasoning),
				});
				if (typeof options?.onPayload === "function") {
					// pi-ai contract: onPayload MAY return a replacement payload (undefined = keep).
					const next = await (options.onPayload as (p: unknown, m: unknown) => unknown)(body, model);
					if (next !== undefined) body = next as OllamaChatRequest;
				}

				const modelHeaders = (model as { headers?: unknown }).headers;
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					// model.headers (e.g. a remote/authed Ollama proxy token) below the
					// defaults; per-call options.headers win last — pi-ai built-in precedence.
					...defaultHeaders,
					...(modelHeaders && typeof modelHeaders === "object" && !Array.isArray(modelHeaders)
						? (modelHeaders as Record<string, string>)
						: {}),
					...((options?.headers as Record<string, string> | undefined) ?? {}),
				};
				const apiKey = options?.apiKey;
				// Only attach a Bearer token for real (cloud) keys — never the local
				// sentinel, which isn't a secret.
				if (typeof apiKey === "string" && apiKey && !LOCAL_SENTINEL_KEYS.has(apiKey) && !headers.Authorization) {
					headers.Authorization = `Bearer ${apiKey}`;
				}

				// SSRF pre-check (the base URL is config-driven and can be remote):
				// blocks cloud-metadata / disallowed hosts while permitting localhost/LAN
				// Ollama. Pre-check + plain fetch (not guardedFetch) so the guard's
				// request timeout never aborts a long-running stream mid-generation.
				const ssrfReason = await classifyUrlForSsrf(chatUrl, { allowPrivateNetwork: true });
				if (ssrfReason) throw new Error(`Ollama endpoint blocked: ${ssrfReason} (${chatUrl})`);

				const doFetch = () =>
					fetch(chatUrl, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
						signal: options?.signal as AbortSignal | undefined,
						// Never follow redirects: a native Ollama /api/chat never legitimately
						// 3xx-redirects, and following one would resend the request (+ any auth
						// header) to a host the SSRF pre-check never saw — defeating the guard.
						redirect: "manual",
					});
				let response = await doFetch();
				if (!response.ok || !response.body) {
					const detail = await response.text().catch(() => "");
					// A text/vision-only model 400s with `"<model>" does not support tools`
					// when a tools array is present. A plain answer beats a hard failure:
					// drop tools, remember it for the rest of the process, retry ONCE. Mirrors
					// the thinking-fallback downgrade for the parallel "does not support
					// thinking" 400. Only fires when we actually SENT tools, so a genuine 400
					// for any other reason still surfaces below unchanged.
					if (
						response.status === 400 &&
						Array.isArray(body.tools) &&
						body.tools.length > 0 &&
						/does not support tools/i.test(detail)
					) {
						noToolsModels.add(wireModelId);
						delete (body as { tools?: unknown }).tools;
						response = await doFetch();
					}
					if (!response.ok || !response.body) {
						const detail2 = await response.text().catch(() => "");
						// The status is embedded in the message (the transport converts this
						// throw into an error EVENT that carries only the message string, so a
						// structured `.status` property wouldn't survive to the classifier).
						// 401/403/429/402 are matched by the classifier's text patterns; a
						// permanent 400 "does not support thinking" is caught upstream by the
						// thinking-fallback downgrade.
						throw new Error(
							`Ollama /api/chat returned ${response.status}${detail2 ? `: ${detail2.slice(0, 200)}` : ""}`,
						);
					}
				}

				// Emit `start` before reading any chunk — mirroring pi-ai's built-in
				// providers. A turn whose only output is a tool call (Ollama's headline
				// agentic case) or an empty reply would otherwise reach `done` having
				// never emitted `start`, violating the event contract and starving a
				// streaming UI until completion.
				ensureStarted();

				reader = response.body.getReader();
				for await (const chunk of parseNdjsonStream(reader)) {
					const thinkingDelta = chunk.message?.thinking ?? chunk.message?.reasoning;
					if (thinkingDelta) {
						ensureStarted();
						if (!thinkingStarted) {
							thinkingStarted = true;
							stream.push({ type: "thinking_start", contentIndex: 0, partial: partial() });
						}
						accumulatedThinking += thinkingDelta;
						stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinkingDelta, partial: partial() });
					}

					const contentDelta = chunk.message?.content;
					if (contentDelta) {
						if (thinkingStarted && !thinkingEnded) closeThinking();
						ensureStarted();
						if (!textStarted) {
							textStarted = true;
							stream.push({ type: "text_start", contentIndex: textIndex(), partial: partial() });
						}
						accumulatedContent += contentDelta;
						stream.push({ type: "text_delta", contentIndex: textIndex(), delta: contentDelta, partial: partial() });
					}

					if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
						closeThinking();
						closeText();
						// Only accumulate WELL-FORMED tool calls. Small/quantized local models
						// routinely emit off-spec shapes (flat `{name,arguments}` with no
						// `function` wrapper, or a `function` with no `name`); Ollama forwards
						// them verbatim. Accessing `tc.function.name` on those throws a
						// TypeError inside the producer → the whole turn errors out. Skip them
						// (defensively coercing args) so a stray malformed call can't nuke a turn.
						for (const tc of chunk.message.tool_calls) {
							if (tc && typeof tc.function?.name === "string" && tc.function.name.length > 0) {
								accumulatedToolCalls.push(tc);
							}
						}
					}

					if (chunk.done) {
						finalResponse = chunk;
						break;
					}
				}

				// Ollama's /api/chat protocol ALWAYS terminates with a `done:true`
				// chunk carrying the final stop reason + eval counts. Its absence
				// means the connection dropped mid-generation, so the accumulated
				// output is truncated. Fail the turn (→ error event → the resilient
				// retry layer re-runs it) rather than pass partial content off as a
				// clean completion — a half-streamed tool call or sentence acted on
				// as "done" is a correctness hazard. Matches the reference transport.
				if (!finalResponse) {
					throw new Error(
						"Ollama /api/chat stream ended without a final response (connection dropped mid-generation)",
					);
				}

				closeThinking();
				closeText();

				const content: (TextContent | ThinkingContent | ToolCall)[] = [];
				if (accumulatedThinking) content.push({ type: "thinking", thinking: accumulatedThinking } as ThinkingContent);
				if (accumulatedContent) content.push({ type: "text", text: accumulatedContent } as TextContent);
				for (const tc of accumulatedToolCalls) {
					content.push({
						type: PI_TOOL_CALL,
						id: `ollama_call_${randomUUID()}`,
						name: tc.function.name,
						arguments: ensureArgsObject(tc.function.arguments),
					} as ToolCall);
				}

				const hasToolCalls = accumulatedToolCalls.length > 0;
				// Map Ollama's done_reason: "length" (hit the num_predict / maxTokens cap)
				// surfaces as StopReason "length" so max-tokens continuation logic sees a
				// TRUNCATED turn instead of mistaking a capped reply for a clean "stop".
				const stopReason: StopReason = hasToolCalls
					? "toolUse"
					: finalResponse.done_reason === "length"
						? "length"
						: "stop";
				const message = buildAssistantMessageShell({
					model: modelInfo,
					timestamp: messageTimestamp,
					content,
					stopReason,
					usage: buildUsageWithNoCost({
						input: finalResponse.prompt_eval_count ?? 0,
						output: finalResponse.eval_count ?? 0,
					}),
				});
				stream.push({ type: "done", reason: stopReason, message });
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(errorMessage));
				stream.push({
					type: "error",
					reason: aborted ? "aborted" : "error",
					error: buildAssistantMessageShell({
						model: modelInfo,
						timestamp: messageTimestamp,
						content: accumulatedContent ? [{ type: "text", text: accumulatedContent } as TextContent] : [],
						stopReason: aborted ? "aborted" : "error",
						usage: buildUsageWithNoCost({}),
						errorMessage,
					}),
				});
			} finally {
				// Release the response-body reader on ANY exit (normal completion,
				// abort, or mid-stream throw). Web streams don't auto-release the lock
				// when read() reports done, so without this the socket dangles until GC
				// on a dropped/aborted turn. No-op resolve when already closed.
				if (reader) await reader.cancel().catch(() => {});
				stream.end();
			}
		};

		queueMicrotask(() => void run());
		return stream as AssistantMessageEventStream;
	}) as unknown as StreamFn;
}
