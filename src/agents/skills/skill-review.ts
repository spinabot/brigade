/**
 * Skill-learning review — Brigade's behavior-change self-improvement pass.
 *
 * The self-improvement engine has two halves: distil the session into MEMORY,
 * and distil reusable techniques into SKILLS. Brigade already does the first
 * (the extraction sweep + `self-review.ts`). This is the second — the
 * behavior-change half: on a cadence, a tool-LESS reviewer reflects on the
 * session and proposes new SKILLS (named, reusable procedures); a deterministic
 * apply-step writes them as `SKILL.md` files the agent discovers on its NEXT
 * turn. So memory makes the agent know more; this makes it DO better.
 *
 * SECURITY — skills are AUTHORITY over behavior. Unlike memory (origin-isolated,
 * recalled per-principal), a skill learned from one session changes how the
 * agent acts for EVERY future turn. A channel peer must therefore NEVER author
 * one (that would be behavior injection). The caller gates this to OWNER
 * sessions; the apply-step additionally writes ONLY the agent's own workspace
 * scope (never the cross-agent `managed` root) and reuses the `manage_skill`
 * tool's path-containment + sanitisation rather than re-deriving them.
 *
 * Brigade-native shape (vs a forked tool-agent): a tool-less LLM emits a
 * STRUCTURED proposal and a deterministic apply-step performs the writes — so
 * the whole pass is unit-testable without a model or a running loop (the same
 * shape as the extraction + consolidation sweeps). The reviewer is INJECTED.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { resolveSkillsDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { balancedObjects, makeIsolatedLlm, type MakeExtractionLlmArgs } from "../memory/extract.js";
import {
	appendSkillSection,
	isPathInside,
	mirrorSkillWrite,
	renderSkillTemplate,
	sanitizeSkillName,
} from "../tools/manage-skill-tool.js";
import { recordSkillCreated, recordSkillPatched } from "./skill-usage.js";

const log = createSubsystemLogger("skills/review");

/** Cadence — review skills once `itersSinceReview` reaches `interval`. The reviewer
 *  nudges skills by activity count (memory by turn); the caller owns the counter.
 *  `0` disables. Kept as a pure rule so it's testable in isolation. */
export function shouldReviewSkills(itersSinceReview: number, interval: number): boolean {
	return interval > 0 && itersSinceReview >= interval;
}

/**
 * The review prompt — "is there a REUSABLE skill here?" with
 * anti-fragmentation discipline (most sessions yield none; never a one-off, an
 * env-failure, or a negative tool claim). These filters are what stop the loop
 * from flooding the library with narrow single-session entries.
 */
export const SKILL_REVIEW_PROMPT = [
	"Review the conversation above and decide whether it produced a REUSABLE SKILL —",
	"a named, repeatable technique, workflow, or convention worth not relearning.",
	"Most sessions yield NONE; zero is the common, correct answer. Noise is worse than nothing.",
	"",
	"PREFER REFINING over creating. If a skill used THIS session (its SKILL.md appears",
	"above) turned out to be missing a step, wrong, or could be sharper, PATCH it:",
	'set "mode":"patch", reuse its EXACT name, and put ONLY the new section in "body"',
	"(a pitfall, a step, a clarified trigger) — never restate the whole skill.",
	"",
	"CREATE a new skill (\"mode\":\"create\") ONLY when no existing one covers the class, and",
	"only when ALL hold:",
	"  • It's a CLASS of task that will recur — not a one-off narrative of what just happened.",
	"  • It has a concrete, transferable procedure someone could follow next time.",
	"  • It isn't already obvious to a capable agent.",
	"Most sessions yield NOTHING; zero is the common, correct answer. Noise is worse than nothing.",
	"",
	"DO NOT propose a skill (create OR patch) for:",
	'  • A single specific task with no reusable class (e.g. "fix issue #123").',
	"  • Environment-dependent failures (a missing binary, an unconfigured key).",
	'  • Negative claims about tools ("X is broken") — they ossify into refusals.',
	"  • Transient errors that resolved within the session.",
	"",
	"Return STRICT JSON only — no prose, no markdown fences:",
	'{"skills":[{"mode":"create|patch","name":"kebab-case-class-name","description":"one line: when to use this (create only)","body":"# Title + procedure (create), OR just the section to append (patch)","reason":"why this recurs"}]}',
	'Use {"skills":[]} when nothing qualifies. Respond with ONLY the JSON object.',
].join("\n");

export interface SkillProposal {
	name: string;
	description: string;
	body: string;
	reason?: string;
	/** "create" (default) = a new skill. "patch" = APPEND `body` as a refinement
	 *  to an EXISTING skill named `name` (the first-choice action). */
	mode?: "create" | "patch";
}

/**
 * Parse the reviewer reply into proposals. Robust to prose-wrapping AND a leading
 * stray object: scans every top-level balanced `{...}` and uses the FIRST that
 * carries a `skills` array (same hardening as `parseExtractedFacts`). Never throws.
 */
export function parseSkillProposals(text: string): SkillProposal[] {
	if (!text) return [];
	for (const block of balancedObjects(text)) {
		let parsed: { skills?: unknown };
		try {
			parsed = JSON.parse(block) as { skills?: unknown };
		} catch {
			continue;
		}
		if (!Array.isArray(parsed.skills)) continue;
		const out: SkillProposal[] = [];
		for (const raw of parsed.skills) {
			if (!raw || typeof raw !== "object") continue;
			const s = raw as Record<string, unknown>;
			// description is optional (a patch needs none); name + body are required.
			if (typeof s.name !== "string" || typeof s.body !== "string" || !s.name.trim() || !s.body.trim()) continue;
			out.push({
				name: s.name.trim(),
				description: typeof s.description === "string" ? s.description.trim() : "",
				body: s.body,
				...(typeof s.reason === "string" ? { reason: s.reason.trim() } : {}),
				...(s.mode === "patch" || s.mode === "create" ? { mode: s.mode } : {}),
			});
		}
		return out;
	}
	return [];
}

/**
 * The reviewer seam — runs {@link SKILL_REVIEW_PROMPT} over a transcript and
 * returns proposals. Production = the tool-less isolated LLM
 * ({@link makeSkillReviewer}); tests inject a fake. The `prompt` argument lets a
 * caller pin a variant; the production builder ignores it (the prompt is baked
 * into the isolated LLM).
 */
export type SkillReviewer = (prompt: string, transcript: string) => Promise<SkillProposal[]>;

export interface SkillReviewResult {
	created: string[];
	patched: string[];
	skipped: Array<{ name: string; reason: string }>;
	summary: string;
}

/** Anti-fragmentation: one review can't flood the library with NEW skills. */
const MAX_SKILLS_PER_REVIEW = 2;
/** Patches don't add skills (and appendSkillSection dedups + size-caps), but bound
 *  per-pass churn anyway. */
const MAX_PATCHES_PER_REVIEW = 3;

/**
 * Run one skill-review pass and write any new skills to the agent's OWN
 * workspace scope. Best-effort: a reviewer error / malformed return is a no-op,
 * never throwing into the sweep. Dedups against existing skill names (the
 * reviewer can neither clobber nor re-create), caps the number created per pass,
 * and refuses anything whose resolved path escapes the agent's skills root.
 *
 * `agentId` selects the OWNER-workspace skills root; the caller MUST only invoke
 * this for owner-origin sessions (a peer must not be able to author behavior).
 */
export async function runSkillReview(args: {
	transcript: string;
	reviewer: SkillReviewer;
	agentId: string;
}): Promise<SkillReviewResult> {
	let proposals: SkillProposal[];
	try {
		proposals = await args.reviewer(SKILL_REVIEW_PROMPT, args.transcript);
	} catch {
		return { created: [], patched: [], skipped: [], summary: "skill-review: skipped (reviewer error)" };
	}
	if (!Array.isArray(proposals) || proposals.length === 0) {
		return { created: [], patched: [], skipped: [], summary: "skill-review: nothing to learn" };
	}
	const root = resolveSkillsDir(args.agentId);
	const existing = existingSkillNames(root);
	const created: string[] = [];
	const patched: string[] = [];
	const skipped: Array<{ name: string; reason: string }> = [];
	for (const p of proposals) {
		const safeName = sanitizeSkillName(p.name);
		if (!safeName) {
			skipped.push({ name: p.name, reason: "unsafe name" });
			continue;
		}
		const skillDir = path.join(root, safeName);
		// Defense in depth — same contain-check the manage_skill tool runs (both
		// create AND patch): the resolved path MUST live inside the skills root.
		if (!isPathInside(path.resolve(root), path.resolve(skillDir))) {
			skipped.push({ name: safeName, reason: "path escapes scope" });
			continue;
		}
		const skillFile = path.join(skillDir, "SKILL.md");
		const exists = existing.has(safeName.toLowerCase());

		// PATCH — refine an existing skill (the first-choice action). Appends
		// the new section; dedups + size-caps live in appendSkillSection.
		if (p.mode === "patch") {
			if (!exists) {
				skipped.push({ name: safeName, reason: "patch target does not exist" });
				continue;
			}
			if (patched.length >= MAX_PATCHES_PER_REVIEW) {
				skipped.push({ name: safeName, reason: "per-review patch cap reached" });
				continue;
			}
			const res = appendSkillSection(skillFile, p.body);
			if (!res.ok || res.content === undefined) {
				skipped.push({ name: safeName, reason: res.reason ?? "patch failed" });
				continue;
			}
			mirrorSkillWrite("agent", args.agentId, safeName, res.content);
			recordSkillPatched(root, safeName);
			patched.push(safeName);
			log.info("skill-review refined a skill", { agentId: args.agentId, name: safeName });
			continue;
		}

		// CREATE — a brand-new skill (capped for anti-fragmentation).
		if (created.length >= MAX_SKILLS_PER_REVIEW) {
			skipped.push({ name: safeName, reason: "per-review create cap reached" });
			continue;
		}
		if (exists) {
			skipped.push({ name: safeName, reason: "already exists (use mode=patch to refine)" });
			continue;
		}
		const content = renderSkillTemplate({
			name: safeName,
			description: p.description,
			body: p.body.trim(),
		});
		try {
			fs.mkdirSync(skillDir, { recursive: true });
			// `wx` — fail if SKILL.md already exists, so a race with the manage_skill
			// tool (or a concurrent sweep) can never clobber a hand-authored skill.
			fs.writeFileSync(skillFile, content, { encoding: "utf8", flag: "wx" });
		} catch (err) {
			const raced = (err as NodeJS.ErrnoException)?.code === "EEXIST";
			// Non-race write fault (ENOSPC/EPERM/EROFS/…): the mkdir above may have
			// just created an empty skillDir. Best-effort remove it so a SKILL.md-less
			// orphan can't permanently block this name on a later pass.
			if (!raced) {
				try {
					fs.rmdirSync(skillDir);
				} catch {
					/* leave it — existingSkillNames now ignores SKILL.md-less dirs anyway */
				}
			}
			skipped.push({ name: safeName, reason: raced ? "already exists" : "write failed" });
			continue;
		}
		// Convex mirror (no-op in fs mode) so the skills table learns immediately,
		// not only at the next gateway boot reconcile.
		mirrorSkillWrite("agent", args.agentId, safeName, content);
		// Mark it agent-created so the curator may age it out later if it never
		// gets used (anchors the inactivity clock at creation).
		recordSkillCreated(root, safeName);
		existing.add(safeName.toLowerCase());
		created.push(safeName);
		log.info("skill-review learned a skill", { agentId: args.agentId, name: safeName });
	}
	const parts: string[] = [];
	if (created.length) parts.push(`learned ${created.length} (${created.join(", ")})`);
	if (patched.length) parts.push(`refined ${patched.length} (${patched.join(", ")})`);
	return {
		created,
		patched,
		skipped,
		summary: parts.length ? `skill-review: ${parts.join("; ")}` : "skill-review: nothing durable to learn",
	};
}

/** Existing skill directory names under a root, lowercased, for dedup. A dir
 *  counts as a skill only if it has a SKILL.md (mirrors `onDiskSkillNames`), so a
 *  bare/orphan directory never blocks a name — the create path's `wx` flag still
 *  prevents clobbering a real skill. Missing root → empty set (no skills yet,
 *  not an error). */
function existingSkillNames(root: string): Set<string> {
	const out = new Set<string>();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith(".")) continue;
		if (fs.existsSync(path.join(root, e.name, "SKILL.md"))) out.add(e.name.toLowerCase());
	}
	return out;
}

/**
 * The production reviewer — a tool-less isolated LLM with {@link SKILL_REVIEW_PROMPT}
 * pinned (the same one-shot, throwaway-transcript subagent the extraction +
 * consolidation sweeps use), its reply parsed into proposals. One extra model
 * call per skill-review fire (cadence-gated), never per turn.
 */
export function makeSkillReviewer(args: MakeExtractionLlmArgs): SkillReviewer {
	const llm = makeIsolatedLlm(SKILL_REVIEW_PROMPT, args);
	return async (_prompt: string, transcript: string): Promise<SkillProposal[]> => {
		const reply = await llm(transcript);
		return parseSkillProposals(reply);
	};
}
