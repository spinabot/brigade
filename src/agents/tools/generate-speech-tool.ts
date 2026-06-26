/**
 * `generate_speech` tool — text-to-speech (TTS), modeled on the proven
 * `generate_image` self-contained pattern.
 *
 * Why this tool exists
 * --------------------
 * Same reasoning as `generate_image`: without a first-class tool, "read this
 * out loud" / "make a voiceover" sends the model to raw `curl` against a TTS
 * API — the key flows through a shell, the (binary) audio response gets
 * mangled by a text-only parser, and a billed synthesis is dropped. This tool
 * owns the call in-process: stored auth, validated params, a parser that
 * understands each provider's audio shape, and a saved file the model hands to
 * `send_media`.
 *
 * Providers (auto-selected by which key is configured, preference order):
 *   • openai     — POST /v1/audio/speech → mp3 bytes (gpt-4o-mini-tts / tts-1)
 *   • elevenlabs — POST /v1/text-to-speech/{voice} → mp3 bytes
 *   • google     — Gemini TTS generateContent (AUDIO modality) → base64 PCM,
 *                  wrapped into a WAV container here.
 * Keys resolve through `resolveMediaProviderKey` (the same credential-store +
 * env path the media-understanding subsystem uses), so TTS works for whichever
 * provider the operator already configured — no bespoke auth.
 *
 * Flow: synthesize → bytes saved under `<cache>/audio/` → result text carries a
 * `MEDIA:<saved-path>` line → the model delivers with `send_media({path})`.
 */

import fs from "node:fs";
import path from "node:path";

import { Type } from "typebox";

import { resolveCacheDir, DEFAULT_AGENT_ID } from "../../config/paths.js";
import { loadConfig } from "../../core/config.js";
import { resolveMediaProviderKey } from "../media-understanding/config.js";
import { synthesizeEdge } from "./edge-tts.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

/** Synthesis can take a few seconds for long input; bound each HTTP call. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Hard cap on input length — providers reject very long text; fail clearly. */
const MAX_INPUT_CHARS = 8_000;

type SpeechProviderId = "openai" | "elevenlabs" | "google" | "minimax" | "xai" | "edge";

/** Preference order when no provider is pinned: first AVAILABLE one wins. Edge is
 *  FREE (no key, Microsoft "Read Aloud" over WebSocket) so it sits LAST — a
 *  configured cloud provider is preferred, and Edge is the always-available free
 *  fallback when no cloud TTS key exists. */
const PROVIDER_PREFERENCE: SpeechProviderId[] = ["openai", "elevenlabs", "google", "minimax", "xai", "edge"];

const DEFAULTS: Record<SpeechProviderId, { model: string; voice: string }> = {
	openai: { model: "gpt-4o-mini-tts", voice: "alloy" },
	elevenlabs: { model: "eleven_multilingual_v2", voice: "21m00Tcm4TlvDq8ikWAM" },
	google: { model: "gemini-2.5-flash-preview-tts", voice: "Kore" },
	minimax: { model: "speech-2.8-hd", voice: "English_expressive_narrator" },
	xai: { model: "", voice: "eve" },
	edge: { model: "", voice: "en-US-AvaNeural" },
};

const GenerateSpeechParams = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("generate"), Type.Literal("list")], {
			description: 'Optional: "generate" (default) or "list" to see which TTS providers are configured.',
		}),
	),
	text: Type.Optional(Type.String({ description: "The text to speak aloud." })),
	provider: Type.Optional(
		Type.Union(
			[Type.Literal("openai"), Type.Literal("elevenlabs"), Type.Literal("google"), Type.Literal("minimax"), Type.Literal("xai"), Type.Literal("edge")],
			{ description: "Optional TTS provider override. `edge` is FREE (no key). Default: first available (cloud preferred, edge fallback)." },
		),
	),
	voice: Type.Optional(
		Type.String({
			description:
				"Optional voice. OpenAI: alloy/echo/fable/onyx/nova/shimmer/sage/coral/… · ElevenLabs: a voice id · Google: Kore/Puck/Charon/… Defaults to a sensible voice per provider.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Optional model override for the chosen provider." })),
	filename: Type.Optional(
		Type.String({ description: "Optional output filename hint (basename preserved, saved under the managed audio dir)." }),
	),
});

interface GenerateSpeechDetails {
	action: "generate" | "list";
	provider?: string;
	model?: string;
	voice?: string;
	path?: string;
	providers?: string[];
	ok: boolean;
	message?: string;
}

export interface MakeGenerateSpeechToolOptions {
	/** Caller's agent id — drives which credential store backs the key. */
	agentId?: string;
	/** Test seam: replaces global fetch. */
	fetchFn?: typeof fetch;
	/** Test seam: output directory override. Default `<cache>/audio`. */
	outDirOverride?: string;
	/** Test seam: per-provider API-key resolver override. */
	resolveKey?: (provider: SpeechProviderId) => string;
	/** Test seam: replace the free Edge WebSocket synth (the `edge` provider has no key). */
	edgeSynth?: (text: string, voice: string, signal?: AbortSignal) => Promise<Buffer>;
}

export function makeGenerateSpeechTool(
	opts: MakeGenerateSpeechToolOptions = {},
): BrigadeTool<typeof GenerateSpeechParams, GenerateSpeechDetails> {
	const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
	const fetchFn = opts.fetchFn ?? fetch;
	const resolveKey = opts.resolveKey ?? ((p: SpeechProviderId) => resolveMediaProviderKey(p, agentId));
	const edgeSynth =
		opts.edgeSynth ??
		((text: string, voice: string, signal?: AbortSignal) =>
			synthesizeEdge({ text, voice, ...(signal ? { signal } : {}) }));
	// Edge is FREE (no key) → always available; every other provider needs a key.
	const isAvailable = (p: SpeechProviderId): boolean => p === "edge" || resolveKey(p).length > 0;

	return {
		name: "generate_speech",
		label: "Generate Speech",
		displaySummary: "synthesizing speech",
		// Billed per call (cloud TTS) — owner-gated like generate_image.
		ownerOnly: true,
		description: [
			"Turn text into spoken audio (text-to-speech). USE THIS — never call a TTS API with bash/curl: the key must not flow through a shell, and the binary audio response is parsed here.",
			'action="generate" (default): requires `text`. Saves an audio file and returns its REAL path as a `MEDIA:<path>` line — reference that path exactly; never invent one.',
			"Auto-selects the first configured provider (OpenAI → ElevenLabs → Google); override with `provider`/`voice`/`model`.",
			"To play it for the operator on a chat surface, follow up with `send_media({path})` — generation does NOT auto-send.",
			'action="list": show which TTS providers have a configured key.',
		].join(" "),
		parameters: GenerateSpeechParams,
		execute: async (_id, args, signal): Promise<AgentToolResult<GenerateSpeechDetails>> => {
			const action = args.action ?? "generate";

			if (action === "list") {
				const providers = PROVIDER_PREFERENCE.filter(isAvailable);
				return jsonResult({
					action,
					providers,
					ok: true,
					message:
						providers.length > 0
							? `${providers.length} TTS provider(s) available: ${providers.join(", ")} (edge is free, no key).`
							: "No TTS provider available. Add an OpenAI/ElevenLabs/Google key with `brigade onboard` (or edge works free).",
				} satisfies GenerateSpeechDetails) as AgentToolResult<GenerateSpeechDetails>;
			}

			const text = (args.text ?? "").trim();
			if (!text) {
				return fail(action, "`text` is required for action=generate.");
			}
			if (text.length > MAX_INPUT_CHARS) {
				return fail(action, `\`text\` is too long (${text.length} chars; max ${MAX_INPUT_CHARS}). Split it into shorter calls.`);
			}

			// Resolve the provider: explicit override (must be keyed) else first keyed.
			let provider: SpeechProviderId | undefined;
			if (args.provider) {
				if (!isAvailable(args.provider)) {
					return fail(action, `Provider "${args.provider}" has no configured key. Add one with \`brigade onboard\`, or omit \`provider\` to auto-select (or use the free \`edge\`).`);
				}
				provider = args.provider;
			} else {
				provider = PROVIDER_PREFERENCE.find(isAvailable);
			}
			if (!provider) {
				return fail(
					action,
					"No TTS provider is available. Add an OpenAI/ElevenLabs/Google API key with `brigade onboard` — or use the free `edge` provider (no key needed).",
				);
			}

			const apiKey = resolveKey(provider);
			const model = args.model?.trim() || resolveConfiguredModel(provider) || DEFAULTS[provider].model;
			const voice = args.voice?.trim() || DEFAULTS[provider].voice;

			let audio: { bytes: Buffer; extension: string };
			try {
				audio =
					provider === "edge"
						? { bytes: await edgeSynth(text, voice, signal), extension: "mp3" }
						: await synthesize({ provider, fetchFn, apiKey, model, voice, text, signal });
			} catch (err) {
				return fail(action, `TTS via ${provider} failed: ${err instanceof Error ? err.message : String(err)}`, { provider, model, voice });
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
							`Synthesized speech with ${model ? `${provider}/${model}` : provider} (voice: ${voice}).`,
							`MEDIA:${outPath}`,
							"Deliver with send_media({path}) — generation does not auto-send.",
						].join("\n"),
					},
				],
				details: { action, provider, model, voice, path: outPath, ok: true },
			};
		},
	};
}

/* ───────────────────────── provider plumbing ───────────────────────── */

async function synthesize(params: {
	// `edge` is handled in execute (no key, WS synth) before this dispatch, so the
	// cloud switch below is exhaustive for the remaining provider ids.
	provider: Exclude<SpeechProviderId, "edge">;
	fetchFn: typeof fetch;
	apiKey: string;
	model: string;
	voice: string;
	text: string;
	signal?: AbortSignal;
}): Promise<{ bytes: Buffer; extension: string }> {
	switch (params.provider) {
		case "openai":
			return synthesizeOpenAI(params);
		case "elevenlabs":
			return synthesizeElevenLabs(params);
		case "google":
			return synthesizeGoogle(params);
		case "minimax":
			return synthesizeMiniMax(params);
		case "xai":
			return synthesizeXai(params);
	}
}

async function synthesizeOpenAI(p: {
	fetchFn: typeof fetch;
	apiKey: string;
	model: string;
	voice: string;
	text: string;
	signal?: AbortSignal;
}): Promise<{ bytes: Buffer; extension: string }> {
	const res = await p.fetchFn("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: p.model, input: p.text, voice: p.voice, response_format: "mp3" }),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	return { bytes: Buffer.from(await res.arrayBuffer()), extension: "mp3" };
}

async function synthesizeElevenLabs(p: {
	fetchFn: typeof fetch;
	apiKey: string;
	model: string;
	voice: string;
	text: string;
	signal?: AbortSignal;
}): Promise<{ bytes: Buffer; extension: string }> {
	const res = await p.fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(p.voice)}`, {
		method: "POST",
		headers: { "xi-api-key": p.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
		body: JSON.stringify({ text: p.text, model_id: p.model }),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	return { bytes: Buffer.from(await res.arrayBuffer()), extension: "mp3" };
}

async function synthesizeGoogle(p: {
	fetchFn: typeof fetch;
	apiKey: string;
	model: string;
	voice: string;
	text: string;
	signal?: AbortSignal;
}): Promise<{ bytes: Buffer; extension: string }> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(p.apiKey)}`;
	const res = await p.fetchFn(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: p.text }] }],
			generationConfig: {
				responseModalities: ["AUDIO"],
				speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice } } },
			},
		}),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const body = (await res.json()) as {
		candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
	};
	const part = body.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data);
	const data = part?.inlineData?.data;
	if (!data) throw new Error("Gemini returned no audio data.");
	const pcm = Buffer.from(data, "base64");
	// Gemini TTS returns raw 16-bit PCM (mimeType like "audio/L16;codec=pcm;rate=24000").
	const rate = parseInt(/rate=(\d+)/.exec(part?.inlineData?.mimeType ?? "")?.[1] ?? "24000", 10) || 24000;
	return { bytes: wrapPcmAsWav(pcm, rate), extension: "wav" };
}

async function synthesizeMiniMax(p: {
	fetchFn: typeof fetch;
	apiKey: string;
	model: string;
	voice: string;
	text: string;
	signal?: AbortSignal;
}): Promise<{ bytes: Buffer; extension: string }> {
	const res = await p.fetchFn("https://api.minimax.io/v1/t2a_v2", {
		method: "POST",
		headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: p.model,
			text: p.text,
			voice_setting: { voice_id: p.voice, speed: 1.0, vol: 1.0, pitch: 0 },
			audio_setting: { format: "mp3", sample_rate: 32000 },
		}),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const body = (await res.json()) as {
		data?: { audio?: string };
		base_resp?: { status_code?: number; status_msg?: string };
	};
	if (body.base_resp && body.base_resp.status_code !== 0) {
		throw new Error(`MiniMax error ${body.base_resp.status_code}: ${body.base_resp.status_msg ?? ""}`);
	}
	const hex = body.data?.audio;
	if (!hex) throw new Error("MiniMax returned no audio.");
	// MiniMax returns the audio as a hex-encoded string in data.audio.
	return { bytes: Buffer.from(hex, "hex"), extension: "mp3" };
}

async function synthesizeXai(p: {
	fetchFn: typeof fetch;
	apiKey: string;
	voice: string;
	text: string;
	signal?: AbortSignal;
}): Promise<{ bytes: Buffer; extension: string }> {
	const res = await p.fetchFn("https://api.x.ai/v1/tts", {
		method: "POST",
		headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ text: p.text, voice_id: p.voice, language: "en" }),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	return { bytes: Buffer.from(await res.arrayBuffer()), extension: "mp3" };
}

/** Wrap raw 16-bit mono little-endian PCM in a minimal WAV (RIFF) container. */
export function wrapPcmAsWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
	const byteRate = (sampleRate * channels * bitsPerSample) / 8;
	const blockAlign = (channels * bitsPerSample) / 8;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // PCM fmt chunk size
	header.writeUInt16LE(1, 20); // audio format = PCM
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/* ───────────────────────── helpers ───────────────────────── */

function resolveConfiguredModel(provider: SpeechProviderId): string | undefined {
	try {
		const cfg = loadConfig() as { tools?: { speech?: { models?: Record<string, unknown> } } };
		const m = cfg.tools?.speech?.models?.[provider];
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
		: `speech-${stamp}`;
	return `${base}.${extension}`;
}

function fail(
	action: "generate" | "list",
	message: string,
	extra: Partial<GenerateSpeechDetails> = {},
): AgentToolResult<GenerateSpeechDetails> {
	return jsonResult({ action, ok: false, message, ...extra } satisfies GenerateSpeechDetails) as AgentToolResult<GenerateSpeechDetails>;
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
