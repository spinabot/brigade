/**
 * `transcribe_audio` tool — speech-to-text (STT), modeled on the proven
 * `generate_speech` self-contained pattern (its mirror image: TTS out → STT in).
 *
 * Why this tool exists
 * --------------------
 * Same reasoning as `generate_speech`: without a first-class tool, "transcribe
 * this recording" / "what does this voice note say" sends the model to raw
 * `curl` against an STT API — the key flows through a shell, the multipart audio
 * upload gets mangled, and the call is dropped. This tool owns the call
 * in-process: stored auth, validated params, a parser that understands each
 * provider's transcript shape, and a path guard so it can't read secrets.
 *
 * It is a READ / understand op (like `analyze_media`), NOT a billed-gating
 * mutation: reads are not privileged, so `ownerOnly` is false. The path guard +
 * allowed-root scoping are the real safety boundary, and they run for EVERY
 * sender — a remote channel sender can never make Brigade transcribe a secret.
 *
 * Providers (auto-selected by which key is configured, preference order):
 *   • groq       — POST /openai/v1/audio/transcriptions (whisper-large-v3-turbo)
 *   • openai     — POST /v1/audio/transcriptions          (whisper-1)
 *   • deepgram   — POST /v1/listen (RAW bytes, not multipart) (nova-3)
 *   • elevenlabs — POST /v1/speech-to-text                 (scribe_v2)
 *   • mistral    — POST /v1/audio/transcriptions          (voxtral-mini-latest)
 *   • xai        — POST /v1/stt                            (no model id)
 * Keys resolve through `resolveMediaProviderKey` (the same credential-store +
 * env path the media-understanding subsystem uses), so transcription works for
 * whichever provider the operator already configured — no bespoke auth.
 *
 * Flow: read audio bytes (URL → fetch; local path → guarded read) → multipart
 * (or raw, for deepgram) POST → the transcript TEXT is returned as `content`,
 * with `details:{ok, provider, model, transcript, chars}`.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Type } from "typebox";

import {
	resolveCacheDir,
	resolveOsCacheDir,
	resolveStateDir,
	DEFAULT_AGENT_ID,
} from "../../config/paths.js";
import { validateOutboundMediaPath } from "../../security/media-path-guard.js";
import { resolveMediaProviderKey } from "../media-understanding/config.js";
import { BrigadeToolInputError, jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

/** Transcription can take a while for long recordings; bound each HTTP call. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Per-request HTTP timeout when FETCHING a URL source's bytes. */
const FETCH_TIMEOUT_MS = 45_000;
/** Hard cap on audio bytes read for ANY source — providers reject huge uploads. */
const MAX_AUDIO_BYTES = 48 * 1024 * 1024; // 48 MiB

type TranscribeProviderId = "groq" | "openai" | "deepgram" | "elevenlabs" | "mistral" | "xai";

/** Preference order when no provider is pinned: first keyed one wins. */
const PROVIDER_PREFERENCE: TranscribeProviderId[] = [
	"groq",
	"openai",
	"deepgram",
	"elevenlabs",
	"mistral",
	"xai",
];

/** Default model id per provider (xai's /v1/stt takes none). */
const DEFAULT_MODEL: Record<TranscribeProviderId, string> = {
	groq: "whisper-large-v3-turbo",
	openai: "whisper-1",
	deepgram: "nova-3",
	elevenlabs: "scribe_v2",
	mistral: "voxtral-mini-latest",
	xai: "",
};

const TranscribeAudioParams = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("transcribe"), Type.Literal("list")], {
			description:
				'Optional: "transcribe" (default) or "list" to see which STT providers are configured.',
		}),
	),
	source: Type.Optional(
		Type.String({
			description:
				"Local file PATH or http(s) URL to an audio file to transcribe (mp3/wav/m4a/ogg/flac/aac/opus/webm). Required for action=transcribe.",
		}),
	),
	provider: Type.Optional(
		Type.Union(
			[
				Type.Literal("groq"),
				Type.Literal("openai"),
				Type.Literal("deepgram"),
				Type.Literal("elevenlabs"),
				Type.Literal("mistral"),
				Type.Literal("xai"),
			],
			{
				description:
					"Optional STT provider override. Default: the first one with a configured key (groq → openai → deepgram → elevenlabs → mistral → xai).",
			},
		),
	),
	model: Type.Optional(
		Type.String({ description: "Optional model override for the chosen provider." }),
	),
	language: Type.Optional(
		Type.String({
			description:
				'Optional spoken-language hint as an ISO code (e.g. "es", "en", "fr"). Improves accuracy for non-English audio; supported by groq/openai/mistral/xai/deepgram.',
		}),
	),
});

interface TranscribeAudioDetails {
	action: "transcribe" | "list";
	provider?: string;
	model?: string;
	transcript?: string;
	chars?: number;
	providers?: string[];
	ok: boolean;
	message?: string;
}

/** Audio bytes plus the inferred mime — what a `readSource` seam returns. */
export interface TranscribeSource {
	bytes: Buffer;
	mime: string;
	/** File extension (no dot) used for the multipart filename hint. */
	extension: string;
}

export interface MakeTranscribeAudioToolOptions {
	/** Caller's agent id — drives which credential store backs the key. */
	agentId?: string;
	/** Workspace dir — an allowed root for local-path reads. */
	workspaceDir?: string;
	/** Process cwd — an allowed root for local-path reads. */
	cwd?: string;
	/**
	 * OWNER local turn (TUI / desktop / the operator's own channel messages):
	 * widen the allowed local-read roots to the operator's HOME dir so a
	 * user-typed absolute path into Downloads / Desktop / Documents resolves.
	 * MUST stay false/undefined for an untrusted remote channel sender. The
	 * media-path guard still refuses secrets / system files even when this is on.
	 */
	ownerLocalAccess?: boolean;
	/** Test seam: replaces global fetch. */
	fetchFn?: typeof fetch;
	/** Test seam: per-provider API-key resolver override. */
	resolveKey?: (provider: TranscribeProviderId) => string;
	/**
	 * Test seam: replace source acquisition (URL fetch / guarded local read) so
	 * tests never touch the filesystem or network. Default reads URL via `fetchFn`
	 * and local paths via the media-path guard + allowed-root scoping.
	 */
	readSource?: (source: string, signal?: AbortSignal) => Promise<TranscribeSource>;
}

export function makeTranscribeAudioTool(
	opts: MakeTranscribeAudioToolOptions = {},
): BrigadeTool<typeof TranscribeAudioParams, TranscribeAudioDetails> {
	const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
	const fetchFn = opts.fetchFn ?? fetch;
	const resolveKey = opts.resolveKey ?? ((p: TranscribeProviderId) => resolveMediaProviderKey(p, agentId));
	const readSource =
		opts.readSource ??
		((source: string, signal?: AbortSignal) =>
			acquireAudio(source, {
				fetchFn,
				maxBytes: MAX_AUDIO_BYTES,
				...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
				...(opts.cwd ? { cwd: opts.cwd } : {}),
				...(opts.ownerLocalAccess ? { ownerLocalAccess: true } : {}),
				...(signal ? { signal } : {}),
			}));

	return {
		name: "transcribe_audio",
		label: "Transcribe Audio",
		displaySummary: "transcribing audio",
		// Read / understand capability — NOT owner-only (like analyze_media). It
		// reads an audio file/URL the operator pointed at and returns the text; it
		// never mutates state. The path guard runs for EVERY sender regardless of
		// owner status, which is the real safety boundary.
		ownerOnly: false,
		description: [
			"Transcribe spoken audio to text (speech-to-text). USE THIS — never call an STT API with bash/curl: the key must not flow through a shell, and the multipart upload is handled here.",
			'action="transcribe" (default): requires `source` (a local audio path or http(s) URL). Returns the transcript TEXT.',
			"Auto-selects the first configured provider (groq → openai → deepgram → elevenlabs → mistral → xai); override with `provider`/`model`/`language`.",
			'action="list": show which STT providers have a configured key.',
		].join(" "),
		parameters: TranscribeAudioParams,
		execute: async (_id, args, signal): Promise<AgentToolResult<TranscribeAudioDetails>> => {
			const action = args.action ?? "transcribe";

			if (action === "list") {
				const providers = PROVIDER_PREFERENCE.filter((p) => resolveKey(p).length > 0);
				return jsonResult({
					action,
					providers,
					ok: true,
					message:
						providers.length > 0
							? `${providers.length} STT provider(s) configured: ${providers.join(", ")}.`
							: "No STT provider configured. Add a Groq, OpenAI, Deepgram, ElevenLabs, Mistral, or xAI key with `brigade onboard`.",
				} satisfies TranscribeAudioDetails) as AgentToolResult<TranscribeAudioDetails>;
			}

			const source = (args.source ?? "").trim();
			if (!source) {
				return fail(action, "`source` is required for action=transcribe (a local audio path or http(s) URL).");
			}

			// Resolve the provider: explicit override (must be keyed) else first keyed.
			let provider: TranscribeProviderId | undefined;
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
					"No STT provider is configured. Add a Groq, OpenAI, Deepgram, ElevenLabs, Mistral, or xAI API key with `brigade onboard` (then this tool auto-selects it).",
				);
			}

			const apiKey = resolveKey(provider);
			const model = args.model?.trim() || DEFAULT_MODEL[provider];

			// Read the audio bytes (URL fetch or guarded local read).
			let audio: TranscribeSource;
			try {
				audio = await readSource(source, signal);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return fail(action, `Could not read the audio source: ${msg}`, { provider, model });
			}
			if (audio.bytes.length === 0) {
				return fail(action, "The audio source is empty (0 bytes).", { provider, model });
			}

			// Transcribe via the chosen provider.
			let transcript: string;
			try {
				transcript = await transcribe({
					provider,
					fetchFn,
					apiKey,
					model,
					audio,
					...(args.language ? { language: args.language.trim() } : {}),
					...(signal ? { signal } : {}),
				});
			} catch (err) {
				return fail(action, `Transcription via ${provider} failed: ${err instanceof Error ? err.message : String(err)}`, {
					provider,
					model,
				});
			}

			const text = transcript.trim();
			if (!text) {
				return fail(action, `${provider} returned an empty transcript (no speech detected?).`, { provider, model });
			}

			return {
				content: [{ type: "text", text }],
				details: {
					action,
					provider,
					model,
					transcript: text,
					chars: text.length,
					ok: true,
				},
			};
		},
	};
}

/* ───────────────────────── provider plumbing ───────────────────────── */

async function transcribe(params: {
	provider: TranscribeProviderId;
	fetchFn: typeof fetch;
	apiKey: string;
	model: string;
	audio: TranscribeSource;
	language?: string;
	signal?: AbortSignal;
}): Promise<string> {
	switch (params.provider) {
		case "groq":
			return transcribeOpenAICompatible(params, "https://api.groq.com/openai/v1/audio/transcriptions");
		case "openai":
			return transcribeOpenAICompatible(params, "https://api.openai.com/v1/audio/transcriptions");
		case "mistral":
			return transcribeOpenAICompatible(params, "https://api.mistral.ai/v1/audio/transcriptions");
		case "xai":
			return transcribeXai(params);
		case "elevenlabs":
			return transcribeElevenLabs(params);
		case "deepgram":
			return transcribeDeepgram(params);
	}
}

/**
 * groq / openai / mistral share the OpenAI-style multipart transcription shape:
 * `FormData{ file, model, response_format:"json", language? }`, Bearer auth,
 * response `{text}`.
 */
async function transcribeOpenAICompatible(
	p: {
		fetchFn: typeof fetch;
		apiKey: string;
		model: string;
		audio: TranscribeSource;
		language?: string;
		signal?: AbortSignal;
	},
	url: string,
): Promise<string> {
	const fd = new FormData();
	fd.append("file", new Blob([p.audio.bytes], { type: p.audio.mime }), `audio.${p.audio.extension}`);
	fd.append("model", p.model);
	fd.append("response_format", "json");
	if (p.language) fd.append("language", p.language);
	const res = await p.fetchFn(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${p.apiKey}` },
		body: fd,
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const body = (await res.json()) as { text?: string };
	return body.text ?? "";
}

/** xAI `/v1/stt` — multipart `{ file, language? }`, Bearer; response `{text}`. */
async function transcribeXai(p: {
	fetchFn: typeof fetch;
	apiKey: string;
	audio: TranscribeSource;
	language?: string;
	signal?: AbortSignal;
}): Promise<string> {
	const fd = new FormData();
	fd.append("file", new Blob([p.audio.bytes], { type: p.audio.mime }), `audio.${p.audio.extension}`);
	if (p.language) fd.append("language", p.language);
	const res = await p.fetchFn("https://api.x.ai/v1/stt", {
		method: "POST",
		headers: { Authorization: `Bearer ${p.apiKey}` },
		body: fd,
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const body = (await res.json()) as { text?: string };
	return body.text ?? "";
}

/** ElevenLabs `/v1/speech-to-text` — multipart `{ file, model_id }`, `xi-api-key`; response `{text}`. */
async function transcribeElevenLabs(p: {
	fetchFn: typeof fetch;
	apiKey: string;
	model: string;
	audio: TranscribeSource;
	signal?: AbortSignal;
}): Promise<string> {
	const fd = new FormData();
	fd.append("file", new Blob([p.audio.bytes], { type: p.audio.mime }), `audio.${p.audio.extension}`);
	fd.append("model_id", p.model);
	const res = await p.fetchFn("https://api.elevenlabs.io/v1/speech-to-text", {
		method: "POST",
		headers: { "xi-api-key": p.apiKey },
		body: fd,
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const body = (await res.json()) as { text?: string };
	return body.text ?? "";
}

/**
 * Deepgram `/v1/listen` — RAW audio bytes (NOT multipart) as the body, with
 * `Authorization: Token <key>` + `Content-Type: <mime>`. Transcript lives at
 * `results.channels[0].alternatives[0].transcript`.
 */
async function transcribeDeepgram(p: {
	fetchFn: typeof fetch;
	apiKey: string;
	audio: TranscribeSource;
	language?: string;
	signal?: AbortSignal;
}): Promise<string> {
	let url = "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true";
	if (p.language) url += `&language=${encodeURIComponent(p.language)}`;
	const res = await p.fetchFn(url, {
		method: "POST",
		headers: { Authorization: `Token ${p.apiKey}`, "Content-Type": p.audio.mime },
		body: new Uint8Array(p.audio.bytes),
		signal: withTimeout(p.signal, REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
	const body = (await res.json()) as {
		results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
	};
	return body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

/* ───────────────────────── source acquisition ───────────────────────── */

/**
 * Read the audio bytes for `source`. A URL is fetched (capped); a local path is
 * read with the SAME safety posture as `analyze_media`:
 *   1. media-path guard (refuse secrets / system files / credential dirs).
 *   2. allowed-root scoping (must be under workspace / cwd / cache / temp /
 *      state media subtree) — refuses arbitrary absolute reads outside roots.
 * Symlinks are resolved first so a benign name can't smuggle a denied target.
 */
async function acquireAudio(
	source: string,
	opts: {
		fetchFn: typeof fetch;
		maxBytes: number;
		workspaceDir?: string;
		cwd?: string;
		ownerLocalAccess?: boolean;
		signal?: AbortSignal;
	},
): Promise<TranscribeSource> {
	const isUrl = /^https?:\/\//i.test(source);
	if (isUrl) {
		const res = await opts.fetchFn(source, {
			method: "GET",
			headers: { accept: "*/*" },
			signal: withTimeout(opts.signal, FETCH_TIMEOUT_MS),
		});
		if (!res.ok) {
			throw new Error(`fetch failed: HTTP ${res.status} for ${source}`);
		}
		const headerMime = res.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
		const full = Buffer.from(await res.arrayBuffer());
		const bytes = full.length > opts.maxBytes ? full.subarray(0, opts.maxBytes) : full;
		const ext = extensionOf(source) || extFromMime(headerMime) || "mp3";
		const mime = headerMime || audioMimeFromExt(ext);
		return { bytes, mime, extension: ext };
	}

	// Local path: guard + allowed-root scoping (mirrors analyze_media).
	const verdict = validateOutboundMediaPath(source);
	if (!verdict.ok) {
		throw new BrigadeToolInputError(verdict.reason ?? "refusing to read that path");
	}
	let resolved: string;
	try {
		resolved = fs.realpathSync(path.resolve(source));
	} catch {
		resolved = path.resolve(source);
	}
	const roots = allowedLocalRoots(opts);
	if (!isInsideAnyRoot(resolved, roots)) {
		throw new BrigadeToolInputError(
			"refusing to read a path outside the allowed roots (workspace / current dir / cache / temp). " +
				"Move the file into the workspace, or pass a URL.",
		);
	}
	let stat: fs.Stats;
	try {
		stat = await fsp.stat(resolved);
	} catch {
		throw new BrigadeToolInputError(`file not found: ${source}`);
	}
	if (!stat.isFile()) throw new BrigadeToolInputError(`not a file: ${source}`);
	if (stat.size === 0) throw new BrigadeToolInputError(`file is empty: ${source}`);
	const full = await fsp.readFile(resolved);
	const bytes = full.length > opts.maxBytes ? full.subarray(0, opts.maxBytes) : full;
	const ext = extensionOf(source) || "mp3";
	return { bytes, mime: audioMimeFromExt(ext), extension: ext };
}

/** Roots a local source path is allowed to live under (workspace, cwd, OS cache/temp, state dir). */
function allowedLocalRoots(opts: { workspaceDir?: string; cwd?: string; ownerLocalAccess?: boolean }): string[] {
	const roots = new Set<string>();
	const add = (p?: string) => {
		if (!p) return;
		try {
			roots.add(path.resolve(p));
		} catch {
			/* ignore */
		}
	};
	add(opts.workspaceDir);
	add(opts.cwd);
	add(resolveCacheDir());
	add(process.env.TMPDIR || process.env.TEMP || process.env.TMP || "");
	try {
		add(os.tmpdir());
	} catch {
		/* ignore */
	}
	// State-dir media subtree: where inbound attachments + generated media land
	// in FILESYSTEM mode — allow it so the model can transcribe a file it just
	// received.
	try {
		add(path.join(resolveStateDir(), "channels"));
		add(path.join(resolveStateDir(), "cache"));
		add(path.join(resolveStateDir(), "captures"));
		add(path.join(resolveStateDir(), "workspace"));
	} catch {
		/* ignore */
	}
	// CONVEX mode relocates inbound channel media to the OS cache dir; cover it
	// (+ the channel subtrees) so "transcribe the voice note I just sent" works.
	// The media-path guard still refuses secrets / system files independently.
	try {
		const osCache = resolveOsCacheDir();
		add(osCache);
		add(path.join(osCache, "channels"));
		add(path.join(osCache, "bluebubbles"));
	} catch {
		/* ignore */
	}
	// macOS Messages Attachments root — inbound iMessage media is surfaced as-is.
	try {
		add(path.join(os.homedir(), "Library", "Messages", "Attachments"));
	} catch {
		/* ignore */
	}
	// OWNER local turns only: widen to the operator's home (Downloads/Desktop/…)
	// so a user-typed absolute path resolves. A remote sender threads
	// ownerLocalAccess:false → this stays off. The path guard still refuses
	// secrets / credential dirs / system files even for the owner.
	if (opts.ownerLocalAccess) {
		try {
			add(os.homedir());
		} catch {
			/* ignore */
		}
	}
	return [...roots].filter((r) => r.length > 0);
}

/** True when `resolved` is inside one of `roots` (path.relative containment, no `..`). */
function isInsideAnyRoot(resolved: string, roots: string[]): boolean {
	for (const root of roots) {
		const rel = path.relative(root, resolved);
		if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
	}
	return false;
}

/* ───────────────────────── helpers ───────────────────────── */

/** Pull a lowercase extension (no dot) from a path or URL pathname. */
export function extensionOf(source: string): string {
	let p = source;
	try {
		if (/^https?:\/\//i.test(source)) p = new URL(source).pathname;
	} catch {
		/* not a URL — treat as a path */
	}
	return path.extname(p).toLowerCase().replace(/^\./, "");
}

/** Audio mime from extension — used when a local audio file has no declared MIME. */
function audioMimeFromExt(ext: string): string {
	switch (ext) {
		case "wav":
			return "audio/wav";
		case "m4a":
			return "audio/mp4";
		case "mp4":
			return "audio/mp4";
		case "aac":
			return "audio/aac";
		case "flac":
			return "audio/flac";
		case "oga":
		case "ogg":
			return "audio/ogg";
		case "opus":
			return "audio/opus";
		case "webm":
			return "audio/webm";
		default:
			return "audio/mpeg";
	}
}

/** Best-effort extension from a content-type (when a URL has no file extension). */
function extFromMime(mime: string | undefined): string | undefined {
	if (!mime) return undefined;
	const m = mime.toLowerCase();
	if (m.includes("wav")) return "wav";
	if (m.includes("mp4") || m.includes("m4a")) return "m4a";
	if (m.includes("aac")) return "aac";
	if (m.includes("flac")) return "flac";
	if (m.includes("ogg")) return "ogg";
	if (m.includes("opus")) return "opus";
	if (m.includes("webm")) return "webm";
	if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
	return undefined;
}

function fail(
	action: "transcribe" | "list",
	message: string,
	extra: Partial<TranscribeAudioDetails> = {},
): AgentToolResult<TranscribeAudioDetails> {
	return jsonResult({ action, ok: false, message, ...extra } satisfies TranscribeAudioDetails) as AgentToolResult<TranscribeAudioDetails>;
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
