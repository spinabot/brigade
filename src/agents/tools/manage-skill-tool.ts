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
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";
import { enqueueWorkspaceMirrorOp } from "../../storage/workspace-live-mirror.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { forgetSkill, recordSkillCreated, recordSkillPatched } from "../skills/skill-usage.js";
import { jsonResult } from "./common.js";
import type { BrigadeTool } from "./types.js";

const ManageSkillParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("patch"),
			Type.Literal("delete"),
			Type.Literal("list"),
			Type.Literal("write_file"),
			Type.Literal("remove_file"),
		],
		{
			description:
				"create: write a new SKILL.md under the resolved scope root. patch: APPEND a new markdown section (`body`) to an EXISTING skill — use this to refine a skill that was missing a step or pitfall, never to rewrite it. delete: remove the skill directory. list: enumerate existing skills across scopes/agents. write_file: write a SUPPORT file (`fileContent` at `filePath`) under an existing skill's references/, templates/, scripts/, or assets/ subdir — deep reference material, copyable starters, or runnable checks the SKILL.md links by relative path. remove_file: delete one such support file.",
		},
	),
	name: Type.Optional(
		Type.String({
			description:
				"Skill name (REQUIRED for create/delete; ignored for list). Becomes the directory name + SKILL.md frontmatter `name`. kebab-case recommended (e.g. `weather-fetcher`).",
			minLength: 1,
			maxLength: 64,
		}),
	),
	scope: Type.Optional(
		Type.Union([Type.Literal("agent"), Type.Literal("managed")], {
			description:
				"agent (default for create/delete): scope to a specific agent's workspace at `~/.brigade/agents/<agentId>/workspace/skills/<name>/` (or `~/.brigade/workspace/skills/<name>/` for the default agent). managed: cross-agent shared at `~/.brigade/skills/<name>/`. For list: omit to enumerate BOTH scopes.",
		}),
	),
	agentId: Type.Optional(
		Type.String({
			description:
				"Agent id (used when scope=agent; for list, filters to one agent's skills). Defaults to the caller's agent for create/delete. Must be a configured agent or `main`.",
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
				"For create: optional markdown body for SKILL.md (a stub is written if omitted). For patch: REQUIRED — the markdown section to append to the existing skill (e.g. `## Pitfall\\n…`).",
			maxLength: 16384,
		}),
	),
	filePath: Type.Optional(
		Type.String({
			description:
				"For write_file/remove_file: path to a SUPPORT file UNDER an allowed subdir — references/, templates/, scripts/, or assets/ (e.g. `references/api-notes.md`, `scripts/check-env.sh`). Relative only; no `..`, no absolute paths.",
			minLength: 1,
			maxLength: 256,
		}),
	),
	fileContent: Type.Optional(
		Type.String({
			description: "For write_file: the support file's full content (max ~256KB). Overwrites if it already exists.",
			maxLength: 262144,
		}),
	),
});

interface ManageSkillResult {
	action: "create" | "patch" | "delete" | "write_file" | "remove_file";
	name: string;
	scope: "agent" | "managed";
	agentId?: string;
	skillDir: string;
	skillFile: string;
	filePath?: string;
	created?: boolean;
	patched?: boolean;
	deleted?: boolean;
	wroteFile?: boolean;
	removedFile?: boolean;
	ok: boolean;
	message: string;
}

interface ManageSkillListEntry {
	name: string;
	scope: "agent" | "managed";
	agentId?: string;
	description?: string;
	skillDir: string;
}

interface ManageSkillListResult {
	action: "list";
	ok: boolean;
	count: number;
	skills: ManageSkillListEntry[];
	message: string;
}

export interface MakeManageSkillToolOptions {
	/** Caller's agent id — used as the default for `scope=agent` when `agentId` is omitted. */
	requesterAgentId?: string;
}

export function makeManageSkillTool(
	opts: MakeManageSkillToolOptions = {},
): BrigadeTool<typeof ManageSkillParams, ManageSkillResult | ManageSkillListResult> {
	const requesterId = normalizeAgentId(opts.requesterAgentId ?? DEFAULT_AGENT_ID);
	return {
		name: "manage_skill",
		label: "Manage Skill",
		ownerOnly: true,
		description: [
			"Owner-only LLM-driven skill CRUD. Use this to create, delete, or LIST skills — NEVER hand-write to a `skills/` directory with the `write` tool, and NEVER answer 'what skills exist' by searching the filesystem with find/bash: action=list is the authoritative answer.",
			"action=create: writes `<scope-root>/<name>/SKILL.md` with frontmatter + body.",
			"action=delete: removes the entire `<scope-root>/<name>/` directory.",
			"action=list: enumerates every skill across the managed scope AND every configured agent's workspace (filter with scope and/or agentId). Returns {skills: [{name, scope, agentId?, description, skillDir}], count}.",
			"action=write_file / remove_file: attach or delete a SUPPORT file (`filePath` under references/, templates/, scripts/, or assets/) on an EXISTING skill — deep reference docs, copyable templates, or runnable scripts the SKILL.md links by relative path. Keeps SKILL.md lean; support files load on demand via the read tool, not into every prompt.",
			"scope=agent (default for create/delete): scoped to one agent's workspace — `~/.brigade/agents/<agentId>/workspace/skills/<name>/` (or `~/.brigade/workspace/skills/<name>/` for the default agent `main`). Only that agent sees the skill.",
			"scope=managed: shared across every agent — `~/.brigade/skills/<name>/`. Subject to each agent's `cfg.agents.<id>.skills` allowlist.",
			"NEVER target the install dir (`<package>/skills/`) — that path is bundled+read-only and wiped on reinstall.",
			"create/delete return {action, name, scope, agentId?, skillDir, skillFile, ok, message}.",
		].join(" "),
		parameters: ManageSkillParams,
		execute: async (
			_toolCallId: string,
			args,
		): Promise<AgentToolResult<ManageSkillResult | ManageSkillListResult>> => {
			if (args.action === "list") {
				return jsonResult(
					listSkills({
						...(args.scope !== undefined ? { scope: args.scope } : {}),
						...(args.agentId !== undefined
							? { agentId: normalizeAgentId(args.agentId) }
							: {}),
					}),
				) as AgentToolResult<ManageSkillListResult>;
			}
			const scope = args.scope ?? "agent";
			const rawName = (args.name ?? "").trim();
			if (!rawName) {
				return jsonResult({
					action: args.action,
					name: "",
					scope,
					skillDir: "",
					skillFile: "",
					ok: false,
					message: "`name` is required for create/delete.",
				} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
			}

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
				mirrorSkillWrite(scope, resolvedAgentId, safeName, content);
				// Opt the skill into curator management (agent-created provenance).
				recordSkillCreated(scopeRoot, safeName);
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

			if (args.action === "patch") {
				if (!fs.existsSync(skillFile)) {
					return jsonResult({
						action: "patch",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						patched: false,
						ok: false,
						message: `No skill at ${skillFile} to patch. Use action=create first.`,
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				const addition = (args.body ?? "").trim();
				if (!addition) {
					return jsonResult({
						action: "patch",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						patched: false,
						ok: false,
						message: "`body` (the markdown section to append) is required for patch.",
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				const res = appendSkillSection(skillFile, addition);
				if (!res.ok || res.content === undefined) {
					return jsonResult({
						action: "patch",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						patched: false,
						ok: false,
						message: res.reason ?? "patch failed.",
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				mirrorSkillWrite(scope, resolvedAgentId, safeName, res.content);
				recordSkillPatched(scopeRoot, safeName);
				return jsonResult({
					action: "patch",
					name: safeName,
					scope,
					...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
					skillDir,
					skillFile,
					patched: true,
					ok: true,
					message: `Patched ${skillFile} (appended ${addition.length} chars). Live on the agent's next turn.`,
				} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
			}

			if (args.action === "write_file") {
				const rel = validateSkillFilePath(args.filePath ?? "");
				if (!rel) {
					return jsonResult({
						action: "write_file",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						...(args.filePath ? { filePath: args.filePath } : {}),
						wroteFile: false,
						ok: false,
						message:
							"`filePath` must be a relative path under references/, templates/, scripts/, or assets/ (e.g. `references/api.md`) — no `..`, no absolute paths.",
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				if (!fs.existsSync(skillFile)) {
					return jsonResult({
						action: "write_file",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						filePath: rel,
						wroteFile: false,
						ok: false,
						message: `No skill at ${skillFile}. Create it with action=create first, then attach support files.`,
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				const fileContent = args.fileContent ?? "";
				if (Buffer.byteLength(fileContent, "utf8") > MAX_SKILL_FILE_BYTES) {
					return jsonResult({
						action: "write_file",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						filePath: rel,
						wroteFile: false,
						ok: false,
						message: `Support file exceeds the ${Math.floor(MAX_SKILL_FILE_BYTES / 1000)}KB limit. Split or trim it.`,
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				const target = path.join(skillDir, rel);
				if (!isPathInside(resolvedDir, path.resolve(target))) {
					return jsonResult({
						action: "write_file",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						filePath: rel,
						wroteFile: false,
						ok: false,
						message: "Resolved support-file path escapes the skill directory. Refusing.",
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				fs.mkdirSync(path.dirname(target), { recursive: true });
				writeFileAtomic(target, fileContent);
				// A support-file write refines an existing skill — bump its patch
				// provenance so the curator treats the package as actively tended.
				recordSkillPatched(scopeRoot, safeName);
				return jsonResult({
					action: "write_file",
					name: safeName,
					scope,
					...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
					skillDir,
					skillFile,
					filePath: rel,
					wroteFile: true,
					ok: true,
					message: `Wrote ${rel} (${Buffer.byteLength(fileContent, "utf8")} bytes). Reference it from SKILL.md by relative path (e.g. \`see ${rel}\`); it loads on demand via the read tool.`,
				} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
			}

			if (args.action === "remove_file") {
				const rel = validateSkillFilePath(args.filePath ?? "");
				if (!rel) {
					return jsonResult({
						action: "remove_file",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						...(args.filePath ? { filePath: args.filePath } : {}),
						removedFile: false,
						ok: false,
						message:
							"`filePath` must be a relative path under references/, templates/, scripts/, or assets/ — no `..`, no absolute paths.",
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				const target = path.join(skillDir, rel);
				if (!isPathInside(resolvedDir, path.resolve(target))) {
					return jsonResult({
						action: "remove_file",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						filePath: rel,
						removedFile: false,
						ok: false,
						message: "Resolved support-file path escapes the skill directory. Refusing.",
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				if (!fs.existsSync(target)) {
					return jsonResult({
						action: "remove_file",
						name: safeName,
						scope,
						...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
						skillDir,
						skillFile,
						filePath: rel,
						removedFile: false,
						ok: false,
						message: `No support file at ${rel}.`,
					} satisfies ManageSkillResult) as AgentToolResult<ManageSkillResult>;
				}
				fs.rmSync(target, { force: true });
				// Clean up a now-empty support subdir so listings stay tidy (never the
				// skill root itself).
				try {
					const subdir = path.dirname(target);
					if (path.resolve(subdir) !== resolvedDir && fs.readdirSync(subdir).length === 0) {
						fs.rmdirSync(subdir);
					}
				} catch {
					/* best-effort cleanup */
				}
				recordSkillPatched(scopeRoot, safeName);
				return jsonResult({
					action: "remove_file",
					name: safeName,
					scope,
					...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
					skillDir,
					skillFile,
					filePath: rel,
					removedFile: true,
					ok: true,
					message: `Removed ${rel} from ${skillDir}.`,
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
			mirrorSkillRemove(scope, resolvedAgentId, safeName);
			// Drop its usage record so a future same-named skill starts clean.
			forgetSkill(scopeRoot, safeName);
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

// Convex mode: the on-disk write above is what discovery reads (workspace
// stays local-authoritative), but the skills TABLE used to learn about this
// skill only at the next gateway boot via the mirror reconcile — a wipe in
// between lost the skill entirely. Dual-write the table on the live-mirror
// flush chain immediately. Tool scope "agent" maps to the table's
// "workspace" source; "managed" maps to "managed". Best-effort: a failed
// table write logs via the chain and the boot reconcile self-heals.
export function mirrorSkillWrite(
	scope: "agent" | "managed",
	agentId: string | undefined,
	name: string,
	content: string,
): void {
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode !== "convex") return;
	const store = rctx.store;
	enqueueWorkspaceMirrorOp(() =>
		store.skills.write({
			scope: scope === "agent" ? "workspace" : "managed",
			...(agentId !== undefined ? { agentId } : {}),
			name,
			content,
		}),
	);
}

function mirrorSkillRemove(
	scope: "agent" | "managed",
	agentId: string | undefined,
	name: string,
): void {
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode !== "convex") return;
	const store = rctx.store;
	enqueueWorkspaceMirrorOp(() =>
		store.skills.remove({
			scope: scope === "agent" ? "workspace" : "managed",
			...(agentId !== undefined ? { agentId } : {}),
			name,
		}),
	);
}

/**
 * Enumerate skills on disk for `action=list`. Scans the managed root and/or
 * every configured agent's workspace skills dir (plus the default agent),
 * honouring optional scope/agent filters. Each `<root>/<dir>/SKILL.md` found
 * becomes one entry; the frontmatter `description` is extracted with a
 * cheap line parse (full YAML parsing is overkill for one known key).
 */
function listSkills(filter: {
	scope?: "agent" | "managed";
	agentId?: string;
}): ManageSkillListResult {
	const skills: ManageSkillListEntry[] = [];
	if (filter.scope !== "agent") {
		collectSkillsFromRoot(resolveManagedSkillsDir(), { scope: "managed" }, skills);
	}
	if (filter.scope !== "managed") {
		const cfg = loadConfig();
		const agentIds = new Set<string>([DEFAULT_AGENT_ID]);
		for (const entry of listAgentEntries(cfg)) {
			agentIds.add(normalizeAgentId(entry.id));
		}
		for (const agentId of [...agentIds].sort()) {
			if (filter.agentId !== undefined && agentId !== filter.agentId) continue;
			collectSkillsFromRoot(resolveSkillsDir(agentId), { scope: "agent", agentId }, skills);
		}
	}
	const scopeLabel =
		filter.scope ?? (filter.agentId !== undefined ? `agent "${filter.agentId}" + managed` : "all scopes");
	return {
		action: "list",
		ok: true,
		count: skills.length,
		skills,
		message: `${skills.length} skill(s) found (${scopeLabel}).`,
	};
}

function collectSkillsFromRoot(
	root: string,
	origin: { scope: "agent" | "managed"; agentId?: string },
	out: ManageSkillListEntry[],
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return; // root doesn't exist yet — zero skills, not an error
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillDir = path.join(root, entry.name);
		const skillFile = path.join(skillDir, "SKILL.md");
		if (!fs.existsSync(skillFile)) continue;
		const description = readFrontmatterDescription(skillFile);
		out.push({
			name: entry.name,
			scope: origin.scope,
			...(origin.agentId !== undefined ? { agentId: origin.agentId } : {}),
			...(description !== undefined ? { description } : {}),
			skillDir,
		});
	}
}

/** Pull `description:` out of the SKILL.md frontmatter block, if present. */
function readFrontmatterDescription(skillFile: string): string | undefined {
	let head: string;
	try {
		const fd = fs.openSync(skillFile, "r");
		try {
			const buf = Buffer.alloc(2048);
			const n = fs.readSync(fd, buf, 0, buf.length, 0);
			head = buf.subarray(0, n).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	if (!head.startsWith("---")) return undefined;
	const end = head.indexOf("\n---", 3);
	const block = end === -1 ? head : head.slice(0, end);
	const match = /^description:\s*(.+)$/m.exec(block);
	if (!match) return undefined;
	let value = (match[1] ?? "").trim();
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	return value || undefined;
}

/** Support-file subdirs a skill may carry (the agentskills.io packaging convention):
 *  references/ = deep knowledge, templates/ = copyable starters, scripts/ = runnable
 *  checks, assets/ = other supplementary files. The model authors these via
 *  manage_skill(action="write_file") and links them from SKILL.md by relative path. */
const ALLOWED_SKILL_SUBDIRS = new Set(["references", "templates", "scripts", "assets"]);

/** Max bytes for a single support file — aligned to the skills loader's read cap so we
 *  never write a file the loader would later refuse to surface. */
const MAX_SKILL_FILE_BYTES = 256_000;

/**
 * Validate a support-file path. Returns the normalized relative path (POSIX
 * separators) on success, or `undefined` if it isn't a safe in-package path:
 * relative (no absolute / no `..` traversal), first segment an allowed subdir,
 * a filename present, and every segment a safe name (no dotfiles). The resolved
 * absolute target is ALSO containment-checked by the caller (defense in depth).
 */
export function validateSkillFilePath(filePath: string): string | undefined {
	const raw = (filePath ?? "").trim();
	if (!raw || raw.includes("..") || raw.includes("\0") || path.isAbsolute(raw)) return undefined;
	const segments = raw.split(/[/\\]+/).filter((s) => s.length > 0 && s !== ".");
	if (segments.length < 2) return undefined; // need an allowed subdir + a filename
	if (!ALLOWED_SKILL_SUBDIRS.has(segments[0]!)) return undefined;
	for (const seg of segments) {
		if (seg.startsWith(".")) return undefined;
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(seg)) return undefined;
	}
	return segments.join("/");
}

/**
 * Reject anything that isn't a single safe path segment. Returns the
 * trimmed/lower-cased name on success, empty string on failure.
 *
 * The accepted charset is tightened to the skills loader's effective name
 * contract (kebab-case: lowercase a-z, digits, single hyphens — no leading or
 * trailing hyphen, no consecutive `--`) so a created skill never trips the
 * loader's own name validation and emits a per-scan diagnostic warning. This
 * also keeps the function honest about the "kebab-case" promise in the tool's
 * own rejection message (dots/underscores/uppercase used to slip through).
 */
export function sanitizeSkillName(raw: string): string {
	const trimmed = (raw ?? "").trim().toLowerCase();
	if (!trimmed) return "";
	if (trimmed.startsWith(".")) return "";
	if (/[/\\\0]/.test(trimmed)) return "";
	if (trimmed.includes("..")) return "";
	if (trimmed.startsWith("-") || trimmed.endsWith("-")) return "";
	if (trimmed.includes("--")) return "";
	if (!/^[a-z0-9-]+$/.test(trimmed)) return "";
	return trimmed;
}

/** Max SKILL.md size after a patch — bounds unbounded growth from repeated
 *  refinements (a heavily-used skill could otherwise balloon). */
const SKILL_PATCH_MAX_BYTES = 24_576;

/**
 * Append a markdown section to an existing SKILL.md body — a refinement, never a
 * rewrite. Dedups (skips an addition already present), bounds total size, and
 * returns the new full content for the caller to mirror (convex). Never throws.
 * Shared by the manage_skill `patch` action and the skill-review auto-patcher.
 */
export function appendSkillSection(
	skillFile: string,
	addition: string,
): { ok: boolean; content?: string; reason?: string } {
	const add = addition.trim();
	if (!add) return { ok: false, reason: "nothing to append" };
	let current: string;
	try {
		current = fs.readFileSync(skillFile, "utf8");
	} catch {
		return { ok: false, reason: "skill not found" };
	}
	if (current.includes(add)) return { ok: false, reason: "that addition is already present" };
	const next = `${current.trimEnd()}\n\n${add}\n`;
	if (Buffer.byteLength(next, "utf8") > SKILL_PATCH_MAX_BYTES) {
		return { ok: false, reason: "skill is at its size limit — consolidate it instead of patching" };
	}
	try {
		writeFileAtomic(skillFile, next);
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : "write failed" };
	}
	return { ok: true, content: next };
}

export function renderSkillTemplate(args: { name: string; description: string; body: string }): string {
	const desc = args.description || "Skill description goes here. Tell future turns when this skill applies.";
	const body = args.body
		? args.body
		: `# ${args.name}\n\nWrite the skill's instructions here. The first time a turn loads this body, treat it as authoritative for the named task.\n\n<!-- Keep this file lean. Put deep reference material in references/, copyable starter files in templates/, and runnable checks in scripts/ — author them with manage_skill(action="write_file") and link them by relative path (e.g. \`see references/api-notes.md\`). They load on demand, not into every prompt. -->\n`;
	return `---\nname: ${args.name}\ndescription: ${escapeYamlScalar(desc)}\n---\n\n${body}\n`;
}

function escapeYamlScalar(value: string): string {
	const normalised = value.replace(/\r?\n/g, " ").trim();
	if (!/[:#\-?@`'"<>{}[\]&*!|%]/.test(normalised) && normalised.length < 240) {
		return normalised;
	}
	return `"${normalised.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function isPathInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}

/**
 * Write a file atomically: stage to a sibling temp path, then rename over the
 * destination (rename is atomic on the same filesystem). This guards an
 * EXISTING, hand-authored skill or support file against a truncated/half-written
 * state if the process is interrupted mid-write (crash, power loss, ENOSPC) —
 * the destination is only ever swapped wholesale or left untouched. Mirrors the
 * tmp+rename pattern the skill-usage sidecar uses. The temp file is cleaned up
 * on a failed rename so we never leave stray `.tmp-*` files behind.
 */
function writeFileAtomic(target: string, content: string): void {
	const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, content, "utf8");
	try {
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* best-effort temp cleanup */
		}
		throw err;
	}
}
