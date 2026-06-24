/**
 * Convert agent-style markdown (Brigade agents output this by default) into
 * Slack's `mrkdwn` message format.
 *
 * Slack's mrkdwn differs from CommonMark in load-bearing ways:
 *   - **bold** / __bold__  → *bold*       (SINGLE asterisk in Slack)
 *   - *italic* / _italic_  → _italic_      (UNDERSCORE in Slack)
 *   - ~~strike~~           → ~strike~      (SINGLE tilde)
 *   - `code`               → `code`        (same; interior verbatim)
 *   - ```block```          → ```block```   (lang dropped; interior verbatim)
 *   - [label](url)         → <url|label>   (angle-bracket link)
 *   - # heading            → *heading*     (Slack has no headings)
 *   - `-`/`*`/`+` bullet   → •  bullet
 *   - > quote              → > quote       (Slack supports blockquote)
 *   - | pipe | tables |    → flattened "cell | cell" lines
 *
 * `&`, `<`, `>` in TEXT must be escaped (`&amp;` `&lt;` `&gt;`); the link token
 * `<url|label>` uses literal `<` `>` and is emitted AFTER escaping the
 * surrounding text, so it is never double-escaped. Inline code + fenced blocks
 * keep their interior verbatim (escaped once, never re-scanned for emphasis).
 *
 * This is a Brigade-native re-implementation that models the SHAPE of
 * `telegram/format.ts` (markdown in → channel-native formatting out) but emits
 * mrkdwn instead of HTML. Pure / deterministic — no I/O, no globals.
 */

/** Escape the three characters Slack requires escaped in mrkdwn text nodes. */
export function escapeSlackMrkdwn(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Try to match a `[label](url)` link starting at `start` (the `[`). */
function matchMarkdownLink(text: string, start: number): { label: string; url: string; end: number } | null {
	const labelEnd = text.indexOf("]", start + 1);
	if (labelEnd === -1) return null;
	if (text[labelEnd + 1] !== "(") return null;
	const urlEnd = text.indexOf(")", labelEnd + 2);
	if (urlEnd === -1) return null;
	const label = text.slice(start + 1, labelEnd);
	const url = text.slice(labelEnd + 2, urlEnd).trim();
	// Only honour http/https/mailto/tel/slack links — anything else stays literal
	// so we never emit a link token Slack will mangle (and never linkify a path).
	if (!/^(https?:\/\/|mailto:|tel:|slack:\/\/)/i.test(url)) return null;
	if (!label) return null;
	return { label, url, end: urlEnd + 1 };
}

/**
 * Apply emphasis markers to a plain text run and entity-escape everything else,
 * emitting Slack mrkdwn markers. Markdown bold (`**`/`__`) becomes Slack `*`;
 * markdown italic (`*`/`_`) becomes Slack `_`. Bold is processed BEFORE italic
 * so `**x**` is not eaten by the single-asterisk italic rule.
 */
function renderEmphasis(text: string): string {
	type Rule = { re: RegExp; open: string; close: string };
	const rules: Rule[] = [
		{ re: /\*\*([^*]+?)\*\*/, open: "*", close: "*" }, // **bold** → *bold*
		{ re: /__([^_]+?)__/, open: "*", close: "*" }, // __bold__ → *bold*
		{ re: /~~([^~]+?)~~/, open: "~", close: "~" }, // ~~strike~~ → ~strike~
		{ re: /\*([^*\n]+?)\*/, open: "_", close: "_" }, // *italic* → _italic_
		{ re: /(?<![A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])/, open: "_", close: "_" }, // _italic_ → _italic_
	];
	for (const rule of rules) {
		const m = rule.re.exec(text);
		if (m && m.index >= 0) {
			const before = text.slice(0, m.index);
			const inner = m[1] ?? "";
			const after = text.slice(m.index + m[0].length);
			return escapeSlackMrkdwn(before) + rule.open + renderEmphasis(inner) + rule.close + renderEmphasis(after);
		}
	}
	return escapeSlackMrkdwn(text);
}

/**
 * Render the INLINE span markup of one already-newline-free run into Slack
 * mrkdwn. Inline code is extracted first (verbatim interior), then links, then
 * emphasis. Plain text between spans is entity-escaped exactly once.
 */
function renderInlineSpans(text: string): string {
	const out: string[] = [];
	let i = 0;
	const n = text.length;
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
			const close = text.indexOf("`", i + 1);
			if (close !== -1) {
				flushPlain();
				out.push(`\`${escapeSlackMrkdwn(text.slice(i + 1, close))}\``);
				i = close + 1;
				continue;
			}
		}
		// Markdown link: [label](url) → <url|label>
		if (ch === "[") {
			const link = matchMarkdownLink(text, i);
			if (link) {
				flushPlain();
				out.push(`<${link.url}|${escapeSlackMrkdwn(link.label)}>`);
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

/** Render a markdown pipe-table block as flat "cell | cell" mrkdwn lines. */
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
 * Convert agent-style markdown into Slack mrkdwn. Block structure (fences,
 * headings, bullets, blockquotes, tables) is handled line-by-line; inline
 * markup is handled per-line by {@link renderInlineSpans}.
 */
export function markdownToSlackMrkdwn(markdown: string): string {
	if (!markdown) return "";
	const lines = markdown.split("\n");
	const out: string[] = [];
	let i = 0;
	const n = lines.length;

	while (i < n) {
		const line = lines[i] ?? "";

		// Fenced code block: ```lang … ``` → ``` … ``` (lang dropped, interior escaped).
		const fenceOpen = /^\s*```(.*)$/.exec(line);
		if (fenceOpen) {
			const body: string[] = [];
			i += 1;
			while (i < n) {
				const inner = lines[i] ?? "";
				if (/^\s*```\s*$/.test(inner)) {
					i += 1;
					break;
				}
				body.push(inner);
				i += 1;
			}
			out.push("```\n" + escapeSlackMrkdwn(body.join("\n")) + "\n```");
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
			i = start;
		}

		// ATX heading: # … → bold line (Slack mrkdwn has no headings).
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			out.push(`*${renderInlineSpans(heading[2] ?? "")}*`);
			i += 1;
			continue;
		}

		// Blockquote: a leading `>` → Slack blockquote line.
		if (/^\s*>\s?/.test(line)) {
			out.push(`> ${renderInlineSpans(line.replace(/^\s*>\s?/, ""))}`);
			i += 1;
			continue;
		}

		// Bullet list item: -, *, + → "•  ".
		const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			out.push(`${bullet[1] ?? ""}•  ${renderInlineSpans(bullet[2] ?? "")}`);
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
 * True when the rendered mrkdwn carries no visible content — only markers,
 * whitespace, and/or empty tokens. Slack rejects an empty message body, so the
 * send path falls back / skips when this returns true. Mirrors
 * `telegramHtmlIsEmpty` intent.
 */
export function slackMrkdwnIsEmpty(mrkdwn: string): boolean {
	if (!mrkdwn) return true;
	const decoded = mrkdwn
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
	const stripped = decoded
		.replace(/<[@#!][^>]+>/g, "x") // user/channel/special mentions ARE content
		.replace(/<[^>|]+\|([^>]*)>/g, "$1") // <url|label> → label (content)
		.replace(/[*_~`>•|]/g, "")
		.trim();
	return stripped.length === 0;
}
