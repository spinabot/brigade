/**
 * Skill curator — the maintenance half of skill self-improvement (Brigade-native
 * via an automatic-transitions aging pass). Pure, no-LLM aging of
 * AGENT-CREATED skills so the auto-learned library doesn't bloat:
 *   active → stale    (no use for staleAfterDays)
 *   stale  → archived (no use for archiveAfterDays; the dir is moved aside)
 *   stale  → active   (used again → reactivated)
 * Pinned skills are exempt; hand-authored skills (no agent record) are never
 * touched. Archival is REVERSIBLE — the skill dir is moved to a sibling archive
 * root, never deleted; `restoreSkill` moves it back.
 *
 * The use-signal is gathered OFF the hot path: `detectAndRecordSkillUses` scans a
 * session's raw messages for a read of a skill's SKILL.md (Brigade's equivalent
 * of a skill-view → use-bump flow — Brigade has no skill-view tool, so the
 * model reads the body via the generic `read` tool and the path lands in the
 * transcript).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import {
	activityAnchorMs,
	listCurationCandidates,
	recordSkillUse,
	setSkillState,
	SKILL_STATE_ACTIVE,
	SKILL_STATE_ARCHIVED,
	SKILL_STATE_STALE,
} from "./skill-usage.js";

const log = createSubsystemLogger("skills/curator");

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_STALE_AFTER_DAYS = 30;
export const DEFAULT_ARCHIVE_AFTER_DAYS = 90;

export interface CuratorCounts {
	checked: number;
	markedStale: number;
	archived: number;
	reactivated: number;
}

export interface RunSkillCuratorArgs {
	skillsRoot: string;
	staleAfterDays?: number;
	archiveAfterDays?: number;
	now?: number;
}

/**
 * One pure aging pass over a skills root — the
 * apply_automatic_transitions: anchor on lastUsedAt ?? createdAt; archive when
 * the anchor predates archiveAfterDays; else mark stale at staleAfterDays; else
 * reactivate a stale skill whose anchor is now fresh (it was used again). Pinned
 * + hand-authored skills are never touched.
 */
export function runSkillCurator(args: RunSkillCuratorArgs): CuratorCounts {
	const now = args.now ?? Date.now();
	const staleDays = args.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
	const archiveDays = args.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS;
	const staleCutoff = now - staleDays * DAY_MS;
	const archiveCutoff = now - archiveDays * DAY_MS;
	const counts: CuratorCounts = { checked: 0, markedStale: 0, archived: 0, reactivated: 0 };

	for (const cand of listCurationCandidates(args.skillsRoot, now)) {
		counts.checked += 1;
		if (cand.record.pinned) continue; // pinned ⇒ exempt
		const anchor = activityAnchorMs(cand.record);
		// A non-positive/non-finite anchor means activityAnchorMs couldn't parse
		// lastUsedAt OR createdAt (a value-corrupt sidecar — e.g. a hand-edit to
		// .usage.json). Treat that as "fresh, unknown age" (= now), NOT epoch 0,
		// which would otherwise satisfy `anchor <= archiveCutoff` and archive the
		// skill on its very first pass — gutting an actively-relevant skill. Mirrors
		// the "fall back to now" posture that keeps a brand-new skill off the chopping
		// block, and preserves the module's stated "never archive on sight" invariant.
		const effectiveAnchor = anchor > 0 ? anchor : now;
		const state = cand.record.state;
		// `<= 0` DISABLES that transition (matches the "0 disables" convention used
		// for review cadence) — NOT "archive/stale immediately", which would gut the
		// library the instant a skill is created.
		if (archiveDays > 0 && effectiveAnchor <= archiveCutoff && state !== SKILL_STATE_ARCHIVED) {
			if (archiveSkill(args.skillsRoot, cand.name, now).ok) counts.archived += 1;
		} else if (staleDays > 0 && effectiveAnchor <= staleCutoff && state === SKILL_STATE_ACTIVE) {
			setSkillState(args.skillsRoot, cand.name, SKILL_STATE_STALE, now);
			counts.markedStale += 1;
		} else if (staleDays > 0 && effectiveAnchor > staleCutoff && state === SKILL_STATE_STALE) {
			setSkillState(args.skillsRoot, cand.name, SKILL_STATE_ACTIVE, now);
			counts.reactivated += 1;
		}
	}
	if (counts.markedStale || counts.archived || counts.reactivated) {
		log.info("skill curator pass", { ...counts });
	}
	return counts;
}

/** Sibling archive root — OUTSIDE the skills root, so discovery (which scans only
 *  `<ws>/skills`) never surfaces an archived skill regardless of Pi's scan depth. */
export function skillsArchiveRoot(skillsRoot: string): string {
	return path.join(path.dirname(skillsRoot), "skills-archive");
}

export interface ArchiveResult {
	ok: boolean;
	message: string;
	dest?: string;
}

/**
 * Move a skill directory aside to the sibling archive root and mark it archived.
 * Reversible via {@link restoreSkill}; never deletes. A name collision in the
 * archive gets a numeric suffix.
 */
export function archiveSkill(skillsRoot: string, name: string, now: number = Date.now()): ArchiveResult {
	const src = path.join(skillsRoot, name);
	if (!fs.existsSync(path.join(src, "SKILL.md"))) {
		return { ok: false, message: `no skill '${name}' to archive` };
	}
	const archiveRoot = skillsArchiveRoot(skillsRoot);
	let dest = path.join(archiveRoot, name);
	try {
		fs.mkdirSync(archiveRoot, { recursive: true });
		if (fs.existsSync(dest)) dest = path.join(archiveRoot, `${name}-${now}`);
		fs.renameSync(src, dest);
	} catch (err) {
		return { ok: false, message: `archive failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	setSkillState(skillsRoot, name, SKILL_STATE_ARCHIVED, now);
	return { ok: true, message: `archived to ${dest}`, dest };
}

/** Move an archived skill back to the live root. Refuses if a live skill of that
 *  name already exists (no silent clobber). */
export function restoreSkill(skillsRoot: string, name: string, now: number = Date.now()): ArchiveResult {
	const archiveRoot = skillsArchiveRoot(skillsRoot);
	// Resolve the archived dir: the base name, or — if a name was archived more than
	// once — the NEWEST timestamp-suffixed copy (archiveSkill appends `-<ms>` on a
	// collision; without this fallback those copies were silently unrestorable).
	let src = path.join(archiveRoot, name);
	if (!fs.existsSync(path.join(src, "SKILL.md"))) {
		let newest: { dir: string; ts: number } | undefined;
		try {
			for (const e of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
				if (!e.isDirectory()) continue;
				const m = /^(.+)-(\d+)$/.exec(e.name);
				if (!m || m[1] !== name) continue;
				if (!fs.existsSync(path.join(archiveRoot, e.name, "SKILL.md"))) continue;
				const ts = Number(m[2]);
				if (!newest || ts > newest.ts) newest = { dir: e.name, ts };
			}
		} catch {
			/* archive root missing → no candidates */
		}
		if (!newest) return { ok: false, message: `no archived skill '${name}'` };
		src = path.join(archiveRoot, newest.dir);
	}
	const dest = path.join(skillsRoot, name);
	if (fs.existsSync(dest)) return { ok: false, message: `a live skill '${name}' already exists` };
	try {
		fs.mkdirSync(skillsRoot, { recursive: true });
		fs.renameSync(src, dest);
	} catch (err) {
		return { ok: false, message: `restore failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	setSkillState(skillsRoot, name, SKILL_STATE_ACTIVE, now);
	return { ok: true, message: `restored to ${dest}`, dest };
}

/** Sibling snapshots root (parallel to `skills-archive/`). */
export function skillsSnapshotsRoot(skillsRoot: string): string {
	return path.join(path.dirname(skillsRoot), "skills-snapshots");
}

const MAX_SKILL_SNAPSHOTS = 5;

/**
 * Copy the ENTIRE skills root to a timestamped snapshot. Per-skill archive/restore
 * can't undo a keeper's appended section (the merge writes into the keeper's
 * SKILL.md), so a consolidation pass takes a full snapshot first for true
 * reversibility. Best-effort; prunes to the last {@link MAX_SKILL_SNAPSHOTS}.
 */
export function snapshotSkillsRoot(
	skillsRoot: string,
	now: number = Date.now(),
): { ok: boolean; path?: string; message: string } {
	if (!fs.existsSync(skillsRoot)) return { ok: false, message: "no skills root to snapshot" };
	const root = skillsSnapshotsRoot(skillsRoot);
	const dest = path.join(root, String(now));
	try {
		fs.mkdirSync(root, { recursive: true });
		fs.cpSync(skillsRoot, dest, { recursive: true });
	} catch (err) {
		return { ok: false, message: `snapshot failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	try {
		const stamps = fs
			.readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
			.map((e) => Number(e.name))
			.sort((a, b) => b - a);
		for (const ts of stamps.slice(MAX_SKILL_SNAPSHOTS)) {
			fs.rmSync(path.join(root, String(ts)), { recursive: true, force: true });
		}
	} catch {
		/* best-effort prune */
	}
	return { ok: true, path: dest, message: `snapshot at ${dest}` };
}

/**
 * Roll the skills root back to a snapshot. Snapshots the CURRENT state FIRST so
 * the rollback is itself undoable (matching the per-skill archive's reversibility
 * posture), then replaces the live root with the snapshot's contents.
 */
export function restoreSkillsSnapshot(
	skillsRoot: string,
	snapshotPath: string,
	now: number = Date.now(),
): { ok: boolean; message: string } {
	if (!fs.existsSync(path.join(snapshotPath, ""))) return { ok: false, message: `no snapshot at ${snapshotPath}` };
	snapshotSkillsRoot(skillsRoot, now); // make the rollback undoable
	try {
		fs.rmSync(skillsRoot, { recursive: true, force: true });
		fs.cpSync(snapshotPath, skillsRoot, { recursive: true });
	} catch (err) {
		return { ok: false, message: `restore failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true, message: `restored skills from ${snapshotPath}` };
}

/**
 * Detect which agent-created skills were USED in a session's messages and bump
 * their use telemetry. "Used" = the model read the skill's `SKILL.md` (its path
 * appears in the raw messages — read tool call/result). Off-hot-path: called
 * from the gateway sweep with the same messages extraction sees. Path separators
 * (incl. JSON-escaped Windows backslashes) are normalised so the match is
 * platform-independent; the trailing `/SKILL.md` keeps a bare skill name in chat
 * from counting as a use, and prevents one skill name prefixing another.
 *
 * Returns the skill names whose use was recorded.
 */
export function detectAndRecordSkillUses(skillsRoot: string, messages: unknown[], now: number = Date.now()): string[] {
	let hay: string;
	try {
		hay = JSON.stringify(messages) ?? "";
	} catch {
		return [];
	}
	if (!hay) return [];
	const norm = hay.replace(/\\\\/g, "/").replace(/\\/g, "/");
	// Anchor to THIS skills root's absolute path, not a bare `/<name>/SKILL.md`
	// fragment — otherwise a same-named skill in a DIFFERENT root (bundled, another
	// agent's workspace, managed) would falsely bump ours and keep a dead skill alive.
	const rootNorm = skillsRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	const used: string[] = [];
	for (const cand of listCurationCandidates(skillsRoot, now)) {
		if (norm.includes(`${rootNorm}/${cand.name}/SKILL.md`)) {
			recordSkillUse(skillsRoot, cand.name, now);
			used.push(cand.name);
		}
	}
	return used;
}
