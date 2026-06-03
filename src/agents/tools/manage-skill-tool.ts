/**
 * `manage_skill` tool — owner-only LLM-driven skill CRUD.
 *
 * Why this tool exists
 * --------------------
 * Without it, when a user says "create a skill X for agent Y" the model
 * falls back to running `python scripts/init_skill.py X --path skills/public`
 * from the TUI's cwd. The TUI launches with cwd = wherever the user typed
 * `brigade` (often the install/dev tree), so `Path("skills/public").resolve()`
 * lands in the INSTALL directory — read-only at deploy time, lost on the next
 * reinstall, and only discovered as a "bundled" skill (read-only scan root).
 *
 * This tool resolves the target path canonically:
 *
 *   - `scope=agent` → `<workspaceDir>/skills/<name>/SKILL.md`
 *     where `<workspaceDir>` is `~/.brigade/workspace/` for the default
 *     agent or `~/.brigade/agents/<id>/workspace/` for non-default. Skill
 *     is visible to that agent's session only (workspace isolation).
 *
 *   - `scope=managed` → `~/.brigade/skills/<name>/SKILL.md`. Shared across
 *     every agent on this user's machine (subject to each agent's
 *     `cfg.agents.<id>.skills` allowlist — empty allowlist = all eligible).
 *
 * Owner-only. The `manage-agent` posture mirrors here — only the workspace
 * operator can create/delete skills, never a sub-agent or channel-routed
 * external sender.
 *
 * Path containment: the `name` is rendered through `path.basename` and
 * checked to be a single safe segment (no `/`, `\`, `..`, NUL, or
 * leading dot). The resolved real path is then verified to be INSIDE the
 * intended root via `isPathInside` — same defense-in-depth the skills
 * loader uses on read. Without this check a name like `../../etc/passwd`
 * would write outside the skills dir.
 */

import fs from "node:fs";
import path from "node:path";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

import { loadConfig } from "../../core/config.js";
import {
	DEFAULT_AGENT_ID,
	resolveManagedSkillsDir,
	resolveSkillsDir,
} from "../../config/paths.js";
import { listAgentEntries } from "../../cli/commands/agents-config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { jsonResult } from "./common.js";
import type { BrigadeTool } from "./types.js";

const ManageSkillParams = Type.Object({
	action: Type.Union([Type.Literal("create"), Type.Literal("delete")], {
		description:
			"create: write a new SKILL.md under the resolved scope root. delete: remove the skill directory.",
	}),
	name: Type.String({
		description:
			"Skill name. Becomes the directory name + SKILL.md frontmatter `name`. kebab-case recommended (e.g. `weather-fetcher`).",
		minLength: 1,
		maxLength: 64,
	}),
	scope: Type.Optional(
		Type.Union([Type.Literal("agent"), Type.Literal("managed")], {
			description:
				"agent (default): scope to a specific agent's workspace at `~/.brigade/agents/<agentId>/workspace/skills/<name>/` (or `~/.brigade/workspace/skills/<name>/` for the default agent). managed: cross-agent shared at `~/.brigade/skills/<name>/`.",
		}),
	),
	agentId: Type.Optional(
		Type.String({
			description:
				"Agent id (only used when scope=agent). Defaults to the caller's agent. Must be a configured agent or `main`.",
			minLength: 1,
			maxLength: 64,
		}),
	),
	description: Type.Optional(
		Type.String({
			description:
				"Short description for the SKILL.md frontmatter `description` field. Tells future model turns when to use this skill.",
			maxLength: 500,
		}),
	),
	body: Type.Optional(
		Type.String({
			description:
				"Optional markdown body for SKILL.md. If omitted, a minimal stub is written that the operator can flesh out later.",
			maxLength: 16384,
		}),
	),
});

interface ManageSkillResult {
	action: "create" | "delete";
	name: string;
	scope: "agent" | "managed";
	agentId?: string;
	skillDir: string;
	skillFile: string;
	created?: boolean;
	deleted?: boolean;
	ok: boolean;
	message: string;
}

export interface MakeManageSkillToolOptions {
	/** Caller's agent id — used as the default for `scope=agent` when `agentId` is omitted. */
	requesterAgentId?: string;
}

export function makeManageSkillTool(
	opts: MakeManageSkillToolOptions = {},
): BrigadeTool<typeof ManageSkillParams, ManageSkillResult> {
	const requesterId = normalizeAgentId(opts.requesterAgentId ?? DEFAULT_AGENT_ID);
	return {
		name: "manage_skill",
		label: "Manage Skill",
		ownerOnly: true,
		description: [
			"Owner-only LLM-driven skill CRUD. Use this to create or delete a SKILL.md, NEVER hand-write to a `skills/` directory with the `write` tool.",
			"action=create: writes `<scope-root>/<name>/SKILL.md` with frontmatter + body.",
			"action=delete: removes the entire `<scope-root>/<name>/` directory.",
			"scope=agent (default): scoped to one agent's workspace — `~/.brigade/agents/<agentId>/workspace/skills/<name>/` (or `~/.brigade/workspace/skills/<name>/` for the default agent `main`). Only that agent sees the skill.",
			"scope=managed: shared across every agent — `~/.brigade/skills/<name>/`. Subject to each agent's `cfg.agents.<id>.skills` allowlist.",
			"NEVER target the install dir (`<package>/skills/`) — that path is bundled+read-only and wiped on reinstall.",
			"Returns {action, name, scope, agentId?, skillDir, skillFile, ok, message}.",
		].join(" "),
		parameters: ManageSkillParams,
		execute: async (
			_toolCallId: string,
			args,
		): Promise<AgentToolResult<ManageSkillResult>> => {
			const scope = args.scope ?? "agent";
			const rawName = args.name.trim();

			const safeName = sanitizeSkillName(rawName);
			if (!safeName) {
				return jsonResult({
					action: args.action,
					name: rawName,
					scope,
					skillDir: "",
					skillFile: "",
					ok: false,
					message:
						"Skill name must be a single safe segment (kebab-case letters/digits/dashes, no slashes, no `..`, no leading dot).",
				} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
			}

			let resolvedAgentId: string | undefined;
			let scopeRoot: string;
			if (scope === "agent") {
				const candidate = normalizeAgentId(args.agentId ?? requesterId);
				const cfg = loadConfig();
				const configured = new Set(
					listAgentEntries(cfg).map((e) => normalizeAgentId(e.id)),
				);
				configured.add(DEFAULT_AGENT_ID);
				if (!configured.has(candidate)) {
					return jsonResult({
						action: args.action,
						name: safeName,
						scope,
						agentId: candidate,
						skillDir: "",
						skillFile: "",
						ok: false,
						message: `Agent "${candidate}" is not configured. Run \`manage_agent({action:"add", id:"${candidate}"})\` first, then re-run this call.`,
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				resolvedAgentId = candidate;
				scopeRoot = resolveSkillsDir(candidate);
			} else {
				scopeRoot = resolveManagedSkillsDir();
			}

			const skillDir = path.join(scopeRoot, safeName);
			const skillFile = path.join(skillDir, "SKILL.md");

			// Defense in depth — the resolved path MUST live inside the
			// intended scope root after normalisation. `safeName` already
			// rejects path-traversal but a future caller path could regress;
			// the contain-check catches it cheaply.
			const resolvedDir = path.resolve(skillDir);
			const resolvedRoot = path.resolve(scopeRoot);
			if (!isPathInside(resolvedRoot, resolvedDir)) {
				return jsonResult({
					action: args.action,
					name: safeName,
					scope,
					...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
					skillDir,
					skillFile,
					ok: false,
					message: `Resolved skill path escapes the scope root (${resolvedRoot}). Refusing.`,
				} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
			}

			if (args.action === "create") {
				if (fs.existsSync(skillFile)) {
					return jsonResult({
						action: "create",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						created: false,
						ok: false,
						message: `Skill already exists at ${skillFile}. Delete it first or pick a different name.`,
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				fs.mkdirSync(skillDir, { recursive: true });
				const content = renderSkillTemplate({
					name: safeName,
					description: (args.description ?? "").trim(),
					body: (args.body ?? "").trim(),
				});
				fs.writeFileSync(skillFile, content, "utf8");
				return jsonResult({
					action: "create",
					name: safeName,
					scope,
					...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
					skillDir,
					skillFile,
					created: true,
					ok: true,
					message: `Created ${skillFile}.${scope === "agent" ? ` Visible to agent "${resolvedAgentId}" on its next turn.` : " Visible to every agent (subject to per-agent allowlists) on its next turn."}`,
				} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
			}

			// action=delete
			if (!fs.existsSync(skillDir)) {
				return jsonResult({
					action: "delete",
					name: safeName,
					scope,
					...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
					skillDir,
					skillFile,
					deleted: false,
					ok: false,
					message: `No skill at ${skillDir}.`,
				} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
			}
			fs.rmSync(skillDir, { recursive: true, force: true });
			return jsonResult({
				action: "delete",
				name: safeName,
				scope,
				...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
				skillDir,
				skillFile,
				deleted: true,
				ok: true,
				message: `Removed ${skillDir}.`,
			} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
		},
	};
}

/**
 * Reject anything that isn't a single safe path segment. Returns the
 * trimmed/lower-cased name on success, empty string on failure.
 */
export function sanitizeSkillName(raw: string): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "";
	if (trimmed.startsWith(".")) return "";
	if (/[/\\\0]/.test(trimmed)) return "";
	if (trimmed.includes("..")) return "";
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed)) return "";
	return trimmed;
}

function renderSkillTemplate(args: { name: string; description: string; body: string }): string {
	const desc = args.description || "Skill description goes here. Tell future turns when this skill applies.";
	const body = args.body
		? args.body
		: `# ${args.name}\n\nWrite the skill's instructions here. The first time a turn loads this body, treat it as authoritative for the named task.\n`;
	return `---\nname: ${args.name}\ndescription: ${escapeYamlScalar(desc)}\n---\n\n${body}\n`;
}

function escapeYamlScalar(value: string): string {
	const normalised = value.replace(/\r?\n/g, " ").trim();
	if (!/[:#\-?@`'"<>{}[\]&*!|%]/.test(normalised) && normalised.length < 240) {
		return normalised;
	}
	return `"${normalised.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isPathInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}
