/**
 * Skill usage telemetry + provenance — the substrate the skill CURATOR reads to
 * decide lifecycle (Brigade-native skill-usage telemetry).
 *
 * A sidecar `.usage.json` next to a skills root, keyed by skill name. Records
 * when a skill was created, how often it's been USED (a `read` of its SKILL.md,
 * detected off-hot-path in the gateway sweep), and its lifecycle state. The
 * curator anchors aging on the latest real activity (`lastUsedAt`), falling back
 * to `createdAt` so a brand-new skill isn't archived on sight.
 *
 * Design:
 *   - Sidecar, not SKILL.md frontmatter — keeps operational telemetry out of the
 *     user-/model-authored skill content.
 *   - Atomic write (tmp + rename); every mutation is BEST-EFFORT (a broken
 *     sidecar never breaks the underlying tool call or the sweep).
 *   - Provenance gate: only skills explicitly marked `createdBy:"agent"` (set on
 *     `manage_skill create` + the skill-review auto-learner) are curator-managed.
 *     A hand-dropped SKILL.md is never auto-archived — it has no record.
 *   - Injectable clock (`now` ms) so the curator + telemetry are deterministic in
 *     tests, exactly like the FactStore clock seam.
 *
 * Lifecycle states: active (default) → stale (unused > staleAfter) → archived
 * (unused > archiveAfter; the skill dir is moved aside by the curator). `pinned`
 * is an orthogonal opt-out from all auto-transitions.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";

const log = createSubsystemLogger("skills/usage");

export type SkillState = "active" | "stale" | "archived";
export const SKILL_STATE_ACTIVE: SkillState = "active";
export const SKILL_STATE_STALE: SkillState = "stale";
export const SKILL_STATE_ARCHIVED: SkillState = "archived";

export interface SkillUsageRecord {
	/** "agent" ⇒ created by manage_skill / the auto-learner ⇒ curator-managed.
	 *  Absent ⇒ a hand-authored skill the curator must never touch. */
	createdBy?: "agent";
	createdAt: string; // ISO
	useCount: number;
	lastUsedAt: string | null; // ISO; null ⇒ never used (anchor falls back to createdAt)
	/** Times the skill was refined in place (a patch is also "activity"). */
	patchCount: number;
	state: SkillState;
	pinned: boolean;
	archivedAt: string | null; // ISO
}

export type SkillUsageMap = Record<string, SkillUsageRecord>;

function usageFilePath(skillsRoot: string): string {
	return path.join(skillsRoot, ".usage.json");
}

function iso(nowMs: number): string {
	return new Date(nowMs).toISOString();
}

function emptyRecord(nowMs: number): SkillUsageRecord {
	return {
		createdAt: iso(nowMs),
		useCount: 0,
		lastUsedAt: null,
		patchCount: 0,
		state: SKILL_STATE_ACTIVE,
		pinned: false,
		archivedAt: null,
	};
}

/** Read the whole sidecar. Missing / corrupt → empty map (never throws). */
export function loadUsage(skillsRoot: string): SkillUsageMap {
	let raw: string;
	try {
		raw = fs.readFileSync(usageFilePath(skillsRoot), "utf8");
	} catch {
		return {};
	}
	try {
		const data = JSON.parse(raw) as unknown;
		if (!data || typeof data !== "object" || Array.isArray(data)) return {};
		const clean: SkillUsageMap = {};
		for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
			if (v && typeof v === "object" && !Array.isArray(v)) clean[k] = v as SkillUsageRecord;
		}
		return clean;
	} catch {
		return {};
	}
}

/** Write the sidecar atomically. Best-effort — a failure is logged, not thrown. */
export function saveUsage(skillsRoot: string, data: SkillUsageMap): void {
	const p = usageFilePath(skillsRoot);
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
		fs.renameSync(tmp, p);
	} catch (err) {
		log.warn("skill usage save failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

/** Backfill any missing fields so callers can index an old/partial record. */
function backfill(rec: SkillUsageRecord, nowMs: number): SkillUsageRecord {
	const base = emptyRecord(nowMs);
	return { ...base, ...rec };
}

/** Load → apply mutator in place → save. Best-effort; never throws. */
function mutate(skillsRoot: string, name: string, nowMs: number, fn: (rec: SkillUsageRecord) => void): void {
	if (!name) return;
	try {
		const data = loadUsage(skillsRoot);
		const rec = backfill(data[name] ?? emptyRecord(nowMs), nowMs);
		fn(rec);
		data[name] = rec;
		saveUsage(skillsRoot, data);
	} catch (err) {
		log.warn("skill usage mutate failed", { name, error: err instanceof Error ? err.message : String(err) });
	}
}

/** Mark a skill as agent-created (manage_skill / auto-learner) ⇒ curator-managed.
 *  Anchors `createdAt` the first time so the inactivity clock starts now. */
export function recordSkillCreated(skillsRoot: string, name: string, nowMs: number = Date.now()): void {
	mutate(skillsRoot, name, nowMs, (rec) => {
		rec.createdBy = "agent";
		// Keep the original createdAt if a record already existed; emptyRecord
		// already stamped now for a fresh one.
	});
}

/** Bump use_count + lastUsedAt — the curator's reactivation/aging signal. Called
 *  from the sweep when a skill's SKILL.md was read this window. Pure telemetry:
 *  the lifecycle FLIP (stale → active) is left to the curator's transition pass
 *  (record-only here; the curator reactivates). */
export function recordSkillUse(skillsRoot: string, name: string, nowMs: number = Date.now()): void {
	mutate(skillsRoot, name, nowMs, (rec) => {
		rec.useCount += 1;
		rec.lastUsedAt = iso(nowMs);
	});
}

/** Bump patchCount + lastUsedAt — a refinement is also activity, so a patched
 *  skill resets its staleness clock (the curator won't age out a skill we keep
 *  improving). Called by the manage_skill patch action + the skill-review patcher. */
export function recordSkillPatched(skillsRoot: string, name: string, nowMs: number = Date.now()): void {
	mutate(skillsRoot, name, nowMs, (rec) => {
		rec.patchCount = (rec.patchCount ?? 0) + 1;
		rec.lastUsedAt = iso(nowMs);
	});
}

export function setSkillState(skillsRoot: string, name: string, state: SkillState, nowMs: number = Date.now()): void {
	mutate(skillsRoot, name, nowMs, (rec) => {
		rec.state = state;
		if (state === SKILL_STATE_ARCHIVED) rec.archivedAt = iso(nowMs);
		else if (state === SKILL_STATE_ACTIVE) rec.archivedAt = null;
	});
}

export function setSkillPinned(skillsRoot: string, name: string, pinned: boolean, nowMs: number = Date.now()): void {
	mutate(skillsRoot, name, nowMs, (rec) => {
		rec.pinned = pinned;
	});
}

/** Drop a skill's record entirely — called when the skill is deleted. */
export function forgetSkill(skillsRoot: string, name: string): void {
	if (!name) return;
	try {
		const data = loadUsage(skillsRoot);
		if (name in data) {
			delete data[name];
			saveUsage(skillsRoot, data);
		}
	} catch {
		/* best-effort */
	}
}

/** The newest real-activity anchor for aging: lastUsedAt, falling back to
 *  createdAt (so a never-used skill ages from creation, not epoch). Returns ms. */
export function activityAnchorMs(rec: SkillUsageRecord): number {
	const t = rec.lastUsedAt ?? rec.createdAt;
	const ms = Date.parse(t);
	return Number.isFinite(ms) ? ms : 0;
}

export interface CurationCandidate {
	name: string;
	record: SkillUsageRecord;
}

/**
 * Curator-managed candidates: skills present on disk under `skillsRoot` whose
 * record is marked `createdBy:"agent"`. Hand-authored skills (no record / no
 * agent flag) are excluded — the curator never archives what the operator wrote
 * by hand. `state` is read from the record (defaults active).
 */
export function listCurationCandidates(skillsRoot: string, nowMs: number = Date.now()): CurationCandidate[] {
	const data = loadUsage(skillsRoot);
	const onDisk = onDiskSkillNames(skillsRoot);
	const out: CurationCandidate[] = [];
	for (const name of onDisk) {
		const rec = data[name];
		if (!rec || rec.createdBy !== "agent") continue; // only agent-created are managed
		out.push({ name, record: backfill(rec, nowMs) });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Skill directory names directly under a root (one level; ignores dotfiles like
 *  `.usage.json` / `.archive`). A dir counts as a skill only if it has SKILL.md. */
export function onDiskSkillNames(skillsRoot: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const names: string[] = [];
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith(".")) continue;
		if (fs.existsSync(path.join(skillsRoot, e.name, "SKILL.md"))) names.push(e.name);
	}
	return names;
}
