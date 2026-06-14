/**
 * Cmd-ism guard — refuses `bash` / `exec` / `shell` / `sh` commands that
 * redirect into a reserved MS-DOS device name (`nul`, `con`, `prn`,
 * `aux`, `com1-9`, `lpt1-9`).
 *
 * Why this exists
 * ---------------
 * Models that know the host is Windows sometimes emit cmd.exe idioms
 * into the POSIX bash tool — most commonly `2>nul` / `>nul 2>&1` to
 * discard output. In cmd.exe `nul` is the null device; in bash it is a
 * plain filename, so the redirect silently creates a real, 0-byte file
 * named `nul` in the session cwd. On Windows that file is then
 * untouchable through normal APIs (Explorer fails the containing
 * folder's deletion with "Invalid MS-DOS function") — it can only be
 * removed via a `\\?\` raw path. This happened in production: an agent
 * ran `where magick 2>nul || ...` and left `~/.brigade/workspace/nul`
 * behind, bricking folder deletion for the operator.
 *
 * The redirect is the only cmd-ism worth guarding: other cmd-isms
 * (`where`, `del`, `copy`) fail loudly in bash and the model
 * self-corrects from stderr, but a `2>nul` redirect *appears to
 * succeed* while leaving a toxic artifact.
 *
 * Scope
 * -----
 * Exact device names only (`> nul`, `2>nul`, `>> NUL`, `> tmp/nul`).
 * Windows also reserves the names with extensions (`nul.txt`), but the
 * model never emits those as a discard target — kept out to avoid
 * false positives. Quoted spans are stripped before matching so a
 * command that merely *mentions* `2>nul` in a string (e.g. writing
 * docs about cmd.exe) passes through. Heuristic by design, same
 * philosophy as the path-write guard.
 */

import type { BeforeToolCallResult } from "@mariozechner/pi-agent-core";

import type { BrigadeBeforeToolCallHook } from "./tool-guard.js";

/** Tool names whose `command` arg we scan (matches path-write-guard). */
const BASH_TOOL_NAMES = new Set(["bash", "exec", "shell", "sh"]);

/** Extract the `command` string from a bash-shaped tool call. */
function extractBashCommand(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const bag = args as { command?: unknown; cmd?: unknown; script?: unknown };
	const raw = bag.command ?? bag.cmd ?? bag.script;
	return typeof raw === "string" ? raw : undefined;
}

/**
 * Redirect into a reserved DOS device name:
 *   - optional fd digits (`2>`, `1>`), `>` or `>>`, optional whitespace
 *   - optional path prefix (`tmp/nul` creates the same toxic file)
 *   - the device name, terminated by end-of-string or a shell delimiter
 *
 * `2>&1` never matches — `&` is not a valid target character.
 */
const DEVICE_REDIRECT = /(?:^|[\s;&|()])\d*>{1,2}\s*((?:[^\s;&|<>"']*[\\/])?(?:nul|con|prn|aux|com[1-9]|lpt[1-9]))(?=$|[\s;&|<>)])/i;

/** Drop quoted spans so string literals mentioning `2>nul` don't trip the guard. */
function stripQuotedSpans(command: string): string {
	return command.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
}

/**
 * Returns the offending redirect target (e.g. `nul`) when the command
 * redirects into a reserved device name, else `undefined`.
 */
export function detectDeviceRedirect(command: string): string | undefined {
	if (!command || !command.trim()) return undefined;
	const match = stripQuotedSpans(command).match(DEVICE_REDIRECT);
	return match?.[1];
}

/**
 * Build the cmd-ism guard hook. Wire AFTER the path-write guard (both
 * are structural "is this call even legal" checks; path legality first)
 * and BEFORE the loop detector + exec-gate, so the operator is never
 * asked to approve a command that would brick their state dir.
 */
export function makeCmdIsmGuard(): BrigadeBeforeToolCallHook {
	return async (ctx) => {
		const rawName = (ctx as { toolCall?: { name?: unknown }; name?: unknown })?.toolCall?.name
			?? (ctx as { name?: unknown })?.name
			?? "";
		const name = typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
		if (!BASH_TOOL_NAMES.has(name)) return undefined;

		const args = (ctx as { toolCall?: { arguments?: unknown }; arguments?: unknown; args?: unknown })
			?.toolCall?.arguments
			?? (ctx as { arguments?: unknown })?.arguments
			?? (ctx as { args?: unknown })?.args
			?? {};
		const command = extractBashCommand(args);
		if (!command) return undefined;

		const target = detectDeviceRedirect(command);
		if (!target) return undefined;
		return {
			block: true,
			reason:
				`bash: refusing redirect into \`${target}\` — that is a cmd.exe idiom, but this tool runs a POSIX shell ` +
				`where \`${target}\` is a plain filename. The redirect would create a real file with a reserved DOS device ` +
				`name, which Windows file APIs then cannot delete. Use \`/dev/null\` to discard output (e.g. \`2>/dev/null\`).`,
		} satisfies BeforeToolCallResult;
	};
}
