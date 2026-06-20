/**
 * Real-data gold EXPORT (build Step 2 — the privacy-safe local path).
 *
 * Turns the operator's REAL on-disk facts into a {@link GoldSpec} SCAFFOLD they
 * review + approve LOCALLY, then feed back through `loadGoldSpec` → `seedGold` →
 * `runRecallEval`. This is the "export → generate → human-approve" pipeline,
 * minus the leak: the output holds real personal facts, so it is written to a
 * `.local.json` file that `.gitignore` keeps OUT of the (public) repo — it is
 * NEVER committed or pushed. The committed CI gold stays synthetic.
 *
 * Pipeline (run on the machine that HAS the facts):
 *   const store = new FactStore(workspaceDir);            // fs OR convex (cache)
 *   writeLocalGoldSpec(p, exportGoldScaffold(store));     // → gold.local.json
 *   // …operator edits gold.local.json: rewrite each trivial query into a real
 *   //   paraphrase, set the taxonomy category, drop noise, mark abstentions…
 *   const cases = seedGold(new FactStore(tmp), loadGoldSpec(p));
 *   const result = await runRecallEval(defaultRecallCapability(store2), cases);
 *
 * The auto-generated queries are TRIVIAL by construction (terms lifted straight
 * from the fact), so an un-approved scaffold over-scores — the human-approval
 * rewrite is what makes it a real measurement (v2's LlmAdapter can automate the
 * paraphrase). Nothing here runs in CI; it's an on-demand local tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { FactStore } from "../records.js";
import { tokenize } from "../scoring.js";
import { GOLD_REVIEW_PLACEHOLDER, type GoldCase, type GoldFact, type GoldSpec } from "./gold.js";

/**
 * Build a gold-set scaffold from a store's ACTIVE facts. Facts are keyed by
 * their real `memoryId` (already stable); each fact gets ONE candidate case
 * whose query is its salient content terms — a placeholder for the operator to
 * rewrite into a realistic query during approval.
 */
export function exportGoldScaffold(store: FactStore, opts: { maxCases?: number } = {}): GoldSpec {
	const records = store.list(); // active, most-recent-first
	const facts: GoldFact[] = records.map((r) => ({
		key: r.memoryId,
		content: r.content,
		segment: r.segment,
		importance: r.importance,
		...(r.createdBy !== undefined ? { createdBy: r.createdBy } : {}),
		// Carry sourceType through — without it an untrusted real fact (tool_output /
		// retrieved_document / extraction / …) would scaffold as a TRUSTED one
		// (undefined ⇒ trusted at the write-gate), silently mislabeling the poison
		// lane the operator is trying to capture.
		...(r.sourceType !== undefined ? { sourceType: r.sourceType } : {}),
	}));
	const limit = opts.maxCases !== undefined && opts.maxCases >= 0 ? opts.maxCases : records.length;
	const cases: GoldCase[] = records.slice(0, limit).map((r, i) => {
		const terms = [...new Set(tokenize(r.content))].slice(0, 6).join(" ");
		return {
			id: `cand-${i}`,
			// ⚠ TRIVIAL placeholder — rewrite into a realistic paraphrase on approval.
			// If auto-extraction yields no terms (content was all stopwords/punctuation),
			// emit a visible placeholder so the operator can't miss the empty query on
			// review — and `loadGoldSpec` HARD-REJECTS any spec that still carries it.
			query: terms.length > 0 ? terms : GOLD_REVIEW_PLACEHOLDER,
			relevantKeys: [r.memoryId],
			// A reasonable default bucket (the fact's segment); refine to a GOLD_CATEGORIES
			// taxonomy label (single-session/temporal/abstention/…) during approval.
			category: r.segment,
		};
	});
	// approved:false ⇒ `loadGoldSpec` refuses to score this until the operator
	// reviews the trivial auto-queries and flips it to true (anti-inflation gate).
	return { approved: false, facts, cases };
}

/**
 * Persist a gold spec to a LOCAL file. The caller MUST use a path matched by
 * `.gitignore` (any `*.local.json` — the suffix is gitignored repo-wide) so real
 * facts never reach the public repo — enforced by {@link assertLocalGoldPath}.
 */
export function writeLocalGoldSpec(filePath: string, spec: GoldSpec): void {
	assertLocalGoldPath(filePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(spec, null, 2), "utf8");
}

/** Guard: a real-data gold file MUST be a `.local.json` (the gitignored pattern),
 *  so exporting real personal facts can't accidentally target a committed path. */
export function assertLocalGoldPath(filePath: string): void {
	if (!filePath.endsWith(".local.json")) {
		throw new Error(
			`real-data gold must be written to a *.local.json file (gitignored, never pushed); got: ${filePath}`,
		);
	}
}
