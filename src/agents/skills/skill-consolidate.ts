/**
 * Skill consolidation — the UMBRELLA-BUILDING half of skill self-improvement
 * (the LLM consolidation pass, and the skill
 * analogue of memory `consolidate.ts`). The aging curator (skill-curator.ts)
 * prunes UNUSED skills; this merges OVERLAPPING ones, so the auto-learned library
 * stays a small set of class-level skills instead of a sprawl of near-duplicate
 * one-session entries.
 *
 * Shape (mirrors memory consolidate.ts): ONE LLM call over the agent's
 * agent-created skills (name + body excerpt) → a structured plan of MERGES (fold
 * sibling skills into a keeper, appending a labeled section) and PRUNES (archive
 * an obsolete skill). Apply reuses the Inc-4 `appendSkillSection` (merge) + Inc-2
 * `archiveSkill` (sibling/prune) primitives — REVERSIBLE, never deletes.
 * Owner-workspace only; throttled by the same window as memory consolidation.
 *
 * SAFETY: only agent-created, non-pinned, non-archived skills are touched; a
 * keeper MUST exist among them and SURVIVES (hallucinated keepers rejected); a
 * name is touched at most once (no keeper-also-folded); never archives the last
 * skill. Discovery reads the local FS (authoritative both modes), so a merge/
 * archive takes effect on the agent's next turn. (NOTE: the convex skills-TABLE
 * mirror isn't updated on archive/merge — shared follow-up with the curator;
 * discovery is unaffected since it's local-FS-authoritative.)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { balancedObjects, makeIsolatedLlm, type MakeExtractionLlmArgs } from "../memory/extract.js";
import { appendSkillSection } from "../tools/manage-skill-tool.js";
import { archiveSkill, skillsSnapshotsRoot, snapshotSkillsRoot } from "./skill-curator.js";
import { listCurationCandidates, recordSkillPatched } from "./skill-usage.js";

const log = createSubsystemLogger("skills/consolidate");

/** Below this many candidates there's nothing worth an LLM call. */
const MIN_SKILLS_TO_CONSOLIDATE = 4;
const BODY_EXCERPT_CHARS = 400;

export const SKILL_CONSOLIDATION_PROMPT = `You are a skill-library curator for a personal AI assistant.
Below are the assistant's AUTO-LEARNED skills, each with its name and a body excerpt.
Goal: keep the library a SMALL set of CLASS-LEVEL skills, not a sprawl of near-duplicate one-session entries.

Find skills that OVERLAP — same class of task, redundant, or one is a narrow special case of another.
For each overlapping cluster pick the BROADEST, best skill as the KEEPER and FOLD the others into it.

Be CONSERVATIVE. Only merge skills that genuinely cover the SAME class of task; distinct tasks stay separate.
NEVER merge everything into one. When in doubt, leave them alone.

Return STRICT JSON only — no prose, no fences:
{"merges":[{"keeper":"<existing skill name>","fold":["<name>", ...],"section":"## <heading>\\n\\n<1-3 lines capturing what the folded skills add that the keeper lacks>"}],"prunes":["<name of a clearly obsolete/empty skill to archive>", ...]}
- "keeper" MUST be one of the skills listed (never invent a name); it survives.
- "fold" skills are archived after their essence is appended to the keeper via "section".
- A skill may appear in at most ONE merge, and never as both keeper and fold.
- Use {"merges":[],"prunes":[]} if nothing should change.`;

export interface SkillMerge {
	keeper: string;
	fold: string[];
	section: string;
}
export interface SkillConsolidationPlan {
	merges: SkillMerge[];
	prunes: string[];
}

/** Parse the consolidation reply. Never throws; malformed → empty plan. Scans every
 *  top-level balanced `{...}` and uses the FIRST that carries a `merges` or `prunes`
 *  array — robust to prose-wrapped JSON + a leading stray object (mirrors how
 *  `parseConsolidationArchive` / `parseExtractionReply` were hardened; a greedy
 *  first-to-last brace match would span unrelated brace groups and silently no-op). */
export function parseSkillConsolidation(text: string): SkillConsolidationPlan {
	const empty: SkillConsolidationPlan = { merges: [], prunes: [] };
	if (!text) return empty;
	for (const block of balancedObjects(text)) {
		let parsed: { merges?: unknown; prunes?: unknown };
		try {
			parsed = JSON.parse(block) as { merges?: unknown; prunes?: unknown };
		} catch {
			continue;
		}
		if (!Array.isArray(parsed.merges) && !Array.isArray(parsed.prunes)) continue;
		const merges: SkillMerge[] = [];
		if (Array.isArray(parsed.merges)) {
			for (const m of parsed.merges) {
				if (!m || typeof m !== "object") continue;
				const mm = m as Record<string, unknown>;
				if (typeof mm.keeper !== "string" || !mm.keeper.trim()) continue;
				if (typeof mm.section !== "string" || !mm.section.trim()) continue;
				const fold = Array.isArray(mm.fold)
					? mm.fold.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
					: [];
				if (fold.length === 0) continue;
				merges.push({ keeper: mm.keeper.trim(), fold, section: mm.section });
			}
		}
		const prunes = Array.isArray(parsed.prunes)
			? parsed.prunes.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
			: [];
		return { merges, prunes };
	}
	return empty;
}

export type SkillConsolidationLlm = (skillsBlock: string) => Promise<string>;

export interface SkillConsolidationResult {
	ran: boolean;
	/** When true, the plan was computed + reported but NOT applied (preview). */
	dryRun: boolean;
	merged: number; // sibling skills folded into a keeper + archived
	pruned: number; // skills archived as obsolete
	considered: number;
	/** Applied merges (keeper ← folded names) — the rename-map for "where did my skill go". */
	appliedMerges: Array<{ keeper: string; folded: string[] }>;
	/** Names archived as obsolete prunes. */
	appliedPrunes: string[];
	/** Full-library snapshot taken before applying (rollback point); undefined for a no-op/dry-run. */
	snapshotPath?: string;
	/** The LLM plan (surfaced for dry-run preview + the run report). */
	plan: SkillConsolidationPlan;
}

/**
 * Run one consolidation pass over an agent's skills root. No-op below `minSkills`.
 * Validates the LLM plan hard (keeper exists + survives; each name touched once;
 * never archives the last skill) before applying. Best-effort.
 */
export async function runSkillConsolidation(args: {
	skillsRoot: string;
	llm: SkillConsolidationLlm;
	minSkills?: number;
	now?: number;
	/** Preview only — compute + report the plan, apply nothing (no snapshot, no mutation). */
	dryRun?: boolean;
}): Promise<SkillConsolidationResult> {
	const now = args.now ?? Date.now();
	const dryRun = args.dryRun === true;
	const emptyPlan: SkillConsolidationPlan = { merges: [], prunes: [] };
	const notRun = (considered: number): SkillConsolidationResult => ({
		ran: false,
		dryRun,
		merged: 0,
		pruned: 0,
		considered,
		appliedMerges: [],
		appliedPrunes: [],
		plan: emptyPlan,
	});
	const candidates = listCurationCandidates(args.skillsRoot, now).filter(
		(c) => !c.record.pinned && c.record.state !== "archived",
	);
	const min = args.minSkills ?? MIN_SKILLS_TO_CONSOLIDATE;
	if (candidates.length < min) {
		return notRun(candidates.length);
	}

	const block = candidates
		.map((c) => {
			const file = path.join(args.skillsRoot, c.name, "SKILL.md");
			let excerpt = "";
			try {
				excerpt = fs
					.readFileSync(file, "utf8")
					.replace(/^---[\s\S]*?\n---\n/, "") // drop frontmatter
					.trim()
					.slice(0, BODY_EXCERPT_CHARS);
			} catch {
				/* unreadable → name only */
			}
			return `### ${c.name}\n${excerpt}`;
		})
		.join("\n\n");

	let reply = "";
	try {
		reply = await args.llm(block);
	} catch (err) {
		log.warn("skill consolidation llm failed", { error: err instanceof Error ? err.message : String(err) });
		return notRun(candidates.length);
	}

	const plan = parseSkillConsolidation(reply);

	// DRY RUN — surface the plan + write a report, change NOTHING (no snapshot, no
	// mutation). Lets an operator preview a pass before trusting it live.
	if (dryRun) {
		writeConsolidationReport(args.skillsRoot, now, {
			dryRun: true,
			considered: candidates.length,
			plan,
			appliedMerges: [],
			appliedPrunes: [],
		});
		return { ran: true, dryRun: true, merged: 0, pruned: 0, considered: candidates.length, appliedMerges: [], appliedPrunes: [], plan };
	}

	const names = new Set(candidates.map((c) => c.name));
	const touched = new Set<string>(); // a name is merged/pruned at most once
	const appliedMerges: Array<{ keeper: string; folded: string[] }> = [];
	const appliedPrunes: string[] = [];
	let merged = 0;
	let pruned = 0;

	// SNAPSHOT before any mutation — a keeper's appended section is NOT per-skill
	// reversible (archiveSkill only undoes the folds), so take a full-library
	// rollback point first. Best-effort: a snapshot failure degrades to the
	// per-fold archive reversibility, it does not block the pass.
	let snapshotPath: string | undefined;
	if (plan.merges.length > 0 || plan.prunes.length > 0) {
		const snap = snapshotSkillsRoot(args.skillsRoot, now);
		if (snap.ok) snapshotPath = snap.path;
		else log.warn("skill consolidation snapshot failed; proceeding without a rollback point", { message: snap.message });
	}
	// Per-pass DESTRUCTION CAP — a single bad/hallucinated LLM reply must not gut the
	// library in one pass (consolidation is reversible, but mass-archival is still
	// disruptive). Generous floor so a small library can still fully umbrella-ify
	// (e.g. 4→1), bounded fraction so a large library can't collapse in one pass.
	const maxArchivable = Math.max(3, Math.floor(candidates.length * 0.6));

	// MERGES — keeper must exist + be free; fold members must exist, differ from
	// the keeper, and be free; never archive every candidate; respect the pass cap.
	for (const m of plan.merges) {
		if (!names.has(m.keeper) || touched.has(m.keeper)) continue;
		const fold = m.fold.filter((f) => names.has(f) && f !== m.keeper && !touched.has(f));
		if (fold.length === 0) continue;
		if (touched.size + fold.length + 1 > candidates.length) continue; // never archive all
		if (merged + pruned + fold.length > maxArchivable) continue; // would exceed the pass cap
		const keeperFile = path.join(args.skillsRoot, m.keeper, "SKILL.md");
		const res = appendSkillSection(keeperFile, m.section);
		if (!res.ok) continue; // dedup / size-cap / missing → skip this merge
		recordSkillPatched(args.skillsRoot, m.keeper, now);
		touched.add(m.keeper);
		const folded: string[] = [];
		for (const f of fold) {
			if (archiveSkill(args.skillsRoot, f, now).ok) {
				touched.add(f);
				merged += 1;
				folded.push(f);
			}
		}
		if (folded.length > 0) appliedMerges.push({ keeper: m.keeper, folded });
	}

	// PRUNES — archive an obsolete skill; never a keeper / already-touched; never
	// the last remaining skill.
	for (const p of plan.prunes) {
		if (merged + pruned >= maxArchivable) break; // per-pass destruction cap
		if (!names.has(p) || touched.has(p)) continue;
		if (touched.size + 1 >= candidates.length) break;
		if (archiveSkill(args.skillsRoot, p, now).ok) {
			touched.add(p);
			pruned += 1;
			appliedPrunes.push(p);
		}
	}

	if (merged || pruned) {
		log.info("skill consolidation", { merged, pruned, considered: candidates.length, snapshotPath });
		writeConsolidationReport(args.skillsRoot, now, {
			dryRun: false,
			considered: candidates.length,
			plan,
			appliedMerges,
			appliedPrunes,
			...(snapshotPath ? { snapshotPath } : {}),
		});
	}
	return {
		ran: true,
		dryRun: false,
		merged,
		pruned,
		considered: candidates.length,
		appliedMerges,
		appliedPrunes,
		...(snapshotPath ? { snapshotPath } : {}),
		plan,
	};
}

/** Persist a per-run consolidation report (JSON) under the snapshots root so an
 *  operator can see what changed (or, for a dry-run, what WOULD change) and which
 *  snapshot to roll back to. Best-effort — a report failure never blocks the pass. */
function writeConsolidationReport(
	skillsRoot: string,
	now: number,
	report: {
		dryRun: boolean;
		considered: number;
		plan: SkillConsolidationPlan;
		appliedMerges: Array<{ keeper: string; folded: string[] }>;
		appliedPrunes: string[];
		snapshotPath?: string;
	},
): void {
	try {
		const root = skillsSnapshotsRoot(skillsRoot);
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, `report-${now}.json`), `${JSON.stringify({ at: now, ...report }, null, 2)}\n`, "utf8");
	} catch {
		/* best-effort report */
	}
}

/** The consolidation distiller — `makeIsolatedLlm` with the prompt pinned. */
export function makeSkillConsolidationLlm(args: MakeExtractionLlmArgs): SkillConsolidationLlm {
	return makeIsolatedLlm(SKILL_CONSOLIDATION_PROMPT, args);
}
