/**
 * `generate_video` tool — text-to-video / image-to-video generation, modeled
 * on the proven self-contained `generate_speech` / `generate_image` pattern.
 *
 * Why this tool exists
 * --------------------
 * Same reasoning as `generate_image` / `generate_speech`: without a first-class
 * tool, "make me a video" / "animate this image" sends the model to raw `curl`
 * against a video API — the key flows through a shell, the async submit→poll→
 * download dance is hand-rolled (and dropped half-way), and a BILLED render is
 * lost. This tool owns the call in-process: stored auth, validated params, the
 * provider-specific async flow (submit a job → poll its status → download the
 * finished mp4), and a saved file the model hands to `send_media`.
 *
 * Most video providers are ASYNC: a POST submits a job and returns an id; a
 * status GET is polled on an interval until the job is done/failed; the final
 * video URL is then downloaded (GET) and the bytes saved. We poll inline (the
 * tool's `execute` is async) via `pollUntil(...)`, treating any unknown /
 * transient status as "keep polling".
 *
 * Providers (auto-selected by which key is configured, preference order):
 *   • openrouter — POST /api/v1/videos (Veo by default); may return the video
 *                  inline (url / data-url) OR an {id} to poll. NEWER API —
 *                  implemented flexibly (deep-searches the body for the first
 *                  mp4 / data:video URL). [per-spec; treat as unverified]
 *   • fal        — queue.fal.run/{model} submit → status_url poll → response_url
 *   • openai     — Sora: POST /v1/videos → poll → /v1/videos/{id}/content
 *   • xai        — grok-imagine-video: POST /v1/videos/generations → poll
 *   • minimax    — Hailuo: POST /v1/video_generation → query task → file fetch
 *   • runway     — gen4_turbo: POST /v1/text_to_video (or image_to_video) → poll
 * Keys resolve through `resolveMediaProviderKey` (the same credential-store +
 * env path the media-understanding subsystem uses), so video works for whichever
 * provider the operator already configured — no bespoke auth.
 *
 * Flow: generate → bytes saved under `<cache>/video/` → result text carries a
 * `MEDIA:<saved-path>` line → the model delivers with `send_media({path})`.
 */

import fs from "node:fs";
import path from "node:path";

import { Type } from "typebox";

import { resolveCacheDir, DEFAULT_AGENT_ID } from "../../config/paths.js";
import { loadConfig } from "../../core/config.js";
import { resolveMediaProviderKey } from "../media-understanding/config.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

/** Each individual HTTP call (submit / poll tick / download) is bounded. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Hard cap on prompt length — providers reject very long prompts; fail clearly. */
const MAX_PROMPT = 4_000;
/**
 * Absolute ceiling on total time spent polling a single job, regardless of the
 * per-provider attempt counts below. Renders can legitimately take minutes;
 * this is the "give up and tell the operator" backstop so a wedged job can't
 * hang the agent loop forever.
 */
const POLL_TIMEOUT_MS = 12 * 60_000;

type VideoProviderId = "openrouter" | "fal" | "openai" | "xai" | "minimax" | "runway";

/** Preference order when no provider is pinned: first keyed one wins. */
const PROVIDER_PREFERENCE: VideoProviderId[] = [
	"openrouter",
	"fal",
	"openai",
	"xai",
	"minimax",
	"runway",
];

/** Default model per provider (overridable via the `model` param / config). */
const DEFAULT_MODELS: Record<VideoProviderId, string> = {
	openrouter: "kwaivgi/kling-v3.0-std",
	fal: "fal-ai/wan/v2.2-a14b/text-to-video",
	openai: "sora-2",
	xai: "grok-imagine-video",
	minimax: "MiniMax-Hailuo-2.3",
	runway: "gen4_turbo",
};

const GenerateVideoParams = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("generate"), Type.Literal("list")], {
			description: 'Optional: "generate" (default) or "list" to see which video providers are configured.',
		}),
	),
	prompt: Type.Optional(Type.String({ description: "The text prompt describing the video to generate." })),
	image: Type.Optional(
		Type.String({
			description:
				"Optional source image for image-to-video: a LOCAL file path or an http(s) URL. Its bytes are read and sent as the first/seed frame to providers that accept image input.",
		}),
	),
	provider: Type.Optional(
		Type.Union(
			[
				Type.Literal("openrouter"),
				Type.Literal("fal"),
				Type.Literal("openai"),
				Type.Literal("xai"),
				Type.Literal("minimax"),
				Type.Literal("runway"),
			],
			{ description: "Optional provider override. Default: the first one with a configured key." },
		),
	),
	model: Type.Optional(Type.String({ description: "Optional model override for the chosen provider." })),
	durationSeconds: Type.Optional(
		Type.Integer({ description: "Optional clip length in seconds (provider-dependent; commonly 5-10)." }),
	),
	aspectRatio: Type.Optional(Type.String({ description: 'Optional aspect ratio, e.g. "16:9", "9:16", "1:1".' })),
	resolution: Type.Optional(Type.String({ description: 'Optional resolution, e.g. "720p", "1080p".' })),
	filename: Type.Optional(
		Type.String({ description: "Optional output filename hint (basename preserved, saved under the managed video dir)." }),
	),
});

interface GenerateVideoDetails {
	action: "generate" | "list";
	provider?: string;
	model?: string;
	path?: string;
	providers?: string[];
	ok: boolean;
	message?: string;
}

export interface MakeGenerateVideoToolOptions {
	/** Caller's agent id — drives which credential store backs the key. */
	agentId?: string;
	/** Test seam: replaces global fetch. */
	fetchFn?: typeof fetch;
	/** Test seam: output directory override. Default `<cache>/video`. */
	outDirOverride?: string;
	/** Test seam: per-provider API-key resolver override. */
	resolveKey?: (provider: VideoProviderId) => string;
	/**
	 * Test seam: base poll interval in ms. Real default keeps the provider-
	 * specific cadence below; tests set this tiny so they don't actually wait.
	 * When set, it scales every provider's interval down to this value.
	 */
	pollIntervalMs?: number;
}

export function makeGenerateVideoTool(
	opts: MakeGenerateVideoToolOptions = {},
): BrigadeTool<typeof GenerateVideoParams, GenerateVideoDetails> {
	const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
	const fetchFn = opts.fetchFn ?? fetch;
	const resolveKey = opts.resolveKey ?? ((p: VideoProviderId) => resolveMediaProviderKey(p, agentId));
	// When a tiny test interval is supplied, honour it for EVERY provider so the
	// submit→poll→download flow runs without real waits.
	const intervalOverride = opts.pollIntervalMs;

	return {
		name: "generate_video",
		label: "Generate Video",
		displaySummary: "generating video",
		// Billed per call (cloud video generation) — owner-gated like generate_image.
		ownerOnly: true,
		description: [
			"Turn a text prompt (optionally + a source image) into a generated video. USE THIS — never call a video API with bash/curl: the key must not flow through a shell, and the async submit→poll→download flow + binary mp4 are handled here.",
			'action="generate" (default): requires `prompt`. Optionally pass `image` (a local path or http(s) URL) for image-to-video. Saves an mp4 and returns its REAL path as a `MEDIA:<path>` line — reference that path exactly; never invent one.',
			"Auto-selects the first configured provider (OpenRouter → fal → OpenAI → xAI → MiniMax → Runway); override with `provider`/`model`. Generation is async and can take a few minutes; the tool polls until the render finishes.",
			"To play it for the operator on a chat surface, follow up with `send_media({path})` — generation does NOT auto-send.",
			'action="list": show which video providers have a configured key.',
		].join(" "),
		parameters: GenerateVideoParams,
		execute: async (_id, args, signal): Promise<AgentToolResult<GenerateVideoDetails>> => {
			const action = args.action ?? "generate";

			if (action === "list") {
				const providers = PROVIDER_PREFERENCE.filter((p) => resolveKey(p).length > 0);
				return jsonResult({
					action,
					providers,
					ok: true,
					message:
						providers.length > 0
							? `${providers.length} video provider(s) configured: ${providers.join(", ")}.`
							: "No video provider configured. Add an OpenRouter, fal, OpenAI, xAI, MiniMax, or Runway key with `brigade onboard`.",
				} satisfies GenerateVideoDetails) as AgentToolResult<GenerateVideoDetails>;
			}

			const prompt = (args.prompt ?? "").trim();
			if (!prompt) {
				return fail(action, "`prompt` is required for action=generate.");
			}
			if (prompt.length > MAX_PROMPT) {
				return fail(action, `\`prompt\` is too long (${prompt.length} chars; max ${MAX_PROMPT}). Shorten it.`);
			}

			// Resolve the provider: explicit override (must be keyed) else first keyed.
			let provider: VideoProviderId | undefined;
			if (args.provider) {
				if (resolveKey(args.provider).length === 0) {
					return fail(
						action,
						`Provider "${args.provider}" has no configured key. Add one with \`brigade onboard\`, or omit \`provider\` to auto-select.`,
					);
				}
				provider = args.provider;
			} else {
				provider = PROVIDER_PREFERENCE.find((p) => resolveKey(p).length > 0);
			}
			if (!provider) {
				return fail(
					action,
					"No video provider is configured. Add an OpenRouter, fal, OpenAI, xAI, MiniMax, or Runway API key with `brigade onboard` (then this tool auto-selects it).",
				);
			}

			const apiKey = resolveKey(provider);
			const model = args.model?.trim() || resolveConfiguredModel(provider) || DEFAULT_MODELS[provider];

			// Resolve the optional source image into a data URL (path → read bytes;
			// http(s) → fetch bytes). Failure here is a clear user-facing error.
			let imageDataUrl: string | undefined;
			if (args.image && args.image.trim()) {
				try {
					imageDataUrl = await loadImageAsDataUrl(args.image.trim(), fetchFn, signal);
				} catch (err) {
					return fail(action, `Could not read \`image\`: ${err instanceof Error ? err.message : String(err)}`, {
						provider,
						model,
					});
				}
			}

			let bytes: Buffer;
			try {
				bytes = await generate({
					provider,
					fetchFn,
					apiKey,
					model,
					prompt,
					imageDataUrl,
					durationSeconds: args.durationSeconds,
					aspectRatio: args.aspectRatio?.trim() || undefined,
					resolution: args.resolution?.trim() || undefined,
					signal,
					intervalOverride,
				});
			} catch (err) {
				return fail(action, `Video via ${provider} failed: ${err instanceof Error ? err.message : String(err)}`, {
					provider,
					model,
				});
			}

			const outDir = opts.outDirOverride ?? path.join(resolveCacheDir(), "video");
			fs.mkdirSync(outDir, { recursive: true });
			const outPath = path.join(outDir, buildFileName(args.filename));
			fs.writeFileSync(outPath, bytes);

			return {
				content: [
					{
						type: "text",
						text: [
							`Generated video with ${provider}/${model}${imageDataUrl ? " (image-to-video)" : ""}.`,
							`MEDIA:${outPath}`,
							"Deliver with send_media({path}) — generation does not auto-send.",
						].join("\n"),
					},
				],
				details: { action, provider, model, path: outPath, ok: true },
			};
		},
	};
}

/* ───────────────────────── provider plumbing ───────────────────────── */

interface GenerateParams {
	provider: VideoProviderId;
	fetchFn: typeof fetch;
	apiKey: string;
	model: string;
	prompt: string;
	imageDataUrl?: string;
	durationSeconds?: number;
	aspectRatio?: string;
	resolution?: string;
	signal?: AbortSignal;
	intervalOverride?: number;
}

async function generate(p: GenerateParams): Promise<Buffer> {
	switch (p.provider) {
		case "openrouter":
			return generateOpenRouter(p);
		case "fal":
			return generateFal(p);
		case "openai":
			return generateOpenAI(p);
		case "xai":
			return generateXai(p);
		case "minimax":
			return generateMiniMax(p);
		case "runway":
			return generateRunway(p);
	}
}

/**
 * OpenRouter video. NEWER API — implemented flexibly per spec. Submit returns
 * (verified shape, per memory reference-openrouter-video-generation): the submit
 * is ASYNC — `POST /api/v1/videos` returns `{ id, polling_url, status:"pending" }`;
 * poll `GET /api/v1/videos/{id}` until `status:"completed"`; then download the
 * rendered bytes from `GET /api/v1/videos/{id}/content?index=0`. Image-to-video
 * passes a typed `frame_images:[{type:"image_url", image_url:{url}, frame_type}]`
 * (inline base64 data URLs are accepted — no public host upload needed).
 */
async function generateOpenRouter(p: GenerateParams): Promise<Buffer> {
	const body: Record<string, unknown> = { model: p.model, prompt: p.prompt };
	if (p.imageDataUrl) {
		body.frame_images = [{ type: "image_url", image_url: { url: p.imageDataUrl }, frame_type: "first_frame" }];
	}
	const res = await p.fetchFn("https://openrouter.ai/api/v1/videos", {
		method: "POST",
		headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const submitBody = (await safeJson(res)) as Record<string, unknown>;
	const id = readString(submitBody, "id") ?? readString(submitBody, "request_id");
	if (!id) throw new Error("OpenRouter video submit returned no job id.");
	// Poll until completed (failed/canceled throw; any other status keeps polling).
	await pollUntil(
		async () => {
			const r = await p.fetchFn(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(id)}`, {
				headers: { Authorization: `Bearer ${p.apiKey}` },
				signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status} ${(await safeText(r)).slice(0, 200)}`);
			const pollBody = (await safeJson(r)) as Record<string, unknown>;
			const status = (readString(pollBody, "status") ?? "").toLowerCase();
			if (status === "failed" || status === "error" || status === "canceled" || status === "cancelled") {
				throw new Error(`OpenRouter reported status "${status}".`);
			}
			return status === "completed" ? "done" : POLL_AGAIN;
		},
		{ intervalMs: scaleInterval(5_000, p.intervalOverride), maxAttempts: 120 },
	);
	// Download the rendered bytes from the documented content endpoint.
	const dl = await p.fetchFn(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(id)}/content?index=0`, {
		headers: { Authorization: `Bearer ${p.apiKey}` },
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!dl.ok) throw new Error(`OpenRouter content download failed: HTTP ${dl.status} ${(await safeText(dl)).slice(0, 120)}`);
	return Buffer.from(await dl.arrayBuffer());
}

/**
 * fal queue. Submit to `queue.fal.run/{model}` (header `Authorization: Key …`,
 * NOT Bearer); poll the returned `status_url`; on COMPLETED fetch `response_url`
 * for the video url; download it.
 */
async function generateFal(p: GenerateParams): Promise<Buffer> {
	const body: Record<string, unknown> = { prompt: p.prompt };
	if (p.imageDataUrl) body.image_url = p.imageDataUrl;
	if (p.aspectRatio) body.aspect_ratio = p.aspectRatio;
	if (p.durationSeconds !== undefined) body.duration = String(p.durationSeconds); // fal wants a STRING
	if (p.resolution) body.resolution = p.resolution;

	const res = await p.fetchFn(`https://queue.fal.run/${p.model}`, {
		method: "POST",
		headers: { Authorization: `Key ${p.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const submit = (await safeJson(res)) as { status_url?: string; response_url?: string; request_id?: string };
	const statusUrl = submit.status_url;
	const responseUrl = submit.response_url;
	if (!statusUrl || !responseUrl) throw new Error("fal submit returned no status_url/response_url.");

	await pollUntil(
		async () => {
			const r = await p.fetchFn(statusUrl, {
				headers: { Authorization: `Key ${p.apiKey}` },
				signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status} ${(await safeText(r)).slice(0, 200)}`);
			const status = (readString((await safeJson(r)) as Record<string, unknown>, "status") ?? "").toUpperCase();
			if (status === "FAILED" || status === "ERROR") throw new Error(`fal reported status "${status}".`);
			return status === "COMPLETED" ? true : POLL_AGAIN;
		},
		{ intervalMs: scaleInterval(5_000, p.intervalOverride), maxAttempts: 120 },
	);

	const finalRes = await p.fetchFn(responseUrl, {
		headers: { Authorization: `Key ${p.apiKey}` },
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!finalRes.ok) throw new Error(`HTTP ${finalRes.status} ${(await safeText(finalRes)).slice(0, 200)}`);
	const out = (await safeJson(finalRes)) as { video?: { url?: string }; videos?: Array<{ url?: string }> };
	const url = out.video?.url ?? out.videos?.[0]?.url;
	if (!url) throw new Error("fal response carried no video url.");
	return downloadVideo(url, p.fetchFn, p.apiKey, p.signal);
}

/**
 * OpenAI Sora. Submit `POST /v1/videos` → `{id,status}`; poll
 * `GET /v1/videos/{id}` until `completed`; download bytes from
 * `GET /v1/videos/{id}/content?variant=video`.
 */
async function generateOpenAI(p: GenerateParams): Promise<Buffer> {
	const body: Record<string, unknown> = { prompt: p.prompt, model: p.model };
	if (p.durationSeconds !== undefined) body.seconds = String(p.durationSeconds);
	if (p.resolution) body.size = p.resolution;
	if (p.imageDataUrl) body.input_reference = { image_url: p.imageDataUrl };

	const res = await p.fetchFn("https://api.openai.com/v1/videos", {
		method: "POST",
		headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const submit = (await safeJson(res)) as { id?: string };
	const id = submit.id;
	if (!id) throw new Error("OpenAI video submit returned no id.");

	await pollUntil(
		async () => {
			const r = await p.fetchFn(`https://api.openai.com/v1/videos/${encodeURIComponent(id)}`, {
				headers: { Authorization: `Bearer ${p.apiKey}` },
				signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status} ${(await safeText(r)).slice(0, 200)}`);
			const status = (readString((await safeJson(r)) as Record<string, unknown>, "status") ?? "").toLowerCase();
			if (status === "failed" || status === "error") throw new Error(`OpenAI reported status "${status}".`);
			return status === "completed" ? true : POLL_AGAIN;
		},
		{ intervalMs: scaleInterval(2_500, p.intervalOverride), maxAttempts: 120 },
	);

	const contentRes = await p.fetchFn(
		`https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content?variant=video`,
		{
			headers: { Authorization: `Bearer ${p.apiKey}`, Accept: "application/binary" },
			signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
		},
	);
	if (!contentRes.ok) throw new Error(`HTTP ${contentRes.status} ${(await safeText(contentRes)).slice(0, 200)}`);
	return Buffer.from(await contentRes.arrayBuffer());
}

/**
 * xAI grok-imagine-video. Submit `POST /v1/videos/generations` → `{request_id}`;
 * poll `GET /v1/videos/{request_id}` until `done`; download `video.url`.
 */
async function generateXai(p: GenerateParams): Promise<Buffer> {
	const body: Record<string, unknown> = { model: p.model, prompt: p.prompt };
	if (p.imageDataUrl) body.image = { url: p.imageDataUrl };
	if (p.durationSeconds !== undefined) body.duration = p.durationSeconds;
	if (p.aspectRatio) body.aspect_ratio = p.aspectRatio;
	if (p.resolution) body.resolution = p.resolution;

	const res = await p.fetchFn("https://api.x.ai/v1/videos/generations", {
		method: "POST",
		headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const submit = (await safeJson(res)) as { request_id?: string };
	const id = submit.request_id;
	if (!id) throw new Error("xAI video submit returned no request_id.");

	const url = await pollUntil(
		async () => {
			const r = await p.fetchFn(`https://api.x.ai/v1/videos/${encodeURIComponent(id)}`, {
				headers: { Authorization: `Bearer ${p.apiKey}` },
				signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status} ${(await safeText(r)).slice(0, 200)}`);
			const pollBody = (await safeJson(r)) as Record<string, unknown>;
			const status = (readString(pollBody, "status") ?? "").toLowerCase();
			if (status === "failed" || status === "expired" || status === "error") {
				throw new Error(`xAI reported status "${status}".`);
			}
			if (status === "done") {
				const videoUrl = (pollBody.video as { url?: string } | undefined)?.url ?? findVideoUrl(pollBody);
				if (!videoUrl) throw new Error("xAI reported done but carried no video url.");
				return videoUrl;
			}
			return POLL_AGAIN;
		},
		{ intervalMs: scaleInterval(5_000, p.intervalOverride), maxAttempts: 120 },
	);
	return downloadVideo(url, p.fetchFn, p.apiKey, p.signal);
}

/**
 * MiniMax Hailuo. Submit `POST /v1/video_generation` → `{task_id}`; poll
 * `GET /v1/query/video_generation?task_id=` until `Success`; on success take
 * `video_url` if present, else resolve `file_id` → `/v1/files/retrieve` →
 * `file.download_url`; download.
 */
async function generateMiniMax(p: GenerateParams): Promise<Buffer> {
	const body: Record<string, unknown> = { model: p.model, prompt: p.prompt };
	if (p.imageDataUrl) body.first_frame_image = p.imageDataUrl;

	const res = await p.fetchFn("https://api.minimax.io/v1/video_generation", {
		method: "POST",
		headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const submit = (await safeJson(res)) as { task_id?: string };
	const taskId = submit.task_id;
	if (!taskId) throw new Error("MiniMax video submit returned no task_id.");

	const result = await pollUntil(
		async () => {
			const r = await p.fetchFn(
				`https://api.minimax.io/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
				{ headers: { Authorization: `Bearer ${p.apiKey}` }, signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS) },
			);
			if (!r.ok) throw new Error(`HTTP ${r.status} ${(await safeText(r)).slice(0, 200)}`);
			const pollBody = (await safeJson(r)) as { status?: string; video_url?: string; file_id?: string };
			const status = (pollBody.status ?? "").toLowerCase();
			if (status === "fail" || status === "failed" || status === "error") {
				throw new Error(`MiniMax reported status "${pollBody.status}".`);
			}
			if (status === "success") {
				return { videoUrl: pollBody.video_url, fileId: pollBody.file_id };
			}
			return POLL_AGAIN;
		},
		{ intervalMs: scaleInterval(10_000, p.intervalOverride), maxAttempts: 90 },
	);

	if (result.videoUrl) return downloadVideo(result.videoUrl, p.fetchFn, p.apiKey, p.signal);
	if (!result.fileId) throw new Error("MiniMax success carried neither video_url nor file_id.");
	const fileRes = await p.fetchFn(
		`https://api.minimax.io/v1/files/retrieve?file_id=${encodeURIComponent(result.fileId)}`,
		{ headers: { Authorization: `Bearer ${p.apiKey}` }, signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS) },
	);
	if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status} ${(await safeText(fileRes)).slice(0, 200)}`);
	const fileBody = (await safeJson(fileRes)) as { file?: { download_url?: string } };
	const downloadUrl = fileBody.file?.download_url;
	if (!downloadUrl) throw new Error("MiniMax file retrieve carried no download_url.");
	return downloadVideo(downloadUrl, p.fetchFn, p.apiKey, p.signal);
}

/**
 * Runway. Submit `POST /v1/text_to_video` (or `/v1/image_to_video` when an
 * image is given), header `X-Runway-Version`; poll `GET /v1/tasks/{id}` until
 * `SUCCEEDED`; `output[0]` is the video URL → download.
 */
async function generateRunway(p: GenerateParams): Promise<Buffer> {
	const headers = {
		Authorization: `Bearer ${p.apiKey}`,
		"Content-Type": "application/json",
		"X-Runway-Version": "2024-11-06",
	};
	const ratio = p.aspectRatio && p.aspectRatio.includes(":") && /\d/.test(p.aspectRatio) ? p.aspectRatio : "1280:720";
	const duration = p.durationSeconds ?? 5;

	let submitUrl: string;
	let body: Record<string, unknown>;
	if (p.imageDataUrl) {
		submitUrl = "https://api.dev.runwayml.com/v1/image_to_video";
		body = { model: p.model, promptText: p.prompt, promptImage: p.imageDataUrl, ratio, duration };
	} else {
		submitUrl = "https://api.dev.runwayml.com/v1/text_to_video";
		body = { model: p.model, promptText: p.prompt, ratio, duration };
	}

	const res = await p.fetchFn(submitUrl, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const submit = (await safeJson(res)) as { id?: string };
	const id = submit.id;
	if (!id) throw new Error("Runway submit returned no id.");

	const url = await pollUntil(
		async () => {
			const r = await p.fetchFn(`https://api.dev.runwayml.com/v1/tasks/${encodeURIComponent(id)}`, {
				headers,
				signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status} ${(await safeText(r)).slice(0, 200)}`);
			const pollBody = (await safeJson(r)) as { status?: string; output?: unknown };
			const status = (pollBody.status ?? "").toUpperCase();
			if (status === "FAILED" || status === "CANCELLED" || status === "ERROR") {
				throw new Error(`Runway reported status "${pollBody.status}".`);
			}
			if (status === "SUCCEEDED") {
				const out = Array.isArray(pollBody.output) ? pollBody.output : [];
				const first = out.find((x): x is string => typeof x === "string" && x.length > 0);
				if (!first) throw new Error("Runway succeeded but output[0] was empty.");
				return first;
			}
			return POLL_AGAIN;
		},
		{ intervalMs: scaleInterval(5_000, p.intervalOverride), maxAttempts: 120 },
	);
	return downloadVideo(url, p.fetchFn, p.apiKey, p.signal);
}

/* ───────────────────────── shared helpers ───────────────────────── */

/**
 * Sentinel a poll callback returns to mean "not finished yet — keep polling".
 * Using a unique symbol (rather than `undefined`) lets the callback's resolved
 * value type infer `T` cleanly while keeping the keep-polling signal
 * unambiguous and impossible to collide with a real result value.
 */
export const POLL_AGAIN: unique symbol = Symbol("poll-again");

/**
 * Generic inline poller. Calls `fn` every `intervalMs` until it returns a real
 * value (returned) or throws (propagated as a hard failure). Returning
 * `POLL_AGAIN` (an unknown / transient / queued status) just waits and retries.
 * Bounded by BOTH `maxAttempts` AND the absolute `POLL_TIMEOUT_MS` wall-clock
 * ceiling so a wedged job can never hang the agent loop forever.
 */
export async function pollUntil<T>(
	fn: () => Promise<T | typeof POLL_AGAIN>,
	options: { intervalMs: number; maxAttempts: number },
): Promise<T> {
	const started = Date.now();
	for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
		const result = await fn();
		if (result !== POLL_AGAIN) return result;
		if (Date.now() - started > POLL_TIMEOUT_MS) {
			throw new Error(`Timed out polling for the finished video after ${Math.round(POLL_TIMEOUT_MS / 1000)}s.`);
		}
		await sleep(options.intervalMs);
	}
	throw new Error(`Timed out polling for the finished video after ${options.maxAttempts} attempts.`);
}

/**
 * Download the final video. If the URL is a `data:` URL, decode its base64
 * payload directly; otherwise GET the URL and read the body as bytes. The
 * provider key is sent as a Bearer header for same-origin signed URLs that
 * still require auth; cross-origin CDN URLs simply ignore it.
 */
export async function downloadVideo(
	url: string,
	fetchFn: typeof fetch,
	apiKey: string,
	signal?: AbortSignal,
): Promise<Buffer> {
	if (url.startsWith("data:")) {
		const comma = url.indexOf(",");
		const meta = url.slice(0, comma);
		const payload = url.slice(comma + 1);
		if (meta.includes(";base64")) return Buffer.from(payload, "base64");
		return Buffer.from(decodeURIComponent(payload), "utf8");
	}
	const res = await fetchFn(url, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`download HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	return Buffer.from(await res.arrayBuffer());
}

/**
 * Read an `image` argument (a local path OR an http(s) URL) into a
 * `data:<mime>;base64,…` data URL suitable for the image-to-video providers.
 */
async function loadImageAsDataUrl(image: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<string> {
	if (/^https?:\/\//i.test(image)) {
		const res = await fetchFn(image, { signal: withTimeout(signal, REQUEST_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`HTTP ${res.status} fetching image URL`);
		const bytes = Buffer.from(await res.arrayBuffer());
		const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || guessImageMime(image);
		return `data:${mime};base64,${bytes.toString("base64")}`;
	}
	// Treat as a local filesystem path.
	const bytes = fs.readFileSync(image);
	return `data:${guessImageMime(image)};base64,${bytes.toString("base64")}`;
}

function guessImageMime(p: string): string {
	const ext = path.extname(p).toLowerCase();
	switch (ext) {
		case ".png":
			return "image/png";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".heic":
			return "image/heic";
		case ".jpg":
		case ".jpeg":
		default:
			return "image/jpeg";
	}
}

/**
 * Deep-search an arbitrary JSON body for the first usable video URL — an
 * `https://…mp4` (or any https URL on a key that smells like a video field) or
 * a `data:video…` data URL. Used by the providers (chiefly OpenRouter) whose
 * exact response field for the finished video isn't pinned down.
 */
export function findVideoUrl(body: unknown): string | undefined {
	const seen = new Set<unknown>();
	const stack: unknown[] = [body];
	let httpsFallback: string | undefined;
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || node === undefined) continue;
		if (typeof node === "string") {
			if (node.startsWith("data:video")) return node;
			if (/^https?:\/\/\S+\.mp4(\?\S*)?$/i.test(node)) return node;
			if (!httpsFallback && /^https?:\/\//i.test(node) && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(node)) {
				httpsFallback = node;
			}
			continue;
		}
		if (typeof node !== "object") continue;
		if (seen.has(node)) continue;
		seen.add(node);
		if (Array.isArray(node)) {
			for (const item of node) stack.push(item);
			continue;
		}
		for (const value of Object.values(node as Record<string, unknown>)) stack.push(value);
	}
	return httpsFallback;
}

/** Read a string property from a loose object (undefined when absent/non-string). */
function readString(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Scale a provider's real poll interval by the test override. When no override
 * is set, the real cadence is used; when a tiny override is supplied (tests),
 * every provider collapses to it so the flow runs without real waits.
 */
function scaleInterval(realMs: number, override: number | undefined): number {
	if (override === undefined) return realMs;
	return Math.max(0, override);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		if (typeof t.unref === "function") t.unref();
	});
}

function resolveConfiguredModel(provider: VideoProviderId): string | undefined {
	try {
		const cfg = loadConfig() as { tools?: { video?: { models?: Record<string, unknown> } } };
		const m = cfg.tools?.video?.models?.[provider];
		if (typeof m === "string" && m.trim()) return m.trim();
	} catch {
		/* default below */
	}
	return undefined;
}

function buildFileName(hint: string | undefined): string {
	const stamp = Date.now().toString(36);
	const base = hint
		? path.basename(hint).replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48)
		: `video-${stamp}`;
	return `${base}.mp4`;
}

function fail(
	action: "generate" | "list",
	message: string,
	extra: Partial<GenerateVideoDetails> = {},
): AgentToolResult<GenerateVideoDetails> {
	return jsonResult({
		action,
		ok: false,
		message,
		...extra,
	} satisfies GenerateVideoDetails) as AgentToolResult<GenerateVideoDetails>;
}

async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

async function safeJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return {};
	}
}

/** Compose the caller's signal with a hard per-request timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(ms);
	if (!signal) return timeoutSignal;
	return AbortSignal.any([signal, timeoutSignal]);
}
