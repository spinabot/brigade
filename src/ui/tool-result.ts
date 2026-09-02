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

/* ─────────────────────────── tool ARGUMENTS ─────────────────────────── */

/** Argument keys that identify what a tool is about to act on, most specific first. */
const ARG_PRIORITY = [
	"command",
	"cmd",
	"path",
	"file_path",
	"filePath",
	"filename",
	"pattern",
	"query",
	"url",
	"prompt",
	"task",
	"agent",
	"agentId",
	"name",
	"key",
	"id",
] as const;

const ARG_MAX_LENGTH = 72;

/**
 * A one-line summary of a tool call's ARGUMENTS, for the `⚡` chip.
 *
 * The chip used to render only the tool name — `⚡ bash`, `⚡ edit` — so the
 * operator could see that something was happening but never WHAT: which command,
 * which file. `tool_execution_start` carries `args` on the wire and the renderer
 * discarded it.
 *
 * Deliberately lossy. This is a glance-able subtitle, not a debug dump: one
 * line, hard-truncated, whitespace collapsed. The full arguments remain in the
 * JSONL event log for anyone who needs them.
 *
 * Returns `undefined` when there is nothing worth showing, so the caller renders
 * the bare tool name rather than an empty pair of brackets.
 */
export function formatToolArgs(args: unknown, maxLength = ARG_MAX_LENGTH): string | undefined {
	if (args === null || args === undefined) return undefined;

	// A bare string argument is already the answer.
	if (typeof args === "string") return condenseArg(args, maxLength);
	if (typeof args !== "object") return condenseArg(String(args), maxLength);

	const obj = args as Record<string, unknown>;

	// Prefer the key that says what is being acted on.
	for (const key of ARG_PRIORITY) {
		const v = obj[key];
		if (typeof v === "string" && v.trim()) return condenseArg(v, maxLength);
		if (typeof v === "number" || typeof v === "boolean") return condenseArg(String(v), maxLength);
	}

	// No known key — fall back to the first short scalar, so a custom tool still
	// says something useful instead of nothing.
	for (const [k, v] of Object.entries(obj)) {
		if (typeof v === "string" && v.trim()) return condenseArg(`${k}=${v}`, maxLength);
		if (typeof v === "number" || typeof v === "boolean") return condenseArg(`${k}=${String(v)}`, maxLength);
	}
	return undefined;
}

/** Collapse to one line, trim, and hard-truncate with an ellipsis. */
function condenseArg(raw: string, maxLength: number): string | undefined {
	const flat = raw.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > maxLength ? `${flat.slice(0, Math.max(1, maxLength - 1))}…` : flat;
}

/* ─────────────────────────── unified diffs ─────────────────────────── */

/**
 * Does this text look like a unified diff?
 *
 * Deliberately conservative — it must not fire on prose that merely starts a
 * line with `-`, which is every markdown bullet list ever written. Requires the
 * structural markers a real diff has: a hunk header (`@@ … @@`), or a
 * `---`/`+++` file-header pair.
 *
 * Backend-agnostic on purpose. Brigade has no file-edit tool of its own — edits
 * come from Pi's built-ins or, on the harness backends, from the vendor binary's
 * own tools — so keying off tool NAMES or argument shapes would silently miss
 * whichever backend the operator is actually running. Recognising the output
 * shape works for all of them.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
	if (!text || text.length < 8) return false;
	if (/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(text)) return true;
	return /^--- .+\n\+\+\+ .+/m.test(text);
}

/** One line of a diff, classified for rendering. */
export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

/** Classify a single diff line. */
export function classifyDiffLine(line: string): DiffLineKind {
	if (line.startsWith("@@")) return "hunk";
	// File headers are `---`/`+++`; check them BEFORE the single-char add/remove
	// tests, or every header reads as a removed/added line.
	if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
		return "meta";
	}
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "remove";
	return "context";
}

/** Added / removed line counts, for a one-line summary like `+12 −3`. */
export function summarizeDiffStats(text: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of text.split("\n")) {
		const kind = classifyDiffLine(line);
		if (kind === "add") added += 1;
		else if (kind === "remove") removed += 1;
	}
	return { added, removed };
}

/* ─────────────────────────── todo / plan lists ─────────────────────────── */

/** One item of a model-authored plan. */
export interface TodoItem {
	text: string;
	status: "pending" | "in_progress" | "completed" | "cancelled" | "unknown";
}

function normalizeTodoStatus(raw: unknown): TodoItem["status"] {
	const v = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s-]/g, "_") : "";
	switch (v) {
		case "pending":
		case "todo":
		case "not_started":
			return "pending";
		case "in_progress":
		case "active":
		case "running":
			return "in_progress";
		case "completed":
		case "done":
		case "complete":
			return "completed";
		case "cancelled":
		case "canceled":
		case "skipped":
			return "cancelled";
		default:
			return "unknown";
	}
}

/**
 * Parse a plan-update tool's arguments into items, or `undefined` when this is
 * not one.
 *
 * Tolerant about the wrapper key and the item shape because the tool is not
 * Brigade's: on the claude-cli backend `TodoWrite` comes from the vendor binary,
 * and other backends spell it differently. Keying off a single hardcoded schema
 * would silently fall back to raw JSON for every provider but one.
 */
export function parseTodoArgs(args: unknown): TodoItem[] | undefined {
	if (!args || typeof args !== "object") return undefined;
	const obj = args as Record<string, unknown>;
	const raw = obj.todos ?? obj.items ?? obj.plan ?? obj.tasks;
	if (!Array.isArray(raw) || raw.length === 0) return undefined;

	const items: TodoItem[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			const t = entry.trim();
			if (t) items.push({ text: t, status: "unknown" });
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const text = [e.content, e.text, e.title, e.task, e.activeForm].find(
			(v): v is string => typeof v === "string" && v.trim().length > 0,
		);
		if (!text) continue;
		items.push({ text: text.trim(), status: normalizeTodoStatus(e.status ?? e.state) });
	}
	return items.length > 0 ? items : undefined;
}

/** `✓` done · `▸` in progress · `✗` cancelled · `○` pending/unknown. */
export function todoMarker(status: TodoItem["status"]): string {
	switch (status) {
		case "completed":
			return "✓";
		case "in_progress":
			return "▸";
		case "cancelled":
			return "✗";
		default:
			return "○";
	}
}

/** `2/5 done` — the one-line progress summary for a collapsed row. */
export function summarizeTodos(items: readonly TodoItem[]): string {
	const done = items.filter((i) => i.status === "completed").length;
	return `${done}/${items.length} done`;
}

/* ─────────────────────── live command output ─────────────────────── */

/** Tools whose output is a running log worth watching rather than a value. */
export function isShellLikeTool(name: string): boolean {
	return /^(bash|sh|shell|exec|run|command|terminal|process)/i.test(name.trim());
}

/**
 * The last `maxLines` of a running command's output, for a live tail pane.
 *
 * A long command's output was collapsed to a single 120-char line that
 * flickered in place, so a four-minute test run showed one truncated row and
 * you could not see which test failed until it finished. Every comparable
 * harness streams this into a bounded pane instead (Codex caps at 50 lines,
 * Gemini and Crush at a similar window).
 *
 * Takes the TAIL, not the head: on a build or a test run the interesting part
 * is always what just happened. Each line is also width-clipped, because one
 * pathological line (a minified bundle, a base64 blob) would otherwise wrap
 * across the whole viewport and push everything else off screen.
 */
export function tailLines(text: string, maxLines = 12, maxCols = 160): string[] {
	if (!text) return [];
	const lines = text.split("\n");
	// Trailing blank lines are an artifact of the stream, not content.
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	const tail = lines.slice(Math.max(0, lines.length - maxLines));
	return tail.map((line) => {
		// Tabs render at unpredictable widths and break the clip arithmetic.
		const flat = line.replace(/\t/g, "  ");
		return flat.length > maxCols ? `${flat.slice(0, maxCols - 1)}…` : flat;
	});
}

/** `1.2k lines` / `84 lines` — the scale of what the tail is a window onto. */
export function describeOutputSize(text: string): string {
	const n = text ? text.split("\n").length : 0;
	if (n < 1000) return `${n} line${n === 1 ? "" : "s"}`;
	return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k lines`;
}
