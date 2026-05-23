/**
 * Convert markdown-style replies (Brigade agents output this by default) into
 * WhatsApp's own sparse formatting. WhatsApp recognises only:
 *   - `*bold*` (single asterisk)
 *   - `_italic_` (single underscore)
 *   - `~strikethrough~` (single tilde)
 *   - `` `inline code` `` and triple-backtick fenced blocks (already markdown)
 *
 * Anything else (`**bold**`, `__italic__`, headings, tables, links) leaks raw
 * into the chat and makes the bot look amateurish. This module rewrites the
 * common cases. Pure / deterministic.
 */

/** Convert agent-style markdown into WhatsApp-renderable form. */
export function markdownToWhatsApp(text: string): string {
	if (!text) return text;
	let out = text;

	// `**bold**` → `*bold*`  (double-asterisk is markdown convention)
	out = out.replace(/\*\*([^*]+)\*\*/g, "*$1*");
	// `__italic__` → `_italic_`
	out = out.replace(/__([^_]+)__/g, "_$1_");
	// Strip ATX headings (#, ##, ###…) and bold-emphasise the line instead.
	out = out.replace(/^(#{1,6})\s+(.+?)\s*$/gm, (_m, _h, rest) => `*${rest}*`);
	// Convert markdown links `[label](url)` → `label (url)` (no link rendering).
	out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)");
	// Bulleted lists: `-` or `*` at line start → `•`
	out = out.replace(/^[\t ]*[-*][\t ]+/gm, "• ");
	// Tables → flatten cells to "col | col | col" (header + body rows).
	out = flattenMarkdownTables(out);
	return out;
}

/** Render a markdown pipe-table as line-by-line plain text. */
function flattenMarkdownTables(text: string): string {
	// A table is a run of ≥2 lines where every line starts and ends with `|`.
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const start = i;
		// Detect a contiguous table block.
		while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) i++;
		if (i - start >= 2) {
			const block = lines.slice(start, i);
			// Drop the separator row (`| --- | --- |`).
			for (const row of block) {
				if (/^\s*\|?[\s|:-]+\|?\s*$/.test(row)) continue;
				const cells = row
					.trim()
					.replace(/^\||\|$/g, "")
					.split("|")
					.map((c) => c.trim())
					.filter(Boolean);
				if (cells.length) out.push(cells.join(" | "));
			}
		} else {
			out.push(lines[start] ?? "");
			i = start + 1;
		}
	}
	return out.join("\n");
}
