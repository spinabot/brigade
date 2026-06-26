/**
 * Session-transcript hygiene behind the `sessions.cleanup` gateway RPC — the
 * `brigade sessions cleanup --older-than <duration>` surface, reachable from a
 * remote client.
 *
 * OPERATOR-SCOPED maintenance: deletes an agent's OWN idle transcript files
 * (`~/.brigade/agents/<id>/sessions/<sid>.jsonl`). It does NOT read or disclose
 * another agent's session CONTENT (unlike sessions.list/history/send, which are
 * guarded) — it only removes stale files the gateway regenerates on next
 * access. So no per-session access guard (allowlisted by name in the
 * guard-sweep).
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { DEFAULT_AGENT_ID, resolveSessionsDir } from "../config/paths.js";

interface SessionFile {
	sessionId: string;
	bytes: number;
	mtimeMs: number;
}

function listSessionFiles(agentId: string): SessionFile[] {
	const dir = resolveSessionsDir(agentId);
	if (!existsSync(dir)) return [];
	const rows: SessionFile[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			const st = statSync(path.join(dir, name));
			rows.push({ sessionId: name.replace(/\.jsonl$/, ""), bytes: st.size, mtimeMs: st.mtimeMs });
		} catch {
			/* ignore unreadable entries */
		}
	}
	return rows;
}

/** Parse a duration like "30d" / "12h" / "2w" into milliseconds. */
export function parseDuration(s: string): number | null {
	const m = s.match(/^(\d+)\s*(s|m|h|d|w)$/i);
	if (!m) return null;
	const n = Number(m[1]);
	const u = m[2]?.toLowerCase() ?? "d";
	const mul = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[u as "s"] ?? 0;
	return n * mul;
}

export interface SessionsCleanupResult {
	ok: boolean;
	agentId: string;
	candidates: number;
	deleted: number;
	dryRun: boolean;
	wouldDelete?: string[];
	reason?: string;
}
export function handleSessionsCleanup(params: unknown): SessionsCleanupResult {
	const p = (params ?? {}) as { agentId?: string; olderThan?: string; dryRun?: boolean };
	const agentId = (p.agentId ?? "").trim() || DEFAULT_AGENT_ID;
	const dryRun = !!p.dryRun;
	const ms = parseDuration((p.olderThan ?? "").trim());
	if (ms == null) {
		return {
			ok: false,
			agentId,
			candidates: 0,
			deleted: 0,
			dryRun,
			reason: `'olderThan' must look like "30d" / "12h" / "2w"`,
		};
	}
	const cutoff = Date.now() - ms;
	const stale = listSessionFiles(agentId).filter((r) => r.mtimeMs < cutoff);
	if (dryRun) {
		return { ok: true, agentId, candidates: stale.length, deleted: 0, dryRun: true, wouldDelete: stale.map((r) => r.sessionId) };
	}
	const dir = resolveSessionsDir(agentId);
	let deleted = 0;
	for (const r of stale) {
		try {
			rmSync(path.join(dir, `${r.sessionId}.jsonl`), { force: true });
			deleted++;
		} catch {
			/* best-effort — skip individual delete failures */
		}
	}
	return { ok: true, agentId, candidates: stale.length, deleted, dryRun: false };
}
