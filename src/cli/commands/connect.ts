/**
 * `brigade connect` — TUI that talks to a running `brigade gateway`.
 *
 * This is the thin client. The gateway owns the Pi session, runs the full
 * 6-layer wrapper composition, and broadcasts every Pi event back to us.
 * Our job is only to render and to forward the user's input as typed
 * requests over the WebSocket.
 *
 * Feature parity with `brigade chat` for the common path (send a message,
 * stream the reply, see tool calls, abort with Ctrl+C, switch model, set
 * thinking level, compact, exit). Inline `/provider` onboarding is NOT
 * available from connect mode in v1 — onboarding writes to the gateway's
 * filesystem and is out-of-band; the user runs `brigade onboard` against
 * the gateway machine instead.
 *
 * MAINTAINER NOTE: The footer at `wireConnectUi` deliberately OMITS
 * `/provider` from the slash-command list. Do NOT add it to the connect
 * footer "for parity with chat" — connect cannot perform provider
 * onboarding (no gateway-side filesystem access from the TUI client), and
 * advertising a command we can't honour confuses users. The chat-mode
 * footer (in `src/ui/chat.ts`) DOES list `/provider` because in-process
 * chat owns the filesystem the wizard needs to write to.
 */

import process from "node:process";

import {
	CancellableLoader,
	CombinedAutocompleteProvider,
	ProcessTerminal,
	type SlashCommand,
	Text,
	TUI,
} from "@mariozechner/pi-tui";

import { BrigadeEditor } from "../../ui/editor.js";
import chalk from "chalk";

// Brigade's `Markdown` is a thin Pi-TUI subclass that normalizes `_text_`
// italic spans to `*text*` so the renderer applies italic styling instead
// of leaking literal underscores. Same shape as Pi-TUI's `Markdown` — drop-in.
import { Markdown } from "../../ui/markdown.js";
import { renderBrandHeader } from "../../ui/brand.js";
import { formatCrewLabel, formatSessionLabel } from "../../ui/format-session.js";
import { markTuiActive, restoreTerminal } from "../../ui/terminal-cleanup.js";
import { brand, editorTheme, markdownTheme } from "../../ui/theme.js";
import { summarizeToolResult } from "../../ui/tool-result.js";
import { BrigadeClient } from "../../tui/client.js";
import { ApprovalPrompt, type ApprovalResolution } from "../../tui/approval-prompt.js";
import type { AgentSummary, ModelSummary, SessionStateSnapshot, SessionSummary } from "../../protocol.js";

// Commander wrapper — `brigade connect` is the thin TUI client that
// connects to a running gateway. Same single-touch pattern the TUI /
// gateway commands use.
export function registerConnectCommand(program: import("commander").Command): void {
	program
		.command("connect")
		.description("Connect to a running Brigade gateway from a thin TUI client")
		.option("-h, --host <host>", "gateway host (default: 127.0.0.1)")
		.option("-p, --port <port>", "gateway port", (v) => parseInt(v, 10))
		.option("--timeout <ms>", "request timeout in ms", (v) => parseInt(v, 10))
		.action(async (opts: { host?: string; port?: number; timeout?: number }) => {
			await runConnectCommand({
				host: opts.host,
				port: opts.port,
				requestTimeoutMs: opts.timeout,
			});
			await new Promise<void>(() => {});
		});
}

export interface ConnectCommandOptions {
	/** Gateway host. Default: 127.0.0.1 */
	host?: string;
	/** Gateway port. Default: 7777 */
	port?: number;
	/** Per-request timeout (ms). Default: 60_000 */
	requestTimeoutMs?: number;
}

export interface ConnectHandle {
	/** Aborts the in-flight turn (true) or signals "no turn was running" (false). */
	abort(): boolean;
	close(): Promise<void>;
}

/**
 * Boot the connect TUI. Establishes the WebSocket connection FIRST so the
 * user gets a clear "couldn't reach gateway" error instead of a blank chat.
 */
export async function runConnectCommand(opts: ConnectCommandOptions = {}): Promise<ConnectHandle> {
	// Connect runs a TUI client (raw mode, alt-screen, kitty keys) — opt into
	// the on-exit terminal cleanup. Non-TUI commands skip this and exit silently.
	markTuiActive();
	const host = opts.host ?? "127.0.0.1";
	const port = opts.port ?? 7777;
	const url = `ws://${host}:${port}`;

	const tui = new TUI(new ProcessTerminal());
	tui.start();

	// Wire SIGINT BEFORE the connect attempt so Ctrl+C during a slow connect
	// exits cleanly instead of hanging on the open promise. Re-arm via
	// process.once after each turn-abort so handlers never stack across
	// re-invocations within the same process.
	let chatHandle: ConnectHandle | null = null;
	const onSigint = (): void => {
		if (chatHandle) {
			const wasRunning = chatHandle.abort();
			if (!wasRunning) {
				void chatHandle.close().then(() => {
					tui.stop();
					// tui.stop() already runs Pi-TUI's cleanup (kitty pop on
					// the happy path); restoreTerminal() is the broader safety
					// net (focus, mouse, alt-screen, modifyOtherKeys) plus an
					// unconditional kitty pop in case Pi-TUI's flag tracker
					// missed it.
					restoreTerminal();
					process.exit(0);
				});
				return;
			}
			process.once("SIGINT", onSigint); // re-arm for the next Ctrl+C
			return;
		}
		tui.stop();
		restoreTerminal();
		process.exit(130);
	};
	process.once("SIGINT", onSigint);

	const client = new BrigadeClient({
		url,
		requestTimeoutMs: opts.requestTimeoutMs ?? 60_000,
	});

	try {
		await client.connect();
	} catch (err) {
		tui.stop();
		restoreTerminal();
		const msg = err instanceof Error ? err.message : String(err);
		const isRefused = /ECONNREFUSED|connect.*refused/i.test(msg);
		const isTimeout = /ETIMEDOUT|timed?\s*out/i.test(msg);
		const isUnknownHost = /ENOTFOUND|EAI_AGAIN|getaddrinfo|temporary failure in name resolution/i.test(msg);
		const isUnreachable = /EHOSTUNREACH|ENETUNREACH|network is unreachable|no route to host/i.test(msg);

		// Headline: don't interpolate the raw `msg` (it can carry ENOTFOUND-style
		// internal codes and getaddrinfo jargon). Just say what we tried.
		console.error(chalk.red(`✗ Couldn't reach the Brigade gateway at ${url}.`));
		// Differentiate the most common failure modes so users don't waste
		// time debugging the wrong cause.
		if (isRefused) {
			console.error(chalk.dim(`  Likely cause: no gateway is running on port ${port}.`));
			console.error(chalk.dim(`  Either start one:           brigade gateway --port ${port}`));
			console.error(chalk.dim(`  Or, if it's on another port: brigade connect --port <that-port>`));
		} else if (isTimeout) {
			console.error(chalk.dim(`  Likely cause: gateway is reachable but slow to handshake.`));
			console.error(chalk.dim(`  Check that ${host} resolves and the port isn't blocked by a firewall.`));
		} else if (isUnknownHost) {
			console.error(chalk.dim(`  Couldn't resolve "${host}" — check the hostname and your DNS.`));
		} else if (isUnreachable) {
			console.error(chalk.dim(`  No network route to ${host}. Check your VPN / firewall / network connection.`));
		} else {
			console.error(chalk.dim(`  Start the gateway first:        brigade gateway --port ${port}`));
			console.error(chalk.dim(`  Or check the host/port flags:   brigade connect --host ${host} --port ${port}`));
		}
		// Surface the raw message only when the operator opts into debug mode.
		if (process.env.BRIGADE_DEBUG === "1") {
			console.error(chalk.dim(`  (debug: ${msg})`));
		}
		process.exit(1);
	}

	chatHandle = await wireConnectUi(tui, client);
	return chatHandle;
}

/**
 * Build the live chat UI on top of an already-connected client. Split out so
 * tests can inject a pre-connected client without going through CLI flag
 * parsing or process.exit.
 */
export async function wireConnectUi(tui: TUI, client: BrigadeClient): Promise<ConnectHandle> {
	// Static (last-frame) wordmark — `brigade connect` is the chat surface
	// just like `brigade chat`, so we want the same still rendering here. The
	// looping clip is reserved for onboarding's one-time wow moment.
	renderBrandHeader(tui, { animate: false });

	const header = new Text("", 0, 0);
	tui.addChild(header);
	const divider = new Text(brand.dim("─".repeat(80)), 0, 0);
	tui.addChild(divider);

	// Cumulative usage — accumulated from state snapshots so a reconnect picks
	// up where we left off instead of zeroing the totals on the user's screen.
	let lastSnapshot: SessionStateSnapshot | null = null;
	let isAgentRunning = false;
	// Connection-bound agent id. Defaults to the gateway's boot agent (filled
	// in from the first `state` snapshot) so legacy single-agent gateways keep
	// working unchanged. The `/agent <id>` slash command rebinds the connection
	// so subsequent prompt / abort / steer / set-model / set-thinking RPCs all
	// target that agent without the operator having to repeat it every turn.
	let boundAgentId: string | undefined = undefined;
	// Wave K — connection-bound session key. Lets the operator point this
	// TUI at a per-peer session (e.g. a channel-routed turn under
	// `agent:main:whatsapp:<jid>`) so abort / steer / compact / set-model
	// target THAT lane instead of the boot agent's `main`. Seeded from the
	// first snapshot, overridden by `/session <key>`.
	let boundSessionKey: string | undefined = undefined;
	// Residual P0 (post-Wave K integration audit) — the WS broadcast filter
	// at server.ts:903 keys on per-connection subscription Sets populated by
	// the `subscribe` RPC. Without an explicit subscribe, the filter falls
	// through to back-compat "deliver everything", so two operators each
	// running /agent <id> still see each other's pi/log/approval frames.
	// Track the last-committed sub pair so we can `unsubscribe` it before
	// re-subscribing to the new binding (server keeps sets — leaving stale
	// entries widens what the operator sees).
	let lastSubscribedAgentId: string | undefined = undefined;
	let lastSubscribedSessionKey: string | undefined = undefined;
	// Wave N3 (bug #3) — track whether the very first `state` snapshot has
	// already seeded the connection bindings AND fired an initial `subscribe`.
	// Without this, the snapshot handler stamped boundAgentId/boundSessionKey
	// but never called applySubscription(), so the gateway's per-connection
	// filter at server.ts:903 fell through to its back-compat "deliver
	// everything" branch — every operator on a multi-agent gateway saw every
	// other agent's pi/log/approval frames until they manually issued /agent
	// or /session. We now fire applySubscription() exactly once on the first
	// non-trivial seed; subsequent snapshots are no-ops on this code path.
	let seededSubscription = false;
	const applySubscription = async (): Promise<void> => {
		try {
			const priorParams: Record<string, string> = {};
			if (lastSubscribedAgentId !== undefined)
				priorParams.agentId = lastSubscribedAgentId;
			if (lastSubscribedSessionKey !== undefined)
				priorParams.sessionId = lastSubscribedSessionKey;
			if (Object.keys(priorParams).length > 0) {
				await client.request("unsubscribe", priorParams);
			}
			const nextParams: Record<string, string> = {};
			if (boundAgentId !== undefined) nextParams.agentId = boundAgentId;
			if (boundSessionKey !== undefined) nextParams.sessionId = boundSessionKey;
			if (Object.keys(nextParams).length > 0) {
				await client.request("subscribe", nextParams);
			}
			lastSubscribedAgentId = boundAgentId;
			lastSubscribedSessionKey = boundSessionKey;
		} catch {
			// Best-effort. Server falls back to the back-compat branch on
			// failure (deliver everything), which matches the pre-fix surface.
		}
	};
	// Wave N3 (bug #3) — defence-in-depth lane filter. Even with the
	// server-side `subscribe` RPC engaged, a stale frame can leak during the
	// gap between /agent or /session being typed and the gateway processing
	// the new subscription set, or against a legacy gateway that doesn't
	// honour subscribe at all. Drop any frame whose stamped agentId/sessionId
	// disagrees with the operator's currently bound lane. Mirrors the
	// upstream client-side gate pattern but adapted for Brigade's
	// server-side subscribe (so we only drop frames that explicitly stamp a
	// DIFFERENT lane — frames with no stamp at all fall through, preserving
	// back-compat with older gateway builds that don't tag broadcasts yet).
	const isOffLane = (frameAgentId?: string, frameSessionId?: string): boolean => {
		if (boundAgentId !== undefined && typeof frameAgentId === "string" && frameAgentId.length > 0) {
			if (frameAgentId !== boundAgentId) return true;
		}
		if (boundSessionKey !== undefined && typeof frameSessionId === "string" && frameSessionId.length > 0) {
			if (frameSessionId !== boundSessionKey) return true;
		}
		return false;
	};
	// Build the standard `{ agentId?, sessionKey?, ...rest }` payload shape
	// every RPC uses. Keeps the call sites compact and ensures sessionKey
	// is threaded uniformly so the server's per-session targeting works.
	const withBinding = <T extends Record<string, unknown>>(extra: T = {} as T)
		: T & { agentId?: string; sessionKey?: string } => ({
			...(boundAgentId !== undefined ? { agentId: boundAgentId } : {}),
			...(boundSessionKey !== undefined ? { sessionKey: boundSessionKey } : {}),
			...extra,
		});
	// Streaming-assistant buffers keyed by sub-agent depth (Primitive #6).
	// Depth 0 = top-level agent's stream; depth ≥ 1 = sub-agent at that nesting
	// level. Each depth gets its own Markdown block that grows in place as
	// `message_update` events arrive, so a sub-agent's multi-chunk reply
	// renders as ONE growing block (not N fresh blocks). Cleared per-depth on
	// `tool_execution_start` (so the next message_update at that depth
	// creates a fresh block under the tool), and wholesale on `agent_end` /
	// abort (turn boundary).
	const activeAssistants = new Map<number, Markdown>();
	let activeLoader: CancellableLoader | null = null;
	const pendingTools = new Map<string, Text>();
	// Elapsed-time tracker for the running agent. Started on `agent_start`,
	// cleared on `agent_end`. Read by the 1s ticker below to refresh the
	// header so the user can see "thinking… 12s" / "thinking… 1m 4s" instead
	// of a static "thinking…". Brigade-shape (no phrase rotation, just
	// clean numbers).
	let agentStartedAt: number | null = null;
	// Whimsical phrase rotator for the loader. Rotates in the header tail
	// every 4s while the agent is busy. Pi-TUI's CancellableLoader doesn't
	// expose a label setter so we pipe the phrase into the header `extra`
	// slot instead.
	const WHIMSICAL_PHRASES = [
		"thinking",
		"flibbertigibbeting",
		"kerfuffling",
		"dillydallying",
		"twiddling thumbs",
		"noodling",
		"bamboozling",
		"moseying",
		"hobnobbing",
		"pondering",
		"conjuring",
	];
	let whimsicalIdx = 0;
	// Thinking-block visibility toggle. Default `false` matches today's UX
	// (thinking blocks excluded from `extractAssistantText` filter). When
	// flipped to `true` via the `/show-thinking` slash command, the
	// extractor includes `{ type: "thinking" }` block text alongside the
	// regular text blocks, dimmed so it stays distinct from the agent's
	// final reply. Brigade uses the base Pi-TUI Editor which doesn't
	// expose key handlers, so the toggle is surfaced through the slash-
	// command path instead of a `Ctrl+T` binding.
	let showThinking = false;

	const updateHeader = (extra?: string): void => {
		const provider = lastSnapshot?.provider ?? "?";
		const modelId = lastSnapshot?.modelId ?? "?";
		const tokens = lastSnapshot && (lastSnapshot.totalTokensIn + lastSnapshot.totalTokensOut) > 0
			? ` · ${(lastSnapshot.totalTokensIn + lastSnapshot.totalTokensOut).toLocaleString()} tok`
			: "";
		const cost = lastSnapshot && lastSnapshot.totalCostUsd > 0
			? ` · $${lastSnapshot.totalCostUsd.toFixed(4)}`
			: "";
		const usage = lastSnapshot?.contextUsagePercent ?? null;
		let usageStr = "";
		if (usage != null && usage >= 50) {
			const pct = Math.round(usage);
			const colored = pct >= 75 ? brand.amber(`${pct}% ctx`) : brand.dim(`${pct}% ctx`);
			usageStr = ` · ${colored}`;
		}
		// Elapsed time during a running turn. Hidden when idle; shown as
		// `· 12s` (under a minute) or `· 1m 4s` so the user has a sense of
		// "is the model still working or has it stalled?".
		let elapsed = "";
		if (isAgentRunning && agentStartedAt != null) {
			const ms = Date.now() - agentStartedAt;
			elapsed = ` · ${formatElapsed(ms)}`;
		}
		const tail = extra ? ` · ${extra}` : "";
		const dot = isAgentRunning ? brand.amber("●") : brand.dim("○");
		// Brand mark — the 🦁 mascot always rides ahead of the persona name
		// so the header reads as Brigade-branded at a glance. When the
		// operator has set a `Name` in IDENTITY.md (e.g. "felix"/"molty"),
		// that name takes the persona slot; otherwise fall back to the
		// "Brigade" wordmark.
		const personaName = lastSnapshot?.agentName?.trim();
		const personaLabel = personaName || "Brigade";
		// "crew <id>" badge — surfaced only when meaningful (non-default
		// agent OR no persona name yet). Hides on a single-agent install
		// with a persona name set so the header stays calm.
		const crewLabel = formatCrewLabel({
			agentId: lastSnapshot?.agentId,
			personaName,
		});
		const crewSegment = crewLabel ? ` ${brand.dim(`· ${crewLabel}`)}` : "";
		// Human-readable session label — `main` / `WhatsApp · DM` /
		// `Slack · group · thread` / `sub-agent abc` instead of the raw
		// `agent:<id>:<rest>` key. Falls back to the raw string when the
		// key is unparseable so we never lose information.
		const sessionLabel = formatSessionLabel(lastSnapshot?.sessionKey);
		const sessionSegment = sessionLabel ? ` ${brand.dim(`· ${sessionLabel}`)}` : "";
		header.setText(
			`  ${dot} 🦁 ${brand.white(personaLabel)}${crewSegment}${sessionSegment}  ${brand.dim(`${provider} · ${modelId}${tokens}${cost}`)}${usageStr}${brand.dim(elapsed)}${brand.dim(tail)}`,
		);
	};

	/**
	 * Tick the elapsed-time display every second while the agent is busy.
	 * Cheap (one timer per connect session, not per-turn) and unref'd so it
	 * doesn't keep the process alive past `process.exit`. Cleared in the
	 * abort/close path below.
	 */
	const elapsedTimer = setInterval(() => {
		if (isAgentRunning && agentStartedAt != null) {
			updateHeader();
			tui.requestRender();
		}
	}, 1000);
	if (typeof elapsedTimer.unref === "function") elapsedTimer.unref();

	// Rotate the whimsical phrase shown in the header tail every 4s. Restarts
	// on each agent_start so the user sees the same phrase for the first
	// few seconds (no jarring rotation right after they hit Enter).
	const whimsicalTimer = setInterval(() => {
		if (isAgentRunning && activeLoader) {
			whimsicalIdx = (whimsicalIdx + 1) % WHIMSICAL_PHRASES.length;
			const phrase = WHIMSICAL_PHRASES[whimsicalIdx]!;
			updateHeader(phrase);
			tui.requestRender();
		}
	}, 4000);
	if (typeof whimsicalTimer.unref === "function") whimsicalTimer.unref();
	updateHeader();

	const editor = new BrigadeEditor(tui, editorTheme);
	tui.addChild(editor);
	tui.setFocus(editor);

	// Slash-command autocomplete (Pi-TUI built-in). Connect-mode list omits
	// `/provider` (it can't run the wizard against the remote gateway's
	// filesystem) and `/clear` (chat-only). See chat.ts for the full set.
	// Pi-TUI's slash-command spec: `name` is the command WITHOUT the leading
	// `/`. Pi adds the `/` itself on accept; including it here produces
	// `//reasoning` instead of `/reasoning`.
	const SLASH_COMMANDS: SlashCommand[] = [
		{ name: "help", description: "show all slash commands" },
		{ name: "exit", description: "quit Brigade connect" },
		{ name: "quit", description: "quit Brigade connect" },
		{ name: "abort", description: "abort the in-flight turn (same as Ctrl+C)" },
		{ name: "usage", description: "show token totals + estimated cost so far" },
		{ name: "compact", description: "summarize older turns to free context" },
		{
			name: "model",
			description: "switch to another configured model (no arg = picker)",
			argumentHint: "[<model-id>]",
		},
		{
			name: "thinking",
			description: "set the model's reasoning effort",
			argumentHint: "<off|low|medium|high|xhigh>",
			getArgumentCompletions: (prefix) => {
				const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
				return levels
					.filter((l) => l.startsWith(prefix.toLowerCase()))
					.map((l) => ({ value: l, label: l }));
			},
		},
		{
			name: "reasoning",
			description: "show/hide the model's thinking blocks before replies",
			argumentHint: "<on|off>",
			getArgumentCompletions: (prefix) => {
				const opts = ["on", "off"];
				return opts
					.filter((o) => o.startsWith(prefix.toLowerCase()))
					.map((o) => ({ value: o, label: o }));
			},
		},
		{
			name: "agent",
			description: "show/bind the connection's active agent id",
			argumentHint: "[<agent-id>]",
		},
		{
			name: "session",
			description: "show/bind the connection's active session key",
			argumentHint: "[<session-key>]",
		},
		{
			name: "agents",
			description: "list every agent the gateway knows about",
		},
		{
			name: "sessions",
			description: "list live sessions for the bound agent (or all)",
			argumentHint: "[--all]",
		},
		{
			name: "mute",
			description: "unsubscribe from an agent id or session key",
			argumentHint: "<agent-id|session-key>",
		},
	];
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd()));

	// Connect mode cannot run the provider-onboarding wizard (it writes to the
	// gateway machine's filesystem, which we don't have). We surface that gap
	// inline above the footer so users who notice `/provider` is missing aren't
	// left guessing — they get the exact escape hatch.
	tui.addChild(
		new Text(
			brand.dim("  connect-mode commands: /model · /thinking · /compact · /help (use 'brigade chat' on the gateway machine for /provider)"),
			0,
			0,
		),
	);
	tui.addChild(
		new Text(
			brand.dim("  Enter to send · Ctrl+C abort · /usage /abort /reasoning · /help for full list"),
			0,
			0,
		),
	);

	type AnyChild = Text | Markdown | CancellableLoader | BrigadeEditor | ApprovalPrompt;
	const insertBeforeEditor = (component: AnyChild): void => {
		const children = tui.children;
		const editorIdx = children.indexOf(editor);
		if (editorIdx < 0) {
			tui.addChild(component);
		} else {
			children.splice(editorIdx, 0, component);
			tui.requestRender();
		}
	};
	const removeChild = (component: AnyChild): void => {
		try {
			tui.removeChild(component);
		} catch {
			/* ignore */
		}
	};

	/**
	 * Format the operator's approval choice as a multi-line confirmation
	 * stamped above the editor — replaces the inline card so the chat
	 * history shows BOTH the decision AND the command + persistence target
	 * even after the prompt itself is gone.
	 *
	 * Visual language:
	 *   - Green ✓ on allow (`brand.tool`)
	 *   - Red ✗ on deny (`brand.error`)
	 *   - Persistent decisions ("allow always", "allow pattern") spell out
	 *     the file we just wrote to so the operator can `cat` it to audit.
	 */
	const decisionConfirmation = (
		command: string,
		resolution: ApprovalResolution,
		subagentDepth?: number,
	): string => {
		// When the approval originated from a sub-agent (depth > 0), prefix
		// every line with the same `"  ".repeat(depth)` indent the tool
		// indicators use. Otherwise the confirmation lands at top-level indent
		// while the source `⚡ bash` indicator sits 4 spaces in — visually
		// jarring and easy to misread as "the parent approved that".
		const depth = typeof subagentDepth === "number" && subagentDepth > 0 ? subagentDepth : 0;
		const subIndent = depth > 0 ? "  ".repeat(depth) : "";
		const cmd = `${subIndent}    ${brand.dim(command.trim())}`;
		switch (resolution.decision) {
			case "allow-once":
				return [
					`${subIndent}  ${brand.tool("✓")} ${brand.tool("Allowed once")} ${brand.dim("· running now…")}`,
					cmd,
				].join("\n");
			case "allow-always":
				return [
					`${subIndent}  ${brand.tool("✓")} ${brand.tool("Allowed always")} ${brand.dim("· running now…")}`,
					cmd,
					`${subIndent}    ${brand.dim("Saved to ~/.brigade/exec-approvals.json — future calls will run without asking.")}`,
				].join("\n");
			case "allow-pattern": {
				const pat = resolution.pattern?.trim() ?? "";
				return [
					`${subIndent}  ${brand.tool("✓")} ${brand.tool("Pattern saved")} ${brand.dim("· running now…")}`,
					cmd,
					`${subIndent}    ${brand.dim(`Pattern /${pat}/ saved to ~/.brigade/exec-approvals.json — any future command matching this regex runs without asking.`)}`,
				].join("\n");
			}
			case "deny":
				return [
					`${subIndent}  ${brand.error("✗")} ${brand.error("Denied")} ${brand.dim("· refused")}`,
					cmd,
				].join("\n");
		}
	};

	/**
	 * Extract the renderable text for an assistant message — mirrors
	 * chat.ts's `extractAssistantText`. See chat.ts for the full rationale.
	 */
	const extractAssistantText = (message: any): string => {
		if (!message || !Array.isArray(message.content)) return "";

		const thinkingParts: string[] = [];
		const contentParts: string[] = [];
		for (const b of message.content) {
			if (!b || typeof b !== "object") continue;
			if (b.type === "thinking" && typeof b.thinking === "string") {
				const t = b.thinking.trim();
				if (t) thinkingParts.push(t);
				continue;
			}
			// Some forwarded shapes use `text` instead of `thinking` on the
			// thinking block (gateway re-emit quirk). Honour both.
			if (b.type === "thinking" && typeof b.text === "string") {
				const t = b.text.trim();
				if (t) thinkingParts.push(t);
				continue;
			}
			if (b.type === "text" && typeof b.text === "string") {
				const inlineThinking: string[] = [];
				const stripped = b.text.replace(
					/<think>([\s\S]*?)<\/think>\s*/g,
					(_m: string, inner: string) => {
						const t = inner.trim();
						if (t) inlineThinking.push(t);
						return "";
					},
				);
				thinkingParts.push(...inlineThinking);
				if (stripped.trim()) contentParts.push(stripped);
			}
		}

		const thinkingText = thinkingParts.join("\n").trim();
		const contentText = contentParts.join("").trim();

		const parts: string[] = [];
		if (showThinking && thinkingText) {
			parts.push(`${brand.dim("[thinking]")}\n${brand.dim(thinkingText)}`);
		}
		if (contentText) parts.push(contentText);
		return parts.join("\n\n");
	};

	/**
	 * Format an elapsed-millisecond duration into a compact label for the
	 * status line — `12s` / `1m 4s` / `2h 3m`. Brigade keeps the loader
	 * Pi-TUI provides; only the elapsed counter is new (no shimmer
	 * animation).
	 */
	const formatElapsed = (ms: number): string => {
		const total = Math.max(0, Math.floor(ms / 1000));
		if (total < 60) return `${total}s`;
		const m = Math.floor(total / 60);
		const s = total % 60;
		if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
		const h = Math.floor(m / 60);
		const mm = m % 60;
		return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
	};

	// No auto-kickoff. Brigade used to auto-send "Wake up, my friend!" as a
	// synthetic first user turn on fresh-bootstrap workspaces; removed so
	// the TUI client never auto-sends. The user types the first message
	// themselves.

	// State snapshots from the gateway — every mutation pushes one.
	client.on("state", (snap) => {
		lastSnapshot = snap;
		isAgentRunning = snap.isAgentRunning;
		// Seed the connection-bound agent from the first snapshot the
		// gateway pushes. The operator can override via `/agent <id>` —
		// once set explicitly, snapshot updates no longer reset the binding.
		if (boundAgentId === undefined && typeof snap.agentId === "string" && snap.agentId.length > 0) {
			boundAgentId = snap.agentId;
		}
		// Wave K — seed the connection-bound session key from the first
		// snapshot. Once set explicitly via `/session <key>`, snapshot
		// updates no longer reset it (mirrors boundAgentId semantics).
		if (boundSessionKey === undefined && typeof snap.sessionKey === "string" && snap.sessionKey.length > 0) {
			boundSessionKey = snap.sessionKey;
		}
		// Wave N3 (bug #3) — fire the initial subscription as soon as we
		// have a non-trivial binding from the gateway. Without this, the
		// server-side broadcast filter falls through to "deliver
		// everything" until the operator types /agent or /session, leaking
		// other agents' frames into this TUI. Fires AT MOST ONCE per
		// connection; subsequent /agent and /session bindings each fire
		// their own applySubscription() from their handlers below.
		if (!seededSubscription && (boundAgentId !== undefined || boundSessionKey !== undefined)) {
			seededSubscription = true;
			void applySubscription();
		}
		updateHeader();
	});

	// Tool-approval prompt — the gateway broadcasts an `approval-request`
	// event when a gated tool (today: `bash`) needs operator consent. We
	// render the inline Y/A/P/N prompt above the editor and resolve via
	// the `approval-resolve` request. Persistence ("allow always" / "allow
	// pattern") is handled SERVER-side in exec-gate's `applyApprovalDecision`,
	// which calls `recordApproval()` and writes `~/.brigade/exec-approvals.json`
	// atomically with 0o600 perms.
	let activePrompt: ApprovalPrompt | null = null;
	client.on("approval-request", (req) => {
		// Wave N3 (bug #3) — defence-in-depth: drop approval prompts that
		// don't belong to the lane this TUI is bound to. Without this, two
		// operators each running /agent X and /agent Y would both render
		// every approval card. Server-side subscribe should already filter
		// this, but a race between /agent rebind + the next gated-tool
		// frame can still leak a stale one here.
		if (isOffLane((req as { agentId?: string }).agentId, (req as { sessionId?: string }).sessionId)) {
			return;
		}
		// If another prompt is somehow already showing (shouldn't happen
		// because exec-gate is serial per-turn), tear it down first so we
		// don't stack prompts on the screen.
		if (activePrompt) {
			try {
				tui.removeChild(activePrompt);
			} catch {
				/* ignore */
			}
			activePrompt = null;
		}
		const prompt = new ApprovalPrompt({
			tui,
			request: {
				id: req.id,
				command: req.command,
				toolName: req.toolName,
				cwd: req.cwd,
				...(req.subagentLabel !== undefined ? { subagentLabel: req.subagentLabel } : {}),
				...(req.subagentDepth !== undefined ? { subagentDepth: req.subagentDepth } : {}),
				...(req.parentRunId !== undefined ? { parentRunId: req.parentRunId } : {}),
			},
			onResolve: (resolution: ApprovalResolution) => {
				// Clear the prompt and hand focus back to the editor BEFORE
				// firing the resolve — so the next agent_start event (which
				// will follow on allow) doesn't fight the prompt for focus.
				if (activePrompt) {
					try {
						tui.removeChild(activePrompt);
					} catch {
						/* ignore */
					}
					activePrompt = null;
				}
				tui.setFocus(editor);
				const confirmation = decisionConfirmation(
					req.command,
					resolution,
					req.subagentDepth,
				);
				insertBeforeEditor(new Text(confirmation, 0, 0));
				tui.requestRender();
				void client
					.request("approval-resolve", {
						id: req.id,
						decision: resolution.decision,
						pattern: resolution.pattern,
					})
					.catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err);
						insertBeforeEditor(
							new Text(`  ${brand.error("✗")} ${brand.error(`approval send failed: ${msg}`)}`, 0, 0),
						);
					});
			},
		});
		activePrompt = prompt;
		insertBeforeEditor(prompt);
		tui.setFocus(prompt);
		tui.requestRender();
	});

	// Server-side warnings/info (e.g. "primary failed, trying fallback") — the
	// gateway emits these via the wrapper-chain callbacks. Mirror to the TUI
	// so the user sees the same context they would in `brigade chat`.
	client.on("log", (entry) => {
		// Wave N3 (bug #3) — defensive lane drop. Stamped log entries from
		// off-lane agents get silently dropped here, matching the same
		// filter the server's subscribe applies.
		if (isOffLane(entry.agentId, entry.sessionId)) return;
		const tone =
			entry.level === "error"
				? brand.error(`✗ ${entry.message}`)
				: entry.level === "warn"
					? brand.dim(`⚠ ${entry.message}`)
					: brand.dim(`↻ ${entry.message}`);
		insertBeforeEditor(new Text(`  ${tone}`, 0, 0));
	});

	// `system-event` — out-of-band notification the operator MUST see (today
	// only emitted by the cron service's announce path). Rendered as a
	// visible Brigade-side chat line, NOT in the dim log lane, so a cron
	// reminder firing while the operator is connected actually surfaces.
	// Bug #4 — when `payload.source === "cron"` we always render the cron
	// prefix `[cron "<name>"] <summary>` and append a small delivered/not-
	// delivered hint so the operator can tell whether the channel-side
	// send also landed or only this TUI awareness fired.
	client.on("system-event", (event) => {
		// Wave N3 (bug #3) — defensive lane drop. Cron-fired events stamped
		// for another agent shouldn't surface on this operator's connect TUI.
		if (isOffLane(event.agentId, event.sessionId)) return;
		const isCron = event.source === "cron" || event.jobName !== undefined;
		if (isCron) {
			const name = event.jobName ?? "cron";
			const heading = brand.amber(`🦁 [cron "${name}"]`);
			let suffix = "";
			if (event.delivered === true) {
				suffix = ` ${brand.dim("· delivered")}`;
			} else if (event.delivered === false) {
				suffix = ` ${brand.dim("· not delivered (TUI only)")}`;
			}
			insertBeforeEditor(new Text(`${heading} ${event.text}${suffix}`, 0, 0));
		} else {
			const heading = brand.amber("🦁");
			insertBeforeEditor(new Text(`${heading} ${event.text}`, 0, 0));
		}
		tui.requestRender();
	});

	// Pi events are forwarded as `{ event: <pi event>, subagentDepth? }`.
	// Same render logic as src/ui/chat.ts but stripped of in-process state
	// mutations. Primitive #6: when `subagentDepth > 0`, indent child events
	// by `2 * depth` spaces so nested sub-agent activity is visually distinct
	// from the parent's stream.
	client.on("pi", (payload: { event: any; subagentDepth?: number; agentId?: string; sessionId?: string }) => {
		const { event, subagentDepth } = payload;
		// Wave N3 (bug #3) — defensive lane drop. The gateway already
		// filters via subscribe; this catches the gap between an /agent or
		// /session rebind and the gateway's next-frame view of the new
		// binding (or a legacy gateway that doesn't filter at all).
		if (isOffLane(payload.agentId, payload.sessionId)) return;
		const depth = typeof subagentDepth === "number" ? subagentDepth : 0;
		const subIndent = depth > 0 ? "  ".repeat(depth) : "";
		switch (event?.type) {
			case "agent_start": {
				isAgentRunning = true;
				agentStartedAt = Date.now();
				whimsicalIdx = 0; // reset so the first phrase is always "thinking"
				editor.disableSubmit = true;
				updateHeader(WHIMSICAL_PHRASES[0]);
				activeLoader = new CancellableLoader(
					tui,
					(s) => brand.amber(s),
					(s) => brand.dim(s),
					"thinking",
				);
				insertBeforeEditor(activeLoader);
				break;
			}
			case "message_update":
			case "message_end": {
				const msg = event.message;
				if (!msg || msg.role !== "assistant") break;
				const text = extractAssistantText(msg);
				if (!text) break;
				if (activeLoader) {
					removeChild(activeLoader);
					activeLoader = null;
				}
				// Label assistant turns with the agent's chosen name (from
				// IDENTITY.md, exposed via state snapshot). Falls back to
				// the runtime container name when the operator hasn't named
				// the agent yet — same convention as the brand colour, just
				// dynamic per-workspace.
				const label = lastSnapshot?.agentName ?? "brigade";
				const labelPrefix = depth > 0 ? "sub-agent" : label;
				const renderedText = `${subIndent}${brand.agent(labelPrefix)}  ${text}`;
				// Per-depth streaming buffers: top-level (depth 0) and each sub-
				// agent (depth ≥ 1) get their OWN Markdown block that grows in
				// place. A child's message_update chunks now land in the child's
				// own buffer (not appended as N fresh blocks, and not overwriting
				// the parent's buffer).
				const existing = activeAssistants.get(depth);
				if (!existing) {
					// Wave N5 (bug #6) — origin attribution. When this turn is
					// running on a non-`main` session (e.g. a channel-routed
					// `agent:<id>:whatsapp:direct:<peer>` lane), drop a small
					// `↳ via <label>` chip ABOVE the assistant block so the
					// operator can tell at a glance that the reply is the
					// agent's answer to an inbound WhatsApp / Slack / cron
					// message — not something they typed locally. We surface
					// it only ONCE per (turn, depth), keyed off the first
					// message_update arriving at this depth (when `existing`
					// is undefined). The home session returns `undefined` from
					// `formatSessionLabel` so the chip is silently omitted on
					// the common path.
					const originLabel = formatSessionLabel(payload.sessionId);
					if (originLabel) {
						insertBeforeEditor(
							new Text(`${subIndent}${brand.dim(`↳ via ${originLabel}`)}`, 0, 0),
						);
					}
					const fresh = new Markdown(renderedText, 1, 0, markdownTheme);
					activeAssistants.set(depth, fresh);
					insertBeforeEditor(fresh);
				} else {
					existing.setText(renderedText);
					tui.requestRender();
				}
				break;
			}
			case "tool_execution_start": {
				if (activeLoader) {
					removeChild(activeLoader);
					activeLoader = null;
				}
				// Close the current depth's assistant text block when a tool starts.
				// Otherwise the assistant block's position is locked at first stream-
				// chunk, and a long final answer flowing in AFTER the tools end ends
				// up rendered ABOVE them. Strictly chronological order — clearing
				// the per-depth pointer lets the next message_update at THIS depth
				// create a fresh block that lands below the most recent tool.
				// We clear ONLY this depth's buffer so a sub-agent's tool start
				// doesn't close the parent's open assistant block (separate streams).
				activeAssistants.delete(depth);
				const indicator = new Text(
					`${subIndent}  ${brand.tool("⚡")} ${brand.tool(event.toolName)}`,
					0,
					0,
				);
				pendingTools.set(event.toolCallId, indicator);
				insertBeforeEditor(indicator);
				break;
			}
			case "tool_execution_end": {
				const indicator = pendingTools.get(event.toolCallId);
				if (indicator) {
					const mark = event.isError ? brand.error("✗") : brand.tool("✓");
					// Append a short preview of what the tool produced so the
					// connect view matches `brigade chat` ("✓ bash · output").
					// Errors preserve newlines + use a bigger budget so the
					// gate's "brigade exec allow ..." call-to-action survives.
					const summary = summarizeToolResult(event.result, {
						preserveNewlines: event.isError,
					});
					if (event.isError && summary.multiline) {
						indicator.setText(`${subIndent}  ${mark} ${brand.tool(event.toolName)}`);
						const errIndent = `${subIndent}      `;
						const indentedBody = summary.preview
							.split("\n")
							.map((line) => `${errIndent}${brand.dim(line)}`)
							.join("\n");
						insertBeforeEditor(new Text(indentedBody, 0, 0));
					} else {
						const preview = summary.hasContent ? ` ${brand.dim(`· ${summary.preview}`)}` : "";
						indicator.setText(`${subIndent}  ${mark} ${brand.tool(event.toolName)}${preview}`);
					}
					tui.requestRender();
					pendingTools.delete(event.toolCallId);
				}
				break;
			}
			case "turn_end": {
				// Intentionally a no-op. Token totals (totalTokensIn / Out /
				// CostUsd) are accumulated SERVER-SIDE in server.ts:156-163
				// on every turn_end, then pushed to us via the very next
				// `state` event at server.ts:165. Our `state` handler above
				// stores that into `lastSnapshot` and calls updateHeader(),
				// which reads the totals from `lastSnapshot`. Doing the
				// accumulation HERE too would double-count.
				//
				// Kept as a labelled case so any future connect-only logic
				// (e.g. per-turn flash UI, telemetry hook) has a place to
				// land — and so the next audit doesn't flag this as missing.
				break;
			}
			case "compaction_start": {
				const pct = lastSnapshot?.contextUsagePercent != null
					? `${Math.round(lastSnapshot.contextUsagePercent)}%`
					: "high";
				insertBeforeEditor(
					new Text(`  ${brand.dim(`⚡ compacting context (was ${pct})…`)}`, 0, 0),
				);
				break;
			}
			case "compaction_end": {
				if (event.aborted) {
					insertBeforeEditor(new Text(`  ${brand.dim("compaction aborted")}`, 0, 0));
				} else {
					// Pi's getContextUsage returns null right after compaction by
					// design — token estimates need a fresh LLM response. Show
					// that explicitly via the snapshot's percent (server pushes
					// a fresh snapshot post-compact).
					const after = lastSnapshot?.contextUsagePercent;
					const afterStr =
						after != null
							? `usage now ${Math.round(after)}%`
							: "usage refreshes after your next message";
					insertBeforeEditor(
						new Text(`  ${brand.amber("✓")} ${brand.dim(`compacted · ${afterStr}`)}`, 0, 0),
					);
				}
				break;
			}
			case "auto_retry_start": {
				// Pi auto-retries transient provider errors (rate limit, 5xx,
				// connection drop). Tell the user it's happening — without this,
				// a slow retry looks like the connection is just hanging.
				const attempt = event.attempt ?? 1;
				const max = event.maxAttempts ?? 1;
				const waitS = Math.round((event.delayMs ?? 0) / 100) / 10;
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(`↻ retrying (attempt ${attempt}/${max}, waiting ${waitS}s)…`)}`,
						0,
						0,
					),
				);
				break;
			}
			case "auto_retry_end": {
				if (event.success === false) {
					insertBeforeEditor(
						new Text(
							`  ${brand.error("✗")} ${brand.error(`gave up after ${event.attempt} attempts`)}`,
							0,
							0,
						),
					);
				}
				break;
			}
			case "agent_end": {
				isAgentRunning = false;
				agentStartedAt = null;
				editor.disableSubmit = false;
				activeAssistants.clear();
				if (activeLoader) {
					removeChild(activeLoader);
					activeLoader = null;
				}
				// Clear any tool indicators that never received a matching
				// `tool_execution_end` — a long session can accumulate these
				// when a model aborts mid-tool and they otherwise pin a Text
				// node in the children list per orphaned tool.
				pendingTools.clear();
				updateHeader();
				break;
			}
		}
	});

	// Reconnect notifications — let the user know what just happened so a
	// dropped/restored gateway doesn't look like phantom output.
	//
	// CRITICAL: on reconnect, request a fresh state snapshot AND aggressively
	// clear any "↯ tool" indicators that were waiting on a `tool_execution_end`
	// event we likely missed while the WS was disconnected. Without this, a
	// reconnect mid-tool leaves the TUI showing `↯ cron` (or any other tool)
	// forever even though the gateway has long since finished — the user sees
	// a "stuck" indicator that's purely a TUI state-staleness bug, not an
	// actual hang.
	client.on("reconnected" as any, () => {
		insertBeforeEditor(new Text(`  ${brand.dim("↻ reconnected to gateway")}`, 0, 0));
		// Fire-and-forget: ask the gateway for the current snapshot so the
		// `state` handler above updates `isAgentRunning` + the header. Errors
		// are swallowed — the next state push (any tool call / turn start)
		// will refresh anyway.
		client.request("get-state").then(
			(snap) => {
				if (!snap) return;
				lastSnapshot = snap;
				isAgentRunning = snap.isAgentRunning;
				// If the gateway says no turn is in flight, then any tool
				// indicators we still hold are stale (their `tool_execution_end`
				// landed while we were disconnected). Mark each one as
				// completed-with-no-known-outcome so the TUI stops spinning.
				if (!snap.isAgentRunning && pendingTools.size > 0) {
					// Reconcile orphaned tool indicators by marking each as
					// completed-with-unknown-outcome. We don't know which tool's
					// `tool_execution_end` was missed during the disconnect, so we
					// can't infer the exit status; the dim ⋯ glyph signals "this
					// tool finished, but the TUI didn't see how" and stops the spin.
					for (const [, indicator] of pendingTools) {
						indicator.setText(`  ${brand.dim("⋯ tool completed during disconnect")}`);
					}
					pendingTools.clear();
				}
				updateHeader();
				tui.requestRender();
			},
			() => {
				/* best-effort — silently ignore */
			},
		);
	});

	// Slash command + send wiring.
	editor.onSubmit = async (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;

		// Local commands first — never reach the gateway.
		if (trimmed === "/exit" || trimmed === "/quit") {
			client.close();
			tui.stop();
			restoreTerminal();
			process.exit(0);
		}
		if (trimmed === "/help") {
			editor.setText("");
			insertBeforeEditor(
				new Markdown(
					`${brand.dim("commands")}\n` +
						`- ${chalk.bold("/exit")} or ${chalk.bold("/quit")} — disconnect & quit\n` +
						`- ${chalk.bold("/help")} — this list\n` +
						`- ${chalk.bold("/model <id>")} — switch to a configured model on the gateway\n` +
						`- ${chalk.bold("/thinking <level>")} — set reasoning effort (off|minimal|low|medium|high|xhigh)\n` +
						`- ${chalk.bold("/compact")} — summarize older turns to free up context\n` +
						`- ${chalk.bold("/abort")} — stop the in-flight turn\n` +
						`- ${chalk.bold("/usage")} — show token + cost totals for this session\n` +
						`- ${chalk.bold("/reasoning <on|off>")} — show/hide the model's thinking blocks before replies (default: off)\n` +
						`- ${chalk.bold("/agent [<id>]")} — show/bind the connection's active agent\n` +
						`- ${chalk.bold("/session [<key>]")} — show/bind the connection's active session\n` +
						`- ${chalk.bold("/agents")} — list every agent the gateway knows about\n` +
						`- ${chalk.bold("/sessions [--all]")} — list live sessions (bound agent or all)\n` +
						`- ${chalk.bold("/mute <id|key>")} — unsubscribe from an agent id or session key\n` +
						`- ${chalk.bold("Ctrl+C")} — abort the current turn (same as /abort)\n` +
						`- ${chalk.bold("Ctrl+D")} — quit\n\n` +
						brand.dim("To add a new provider, run `brigade onboard` on the gateway machine."),
					1,
					0,
					markdownTheme,
				),
			);
			return;
		}

		// /session [key] — print or rebind the connection's bound session key.
		// Wave K — without this the TUI can only steer/abort/compact the boot
		// agent's `main` lane. With `/session agent:main:whatsapp:<jid>` an
		// operator can intervene in a runaway channel turn from the TUI.
		// No-arg form prints the current binding.
		if (trimmed === "/session" || trimmed.startsWith("/session ")) {
			editor.setText("");
			const arg = trimmed === "/session" ? "" : trimmed.slice("/session ".length).trim();
			if (!arg) {
				const cur = boundSessionKey ?? lastSnapshot?.sessionKey ?? "(unset)";
				insertBeforeEditor(
					new Text(`  ${brand.dim("bound session:")} ${brand.amber(cur)}`, 0, 0),
				);
				return;
			}
			boundSessionKey = arg;
			insertBeforeEditor(
				new Text(
					`  ${brand.amber("✓")} ${brand.dim("bound to session")} ${brand.amber(arg)}`,
					0,
					0,
				),
			);
			updateHeader();
			void applySubscription();
			return;
		}

		// /agents — list every agent the gateway has runtime state for.
		// Wave N5 (bug #9). Pulls from the gateway via `agents.list` so the
		// list is always source-of-truth (no client-side mirror to fall out
		// of sync with set-model writes). The currently-bound agent is
		// flagged with a `←` so the operator can tell at a glance which
		// agent their typing currently targets.
		if (trimmed === "/agents") {
			editor.setText("");
			let agents: AgentSummary[];
			try {
				agents = await client.request("agents.list");
			} catch (err) {
				insertBeforeEditor(
					new Text(
						`  ${brand.error("✗")} ${brand.error(err instanceof Error ? err.message : String(err))}`,
						0,
						0,
					),
				);
				return;
			}
			if (agents.length === 0) {
				insertBeforeEditor(
					new Text(`  ${brand.dim("no agents configured on the gateway")}`, 0, 0),
				);
				return;
			}
			const bound = boundAgentId ?? lastSnapshot?.agentId;
			const lines = agents.map((a) => {
				const here = a.id === bound ? " " + brand.amber("← bound") : "";
				const bootTag = a.isBoot ? " " + brand.dim("(boot)") : "";
				const persona = a.personaName ? " " + brand.dim(`· ${a.personaName}`) : "";
				return `  ${brand.white(a.id)}${persona}  ${brand.dim(`${a.provider} · ${a.modelId}`)}${bootTag}${here}`;
			});
			insertBeforeEditor(
				new Markdown(
					`${brand.dim("agents on the gateway:")}\n${lines.join("\n")}\n\n${brand.dim("usage: /agent <id> to bind")}`,
					1,
					0,
					markdownTheme,
				),
			);
			return;
		}

		// /sessions [--all] — list live (in-flight Pi) sessions. Defaults to
		// the bound agent's sessions; `--all` returns every agent's. Wave N5
		// (bug #9). Combine with /session <key> to bind to one of them.
		if (trimmed === "/sessions" || trimmed.startsWith("/sessions ")) {
			editor.setText("");
			const arg = trimmed === "/sessions" ? "" : trimmed.slice("/sessions ".length).trim();
			const wantsAll = /\b--?all\b/i.test(arg);
			let sessions: SessionSummary[];
			try {
				const params: { agentId?: string; all?: boolean } = wantsAll
					? { all: true }
					: boundAgentId !== undefined
						? { agentId: boundAgentId }
						: {};
				sessions = await client.request("sessions.list", params);
			} catch (err) {
				insertBeforeEditor(
					new Text(
						`  ${brand.error("✗")} ${brand.error(err instanceof Error ? err.message : String(err))}`,
						0,
						0,
					),
				);
				return;
			}
			if (sessions.length === 0) {
				const scope = wantsAll
					? "no live sessions on the gateway"
					: `no live sessions for agent ${boundAgentId ?? lastSnapshot?.agentId ?? "main"}`;
				insertBeforeEditor(
					new Text(`  ${brand.dim(scope)} ${brand.dim("(turns run between requests — try again during one)")}`, 0, 0),
				);
				return;
			}
			const boundKey = boundSessionKey ?? lastSnapshot?.sessionKey;
			const lines = sessions.map((s) => {
				const friendly = formatSessionLabel(s.sessionKey) ?? brand.dim("(home)");
				const here = s.sessionKey === boundKey ? " " + brand.amber("← bound") : "";
				return `  ${brand.white(s.agentId)}  ${friendly}  ${brand.dim(s.sessionKey)}${here}`;
			});
			const scopeLine = wantsAll
				? "live sessions (all agents):"
				: `live sessions for agent ${boundAgentId ?? lastSnapshot?.agentId ?? "main"}:`;
			insertBeforeEditor(
				new Markdown(
					`${brand.dim(scopeLine)}\n${lines.join("\n")}\n\n${brand.dim("usage: /session <key> to bind · /mute <id|key> to unsubscribe")}`,
					1,
					0,
					markdownTheme,
				),
			);
			return;
		}

		// /mute <id> — drop a subscription on the gateway. Accepts EITHER
		// an agentId (e.g. `ops`) or a full sessionKey (e.g.
		// `agent:main:whatsapp:direct:+91…`). Heuristic: anything starting
		// with `agent:` is treated as a sessionKey; everything else is an
		// agentId. Wave N5 (bug #9). Wires to the existing `unsubscribe`
		// RPC so the per-conn filter (server.ts:861-882) stops delivering
		// frames tagged with that lane to this connection.
		if (trimmed === "/mute" || trimmed.startsWith("/mute ")) {
			editor.setText("");
			const arg = trimmed === "/mute" ? "" : trimmed.slice("/mute ".length).trim();
			if (!arg) {
				insertBeforeEditor(new Text(`  ${brand.dim("usage: /mute <agent-id|session-key>")}`, 0, 0));
				return;
			}
			const isSessionKey = arg.toLowerCase().startsWith("agent:");
			const params: { agentId?: string; sessionId?: string } = isSessionKey
				? { sessionId: arg }
				: { agentId: arg };
			try {
				await client.request("unsubscribe", params);
				// Keep our local lastSubscribed* mirror honest so a later
				// applySubscription() doesn't try to undo a subscribe we just
				// muted — only clear the mirror entry that matches the muted lane.
				if (isSessionKey && lastSubscribedSessionKey === arg) {
					lastSubscribedSessionKey = undefined;
				}
				if (!isSessionKey && lastSubscribedAgentId === arg) {
					lastSubscribedAgentId = undefined;
				}
				const kind = isSessionKey ? "session" : "agent";
				insertBeforeEditor(
					new Text(
						`  ${brand.amber("✓")} ${brand.dim(`muted ${kind}`)} ${brand.amber(arg)}`,
						0,
						0,
					),
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0));
			}
			return;
		}

		// /agent [id] — print or rebind the connection's bound agent. When the
		// gateway runs multi-agent (cfg.agents.<id> with per-agent runtime),
		// the operator uses this to switch which agent their typing targets
		// without reconnecting. No-arg form prints the current binding.
		if (trimmed === "/agent" || trimmed.startsWith("/agent ")) {
			editor.setText("");
			const arg = trimmed === "/agent" ? "" : trimmed.slice("/agent ".length).trim();
			if (!arg) {
				const cur = boundAgentId ?? lastSnapshot?.agentId ?? "(unset)";
				insertBeforeEditor(
					new Text(`  ${brand.dim("bound agent:")} ${brand.amber(cur)}`, 0, 0),
				);
				return;
			}
			boundAgentId = arg;
			insertBeforeEditor(
				new Text(
					`  ${brand.amber("✓")} ${brand.dim("bound to agent")} ${brand.amber(arg)}`,
					0,
					0,
				),
			);
			updateHeader();
			void applySubscription();
			return;
		}

		// /abort — explicit slash-form for the same action Ctrl+C performs.
		// Returning true from `handle.abort()` means a turn was running; the
		// chat loop's SIGINT path uses the same primitive.
		if (trimmed === "/abort") {
			editor.setText("");
			if (!isAgentRunning) {
				insertBeforeEditor(new Text(`  ${brand.dim("nothing to abort — agent is idle")}`, 0, 0));
				return;
			}
			try {
				await client.request("abort", withBinding());
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.dim("aborted")}`, 0, 0));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0));
			}
			return;
		}

		// /reasoning [on|off] — toggle whether the assistant's thinking blocks
		// render before each reply. Pi pushes thinking via `pi` events
		// regardless; this is purely a local view filter applied in
		// `extractAssistantText`.
		if (trimmed === "/reasoning" || trimmed.startsWith("/reasoning ")) {
			editor.setText("");
			const arg = trimmed === "/reasoning" ? "" : trimmed.slice("/reasoning ".length).trim().toLowerCase();
			if (arg === "on" || arg === "true" || arg === "1") {
				showThinking = true;
			} else if (arg === "off" || arg === "false" || arg === "0") {
				showThinking = false;
			} else if (arg.length === 0 || arg === "toggle") {
				showThinking = !showThinking;
			} else {
				insertBeforeEditor(new Text(`  ${brand.dim("usage: /reasoning <on|off>")}`, 0, 0));
				return;
			}
			insertBeforeEditor(
				new Text(
					`  ${brand.dim(showThinking ? "reasoning: on  (model thinking will render before each reply)" : "reasoning: off")}`,
					0,
					0,
				),
			);
			return;
		}

		// /usage — render the cumulative usage block from the latest state
		// snapshot. All fields come from the server's SessionStateSnapshot
		// — no extra RPC needed.
		if (trimmed === "/usage") {
			editor.setText("");
			const snap = lastSnapshot;
			if (!snap) {
				insertBeforeEditor(new Text(`  ${brand.dim("no usage yet — server hasn't sent a state snapshot")}`, 0, 0));
				return;
			}
			const tokenIn = snap.totalTokensIn.toLocaleString();
			const tokenOut = snap.totalTokensOut.toLocaleString();
			const tokenTotal = (snap.totalTokensIn + snap.totalTokensOut).toLocaleString();
			const costStr = snap.totalCostUsd > 0 ? `$${snap.totalCostUsd.toFixed(4)}` : "$0.0000";
			const ctxStr = snap.contextUsagePercent != null ? `${Math.round(snap.contextUsagePercent)}%` : "—";
			insertBeforeEditor(
				new Markdown(
					`${brand.dim("usage")}\n` +
						`- ${chalk.bold("model:")}    ${snap.provider ?? "?"} · ${snap.modelId ?? "?"}\n` +
						`- ${chalk.bold("turns:")}    ${snap.messageCount}\n` +
						`- ${chalk.bold("tokens:")}   ${tokenIn} in · ${tokenOut} out · ${tokenTotal} total\n` +
						`- ${chalk.bold("cost:")}     ${costStr}\n` +
						`- ${chalk.bold("context:")}  ${ctxStr} used\n` +
						`- ${chalk.bold("thinking:")} ${snap.thinkingLevel}` +
						(snap.supportsThinking
							? brand.dim(` (available: ${snap.availableThinkingLevels.join(", ")})`)
							: brand.dim(" (model doesn't support reasoning)")),
					1,
					0,
					markdownTheme,
				),
			);
			return;
		}

		// Mid-turn submit → STEER. The gateway has the same Pi semantics; queueing
		// the message lets the model see it on the next iteration without abort.
		if (isAgentRunning) {
			editor.setText("");
			try {
				await client.request("steer", withBinding({ text: trimmed }));
				insertBeforeEditor(
					new Markdown(`${brand.user("you")}  ${trimmed}`, 1, 0, markdownTheme),
				);
				insertBeforeEditor(
					new Text(
						`  ${brand.dim("↳ queued — the model will see this on its next turn")}`,
						0,
						0,
					),
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0));
			}
			return;
		}

		// /compact — same long-run rationale as `prompt` above; compaction
		// can take a while on a big transcript, beyond the default 60s.
		if (trimmed === "/compact") {
			editor.setText("");
			insertBeforeEditor(new Text(`  ${brand.dim("Compacting…")}`, 0, 0));
			try {
				await client.request("compact", withBinding(), { timeoutMs: 0 });
				insertBeforeEditor(new Text(`  ${brand.amber("✓")} ${brand.dim("Compacted")}`, 0, 0));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.error(`Compaction failed: ${msg}`)}`, 0, 0),
				);
			}
			return;
		}

		// /model <id>  — switch by id (the gateway resolves provider via its registry)
		if (trimmed === "/model" || trimmed.startsWith("/model ")) {
			editor.setText("");
			let models: ModelSummary[];
			try {
				models = await client.request("list-models");
			} catch (err) {
				insertBeforeEditor(
					new Text(
						`  ${brand.error("✗")} ${brand.error(err instanceof Error ? err.message : String(err))}`,
						0,
						0,
					),
				);
				return;
			}

			const arg = trimmed === "/model" ? "" : trimmed.slice("/model ".length).trim();
			if (!arg) {
				const list = models
					.map((m) => `  ${brand.dim(m.provider)}  ${brand.white(m.id)}`)
					.join("\n");
				insertBeforeEditor(
					new Markdown(
						`${brand.dim("configured models on the gateway:")}\n${list}\n\n${brand.dim("usage: /model <id>")}`,
						1,
						0,
						markdownTheme,
					),
				);
				return;
			}

			// Prefer current provider on tie.
			const currentProvider = lastSnapshot?.provider;
			const matches = models.filter((m) => m.id === arg);
			const target =
				matches.find((m) => m.provider === currentProvider) ?? matches[0];
			if (!target) {
				insertBeforeEditor(
					new Text(`  ${brand.error(`✗ no model with id "${arg}" on the gateway.`)}`, 0, 0),
				);
				return;
			}
			try {
				await client.request(
					"set-model",
					withBinding({ provider: target.provider, modelId: target.id }),
				);
				insertBeforeEditor(
					new Text(
						`  ${brand.amber("✓")} ${brand.dim("switched to")} ${brand.white(`${target.provider} · ${target.id}`)}`,
						0,
						0,
					),
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0));
			}
			return;
		}

		// /thinking [level]
		if (trimmed === "/thinking" || trimmed.startsWith("/thinking ")) {
			editor.setText("");
			const arg = trimmed === "/thinking" ? "" : trimmed.slice("/thinking ".length).trim().toLowerCase();
			if (!arg) {
				const cur = lastSnapshot?.thinkingLevel ?? "?";
				const avail = lastSnapshot?.availableThinkingLevels ?? [];
				insertBeforeEditor(
					new Text(
						`  ${brand.dim("thinking is")} ${brand.amber(cur)} ${brand.dim("· available:")} ${brand.dim(avail.join(" "))}`,
						0,
						0,
					),
				);
				return;
			}
			try {
				await client.request("set-thinking", withBinding({ level: arg }));
				insertBeforeEditor(
					new Text(
						`  ${brand.amber("✓")} ${brand.dim("thinking set to")} ${brand.amber(arg)}`,
						0,
						0,
					),
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0));
			}
			return;
		}

		// Default — send as a prompt. Override timeout to 0 (disabled): the
		// SERVER bounds turn duration via the 6-layer wrapper chain (heartbeat,
		// stream-timeout, length-continuation). A client-side 60s cap would
		// reject WHILE the server keeps processing, producing silent state
		// desync — next user message would interleave with the in-flight reply.
		insertBeforeEditor(new Markdown(`${brand.user("you")}  ${trimmed}`, 1, 0, markdownTheme));
		editor.setText("");
		try {
			// Carry the connection's bound agentId when set so the gateway
			// routes this turn to that agent's session lane + runtime entry.
			// Legacy single-agent gateways receive the same boot agent the
			// snapshot reported, so behaviour is unchanged.
			await client.request("prompt", withBinding({ text: trimmed }), { timeoutMs: 0 });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0));
		}
	};

	tui.requestRender();

	return {
		abort: () => {
			if (!isAgentRunning) return false;
			void client.request("abort", withBinding()).catch(() => {});
			isAgentRunning = false;
			agentStartedAt = null;
			editor.disableSubmit = false;
			if (activeLoader) {
				removeChild(activeLoader);
				activeLoader = null;
			}
			// Hygiene on abort: clear any in-flight tool indicators (they'll
			// never get a tool_execution_end now) and drop the assistant-
			// block pointer so the NEXT turn opens a fresh block instead of
			// appending to the aborted one's stale Markdown component.
			for (const indicator of pendingTools.values()) {
				removeChild(indicator);
			}
			pendingTools.clear();
			activeAssistants.clear();
			insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.dim("aborted")}`, 0, 0));
			updateHeader();
			return true;
		},
		close: async () => {
			client.close();
		},
	};
}
