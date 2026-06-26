/**
 * Microsoft Edge "Read Aloud" text-to-speech over WebSocket — FREE, no API key.
 *
 * This is the same free endpoint the `node-edge-tts` package uses (the Bing /
 * "Read Aloud" TTS WebSocket). Auth is an embedded TrustedClientToken plus a
 * computed `Sec-MS-GEC` token (a SHA-256 of the current Windows file-time ticks,
 * floored to 5 minutes, concatenated with the token). The socket sends a
 * `speech.config` frame then an `ssml` frame; audio arrives as binary WS frames
 * (after a `Path:audio` header) and the turn ends on a `Path:turn.end` text
 * frame. Returns MP3 bytes.
 *
 * Re-implemented self-contained (no new dependency) over the `ws` package that
 * Brigade already ships for the gateway/TUI.
 */

import crypto from "node:crypto";

import { WebSocket } from "ws";

const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const GEC_VERSION = "1-131.0.2903.86";
const WSS_BASE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const CHROME_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

/** Minimal WebSocket surface edge-tts uses — lets tests inject a fake socket. */
export interface EdgeWebSocketLike {
	on(event: "open" | "message" | "error" | "close", cb: (...args: unknown[]) => void): void;
	send(data: string): void;
	close(): void;
}

export interface EdgeTtsOptions {
	text: string;
	voice: string;
	outputFormat?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Test seam: inject a WebSocket factory instead of opening a real socket. */
	wsFactory?: (url: string, headers: Record<string, string>) => EdgeWebSocketLike;
}

/** Synthesize speech via the free Edge endpoint. Resolves with MP3 bytes. */
export async function synthesizeEdge(opts: EdgeTtsOptions): Promise<Buffer> {
	const outputFormat = opts.outputFormat ?? "audio-24khz-48kbitrate-mono-mp3";
	const url = `${WSS_BASE}?TrustedClientToken=${TRUSTED_TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}`;
	const headers: Record<string, string> = {
		"User-Agent": CHROME_UA,
		Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
		"Accept-Language": "en-US,en;q=0.9",
	};
	const ws: EdgeWebSocketLike = opts.wsFactory
		? opts.wsFactory(url, headers)
		: (new WebSocket(url, { headers }) as unknown as EdgeWebSocketLike);

	return await new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let settled = false;
		const timer = setTimeout(() => fail(new Error("Edge TTS timed out")), opts.timeoutMs ?? 30_000);
		const onAbort = () => fail(new Error("aborted"));
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		};
		function fail(err: Error): void {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		}
		function done(): void {
			if (settled) return;
			settled = true;
			cleanup();
			if (chunks.length === 0) reject(new Error("Edge TTS produced no audio"));
			else resolve(Buffer.concat(chunks));
		}
		ws.on("open", () => {
			ws.send(configFrame(outputFormat));
			ws.send(ssmlFrame(opts.text, opts.voice));
		});
		ws.on("message", (...args: unknown[]) => {
			const data = args[0];
			const isBinary = args[1] === true;
			const buf = Buffer.isBuffer(data)
				? data
				: data instanceof ArrayBuffer
					? Buffer.from(data)
					: Buffer.from(String(data), "utf8");
			if (isBinary) {
				// Binary frame: first 2 bytes = big-endian header length; audio follows.
				if (buf.length < 2) return;
				const headerLen = buf.readUInt16BE(0);
				const header = buf.subarray(2, 2 + headerLen).toString("utf8");
				if (header.includes("Path:audio")) chunks.push(buf.subarray(2 + headerLen));
			} else if (buf.toString("utf8").includes("Path:turn.end")) {
				done();
			}
		});
		ws.on("error", (...args: unknown[]) => {
			const e = args[0];
			fail(e instanceof Error ? e : new Error(String(e)));
		});
		ws.on("close", () => {
			if (!settled) done();
		});
	});
}

/**
 * The `Sec-MS-GEC` auth token: uppercase SHA-256 hex of `${ticks}${TrustedClientToken}`,
 * where `ticks` = Windows file time (100-ns intervals since 1601-01-01) floored to
 * the nearest 5 minutes. BigInt math — the tick count exceeds Number.MAX_SAFE_INTEGER.
 */
export function secMsGec(nowMs: number = Date.now()): string {
	const secondsSince1601 = BigInt(Math.floor(nowMs / 1000) + 11_644_473_600);
	const roundedSeconds = (secondsSince1601 / 300n) * 300n;
	const ticks = roundedSeconds * 10_000_000n;
	return crypto.createHash("sha256").update(`${ticks}${TRUSTED_TOKEN}`).digest("hex").toUpperCase();
}

/** The opening `speech.config` frame carrying the requested output format. */
export function configFrame(outputFormat: string): string {
	const cfg = {
		context: {
			synthesis: {
				audio: {
					metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
					outputFormat,
				},
			},
		},
	};
	return `X-Timestamp:${new Date().toString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(cfg)}`;
}

/** The `ssml` frame carrying the voice + escaped text. */
export function ssmlFrame(text: string, voice: string): string {
	const id = crypto.randomUUID().replace(/-/g, "");
	const ssml =
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
		`<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
	return `X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toString()}Z\r\nPath:ssml\r\n\r\n${ssml}`;
}

/** Minimal XML escaping for SSML text content. */
export function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/'/g, "&apos;")
		.replace(/"/g, "&quot;");
}
