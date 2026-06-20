import * as fsp from "node:fs/promises";

import type { BrigadeConfig } from "../../config/io.js";
import type { BrigadeExtensionRegistry } from "../extensions/registry.js";
import type { InboundMediaAttachment } from "../extensions/types.js";

/**
 * Build the inbound media note that gets prepended to the turn text.
 *
 * Today every attachment becomes a path stub: `[attached voice → /path]`. For AUDIO/VOICE,
 * if a configured `TranscriptionProvider` is registered, we transcribe the bytes and fold the
 * TRANSCRIPT into the note instead — so the agent reads what was said AND the existing
 * post-turn extraction captures it as memory with the correct origin, automatically. We
 * deliberately do NOT write to FactStore here: routing through the turn text reuses the
 * battle-tested extraction path and keeps zero memory-write logic on the inbound hot path.
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
						/* best-effort — fall through to the path stub below */
					}
				}
			}
			return stub;
		}),
	);
	return lines.join("\n");
}
