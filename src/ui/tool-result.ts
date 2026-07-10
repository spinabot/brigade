/**
 * Summarize a Pi tool-execution result into a short single-line preview for
 * the chat / connect TUIs.
 *
 * Pi's `ToolExecutionEndEvent` carries `result: any` — the shape varies by
 * tool (string for `bash`, object for `read`/`grep`, array of blocks for
 * MCP-style tools). We don't want to dump JSON into the chat; we want
 * something legible after the `✓ tool_name` line.
 *
 * Two render modes:
 *   - SUCCESS — collapse to a 120-char one-line preview ("✓ bash · 7
 *     packages installed"). Tool output is usually long and bulky; the
 *     model already sees the full result, the operator just needs the
 *     gist.
 *   - ERROR (`{ isError: true }` from Pi, or `opts.preserveNewlines`) —
 *     keep newlines + raise the cap to ~800 chars. Refusals from the
 *     exec-gate / exec-approvals refusals carry multi-line instructions
 *     ("blocked: command 'ls' is not on the allowlist. Operator must
 *     run\n  brigade exec allow ...\n…"). A 120-char single-line preview
 *     would chop the magic `brigade exec allow` incantation in half and
 *     leave the operator guessing. The model already self-corrects from
 *     the FULL reason (Pi pipes that into the synthetic tool_result it
 *     sees), so the operator deserves the same fidelity.
 *
 * Renders tool results using Pi-TUI's MarkdownComponent.append for
 * streamed output. Brigade's shorter format trades depth for compactness
 * — a one-line preview keeps the chat scannable, but ERROR results break
 * that rule because their call-to-action lives in the body.
 */
export interface ToolResultSummary {
	/** Preview text. For errors, may contain newlines; for success, single line. */
	preview: string;
	/** Whether the result was non-empty (false → caller may hide entirely) */
	hasContent: boolean;
	/** True when the preview is multi-line (caller should render with line breaks). */
	multiline: boolean;
}

const DEFAULT_MAX_LENGTH = 120;
const ERROR_MAX_LENGTH = 800;

export interface SummarizeOpts {
	maxLength?: number;
	/**
	 * When true, preserve newlines + use the error budget. Set by the TUI
	 * for `isError` tool results. Defaults to false (success render).
	 */
	preserveNewlines?: boolean;
}

export function summarizeToolResult(
	result: unknown,
	opts: SummarizeOpts = {},
): ToolResultSummary {
	const isError = opts.preserveNewlines === true;
	const maxLength = opts.maxLength ?? (isError ? ERROR_MAX_LENGTH : DEFAULT_MAX_LENGTH);

	if (result == null) return { preview: "", hasContent: false, multiline: false };

	let text: string;
	if (typeof result === "string") {
		text = result;
	} else if (Array.isArray(result)) {
		// MCP-style: array of `{ type: "text", text: string }` blocks. Join them.
		const pieces: string[] = [];
		for (const block of result) {
			if (block && typeof block === "object") {
				const b = block as Record<string, unknown>;
				if (typeof b.text === "string") pieces.push(b.text);
				else if (typeof b.content === "string") pieces.push(b.content);
			} else if (typeof block === "string") {
				pieces.push(block);
			}
		}
		text = pieces.join("\n");
	} else if (typeof result === "object") {
		// Pi's `AgentToolResult` shape — `content: (TextContent | ImageContent)[]` —
		// is the canonical envelope every Brigade-native tool returns. We have to
		// peel it FIRST: a previous version of this code only handled `content`
		// as a plain string, so the array shape fell through to `JSON.stringify`
		// and the operator saw `{"content":[{"type":"text","text":"..."}]}`
		// dumped verbatim in the TUI tool-result preview. Iterate the array,
		// keep only the `type === "text"` blocks, concatenate their `text`.
		const r = result as Record<string, unknown>;
		if (Array.isArray(r.content)) {
			const pieces: string[] = [];
			for (const block of r.content) {
				if (block && typeof block === "object") {
					const b = block as Record<string, unknown>;
					if (b.type === "text" && typeof b.text === "string") pieces.push(b.text);
					else if (b.type === "image" && typeof b.mimeType === "string") {
						pieces.push(`[image ${b.mimeType}]`);
					}
				} else if (typeof block === "string") {
					pieces.push(block);
				}
			}
			text = pieces.join("\n");
		} else if (typeof r.content === "string") text = r.content;
		else if (typeof r.output === "string") text = r.output;
		else if (typeof r.text === "string") text = r.text;
		else if (typeof r.message === "string") text = r.message;
		else {
			try {
				text = JSON.stringify(result);
			} catch {
				text = String(result);
			}
		}
	} else {
		text = String(result);
	}

	if (isError) {
		// Trim leading/trailing whitespace but preserve internal newlines
		// + indentation so the "brigade exec allow ..." line stays
		// visually aligned in the rendered block.
		const trimmed = text.replace(/^\s+|\s+$/g, "");
		if (!trimmed) return { preview: "", hasContent: false, multiline: false };
		const sliced = trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`;
		return {
			preview: sliced,
			hasContent: true,
			multiline: sliced.includes("\n"),
		};
	}

	// Success path: one line, beside the ✓ chip.
	//
	// Collapse only the FIRST PARAGRAPH, not the whole result. A blank line means the
	// tool returned prose — a `spawn_agent` reply, a `read` of a document — and
	// collapsing all of it produced a 119-character mash running through the middle of
	// a sentence two paragraphs down. The first paragraph is the gist; past it is noise
	// in a one-line chip.
	//
	// Output-shaped results (bash, grep, ls) carry no blank line, so they collapse
	// exactly as before. A result that OPENS with blank lines falls back to the whole
	// text rather than previewing nothing.
	const firstParagraph = text.split(/\n[ \t]*\n/, 1)[0] ?? "";
	const collapsed = (firstParagraph.trim() ? firstParagraph : text).replace(/\s+/g, " ").trim();
	if (!collapsed) return { preview: "", hasContent: false, multiline: false };

	if (collapsed.length <= maxLength) {
		return { preview: collapsed, hasContent: true, multiline: false };
	}
	return { preview: `${collapsed.slice(0, maxLength - 1)}…`, hasContent: true, multiline: false };
}
