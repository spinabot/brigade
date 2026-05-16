/**
 * Exec gate — refuses problematic shell-tool calls BEFORE they execute.
 *
 * Wired into Pi's `session.agent.beforeToolCall` hook AFTER the
 * unknown-tool guard. Composed in `agent-loop.ts`:
 *
 *   const nameGuard = makeUnknownToolGuard(enabledToolNames);
 *   const gate      = makeExecGate({ ctxRef, displayCwd });
 *   session.agent.beforeToolCall = async (ctx, signal) => {
 *     const named = await nameGuard(ctx, signal);
 *     if (named?.block) return named;
 *     return gate(ctx, signal);
 *   };
 *
 * Scope is shell-only. Path-mutating tools (`write`, `edit`) are NOT
 * gated here — Pi resolves their relative paths against the session
 * cwd (the agent's workspace dir), and absolute paths are passed
 * through. The agent's "home" is its persona directory; project files
 * are reached via absolute paths the operator gives it. Mirrors
 * OpenClaw's `tools.fs.workspaceOnly = false` default at
 * `src/agents/tool-fs-policy.ts:11` and the `createAgentSession({cwd:
 * resolvedWorkspace})` wiring at
 * `src/agents/pi-embedded-runner/run/attempt.ts:1031-1032`.
 *
 * What this gate enforces:
 *
 *   1. Tool name match — case-insensitive lookup against
 *      `EXEC_GATED_TOOLS` (bash, exec, shell, sh). Catches the
 *      `Bash`/`SHELL`/`Exec` casing that some providers emit.
 *
 *   2. Non-string command argument — refused with a typed message
 *      identifying the actual shape (array / number / object / etc.)
 *      so the model knows exactly what to fix.
 *
 *   3. workdir / cwd argument override — refused outright (any value
 *      or type). An operator who approved `ls -la` did NOT approve
 *      running it from `/etc`. v1 trust model: commands run from the
 *      agent's session cwd, no directory shopping. Phase 2 may relax
 *      this to "must be inside session cwd" once the analyzer surface
 *      lands.
 *
 *   4. env argument override — refused. An operator who allowlisted
 *      `git status` did NOT also allowlist running it with arbitrary
 *      environment variables (e.g. `GIT_SSH_COMMAND=/tmp/evil`
 *      hijacks ssh; `LD_PRELOAD=…` hijacks dynamic linking).
 *
 *   5. `decideApproval(command)` — the heart of the gate. Returns
 *      "allow" / "deny" / "prompt"; "allow" passes the call through,
 *      "deny" refuses with a hard-deny reason (and is never persistable),
 *      "prompt" refuses with the exact `brigade exec allow ...` CLI
 *      the operator needs to run.
 *
 *   6. `BrigadeApprovalFileVersionError` passthrough — if the
 *      `~/.brigade/exec-approvals.json` file declares a future schema
 *      version, refuse the tool call with the typed error's remediation
 *      message instead of letting the throw escape into Pi.
 *
 * Every refusal also emits a `tool-blocked` event via the agent event
 * bus. The TUI / gateway WebSocket / future audit consumers can
 * subscribe and render the refusal as a log line.
 */

import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";

import { BrigadeApprovalFileVersionError, decideApproval } from "../core/exec-approvals.js";
import { emitAgentEvent } from "./agent-event-bus.js";
import { type BrigadeBeforeToolCallHook, normalizeToolName } from "./tool-guard.js";

/**
 * Shell-shaped tool names gated by this hook. Includes the canonical
 * `bash` plus the aliases providers occasionally emit (`exec`, `shell`,
 * `sh`). Match is case-insensitive at call time — adding a new alias
 * here is the only wiring needed.
 */
const EXEC_GATED_TOOLS = new Set(["bash", "exec", "shell", "sh"]);

/**
 * Optional context the gate threads into bus events. The agent-loop
 * sets `ctxRef.value = {runId, agentId}` at turn start and clears it
 * in the finally; the gate reads `.value` live each call so events
 * carry accurate correlation IDs across turn boundaries.
 *
 * Both fields are optional: when omitted (unit tests pass no ctxRef)
 * the gate still emits the event with empty-string ids.
 */
export interface ExecGateContext {
	runId?: string;
	agentId?: string;
}

export interface MakeExecGateOptions {
	/** Live context bag for bus events. Default: empty (test-friendly). */
	ctxRef?: { value: ExecGateContext };
	/**
	 * Cwd label for the workdir-refusal reason text. NOT used for any
	 * resolution logic — purely diagnostic so the model sees the actual
	 * cwd Pi will use when retrying without a workdir override. Defaults
	 * to `process.cwd()` for backwards compatibility with callers that
	 * don't supply it.
	 */
	displayCwd?: string;
}

/**
 * Build a `beforeToolCall` hook that enforces the shell-policy above.
 * Returns `undefined` (pass through) for non-shell tools and for
 * allowlisted shell commands; returns `{block: true, reason}` for
 * refusals.
 */
export function makeExecGate(opts: MakeExecGateOptions = {}): BrigadeBeforeToolCallHook {
	const ctxRef = opts.ctxRef ?? { value: {} as ExecGateContext };
	const displayCwd = opts.displayCwd ?? process.cwd();
	const emitBlocked = (toolName: string, reason: string): void => {
		const c = ctxRef.value;
		emitAgentEvent({
			type: "tool-blocked",
			runId: c.runId ?? "",
			agentId: c.agentId ?? "",
			toolName,
			reason,
		});
	};
	return async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
		const rawName = (ctx as { toolCall?: { name?: unknown }; name?: unknown })?.toolCall?.name
			?? (ctx as { name?: unknown })?.name
			?? "";
		// Shared normaliser — lowercase + trim — so the gate behaves
		// identically to the unknown-tool guard and the loop detector
		// when a provider emits `Bash` / `BASH` / `  bash  `.
		const name = normalizeToolName(rawName);
		if (!name) return undefined;
		if (!EXEC_GATED_TOOLS.has(name)) return undefined;

		const args = (ctx as { toolCall?: { arguments?: unknown }; args?: unknown; arguments?: unknown })
			?.toolCall?.arguments
			?? (ctx as { args?: unknown })?.args
			?? (ctx as { arguments?: unknown })?.arguments
			?? {};

		// Pull the command out of the tool args. Pi's `bash` tool accepts
		// `command` (the OpenClaw/Anthropic convention); some providers
		// emit `cmd` or `script` instead — fall back through them.
		const cmdRaw =
			(args && typeof args === "object"
				? ((args as { command?: unknown }).command
					?? (args as { cmd?: unknown }).cmd
					?? (args as { script?: unknown }).script)
				: undefined);

		// Non-string command argument: refuse with shape info so the model
		// can correct itself. Without this branch a `command: ["ls", "-la"]`
		// would silently coerce to empty-string and surface as
		// "(empty command) is not on the allowlist" — misleading.
		if (cmdRaw !== undefined && typeof cmdRaw !== "string") {
			const shape = Array.isArray(cmdRaw)
				? "array"
				: typeof cmdRaw === "object" && cmdRaw !== null
					? "object"
					: typeof cmdRaw;
			const article = /^[aeiou]/i.test(shape) ? "an" : "a";
			const reason =
				`Tool "${name}" was blocked: its \`command\` argument was ${article} ${shape}, ` +
				`not a string. Brigade's bash gate expects a single shell command string ` +
				`(e.g. \`{command: "ls -la"}\`). Re-emit the tool call with the command as ` +
				`one string and retry.`;
			emitBlocked(name, reason);
			return { block: true, reason };
		}

		const cmd = typeof cmdRaw === "string" ? cmdRaw : "";

		// workdir / cwd refusal. Pi's bash schema accepts a `workdir` (alias:
		// `cwd`) override; v1 refuses any such override regardless of value
		// or type. An operator who allowlisted `ls -la` did NOT approve
		// running it from `/etc` — the directory matters. Refused BEFORE
		// the decideApproval check so a workdir attack on an allowlisted
		// command is still caught.
		if (args && typeof args === "object") {
			const hasWorkdir = Object.prototype.hasOwnProperty.call(args, "workdir");
			const hasCwd = Object.prototype.hasOwnProperty.call(args, "cwd");
			const workdirRaw = hasWorkdir
				? (args as { workdir?: unknown }).workdir
				: hasCwd
					? (args as { cwd?: unknown }).cwd
					: undefined;
			const workdirKey = hasWorkdir ? "workdir" : hasCwd ? "cwd" : null;
			if (workdirKey !== null && workdirRaw !== undefined && workdirRaw !== null) {
				const isEmptyString = typeof workdirRaw === "string" && workdirRaw.trim().length === 0;
				if (!isEmptyString) {
					const displayValue = typeof workdirRaw === "string"
						? `"${workdirRaw}"`
						: `(${Array.isArray(workdirRaw) ? "array" : typeof workdirRaw})`;
					const reason =
						`Tool "${name}" was blocked: \`${workdirKey}\` override ${displayValue} is not ` +
						`allowed. v1 refuses any \`workdir\` / \`cwd\` argument on shell tools — ` +
						`the command runs from the agent's session cwd ("${displayCwd}"). If you need ` +
						`to act on files inside a subdirectory, prefer absolute paths in the ` +
						`command itself (e.g. \`ls -la /full/path\`).`;
					emitBlocked(name, reason);
					return { block: true, reason };
				}
			}

			// env refusal. Pi's bash schema accepts an `env` override.
			// Allowlisting `git status` does NOT also allowlist running it
			// with arbitrary env vars (e.g. `GIT_SSH_COMMAND=/tmp/evil`
			// hijacks ssh; `LD_PRELOAD=…` hijacks dynamic linking).
			// Empty-object env (`{env: {}}`) is harmless — passes through.
			const envRaw = (args as { env?: unknown }).env;
			if (envRaw !== undefined && envRaw !== null) {
				if (
					typeof envRaw !== "object" ||
					Array.isArray(envRaw) ||
					Object.keys(envRaw as object).length > 0
				) {
					const reason =
						`Tool "${name}" was blocked: \`env\` override is not allowed. v1 refuses ` +
						`any \`env\` argument on shell tools — environment variables can hijack ` +
						`allowlisted commands (e.g. GIT_SSH_COMMAND to replace ssh, LD_PRELOAD to ` +
						`hijack dynamic linking). If you need a specific env, prefix the command ` +
						`itself (e.g. \`FOO=bar npm test\`) AND approve THAT exact string.`;
					emitBlocked(name, reason);
					return { block: true, reason };
				}
			}
		}

		// decideApproval may throw `BrigadeApprovalFileVersionError` if the
		// on-disk allowlist file declares a future schema version. Refuse
		// the tool call with the typed error's message rather than letting
		// the throw escape into Pi (which would surface a generic stream
		// error far from the actual cause).
		let decision: ReturnType<typeof decideApproval>;
		try {
			decision = decideApproval(cmd);
		} catch (err) {
			if (err instanceof BrigadeApprovalFileVersionError) {
				const reason =
					`Tool "${name}" was blocked: the exec-approvals file declares a schema ` +
					`version this Brigade build doesn't understand. ${err.message}`;
				emitBlocked(name, reason);
				return { block: true, reason };
			}
			throw err;
		}

		if (decision === "allow") return undefined;

		if (decision === "deny") {
			const reason =
				`Tool "${name}" was blocked: command "${cmd.slice(0, 120)}" ` +
				`matches a hard-deny pattern (e.g. rm -rf /, dd to raw disk, ` +
				`fork bomb). This pattern is permanently refused and cannot be ` +
				`allowlisted — pick a safer command.`;
			emitBlocked(name, reason);
			return { block: true, reason };
		}

		// "prompt" — operator hasn't allowlisted this command yet. v1 has
		// no mid-turn TUI prompt UI, so we refuse and tell the model how
		// the operator can approve it.
		const preview = cmd.slice(0, 200) || "(empty command)";
		const reason =
			`Tool "${name}" was blocked: command "${preview}" is not on the ` +
			`exec-approvals allowlist. The operator must run\n` +
			`  brigade exec allow ${JSON.stringify(cmd || "<command>")}\n` +
			`(or \`brigade exec allow-pattern <regex>\` for a family of commands) ` +
			`before this command can execute. Until then, prefer ` +
			`"read", "grep", "find", or "ls" — those tools never need approval.`;
		emitBlocked(name, reason);
		return { block: true, reason };
	};
}
