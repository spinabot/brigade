// src/agents/tools/manage-memory-tool.ts
//
// `manage_memory` — the operator's owner-gated handle on Tideline's Phase-3
// maintenance + governance (the live surface for the dream / purge / inspect /
// export / retention behaviours that are otherwise library-only). Operates on
// the OWNER origin (it's ownerOnly), constructing a FactStore over the agent's
// workspace exactly like the rest of the memory path — so it works in both
// filesystem and convex modes.

import * as fs from "node:fs";
import * as path from "node:path";

import { Type } from "typebox";

import { tryGetRuntimeContext } from "../../storage/runtime-context.js";
import { runDream } from "../memory/dream.js";
import { applyRetention, exportMemory, inspect, purge } from "../memory/governance.js";
import { FactStore, type MemoryRecordOrigin } from "../memory/records.js";
import { applyProposal, approve, type Proposal, proposeFromTelemetry, revertProposal } from "../memory/self-improve.js";
import { writeVault } from "../memory/vault.js";

const OWNER_ORIGIN = { kind: "owner" } as const;

/**
 * After a destructive shred (purge / retention) in FILESYSTEM mode, re-render + prune
 * the markdown vault so the shredded fact's PLAINTEXT note can't linger on disk — the
 * integrity counterpart to the crypto-shred. No-op when the vault was never created, or
 * in convex mode (no disk vault). Best-effort: a vault write failure must not fail the
 * shred that already succeeded (a stale note is the lesser problem, surfaced on next render).
 */
function repruneVaultAfterShred(workspaceDir: string, store: FactStore): void {
	if (tryGetRuntimeContext()?.mode === "convex") return;
	const dir = path.join(workspaceDir, "memory-vault");
	if (!fs.existsSync(dir)) return;
	try {
		writeVault(dir, store.listForVault(OWNER_ORIGIN), { prune: true });
	} catch {
		/* best-effort */
	}
}

import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

const OWNER: MemoryRecordOrigin = { kind: "owner" };

const Params = Type.Object({
	action: Type.Union(
		[
			Type.Literal("dream"),
			Type.Literal("purge"),
			Type.Literal("inspect"),
			Type.Literal("export"),
			Type.Literal("retention"),
			Type.Literal("vault"),
			Type.Literal("propose"),
			Type.Literal("retract"),
			Type.Literal("restore"),
		],
		{
			description:
				"dream: run a reflection pass (confirm repeated beliefs, merge duplicates, evict decayed). " +
				"purge: crypto-shred a fact AND everything derived from it (irreversible). " +
				"inspect: a fact's links/backlinks/provenance. export: dump your facts. " +
				"retention: hard-purge facts older than ttl_days (confirmed beliefs retained). " +
				"vault: write your memory out as an Obsidian-style markdown vault (preserves your hand edits). " +
				"propose: review behaviour-change suggestions drawn from your feedback. " +
				"retract: stop acting on a fact (reversible). restore: undo a retract.",
		},
	),
	memory_id: Type.Optional(Type.String({ description: "fact id — required for purge / inspect / retract / restore", maxLength: 128 })),
	ttl_days: Type.Optional(Type.Number({ description: "retention age threshold in days — required for action=retention", minimum: 1 })),
});

interface ManageMemoryResult {
	action: "dream" | "purge" | "inspect" | "export" | "retention" | "vault" | "propose" | "retract" | "restore";
	ok: boolean;
	message: string;
	[key: string]: unknown;
}

export function makeManageMemoryTool(workspaceDir: string): BrigadeTool<typeof Params, ManageMemoryResult> {
	const result = (r: ManageMemoryResult): AgentToolResult<ManageMemoryResult> =>
		jsonResult(r) as AgentToolResult<ManageMemoryResult>;

	return {
		name: "manage_memory",
		label: "Manage memory",
		displaySummary: "managing long-term memory",
		ownerOnly: true,
		description: [
			"Maintain + govern your long-term memory (owner only).",
			"action 'dream': run a reflection pass now — promote a repeatedly-asserted/corrected belief to a confirmed preference, merge near-duplicates, evict decayed facts.",
			"action 'purge': permanently crypto-shred the fact with `memory_id` AND every fact derived from it (no undo).",
			"action 'inspect': show `memory_id`'s content, typed links, backlinks, and citation graph.",
			"action 'export': dump all your stored facts.",
			"action 'retention': hard-purge facts older than `ttl_days` (confirmed beliefs are kept).",
			"action 'vault': save your memory as an Obsidian-style markdown vault, preserving your hand-pinned edits.",
			"action 'propose': review behaviour-change suggestions drawn from your feedback (down-votes); review-only.",
			"action 'retract': reversibly stop acting on the fact with `memory_id`. action 'restore': undo a retract.",
			"Call only on an explicit operator request.",
		].join(" "),
		parameters: Params,
		execute: async (_toolCallId, args): Promise<AgentToolResult<ManageMemoryResult>> => {
			const store = new FactStore(workspaceDir);

			switch (args.action) {
				case "dream": {
					const r = runDream(store, { origin: OWNER });
					return result({
						action: "dream",
						ok: true,
						confirmed: r.confirmed.length,
						consolidated: r.consolidated.length,
						evicted: r.evicted.length,
						reflected: r.reflected,
						message: `Reflection done: ${r.confirmed.length} confirmed, ${r.consolidated.length} merged, ${r.evicted.length} evicted (of ${r.reflected} active).`,
					});
				}
				case "purge": {
					if (!args.memory_id) return result({ action: "purge", ok: false, message: "memory_id is required for purge." });
					const r = purge(store, args.memory_id);
					if (r.purged.length > 0) repruneVaultAfterShred(workspaceDir, store);
					return result({
						action: "purge",
						ok: r.purged.length > 0,
						purged: r.purged,
						message: r.purged.length > 0
							? `Crypto-shredded ${r.purged.length} fact(s) (the target + any derived citations).`
							: `No fact found with id ${args.memory_id}.`,
					});
				}
				case "inspect": {
					if (!args.memory_id) return result({ action: "inspect", ok: false, message: "memory_id is required for inspect." });
					const info = inspect(store, args.memory_id);
					if (!info) return result({ action: "inspect", ok: false, message: `No fact found with id ${args.memory_id}.` });
					return result({
						action: "inspect",
						ok: true,
						content: info.record.content,
						segment: info.record.segment,
						status: info.record.status ?? "asserted",
						links: info.outbound,
						backlinks: info.backlinks,
						derivedFrom: info.derivedFrom,
						derives: info.derives,
						message: `Fact ${args.memory_id}: ${info.outbound.length} links, ${info.backlinks.length} backlinks, derived-from ${info.derivedFrom.length}, derives ${info.derives.length}.`,
					});
				}
				case "export": {
					const facts = exportMemory(store, { origin: OWNER });
					const activeCount = facts.filter((f) => f.lifecycle === "active").length;
					return result({
						action: "export",
						ok: true,
						count: facts.length,
						activeCount,
						facts: facts.map((f) => ({
							id: f.memoryId,
							content: f.content,
							segment: f.segment,
							status: f.status ?? "asserted",
							// lifecycle distinguishes a LIVE fact from SUPERSEDED history — without
							// it, archived facts render identically to active ones, so "show my
							// memory" looks cluttered with stale beliefs that recall never returns.
							lifecycle: f.lifecycle,
						})),
						message:
							`Exported ${facts.length} fact(s): ${activeCount} active, ` +
							`${facts.length - activeCount} superseded/archived (history — NOT returned by recall).`,
					});
				}
				case "retention": {
					if (!args.ttl_days || args.ttl_days < 1) {
						return result({ action: "retention", ok: false, message: "ttl_days (>= 1) is required for retention." });
					}
					const r = applyRetention(store, { ttlMs: args.ttl_days * 86_400_000, origin: OWNER });
					if (r.purged.length > 0) repruneVaultAfterShred(workspaceDir, store);
					return result({
						action: "retention",
						ok: true,
						purged: r.purged.length,
						message: `Retention: purged ${r.purged.length} fact(s) older than ${args.ttl_days} day(s) (confirmed beliefs kept).`,
					});
				}
				case "vault": {
					// Render the owner's active memory to an Obsidian-style markdown vault,
					// preserving any human-pinned edits (the 3-way merge). A filesystem
					// artifact: in convex mode the store is authoritative, so a disk vault
					// is skipped (it would just be a transient, un-synced render).
					if (tryGetRuntimeContext()?.mode === "convex") {
						return result({
							action: "vault",
							ok: false,
							message: "The markdown vault is a filesystem-mode feature (your memory lives in the database in this mode). Export with action 'export' instead.",
						});
					}
					const dir = path.join(workspaceDir, "memory-vault");
					// Active PLUS restorable-archived (retracted/decayed): a reversibly-
					// retracted fact's note — and the operator's hand-pinned edits on it —
					// must survive the prune (only a hard-purged fact's note is removed).
					const records = store.listForVault(OWNER);
					const w = writeVault(dir, records, { prune: true });
					return result({
						action: "vault",
						ok: true,
						written: w.written,
						mergedPinned: w.mergedPinned,
						dir,
						message: `Wrote ${w.written} note(s) to your vault${w.mergedPinned > 0 ? ` (kept your edits on ${w.mergedPinned})` : ""}.`,
					});
				}
				case "propose": {
					// Lane B — surface behaviour-change suggestions derived from your
					// feedback telemetry (down-votes). Review-only; acting on one is a
					// separate, explicit 'retract'. The telemetry log is filesystem-mode
					// only in this version, so be honest rather than silently empty.
					if (tryGetRuntimeContext()?.mode === "convex") {
						return result({
							action: "propose",
							ok: false,
							message: "Behaviour-change proposals are drawn from the local feedback log, which is a filesystem-mode feature in this version.",
						});
					}
					const proposals = proposeFromTelemetry(store.readEvents(), { minDownvotes: 3 });
					return result({
						action: "propose",
						ok: true,
						count: proposals.length,
						proposals: proposals.map((p) => ({ id: p.id, target: p.diff.target, rationale: p.rationale, change: `${p.diff.before} → ${p.diff.after}` })),
						message:
							proposals.length > 0
								? `${proposals.length} suggestion(s) from your feedback. Review, then 'retract' a fact's id if you agree (it's reversible).`
								: "No behaviour-change suggestions — nothing has been down-voted enough to warrant one.",
					});
				}
				case "retract": {
					// Reversibly stop acting on a fact. Runs the Lane-B human-gated state
					// machine in-process (the operator invoking this IS the approval):
					// propose → approve → reversible apply (archive). 'restore' undoes it.
					if (!args.memory_id) return result({ action: "retract", ok: false, message: "memory_id is required for retract." });
					const target = args.memory_id;
					let p: Proposal = {
						id: `prop:${target}`,
						rationale: "operator-approved retraction",
						diff: { kind: "preference", target, before: "active", after: "retracted" },
						status: "pending",
					};
					p = approve(p);
					p = applyProposal(p, (diff) => {
						const rec = store.invalidate(diff.target);
						return rec ? "active" : undefined;
					}, { appliedLedger: new Set<string>() });
					const applied = p.prior !== undefined;
					return result({
						action: "retract",
						ok: applied,
						message: applied
							? `Retracted ${target} — it will no longer surface in recall. Use action 'restore' with the same id to undo.`
							: `No active fact found with id ${target}.`,
					});
				}
				case "restore": {
					// The reversible counterpart — re-activate a retracted (archived) fact.
					// Routed through the Lane-B revert machinery for symmetry with retract.
					if (!args.memory_id) return result({ action: "restore", ok: false, message: "memory_id is required for restore." });
					const target = args.memory_id;
					let restored = false;
					const p: Proposal = {
						id: `prop:${target}`,
						rationale: "operator-requested restore",
						diff: { kind: "preference", target, before: "active", after: "retracted" },
						status: "applied",
						prior: "active",
					};
					revertProposal(p, () => {
						restored = store.reactivate(target) !== undefined;
					});
					return result({
						action: "restore",
						ok: restored,
						message: restored ? `Restored ${target} — it can surface in recall again.` : `No retracted fact found with id ${target}.`,
					});
				}
				default:
					return result({ action: "export", ok: false, message: "unknown action" });
			}
		},
	};
}
