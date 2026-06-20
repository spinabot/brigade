import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getDefaultEmbedder, setDefaultEmbedder } from "../embedder.js";
import { resolveEmbedder } from "../embedder-providers.js";
import { FactStore } from "../records.js";
import { reembedPending } from "../reembed.js";

/**
 * LEARNED-EMBEDDER readiness + win (env-gated). The model-free HRR lane cannot bridge
 * pure synonymy (no shared lexical term) — that's the documented ceiling, and why the
 * shipped "100% vs 43%" number is qualified "at the default embedder". This proves the
 * learned-embedder PATH is turnkey: set `BRIGADE_MEMORY_EMBEDDER` (+ a key / GGUF) and
 * the SAME runtime resolution (`resolveEmbedder`) activates a learned model, facts get
 * learned vectors (`reembedPending`), and the async recall (`FactStore.recallAsync`)
 * bridges a synonym query HRR can't. It SKIPS on the model-free default (CI), and RUNS
 * the moment an operator drops in a model — turning the qualifier into a measurement.
 *
 *   OpenAI:  BRIGADE_MEMORY_EMBEDDER=openai-256   OPENAI_API_KEY=sk-...
 *   Local :  BRIGADE_MEMORY_EMBEDDER=local-embeddinggemma   (+ `npm i node-llama-cpp` + the GGUF)
 */

let dir: string;
let savedEmbedder: ReturnType<typeof getDefaultEmbedder>;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-learned-emb-"));
	savedEmbedder = getDefaultEmbedder();
});
afterEach(() => {
	setDefaultEmbedder(savedEmbedder); // never leak a learned embedder into sibling tests
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("learned embedder — readiness + the synonymy win (env-gated)", () => {
	it("activates the configured learned model + recalls a pure-SYNONYM query the model-free lane can't", async () => {
		// SAME resolution the gateway boot uses (server.ts).
		const embedder = await resolveEmbedder(process.env.BRIGADE_MEMORY_EMBEDDER ?? "model-free");
		if (embedder.id.startsWith("hrr")) {
			// Model-free default (CI) — no learned model in this environment. This is the
			// expected skip; it RUNS when an operator drops in a key/GGUF (see the header).
			console.log(
				`  [skip] no learned embedder (got ${embedder.id}) — set BRIGADE_MEMORY_EMBEDDER=openai-256 (+OPENAI_API_KEY) or local-embeddinggemma to measure the win`,
			);
			return;
		}

		// Pure synonymy: the query shares NO non-stopword token with the fact
		// ("phobia"/"person" vs "terrified"/"spiders"), so BM25 scores 0 and ONLY a
		// learned vector can bridge it. (An earlier query, "what am I scared of", shared
		// the token "am" — which scoring.ts does NOT stopword — so it recalled via BM25
		// and proved nothing; that was a real bug this test now avoids.)
		const synonymQuery = "what phobia does this person have";
		const factText = "I am terrified of spiders";

		// NEGATIVE CONTROL: the model-free HRR lane (bag-of-words) CANNOT bridge it.
		setDefaultEmbedder(await resolveEmbedder("model-free"));
		const hrrStore = new FactStore(path.join(dir, "hrr"), { now: () => 0 });
		hrrStore.write({ content: factText, segment: "preference" });
		await reembedPending(hrrStore, getDefaultEmbedder(), { limit: 100 });
		const hrrHits = await hrrStore.recallAsync(synonymQuery);
		assert.ok(
			!hrrHits.some((h) => h.content.includes("spiders")),
			"control: model-free HRR does NOT bridge the pure-synonym query (so a pass below is the learned embedder, not BM25)",
		);

		// THE WIN: the learned embedder bridges the same query. embed-on-write is sync; a
		// learned (async) embedder writes WITHOUT a vector, then reembedPending backfills it
		// — exactly what the runtime sweep does on boot.
		setDefaultEmbedder(embedder);
		const store = new FactStore(path.join(dir, "learned"), { now: () => 0 });
		store.write({ content: factText, segment: "preference" });
		const backfilled = await reembedPending(store, embedder, { limit: 100 });
		assert.strictEqual(backfilled, 1, "the learned embedder backfilled exactly the 1 pending fact's vector");
		const hits = await store.recallAsync(synonymQuery);
		assert.ok(
			hits.some((h) => h.content.includes("spiders")),
			`learned embedder ${embedder.id} bridged the synonym query (model-free HRR could not, per the control)`,
		);
		console.log(`  ✓ learned embedder ${embedder.id}: bridged a pure-synonym query the model-free lane provably misses`);
	});
});
