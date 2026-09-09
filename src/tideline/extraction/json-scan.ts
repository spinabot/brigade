/**
 * Tiny shared helper for pulling JSON objects out of an LLM reply — extracted to its
 * OWN module so both `extract.ts` and `relationship-extract.ts` can use it WITHOUT
 * importing each other (which would form a load-time cycle: extract.ts builds
 * EXTRACTION_PROMPT from relationship-extract.ts's prompt fragment at module top level,
 * so relationship-extract.ts must not depend on extract.ts being initialized first).
 */

/** ALL top-level BALANCED `{...}` objects in `text`, in order (string-aware: braces
 *  inside JSON strings don't count). Replaces a greedy first-to-LAST `{...}` match that
 *  grabbed any trailing brace block AND a single-object scan that let a LEADING stray
 *  object (`{}`, a reasoning artifact) shadow the real `{"facts":[…]}` after it — both
 *  failure modes returned [] and advanced the cursor past un-distilled facts. */
export function balancedObjects(text: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr = false;
	let esc = false;
	let start = -1;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (c === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				out.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return out;
}
