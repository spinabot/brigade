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
 * are reached via absolute paths the operator gives it. This matches the
 * `tools.fs.workspaceOnly = false` default and `createAgentSession({cwd:
 * resolvedWorkspace})` wiring.
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
import { isExecAllowAll, setExecAllowAll } from "./exec-session-allow.js";
import {
	applyApprovalDecision,
	type ApprovalDecisionKind,
	getActiveApprovalBridge,
} from "./approval-bridge.js";
import type { ChannelApprovalRoute } from "./channels/approval-router.js";
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
	/** Wave I — session key the gated tool call ran under. Threaded into the
	 *  `tool-blocked` bus event so the WS subscription filter can route the
	 *  refusal log to the operator watching THIS session only. */
	sessionKey?: string;
	/** When this turn IS running inside a sub-agent, these surface so the
	 *  operator's approval prompt can show "Sub-agent '<label>' wants to run
	 *  …" instead of the default attribution. Top-level turns leave them
	 *  unset (the prompt falls back to "Brigade wants to run …"). */
	subagentLabel?: string;
	subagentDepth?: number;
	parentRunId?: string;
	/** Channel routing — when set, the approval prompt is delivered into
	 *  the originating chat (via the per-channel approval-router) instead
	 *  of only the gateway WS. Channel-routed inbounds populate this; TUI /
	 *  sub-agent / cron turns leave it undefined and the bridge falls back
	 *  to the WS-only path. */
	channelRoute?: ChannelApprovalRoute;
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
			// Wave I — forward the session key so the gateway's per-client
			// subscription filter routes the refusal log to the operator
			// watching THIS session only.
			...(c.sessionKey !== undefined ? { sessionKey: c.sessionKey } : {}),
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
		// `command` (the Anthropic convention); some providers emit `cmd`
		// or `script` instead — fall back through them.
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
		//
		// agentId scopes the allowlist per-agent — top-level + sub-agent turns
		// both flow through here and ctxRef.value.agentId carries the active
		// agent id from runSingleTurn. Falls back to the default agent when
		// no ctxRef is supplied (unit tests).
		const gateAgentId = ctxRef.value.agentId;
		let decision: ReturnType<typeof decideApproval>;
		try {
			decision = decideApproval(cmd, gateAgentId);
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

		// Session allow-all (operator-armed via `/allow-all on`). Only a
		// "prompt" decision can reach here — "allow" returned at the allowlist
		// check above, "deny" returned in the hard-deny block, and the
		// non-string / workdir / env refusals returned earlier. The
		// config-write + path-write guards also ran BEFORE this gate in
		// composeBrigadeBeforeToolCall. So allow-all ONLY ever waives the
		// interactive prompt — it can never bypass a protective block. It's
		// in-memory + per-session (clears on restart) and does NOT cascade to
		// sub-agents (their gate checks distinct child session keys).
		if (isExecAllowAll(ctxRef.value.sessionKey)) return undefined;

		// "prompt" — operator hasn't allowlisted this command yet. If a
		// gateway client is online (the WS bridge is registered), surface
		// an inline approval prompt and route the operator's choice
		// through `applyApprovalDecision` — which persists "allow-always"
		// or "allow-pattern" decisions to `~/.brigade/exec-approvals.json`
		// before letting the call proceed.
		const bridge = getActiveApprovalBridge();
		if (bridge) {
			const preview = previewCommand(cmd);
			const decisions: ReadonlyArray<ApprovalDecisionKind> = [
				"allow-once",
				"allow-always",
				"allow-pattern",
				"allow-session",
				"deny",
			];
			try {
				const c = ctxRef.value;
				const decision = await bridge.requestApproval({
					command: cmd,
					toolName: name,
					cwd: displayCwd,
					timeoutMs: 5 * 60 * 1000,
					decisions,
					...(c.subagentLabel !== undefined ? { subagentLabel: c.subagentLabel } : {}),
					...(c.subagentDepth !== undefined ? { subagentDepth: c.subagentDepth } : {}),
					...(c.parentRunId !== undefined ? { parentRunId: c.parentRunId } : {}),
					...(c.channelRoute !== undefined ? { channelRoute: c.channelRoute } : {}),
					// Wave K (R3) — forward the per-turn agentId + sessionKey-as-sessionId
					// so the gateway's WS subscription filter routes the approval
					// prompt to the operator watching THIS agent's session only. Without
					// these the broadcaster's filter sees an un-tagged frame and falls
					// back to fan-out-to-everyone, so a TUI bound to a different agent
					// would see (and could answer) someone else's approval.
					...(c.agentId !== undefined ? { agentId: c.agentId } : {}),
					...(c.sessionKey !== undefined ? { sessionId: c.sessionKey } : {}),
				});
				if (decision.timedOut) {
					const reason =
						`Bash refused: approval timed out (no operator reply within 5 minutes). Command was "${preview}". ` +
						`Tell the user what you wanted to run and ask again when they're back.`;
					emitBlocked(name, reason);
					return { block: true, reason };
				}
				// "allow-session" — operator chose "allow all this session" from the
				// prompt. Arm the per-session bypass (so subsequent commands skip
				// the prompt) AND allow THIS call. Same bounded surface as
				// `/allow-all`: only the prompt is waived; hard-deny / workdir / env
				// refusals + the config/path-write guards still apply.
				if (decision.kind === "allow-session") {
					setExecAllowAll(ctxRef.value.sessionKey, true);
					return undefined;
				}
				const outcome = applyApprovalDecision({ command: cmd, decision, agentId: gateAgentId });
				if (outcome === "allow") return undefined;
				// Deny → refuse with a short, agent-friendly reason.
				const reason = `Bash refused by operator: "${preview}" was explicitly denied. Don't retry the same command — ask the user what they want instead.`;
				emitBlocked(name, reason);
				return { block: true, reason };
			} catch (err) {
				// recordApproval can throw on hard-deny / symlink violation.
				// Surface a clear refusal so the agent doesn't loop on the
				// same command thinking the operator hasn't seen it yet.
				const detail = err instanceof Error ? err.message : String(err);
				const reason =
					`Bash refused: couldn't persist the operator's approval — ${detail}. ` +
					`The command was "${preview}". Tell the user the file at ~/.brigade/exec-approvals.json may need attention.`;
				emitBlocked(name, reason);
				return { block: true, reason };
			}
		}

		// No bridge attached (CLI `brigade agent`, unit tests). Refuse with
		// the legacy message so the model knows to ask the operator out-of-band.
		const preview = previewCommand(cmd);
		const reason =
			`Bash refused: command starting "${preview}" is not pre-approved.\n` +
			`Do NOT retry with shell variants (powershell / python -c / different quoting / heredoc) — ` +
			`they all hit the same gate. Tell the user what you wanted to run and ask them to approve, ` +
			`OR use one of these tools that don't need approval:\n` +
			`  • read / grep / find / ls — file ops are always open.\n` +
			`  • fetch_url / web_search / web_extract — for web content.\n` +
			`  • browser — for JS-driven pages or screenshots.\n` +
			`  • write / edit — for file writes inside the workspace.`;
		emitBlocked(name, reason);
		return { block: true, reason };
	};
}

/**
 * Build a short, single-line preview of the offending command for the
 * blocked-tool error message. Strips newlines + control chars (so a
 * multi-line heredoc doesn't blow up the rendering), collapses runs of
 * whitespace, and truncates at 80 chars with an ellipsis. Output is
 * SAFE to embed in an arbitrary error string — no shell escaping needed.
 */
function previewCommand(cmd: string): string {
	if (!cmd) return "(empty command)";
	const flat = cmd.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
	if (flat.length <= 80) return flat;
	return `${flat.slice(0, 77)}…`;
}
