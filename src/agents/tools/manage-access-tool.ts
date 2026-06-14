/**
 * `manage_access` tool — owner-only agent-to-agent access control.
 *
 * Why this tool exists (production, 2026-06-11)
 * ---------------------------------------------
 * Asked to message another agent, the model correctly found A2A blocked,
 * then had NO sanctioned way to change the knobs that gate it
 * (`session.sessionTools.visibility`, `session.agentToAgent.enabled/allow`,
 * `org.a2a.mode`). The `org` tool only edits department/reportsTo/role/bio;
 * `manage_agent` only does agents. So the model fell back to "hand-edit
 * brigade.json" — which the path-write / config-write guards correctly
 * refuse. The result: blocked both ways, dead end. This tool closes that
 * gap with the SAME atomic-config write the org/manage_agent tools use, so
 * "let main message marketing-lead" is one validated call instead of an
 * impossible hand-edit.
 *
 * Owner-only by design: only an operator-driven turn can widen who-can-talk-
 * to-whom; a channel peer can never escalate its own reach. The model should
 * call this ONLY when the operator explicitly asks to change A2A access, and
 * should report exactly what changed (like `manage_provider`).
 *
 * The three knobs and how they interact (cross-agent `sessions_send`):
 *   - `visibility` (session.sessionTools.visibility): "self" (default) hides
 *     other agents' sessions entirely; "all" is required for ANY cross-agent
 *     reach. The first gate.
 *   - `a2aEnabled` (session.agentToAgent.enabled): the second gate. With it
 *     off, cross-agent send is refused even under visibility "all".
 *   - `a2aMode` (org.a2a.mode, only when an org is configured): "derived"
 *     (default) restricts reach to org-graph edges (escalate up / assign
 *     down / same-dept / top↔all); "explicit" ignores the graph and uses the
 *     flat `agentToAgent.allow` matrix; "open" = everyone↔everyone. A
 *     non-org orchestrator like `main` that isn't a graph member can only
 *     reach others under "explicit" (+ an allow rule) or "open".
 */

import { Type } from "typebox";

import { loadConfig } from "../../core/config.js";
import { mutateConfigAtomic, type BrigadeConfig } from "../../config/io.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

const VISIBILITIES = ["self", "tree", "agent", "all"] as const;
const A2A_MODES = ["derived", "explicit", "open"] as const;
const WIDE_OPEN_ALLOW = [{ from: "*", to: "*" }];

const ManageAccessParams = Type.Object({
	action: Type.Union([Type.Literal("show"), Type.Literal("set")], {
		description:
			"show: print the current agent-to-agent access settings. set: change one or more of them (pass only what you want to change).",
	}),
	visibility: Type.Optional(
		Type.Union(
			VISIBILITIES.map((v) => Type.Literal(v)),
			{
				description:
					'session.sessionTools.visibility. "all" is required for ANY cross-agent reach; "self" (default) hides other agents.',
			},
		),
	),
	a2aEnabled: Type.Optional(
		Type.Boolean({
			description: "session.agentToAgent.enabled — the master switch for cross-agent messaging.",
		}),
	),
	a2aMode: Type.Optional(
		Type.Union(
			A2A_MODES.map((m) => Type.Literal(m)),
			{
				description:
					'org.a2a.mode (only when an org is configured). "derived" = org-graph edges only; "explicit" = flat agentToAgent.allow matrix; "open" = everyone. A non-org orchestrator (e.g. main) needs "explicit" or "open" to reach org members.',
			},
		),
	),
	allowAll: Type.Optional(
		Type.Boolean({
			description:
				'Convenience: set session.agentToAgent.allow to the wide-open [{from:"*",to:"*"}] matrix (every agent may message every agent). Auto-applied when a2aEnabled is turned on and no allow list exists yet.',
		}),
	),
});

interface AccessSnapshot {
	visibility: string;
	a2aEnabled: boolean;
	a2aAllow: Array<{ from: string; to: string }>;
	orgConfigured: boolean;
	a2aMode: string | null;
}

interface ManageAccessResult {
	action: "show" | "set";
	ok: boolean;
	message: string;
	before?: AccessSnapshot;
	after?: AccessSnapshot;
	settings?: AccessSnapshot;
}

export function makeManageAccessTool(): BrigadeTool<
	typeof ManageAccessParams,
	ManageAccessResult
> {
	return {
		name: "manage_access",
		label: "Manage Access",
		displaySummary: "managing agent-to-agent access",
		ownerOnly: true,
		description: [
			"Owner-only agent-to-agent access control. Use this to read or change who-can-message-whom — NEVER hand-edit brigade.json (the guards refuse it).",
			"WHEN cross-agent sessions_send is refused and the OPERATOR asks you to enable it: call manage_access set with the knob(s) the refusal named (visibility / a2aEnabled / a2aMode). Then report exactly what changed.",
			'show: returns {visibility, a2aEnabled, a2aAllow, orgConfigured, a2aMode}.',
			'set: change any of visibility ("all" for cross-agent reach), a2aEnabled (master switch), a2aMode ("explicit" lets a non-org agent like main reach org members; only valid when an org exists), allowAll (wide-open allow matrix). Pass only what changes.',
			"Do NOT call this proactively to widen your own reach — only on explicit operator request.",
		].join(" "),
		parameters: ManageAccessParams,
		execute: async (
			_toolCallId,
			args,
		): Promise<AgentToolResult<ManageAccessResult>> => {
			if (args.action === "show") {
				const snap = readAccessSnapshot(loadConfig() as BrigadeConfig);
				return jsonResult({
					action: "show",
					ok: true,
					settings: snap,
					message: describeSnapshot(snap),
				} satisfies ManageAccessResult) as AgentToolResult<ManageAccessResult>;
			}

			// action === "set"
			const wantsVisibility = args.visibility !== undefined;
			const wantsEnabled = args.a2aEnabled !== undefined;
			const wantsMode = args.a2aMode !== undefined;
			const wantsAllowAll = args.allowAll === true;
			if (!wantsVisibility && !wantsEnabled && !wantsMode && !wantsAllowAll) {
				return jsonResult({
					action: "set",
					ok: false,
					message:
						"manage_access set: nothing to change — pass at least one of visibility / a2aEnabled / a2aMode / allowAll.",
				} satisfies ManageAccessResult) as AgentToolResult<ManageAccessResult>;
			}

			const before = readAccessSnapshot(loadConfig() as BrigadeConfig);

			// a2aMode lives under org — refuse cleanly when no org exists rather
			// than writing an org block the rest of the system doesn't expect.
			if (wantsMode && !before.orgConfigured) {
				return jsonResult({
					action: "set",
					ok: false,
					before,
					message:
						"manage_access set: a2aMode lives under the org config, but no org is configured. Run org({action:'init', template:'…'}) first, or change visibility / a2aEnabled instead.",
				} satisfies ManageAccessResult) as AgentToolResult<ManageAccessResult>;
			}

			const next = await mutateConfigAtomic((current: BrigadeConfig) => {
				const merged: BrigadeConfig = { ...current };
				const session = {
					...((merged.session as Record<string, unknown> | undefined) ?? {}),
				} as Record<string, unknown>;

				if (wantsVisibility) {
					session.sessionTools = {
						...((session.sessionTools as Record<string, unknown> | undefined) ?? {}),
						visibility: args.visibility,
					};
				}

				if (wantsEnabled || wantsAllowAll) {
					const a2a = {
						...((session.agentToAgent as Record<string, unknown> | undefined) ?? {}),
					} as { enabled?: boolean; allow?: Array<{ from: string; to: string }> };
					if (wantsEnabled) a2a.enabled = args.a2aEnabled;
					const hasAllow = Array.isArray(a2a.allow) && a2a.allow.length > 0;
					// Seed the wide-open matrix when explicitly asked, OR when
					// enabling A2A with no allow list yet (else "enabled" does
					// nothing — every pair is denied by an empty matrix).
					if (wantsAllowAll || (args.a2aEnabled === true && !hasAllow)) {
						a2a.allow = [...WIDE_OPEN_ALLOW];
					}
					session.agentToAgent = a2a;
				}

				merged.session = session as BrigadeConfig["session"];

				if (wantsMode) {
					const org = {
						...((merged.org as Record<string, unknown> | undefined) ?? {}),
					} as Record<string, unknown>;
					org.a2a = {
						...((org.a2a as Record<string, unknown> | undefined) ?? {}),
						mode: args.a2aMode,
					};
					// The set guard above already refused a2aMode when no org
					// exists, so by here `org` carries the real block (topOrder +
					// a2a) — cast through unknown since we built it structurally.
					merged.org = org as unknown as BrigadeConfig["org"];
				}

				return merged;
			});

			const after = readAccessSnapshot(next);
			return jsonResult({
				action: "set",
				ok: true,
				before,
				after,
				message: `Updated agent-to-agent access. ${describeSnapshot(after)} This is LIVE — no gateway restart needed. If you were blocked reaching another agent, retry that sessions_send now (this same turn); it re-checks against the new setting.`,
			} satisfies ManageAccessResult) as AgentToolResult<ManageAccessResult>;
		},
	};
}

/* ───────────────────────── helpers ───────────────────────── */

function readAccessSnapshot(cfg: BrigadeConfig): AccessSnapshot {
	const session = cfg.session as
		| {
				sessionTools?: { visibility?: string };
				agentToAgent?: { enabled?: boolean; allow?: Array<{ from: string; to: string }> };
		  }
		| undefined;
	const org = cfg.org as { a2a?: { mode?: string } } | undefined;
	const allow = Array.isArray(session?.agentToAgent?.allow)
		? (session?.agentToAgent?.allow as Array<{ from: string; to: string }>)
		: [];
	return {
		visibility: session?.sessionTools?.visibility ?? "self",
		a2aEnabled: session?.agentToAgent?.enabled === true,
		a2aAllow: allow,
		orgConfigured: org !== undefined && org !== null,
		a2aMode: org?.a2a?.mode ?? null,
	};
}

function describeSnapshot(s: AccessSnapshot): string {
	const parts = [
		`visibility=${s.visibility}`,
		`a2aEnabled=${s.a2aEnabled}`,
		`allow=${s.a2aAllow.length === 1 && s.a2aAllow[0]?.from === "*" && s.a2aAllow[0]?.to === "*" ? "everyone" : `${s.a2aAllow.length} rule(s)`}`,
	];
	if (s.orgConfigured) parts.push(`orgA2aMode=${s.a2aMode}`);
	const crossAgentOk =
		s.visibility === "all" &&
		s.a2aEnabled &&
		(!s.orgConfigured || s.a2aMode === "explicit" || s.a2aMode === "open" || s.a2aMode === "derived");
	parts.push(crossAgentOk ? "→ cross-agent messaging is ON" : "→ cross-agent messaging is OFF");
	return parts.join(", ") + ".";
}
