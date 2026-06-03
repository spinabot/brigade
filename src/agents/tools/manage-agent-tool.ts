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
			const action = args.action;
			const id = args.id.trim();
			const capture = captureStdio();
			let exitCode = 0;
			try {
				if (action === "add") {
					const { runAgentsAdd } = await import("../../cli/commands/agents-cmd.js");
					exitCode = await runAgentsAdd({
						name: id,
						nonInteractive: true,
						...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
						...(args.provider !== undefined ? { provider: args.provider } : {}),
						...(args.model !== undefined ? { model: args.model } : {}),
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
		},
	};
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
