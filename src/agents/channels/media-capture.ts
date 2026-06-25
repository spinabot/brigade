import * as fsp from "node:fs/promises";

import type { BrigadeConfig } from "../../config/io.js";
import type { BrigadeExtensionRegistry } from "../extensions/registry.js";
import type { InboundMediaAttachment } from "../extensions/types.js";

/**
 * A decoded inbound image, ready to ride the turn as a Pi `ImageContent` block.
 * `data` is RAW base64 (no `data:` prefix) + `mimeType` — exactly the two fields
 * Pi's `ImageContent` needs (the agent loop adds `type:"image"` at the
 * `session.prompt` boundary). This is the same block shape `analyze_media`
 * returns and `payload-mutators.ts` prunes from history.
 */
export interface InboundImageBlock {
	data: string;
	mimeType: string;
}

/**
 * Per-image byte cap for AUTO-injected inbound images. Matches `analyze_media`'s
 * `DEFAULT_IMAGE_MAX_BYTES` (8 MiB) — image blocks are the most token-expensive
 * payload, and an image over this is dropped from the inline path (the agent
 * still gets the `[attached image → <path>]` note and can call `analyze_media`,
 * which has its own larger ceiling + truncation).
 */
export const INBOUND_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Total byte cap across ALL inline inbound images on a single turn — guards the
 * context window when several photos arrive at once. Once the running total
 * would exceed this, further images are skipped (their notes still carry the
 * path for `analyze_media`).
 */
export const INBOUND_IMAGE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

/** MIME the provider will accept for an inbound image, derived from mime/ext. */
function inboundImageMime(m: InboundMediaAttachment): string {
	const declared = m.mimeType?.split(";")[0]?.trim().toLowerCase();
	if (declared && declared.startsWith("image/")) return declared;
	const ext = (m.path.split(".").pop() ?? "").toLowerCase();
	switch (ext) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "bmp":
			return "image/bmp";
		case "heic":
		case "heif":
			return `image/${ext}`;
		default:
			// Unknown — default to jpeg; most providers sniff the bytes anyway.
			return "image/jpeg";
	}
}

/**
 * Decode inbound IMAGE attachments into Pi `ImageContent`-shaped blocks so the
 * inbound pipeline can inject them inline on a vision-capable turn (A3) — the
 * model SEES the photo with zero tool calls. Non-image kinds are ignored here
 * (they go through the `analyze_media` note path instead).
 *
 * Caps: each image is read fully then dropped if it exceeds the per-image cap;
 * a running total enforces the all-images ceiling. An unreadable file is
 * silently skipped (best-effort — the note stub still carries its path).
 * Non-throwing + pure (no gateway state), so it is unit-testable in isolation.
 *
 * HEIC/HEIF are passed through with their declared mime — most providers reject
 * them, but the decision to drop belongs to the provider, not here (mirrors
 * `analyze_media`); the path-note fallback covers a rejection.
 */
export async function buildInboundImageBlocks(
	media: readonly InboundMediaAttachment[],
	opts?: { perImageMaxBytes?: number; totalMaxBytes?: number },
): Promise<InboundImageBlock[]> {
	const perImageCap = opts?.perImageMaxBytes ?? INBOUND_IMAGE_MAX_BYTES;
	const totalCap = opts?.totalMaxBytes ?? INBOUND_IMAGE_TOTAL_MAX_BYTES;
	const blocks: InboundImageBlock[] = [];
	let total = 0;
	for (const m of media) {
		if (m.kind !== "image") continue;
		let bytes: Buffer;
		try {
			bytes = await fsp.readFile(m.path);
		} catch {
			continue; // unreadable — fall back to the path note for this one
		}
		if (bytes.length === 0 || bytes.length > perImageCap) continue;
		if (total + bytes.length > totalCap) continue;
		total += bytes.length;
		blocks.push({ data: bytes.toString("base64"), mimeType: inboundImageMime(m) });
	}
	return blocks;
}

/**
 * `kind`s whose bytes Pi can carry to the model as a native multimodal block
 * (`ImageContent` — the whole SDK content model is text + image). For these the
 * inbound pipeline injects the bytes inline (A3) and the agent SEES the image
 * with zero tool calls, so the note here stays a bare path stub — no call-to-
 * action — and the model is told (system-prompt MEDIA guidance) that attached
 * images are already visible. The path remains in the note for re-analysis.
 */
function kindIsNativelyVisible(kind: InboundMediaAttachment["kind"]): boolean {
	return kind === "image";
}

/**
 * Build the inbound media note that gets prepended to the turn text.
 *
 * Today every attachment becomes a path stub: `[attached voice → /path]`. Three
 * behaviours layer on top:
 *
 *   - AUDIO/VOICE: if a configured `TranscriptionProvider` is registered, we
 *     transcribe the bytes and fold the TRANSCRIPT into the note instead — so the
 *     agent reads what was said AND the existing post-turn extraction captures it as
 *     memory with the correct origin, automatically. We deliberately do NOT write to
 *     FactStore here: routing through the turn text reuses the battle-tested
 *     extraction path and keeps zero memory-write logic on the inbound hot path.
 *
 *   - NON-IMAGE attachments that have NO inline path to the model (pdf / docx / pptx
 *     / xlsx / html / video, and audio/voice that produced no transcript): the note
 *     carries a CALL-TO-ACTION naming the `analyze_media` tool + the path, so the
 *     agent reliably reaches for the tool instead of treating the bare stub as
 *     content it can't read. (A document/video can NOT become a native content
 *     block — Pi only carries text + image — so the tool is the only path in.)
 *
 *   - IMAGE attachments: left as a bare path stub. The inbound pipeline injects the
 *     image bytes inline as a real multimodal block when the turn model is vision-
 *     capable (A3), so the agent already sees it; the stub just preserves the path
 *     for later re-analysis. (When the model is text-only the bytes are dropped and
 *     the stub is the agent's signal to call `analyze_media` — but we don't know the
 *     model here, so the image note stays generic + the system-prompt guidance
 *     covers both cases.)
 *
 * Best-effort + non-throwing: any read/transcribe failure falls back to the original stub, so
 * a flaky STT provider can never break message ingest. Pure (the registry is passed in — the
 * pipeline supplies `getActiveRegistry()`), so it is unit-testable without gateway boot.
 */
export async function buildMediaNote(
	media: readonly InboundMediaAttachment[],
	opts: { registry?: BrigadeExtensionRegistry; config: BrigadeConfig; env?: NodeJS.ProcessEnv },
): Promise<string> {
	const lines = await Promise.all(
		media.map(async (m) => {
			const caption = m.caption ? `: "${m.caption}"` : "";
			const name = m.fileName ? ` (${m.fileName})` : "";
			const stub = `[attached ${m.kind}${name}${caption} → ${m.path}]`;

			if ((m.kind === "audio" || m.kind === "voice") && opts.registry) {
				const provider = opts.registry.transcriptionProviders.find((p) =>
					p.isConfigured(opts.config, opts.env ?? process.env),
				);
				if (provider) {
					try {
						const bytes = await fsp.readFile(m.path);
						const { text } = await provider.transcribe(
							bytes,
							m.mimeType ? { mimeType: m.mimeType } : undefined,
						);
						const t = text.trim();
						if (t) return `[${m.kind} transcript${name}${caption}: "${t}"]`;
					} catch {
						/* best-effort — fall through to the call-to-action stub below */
					}
				}
			}

			// Images flow to the model inline (A3) — bare stub, no call-to-action.
			if (kindIsNativelyVisible(m.kind)) return stub;

			// Everything else (document / pdf / spreadsheet / video, plus audio/voice
			// with no transcript) can ONLY be read via the tool — embed the
			// instruction so the agent reaches for it instead of stalling on a path
			// it can't open. Note-embedded instruction == the cheap, immediate fix.
			return (
				`[attached ${m.kind}${name}${caption} → ${m.path} — not inlined; ` +
				`call analyze_media with source="${m.path}"${m.caption ? "" : " and a question"} to read it]`
			);
		}),
	);
	return lines.join("\n");
}
