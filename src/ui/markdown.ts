/**
 * Pi-TUI `Markdown` wrapper that normalizes underscored italic spans before
 * the widget's parser sees them.
 *
 * The bug it fixes: Pi-TUI's Markdown parser handles `**bold**` and
 * `*italic*` correctly but renders `_text_` as LITERAL underscores. The
 * CommonMark spec says `_text_` should produce italic when the underscores
 * are at flank boundaries (e.g. `_(pick something you like)_`), but Pi-TUI
 * v0.70.x doesn't follow that path. Without this wrapper, agent replies
 * that quote markdown using underscored emphasis — most visibly the
 * placeholders inside the workspace template files (`_(pick something you
 * like)_`, `_Fill this in._`, etc.) — leak through with raw underscores.
 *
 * Same Pi-TUI version is used by the OpenClaw mirror, which has the same
 * symptom. This is a Brigade-side fix (templates stay untouched, agent
 * outputs aren't post-processed elsewhere — only the renderer is taught to
 * accept both italic flavours).
 *
 * Replacement scope (`normalizeMarkdownItalic`):
 *   - Convert `_X_` to `*X*` ONLY when:
 *       • opening `_` is at start-of-string OR follows whitespace/punctuation
 *       • closing `_` is at end-of-string OR precedes whitespace/punctuation
 *       • span contents have no newlines and no nested underscores
 *   - Skip `snake_case` identifiers (the underscores are between word chars
 *     so the boundary check naturally excludes them).
 *   - Skip URLs that contain underscores (those get caught by the
 *     "preceded-by-`/` or `:`" cases — neither is in our flank set, so the
 *     pattern doesn't fire mid-URL).
 *
 * Drop-in shape: same constructor + setText signature as Pi-TUI's
 * `Markdown`, so callsites can just swap the import line.
 */

import { Markdown as PiMarkdown } from "@mariozechner/pi-tui";
import type { DefaultTextStyle, MarkdownTheme } from "@mariozechner/pi-tui";

/**
 * Convert `_text_` italic markdown into `*text*` so Pi-TUI's parser renders
 * it as italic. Idempotent — running on already-normalized text is a no-op.
 */
export function normalizeMarkdownItalic(text: string): string {
  if (!text || !text.includes("_")) return text;
  // Flank set:
  //   open: start-of-string or whitespace or open-bracket / quote / backtick
  //   close: end-of-string or whitespace or close-bracket / sentence punct / quote
  // Negative lookbehind/ahead for whitespace inside the span keeps tight
  // emphasis (`_X_`) but rejects loose forms (`_ X _`) per CommonMark.
  return text.replace(
    /(^|[\s(\[\{>"'`])_(?!\s)([^_\n]+?)(?<!\s)_(?=$|[\s)\]\}.,!?;:"'`])/g,
    "$1*$2*",
  );
}

/**
 * Brigade's drop-in `Markdown` — same surface as Pi-TUI's, but normalises
 * underscored italics on every text mutation. Use this everywhere the TUI
 * renders user/agent text.
 */
export class Markdown extends PiMarkdown {
  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    defaultTextStyle?: DefaultTextStyle,
  ) {
    super(normalizeMarkdownItalic(text), paddingX, paddingY, theme, defaultTextStyle);
  }

  override setText(text: string): void {
    super.setText(normalizeMarkdownItalic(text));
  }
}
