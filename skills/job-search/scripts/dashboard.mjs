#!/usr/bin/env node
/**
 * job-search dashboard — a read-only local web view of the tracker ledger.
 *
 * Part of the bundled `job-search` skill. Serves the same applications.json
 * the tracker script maintains as a small status page: funnel, follow-ups,
 * and the full application table. Design constraints, on purpose:
 *
 *   - READ-ONLY. The dashboard never writes the ledger; status changes go
 *     through tracker.mjs so every change lands in the history.
 *   - LOOPBACK ONLY by default (127.0.0.1), so the page is not reachable
 *     from the network. `--host`/`--port` exist for the rare exception.
 *   - ZERO DEPENDENCIES and zero client-side JavaScript: one stylesheet,
 *     no scripts, no external requests (a strict CSP enforces it).
 *   - FRESH READS. The ledger is re-read on every request, so edits made
 *     by the tracker (or the agent) show up on the next refresh.
 *
 * Usage:
 *   dashboard.mjs [--db <path>] [--host <addr>] [--port <1-65535>]
 *
 * Exit codes: 0 ok | 1 usage error | 2 data/environment error
 * (corrupt ledger, bind failure)
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

/** Fixed status vocabulary, in pipeline order (must match tracker.mjs). */
const STATUSES = ["applied", "screening", "interview", "offer", "rejected", "withdrawn", "accepted"];
/** A terminal status means the hunt is over for that application. */
const TERMINAL = new Set(["rejected", "withdrawn", "accepted"]);
/** Statuses that count as "a human replied" for the response rate. */
const RESPONDED = new Set(["screening", "interview", "offer", "rejected", "accepted"]);
/** What to do next, per status (must match tracker.mjs). */
const NEXT_ACTION = {
	applied: "Nudge: a short follow-up is overdue",
	screening: "Check in on next steps",
	interview: "Send a thank-you / check stage progress",
	offer: "Decision pending — respond, negotiate, or decline",
};
/** Applications quiet for at least this many days land in "Needs attention". */
const STALE_DAYS = 7;

const USAGE = `Usage: dashboard.mjs [--db <path>] [--host <addr>] [--port <1-65535>]

Serves a read-only local web view of the job-search ledger (funnel,
follow-ups, full table). Binds to 127.0.0.1 on an ephemeral port by
default and prints the URL. Ctrl-C stops it.

  --db <path>       ledger file (default: <cwd>/job-search/applications.json)
  --host <addr>     bind address (default: 127.0.0.1 — loopback only)
  --port <1-65535>  fixed port (default: 0 — OS-assigned ephemeral port)

The dashboard never writes the ledger; use tracker.mjs to change anything.`;

/**
 * A ledger problem the user should fix (corrupt file, unreadable path).
 * Distinct from usage errors so exit-code semantics match the tracker.
 */
class LedgerError extends Error {}

function die(message, code = 1) {
	process.stderr.write(`dashboard: ${message}\n`);
	process.exit(code);
}

/** Escape a value for safe interpolation into HTML text or a double-quoted attribute. */
function esc(value) {
	return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Parse argv; any unrecognized flag or stray positional is a usage error. */
function parseArgs(argv) {
	const out = { host: "127.0.0.1", port: 0, db: undefined, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") {
			out.help = true;
		} else if (a === "--host") {
			const v = argv[++i];
			if (v === undefined) die("--host requires a value");
			out.host = v;
		} else if (a === "--port") {
			const v = argv[++i];
			if (v === undefined) die("--port requires a value");
			if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) die(`--port must be a whole number between 1 and 65535 (got "${v}")`);
			out.port = Number(v);
		} else if (a === "--db") {
			const v = argv[++i];
			if (v === undefined) die("--db requires a path");
			out.db = v;
		} else {
			die(`unknown argument "${a}"\n\n${USAGE}`);
		}
	}
	return out;
}

/** Today as a local YYYY-MM-DD string. */
function todayISO() {
	const d = new Date();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Whole calendar days from date `a` (older) to date `b` (newer). */
function daysBetween(a, b) {
	const pa = a.split("-").map(Number);
	const pb = b.split("-").map(Number);
	const da = new Date(pa[0], pa[1] - 1, pa[2]);
	const db = new Date(pb[0], pb[1] - 1, pb[2]);
	return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/** Accept only real calendar dates in YYYY-MM-DD form. */
function isRealDate(s) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const [y, m, d] = s.split("-").map(Number);
	const dt = new Date(y, m - 1, d);
	return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Days since `date`, or null when the stamp is not a valid calendar date. */
function daysSince(date, today) {
	return typeof date === "string" && isRealDate(date) ? daysBetween(date, today) : null;
}

/**
 * Load + validate the ledger. Missing file = empty ledger (same contract as
 * the tracker). Anything unreadable or malformed raises LedgerError — the
 * dashboard refuses to guess at half-valid data.
 */
function loadLedger(dbPath) {
	let raw;
	try {
		raw = fs.readFileSync(dbPath, "utf8");
	} catch (err) {
		if (err instanceof Error && err.code === "ENOENT") return { version: 1, nextId: 1, applications: [] };
		throw new LedgerError(`cannot read ledger ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.applications)) {
			throw new Error("not a job-search ledger (missing applications array)");
		}
		return parsed;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		if (reason.startsWith("cannot read ledger")) throw err;
		throw new LedgerError(`ledger ${dbPath} is corrupt (${reason}). Restore it from a backup or move it aside; refusing to display partial data.`);
	}
}

/** Funnel/response numbers, mirroring tracker.mjs `stats`. */
function computeStats(applications) {
	const byStatus = {};
	for (const s of STATUSES) byStatus[s] = 0;
	for (const r of applications) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
	const total = applications.length;
	const active = applications.filter((r) => !TERMINAL.has(r.status)).length;
	const responded = applications.filter((r) => RESPONDED.has(r.status)).length;
	return {
		total,
		byStatus,
		active,
		responses: responded,
		responseRate: total === 0 ? "n/a" : `${Math.round((responded / total) * 100)}%`,
	};
}

/** Most-recent-first records with derived per-row fields for table + follow-ups. */
function enrich(applications, today) {
	return [...applications]
		.sort((a, b) => {
			if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
			return Number(b.id) - Number(a.id);
		})
		.map((r) => {
			const days = daysSince(r.updatedAt, today);
			const isStale = !TERMINAL.has(r.status) && days !== null && days >= STALE_DAYS;
			return {
				id: r.id,
				company: r.company,
				role: r.role,
				status: r.status,
				location: r.location ?? "",
				url: r.url ?? "",
				source: r.source ?? "",
				createdAt: r.createdAt,
				updatedAt: r.updatedAt,
				daysSinceActivity: days,
				followUp: isStale ? (NEXT_ACTION[r.status] ?? "Follow up") : null,
				historyCount: Array.isArray(r.history) ? r.history.length : 0,
			};
		});
}

/** A href is only rendered when the URL is a real http(s) link; anything else stays text. */
function linkOrText(url) {
	if (typeof url !== "string" || url === "") return "";
	if (!/^https?:\/\//i.test(url)) return esc(url);
	return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">posting</a>`;
}

/** Fixed whitelist of status badge classes; unknown statuses fall back to neutral. */
function badge(status) {
	const known = STATUSES.includes(status) ? status : "other";
	return `<span class="badge st-${known}">${esc(status)}</span>`;
}

function renderFollowups(stale) {
	if (stale.length === 0) {
		return `<p class="empty">Nothing is stale — every active application had activity within the last ${STALE_DAYS} day(s).</p>`;
	}
	const rows = stale
		.map(
			(r) => `<tr>
	<td><code>#${esc(r.id)}</code></td>
	<td>${esc(r.company)}</td>
	<td>${esc(r.role)}</td>
	<td>${badge(r.status)}</td>
	<td class="num">${r.daysSinceActivity === null ? "—" : `${r.daysSinceActivity}d`}</td>
	<td>${esc(r.followUp ?? "Follow up")}</td>
</tr>`,
		)
		.join("\n");
	return `<table>
	<thead><tr><th>ID</th><th>Company</th><th>Role</th><th>Status</th><th>Quiet</th><th>Suggested action</th></tr></thead>
	<tbody>${rows}</tbody>
</table>`;
}

function renderTable(records) {
	if (records.length === 0) {
		return `<p class="empty">No applications yet — add the first one with <code>tracker.mjs add --company … --role …</code> and refresh.</p>`;
	}
	const rows = records
		.map(
			(r) => `<tr>
	<td><code>#${esc(r.id)}</code></td>
	<td>${esc(r.company)}</td>
	<td>${esc(r.role)}</td>
	<td>${badge(r.status)}</td>
	<td>${esc(r.createdAt)}</td>
	<td>${esc(r.updatedAt)}</td>
	<td class="num">${r.daysSinceActivity === null ? "—" : `${r.daysSinceActivity}d`}</td>
	<td>${linkOrText(r.url)}</td>
</tr>`,
		)
		.join("\n");
	return `<table>
	<thead><tr><th>ID</th><th>Company</th><th>Role</th><th>Status</th><th>Applied</th><th>Updated</th><th>Quiet</th><th>Link</th></tr></thead>
	<tbody>${rows}</tbody>
</table>`;
}

const STYLE = `:root {
	color-scheme: light dark;
	--ink: #1c2430;
	--muted: #5b6b7c;
	--line: #d8e0e8;
	--panel: #f6f8fa;
	--accent: #2563eb;
}
* { box-sizing: border-box; }
body {
	margin: 0 auto;
	padding: 1.25rem 1.5rem 3rem;
	max-width: 60rem;
	font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
	color: var(--ink);
	background: #fff;
}
header h1 { margin: 0; font-size: 1.45rem; }
header .sub { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.85rem; overflow-wrap: anywhere; }
header code { background: var(--panel); padding: 0.05rem 0.3rem; border-radius: 4px; }
section { margin-top: 1.75rem; }
h2 { font-size: 1rem; margin: 0 0 0.6rem; }
.stats { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.25rem; }
.stat { flex: 1 1 8rem; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 0.6rem 0.9rem; }
.stat .num { display: block; font-size: 1.5rem; font-weight: 650; }
.stat .lbl { color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
thead th { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--muted); }
tbody th { font-weight: 600; }
td.num, th.num { text-align: right; white-space: nowrap; }
.bar { width: 40%; min-width: 10rem; }
progress { width: 100%; height: 0.7rem; accent-color: var(--accent); }
.badge { display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; border: 1px solid var(--line); background: var(--panel); }
.st-applied { background: #eef2ff; border-color: #c7d2fe; }
.st-screening { background: #e0f2fe; border-color: #bae6fd; }
.st-interview { background: #fef3c7; border-color: #fde68a; }
.st-offer { background: #dcfce7; border-color: #bbf7d0; }
.st-accepted { background: #16a34a; border-color: #16a34a; color: #fff; }
.st-rejected { background: #fee2e2; border-color: #fecaca; }
.st-withdrawn { background: #e5e7eb; border-color: #d1d5db; }
.empty { color: var(--muted); }
.terminal { color: var(--muted); font-size: 0.85rem; }
footer { margin-top: 2.5rem; color: var(--muted); font-size: 0.78rem; border-top: 1px solid var(--line); padding-top: 0.8rem; }
a { color: var(--accent); }
@media (prefers-color-scheme: dark) {
	:root { --line: #2a3441; --panel: #171e27; --muted: #94a5b8; }
	body { background: #10151c; color: #e7edf4; }
	header code { background: var(--panel); }
}`;

/** The whole page; every ledger-derived value passes through esc(). */
function renderPage(dbPath, stats, stale, records, generatedAt) {
	const stages = STATUSES.filter((s) => !TERMINAL.has(s));
	const max = Math.max(1, ...stages.map((s) => stats.byStatus[s] ?? 0));
	const funnelRows = stages
		.map(
			(s) => `<tr>
			<th scope="row">${s}</th>
			<td class="num">${stats.byStatus[s] ?? 0}</td>
			<td class="bar"><progress value="${stats.byStatus[s] ?? 0}" max="${max}"></progress></td>
		</tr>`,
		)
		.join("\n");
	const terminalBadges = STATUSES.filter((s) => TERMINAL.has(s))
		.map((s) => `<span class="badge st-${s}">${s} ${stats.byStatus[s] ?? 0}</span>`)
		.join(" ");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="30">
<title>Job search — dashboard</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
	<h1>💼 Job search</h1>
	<p class="sub">read-only view of <code>${esc(dbPath)}</code> · auto-refreshes every 30s · <a href="/">refresh now</a></p>
</header>
<section class="stats">
	<div class="stat"><span class="num">${stats.total}</span><span class="lbl">total</span></div>
	<div class="stat"><span class="num">${stats.active}</span><span class="lbl">active</span></div>
	<div class="stat"><span class="num">${stats.responses}</span><span class="lbl">responses</span></div>
	<div class="stat"><span class="num">${esc(stats.responseRate)}</span><span class="lbl">response rate</span></div>
</section>
<section>
	<h2>Funnel</h2>
	<table>
		<thead><tr><th>Stage</th><th class="num">Count</th><th></th></tr></thead>
		<tbody>${funnelRows}</tbody>
	</table>
	<p class="terminal">${terminalBadges}</p>
</section>
<section>
	<h2>Needs attention (no activity for ≥ ${STALE_DAYS}d)</h2>
	${renderFollowups(stale)}
</section>
<section>
	<h2>Applications</h2>
	${renderTable(records)}
</section>
<footer>Generated ${esc(generatedAt)} · status changes go through <code>tracker.mjs</code> — the dashboard never writes the ledger.</footer>
</body>
</html>
`;
}

/** Headers every response carries: the page is local, static, and script-free. */
function securityHeaders(contentType) {
	return {
		"Content-Type": contentType,
		"Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "no-store",
	};
}

function send(res, status, body, contentType, isHead) {
	const headers = securityHeaders(contentType);
	headers["Content-Length"] = String(Buffer.byteLength(body));
	res.writeHead(status, headers);
	res.end(isHead ? undefined : body);
}

/** Handle one request; throws only become a 500 through the caller's guard. */
function route(req, res, dbPath, isHead) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const routePath = url.pathname.replace(/\/+$/, "") || "/";

	if (routePath === "/healthz") {
		send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8", isHead);
		return;
	}
	if (routePath === "/style.css") {
		send(res, 200, STYLE, "text/css; charset=utf-8", isHead);
		return;
	}
	if (routePath !== "/" && routePath !== "/index.html" && routePath !== "/data") {
		send(res, 404, "not found\n", "text/plain; charset=utf-8", isHead);
		return;
	}

	let ledger;
	try {
		ledger = loadLedger(dbPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const body = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Job search — ledger error</title><link rel="stylesheet" href="style.css"></head><body><h1>Ledger unavailable</h1><p>${esc(message)}</p><p><a href="/">Retry</a></p></body></html>\n`;
		send(res, 500, body, "text/html; charset=utf-8", isHead);
		return;
	}

	const today = todayISO();
	const stats = computeStats(ledger.applications);
	const records = enrich(ledger.applications, today);
	const stale = records.filter((r) => r.followUp !== null);

	if (routePath === "/data") {
		send(
			res,
			200,
			`${JSON.stringify({ ledgerPath: dbPath, generatedAt: new Date().toISOString(), stats, followups: stale, records }, null, 2)}\n`,
			"application/json; charset=utf-8",
			isHead,
		);
		return;
	}
	send(res, 200, renderPage(dbPath, stats, stale, records, new Date().toISOString().replace("T", " ").slice(0, 16)), "text/html; charset=utf-8", isHead);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(`${USAGE}\n`);
		process.exit(0);
	}
	const dbPath = path.resolve(args.db ?? path.join(process.cwd(), "job-search", "applications.json"));

	// Fail fast on a corrupt ledger before binding the port (exit 2, like the tracker).
	try {
		loadLedger(dbPath);
	} catch (err) {
		if (err instanceof LedgerError) die(err.message, 2);
		throw err;
	}

	const server = http.createServer((req, res) => {
		const isHead = req.method === "HEAD";
		if (req.method !== "GET" && !isHead) {
			res.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
			res.end();
			return;
		}
		try {
			route(req, res, dbPath, isHead);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			send(res, 500, `internal error: ${message}\n`, "text/plain; charset=utf-8", isHead);
		}
	});

	server.on("error", (err) => {
		die(`cannot start dashboard server: ${err instanceof Error ? err.message : String(err)}`, 2);
	});
	server.listen(args.port, args.host, () => {
		const addr = server.address();
		const port = typeof addr === "object" && addr !== null ? addr.port : args.port;
		process.stdout.write(`job-search dashboard: http://${args.host}:${port}/ (ledger: ${dbPath})\n`);
	});
}

main();
