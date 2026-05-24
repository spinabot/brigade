/**
 * npm registry search provider — keyless.
 *
 * Endpoint: `https://registry.npmjs.org/-/v1/search`. Returns top-level
 * package metadata + popularity / quality / maintenance scores. No auth.
 *
 * Operator config (`tools.web.search.providers.npm`):
 *   { quality?, popularity?, maintenance? }   // weights (0-1) the API
 *                                              // uses to rank.
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
	wrapSearchHit,
} from "./web-provider-helpers.js";

interface NpmConfig {
	quality?: number;
	popularity?: number;
	maintenance?: number;
}

interface NpmObject {
	package?: {
		name?: unknown;
		version?: unknown;
		description?: unknown;
		date?: unknown;
		links?: { npm?: unknown; homepage?: unknown };
	};
	score?: { final?: unknown };
}

interface NpmResponse {
	objects?: NpmObject[];
}

function createNpmSearchProvider(): WebSearchProvider {
	return {
		id: "npm",
		label: "npm registry",
		hint: "Search the public npm registry. Keyless. Ideal for finding packages by name/keyword.",
		requiresCredential: false,
		envVars: [],
		signupUrl: "https://www.npmjs.com",
		docsUrl: "https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md#get-v1search",
		autoDetectOrder: 175,
		isConfigured: () => true,
		createTool(ctx: WebProviderContext): WebProviderToolDefinition {
			const cfgSlot = readProviderConfigSlot<NpmConfig>({
				cfg: ctx.config,
				providerId: "npm",
				kind: "search",
			});
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "npm registry search. Returns package name + version + description + npm URL.",
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
					if (!query) throw new Error("npm: missing query");
					const size = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						25,
					);
					const url = new URL("https://registry.npmjs.org/-/v1/search");
					url.searchParams.set("text", query);
					url.searchParams.set("size", String(size));
					if (typeof cfgSlot.quality === "number") {
						url.searchParams.set("quality", String(cfgSlot.quality));
					}
					if (typeof cfgSlot.popularity === "number") {
						url.searchParams.set("popularity", String(cfgSlot.popularity));
					}
					if (typeof cfgSlot.maintenance === "number") {
						url.searchParams.set("maintenance", String(cfgSlot.maintenance));
					}

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(url.toString(), {
							method: "GET",
							headers: { accept: "application/json" },
							signal: combined,
						});
						const { text: body } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							const safe = body.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`npm: HTTP ${response.status} — ${safe}`);
						}
						const data = (() => {
							try {
								return JSON.parse(body) as NpmResponse;
							} catch {
								throw new Error("npm: invalid JSON from upstream");
							}
						})();
						const objects = Array.isArray(data.objects) ? data.objects : [];
						const results = objects
							.map((o) => {
								const p = o.package;
								if (!p) return null;
								const name = typeof p.name === "string" ? p.name : "";
								const version = typeof p.version === "string" ? p.version : "";
								const description = typeof p.description === "string" ? p.description : "";
								const npmUrl = typeof p.links?.npm === "string"
									? p.links.npm
									: name
										? `https://www.npmjs.com/package/${name}`
										: "";
								if (!name || !npmUrl) return null;
								const finalScore = typeof o.score?.final === "number" ? o.score.final : undefined;
								return wrapSearchHit({
									title: version ? `${name}@${version}` : name,
									url: npmUrl,
									snippet: description || undefined,
									siteName: "npmjs.com",
									published: typeof p.date === "string" ? p.date : undefined,
									score: finalScore,
								});
							})
							.filter((r): r is NonNullable<typeof r> => r !== null);
						return { provider: "npm", results };
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

export const npmSearchModule = defineModule({
	id: "npm-search",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createNpmSearchProvider());
	},
});

export { createNpmSearchProvider };
