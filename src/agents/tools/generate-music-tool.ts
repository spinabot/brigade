/**
 * `generate_music` tool — text-to-music generation, modeled on the proven
 * `generate_speech` self-contained pattern.
 *
 * Why this tool exists
 * --------------------
 * Same reasoning as `generate_speech`/`generate_image`: without a first-class
 * tool, "make a song" / "compose background music" sends the model to raw
 * `curl` against a music API — the key flows through a shell, the (binary or
 * base64) audio response gets mangled by a text-only parser, and a billed
 * generation is dropped. This tool owns the call in-process: stored auth,
 * validated params, a parser that understands each provider's audio shape, and
 * a saved file the model hands to `send_media`.
 *
 * Providers (auto-selected by which key is configured, preference order):
 *   • google     — Lyria via Gemini generateContent (AUDIO modality) → base64
 *                  audio (mp3). Single POST, no poll.
 *   • minimax    — Music generation → URL or inline (hex/base64) audio (mp3).
 *   • elevenlabs — Music endpoint → raw mp3 bytes.
 * Keys resolve through `resolveMediaProviderKey` (the same credential-store +
 * env path the media-understanding subsystem uses), so music generation works
 * for whichever provider the operator already configured — no bespoke auth.
 *
 * Flow: generate → bytes saved under `<cache>/audio/` → result text carries a
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

/** Music generation can take a while; bound each HTTP call generously. */
const REQUEST_TIMEOUT_MS = 180_000;
/** Hard cap on prompt length — providers reject very long prompts; fail clearly. */
const MAX_PROMPT_CHARS = 8_000;

type MusicProviderId = "google" | "minimax" | "elevenlabs";

/** Preference order when no provider is pinned: first keyed one wins. */
const PROVIDER_PREFERENCE: MusicProviderId[] = ["google", "minimax", "elevenlabs"];

const DEFAULTS: Record<MusicProviderId, { model: string }> = {
	google: { model: "lyria-3-clip-preview" },
	minimax: { model: "music-2.5+" },
	elevenlabs: { model: "" },
};

const GenerateMusicParams = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("generate"), Type.Literal("list")], {
			description: 'Optional: "generate" (default) or "list" to see which music providers are configured.',
		}),
	),
	prompt: Type.Optional(
		Type.String({ description: "The style/description of the music to generate (e.g. 'upbeat lo-fi hip hop with mellow piano')." }),
	),
	lyrics: Type.Optional(Type.String({ description: "Optional lyrics for vocal tracks (ignored when instrumental)." })),
	instrumental: Type.Optional(Type.Boolean({ description: "Optional: when true, generate instrumental-only (no vocals)." })),
	provider: Type.Optional(
		Type.Union(
			[Type.Literal("google"), Type.Literal("minimax"), Type.Literal("elevenlabs")],
			{ description: "Optional music provider override. Default: the first one with a configured key." },
		),
	),
	model: Type.Optional(Type.String({ description: "Optional model override for the chosen provider." })),
	durationSeconds: Type.Optional(
		Type.Integer({ description: "Optional target length in seconds (where the provider supports it, e.g. ElevenLabs)." }),
	),
	filename: Type.Optional(
		Type.String({ description: "Optional output filename hint (basename preserved, saved under the managed audio dir)." }),
	),
});

interface GenerateMusicDetails {
	action: "generate" | "list";
	provider?: string;
	model?: string;
	path?: string;
	providers?: string[];
	ok: boolean;
	message?: string;
}

export interface MakeGenerateMusicToolOptions {
	/** Caller's agent id — drives which credential store backs the key. */
	agentId?: string;
	/** Test seam: replaces global fetch. */
	fetchFn?: typeof fetch;
	/** Test seam: output directory override. Default `<cache>/audio`. */
	outDirOverride?: string;
	/** Test seam: per-provider API-key resolver override. */
	resolveKey?: (provider: MusicProviderId) => string;
}

export function makeGenerateMusicTool(
	opts: MakeGenerateMusicToolOptions = {},
): BrigadeTool<typeof GenerateMusicParams, GenerateMusicDetails> {
	const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
	const fetchFn = opts.fetchFn ?? fetch;
	const resolveKey = opts.resolveKey ?? ((p: MusicProviderId) => resolveMediaProviderKey(p, agentId));

	return {
		name: "generate_music",
		label: "Generate Music",
		displaySummary: "generating music",
		// Billed per call (cloud music generation) — owner-gated like generate_speech.
		ownerOnly: true,
		description: [
			"Generate music from a text description (text-to-music). USE THIS — never call a music API with bash/curl: the key must not flow through a shell, and the binary/base64 audio response is parsed here.",
			'action="generate" (default): requires `prompt` (the style/description). Saves an audio file and returns its REAL path as a `MEDIA:<path>` line — reference that path exactly; never invent one.',
			"Optional `lyrics`, `instrumental`, `durationSeconds`. Auto-selects the first configured provider (Google → MiniMax → ElevenLabs); override with `provider`/`model`.",
			"To play it for the operator on a chat surface, follow up with `send_media({path})` — generation does NOT auto-send.",
			'action="list": show which music providers have a configured key.',
		].join(" "),
		parameters: GenerateMusicParams,
		execute: async (_id, args, signal): Promise<AgentToolResult<GenerateMusicDetails>> => {
			const action = args.action ?? "generate";

			if (action === "list") {
				const providers = PROVIDER_PREFERENCE.filter((p) => resolveKey(p).length > 0);
				return jsonResult({
					action,
					providers,
					ok: true,
					message:
						providers.length > 0
							? `${providers.length} music provider(s) configured: ${providers.join(", ")}.`
							: "No music provider configured. Add a Google, MiniMax, or ElevenLabs key with `brigade onboard`.",
				} satisfies GenerateMusicDetails) as AgentToolResult<GenerateMusicDetails>;
			}

			const prompt = (args.prompt ?? "").trim();
			if (!prompt) {
				return fail(action, "`prompt` is required for action=generate.");
			}
			if (prompt.length > MAX_PROMPT_CHARS) {
				return fail(action, `\`prompt\` is too long (${prompt.length} chars; max ${MAX_PROMPT_CHARS}). Shorten it.`);
			}

			const instrumental = args.instrumental === true;
			const lyrics = args.lyrics?.trim() || undefined;
			// Instrumental + lyrics is contradictory — refuse rather than silently drop one.
			if (instrumental && lyrics) {
				return fail(action, "`instrumental` and `lyrics` cannot both be set — pick one (instrumental = no vocals).");
			}

			// Resolve the provider: explicit override (must be keyed) else first keyed.
			let provider: MusicProviderId | undefined;
			if (args.provider) {
				if (resolveKey(args.provider).length === 0) {
					return fail(action, `Provider "${args.provider}" has no configured key. Add one with \`brigade onboard\`, or omit \`provider\` to auto-select.`);
				}
				provider = args.provider;
			} else {
				provider = PROVIDER_PREFERENCE.find((p) => resolveKey(p).length > 0);
			}
			if (!provider) {
				return fail(
					action,
					"No music provider is configured. Add a Google, MiniMax, or ElevenLabs API key with `brigade onboard` (then this tool auto-selects it).",
				);
			}

			const apiKey = resolveKey(provider);
			const model = args.model?.trim() || resolveConfiguredModel(provider) || DEFAULTS[provider].model;
			const durationSeconds =
				typeof args.durationSeconds === "number" && Number.isFinite(args.durationSeconds) && args.durationSeconds > 0
					? Math.trunc(args.durationSeconds)
					: undefined;

			let audio: { bytes: Buffer; extension: string };
			try {
				audio = await generate({ provider, fetchFn, apiKey, model, prompt, lyrics, instrumental, durationSeconds, signal });
			} catch (err) {
				return fail(action, `Music generation via ${provider} failed: ${err instanceof Error ? err.message : String(err)}`, {
					provider,
					model,
				});
			}

			const outDir = opts.outDirOverride ?? path.join(resolveCacheDir(), "audio");
			fs.mkdirSync(outDir, { recursive: true });
			const outPath = path.join(outDir, buildFileName(args.filename, audio.extension));
			fs.writeFileSync(outPath, audio.bytes);

			return {
				content: [
					{
						type: "text",
						text: [
							`Generated music with ${model ? `${provider}/${model}` : provider}.`,
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
	provider: MusicProviderId;
	fetchFn: typeof fetch;
	apiKey: string;
	model: string;
	prompt: string;
	lyrics?: string;
	instrumental: boolean;
	durationSeconds?: number;
	signal?: AbortSignal;
}

async function generate(params: GenerateParams): Promise<{ bytes: Buffer; extension: string }> {
	switch (params.provider) {
		case "google":
			return generateGoogle(params);
		case "minimax":
			return generateMiniMax(params);
		case "elevenlabs":
			return generateElevenLabs(params);
	}
}

async function generateGoogle(p: GenerateParams): Promise<{ bytes: Buffer; extension: string }> {
	// Lyria via Gemini generateContent. Assemble the textual prompt with the
	// instrumental hint and lyrics folded in (the API takes a single text part).
	let text = p.prompt;
	if (p.instrumental) text += "\n\nInstrumental only. No vocals.";
	if (p.lyrics) text += `\n\nLyrics:\n${p.lyrics}`;

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(p.apiKey)}`;
	const res = await p.fetchFn(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text }] }],
			generationConfig: { responseModalities: ["AUDIO", "TEXT"] },
		}),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const body = (await res.json()) as {
		candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
	};
	const part = body.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data);
	const data = part?.inlineData?.data;
	if (!data) throw new Error("Lyria returned no audio data.");
	const bytes = Buffer.from(data, "base64");
	// Lyria returns mp3 by default. (If the mimeType ever reports raw PCM/L16 the
	// bytes won't be playable as-is, but the documented default is mp3.)
	return { bytes, extension: "mp3" };
}

async function generateMiniMax(p: GenerateParams): Promise<{ bytes: Buffer; extension: string }> {
	const reqBody: Record<string, unknown> = {
		model: p.model || "music-2.5+",
		prompt: p.prompt,
		output_format: "url",
		audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
	};
	if (p.instrumental) reqBody.is_instrumental = true;
	if (p.lyrics) reqBody.lyrics = p.lyrics;

	const res = await p.fetchFn("https://api.minimax.io/v1/music_generation", {
		method: "POST",
		headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(reqBody),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const body = (await res.json()) as {
		data?: { audio?: string; audio_url?: string };
		audio?: string;
		audio_url?: string;
		base_resp?: { status_code?: number; status_msg?: string };
	};
	if (body.base_resp && body.base_resp.status_code !== 0) {
		throw new Error(`MiniMax error ${body.base_resp.status_code}: ${body.base_resp.status_msg ?? ""}`);
	}

	// Prefer an explicit URL field; otherwise the audio field may be a URL or inline.
	const urlValue = body.data?.audio_url ?? body.audio_url;
	const audioValue = body.data?.audio ?? body.audio;
	const candidate = urlValue ?? audioValue;
	if (!candidate) throw new Error("MiniMax returned no audio.");

	if (/^https?:\/\//.test(candidate)) {
		const bytes = await downloadBytes(p.fetchFn, candidate, p.signal);
		return { bytes, extension: "mp3" };
	}
	// Inline: hex (only [0-9a-f], even length) → hex; else base64.
	const isHex = candidate.length % 2 === 0 && /^[0-9a-f]+$/.test(candidate);
	const bytes = Buffer.from(candidate, isHex ? "hex" : "base64");
	return { bytes, extension: "mp3" };
}

async function generateElevenLabs(p: GenerateParams): Promise<{ bytes: Buffer; extension: string }> {
	const reqBody: Record<string, unknown> = { prompt: p.prompt };
	if (p.durationSeconds) reqBody.music_length_ms = p.durationSeconds * 1000;

	const res = await p.fetchFn("https://api.elevenlabs.io/v1/music", {
		method: "POST",
		headers: { "xi-api-key": p.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
		body: JSON.stringify(reqBody),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	return { bytes: Buffer.from(await res.arrayBuffer()), extension: "mp3" };
}

/* ───────────────────────── helpers ───────────────────────── */

async function downloadBytes(fetchFn: typeof fetch, url: string, signal?: AbortSignal): Promise<Buffer> {
	const res = await fetchFn(url, { method: "GET", signal: withTimeout(signal, REQUEST_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`download HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	return Buffer.from(await res.arrayBuffer());
}

function resolveConfiguredModel(provider: MusicProviderId): string | undefined {
	try {
		const cfg = loadConfig() as { tools?: { music?: { models?: Record<string, unknown> } } };
		const m = cfg.tools?.music?.models?.[provider];
		if (typeof m === "string" && m.trim()) return m.trim();
	} catch {
		/* default below */
	}
	return undefined;
}

function buildFileName(hint: string | undefined, extension: string): string {
	const stamp = Date.now().toString(36);
	const base = hint
		? path.basename(hint).replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48)
		: `music-${stamp}`;
	return `${base}.${extension}`;
}

function fail(
	action: "generate" | "list",
	message: string,
	extra: Partial<GenerateMusicDetails> = {},
): AgentToolResult<GenerateMusicDetails> {
	return jsonResult({ action, ok: false, message, ...extra } satisfies GenerateMusicDetails) as AgentToolResult<GenerateMusicDetails>;
}

async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

/** Compose the caller's signal with a hard per-request timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(ms);
	if (!signal) return timeoutSignal;
	return AbortSignal.any([signal, timeoutSignal]);
}
