/**
 * `sessions_rename` agent tool.
 *
 * Lets an agent name the thread it is ALREADY IN — "title this conversation
 * from what we discussed" — so a history list reads as topics rather than
 * opaque session keys.
 *
 * Deliberately takes NO `sessionKey` parameter. The target is always the
 * caller's own `agentSessionKey`, for a specific reason: this bundle has no
 * owner gate (`createSessionsBrigadeTools` receives no `senderIsOwner`, and no
 * sessions tool declares `ownerOnly`), so any channel peer's turn can reach
 * these tools. A `sessionKey` argument would therefore let an untrusted sender
 * rename threads belonging to other people or other agents. Scoping to self
 * removes that class of abuse entirely rather than trying to police it — and
 * costs nothing, because titling the current thread is the whole use case.
 *
 * The gateway still enforces its own access check on the resulting
 * `sessions.rename` call, so this is defence in depth, not the only guard.
 *
 * Output shape: `{ ok, name? }` — `name` absent when the name was cleared.
 */

import { callGateway } from "../../gateway-call.js";
import {
	jsonToolResult,
	SESSIONS_RENAME_TOOL_DISPLAY_SUMMARY,
	type ToolResultEnvelope,
} from "./shared.js";

export interface SessionsRenameToolArgs {
	/** Empty / omitted CLEARS the name — the same verb removes it. */
	name?: string;
}

export interface SessionsRenameToolOptions {
	/** The caller's OWN session key. Absent → the tool refuses (fail-closed). */
	agentSessionKey?: string;
}

export interface SessionsRenameToolDescriptor {
	name: "sessions_rename";
	displaySummary: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: unknown) => Promise<ToolResultEnvelope>;
}

const SESSIONS_RENAME_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		name: {
			type: "string",
			maxLength: 120,
			description:
				"Short title for THIS conversation — a few words describing what it is about. Omit or pass an empty string to clear the name.",
		},
	},
	additionalProperties: false,
};

function describeSessionsRenameTool(): string {
	return [
		"Name the conversation you are currently in, so it is recognisable in the thread list.",
		"You can only name THIS thread — there is no way to name another one.",
		"Use a short, specific title (a few words). Omit `name` to clear it.",
	].join(" ");
}

export function createSessionsRenameTool(
	opts: SessionsRenameToolOptions = {},
): SessionsRenameToolDescriptor {
	return {
		name: "sessions_rename",
		displaySummary: SESSIONS_RENAME_TOOL_DISPLAY_SUMMARY,
		description: describeSessionsRenameTool(),
		parameters: SESSIONS_RENAME_SCHEMA,
		execute: async (args) => {
			const sessionKey = opts.agentSessionKey;
			// Fail-closed: with no caller key there is no "own thread" to name, and
			// guessing one would be exactly the cross-thread write this tool avoids.
			if (!sessionKey) {
				return jsonToolResult({
					status: "forbidden",
					error: "sessions_rename forbidden: no caller session key",
					ok: false,
				});
			}
			// Coercing anything non-string to "" made EVERY malformed call a silent
			// CLEAR: `{}`, `{title:"x"}`, `{name:42}` and a bare string argument all
			// wiped the operator's name and reported success. Clearing must be an
			// explicit empty string, and anything else is an input error.
			if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
				return jsonToolResult({ ok: false, error: "sessions_rename expects an object with a `name` field" });
			}
			const raw = (args as { name?: unknown } | undefined)?.name;
			if (raw !== undefined && typeof raw !== "string") {
				return jsonToolResult({ ok: false, error: "`name` must be a string (pass \"\" to clear it)" });
			}
			if (raw === undefined) {
				return jsonToolResult({
					ok: false,
					error: 'no `name` given — pass a title, or "" to clear the current one',
				});
			}
			const name = raw;
			try {
				const res = await callGateway<{ ok?: boolean; name?: string }>({
					method: "sessions.rename",
					params: { sessionKey, name },
				});
				if (!res?.ok) {
					// The thread has no store entry yet (no turn has been persisted).
					// A miss, not an error — never worth failing the turn over.
					return jsonToolResult({ ok: false, error: "this thread cannot be named yet" });
				}
				return jsonToolResult(res.name ? { ok: true, name: res.name } : { ok: true, cleared: true });
			} catch (err) {
				return jsonToolResult({
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
	};
}
