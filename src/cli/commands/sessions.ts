/**
 * `brigade sessions list / cleanup` — daemon-grade transcript hygiene.
 *
 * Sessions live at `~/.brigade/agents/<agentId>/sessions/<sessionId>.jsonl` and
 * are tracked in `sessions.json`. Over time idle sessions accumulate — this
 * command lists them with size + mtime, and `cleanup --older-than <duration>`
 * deletes the transcripts. The session-store entry isn't touched (the gateway
 * regenerates it on next access).
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { DEFAULT_AGENT_ID, resolveSessionsDir } from "../../config/paths.js";

interface SessionRow {
	sessionId: string;
	bytes: number;
	mtimeIso: string;
	ageDays: number;
}

function listSessions(agentId: string): SessionRow[] {
	const dir = resolveSessionsDir(agentId);
	if (!existsSync(dir)) return [];
	const now = Date.now();
	const rows: SessionRow[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const full = path.join(dir, name);
		try {
			const st = statSync(full);
			rows.push({
				sessionId: name.replace(/\.jsonl$/, ""),
				bytes: st.size,
				mtimeIso: new Date(st.mtimeMs).toISOString(),
				ageDays: Math.floor((now - st.mtimeMs) / (1000 * 60 * 60 * 24)),
			});
		} catch {
			/* ignore */
		}
	}
	rows.sort((a, b) => Date.parse(b.mtimeIso) - Date.parse(a.mtimeIso));
	return rows;
}

/** Parse a duration like "30d" / "12h" / "2w" into milliseconds. */
function parseDuration(s: string): number | null {
	const m = s.match(/^(\d+)\s*(s|m|h|d|w)$/i);
	if (!m) return null;
	const n = Number(m[1]);
	const u = m[2]?.toLowerCase() ?? "d";
	const mul = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[u as "s"] ?? 0;
	return n * mul;
}

export async function runSessionsList(
	args: { agent?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const agentId = args.agent ?? DEFAULT_AGENT_ID;
	const rows = listSessions(agentId);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ agent: agentId, sessions: rows }, null, 2)}\n`);
		return 0;
	}
	if (rows.length === 0) {
		process.stdout.write(`No sessions for agent "${agentId}".\n`);
		return 0;
	}
	process.stdout.write(`${"SESSION".padEnd(38)} ${"AGE".padEnd(8)} ${"BYTES".padStart(10)}  MTIME\n`);
	for (const r of rows) {
		process.stdout.write(
			`${r.sessionId.padEnd(38)} ${`${r.ageDays}d`.padEnd(8)} ${String(r.bytes).padStart(10)}  ${r.mtimeIso}\n`,
		);
	}
	return 0;
}

export async function runSessionsCleanup(
	args: { agent?: string; olderThan: string; dryRun?: boolean },
	opts: { json?: boolean } = {},
): Promise<number> {
	const agentId = args.agent ?? DEFAULT_AGENT_ID;
	const ms = parseDuration(args.olderThan);
	if (ms == null) {
		process.stderr.write(`--older-than must look like "30d" / "12h" / "2w" (got ${JSON.stringify(args.olderThan)}).\n`);
		return 2;
	}
	const cutoff = Date.now() - ms;
	const rows = listSessions(agentId).filter((r) => Date.parse(r.mtimeIso) < cutoff);
	if (args.dryRun) {
		if (opts.json) process.stdout.write(`${JSON.stringify({ wouldDelete: rows }, null, 2)}\n`);
		else process.stdout.write(`Would delete ${rows.length} session(s) older than ${args.olderThan}.\n`);
		return 0;
	}
	let deleted = 0;
	for (const r of rows) {
		const full = path.join(resolveSessionsDir(agentId), `${r.sessionId}.jsonl`);
		try {
			rmSync(full, { force: true });
			deleted++;
		} catch {
			/* ignore individual delete failures */
		}
	}
	if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, deleted, candidates: rows.length })}\n`);
	else process.stdout.write(`Deleted ${deleted}/${rows.length} session transcript(s).\n`);
	return 0;
}
