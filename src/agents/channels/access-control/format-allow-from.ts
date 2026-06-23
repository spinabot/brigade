/**
 * `formatAllowFrom` — the SHARED display formatter for a channel's allow-from
 * list.
 *
 * The config-backed allowlist itself (read/merge of store + `channels.<id>.
 * allowFrom`) is owned by the access-control engine; this module is ONLY the
 * rendering surface so every place that prints the list — the in-chat
 * `/allowlist list` command AND the `brigade channels allow list` CLI — renders
 * it identically. A channel MAY override the rendering via the optional
 * `ChannelConfigAdapter.formatAllowFrom` hook (e.g. Slack turning `U123` into
 * `@alex`); when it omits the hook, this default is used.
 *
 * Pure + dependency-free: takes the entries (+ optional display options) and
 * returns a ready-to-send string. No I/O, no config reads — the caller resolves
 * the entries first.
 */

/** A single allow-from entry to render: a bare id, or an id paired with a name. */
export type AllowFromEntry =
	| string
	| number
	| {
			/** Stable channel id (WhatsApp E.164, Telegram numeric id, Slack `U…`). */
			id: string | number;
			/** Human-readable display name, when the channel knows one. */
			name?: string;
	};

export interface FormatAllowFromOptions {
	/**
	 * Channel label for the header ("WhatsApp allow-from (3):"). When omitted the
	 * header reads "Allow-from (N):".
	 */
	channelLabel?: string;
	/** Line shown when the list is empty. Defaults to "Allow-from list is empty." */
	emptyText?: string;
	/** Drop the count header entirely and emit only the indented id lines. */
	omitHeader?: boolean;
	/** Per-line indent. Defaults to two spaces (matches the bundled command). */
	indent?: string;
}

/** Normalize one entry to `{ id, name? }`, dropping blank ids. */
function coerceEntry(entry: AllowFromEntry): { id: string; name?: string } | null {
	if (entry == null) return null;
	if (typeof entry === "object") {
		const id = String(entry.id ?? "").trim();
		if (!id) return null;
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		return name ? { id, name } : { id };
	}
	const id = String(entry).trim();
	return id ? { id } : null;
}

/** Render a single entry line: `name (id)` when a name is present, else just `id`. */
function renderEntryLine(entry: { id: string; name?: string }): string {
	return entry.name ? `${entry.name} (${entry.id})` : entry.id;
}

/**
 * Render an allow-from list to a display string.
 *
 *   - Empty list → the `emptyText` line (or the default).
 *   - Non-empty  → a `<label> allow-from (N):` header (unless `omitHeader`)
 *     followed by one indented line per entry. An entry carrying a `name`
 *     renders as `name (id)`; a bare id renders verbatim. Blank/whitespace ids
 *     are dropped.
 *
 * Idempotent + total: never throws, accepts a heterogeneous mix of bare ids and
 * `{ id, name }` objects.
 */
export function formatAllowFrom(
	entries: ReadonlyArray<AllowFromEntry> | null | undefined,
	opts: FormatAllowFromOptions = {},
): string {
	const indent = opts.indent ?? "  ";
	const coerced = (entries ?? [])
		.map(coerceEntry)
		.filter((e): e is { id: string; name?: string } => e !== null);

	if (coerced.length === 0) {
		return opts.emptyText ?? "Allow-from list is empty.";
	}

	const lines = coerced.map((e) => `${indent}${renderEntryLine(e)}`);
	if (opts.omitHeader) {
		return lines.join("\n");
	}
	const header = opts.channelLabel
		? `${opts.channelLabel} allow-from (${coerced.length}):`
		: `Allow-from (${coerced.length}):`;
	return [header, ...lines].join("\n");
}
