// src/storage/convex/skill-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";
import type { BrigadeConfig } from "../../config/types.js";

import { NotImplementedYet } from "../store.js";
import type { SkillBody, SkillRecord, SkillStatusReport, SkillStore } from "../store.js";

interface Deps { client: ConvexHttpClient; ownerId: string }

/** Rebuild a full SKILL.md from the split frontmatter + body columns. The
 *  `write` split stores the YAML WITHOUT its `---` fences; reconstruction must
 *  re-add them or the restored file is no longer valid frontmatter and skill
 *  discovery silently ignores it. */
export function skillContentFromParts(frontmatter: string | undefined, body: string | undefined): string {
	const fm = frontmatter ?? "";
	const b = body ?? "";
	if (fm.trim().length === 0) return b;
	return `---\n${fm}\n---\n${b}`;
}

export class ConvexSkillStore implements SkillStore {
	constructor(private readonly deps: Deps) {}

	async list(args?: {
		agentId?: string;
		source?: "bundled" | "config" | "managed" | "personal" | "project" | "workspace";
	}): Promise<{ records: SkillRecord[]; diagnostics: unknown[] }> {
		const rows = (await this.deps.client.query(api.skills.list, {
			ownerId: this.deps.ownerId,
			...(args?.source !== undefined ? { source: args.source } : {}),
			// `agentId` is part of the scope key — pass it (incl. an explicit
			// agent id) only alongside a source so the scoped index applies.
			...(args?.source !== undefined && args?.agentId !== undefined
				? { agentId: args.agentId }
				: {}),
		})) as Array<Record<string, unknown>>;
		return { records: rows as unknown as SkillRecord[], diagnostics: [] };
	}

	async read(ref: string): Promise<SkillBody | undefined> {
		// `ref` is the skill name in convex mode.
		const row = (await this.deps.client.query(api.skills.get, {
			ownerId: this.deps.ownerId,
			name: ref,
		})) as Record<string, unknown> | null;
		if (!row) return undefined;
		// Surface a reconstructed full-content `content` (fences restored)
		// alongside the raw columns so callers that round-trip the file get
		// valid frontmatter.
		const content = skillContentFromParts(row.frontmatter as string, row.body as string);
		return { body: row.body as string, content, ...(row as object) } as unknown as SkillBody;
	}

	async write(args: {
		scope: "managed" | "workspace";
		agentId?: string;
		name: string;
		content: string;
	}): Promise<{ ref: string; created: boolean }> {
		// Parse frontmatter + body from the content. Convex schema stores them
		// separately; we do a minimal split here. Eligibility defaults match
		// the schema's nested object shape.
		const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(args.content);
		const frontmatter = fmMatch ? fmMatch[1] ?? "" : "";
		const body = fmMatch ? fmMatch[2] ?? "" : args.content;
		const result = (await this.deps.client.mutation(api.skills.upsert, {
			ownerId: this.deps.ownerId,
			source: args.scope === "managed" ? "managed" : "workspace",
			agentId: args.agentId ?? null,
			name: args.name,
			description: "",
			frontmatter,
			body,
			eligibility: {
				os: [],
				requiresBins: [],
				requiresAnyBins: [],
				requiresEnv: [],
				requiresConfig: [],
			},
			disableModelInvocation: false,
		})) as { created: boolean };
		return { ref: args.name, created: result.created };
	}

	async remove(args: {
		scope: "managed" | "workspace";
		agentId?: string;
		name: string;
	}): Promise<{ removed: boolean }> {
		const removed = (await this.deps.client.mutation(api.skills.remove, {
			ownerId: this.deps.ownerId,
			name: args.name,
		})) as boolean;
		return { removed };
	}

	async status(_args: {
		workspaceDir: string;
		config: BrigadeConfig;
		agentId?: string;
	}): Promise<SkillStatusReport> {
		const { records } = await this.list();
		return { skills: records, total: records.length, eligible: records.length } as unknown as SkillStatusReport;
	}

	__unused = NotImplementedYet;
}
