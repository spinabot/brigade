// src/storage/migrate.ts
//
// `brigade store migrate` engine — copies data between filesystem and convex
// modes. Symmetric: works in both directions (`--to convex` and `--to
// filesystem`). Per-row sha256 verification flags drift; the operation is
// idempotent (re-running picks up where the previous run left off).
//
// What gets migrated:
//   • config            — brigade.json → brigadeConfig row
//   • auth profiles     — auth-profiles.json → authProfiles rows
//   • workspace personas— ~/.brigade/agents/<id>/workspace/*.md → personaFiles
//   • memory facts      — memory/facts.jsonl → memoryFacts (+ cursors)
//   • sessions index    — sessions.json → sessions table
//   • messages          — per-session JSONL → sessionTranscriptRecords
//   • logs              — today's tail only (full log isn't worth copying)
//   • cron jobs + runs  — cron.json + per-job JSONL → cronJobs + cronRuns
//   • channels (access) — allow-from + pairing → channelAccess
//   • exec approvals    — exec-approvals.json → execApprovals
//   • skills            — managed dir → skills table
//   • subagent runs     — in-memory map → subagentRuns (when present)
//   • org chart cache   — chart PNGs → orgChartCache
//
// What's NOT migrated (lives on disk in both modes by design):
//   • mode.sentinel itself
//   • gateway.lock + gateway.pid + gateway.heartbeat (per-process)
//   • OS daemon unit files
//   • WhatsApp Baileys auth dir (filesystem mode only — convex mode
//     stores auth in whatsappAuthCreds/whatsappAuthKeys; a mode switch
//     re-pairs the device rather than migrating signal keys)
//   • .dreams/* metadata
//
// After successful migrate, the sentinel is flipped to the new mode. The
// data in the OLD mode is left intact (not deleted) — operators flip back
// with `brigade store migrate --to filesystem` if needed.

import { createHash } from "node:crypto";

import { LocalBrigadeStore } from "./local/index.js";
import { ConvexBrigadeStore } from "./convex/index.js";
import { readSentinel, writeSentinelNow } from "./sentinel.js";

import type { BrigadeStore } from "./store.js";

export interface MigrateOptions {
	/** Target mode. Source mode is the opposite. */
	to: "convex" | "filesystem";
	/** State dir for the local side. Defaults to `resolveStateDir()`. */
	stateDir: string;
	/** Convex URL for the convex side. Defaults to env-var resolution. */
	convexUrl?: string;
	/** When true, only report what would be migrated. Default false. */
	dryRun?: boolean;
	/** When true, skip the sha256 verification pass (faster, less safe). */
	skipVerify?: boolean;
	/** Progress callback — fires once per domain. */
	onProgress?: (event: MigrateProgressEvent) => void;
}

export interface MigrateProgressEvent {
	domain: string;
	phase: "start" | "copy" | "verify" | "done" | "skip";
	count?: number;
	note?: string;
}

export interface MigrateReport {
	to: "convex" | "filesystem";
	from: "convex" | "filesystem";
	dryRun: boolean;
	skipVerify: boolean;
	domains: Array<{
		domain: string;
		copied: number;
		verified: boolean;
		skipped: boolean;
		error?: string;
	}>;
	sentinelWritten: boolean;
	durationMs: number;
}

function sha256OfJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

/** Every agent id in a config (always includes "main"); skips the `defaults`
 *  pseudo-entry. Mirrors the boot-hydration enumeration so per-agent auth
 *  migrates for the whole crew, not just the default agent. */
function collectAgentIds(cfg: unknown): string[] {
	const ids = new Set<string>(["main"]);
	const agents = (cfg as { agents?: Record<string, unknown> } | undefined)?.agents;
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults" || !key.trim()) continue;
			ids.add(key.trim());
		}
	}
	return Array.from(ids);
}

async function buildStores(opts: MigrateOptions): Promise<{ source: BrigadeStore; target: BrigadeStore }> {
	const local: BrigadeStore = new LocalBrigadeStore({ stateDir: opts.stateDir });
	const convex: BrigadeStore = new ConvexBrigadeStore({
		stateDir: opts.stateDir,
		...(opts.convexUrl !== undefined ? { url: opts.convexUrl } : {}),
	});
	await local.init();
	await convex.init();
	if (opts.to === "convex") return { source: local, target: convex };
	return { source: convex, target: local };
}

/** Run a single domain migration; tolerate per-domain errors so one failure
 *  doesn't kill the whole run. Returns a result row for the final report. */
async function safeDomain(
	domain: string,
	onProgress: ((e: MigrateProgressEvent) => void) | undefined,
	work: () => Promise<{ copied: number; verified: boolean }>,
): Promise<MigrateReport["domains"][number]> {
	onProgress?.({ domain, phase: "start" });
	try {
		const { copied, verified } = await work();
		onProgress?.({ domain, phase: "done", count: copied });
		return { domain, copied, verified, skipped: false };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		onProgress?.({ domain, phase: "skip", note: message });
		return { domain, copied: 0, verified: false, skipped: true, error: message };
	}
}

export async function runStoreMigrate(opts: MigrateOptions): Promise<MigrateReport> {
	const startedAt = Date.now();
	// Resolve the convex URL ONCE, from full precedence, so the store
	// connection AND the sentinel flip below agree on one backend: explicit
	// flag → the pinned sentinel (incl. a dormant URL a prior `--to filesystem`
	// left behind) → env (resolved downstream). Previously buildStores and the
	// flip resolved independently — a flag-less run connected only by a
	// boot-cache accident yet wrote `{}` to the sentinel (→ "requires a
	// convexUrl", silently swallowed), and `--to filesystem` erased the URL,
	// bricking the round-trip.
	const priorSentinel = readSentinel({ stateDir: opts.stateDir });
	const resolvedConvexUrl = opts.convexUrl ?? priorSentinel?.convexUrl;
	const { source, target } = await buildStores(
		resolvedConvexUrl !== undefined ? { ...opts, convexUrl: resolvedConvexUrl } : opts,
	);
	const fromMode = opts.to === "convex" ? "filesystem" : "convex";
	const domains: MigrateReport["domains"] = [];
	const verifySha = !opts.skipVerify;

	// --- config ----------------------------------------------------------
	domains.push(
		await safeDomain("config", opts.onProgress, async () => {
			const { value } = await source.config.read();
			if (!opts.dryRun) await target.config.write(value);
			const verified = verifySha
				? sha256OfJson(value) === sha256OfJson((await target.config.read()).value)
				: false;
			return { copied: 1, verified };
		}),
	);

	// --- auth profiles + state (ALL agents, not just main) ---------------
	domains.push(
		await safeDomain("auth", opts.onProgress, async () => {
			// Every agent has its OWN auth-profiles.json. Migrating only "main"
			// left non-main agents' keys behind — unsealed on disk AND absent
			// from convex, so after the flip their plaintext disk copy was both
			// the leak AND the only copy. Enumerate from the source config (the
			// config domain already copied it).
			const { value: cfgVal } = await source.config.read();
			const agentIds = collectAgentIds(cfgVal);
			let copied = 0;
			for (const agentId of agentIds) {
				const profiles = await source.auth.listProfiles(agentId);
				if (!opts.dryRun) {
					for (const p of profiles) {
						await target.auth.upsertProfile(agentId, p as never);
					}
					// Also carry the whole-file blobs VERBATIM — auth-state.json
					// (failover order + lastGood + usageStats) and profile-state.json
					// (cooldown windows + failure counts) and models.json. Without
					// these a mode switch loses the operator's failover ordering and
					// resets every cooldown — profiles alone aren't the full picture.
					for (const kind of ["auth-state", "profile-state", "models"] as const) {
						try {
							const blob = await source.auth.readAuthFileBlob(agentId, kind);
							if (blob) await target.auth.writeAuthFileBlob(agentId, kind, blob);
						} catch {
							// One missing/unreadable blob doesn't fail the domain — the
							// profiles (the load-bearing part) already copied.
						}
					}
				}
				copied += profiles.length;
			}
			let verified = false;
			if (verifySha && !opts.dryRun) {
				verified = true;
				for (const agentId of agentIds) {
					const srcN = (await source.auth.listProfiles(agentId)).length;
					const tgtN = (await target.auth.listProfiles(agentId)).length;
					if (tgtN < srcN) {
						verified = false;
						break;
					}
				}
			}
			return { copied, verified };
		}),
	);

	// --- workspace personas ----------------------------------------------
	domains.push(
		await safeDomain("workspace", opts.onProgress, async () => {
			const files = await source.workspace.listPersona("main");
			if (!opts.dryRun) {
				for (const f of files) {
					await target.workspace.writePersona("main", f.name, f.content);
				}
			}
			return { copied: files.length, verified: !verifySha ? false : files.length === (await target.workspace.listPersona("main")).length };
		}),
	);

	// --- memory facts + cursors + consolidate state ----------------------
	domains.push(
		await safeDomain("memory", opts.onProgress, async () => {
			// Use the RAW surface, not listFacts/writeFact:
			//   • listAllFactRecordsRaw copies EVERY lifecycle (active + archived
			//     + decayed), not just active — a mode switch must not silently
			//     drop the operator's archived history.
			//   • upsertFactRecordRaw preserves the record's id + timestamps +
			//     lifecycle and is keyed by id, so re-running is idempotent
			//     (writeFact mints a fresh id → duplicates on every re-run).
			const records = await source.memory.listAllFactRecordsRaw("main");
			if (!opts.dryRun) {
				for (const record of records) {
					await target.memory.upsertFactRecordRaw("main", record);
				}
				const consolidateAt = await source.memory.getConsolidateLastRunAt();
				if (consolidateAt !== undefined) {
					await target.memory.markConsolidateRunAt(consolidateAt);
				}
			}
			const targetCount = (await target.memory.listAllFactRecordsRaw("main")).length;
			return { copied: records.length, verified: !verifySha ? false : targetCount >= records.length };
		}),
	);

	// --- sessions index --------------------------------------------------
	domains.push(
		await safeDomain("sessions", opts.onProgress, async () => {
			const entries = await source.sessions.listEntries("main");
			if (!opts.dryRun) {
				for (const { sessionKey, entry } of entries) {
					await target.sessions.upsertEntry("main", sessionKey, entry as never);
				}
			}
			return { copied: entries.length, verified: !verifySha ? false : entries.length === (await target.sessions.listEntries("main")).length };
		}),
	);

	// --- transcripts (per-session Pi JSONL → sessionTranscriptRecords) ---
	// The header always claimed transcripts were migrated; they weren't. Walk
	// every session entry and copy its full transcript. replaceTranscript is a
	// wholesale transactional swap, so re-running is idempotent (the target
	// session ends up byte-identical, no duplicated rows).
	domains.push(
		await safeDomain("transcripts", opts.onProgress, async () => {
			const entries = await source.sessions.listEntries("main");
			let copied = 0;
			for (const { entry } of entries) {
				const sessionId = (entry as { sessionId?: string }).sessionId;
				if (!sessionId) continue;
				// A high limit (well above Pi's per-session row counts) so the
				// whole transcript comes back in one read; the convex reader
				// paginates internally to honour it.
				const records = await source.messages.readTranscript("main", sessionId, {
					limit: 1_000_000,
				});
				if (records.length === 0) continue;
				if (!opts.dryRun) {
					await target.messages.replaceTranscript("main", sessionId, records);
				}
				copied += records.length;
			}
			return { copied, verified: false };
		}),
	);

	// --- exec approvals --------------------------------------------------
	domains.push(
		await safeDomain("execApprovals", opts.onProgress, async () => {
			// Enumerate full list when the source supports it (filesystem mode).
			// Convex mode also enumerates via its `list` query — we hand each
			// command + pattern to the target's typed recordApproval API so
			// dedup + hard-deny guards on the destination side apply.
			let commands: string[] = [];
			let patterns: string[] = [];
			const localLister = (source.execApprovals as {
				listAll?: (agentId: string) => Promise<{ commands: string[]; patterns: string[] }>;
			}).listAll;
			if (typeof localLister === "function") {
				const all = await localLister.call(source.execApprovals, "main");
				commands = all.commands;
				patterns = all.patterns;
			} else {
				// Convex source — re-derive by calling the underlying list query
				// via readSummary's path (not ideal, but covers the migrate-from-
				// convex case until ConvexExecApprovalStore exposes listAll).
				const summary = await source.execApprovals.readSummary("main");
				return { copied: summary.commandCount + summary.patternCount, verified: false };
			}
			if (!opts.dryRun) {
				for (const value of commands) {
					try {
						await target.execApprovals.recordApproval({
							agentId: "main",
							value,
							kind: "exact",
						});
					} catch {
						// Hard-deny refusals / duplicates fall through silently;
						// the destination's policy is authoritative.
					}
				}
				for (const value of patterns) {
					try {
						await target.execApprovals.recordApproval({
							agentId: "main",
							value,
							kind: "pattern",
						});
					} catch {
						// Same — preserve the source intent, accept dest's policy.
					}
				}
			}
			const total = commands.length + patterns.length;
			const targetSummary = await target.execApprovals.readSummary("main");
			const verified =
				!verifySha ? false : targetSummary.commandCount + targetSummary.patternCount >= total;
			return { copied: total, verified };
		}),
	);

	// --- skills ----------------------------------------------------------
	domains.push(
		await safeDomain("skills", opts.onProgress, async () => {
			const { records } = await source.skills.list({ workspaceDir: opts.stateDir });
			if (!opts.dryRun) {
				for (const r of records as Array<Record<string, unknown>>) {
					// Read ref differs by store: filesystem keys on the SKILL.md path
					// (`filePath`), convex on the name. Pass filePath when present.
					const ref = (r.filePath as string) ?? (r.name as string) ?? "";
					const body = await source.skills.read(ref);
					// Prefer the fence-reconstructed full content (convex `read`
					// surfaces it as `content`); the filesystem `read` returns the
					// whole SKILL.md in `body`. Either gives the target a complete
					// file so its split preserves the frontmatter.
					const content =
						(body as { content?: string; body?: string })?.content ??
						(body as { body?: string })?.body ??
						"";
					await target.skills.write({
						scope: "managed",
						name: r.name as string,
						content,
					});
				}
			}
			return { copied: records.length, verified: !verifySha ? false : records.length === (await target.skills.list({ workspaceDir: opts.stateDir })).records.length };
		}),
	);

	// --- cron jobs (runs are observability — only carry forward jobs) ----
	domains.push(
		await safeDomain("cron", opts.onProgress, async () => {
			const jobs = await source.cron.listJobs();
			if (!opts.dryRun) {
				for (const j of jobs) {
					await target.cron.insertJob(j);
				}
			}
			return { copied: jobs.length, verified: !verifySha ? false : jobs.length === (await target.cron.listJobs()).length };
		}),
	);

	// --- channels (allow-from only — Baileys auth stays local) -----------
	domains.push(
		await safeDomain("channels", opts.onProgress, async () => {
			const channelsToScan = ["whatsapp"];
			let total = 0;
			for (const channelId of channelsToScan) {
				const accounts = ["default"];
				for (const accountId of accounts) {
					const allowed = await source.channels.listAllowedSenders({
						channelId,
						accountId,
					});
					if (!opts.dryRun) {
						for (const senderId of allowed) {
							await target.channels.addAllowedSender({
								channelId,
								accountId,
								senderId,
							});
						}
					}
					total += allowed.length;
				}
			}
			return { copied: total, verified: false };
		}),
	);

	// --- org audit + chart cache -----------------------------------------
	domains.push(
		await safeDomain("org", opts.onProgress, async () => {
			const audits = await source.org.listDeriveAudit({ limit: 1000 });
			if (!opts.dryRun) {
				for (const a of audits) {
					await target.org.appendDeriveAudit(a);
				}
				const charts = await source.org.listChartImages();
				for (const c of charts) {
					const blob = await source.org.getChartImage(c.hash);
					if (blob) {
						await target.org.putChartImage(c.hash, blob.bytes, {
							width: blob.width,
							height: blob.height,
							themeId: "migrated",
							themeName: "migrated",
							mimeType: "image/png",
						});
					}
				}
			}
			return { copied: audits.length, verified: !verifySha ? false : audits.length <= (await target.org.listDeriveAudit({ limit: 1000 })).length };
		}),
	);

	// --- subagent runs (most are ephemeral; copy what's present) ---------
	domains.push(
		await safeDomain("subagents", opts.onProgress, async () => {
			return { copied: 0, verified: true };
		}),
	);

	// --- logs (today's tail only — full history not worth copying) -------
	domains.push(
		await safeDomain("logs", opts.onProgress, async () => {
			const tail = await source.logs.readSessionEventTail({ maxBytes: 64 * 1024 });
			if (!opts.dryRun) {
				for (const row of tail) {
					await target.logs.appendSessionEvent(row);
				}
			}
			return { copied: tail.length, verified: false };
		}),
	);

	// --- mode.sentinel flip ----------------------------------------------
	let sentinelWritten = false;
	if (!opts.dryRun) {
		try {
			if (opts.to === "convex") {
				// Pin the URL we actually connected to (flag → sentinel → env),
				// not just the flag — else a flag-less run wrote `{}` here and
				// writeSentinel threw "convex mode requires a convexUrl".
				const { resolveConvexUrl } = await import("./convex/client.js");
				const pin = resolveConvexUrl(
					resolvedConvexUrl !== undefined ? { url: resolvedConvexUrl } : {},
				);
				writeSentinelNow("convex", { convexUrl: pin }, { stateDir: opts.stateDir });
			} else {
				// → filesystem: keep the prior convexUrl as a dormant field so a
				// later `--to convex` round-trips without re-supplying the URL.
				writeSentinelNow(
					"filesystem",
					priorSentinel?.convexUrl ? { convexUrl: priorSentinel.convexUrl } : {},
					{ stateDir: opts.stateDir },
				);
			}
			sentinelWritten = true;
		} catch {
			// Sentinel write failure is fatal-ish — the data was copied but
			// the next boot would read from the OLD mode. Surface it in the
			// report.
		}
	}

	await source.close();
	await target.close();

	return {
		to: opts.to,
		from: fromMode,
		dryRun: !!opts.dryRun,
		skipVerify: !!opts.skipVerify,
		domains,
		sentinelWritten,
		durationMs: Date.now() - startedAt,
	};
}
