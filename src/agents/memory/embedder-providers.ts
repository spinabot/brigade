/**
 * Embedder PROVIDER registry — the pluggable, lazy, optional, graceful-degrading
 * embedder selection: a registry of adapters, each of which LAZILY creates an
 * embedder or returns `null` to degrade. The heavy local backend
 * (`node-llama-cpp` → `embeddinggemma`) is an OPTIONAL dependency, lazy-imported,
 * never top-level — so the default install never pays for it and air-gap stays
 * intact. When no learned embedder is available (no key, dep not installed),
 * resolution falls back to the zero-dep model-free {@link HrrEmbedder} — recall
 * ALWAYS works, degrading to lexical-only like any robust hybrid engine.
 *
 * The model-free HRR is the always-available floor; this module adds the
 * learned-embedder path on top (a learned model lifts true-synonymy recall).
 *
 * Provider tiers (three transports):
 *   - "model-free" → HrrEmbedder (zero-dep, offline, sync) — the always-available floor.
 *   - "local"      → embeddinggemma via node-llama-cpp (offline, air-gap, async).
 *   - "remote"     → OpenAI text-embedding-3-small @ 256 dims (network, async).
 *
 * DIMS: every adapter emits 256-dim L2-normalised vectors so they're drop-in for
 * the existing convex `by_embedding` vectorIndex (no schema migration) and
 * cosine-comparable with the bundled HRR. The learned models are truncated via
 * Matryoshka (text-embedding-3-small `dimensions:256`; embeddinggemma 768→256)
 * then re-normalised. (NOTE: switching embedder FAMILIES requires re-embedding
 * stored facts — cross-family cosine is meaningless — i.e. re-index on model
 * change. That re-embed pass + async write/recall wiring is the activation step
 * that turns a registered adapter into live recall.)
 */

import { type Embedder, HrrEmbedder } from "./embedder.js";

/** Vectors every adapter emits at this width (matches the convex vectorIndex + HRR). */
export const EMBEDDER_DIMS = 256;

/** L2-normalise (and optionally Matryoshka-truncate) a raw model vector to unit
 *  length at `dims` — so cosine = dot and short/long texts compare fairly. A
 *  near-zero vector maps to all-zeros (cosine() then returns 0). Standard
 *  embedding sanitize-and-normalize. */
export function normalizeTo(raw: readonly number[], dims: number = EMBEDDER_DIMS): number[] {
	const v = raw.length > dims ? raw.slice(0, dims) : raw.slice();
	let mag = 0;
	for (const x of v) mag += (Number.isFinite(x) ? x : 0) ** 2;
	mag = Math.sqrt(mag);
	if (mag < 1e-10) return new Array(v.length).fill(0);
	return v.map((x) => (Number.isFinite(x) ? x : 0) / mag);
}

/**
 * An embedder adapter (a memory-embedding provider adapter): lazily make
 * an {@link Embedder}, or return `null` to gracefully degrade (missing key /
 * uninstalled optional dep). `create` MUST return null — never throw — for a
 * missing-credential / missing-dep case, so resolution can fall through.
 */
export interface EmbedderAdapter {
	readonly id: string;
	readonly transport: "model-free" | "local" | "remote";
	/** Lower = tried first in auto-select; omit to exclude from auto-select. */
	readonly autoSelectPriority?: number;
	create(): Promise<Embedder | null>;
	/** One-line setup hint shown when this adapter was requested but unavailable. */
	formatSetupError?(): string;
}

const registry = new Map<string, EmbedderAdapter>();

export function registerEmbedderAdapter(adapter: EmbedderAdapter): void {
	registry.set(adapter.id, adapter);
}
export function listEmbedderAdapters(): EmbedderAdapter[] {
	return [...registry.values()];
}
export function getEmbedderAdapter(id: string): EmbedderAdapter | undefined {
	return registry.get(id);
}
/** Test-only. */
export function __resetEmbedderRegistryForTests(): void {
	registry.clear();
	registerBuiltInEmbedderAdapters();
}

/**
 * Resolve the embedder for a `selection`:
 *   - "model-free" (default) → always the zero-dep HRR (air-gap, no network).
 *   - a specific adapter id  → that adapter; falls back to HRR if it yields null.
 *   - "auto"                 → highest-priority adapter that creates successfully,
 *                              else HRR.
 * NEVER throws and ALWAYS returns a working embedder (graceful degrade) — the
 * the always-fallback invariant: a missing model/key downgrades, never breaks.
 */
export async function resolveEmbedder(selection: string = "model-free"): Promise<Embedder> {
	const fallback = (): Embedder => new HrrEmbedder(128);
	if (selection === "model-free") return fallback();

	if (selection !== "auto") {
		const adapter = registry.get(selection);
		if (adapter) {
			const e = await adapter.create().catch(() => null);
			if (e) return e;
		}
		return fallback();
	}

	// auto: try learned adapters by priority (lowest first), degrade to HRR.
	const ordered = [...registry.values()]
		.filter((a) => a.autoSelectPriority !== undefined)
		.sort((x, y) => (x.autoSelectPriority ?? 1e9) - (y.autoSelectPriority ?? 1e9));
	for (const a of ordered) {
		const e = await a.create().catch(() => null);
		if (e) return e;
	}
	return fallback();
}

/* ─────────────────────────── remote: OpenAI ─────────────────────────── */

/** OpenAI text-embedding-3-small, requesting `dimensions:256` (Matryoshka) so it
 *  drops into the existing 256-dim vectorIndex. Async; L2-normalised on output. */
export class OpenAiEmbedder implements Embedder {
	readonly id = "openai:text-embedding-3-small:256";
	readonly dims = EMBEDDER_DIMS;
	// A learned model's cosine tracks MEANING not tokens, so unrelated text scores
	// ~0 and true paraphrases clear a low floor — a clean 0.3 default works (no
	// HRR-style high floor needed). Left at the hybrid default by omitting minSim.
	constructor(
		private readonly apiKey: string,
		private readonly model = "text-embedding-3-small",
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		const res = await this.fetchImpl("https://api.openai.com/v1/embeddings", {
			method: "POST",
			headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({ model: this.model, input: texts, dimensions: EMBEDDER_DIMS }),
		});
		if (!res.ok) throw new Error(`openai embeddings HTTP ${res.status}`);
		const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
		const rows = data.data ?? [];
		// Preserve input order (OpenAI returns in order); normalise each.
		return texts.map((_, i) => normalizeTo(rows[i]?.embedding ?? []));
	}
}

/** Adapter: enabled only when an OpenAI key is present (env or injected). Returns
 *  null (degrade) when absent — never throws on a missing key. */
export function openAiEmbedderAdapter(opts: { apiKey?: string } = {}): EmbedderAdapter {
	return {
		id: "openai-256",
		transport: "remote",
		autoSelectPriority: 20, // after local (10)
		async create() {
			const key = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
			return key.trim() ? new OpenAiEmbedder(key.trim()) : null;
		},
		formatSetupError: () => "set OPENAI_API_KEY to use the OpenAI text-embedding-3-small (256-dim) embedder",
	};
}

/* ──────────────────── local: node-llama-cpp / embeddinggemma ──────────────────── */

/** Default local embedding model (Q8 GGUF, auto-resolved/downloaded). */
export const DEFAULT_LOCAL_EMBED_MODEL =
	"hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";

/**
 * Local embedder over `node-llama-cpp` + embeddinggemma (768-dim → 256 Matryoshka).
 * OFFLINE / AIR-GAP once the model is cached. The model + context init is memoised
 * behind a shared promise (an init-promise guard) so concurrent calls share one load.
 * Runs only when the optional `node-llama-cpp` dep is installed.
 */
export class LocalLlamaEmbedder implements Embedder {
	readonly id = "local:embeddinggemma-300m:256";
	readonly dims = EMBEDDER_DIMS;
	private ctx: Promise<{ getEmbeddingFor: (t: string) => Promise<{ vector: number[] }> }> | null = null;

	constructor(
		private readonly loadCtx: () => Promise<{ getEmbeddingFor: (t: string) => Promise<{ vector: number[] }> }>,
	) {}

	private ensure() {
		if (!this.ctx) this.ctx = this.loadCtx();
		return this.ctx;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		const ctx = await this.ensure();
		// Per-text (batch via Promise.all).
		return Promise.all(
			texts.map(async (t) => normalizeTo(Array.from((await ctx.getEmbeddingFor(t)).vector ?? []))),
		);
	}
}

/** Adapter: lazy-imports `node-llama-cpp` (an OPTIONAL dep). Returns null (degrade
 *  to HRR) when the dep isn't installed — the optional-dependency
 *  pattern, so air-gap installs that haven't added it simply fall back. */
export function localLlamaEmbedderAdapter(opts: { model?: string; cacheDir?: string } = {}): EmbedderAdapter {
	return {
		id: "local-embeddinggemma",
		transport: "local",
		autoSelectPriority: 10, // tried FIRST in auto (local before remote)
		async create() {
			let mod: Record<string, unknown>;
			try {
				// Optional dep — never a top-level import; a NON-LITERAL specifier so
				// the type-checker doesn't try to resolve an uninstalled module, and
				// absence at runtime ⇒ graceful null (the optional-dependency pattern).
				const optionalModule = "node-llama-cpp";
				mod = (await import(optionalModule)) as Record<string, unknown>;
			} catch {
				return null;
			}
			const getLlama = mod.getLlama as undefined | (() => Promise<unknown>);
			const resolveModelFile = mod.resolveModelFile as undefined | ((m: string, c?: string) => Promise<string>);
			if (typeof getLlama !== "function" || typeof resolveModelFile !== "function") return null;
			const loadCtx = async () => {
				const llama = (await getLlama()) as {
					loadModel: (a: { modelPath: string }) => Promise<{
						createEmbeddingContext: () => Promise<{ getEmbeddingFor: (t: string) => Promise<{ vector: number[] }> }>;
					}>;
				};
				const modelPath = await resolveModelFile(opts.model ?? DEFAULT_LOCAL_EMBED_MODEL, opts.cacheDir);
				const model = await llama.loadModel({ modelPath });
				return model.createEmbeddingContext();
			};
			return new LocalLlamaEmbedder(loadCtx);
		},
		formatSetupError: () =>
			"install the optional `node-llama-cpp` dependency to use the local embeddinggemma embedder (offline/air-gap)",
	};
}

/** Register the built-in adapters. Idempotent-ish (overwrites by id). The
 *  model-free HRR is the implicit fallback in resolveEmbedder, so it's not an
 *  auto-select adapter; the two LEARNED adapters are (local first, then remote). */
export function registerBuiltInEmbedderAdapters(): void {
	registerEmbedderAdapter(localLlamaEmbedderAdapter());
	registerEmbedderAdapter(openAiEmbedderAdapter());
}

registerBuiltInEmbedderAdapters();
