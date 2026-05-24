/**
 * arXiv search provider — keyless, no rate limit beyond standard fair-use.
 *
 * Endpoint: `https://export.arxiv.org/api/query`. Returns Atom XML.
 * Ideal for research-paper / preprint queries (ML / physics / math / CS).
 *
 * Operator config (`tools.web.search.providers.arxiv`):
 *   { sortBy?, sortOrder? }
 *     sortBy: 'relevance' | 'lastUpdatedDate' | 'submittedDate'
 *     sortOrder: 'ascending' | 'descending'
 */

import { defineModule } from "../types.js";
import type {
	BrigadeExtensionContext,
	WebProviderContext,
	WebProviderToolDefinition,
	WebSearchProvider,
} from "../types.js";
import { DEFAULT_TIMEOUT_SECONDS, readResponseText } from "../../tools/web-shared.js";
import {
	readProviderConfigSlot,
	resolveSiteName,
	wrapSearchHit,
} from "./web-provider-helpers.js";

interface ArxivConfig {
	sortBy?: "relevance" | "lastUpdatedDate" | "submittedDate";
	sortOrder?: "ascending" | "descending";
}

const ARXIV_ENDPOINT = "https://export.arxiv.org/api/query";

/**
 * Parse arXiv's Atom XML. The schema is well-known + stable so we use a
 * regex-based extractor rather than pulling in an XML parser. For each
 * `<entry>` block we pull title / link / summary / published / authors.
 */
function parseArxivAtom(xml: string, max: number): Array<{
	title: string;
	url: string;
	snippet?: string;
	authors?: string;
	published?: string;
}> {
	const out: Array<{ title: string; url: string; snippet?: string; authors?: string; published?: string }> = [];
	const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
	let m: RegExpExecArray | null;
	while ((m = entryRe.exec(xml)) !== null && out.length < max) {
		const block = m[1] ?? "";
		const title = (block.match(/<title>([\s\S]*?)<\/title>/) ?? [, ""])[1]?.trim().replace(/\s+/g, " ") ?? "";
		// arXiv puts the abstract URL in a <link href="..."/> with rel="alternate".
		const linkMatch = block.match(/<link\b[^>]*?href="([^"]+)"[^>]*?rel="alternate"/)
			?? block.match(/<id>([\s\S]*?)<\/id>/);
		const url = (linkMatch ? linkMatch[1] : "")?.trim() ?? "";
		const summary = (block.match(/<summary>([\s\S]*?)<\/summary>/) ?? [, ""])[1]
			?.trim()
			.replace(/\s+/g, " ");
		const published = (block.match(/<published>([\s\S]*?)<\/published>/) ?? [, ""])[1]?.trim();
		// Author names — list them comma-separated for the snippet.
		const authors: string[] = [];
		const authorRe = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
		let am: RegExpExecArray | null;
		while ((am = authorRe.exec(block)) !== null) {
			const n = (am[1] ?? "").trim().replace(/\s+/g, " ");
			if (n) authors.push(n);
		}
		if (!title || !url) continue;
		out.push({
			title,
			url,
			snippet: summary ? summary.slice(0, 600) : undefined,
			authors: authors.length > 0 ? authors.join(", ") : undefined,
			published: published || undefined,
		});
	}
	return out;
}

function createArxivSearchProvider(): WebSearchProvider {
	return {
		id: "arxiv",
		label: "arXiv",
		hint: "arXiv research-paper search. Keyless. Best for ML / physics / math / CS preprints.",
		requiresCredential: false,
		envVars: [],
		signupUrl: "https://arxiv.org",
		docsUrl: "https://info.arxiv.org/help/api/index.html",
		autoDetectOrder: 165,
		isConfigured: () => true,
		createTool(ctx: WebProviderContext): WebProviderToolDefinition {
			const cfgSlot = readProviderConfigSlot<ArxivConfig>({
				cfg: ctx.config,
				providerId: "arxiv",
				kind: "search",
			});
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "arXiv research-paper search. Returns paper titles + abstract URLs + authors + summary.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						count: { type: "integer", minimum: 1, maximum: 25 },
					},
					required: ["query"],
				},
				async execute(args, signal) {
					const query = String((args as { query?: unknown }).query ?? "").trim();
					if (!query) throw new Error("arxiv: missing query");
					const max_results = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						25,
					);
					const url = new URL(ARXIV_ENDPOINT);
					url.searchParams.set("search_query", `all:${query}`);
					url.searchParams.set("start", "0");
					url.searchParams.set("max_results", String(max_results));
					if (cfgSlot.sortBy) url.searchParams.set("sortBy", cfgSlot.sortBy);
					if (cfgSlot.sortOrder) url.searchParams.set("sortOrder", cfgSlot.sortOrder);

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(url.toString(), {
							method: "GET",
							headers: { accept: "application/atom+xml" },
							signal: combined,
						});
						const { text: xml } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							const safe = xml.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`arxiv: HTTP ${response.status} — ${safe}`);
						}
						const entries = parseArxivAtom(xml, max_results);
						const results = entries.map((e) => {
							// Embed authors into snippet so the model sees them
							// even though the schema only has `snippet`.
							const snippet = e.authors
								? `${e.authors}\n\n${e.snippet ?? ""}`.trim()
								: e.snippet;
							return wrapSearchHit({
								title: e.title,
								url: e.url,
								snippet: snippet || undefined,
								siteName: resolveSiteName(e.url),
								published: e.published,
							});
						});
						return { provider: "arxiv", results };
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
	};
}

function mergeSignals(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
	const real = signals.filter((s): s is AbortSignal => s !== undefined);
	if (real.length === 0) return undefined;
	if (real.length === 1) return real[0];
	const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFn === "function") return anyFn.call(AbortSignal, real);
	const ctl = new AbortController();
	for (const s of real) {
		if (s.aborted) {
			ctl.abort(s.reason);
			break;
		}
		s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
	}
	return ctl.signal;
}

export const arxivModule = defineModule({
	id: "arxiv",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createArxivSearchProvider());
	},
});

export { createArxivSearchProvider, parseArxivAtom };
