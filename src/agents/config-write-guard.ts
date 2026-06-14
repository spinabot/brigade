/**
 * Config-write guard — refuses bash commands that would MUTATE Brigade's
 * state files (`~/.brigade/brigade.json`, credential stores, approvals,
 * encryption key, cron store).
 *
 * Why (production, 2026-06-11): asked to tweak the org's A2A mode, the
 * model piped brigade.json through an inline python script and wrote it
 * back. The operator approved the prompt without realizing it was a config
 * WRITE; the script silently no-op'd (declared success, changed nothing),
 * and only forensics caught it. A different bug in the same shape could
 * have corrupted the whole install. `write`/`edit` are already guarded by
 * the path-write guard — bash + python/sed/tee was the remaining hole.
 *
 * Boundary semantics (the operator's explicit ask): the agent may READ
 * state files through the shell (discouraged — the tools report this state
 * already), but every MUTATION must go through the proper tool surface
 * (org / manage_provider / manage_agent / manage_skill / cron) or be
 * handed to the operator as an exact suggested edit. The refusal text
 * carries that remedy so the model course-corrects in one step.
 */

import type { BeforeToolCallResult } from "@mariozechner/pi-agent-core";

import type { BrigadeBeforeToolCallHook } from "./tool-guard.js";

const BASH_TOOL_NAMES = new Set(["bash", "shell", "exec"]);

/**
 * A command is only inspected when it references a Brigade STATE path —
 * a protected basename in a `.brigade` directory context. Bare mentions of
 * `brigade.json` (e.g. developing Brigade itself in a repo checkout, or
 * tempdir fixtures in tests) don't trip the guard.
 */
const STATE_PATH_RE =
	/(?:\$HOME|~|%USERPROFILE%|[A-Za-z]:[\\/](?:[^\s"']*[\\/])?)?\.brigade[\\/][^\s"'|;&]*?(brigade\.json|auth-profiles\.json|auth-state\.json|exec-approvals\.json|encryption\.key|cron\.json|models\.json|mode\.sentinel)/i;

/** Write indicators evaluated only when a state path is referenced. */
const WRITE_INDICATOR_RES: Array<{ re: RegExp; label: string }> = [
	// python: json.dump( — but NOT json.dumps( (the read-and-print form).
	{ re: /json\.dump\s*\(/, label: "json.dump(...)" },
	// python: open(..., "w"/"a"/"w+"/"wb"…)
	{ re: /open\s*\([^)]*['"][wa]\+?b?['"]/, label: "open(…, 'w')" },
	// .write(...) / .writelines(...) — fh.write, stream.write, etc.
	{ re: /\.write(?:lines)?\s*\(/, label: ".write(...)" },
	// pathlib: Path(...).write_text(...) / .write_bytes(...) — audit P1
	// (these don't match `.write(` because of the underscore suffix).
	{ re: /\.write_(?:text|bytes)\s*\(/, label: ".write_text(...)" },
	// node: fs.writeFileSync / fs.writeFile / fs.appendFileSync / .promises.writeFile
	{ re: /\b(?:write|append)File(?:Sync)?\s*\(/, label: "fs.writeFile(...)" },
	// PowerShell .NET: [IO.File]::WriteAllText/WriteAllBytes/WriteAllLines
	{ re: /::Write(?:AllText|AllBytes|AllLines|AllLinesAsync)\b/i, label: "[IO.File]::WriteAll…" },
	// shell redirect INTO a .brigade path
	{ re: />{1,2}\s*"?[^\s"'|;&]*\.brigade[\\/]/i, label: "redirect into ~/.brigade" },
	// in-place editors / copiers targeting a .brigade path
	{ re: /\bsed\s+(-[a-zA-Z]*\s+)*-i\b/, label: "sed -i" },
	{ re: /\btee\s+(-a\s+)?"?[^\s"'|;&]*\.brigade[\\/]/i, label: "tee into ~/.brigade" },
	{ re: /\b(mv|cp)\s+\S+\s+"?[^\s"'|;&]*\.brigade[\\/]/i, label: "mv/cp into ~/.brigade" },
	// PowerShell write cmdlets
	{ re: /\b(set-content|out-file|add-content)\b/i, label: "Set-Content/Out-File" },
];

/** Exposed for tests: classify a command. Returns the matched indicator or null. */
export function detectConfigWrite(command: string): string | null {
	if (!STATE_PATH_RE.test(command)) return null;
	for (const { re, label } of WRITE_INDICATOR_RES) {
		if (re.test(command)) return label;
	}
	return null;
}

export function makeConfigWriteGuard(): BrigadeBeforeToolCallHook {
	return async (ctx) => {
		const rawName =
			(ctx as { toolCall?: { name?: unknown }; name?: unknown })?.toolCall?.name ??
			(ctx as { name?: unknown })?.name ??
			"";
		const name = typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
		if (!BASH_TOOL_NAMES.has(name)) return undefined;

		const args =
			(ctx as { toolCall?: { arguments?: unknown }; arguments?: unknown; args?: unknown })
				?.toolCall?.arguments ??
			(ctx as { arguments?: unknown })?.arguments ??
			(ctx as { args?: unknown })?.args ??
			{};
		const command =
			args && typeof args === "object" && typeof (args as { command?: unknown }).command === "string"
				? (args as { command: string }).command
				: undefined;
		if (!command) return undefined;

		const indicator = detectConfigWrite(command);
		if (!indicator) return undefined;
		return {
			block: true,
			reason:
				`bash: refusing to modify a Brigade state file through the shell (detected ${indicator} ` +
				"targeting ~/.brigade). A malformed shell write can corrupt the whole install — one such " +
				"edit already silently failed in production while reporting success. Use the proper tool " +
				"instead: org (hierarchy + a2a mode), manage_provider (API keys + per-agent models), " +
				"manage_agent (agents), manage_skill (skills), cron (jobs). If no tool covers this change, " +
				"tell the operator the exact edit to make in brigade.json — do not apply it yourself.",
		} satisfies BeforeToolCallResult;
	};
}
