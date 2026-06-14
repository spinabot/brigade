/**
 * `generate_image` tool — first-class image generation, modeled on the
 * reference architecture's media-generation tool family.
 *
 * Why this tool exists
 * --------------------
 * Without it, "make me an image" sends the model to raw `curl` against the
 * provider API: the API key flows through shell commands, model ids get
 * guessed (a dead id 400'd), the response shape gets guessed (a 69-second
 * generation was BILLED and then silently dropped by a hand-written parser
 * that didn't know images ride outside `message.content`), and the operator
 * answers four bash-approval prompts for zero delivered pixels (production,
 * 2026-06-11). This tool owns the call in-process: stored auth, validated
 * params, a parser that understands every shape OpenRouter actually returns,
 * and a saved file the model can hand to `send_media`.
 *
 * Flow: generate → bytes saved under `~/.brigade/cache/images/` → result
 * text carries `MEDIA:<saved-path>` lines — the contract is "show the real
 * path so the model can't invent a bogus one" — → the model delivers with
 * `send_media({path})` (same proven pipeline as org-chart images).
 *
 * Provider: OpenRouter (the operator's configured aggregator). Image-output
 * models are exposed through chat/completions with
 * `modalities: ["image", "text"]`; generated images arrive as data URLs in
 * `choices[0].message.images[]` (canonical) or as image parts inside a
 * content array (some providers). Both are handled; http(s) URLs are
 * downloaded.
 */

import fs from "node:fs";
import path from "node:path";

import { Type } from "typebox";

import { resolveCacheDir, DEFAULT_AGENT_ID } from "../../config/paths.js";
import { loadConfig } from "../../core/config.js";
import { readProfiles } from "../../auth/profiles.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

const DEFAULT_MODEL = "openai/gpt-5-image";
const DEFAULT_COUNT = 1;
const MAX_COUNT = 4;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
/** Generation can legitimately take 1-2 minutes; bound each HTTP call. */
const REQUEST_TIMEOUT_MS = 150_000;
const SUPPORTED_ASPECT_RATIOS = new Set([
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9",
]);

const GenerateImageParams = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("generate"), Type.Literal("list")], {
			description: 'Optional action: "generate" (default) or "list" to inspect available image models.',
		}),
	),
	prompt: Type.Optional(Type.String({ description: "Image generation prompt." })),
	model: Type.Optional(
		Type.String({
			description:
				"Optional model override, e.g. openai/gpt-5-image or google/gemini-2.5-flash-image. Use action:list to discover what's available.",
		}),
	),
	filename: Type.Optional(
		Type.String({
			description:
				"Optional output filename hint. Brigade preserves the basename and saves under its managed images directory.",
		}),
	),
	size: Type.Optional(
		Type.String({
			description:
				"Optional size hint like 1024x1024, 1536x1024, or 1024x1536. Passed to the model as a prompt hint.",
		}),
	),
	aspectRatio: Type.Optional(
		Type.String({
			description:
				"Optional aspect ratio hint: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9.",
		}),
	),
	count: Type.Optional(
		Type.Number({
			description: `Optional number of images to request (1-${MAX_COUNT}). Each is a separate billed generation.`,
			minimum: 1,
			maximum: MAX_COUNT,
		}),
	),
});

interface GenerateImageDetails {
	action: "generate" | "list";
	provider: string;
	model?: string;
	count?: number;
	paths?: string[];
	models?: string[];
	ok: boolean;
	message?: string;
}

export interface MakeGenerateImageToolOptions {
	/** Caller's agent id — drives which auth-profiles file backs the key. */
	agentId?: string;
	/** Test seam: replaces global fetch. */
	fetchFn?: typeof fetch;
	/** Test seam: output directory override. Default `<cache>/images`. */
	outDirOverride?: string;
	/** Test seam: API-key resolver override. */
	resolveApiKey?: () => string;
}

export function makeGenerateImageTool(
	opts: MakeGenerateImageToolOptions = {},
): BrigadeTool<typeof GenerateImageParams, GenerateImageDetails> {
	const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
	const fetchFn = opts.fetchFn ?? fetch;
	const resolveKey = opts.resolveApiKey ?? (() => resolveOpenRouterApiKey(agentId));
	return {
		name: "generate_image",
		label: "Generate Image",
		displaySummary: "generating an image",
		// Spend gate: generation is billed per call. The operator (and their
		// own channel DMs, which run as owner) can generate; unapproved
		// channel peers cannot burn credits.
		ownerOnly: true,
		description: [
			"Generate images with the operator's configured image models (via OpenRouter). USE THIS — never call the provider API with bash/curl: the key must not flow through a shell, and the response parsing is owned here.",
			'action="generate" (default): requires `prompt`. Saves each image under the managed images directory and returns the REAL saved paths as `MEDIA:<path>` lines — reference those paths exactly; never invent one.',
			"To deliver the image to the operator on a chat surface, follow up with `send_media({path: <saved path>})` — from a channel chat it auto-targets the current conversation. Generation does NOT auto-send.",
			'action="list": enumerate the image-capable model ids available to this key.',
			"Generation takes up to ~2 minutes per image — do not retry while a call is in flight.",
		].join(" "),
		parameters: GenerateImageParams,
		execute: async (
			_toolCallId,
			args,
			signal,
		): Promise<AgentToolResult<GenerateImageDetails>> => {
			const action = args.action ?? "generate";
			const apiKey = resolveKey();
			if (!apiKey) {
				return jsonResult({
					action,
					provider: "openrouter",
					ok: false,
					message:
						"No OpenRouter key is configured. The operator can add one with `brigade onboard` (or set the OPENROUTER_API_KEY environment variable).",
				} satisfies GenerateImageDetails) as AgentToolResult<GenerateImageDetails>;
			}

			if (action === "list") {
				const models = await listImageModels(fetchFn, apiKey, signal);
				return jsonResult({
					action,
					provider: "openrouter",
					models,
					ok: true,
					message: `${models.length} image-capable model(s).`,
				} satisfies GenerateImageDetails) as AgentToolResult<GenerateImageDetails>;
			}

			const prompt = (args.prompt ?? "").trim();
			if (!prompt) {
				return jsonResult({
					action,
					provider: "openrouter",
					ok: false,
					message: "`prompt` is required for action=generate.",
				} satisfies GenerateImageDetails) as AgentToolResult<GenerateImageDetails>;
			}
			const aspectRatio = args.aspectRatio?.trim();
			if (aspectRatio && !SUPPORTED_ASPECT_RATIOS.has(aspectRatio)) {
				return jsonResult({
					action,
					provider: "openrouter",
					ok: false,
					message:
						"aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9.",
				} satisfies GenerateImageDetails) as AgentToolResult<GenerateImageDetails>;
			}
			const model = args.model?.trim() || resolveDefaultImageModel();
			const count =
				typeof args.count === "number" && Number.isFinite(args.count)
					? Math.min(MAX_COUNT, Math.max(1, Math.floor(args.count)))
					: DEFAULT_COUNT;
			// Size/aspect ride as prompt hints — portable across heterogeneous
			// image models behind the aggregator, no per-model param mapping.
			const hints: string[] = [];
			if (args.size?.trim()) hints.push(`Target size: ${args.size.trim()}.`);
			if (aspectRatio) hints.push(`Aspect ratio: ${aspectRatio}.`);
			const fullPrompt = hints.length > 0 ? `${prompt}\n\n${hints.join(" ")}` : prompt;

			const outDir = opts.outDirOverride ?? path.join(resolveCacheDir(), "images");
			fs.mkdirSync(outDir, { recursive: true });

			const generations = await Promise.all(
				Array.from({ length: count }, (_, i) =>
					generateOneImage({
						fetchFn,
						apiKey,
						model,
						prompt: fullPrompt,
						outDir,
						filenameHint: args.filename,
						index: i,
						signal,
					}),
				),
			);
			const saved = generations.filter((g): g is string => typeof g === "string");
			const failures = generations.length - saved.length;
			if (saved.length === 0) {
				return jsonResult({
					action,
					provider: "openrouter",
					model,
					count: 0,
					ok: false,
					message:
						`Generation with ${model} returned no images` +
						" — the model may not support image output (use action:list), or the request was refused. Do not retry more than once.",
				} satisfies GenerateImageDetails) as AgentToolResult<GenerateImageDetails>;
			}
			const lines = [
				`Generated ${saved.length} image${saved.length === 1 ? "" : "s"} with openrouter/${model}.`,
				...(failures > 0 ? [`Warning: ${failures} of ${count} generations failed.`] : []),
				// Show the actual saved paths so the model does not invent a bogus
				// local path when it references the generated image in a follow-up.
				...saved.map((p) => `MEDIA:${p}`),
				"Deliver with send_media({path}) — generation does not auto-send.",
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					action,
					provider: "openrouter",
					model,
					count: saved.length,
					paths: saved,
					ok: true,
				},
			};
		},
	};
}

/* ───────────────────────── provider plumbing ───────────────────────── */

/**
 * Resolve the OpenRouter API key the same way the agent kernel does:
 * auth-profiles first (direct key or env-backed keyRef), then the plain
 * environment variable as bootstrap fallback.
 */
export function resolveOpenRouterApiKey(agentId: string): string {
	try {
		const parsed = readProfiles(agentId) as unknown as {
			profiles?: Record<
				string,
				{
					provider?: string;
					type?: string;
					key?: string;
					keyRef?: { source?: string; id?: string } | string;
				}
			>;
		};
		for (const profile of Object.values(parsed.profiles ?? {})) {
			if (profile?.provider !== "openrouter" || profile.type !== "api_key") continue;
			if (profile.key && profile.key.length > 0) return profile.key;
			const ref = profile.keyRef;
			if (typeof ref === "string") {
				const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(ref);
				if (m?.[1]) return process.env[m[1]] ?? "";
			} else if (ref?.source === "env" && ref.id) {
				return process.env[ref.id] ?? "";
			}
		}
	} catch {
		/* fall through to env */
	}
	return process.env.OPENROUTER_API_KEY ?? "";
}

function resolveDefaultImageModel(): string {
	try {
		const cfg = loadConfig() as { tools?: { imageGeneration?: { model?: unknown } } };
		const configured = cfg.tools?.imageGeneration?.model;
		if (typeof configured === "string" && configured.trim()) return configured.trim();
	} catch {
		/* default below */
	}
	return DEFAULT_MODEL;
}

async function listImageModels(
	fetchFn: typeof fetch,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const res = await fetchFn(`${OPENROUTER_BASE}/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`OpenRouter model listing failed: HTTP ${res.status}`);
	}
	const body = (await res.json()) as {
		data?: Array<{ id?: string; architecture?: { output_modalities?: string[] } }>;
	};
	const out: string[] = [];
	for (const m of body.data ?? []) {
		if (!m?.id) continue;
		if (m.architecture?.output_modalities?.includes("image")) out.push(m.id);
	}
	return out.sort();
}

async function generateOneImage(params: {
	fetchFn: typeof fetch;
	apiKey: string;
	model: string;
	prompt: string;
	outDir: string;
	filenameHint?: string;
	index: number;
	signal?: AbortSignal;
}): Promise<string | null> {
	const { fetchFn, apiKey, model, prompt, outDir, filenameHint, index, signal } = params;
	let res: Response;
	try {
		res = await fetchFn(`${OPENROUTER_BASE}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				modalities: ["image", "text"],
			}),
			signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
	if (!res.ok) return null;
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return null;
	}
	const urls = extractImageUrls(body);
	if (urls.length === 0) return null;
	// One generation request → take the first image it produced.
	const url = urls[0]!;
	const decoded = await materializeImage(fetchFn, url, signal);
	if (!decoded) return null;
	const fileName = buildFileName(filenameHint, index, decoded.extension);
	const outPath = path.join(outDir, fileName);
	fs.writeFileSync(outPath, decoded.bytes);
	return outPath;
}

/**
 * Pull image URLs out of every response shape OpenRouter image models emit.
 * This breadth is the whole point — the production failure dropped a billed
 * image because a hand-written parser knew only one shape:
 *   - `choices[0].message.images[]` (canonical: `{type, image_url: {url}}`)
 *   - content as an ARRAY of parts with `image_url` / `output_image` types
 *   - a bare data: URL inside a string content (defensive)
 */
export function extractImageUrls(body: unknown): string[] {
	const urls: string[] = [];
	const choices = (body as { choices?: unknown[] } | null)?.choices;
	if (!Array.isArray(choices)) return urls;
	for (const choice of choices) {
		const message = (choice as { message?: unknown } | null)?.message as
			| {
					images?: unknown[];
					content?: unknown;
			  }
			| undefined;
		if (!message) continue;
		if (Array.isArray(message.images)) {
			for (const image of message.images) {
				const url = readImageUrl(image);
				if (url) urls.push(url);
			}
		}
		const content = message.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				const url = readImageUrl(part);
				if (url) urls.push(url);
			}
		} else if (typeof content === "string") {
			const m = /data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/.exec(content);
			if (m) urls.push(m[0]);
		}
	}
	return urls;
}

/** Read a `{image_url: {url}}` / `{image_url: "..."}` / `{url}` shaped part. */
function readImageUrl(part: unknown): string | null {
	if (!part || typeof part !== "object") return null;
	const p = part as { image_url?: { url?: unknown } | string; url?: unknown; b64_json?: unknown };
	if (typeof p.image_url === "string" && p.image_url) return p.image_url;
	if (p.image_url && typeof p.image_url === "object" && typeof p.image_url.url === "string") {
		return p.image_url.url;
	}
	if (typeof p.url === "string" && p.url) return p.url;
	if (typeof p.b64_json === "string" && p.b64_json) {
		return `data:image/png;base64,${p.b64_json}`;
	}
	return null;
}

async function materializeImage(
	fetchFn: typeof fetch,
	url: string,
	signal?: AbortSignal,
): Promise<{ bytes: Buffer; extension: string } | null> {
	if (url.startsWith("data:")) {
		const comma = url.indexOf(",");
		if (comma === -1) return null;
		const header = url.slice(0, comma);
		const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? "image/png";
		try {
			return {
				bytes: Buffer.from(url.slice(comma + 1), "base64"),
				extension: extensionForMime(mime),
			};
		} catch {
			return null;
		}
	}
	if (/^https?:\/\//.test(url)) {
		try {
			const res = await fetchFn(url, { signal: withTimeout(signal, REQUEST_TIMEOUT_MS) });
			if (!res.ok) return null;
			const mime = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/png";
			return {
				bytes: Buffer.from(await res.arrayBuffer()),
				extension: extensionForMime(mime),
			};
		} catch {
			return null;
		}
	}
	return null;
}

function extensionForMime(mime: string): string {
	switch (mime.toLowerCase()) {
		case "image/jpeg":
		case "image/jpg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "png";
	}
}

function buildFileName(hint: string | undefined, index: number, extension: string): string {
	const stamp = Date.now().toString(36);
	const suffix = index > 0 ? `-${index + 1}` : "";
	const base = hint
		? path
				.basename(hint)
				.replace(/\.[a-z0-9]+$/i, "")
				.replace(/[^a-zA-Z0-9._-]/g, "_")
				.slice(0, 48)
		: `image-${stamp}`;
	return `${base}${suffix}.${extension}`;
}

/** Compose the caller's signal with a hard per-request timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(ms);
	if (!signal) return timeoutSignal;
	return AbortSignal.any([signal, timeoutSignal]);
}
