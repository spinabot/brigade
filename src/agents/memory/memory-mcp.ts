// src/agents/memory/memory-mcp.ts
//
// Tideline Step 23 — the MCP tool surface for memory.
//
// Exposes add / search / context as MCP-style tools backed by the Tideline
// facade. TRANSPORT-AGNOSTIC: each tool is {name, description, inputSchema,
// handler} returning the MCP `CallToolResult` shape, so the same registry
// mounts on any transport — the stdio MCP SDK, or Brigade's plugin HTTP —
// without this module taking a protocol dependency.
//
// PRINCIPAL-BOUND (security): `memoryMcpTools` REQUIRES the connected
// principal's `origin`. Reads are scoped to it (never the whole store — an
// omitted origin would leak the operator's + every channel peer's facts); writes
// are stamped with it as `createdBy`, plus a trust-appropriate `sourceType` so
// the WRITE-GATE engages for non-owner clients (an external MCP client can't
// poison owner-authored memory or recall at owner trust).
//
// DEFANG: search results are run through `sanitizeForPromptLiteral` (strips
// control / bidi / line-separator codepoints), `<`/`>`-escaped, and wrapped in
// an untrusted-data block, so a stored fact can't smuggle markup or instructions
// into the consuming client's context.

import { sanitizeForPromptLiteral, wrapUntrustedDataBlock } from "../../system-prompt/sanitize.js";
import { MEMORY_SEGMENTS, type MemoryRecordOrigin, type MemorySegment, type MemorySourceType } from "./records.js";
import type { Tideline } from "./tideline.js";

export interface McpToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export interface McpTool {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
	handler: (args: Record<string, unknown>) => McpToolResult;
}

export interface MemoryMcpOpts {
	/** The connected principal — REQUIRED. Reads are scoped to it; writes are
	 *  stamped with it. Never omit (an omitted origin = whole-store leak). */
	origin: MemoryRecordOrigin;
	/** Trust of MCP writes. Default: owner → trusted (undefined); any other
	 *  principal → "retrieved_document" so the write-gate + recall trust engage. */
	sourceType?: MemorySourceType;
}

const text = (t: string, isError = false): McpToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
const escapeMarkup = (s: string): string => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The three memory tools backed by `tide`, bound to `opts.origin`. Mount on an
 * MCP transport: list them for `tools/list`, dispatch `tools/call` to the
 * matching tool's `handler`.
 */
export function memoryMcpTools(tide: Tideline, opts: MemoryMcpOpts): McpTool[] {
	const origin = opts.origin;
	const writeSourceType: MemorySourceType | undefined =
		opts.sourceType ?? (origin.kind === "owner" ? undefined : "retrieved_document");

	const renderHits = (hits: Array<{ segment: string; content: string }>): string =>
		wrapUntrustedDataBlock({
			label: "memory",
			text: hits
				.map((h) => {
					// Recall-time content scan FIRST (mirrors tide.context() + auto-recall):
					// a fact carrying an injection/exfil/C2 payload is surfaced as a
					// non-actionable [BLOCKED] line, never its raw text. Markup-escape stays
					// the always-on second layer for everything else.
					const threats = tide.scanThreats(h.content);
					return threats.length > 0
						? `- [${h.segment}] [BLOCKED] this fact matched threat pattern(s): ${threats.join(", ")} — omitted`
						: `- [${h.segment}] ${escapeMarkup(sanitizeForPromptLiteral(h.content))}`;
				})
				.join("\n"),
		});

	return [
		{
			name: "memory_add",
			description: "Store a fact in long-term memory (subject to the write-gate + your principal's trust).",
			inputSchema: {
				type: "object",
				properties: {
					content: { type: "string", description: "the fact to remember" },
					segment: { type: "string", enum: [...MEMORY_SEGMENTS], description: "kind of fact (default: knowledge)" },
				},
				required: ["content"],
			},
			handler: (args) => {
				const content = String(args.content ?? "").trim();
				if (!content) return text("content is required", true);
				const seg = typeof args.segment === "string" && (MEMORY_SEGMENTS as readonly string[]).includes(args.segment)
					? (args.segment as MemorySegment)
					: ("knowledge" as MemorySegment);
				try {
					const rec = tide.add({
						content,
						segment: seg,
						createdBy: origin,
						...(writeSourceType ? { sourceType: writeSourceType } : {}),
					});
					return text(`stored ${rec.memoryId}`);
				} catch (e) {
					return text(`blocked: ${(e as Error).message}`, true);
				}
			},
		},
		{
			name: "memory_search",
			description: "Search YOUR long-term memory; returns ranked facts (scoped to your principal).",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" }, limit: { type: "number", description: "max results (default 8)" } },
				required: ["query"],
			},
			handler: (args) => {
				const query = String(args.query ?? "").trim();
				if (!query) return text("query is required", true);
				const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 8;
				try {
					const hits = tide.recall(query, { limit, markAccessed: false, origin });
					if (hits.length === 0) return text("(no matches)");
					return text(renderHits(hits));
				} catch (e) {
					return text(`error: ${(e as Error).message}`, true);
				}
			},
		},
		{
			name: "memory_context",
			description: "A budgeted memory block for a query, scoped to your principal, ready to drop into a prompt.",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" }, maxChars: { type: "number", description: "budget cap (default 1200)" } },
				required: ["query"],
			},
			handler: (args) => {
				const query = String(args.query ?? "").trim();
				if (!query) return text("query is required", true);
				const maxChars = typeof args.maxChars === "number" && args.maxChars > 0 ? args.maxChars : 1200;
				try {
					const block = tide.context(query, { maxChars, origin });
					return text(block ? wrapUntrustedDataBlock({ label: "memory", text: block }) : "(nothing relevant)");
				} catch (e) {
					return text(`error: ${(e as Error).message}`, true);
				}
			},
		},
	];
}
