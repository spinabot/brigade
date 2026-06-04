/**
 * `manage_agent` tool — owner-only LLM-driven agent CRUD.
 *
 * Mirrors the reference codebase's posture: the owner-via-LLM can mutate
 * the agent catalog (the reference does this via its generic `gateway`
 * tool + `config.patch`). Brigade chooses a safer, more specific shape:
 * a dedicated tool with `action: add | delete | set-identity` that wraps
 * Brigade's existing CRUD helpers (`runAgentsAdd` / `runAgentsDelete` /
 * `runAgentsSetIdentity`) so the model gets atomic workspace seeding,
 * validation, rollback on partial failure, and soft-delete to
 * `.brigade-trash/` — all of which a generic `config.patch` would skip.
 *
 * `ownerOnly: true` — the session-wiring wrapper refuses the tool when
 * the caller is not the workspace owner. In Brigade's single-user setup
 * the operator IS always the owner, so the tool is effectively always
 * available to YOU but never to a sub-agent or channel-routed turn from
 * an external sender.
 *
 * Output capture: each CRUD helper writes to stdout/stderr; we redirect
 * those streams into in-memory buffers so the tool result carries the
 * exact CLI output the operator would see.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

import { jsonResult } from "./common.js";
import type { BrigadeTool } from "./types.js";

const ManageAgentParams = Type.Object({
	action: Type.Union(
		[Type.Literal("add"), Type.Literal("delete"), Type.Literal("set-identity")],
		{
			description:
				"add: create a new agent. delete: remove an agent (soft — moves to .brigade-trash/). set-identity: update name/emoji/theme/avatar.",
		},
	),
	id: Type.String({
		description:
			"Agent id. For `add` this is the new agent's name (will be normalised). For `delete`/`set-identity` this is the existing agent id.",
		minLength: 1,
		maxLength: 64,
	}),
	// `add` params
	workspace: Type.Optional(
		Type.String({
			description:
				"Optional custom workspace dir for the new agent. Defaults to `~/.brigade/agents/<id>/workspace/`. Only used when action=add.",
		}),
	),
	provider: Type.Optional(
		Type.String({
			description:
				"Provider id (anthropic / openrouter / etc.). Defaults to cfg.agents.defaults.provider. Only used when action=add.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model id. Defaults to cfg.agents.defaults.model.primary. Only used when action=add.",
		}),
	),
	// `set-identity` params
	name: Type.Optional(Type.String({ description: "Display name (set-identity only)." })),
	emoji: Type.Optional(Type.String({ description: "Emoji (set-identity only)." })),
	theme: Type.Optional(Type.String({ description: "Theme tag (set-identity only)." })),
	avatar: Type.Optional(Type.String({ description: "Avatar path / URL (set-identity only)." })),
	// `add`-time ORG-position params (Pride hierarchy, optional). When ANY
	// of these is set on action=add AND cfg.org is absent, Brigade auto-
	// initialises a minimal cfg.org so the operator never has to run
	// `brigade org init` separately. "Create a CEO" / "create eng-lead
	// reporting to main" / "set up a strategy department" all just work
	// from chat. See `applyAutoEnableOrgOnHierarchicalAdd`.
	department: Type.Optional(
		Type.String({
			description:
				"Org department slug (e.g. \"engineering\", \"strategy\", \"executive\"). Setting this on action=add auto-initialises cfg.org if absent — no separate `brigade org init` needed.",
		}),
	),
	reportsTo: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description:
				"Org parent agent id. Pass null to make the NEW agent the top-of-org (Higher Office); pass an existing agent id to place the new agent under it. Setting this on action=add auto-initialises cfg.org if absent.",
		}),
	),
	role: Type.Optional(
		Type.String({
			description:
				"Org role title (e.g. \"Chief of Staff\", \"Engineering Lead\", \"Inventory Specialist\"). Used in the Pride chart anchor + ## Org block. Setting this on action=add auto-initialises cfg.org if absent.",
		}),
	),
	bio: Type.Optional(
		Type.String({
			description:
				"Optional 1-line org-position description (\"Routes work across the org.\", \"Reviews diffs for correctness.\"). Setting this on action=add auto-initialises cfg.org if absent.",
		}),
	),
});

interface ManageAgentResult {
	action: "add" | "delete" | "set-identity";
	id: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	ok: boolean;
}

export function makeManageAgentTool(): BrigadeTool<typeof ManageAgentParams, ManageAgentResult> {
	return {
		name: "manage_agent",
		label: "Manage Agent",
		ownerOnly: true,
		description: [
			"Owner-only LLM-driven agent CRUD. Wraps the same code as `brigade agents add/delete/set-identity`.",
			"Use this when the user asks you to create, delete, or rename a peer agent.",
			"action=add creates a new agent with its workspace (all 7 persona files seeded) + brigade.json entry, atomically with rollback on failure.",
			"action=delete soft-deletes — the workspace moves to `.brigade-trash/<id>-<timestamp>/` so the user can recover.",
			"action=set-identity updates display name/emoji/theme/avatar without touching workspace files.",
			"Returns {action, id, exitCode, stdout, stderr, ok}. Relay the CLI output back to the user.",
			"After action=add the gateway hot-reload watcher picks up the new agent automatically within ~500ms — no restart needed for it to appear in `agents_list`.",
		].join(" "),
		parameters: ManageAgentParams,
		execute: async (
			_toolCallId: string,
			args,
		): Promise<AgentToolResult<ManageAgentResult>> => {
			// SERIALIZE concurrent manage_agent calls. The CLI helpers (runAgents*)
			// each replace `process.stdout.write` to capture human-readable output,
			// then restore in `finally`. With N parallel invocations, the second
			// capture saves the FIRST capture's hook (not the real stdout) — and
			// the restore order corrupts process.stdout for the rest of the
			// process lifetime. Also, runAgentsAdd performs read-modify-write on
			// brigade.json; concurrent mutations race even with atomic file
			// writes. Serialising both stdio capture AND the underlying CLI helper
			// removes both races in one place.
			return runSerial(async () => {
				const action = args.action;
				const id = args.id.trim();
				const capture = captureStdio();
				let exitCode = 0;
				try {
					if (action === "add") {
						const { runAgentsAdd } = await import("../../cli/commands/agents-cmd.js");
						// Org-position params are threaded through to runAgentsAdd
						// so the underlying mutateConfigAtomic callback can
						// (a) seed the new agent's cfg.agents.<id>.org block AND
						// (b) auto-init cfg.org when it's absent — both atomic
						// with the agent creation itself. See
						// `applyAutoEnableOrgOnHierarchicalAdd` in agents-cmd.ts.
						const orgFields: {
							department?: string;
							reportsTo?: string | null;
							role?: string;
							bio?: string;
						} = {};
						// Normalise the LLM's freeform inputs:
						//   - department/role/bio: trim, treat "" as omitted
						//   - reportsTo: special-case — TypeBox accepts the
						//     union (string | null) and LLMs sometimes pass
						//     ""  meaning "no parent" instead of `null`. Coerce
						//     empty/whitespace strings → null so the agent
						//     becomes the top-of-org (matching the LLM's
						//     intent) rather than producing a corrupt
						//     `agents.<id>.org.reportsTo: ""` block that
						//     fails validation and bricks every subsequent
						//     turn.
						if (args.department !== undefined) {
							const d = args.department.trim();
							if (d.length > 0) orgFields.department = d;
						}
						if (args.reportsTo !== undefined) {
							if (args.reportsTo === null) {
								orgFields.reportsTo = null;
							} else if (typeof args.reportsTo === "string") {
								const rt = args.reportsTo.trim();
								orgFields.reportsTo = rt.length > 0 ? rt : null;
							}
						}
						if (args.role !== undefined) {
							const r = args.role.trim();
							if (r.length > 0) orgFields.role = r;
						}
						if (args.bio !== undefined) {
							const b = args.bio.trim();
							if (b.length > 0) orgFields.bio = b;
						}
						exitCode = await runAgentsAdd({
							name: id,
							nonInteractive: true,
							...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
							...(args.provider !== undefined ? { provider: args.provider } : {}),
							...(args.model !== undefined ? { model: args.model } : {}),
							...(Object.keys(orgFields).length > 0 ? { org: orgFields } : {}),
						});
					} else if (action === "delete") {
						const { runAgentsDelete } = await import("../../cli/commands/agents-cmd.js");
						exitCode = await runAgentsDelete({ id, force: true });
					} else {
						const { runAgentsSetIdentity } = await import("../../cli/commands/agents-cmd.js");
						exitCode = await runAgentsSetIdentity({
							agent: id,
							...(args.name !== undefined ? { name: args.name } : {}),
							...(args.emoji !== undefined ? { emoji: args.emoji } : {}),
							...(args.theme !== undefined ? { theme: args.theme } : {}),
							...(args.avatar !== undefined ? { avatar: args.avatar } : {}),
						});
					}
				} finally {
					capture.restore();
				}
				const result: ManageAgentResult = {
					action,
					id,
					exitCode,
					stdout: capture.stdout(),
					stderr: capture.stderr(),
					ok: exitCode === 0,
				};
				return jsonResult(result) as AgentToolResult<ManageAgentResult>;
			});
		},
	};
}

/**
 * Process-wide serial queue for stdio-capturing CLI calls.
 *
 * Two operations protected by this:
 *   - `captureStdio()` — replaces `process.stdout.write` for the call
 *     duration. Concurrent callers would save each other's hooks and
 *     corrupt `process.stdout` permanently when they restore in `finally`.
 *   - `runAgents{Add,Delete,SetIdentity}` — read-modify-write on
 *     `brigade.json`. Concurrent mutations race even with atomic writes.
 *
 * Shared across every `manage_agent` invocation (module-level Promise
 * chain). The chain swallows rejections (`.catch(() => undefined)`) so
 * a failed prior call doesn't poison the chain — subsequent calls still
 * get to run.
 */
let manageAgentSerial: Promise<unknown> = Promise.resolve();

function runSerial<T>(fn: () => Promise<T>): Promise<T> {
	const next = manageAgentSerial.then(
		() => fn(),
		() => fn(),
	);
	manageAgentSerial = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

/**
 * Redirect process.stdout/stderr.write to in-memory buffers for the
 * duration of a CLI helper call. The helpers write human-readable
 * status to those streams; capturing lets us hand the output back to
 * the model as part of the tool result.
 */
function captureStdio(): {
	stdout: () => string;
	stderr: () => string;
	restore: () => void;
} {
	const out: string[] = [];
	const err: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
	return {
		stdout: () => out.join(""),
		stderr: () => err.join(""),
		restore: () => {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
		},
	};
}
