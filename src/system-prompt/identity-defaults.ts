/**
 * IDENTITY.md runtime defaults.
 *
 * A 3-tier identity-resolution + placeholder-detection pattern: the file on
 * disk stays untouched, but at the moment we LOAD it for system-prompt
 * injection we substitute a sensible default for any field still holding a
 * template placeholder.
 *
 * The most user-visible case is the Name field. Until the user personalises
 * IDENTITY.md, the template ships with `_(pick something you like)_` (the
 * v0.1.3 placeholder). Without this substitution the agent reads that
 * placeholder verbatim out of the system prompt and echoes it back into
 * chat ("hi! _(pick something you like)_..."). Replacing the placeholder
 * with `Brigade` at load time gives the agent a stable name from boot.
 *
 * Scope (intentionally narrow):
 *   - ONLY the Name field gets a default substitution. Other fields
 *     (Creature, Vibe, Emoji, Avatar) stay as their template placeholders.
 *     Brigade injects raw markdown rather than filtering placeholders at
 *     parse time, so leaving the placeholder text is the safer floor.
 *   - The user's on-disk IDENTITY.md is NEVER modified. We only return a
 *     normalised in-memory copy.
 *   - `extractIdentityName` is the single source of truth for "is the name
 *     personalised yet?" — the substitution kicks in iff that returns
 *     undefined.
 *
 * Per-channel markdown gate (FIX 9):
 *   The "Brigade injects raw markdown" floor above is true for persona files
 *   AND for the model's OWN reply formatting — historically Brigade has never
 *   told the model to suppress markdown, so on a plain-text surface (an SMS
 *   gateway, a webhook that shows literal `**bold**`) the user would see raw
 *   markup. `resolveOutputFormattingDirective` closes that gap: it consults
 *   the channel's declared `meta.markdownCapable` (via the channel-meta
 *   registry) and returns a "plain text, no markdown" directive ONLY for a
 *   channel that explicitly opted out (`markdownCapable: false`). For every
 *   other channel — markdown-capable, unknown, or meta-less — it returns
 *   `undefined`, so the assembler emits NOTHING and the historical
 *   markdown-on behavior is preserved unchanged (no regression).
 */

import { isMarkdownCapableMessageChannel } from "../agents/channels/markdown-capability.js";
import { extractIdentityName } from "../core/system-prompt.js";

/**
 * The string the agent uses for itself before the user picks a name. Surfaces
 * in: the chat label, the system-prompt injection of IDENTITY.md, the gateway
 * state snapshot.
 */
export const DEFAULT_AGENT_NAME = "Brigade";

/**
 * Return a copy of `identityMarkdown` with the Name field filled in with
 * `defaultName` if the file still holds a placeholder. Idempotent — running
 * on already-personalised content is a no-op.
 *
 * Implementation note: we don't try to be clever with regex substitution
 * inside the existing line. Instead we rebuild the Name line cleanly:
 *
 *   - Find the `- **Name:** ...` line via the same anchor `extractIdentityName`
 *     uses, so behaviour is symmetric across detection and substitution.
 *   - If the value (inline or on the following non-blank line) is empty or a
 *     placeholder, replace the original line with `- **Name:** <defaultName>`
 *     and drop the trailing placeholder line if present.
 *   - Preserve the original list-bullet character (`-` vs `*`) so the
 *     diff against the source template stays minimal.
 */
export function applyIdentityDefaults(
  identityMarkdown: string,
  defaultName: string = DEFAULT_AGENT_NAME,
): string {
  if (!identityMarkdown || identityMarkdown.trim().length === 0) {
    return identityMarkdown;
  }

  // Already personalised — extractIdentityName returns the chosen name.
  if (extractIdentityName(identityMarkdown) !== undefined) {
    return identityMarkdown;
  }

  const lines = identityMarkdown.split(/\r?\n/);
  const nameLineMatcher = /^(\s*)([-*]?)(\s*)\*\*\s*Name\s*:\s*\*\*(.*)$/i;

  let nameLineIdx = -1;
  let leadingWhitespace = "";
  let bullet = "-";
  let bulletGap = " ";
  let inlineValue = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(nameLineMatcher);
    if (m) {
      nameLineIdx = i;
      leadingWhitespace = m[1] ?? "";
      bullet = (m[2] ?? "").length > 0 ? m[2]! : "-";
      bulletGap = (m[3] ?? "").length > 0 ? m[3]! : " ";
      inlineValue = (m[4] ?? "").trim();
      break;
    }
  }

  // No Name line at all — nothing to do. (We could prepend one, but a
  // file without a Name line was hand-edited; honour that intent.)
  if (nameLineIdx === -1) return identityMarkdown;

  // Compose the canonical replacement line. We use `- **Name:** <value>`
  // shape — matches the template's inline form and round-trips cleanly
  // through extractIdentityName + isIdentityNameUnset.
  const newNameLine = `${leadingWhitespace}${bullet}${bulletGap}**Name:** ${defaultName}`;

  // Walk forward from the Name line to figure out whether the placeholder
  // value lives on the next line (the v0.1.3 template form) — if so we
  // remove that line so the inline value isn't shadowed.
  if (inlineValue.length === 0) {
    for (let j = nameLineIdx + 1; j < lines.length; j++) {
      const next = (lines[j] ?? "").trim();
      if (next.length === 0) continue;
      // Placeholder shapes: `_(text)_`, `*(text)*`, or just `(text)`.
      if (/^[*_]?\([^)]*\)[*_]?$/.test(next)) {
        lines[nameLineIdx] = newNameLine;
        lines.splice(j, 1);
        return lines.join("\n");
      }
      // Hit another field / heading / divider before any value — the file
      // genuinely has no Name. Insert the default inline and stop.
      if (/^[-*]?\s*\*\*[^*]+:\*\*/.test(next) || /^---+$/.test(next) || /^#/.test(next)) {
        lines[nameLineIdx] = newNameLine;
        return lines.join("\n");
      }
      // Otherwise the next line IS the user's name — we shouldn't be here
      // because extractIdentityName would have detected it. Defensive
      // no-op so we never overwrite a user-typed value.
      return identityMarkdown;
    }
    // EOF after the Name line — empty value, install default.
    lines[nameLineIdx] = newNameLine;
    return lines.join("\n");
  }

  // Inline value is a placeholder (extractIdentityName returned undefined,
  // so we know the value didn't pass detection). Rewrite the line.
  lines[nameLineIdx] = newNameLine;
  return lines.join("\n");
}

/**
 * The `## Output Formatting` directive injected for a PLAIN-TEXT channel.
 *
 * Mirrors the kind of fence/markdown guidance the assembler used to ship
 * always-on, but FLIPPED: this tells the model to drop markdown entirely
 * because the destination channel renders raw markup literally. Kept terse —
 * a few imperative lines the model can absorb without parroting them back.
 */
const PLAIN_TEXT_OUTPUT_DIRECTIVE = [
  "## Output Formatting",
  "This conversation is delivered over a channel that does NOT render markdown — the user sees raw characters.",
  "Reply in PLAIN TEXT. Do not use markdown: no `**bold**`, no `_italics_`, no `#` headings, no backtick code fences, no markdown tables or `-`/`*` bullet syntax.",
  "Convey structure with plain prose, line breaks, and (where a list truly helps) short numbered lines like `1. ...`. Write URLs and code inline as bare text.",
].join("\n");

/**
 * Resolve the per-turn output-formatting directive for a destination channel.
 *
 * Returns the plain-text directive string ONLY when the channel has explicitly
 * declared `markdownCapable: false` (looked up through the channel-meta
 * registry by {@link isMarkdownCapableMessageChannel}). For a markdown-capable
 * channel, an unknown channel, the CLI/TUI, or no channel at all, returns
 * `undefined` — the caller then emits nothing and Brigade's historical
 * markdown-on default is preserved (no regression for existing channels).
 *
 * This is the consumption site the FIX-9 markdown gate was built for: the
 * assembler calls it and pushes the returned block (when present) into the
 * `## Output Formatting` slot.
 */
export function resolveOutputFormattingDirective(
  channelId: string | null | undefined,
): string | undefined {
  if (isMarkdownCapableMessageChannel(channelId)) return undefined;
  return PLAIN_TEXT_OUTPUT_DIRECTIVE;
}
