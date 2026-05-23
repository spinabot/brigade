/**
 * Split a long outbound message into WhatsApp-sized chunks WITHOUT shredding
 * code fences, paragraphs, or sentences.
 *
 * WhatsApp's hard limit is ~4096 chars; we target a safe 4000. Splitting
 * strategy, from cheapest to last-resort:
 *   1. If under the limit → one chunk, done.
 *   2. Walk paragraphs (`\n\n` separators) — keep them intact, accumulate into
 *      chunks under the limit. A single oversized paragraph passes to step 3.
 *   3. Walk lines within the paragraph — same accumulation pattern. Single
 *      oversized lines pass to step 4.
 *   4. Hard-split on character boundary at a word break near the limit.
 *
 * Fence-aware: an open code fence (```) inside a chunk is closed at the chunk
 * boundary and re-opened in the next chunk, so each chunk renders as valid
 * markdown.
 *
 * Pure / deterministic — no I/O, no globals.
 */

const DEFAULT_LIMIT = 4000;
const FENCE = "```";

export interface ChunkOptions {
	/** Max characters per chunk; defaults to ~4000 (WhatsApp). */
	limit?: number;
}

/** Split `text` into chunks suitable for one-by-one outbound delivery. */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
	const limit = opts.limit ?? DEFAULT_LIMIT;
	if (text.length <= limit) return [text];

	const chunks: string[] = [];
	let pending = "";
	const flush = () => {
		if (pending) {
			chunks.push(closeOpenFence(pending));
			pending = "";
		}
	};

	// Paragraph-level pass.
	const paragraphs = text.split(/\n\n+/);
	for (let i = 0; i < paragraphs.length; i++) {
		const para = paragraphs[i] as string;
		const sep = pending ? "\n\n" : "";
		if (pending.length + sep.length + para.length <= limit) {
			pending += sep + para;
			continue;
		}
		// Flush whatever fits so far.
		flush();
		// Single paragraph that's still too big → line-level pass.
		if (para.length > limit) {
			for (const piece of splitByLines(para, limit)) chunks.push(closeOpenFence(piece));
		} else {
			pending = para;
		}
	}
	flush();
	return chunks;
}

/** Split a single oversized paragraph by line, packing lines into <=limit chunks. */
function splitByLines(paragraph: string, limit: number): string[] {
	const out: string[] = [];
	const lines = paragraph.split("\n");
	let pending = "";
	for (const line of lines) {
		const sep = pending ? "\n" : "";
		if (pending.length + sep.length + line.length <= limit) {
			pending += sep + line;
			continue;
		}
		if (pending) {
			out.push(pending);
			pending = "";
		}
		// Single oversized line → hard split at a word break.
		if (line.length > limit) {
			for (const piece of hardSplit(line, limit)) out.push(piece);
		} else {
			pending = line;
		}
	}
	if (pending) out.push(pending);
	return out;
}

/** Last resort: split a string at a word boundary near `limit`. */
function hardSplit(s: string, limit: number): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < s.length) {
		if (s.length - i <= limit) {
			out.push(s.slice(i));
			break;
		}
		// Prefer the last whitespace in the window.
		const window = s.slice(i, i + limit);
		const breakAt = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
		const cut = breakAt > limit / 2 ? breakAt : limit;
		out.push(s.slice(i, i + cut));
		i += cut;
		// Skip the consumed whitespace so the next chunk doesn't start with " ".
		while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
	}
	return out;
}

/**
 * If `s` has an odd number of code-fence markers, close the trailing fence so
 * the chunk renders as valid markdown on its own. The next chunk will need to
 * re-open a fence to keep the language tag, but at minimum every chunk parses.
 */
function closeOpenFence(s: string): string {
	// Count occurrences of FENCE that start at line beginnings (the markdown rule).
	let count = 0;
	for (let i = 0; i < s.length - 2; i++) {
		if ((i === 0 || s[i - 1] === "\n") && s.slice(i, i + 3) === FENCE) count++;
	}
	if (count % 2 === 1) return `${s}\n${FENCE}`;
	return s;
}
