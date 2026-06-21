/**
 * Convert markdown-style replies (Brigade agents output this by default) into
 * Telegram's strict HTML message format (`parse_mode: "HTML"`).
 *
 * Telegram's HTML parser accepts ONLY a small tag allow-list — `<b> <i> <u>
 * <s> <code> <pre> <a> <tg-spoiler> <blockquote>` (plus `<pre><code
 * class="language-xx">` for fenced blocks). Everything else must be entity-
 * escaped or Telegram rejects the whole message with `can't parse entities`.
 * Critically, `&`, `<`, `>` in TEXT must be escaped, and `&`, `<`, `>`, `"` in
 * attribute values (the `href`) must be escaped.
 *
 * This is a Brigade-native re-implementation: the reference converter depends on a
 * shared markdown-IR engine Brigade doesn't carry, so the conversion is done
 * here with a small deterministic tokenizer. It models the SHAPE of
 * `whatsapp/format.ts` (markdown in → channel-native formatting out) but emits
 * HTML instead of WhatsApp's sparse markers.
 *
 * Supported conversions:
 *   - Fenced code blocks ```lang … ```  → <pre><code class="language-lang">…</code></pre>
 *   - Inline `code`                      → <code>…</code>
 *   - **bold** / __bold__                → <b>…</b>
 *   - *italic* / _italic_                → <i>…</i>
 *   - ~~strike~~                         → <s>…</s>
 *   - ||spoiler||                        → <tg-spoiler>…</tg-spoiler>
 *   - [label](url)                       → <a href="url">label</a>
 *   - # headings                         → <b>heading</b>
 *   - `-`/`*`/`+` bullets                → •  bullet
 *   - > blockquote lines                 → <blockquote>…</blockquote>
 *   - | pipe | tables |                  → flattened "cell | cell" lines
 *
 * Pure / deterministic — no I/O, no globals.
 */

/** Escape the three characters Telegram requires escaped in HTML text nodes. */
export function escapeTelegramHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an attribute value (adds `"` on top of the text escapes). */
function escapeTelegramHtmlAttr(text: string): string {
	return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

/**
 * Render the INLINE span markup of one already-newline-free text run into
 * Telegram HTML. Order matters: inline code is extracted first (its contents
 * are verbatim and must not be re-scanned for emphasis), then links, then the
 * emphasis markers. Plain text between spans is entity-escaped.
 */
function renderInlineSpans(text: string): string {
	// Tokenize into a flat list of {kind, ...} so we escape text exactly once and
	// never double-process the verbatim interior of a code span / link label.
	const out: string[] = [];
	let i = 0;
	const n = text.length;
	// Accumulate plain text, flushing (escaped) when a span starts.
	let plain = "";
	const flushPlain = () => {
		if (plain) {
			out.push(renderEmphasis(plain));
			plain = "";
		}
	};

	while (i < n) {
		const ch = text[i];
		// Inline code: `…` — interior is verbatim (escaped, no emphasis).
		if (ch === "`") {
			// Find the closing backtick on the same run.
			const close = text.indexOf("`", i + 1);
			if (close !== -1) {
				flushPlain();
				const inner = text.slice(i + 1, close);
				out.push(`<code>${escapeTelegramHtml(inner)}</code>`);
				i = close + 1;
				continue;
			}
		}
		// Markdown link: [label](url)
		if (ch === "[") {
			const link = matchMarkdownLink(text, i);
			if (link) {
				flushPlain();
				// Label may itself contain emphasis; url is attribute-escaped.
				out.push(`<a href="${escapeTelegramHtmlAttr(link.url)}">${renderEmphasis(link.label)}</a>`);
				i = link.end;
				continue;
			}
		}
		plain += ch;
		i += 1;
	}
	flushPlain();
	return out.join("");
}

/** Try to match a `[label](url)` link starting at `start` (the `[`). */
function matchMarkdownLink(text: string, start: number): { label: string; url: string; end: number } | null {
	// Find the matching `]` (no nested brackets supported — rare in agent output).
	const labelEnd = text.indexOf("]", start + 1);
	if (labelEnd === -1) return null;
	if (text[labelEnd + 1] !== "(") return null;
	const urlEnd = text.indexOf(")", labelEnd + 2);
	if (urlEnd === -1) return null;
	const label = text.slice(start + 1, labelEnd);
	const url = text.slice(labelEnd + 2, urlEnd).trim();
	// Only honour http/https/tg/mailto links — anything else stays literal so we
	// never emit an href Telegram will reject (and never linkify a file path).
	if (!/^(https?:\/\/|tg:\/\/|mailto:)/i.test(url)) return null;
	if (!label) return null;
	return { label, url, end: urlEnd + 1 };
}

/**
 * Apply emphasis markers (bold / italic / strike / spoiler) to a plain text run
 * and entity-escape everything else. The interior of each emphasis is itself
 * run through emphasis (so `*_x_*` nests), but the recursion bottoms out on
 * plain text which gets escaped exactly once.
 */
function renderEmphasis(text: string): string {
	// Bold: **x** or __x__  (greedy-safe: non-empty, no marker char inside run).
	// Process longest/most-specific markers first.
	type Rule = { re: RegExp; open: string; close: string };
	const rules: Rule[] = [
		{ re: /\*\*([^*]+?)\*\*/, open: "<b>", close: "</b>" },
		{ re: /__([^_]+?)__/, open: "<b>", close: "</b>" },
		{ re: /~~([^~]+?)~~/, open: "<s>", close: "</s>" },
		{ re: /\|\|([^|]+?)\|\|/, open: "<tg-spoiler>", close: "</tg-spoiler>" },
		// Single-char italics LAST so they don't eat the doubled forms above.
		{ re: /\*([^*\n]+?)\*/, open: "<i>", close: "</i>" },
		{ re: /(?<![A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])/, open: "<i>", close: "</i>" },
	];
	for (const rule of rules) {
		const m = rule.re.exec(text);
		if (m && m.index >= 0) {
			const before = text.slice(0, m.index);
			const inner = m[1] ?? "";
			const after = text.slice(m.index + m[0].length);
			// `before` is plain (escape it), `inner` recurses, `after` recurses.
			return escapeTelegramHtml(before) + rule.open + renderEmphasis(inner) + rule.close + renderEmphasis(after);
		}
	}
	// No markers left — pure text.
	return escapeTelegramHtml(text);
}

/** Render a markdown pipe-table block as flat "cell | cell" HTML lines. */
function renderTableBlock(block: string[]): string {
	const rows: string[] = [];
	for (const row of block) {
		// Drop the separator row (`| --- | :--: |`).
		if (/^\s*\|?[\s|:-]+\|?\s*$/.test(row)) continue;
		const cells = row
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((c) => c.trim())
			.filter(Boolean);
		if (cells.length) rows.push(cells.map((c) => renderInlineSpans(c)).join(" | "));
	}
	return rows.join("\n");
}

/**
 * Convert agent-style markdown into Telegram HTML. Block structure (fences,
 * headings, bullets, blockquotes, tables) is handled line-by-line; inline
 * markup is handled per-line by {@link renderInlineSpans}.
 */
export function markdownToTelegramHtml(markdown: string): string {
	if (!markdown) return "";
	const lines = markdown.split("\n");
	const out: string[] = [];
	let i = 0;
	const n = lines.length;

	while (i < n) {
		const line = lines[i] ?? "";

		// Fenced code block: ```lang … ```
		const fenceOpen = /^\s*```(.*)$/.exec(line);
		if (fenceOpen) {
			const lang = (fenceOpen[1] ?? "").trim();
			const body: string[] = [];
			i += 1;
			let closed = false;
			while (i < n) {
				const inner = lines[i] ?? "";
				if (/^\s*```\s*$/.test(inner)) {
					closed = true;
					i += 1;
					break;
				}
				body.push(inner);
				i += 1;
			}
			void closed; // an unterminated fence still renders what we captured
			const langAttr =
				lang && /^[A-Za-z0-9+#._-]+$/.test(lang) ? ` class="language-${escapeTelegramHtmlAttr(lang)}"` : "";
			out.push(`<pre><code${langAttr}>${escapeTelegramHtml(body.join("\n"))}</code></pre>`);
			continue;
		}

		// Pipe-table block: ≥2 contiguous lines that start+end with `|`.
		if (/^\s*\|.*\|\s*$/.test(line)) {
			const start = i;
			while (i < n && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) i += 1;
			if (i - start >= 2) {
				out.push(renderTableBlock(lines.slice(start, i)));
				continue;
			}
			// A lone pipe line isn't a table — fall through to inline rendering.
			i = start;
		}

		// ATX heading: # … → bold line.
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			out.push(`<b>${renderInlineSpans(heading[2] ?? "")}</b>`);
			i += 1;
			continue;
		}

		// Blockquote: one or more leading `> ` lines collapse into a <blockquote>.
		if (/^\s*>\s?/.test(line)) {
			const quoted: string[] = [];
			while (i < n && /^\s*>\s?/.test(lines[i] ?? "")) {
				quoted.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
				i += 1;
			}
			out.push(`<blockquote>${renderInlineSpans(quoted.join("\n"))}</blockquote>`);
			continue;
		}

		// Bullet list item: -, *, + → "• ".
		const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			out.push(`${bullet[1] ?? ""}• ${renderInlineSpans(bullet[2] ?? "")}`);
			i += 1;
			continue;
		}

		// Plain line — render inline markup + escape.
		out.push(renderInlineSpans(line));
		i += 1;
	}

	return out.join("\n");
}

/**
 * True when the rendered HTML carries no visible content — only whitespace
 * and/or empty tags. Telegram rejects an empty message body, so the send path
 * falls back to plain text (or skips) when this returns true. Mirrors
 * `telegramHtmlIsEmpty` intent: strip tags + entities, check for any non-space.
 */
export function telegramHtmlIsEmpty(html: string): boolean {
	if (!html) return true;
	// Drop tags, then decode the handful of entities we emit, then trim.
	const withoutTags = html.replace(/<[^>]*>/g, "");
	const decoded = withoutTags
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"');
	return decoded.trim().length === 0;
}
