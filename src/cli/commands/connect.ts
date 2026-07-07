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
 * thinking level, compact, exit).
 *
 * `/provider` works here too: switching among configured providers reuses the
 * `set-model` RPC, and adding a new API-key provider inline routes the typed
 * key to the gateway's `add-provider` RPC, which validates + persists it on
 * the GATEWAY side (auth-profiles.json) and hot-refreshes the model registry.
 * Because the credential write happens server-side, the TUI client never needs
 * gateway-filesystem access. Subscription / local / custom providers (OAuth,
 * Ollama, BYO-endpoint) still need the full `brigade onboard` wizard.
 */

import process from "node:process";
import { randomUUID } from "node:crypto";

import {
	CancellableLoader,
	CombinedAutocompleteProvider,
	ProcessTerminal,
	type SlashCommand,
	Text,
	TUI,
} from "@earendil-works/pi-tui";

import { BrigadeEditor } from "../../ui/editor.js";
import { PROVIDERS, findProvider } from "../../providers/catalog.js";
import { sanitizeTerminalInput } from "../../security/terminal-input-sanitizer.js";
import chalk from "chalk";

// Brigade's `Markdown` is a thin Pi-TUI subclass that normalizes `_text_`
// italic spans to `*text*` so the renderer applies italic styling instead
// of leaking literal underscores. Same shape as Pi-TUI's `Markdown` — drop-in.
import { Markdown } from "../../ui/markdown.js";
import { loaderIndicator, probeTerminalAnimationSupport } from "../../ui/animations.js";
import { renderBrandHeader } from "../../ui/brand.js";
import { formatCrewLabel, formatSessionLabel } from "../../ui/format-session.js";
import { markTuiActive, restoreTerminal } from "../../ui/terminal-cleanup.js";
import { brand, editorTheme, markdownTheme } from "../../ui/theme.js";
import { summarizeToolResult } from "../../ui/tool-result.js";
import { BrigadeClient } from "../../tui/client.js";
import { loadConfig } from "../../core/config.js";
import { resolveClientToken } from "../../core/gateway-auth.js";
import { asstKey, clipOneLine, extractUserText, joinToolResultText } from "./connect-transcript.js";
import { ApprovalPrompt, type ApprovalResolution } from "../../tui/approval-prompt.js";
import type { AgentSummary, EventPayload, ModelSummary, SessionStateSnapshot, SessionSummary } from "../../protocol.js";
import {
	computeExplain,
	filterGraphToSubtree,
	formatExplain,
	parseOrgSlash,
	renderDepartmentsOnly,
} from "./org-slash.js";
import {
	renderPrideChartWithPins,
	BRIGADE_FOOTER_RULE,
} from "../../agents/org/pride-template.js";
import type { MemoryQueryResult } from "../../agents/memory/query.js";
import type { OrgGraph } from "../../agents/org/types.js";

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
	/**
	 * Token for an authenticated gateway. Falls back to `BRIGADE_GATEWAY_TOKEN`
	 * then the local `gateway.auth` config when omitted; undefined for an
	 * unauthenticated gateway (the default), in which case no auth is sent.
	 */
	token?: string;
	/**
	 * Bind the TUI to this agent id at startup — equivalent to opening the
	 * TUI and immediately running `/agent <id>`, but without the manual step.
	 * Validated against the gateway's `agents.list` before the UI engages;
	 * an unknown id exits with the available list (an unvalidated id would
	 * silently fall back to the boot agent server-side, so the operator
	 * would think they were talking to X while actually talking to main).
	 */
	agentId?: string;
}

export interface ConnectHandle {
	/** Aborts the in-flight turn (true) or signals "no turn was running" (false). */
	abort(): boolean;
	close(): Promise<void>;
}

/**
 * Should a `state` snapshot's `sessionKey` seed the connection-bound session?
 *
 * Yes when unbound (normal first-snapshot seed) or when the snapshot is for
 * the SAME agent we're bound to. No when bound to a DIFFERENT agent than the
 * snapshot — that's the `--agent X` cross-agent-session bug: the gateway's
 * boot snapshot (agent `main`, session `agent:main:main`) must NOT seed the
 * session for a connection bound to `marketing-lead`, or `withBinding` emits
 * the incoherent pair `{agentId: marketing-lead, sessionKey: agent:main:main}`
 * and the reply gets filtered to the wrong lane. Exported for regression
 * testing of that exact decision.
 */
export function snapshotSessionSeedable(
	boundAgentId: string | undefined,
	snapAgentId: string | undefined,
): boolean {
	if (boundAgentId === undefined) return true;
	return typeof snapAgentId === "string" && snapAgentId === boundAgentId;
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

	// Ask the terminal whether it can repaint atomically (DECRQM 2026) while
	// stdin is still ours — decides animated vs static chrome. ≤150 ms once.
	await probeTerminalAnimationSupport();

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

	// Resolve the gateway token (flag → BRIGADE_GATEWAY_TOKEN → local config).
	// Undefined when the gateway is unauthenticated — the client then sends no
	// auth header and connects exactly as before.
	const token = resolveClientToken(loadConfig().gateway?.auth, { override: opts.token });
	const client = new BrigadeClient({
		url,
		requestTimeoutMs: opts.requestTimeoutMs ?? 60_000,
		...(token ? { token } : {}),
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

	// Startup `--agent <id>` binding. Validate against the gateway's live
	// agent list BEFORE engaging the UI — an unknown id would otherwise fall
	// back to the boot agent server-side (getAgentRuntime), silently routing
	// the operator's turns to `main` while they believe they're talking to X.
	// Mirrors the in-TUI `/agent` validation. agents.list failure is lenient
	// (bind anyway; the in-TUI /agent can correct) so a transient RPC hiccup
	// doesn't block launch.
	let initialAgentId: string | undefined;
	if (opts.agentId) {
		try {
			const known = (await client.request("agents.list")) as AgentSummary[];
			if (!known.some((a) => a.id === opts.agentId)) {
				tui.stop();
				restoreTerminal();
				const available = known.map((a) => a.id).join(", ") || "(none)";
				console.error(chalk.red(`✗ Unknown agent "${opts.agentId}".`));
				console.error(chalk.dim(`  Available: ${available}`));
				console.error(chalk.dim(`  (run \`brigade agents list\` to see them all)`));
				process.exit(1);
			}
			initialAgentId = opts.agentId;
		} catch {
			// Lenient: bind anyway; `/agent` inside the TUI re-validates.
			initialAgentId = opts.agentId;
		}
	}

	chatHandle = await wireConnectUi(tui, client, initialAgentId);
	return chatHandle;
}

/**
 * Build the live chat UI on top of an already-connected client. Split out so
 * tests can inject a pre-connected client without going through CLI flag
 * parsing or process.exit.
 */
export async function wireConnectUi(
	tui: TUI,
	client: BrigadeClient,
	initialAgentId?: string,
): Promise<ConnectHandle> {
	// Static (last-frame) wordmark — `brigade connect` is the chat surface
	// just like `brigade chat`, so we want the same still rendering here. The
	// looping clip is reserved for onboarding's one-time wow moment.
	renderBrandHeader(tui, { animate: false });

	const header = new Text("", 0, 0);
	tui.addChild(header);
	const divider = new Text(brand.dim("─".repeat(80)), 0, 0);
	tui.addChild(divider);
	// Persistent status FOOTER. Pi-TUI renders a viewport anchored to the
	// focused editor at the bottom, so the top header (brand wordmark + this
	// model/token line) scrolls ABOVE the viewport as soon as a streamed reply
	// fills the screen — the operator loses sight of the model + token/cost
	// readout exactly when a turn is running. The footer lives in the
	// always-visible bottom region (added after the editor, alongside the hint
	// lines), and `updateHeader` paints the same live status into it. Declared
	// here so the first `updateHeader()` (before the editor is built) can target
	// it; added to the tree below, right under the editor.
	const footer = new Text("", 0, 0);

	// Cumulative usage — accumulated from state snapshots so a reconnect picks
	// up where we left off instead of zeroing the totals on the user's screen.
	let lastSnapshot: SessionStateSnapshot | null = null;
	// The last text the user sent as a prompt — the replay message for a `/switch`
	// (Carrow) mid-turn model handoff: abort the live turn, swap, re-run this on the new model.
	let lastUserPrompt = "";
	let isAgentRunning = false;
	// `/provider <name>` for an UNCONFIGURED provider arms this — the NEXT line
	// the operator submits is captured as that provider's API key (sent to the
	// gateway's `add-provider`, never echoed into the transcript or input
	// history) instead of being sent as a chat prompt. Cleared on submit/cancel.
	let pendingProviderEntry: { providerId: string; providerName: string } | null = null;
	// Connection-bound agent id. Defaults to the gateway's boot agent (filled
	// in from the first `state` snapshot) so legacy single-agent gateways keep
	// working unchanged. The `/agent <id>` slash command rebinds the connection
	// so subsequent prompt / abort / steer / set-model / set-thinking RPCs all
	// target that agent without the operator having to repeat it every turn.
	// Seeded from `--agent <id>` when supplied (already validated against
	// agents.list in runConnectCommand); otherwise filled from the first
	// `state` snapshot. A pre-set value is preserved by the snapshot handler's
	// `=== undefined` guard, so the startup binding sticks.
	let boundAgentId: string | undefined = initialAgentId;
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
	const isOffLane = (frameAgentId?: string, frameSessionId?: string, subagentDepth?: number): boolean => {
		if (boundAgentId !== undefined && typeof frameAgentId === "string" && frameAgentId.length > 0) {
			if (frameAgentId !== boundAgentId) return true;
		}
		// A SUB-AGENT of the bound agent is in-lane regardless of its session id.
		// Sub-agent STREAMING pi frames carry a child Pi-session UUID (NOT the
		// `…:subagent:…` descendant key), so the session-prefix check below can't
		// catch them — the depth tag is the reliable signal. Without this, the
		// operator watching the parent turn never sees the sub-agent working
		// (only its approval prompts, which DO carry the descendant key, slipped
		// through). The agent already matched above, so this can't leak another
		// agent's sub-agents.
		if (typeof subagentDepth === "number" && subagentDepth > 0) return false;
		if (boundSessionKey !== undefined && typeof frameSessionId === "string" && frameSessionId.length > 0) {
			// In-lane = the bound session OR a sub-agent DESCENDANT of it. A
			// spawned sub-agent runs under a child key (`<bound>:subagent:<id>`),
			// so its live frames + approval prompts belong to the operator
			// watching this lane — without this they'd be dropped, the sub-agent's
			// work would be invisible, and its `bash` approval prompt would never
			// render (the turn hangs until the approval times out). Trailing ":"
			// prevents a sibling (`…:main2`) from matching (`…:main`).
			if (frameSessionId !== boundSessionKey && !frameSessionId.startsWith(`${boundSessionKey}:`)) return true;
		}
		return false;
	};
	// SECURITY (render-side escape scrub). The operator's OWN input is already
	// scrubbed at the submit chokepoint (`sanitizeTerminalInput` in
	// `editor.onSubmit`), but every string the GATEWAY pushes — tool-result
	// previews, assistant text, log lines, cron system-events, the bash command
	// echoed back in an approval confirmation — is attacker-influenceable (a
	// model/tool can be steered to emit control bytes) and reaches a `Text` /
	// `Markdown` widget that preserves raw ANSI. Embedded ESC[ / OSC sequences
	// would otherwise move the cursor, clear the screen, rewrite the window
	// title, or smuggle an OSC 52 clipboard write. Funnel every server-pushed
	// render string through this single helper before it hits a widget.
	//
	// `sanitizeTerminalInput` already strips CSI/OSC/leaked-paste/stray-ESC, but
	// it does NOT strip non-ESC C0 (0x00-0x1F, minus \n/\t) or C1 (0x80-0x9F)
	// control bytes — those can still drive a terminal on their own — so we
	// remove them here too. Newlines and tabs are preserved (multi-line tool
	// errors + the `brigade exec allow …` call-to-action must keep their
	// layout). Idempotent + pure; safe to apply to already-clean text.
	const scrubRenderable = (text: string): string => {
		if (!text) return text;
		// First reuse the input-side stripper (CSI/OSC/leaked-paste/stray-ESC +
		// lone-surrogate repair), then drop remaining bare C0/C1 control bytes.
		// eslint-disable-next-line no-control-regex
		return sanitizeTerminalInput(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
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
	// Streaming-assistant buffers keyed by MESSAGE IDENTITY, not arrival
	// position. The key is `${depth}:${timestamp}` — Pi stamps each assistant
	// message with a stable `timestamp` at creation that is constant across all
	// its `message_update`s and its `message_end`, and a NEW message (e.g. the
	// continuation after a tool call) gets a NEW timestamp. So each logical
	// message owns exactly one growing Markdown block, and a block lands where
	// its message belongs in the stream — never above a tool it came after, and
	// a late/duplicate update for an earlier message updates THAT block in place
	// instead of spawning a misplaced copy. This identity keying is also what
	// makes `resume` idempotent: re-applying a message the client already has
	// resolves to the same block. Depth keeps sub-agent (≥1) streams from
	// colliding with the top-level (0) stream. Cleared wholesale on `agent_end`
	// / abort (turn boundary). `pendingTools` is already identity-keyed by the
	// tool call id.
	const activeAssistants = new Map<string, Markdown>();
	let activeLoader: CancellableLoader | null = null;
	const pendingTools = new Map<string, Text>();
	// `asstKey` (identity key for an assistant block) is imported from
	// `connect-transcript.js` so the live path + the resume rebuild + the unit
	// tests all share one definition.
	// Streaming render coalescer. Every `setText()` on the streaming Markdown
	// widget invalidates the parser cache, so each paint re-parses the FULL
	// growing reply (Marked + line-wrap + ANSI styling). At 60Hz that's a
	// continuous parse stall that blocks scroll events queued in the
	// terminal's input buffer, causing the flicker + scroll-lock the operator
	// sees on Windows Terminal. 150ms (~6–7 paints/sec while streaming) is the
	// chosen default — slow enough that each paint's parse cost is small
	// relative to the gap, fast enough that streaming still feels live.
	// Override with `BRIGADE_STREAM_RENDER_MS` (clamped to ≥16). Raise to 250–400
	// if a slow terminal still flickers; lower to 30–60 on a fast terminal
	// (iTerm, Alacritty, recent Kitty) for snappier streaming.
	const streamRenderMs = Math.max(
		16,
		Number(process.env.BRIGADE_STREAM_RENDER_MS) || 150,
	);
	let streamRenderTimer: NodeJS.Timeout | null = null;
	const scheduleStreamingRender = (): void => {
		if (streamRenderTimer) return;
		streamRenderTimer = setTimeout(() => {
			streamRenderTimer = null;
			tui.requestRender();
		}, streamRenderMs);
		if (typeof streamRenderTimer.unref === "function") streamRenderTimer.unref();
	};
	const flushStreamingRender = (): void => {
		if (streamRenderTimer) {
			clearTimeout(streamRenderTimer);
			streamRenderTimer = null;
		}
		tui.requestRender();
	};
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
		// Mirror the live model + token/cost/context readout into the bottom
		// status footer so it survives the viewport scroll while a turn streams
		// (the top header scrolls out of view; this stays pinned by the editor).
		footer.setText(
			`  ${dot} ${brand.dim(`${provider} · ${modelId}${tokens}${cost}`)}${usageStr}${brand.dim(elapsed)}${brand.dim(tail)}`,
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
	// Pin the live status line directly under the editor — the bottom region
	// Pi-TUI keeps in view (the hint lines below also live here). This is what
	// keeps `provider · model · tokens · cost` visible while a reply streams.
	tui.addChild(footer);

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
			name: "memory",
			description: "inspect memory — list / search <q> / inspect <id> / stats",
			argumentHint: "[list | search <q> | inspect <id> | stats]",
			getArgumentCompletions: (prefix) => {
				const verbs = ["list", "search", "inspect", "stats"];
				return verbs
					.filter((v) => v.startsWith(prefix.toLowerCase()))
					.map((v) => ({ value: v, label: v }));
			},
		},
		{
			name: "allow-all",
			description: "on|off — skip shell approval prompts this session (guards still apply)",
			argumentHint: "<on|off>",
		},
		{
			name: "grant-skill",
			description: "preview/approve a skill's declared commands (--yes to apply)",
			argumentHint: "<name> [--yes]",
		},
		{
			name: "revoke-skill",
			description: "remove a skill's granted commands from the allowlist",
			argumentHint: "<name>",
		},
		{
			name: "model",
			description: "switch to another configured model (no arg = picker)",
			argumentHint: "[<model-id>]",
		},
		{
			name: "provider",
			description: "switch model provider, or add a new one (no arg = list)",
			argumentHint: "[<provider>]",
			getArgumentCompletions: (prefix) => {
				const lower = prefix.toLowerCase();
				return PROVIDERS.filter(
					(pr) => !pr.noAuth && !pr.custom && !pr.subscription && !pr.cliLogin,
				)
					.map((pr) => pr.id)
					.filter((id) => id.startsWith(lower))
					.map((id) => ({ value: id, label: id }));
			},
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
			name: "new",
			description: "start a fresh thread (new session, clean screen, no prior context)",
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
		{
			name: "org",
			description: "show the Pride hierarchy chart (Higher Office / Departments)",
			argumentHint: "[<agent-id>|--departments|--explain <from> <to>]",
		},
	];
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd()));

	// `/provider` switches the model provider and can add an API-key provider
	// inline — the credential write happens on the GATEWAY side (`add-provider`
	// RPC), so it works from connect mode too. Subscription / local / custom
	// providers still need `brigade onboard` on the gateway machine.
	tui.addChild(
		new Text(
			brand.dim("  connect-mode: /new /agent /agents /session /sessions · /model /provider /thinking /reasoning · /abort /steer /compact · /usage /help"),
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
		// Scrub the server-pushed bash command before echoing it back (see
		// `scrubRenderable`). The command string is attacker-influenceable
		// (a model can request a command containing ANSI/OSC bytes) and is
		// rendered verbatim in the confirmation stamped above the editor.
		const cmd = `${subIndent}    ${brand.dim(scrubRenderable(command).trim())}`;
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
			case "allow-session":
				return [
					`${subIndent}  ${brand.amber("⚠")} ${brand.amber("Allow all this session")} ${brand.dim("· running now…")}`,
					cmd,
					`${subIndent}    ${brand.dim("Shell commands run without asking for the rest of this session (safety guards still apply). /allow-all off to stop.")}`,
				].join("\n");
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
				// Match <think>, <thinking>, and <thought> (with any attributes) —
				// local models (e.g. Ollama's reasoning models) emit <thinking>…
				// </thinking> inline as TEXT when models.json marks them
				// reasoning:false, so a <think>-only regex left the raw tags in the
				// transcript. Case-insensitive; tolerant of attributes/whitespace.
				const stripped = b.text.replace(
					/<\s*(?:think(?:ing)?|thought)\b[^>]*>([\s\S]*?)<\/\s*(?:think(?:ing)?|thought)\s*>\s*/gi,
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

	/* ───────────────────── reliable-streaming recovery ───────────────────── */
	// The transcript is the single source of truth. `resume` returns it; we
	// clear the rendered region and rebuild from it, so a (re)connect or a
	// detected seq gap heals with nothing missing, duplicated, or misplaced.
	// Static renderers below share the SAME identity keys as the live path
	// (`asstKey` for assistant blocks, `pendingTools` for tools), so a live
	// `message_update` that arrives after the rebuild updates the rebuilt block
	// in place rather than spawning a copy.

	// `extractUserText`, `joinToolResultText`, `clipOneLine` are imported from
	// `connect-transcript.js` (pure + unit-tested).

	/** Remove the rendered transcript (everything between the header+divider
	 *  chrome and the editor); the editor + trailing chrome stay. Resets the
	 *  streaming maps so the rebuild starts clean.
	 *
	 *  The header chrome is NOT a fixed 0/1 pair: `renderBrandHeader` prepends
	 *  padTop + splash block + padBottom (3 children) and only THEN does connect
	 *  add the status `header` line and the `divider`. Anchor on the divider's
	 *  live index so the splash + status line + divider always survive a clear
	 *  (a hardcoded `slice(2, …)` deleted the status line and divider, leaving
	 *  the splash butting straight into the conversation with no separator). */
	const clearTranscriptRegion = (): void => {
		const children = tui.children;
		const editorIdx = children.indexOf(editor);
		const dividerIdx = children.indexOf(divider);
		// Start clearing just past the divider (the last chrome element). Fall
		// back to index 2 only if the divider somehow isn't in the tree.
		const start = dividerIdx >= 0 ? dividerIdx + 1 : 2;
		if (editorIdx > start) {
			for (const c of children.slice(start, editorIdx)) removeChild(c as AnyChild);
		}
		activeAssistants.clear();
		pendingTools.clear();
		if (activeLoader) {
			removeChild(activeLoader);
			activeLoader = null;
		}
		// Drop any showing approval prompt — `resume`'s `pendingApprovals` is the
		// authoritative pending set and re-renders it (so a resolved-while-away
		// prompt vanishes, and a still-pending one comes back answerable).
		if (activePrompt) {
			try {
				tui.removeChild(activePrompt);
			} catch {
				/* ignore */
			}
			activePrompt = null;
		}
	};

	/** Render ONE persisted transcript message as final (static) blocks, using
	 *  the same identity keys the live path uses. */
	const renderTranscriptMessage = (m: any): void => {
		if (!m || typeof m !== "object") return;
		if (m.role === "user") {
			const text = scrubRenderable(extractUserText(m)).trim();
			if (text) {
				insertBeforeEditor(new Markdown(`${brand.user("you")}  ${text}`, 1, 0, markdownTheme));
			}
			return;
		}
		if (m.role === "assistant") {
			const text = scrubRenderable(extractAssistantText(m));
			if (text) {
				const label = lastSnapshot?.agentName ?? "brigade";
				const block = new Markdown(`${brand.agent(label)}  ${text}`, 1, 0, markdownTheme);
				activeAssistants.set(asstKey(0, m), block);
				insertBeforeEditor(block);
			}
			// Tool calls embedded in the assistant message → pending indicators;
			// the matching toolResult message (below) fills in the ✓/✗ + preview.
			if (Array.isArray(m.content)) {
				for (const b of m.content) {
					if (b?.type === "toolCall" && typeof b.id === "string") {
						const indicator = new Text(
							`  ${brand.tool("⚡")} ${brand.tool(typeof b.name === "string" ? b.name : "tool")}`,
							0,
							0,
						);
						pendingTools.set(b.id, indicator);
						insertBeforeEditor(indicator);
					}
				}
			}
			return;
		}
		if (m.role === "toolResult" && typeof m.toolCallId === "string") {
			const mark = m.isError ? brand.error("✗") : brand.tool("✓");
			const name = typeof m.toolName === "string" ? m.toolName : "tool";
			// Join → scrub terminal escapes → collapse/clip to one line.
			const clipped = clipOneLine(scrubRenderable(joinToolResultText(m.content)));
			const preview = clipped ? ` ${brand.dim(`· ${clipped}`)}` : "";
			const line = `  ${mark} ${brand.tool(name)}${preview}`;
			const indicator = pendingTools.get(m.toolCallId);
			if (indicator) {
				indicator.setText(line);
				pendingTools.delete(m.toolCallId);
			} else {
				insertBeforeEditor(new Text(line, 0, 0));
			}
			return;
		}
	};

	/** Render an inline approval card the operator can answer. Shared by the
	 *  live `approval-request` handler AND `resume` recovery (so a prompt that
	 *  arrived / was missed during a disconnect comes back answerable instead of
	 *  hanging the turn to auto-deny). */
	const renderApprovalPrompt = (req: EventPayload["approval-request"]): void => {
		// Only one prompt at a time (exec-gate is serial per turn).
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
				if (activePrompt) {
					try {
						tui.removeChild(activePrompt);
					} catch {
						/* ignore */
					}
					activePrompt = null;
				}
				tui.setFocus(editor);
				insertBeforeEditor(new Text(decisionConfirmation(req.command, resolution, req.subagentDepth), 0, 0));
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
	};

	/** Render one `system-event` notice (cron announce / channel-health) as a
	 *  visible Brigade-side line. Shared by the live handler + `resume` recovery. */
	const renderSystemEventLine = (event: EventPayload["system-event"]): void => {
		const eventText = scrubRenderable(event.text);
		const isCron = event.source === "cron" || event.jobName !== undefined;
		if (isCron) {
			const name = event.jobName ?? "cron";
			const heading = brand.amber(`🦁 [cron "${name}"]`);
			let suffix = "";
			if (event.delivered === true) suffix = ` ${brand.dim("· delivered")}`;
			else if (event.delivered === false) suffix = ` ${brand.dim("· not delivered (TUI only)")}`;
			insertBeforeEditor(new Text(`${heading} ${eventText}${suffix}`, 0, 0));
		} else {
			insertBeforeEditor(new Text(`${brand.amber("🦁")} ${eventText}`, 0, 0));
		}
		tui.requestRender();
	};

	/** Resume the bound session and rebuild the transcript from the gateway's
	 *  source of truth. Safe (and idempotent) on first connect (loads history),
	 *  reconnect (backfills the gap + clears stale spinners), and `"resync"`
	 *  (fills a mid-stream drop). Best-effort: on failure the current view stays
	 *  and the next live frame refreshes it. */
	// Serialize resumes: a reconnect AND a gap-resync can both fire, and live
	// frames can trigger more while one is in flight. Run at most one at a time
	// and coalesce concurrent requests into a single follow-up rebuild — no
	// overlapping clears/rebuilds against the shared render maps.
	let resumeInFlight = false;
	let resumePending = false;
	// Resume = ONE idempotent operation: "attach to the bound thread and render
	// its current truth." It fires identically on initial connect AND on
	// reconnect/resync — both land the operator in the SAME thread with its
	// history, so the screen never disagrees with what the agent actually
	// remembers (best-in-class default: ChatGPT/Claude.ai/Cursor/Hermes all land
	// you in your thread WITH history). A genuinely clean slate is `/new` (a real
	// empty thread), never a blanked view of a thread that's secretly full.
	// The replay is BOUNDED server-side — the `resume` RPC caps how many
	// transcript messages it ships — so a 10k-message thread stays snappy.
	const doResume = async (): Promise<void> => {
		if (resumeInFlight) {
			resumePending = true;
			return;
		}
		resumeInFlight = true;
		try {
			let snap: Awaited<ReturnType<typeof client.resume>> | undefined;
			try {
				snap = await client.resume(withBinding());
			} catch {
				return;
			}
			if (!snap) return;
			clearTranscriptRegion();
			const messages = Array.isArray(snap.messages) ? snap.messages : [];
			for (const m of messages) renderTranscriptMessage(m);
			// Recover the non-transcript events too ("nothing lost"): recent
			// system-event notices, then any tool-approval prompts STILL pending
			// on this session — re-rendered answerable so a prompt that arrived or
			// was missed doesn't strand the turn.
			for (const ev of snap.recentSystemEvents ?? []) renderSystemEventLine(ev);
			for (const appr of snap.pendingApprovals ?? []) renderApprovalPrompt(appr);
			if (snap.snapshot) {
				lastSnapshot = snap.snapshot;
				if (!snap.snapshot.isAgentRunning) isAgentRunning = false;
			}
			updateHeader();
			tui.requestRender();
		} finally {
			resumeInFlight = false;
			if (resumePending) {
				resumePending = false;
				void doResume();
			}
		}
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
		// `snap.isAgentRunning` is AGENT-wide — it goes true when ANY session
		// of this agent has a turn running (a WhatsApp chat, spawned
		// sub-agents, a cron run). Taking it as-is flipped THIS lane into
		// steer mode while our own session was idle, so typed messages
		// bounced with "nothing to steer" and were lost. Only the CLEARING
		// direction is safe from the snapshot (it reconciles a missed
		// agent_end after a disconnect); the lane's own agent_start /
		// agent_end events own the upward direction.
		if (!snap.isAgentRunning) isAgentRunning = false;
		// Seed the connection-bound agent from the first snapshot the
		// gateway pushes. The operator can override via `/agent <id>` —
		// once set explicitly, snapshot updates no longer reset the binding.
		if (boundAgentId === undefined && typeof snap.agentId === "string" && snap.agentId.length > 0) {
			boundAgentId = snap.agentId;
		}
		// Wave K — seed the connection-bound session key from the first
		// snapshot. Once set explicitly via `/session <key>`, snapshot
		// updates no longer reset it (mirrors boundAgentId semantics).
		//
		// --agent guard (2026-06-11): do NOT inherit a session key from a
		// snapshot whose agent differs from the one we're explicitly bound to.
		// On `brigade connect --agent marketing-lead`, the gateway's first
		// (boot) snapshot is for `main` with sessionKey `agent:main:main`.
		// Seeding that here made `withBinding` send the incoherent pair
		// {agentId: "marketing-lead", sessionKey: "agent:main:main"} — the
		// turn routed to main's session and the off-lane / subscription filter
		// dropped the reply (first message landed on main, "fixed" itself only
		// once a marketing-lead snapshot arrived). Leaving boundSessionKey
		// undefined lets the gateway resolve the bound agent's OWN default
		// session from agentId alone. Once a snapshot for the bound agent
		// arrives, the match passes and the real session key seeds normally.
		if (
			boundSessionKey === undefined &&
			typeof snap.sessionKey === "string" &&
			snap.sessionKey.length > 0 &&
			snapshotSessionSeedable(boundAgentId, snap.agentId)
		) {
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
			// Subscribe to the bound lane, THEN resume to load this thread's
			// (bounded) history from the gateway's source of truth, so the operator
			// lands back where they left off — the same operation reconnect/resync
			// use. Runs once per connection. `/new` is the path to a fresh thread.
			void applySubscription().finally(() => {
				void doResume();
			});
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
		// don't belong to the lane this TUI is bound to. Server-side subscribe
		// should already filter this, but a race between /agent rebind + the
		// next gated-tool frame can still leak a stale one here.
		if (
			isOffLane(
				(req as { agentId?: string }).agentId,
				(req as { sessionId?: string }).sessionId,
				(req as { subagentDepth?: number }).subagentDepth,
			)
		) {
			return;
		}
		renderApprovalPrompt(req);
	});

	// Server-side warnings/info (e.g. "primary failed, trying fallback") — the
	// gateway emits these via the wrapper-chain callbacks. Mirror to the TUI
	// so the user sees the same context they would in `brigade chat`.
	client.on("log", (entry) => {
		// Wave N3 (bug #3) — defensive lane drop. Stamped log entries from
		// off-lane agents get silently dropped here, matching the same
		// filter the server's subscribe applies.
		if (isOffLane(entry.agentId, entry.sessionId, (entry as { subagentDepth?: number }).subagentDepth)) return;
		// Scrub the server-pushed log message before rendering (see
		// `scrubRenderable`) — these can carry forwarded model/tool text.
		const message = scrubRenderable(entry.message);
		const tone =
			entry.level === "error"
				? brand.error(`✗ ${message}`)
				: entry.level === "warn"
					? brand.dim(`⚠ ${message}`)
					: brand.dim(`↻ ${message}`);
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
		if (isOffLane(event.agentId, event.sessionId, (event as { subagentDepth?: number }).subagentDepth)) return;
		renderSystemEventLine(event);
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
		if (isOffLane(payload.agentId, payload.sessionId, subagentDepth)) return;
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
					loaderIndicator(),
				);
				insertBeforeEditor(activeLoader);
				break;
			}
			case "message_update":
			case "message_end": {
				const msg = event.message;
				if (!msg || msg.role !== "assistant") break;
				// Scrub server-pushed assistant text before it reaches the
				// Markdown widget (see `scrubRenderable`). The model can be
				// steered to emit ANSI/OSC control bytes; the widget preserves
				// raw escapes, so strip them here. The brand-coloured label
				// prefix added below is Brigade-internal chalk and stays intact.
				const text = scrubRenderable(extractAssistantText(msg));
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
				// Identity-keyed streaming block (see `asstKey`). Each logical
				// message — top-level or sub-agent — owns ONE growing Markdown
				// block, resolved by `${depth}:${timestamp}`. A continuation after
				// a tool call is a new message (new timestamp) → a fresh block
				// that lands BELOW the tool; a late/duplicate update for an
				// earlier message resolves to its existing block and updates it in
				// place, so nothing is ever misplaced or duplicated.
				const key = asstKey(depth, msg);
				const existing = activeAssistants.get(key);
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
					activeAssistants.set(key, fresh);
					insertBeforeEditor(fresh);
				} else {
					existing.setText(renderedText);
					// message_end carries the FINAL text — paint immediately so
					// the user never has to wait the debounce window for the
					// last chunk. message_update batches through the debouncer
					// so a 200-token reply paints ~12 times instead of ~200,
					// killing the flicker that blocked terminal scroll-back.
					if (event.type === "message_end") {
						flushStreamingRender();
					} else {
						scheduleStreamingRender();
					}
				}
				break;
			}
			case "tool_execution_start": {
				if (activeLoader) {
					removeChild(activeLoader);
					activeLoader = null;
				}
				// NOTE: we no longer delete any assistant block here. With
				// identity keying (`asstKey`), the post-tool continuation is a NEW
				// message with a NEW timestamp, so it naturally opens a fresh block
				// that lands BELOW this tool — while a late update for the
				// pre-tool message still resolves to its own (earlier) block and
				// updates in place. The old `activeAssistants.delete(depth)` hack
				// (forcing a fresh block by position) is exactly what let a
				// reordered/duplicate pre-tool update spawn a misplaced copy; it's
				// gone. We still flush any pending debounced paint so the assistant
				// text above renders in full BEFORE the tool indicator lands.
				flushStreamingRender();
				const indicator = new Text(
					`${subIndent}  ${brand.tool("⚡")} ${brand.tool(event.toolName)}`,
					0,
					0,
				);
				pendingTools.set(event.toolCallId, indicator);
				insertBeforeEditor(indicator);
				break;
			}
			case "tool_execution_update": {
				// LIVE tool output. Pi streams a tool's accumulating result via
				// `onUpdate` (e.g. `bash` fires stdout/stderr as it runs); the
				// gateway forwards each as a `tool_execution_update`. Repaint the
				// ⚡ chip with the running preview so the operator watches the tool
				// work in real time instead of a static spinner. The repaint is
				// coalesced through the streaming debouncer so a chatty command
				// can't thrash the terminal.
				const liveIndicator = pendingTools.get(event.toolCallId);
				if (liveIndicator) {
					const summary = summarizeToolResult(event.partialResult, { preserveNewlines: false });
					const previewText = scrubRenderable(summary.preview);
					const tail = summary.hasContent ? ` ${brand.dim(`· ${previewText}`)}` : "";
					liveIndicator.setText(`${subIndent}  ${brand.tool("⚡")} ${brand.tool(event.toolName)}${tail}`);
					scheduleStreamingRender();
				}
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
					// Scrub the server-pushed tool-result preview before it
					// reaches a Text widget (see `scrubRenderable`). Tool output
					// is the most direct attacker-influenceable render path —
					// a `bash`/`read` result can carry ANSI/OSC control bytes.
					// Done once here so both render branches below stay clean.
					const previewText = scrubRenderable(summary.preview);
					if (event.isError && summary.multiline) {
						indicator.setText(`${subIndent}  ${mark} ${brand.tool(event.toolName)}`);
						const errIndent = `${subIndent}      `;
						const indentedBody = previewText
							.split("\n")
							.map((line) => `${errIndent}${brand.dim(line)}`)
							.join("\n");
						insertBeforeEditor(new Text(indentedBody, 0, 0));
					} else {
						const preview = summary.hasContent ? ` ${brand.dim(`· ${previewText}`)}` : "";
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
				// Turn-end is the definitive flush point — even if every other
				// path missed flushing, this guarantees the last paint of the
				// turn lands before the editor re-enables for the operator.
				flushStreamingRender();
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
	client.on("reconnected", () => {
		// BrigadeClient opened a BRAND-NEW socket on reconnect, so the gateway
		// assigned a fresh conn id whose per-connection subscription Sets are
		// EMPTY. Reset the sub mirror (the fresh connection has no prior
		// server-side subscription, so leaving these set would fire a spurious
		// `unsubscribe`), re-subscribe to the bound lane, THEN resume — which
		// rebuilds the transcript from the gateway's source of truth. The rebuild
		// backfills every `pi` frame missed while disconnected AND clears any
		// stale tool spinners (each tool re-renders with its actual ✓/✗ outcome),
		// so there's no separate orphan-reconcile step — the
		// missing-after-tool / needs-a-refresh class of bug is gone.
		lastSubscribedAgentId = undefined;
		lastSubscribedSessionKey = undefined;
		void (async () => {
			await applySubscription();
			await doResume();
			// Notice lands AFTER the rebuild — else clearTranscriptRegion wipes it.
			insertBeforeEditor(new Text(`  ${brand.dim("↻ reconnected to gateway")}`, 0, 0));
		})();
	});

	// Mid-stream gap recovery. BrigadeClient emits "resync" when it detects a
	// seq gap on the ordered `pi` stream — a frame dropped under backpressure or
	// reordered, or the gateway restarted and reset its counters. Resume to
	// rebuild from the transcript so the live view self-heals with no missing or
	// misplaced messages and WITHOUT waiting for a reconnect or a manual refresh.
	client.on("resync", () => {
		void doResume();
	});

	// Switch the live session onto a CONFIGURED provider by reusing the same
	// `set-model` path `/model` uses. Picks a model on that provider, preferring
	// the one whose id matches the current model so a same-id model on the new
	// provider continues seamlessly; otherwise the provider's first model. Used
	// by `/provider <configured>` and right after a successful inline add.
	const applyProviderSwitch = async (providerName: string): Promise<void> => {
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
		const providerModels = models.filter((m) => m.provider === providerName);
		const curModelId = lastSnapshot?.modelId;
		const target =
			providerModels.find((m) => m.id === curModelId) ?? providerModels[0];
		if (!target) {
			insertBeforeEditor(
				new Text(
					`  ${brand.error("✗")} ${brand.error(`no models available for provider "${providerName}" yet.`)}`,
					0,
					0,
				),
			);
			return;
		}
		try {
			await client.request(
				"set-model",
				withBinding({ provider: providerName, modelId: target.id }),
			);
			insertBeforeEditor(
				new Text(
					`  ${brand.amber("✓")} ${brand.dim("switched to")} ${brand.white(`${providerName} · ${target.id}`)}`,
					0,
					0,
				),
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0));
		}
	};

	// Slash command + send wiring.
	editor.onSubmit = async (value: string) => {
		// SECURITY — scrub terminal escape sequences, leaked bracketed-paste markers,
		// and lone surrogates from input BEFORE it reaches command dispatch, the model
		// payload, or the echo. A hostile paste (or text the agent was told to copy
		// from a malicious page) can otherwise corrupt the terminal or smuggle control
		// bytes into the transcript. The single submit chokepoint covers every path.
		const trimmed = sanitizeTerminalInput(value).trim();
		if (!trimmed) return;

		// API-key capture for `/provider <new-provider>`. When armed, this line
		// IS the key — consume it here before any command dispatch or echo so it
		// never reaches the model payload or the transcript. The editor clears
		// immediately and we don't insert the raw key into scrollback (and the
		// editor never adds submits to up-arrow history), so it isn't recoverable.
		if (pendingProviderEntry) {
			const entry = pendingProviderEntry;
			pendingProviderEntry = null;
			editor.setText("");
			if (trimmed === "/cancel" || trimmed === "/abort") {
				insertBeforeEditor(
					new Text(`  ${brand.dim(`cancelled adding ${entry.providerName}.`)}`, 0, 0),
				);
				return;
			}
			insertBeforeEditor(
				new Text(`  ${brand.dim(`validating ${entry.providerName} key…`)}`, 0, 0),
			);
			try {
				const res = await client.request("add-provider", {
					providerId: entry.providerId,
					apiKey: trimmed,
				});
				if (res.warning) {
					insertBeforeEditor(
						new Text(`  ${brand.amber("⚠")} ${brand.dim(res.warning)}`, 0, 0),
					);
				}
				insertBeforeEditor(
					new Text(
						`  ${brand.amber("✓")} ${brand.dim("added provider")} ${brand.white(entry.providerId)}`,
						0,
						0,
					),
				);
				// Now switch the live session onto the freshly-added provider.
				await applyProviderSwitch(entry.providerId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.error(`add provider failed: ${msg}`)}`, 0, 0),
				);
			}
			return;
		}

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
						`- ${chalk.bold("/provider [<name>]")} — switch model provider, or add a new one with an API key (no arg = list)\n` +
						`- ${chalk.bold("/thinking <level>")} — set reasoning effort (off|minimal|low|medium|high|xhigh)\n` +
						`- ${chalk.bold("/compact")} — summarize older turns to free up context\n` +
						`- ${chalk.bold("/allow-all <on|off>")} — skip shell-approval prompts for this session (safety guards still apply)\n` +
						`- ${chalk.bold("/grant-skill <name> [--yes]")} — preview/approve a skill's declared commands so the agent runs them without asking\n` +
						`- ${chalk.bold("/revoke-skill <name>")} — remove a skill's granted commands\n` +
						`- ${chalk.bold("/abort")} — stop the in-flight turn\n` +
						`- ${chalk.bold("/usage")} — show token + cost totals for this session\n` +
						`- ${chalk.bold("/reasoning <on|off>")} — show/hide the model's thinking blocks before replies (default: off)\n` +
						`- ${chalk.bold("/new")} — start a fresh thread (new session, clean screen, no prior context)\n` +
						`- ${chalk.bold("/agent [<id>]")} — show/bind the connection's active agent\n` +
						`- ${chalk.bold("/session [<key>]")} — show/bind the connection's active session\n` +
						`- ${chalk.bold("/agents")} — list every agent the gateway knows about\n` +
						`- ${chalk.bold("/sessions [--all]")} — list live sessions (bound agent or all)\n` +
						`- ${chalk.bold("/mute <id|key>")} — unsubscribe from an agent id or session key\n` +
						`- ${chalk.bold("/memory")} — list recent memories\n` +
						`- ${chalk.bold("/memory search <q>")} — search memories by keyword\n` +
						`- ${chalk.bold("/memory inspect <id>")} — show a single memory by id prefix\n` +
						`- ${chalk.bold("/memory stats")} — show memory counts by segment / origin\n` +
						`- ${chalk.bold("/org")} — show the Pride hierarchy chart (Higher Office / Departments)\n` +
						`- ${chalk.bold("/org <agent-id>")} — show a sub-tree of the chart\n` +
						`- ${chalk.bold("/org --departments")} — chart without the Higher Office block\n` +
						`- ${chalk.bold("/org --explain <from> <to>")} — why this edge exists (or does not)\n` +
						`- ${chalk.bold("Ctrl+C")} — abort the current turn (same as /abort)\n` +
						`- ${chalk.bold("Ctrl+D")} — quit\n\n` +
						brand.dim("Subscription / local / custom providers still need `brigade onboard` on the gateway machine."),
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
		// /new — start a genuinely fresh thread. Binds the connection to a NEW
		// session key under the current agent (the gateway opens a fresh
		// transcript on the first prompt, so the agent starts with NO prior
		// context), clears the screen, and re-subscribes. This is the ONE true
		// clean-slate affordance: a normal launch lands you back in your existing
		// thread WITH its (bounded) history — the best-in-class default — and
		// `/new` is how you deliberately start over. Mirrors OpenClaw's `/new` and
		// Claude.ai/ChatGPT "new chat"; `/sessions` lists threads, `/session <key>`
		// jumps back to one.
		if (trimmed === "/new") {
			editor.setText("");
			const agentForNew = boundAgentId ?? lastSnapshot?.agentId ?? "main";
			const freshKey = `agent:${agentForNew}:t-${randomUUID().slice(0, 8)}`;
			boundSessionKey = freshKey;
			clearTranscriptRegion();
			insertBeforeEditor(
				new Text(
					`  ${brand.amber("✓")} ${brand.dim("new thread")} ${brand.amber(freshKey)}`,
					0,
					0,
				),
			);
			updateHeader();
			void applySubscription();
			return;
		}

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
				// The sessions.list RPC returns `{ sessions, count }` — extract the
				// array (a stale type map said it was a bare array, which crashed
				// `.map`). Defensive: accept either shape.
				const res: unknown = await client.request("sessions.list", params);
				sessions = Array.isArray(res)
					? (res as SessionSummary[])
					: ((res as { sessions?: SessionSummary[] }).sessions ?? []);
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
			let known: AgentSummary[];
			try {
				known = await client.request("agents.list");
			} catch (err) {
				insertBeforeEditor(
					new Text(
						`  ${brand.error("✗")} ${brand.error(
							`agents.list failed: ${err instanceof Error ? err.message : String(err)}`,
						)}`,
						0,
						0,
					),
				);
				return;
			}
			if (!known.some((a) => a.id === arg)) {
				const available = known.map((a) => a.id).join(", ") || "(none)";
				insertBeforeEditor(
					new Text(
						`  ${brand.error("✗")} ${brand.error(`unknown agent "${arg}"`)}\n  ${brand.dim(
							`available: ${available}`,
						)}\n  ${brand.dim("usage: /agent <id> — try /agents to see the full list")}`,
						0,
						0,
					),
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

		// /org — Pride hierarchy chart. Calls the gateway's `org.snapshot`
		// RPC and renders the result inline. Four shapes:
		//   /org                       → full chart (pre-rendered ANSI+emoji)
		//   /org <agent-id>            → re-render the subtree rooted at <id>
		//   /org --departments        → re-render without Higher Office
		//   /org --explain <from> <to> → derived-graph edge explain
		// When cfg.org is absent the gateway returns ok=false with the
		// flat-crew redirect note; we print it verbatim (no chart frame).
		if (trimmed === "/org" || trimmed.startsWith("/org ")) {
			editor.setText("");
			const rawArgs = trimmed === "/org" ? "" : trimmed.slice("/org ".length);
			const parsed = parseOrgSlash(rawArgs);
			if (parsed.kind === "error") {
				insertBeforeEditor(new Text(`  ${brand.dim(parsed.message)}`, 0, 0));
				return;
			}
			let snap: import("../../protocol/methods.js").OrgSnapshotResult;
			try {
				snap = await client.request("org.snapshot");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0),
				);
				return;
			}
			if (snap.ok === false) {
				insertBeforeEditor(new Markdown(snap.redirect, 1, 0, markdownTheme));
				return;
			}
			const graph = snap.graph as OrgGraph;
			// Read department-head pins from the snapshot graph caller side
			// is fine for re-renders — the gateway already applied them
			// when computing the pre-rendered `charts.tui` for the happy
			// path. For client-side re-render branches (subtree /
			// departments) we just pass `undefined` since the pin map
			// isn't carried in the snapshot response today. The most-
			// senior fallback path inside `flattenToThreeTiers` still
			// produces a sensible chart.
			const pins: Record<string, string> | undefined = undefined;
			if (parsed.kind === "show") {
				// Pre-shape: ensure the trailing footer rule sits on its
				// own line so the rendered Markdown widget doesn't collapse
				// it into the previous block.
				let body = snap.charts.tui;
				if (!body.endsWith("\n")) body += "\n";
				if (!body.includes(BRIGADE_FOOTER_RULE + "\n")) {
					body = body.replace(BRIGADE_FOOTER_RULE, BRIGADE_FOOTER_RULE + "\n");
				}
				insertBeforeEditor(new Text(body, 0, 0));
				return;
			}
			if (parsed.kind === "explain") {
				const outcome = computeExplain(graph, parsed.from, parsed.to);
				insertBeforeEditor(new Text(formatExplain(outcome), 0, 0));
				return;
			}
			if (parsed.kind === "subtree") {
				const filtered = filterGraphToSubtree(graph, parsed.agentId);
				if (!filtered) {
					insertBeforeEditor(
						new Text(
							`  ${brand.error(`✗ Unknown agent "${parsed.agentId}". Run /org to see the full chart.`)}`,
							0,
							0,
						),
					);
					return;
				}
				const body = renderPrideChartWithPins(filtered, pins, {
					emoji: true,
					ansi: true,
				});
				let withFooter = body;
				if (!withFooter.endsWith("\n")) withFooter += "\n";
				if (!withFooter.includes(BRIGADE_FOOTER_RULE + "\n")) {
					withFooter = withFooter.replace(
						BRIGADE_FOOTER_RULE,
						BRIGADE_FOOTER_RULE + "\n",
					);
				}
				insertBeforeEditor(new Text(withFooter, 0, 0));
				return;
			}
			// parsed.kind === "departments"
			const body = renderDepartmentsOnly(graph, pins, {
				emoji: true,
				ansi: true,
			});
			let withFooter = body;
			if (!withFooter.endsWith("\n")) withFooter += "\n";
			if (!withFooter.includes(BRIGADE_FOOTER_RULE + "\n")) {
				withFooter = withFooter.replace(
					BRIGADE_FOOTER_RULE,
					BRIGADE_FOOTER_RULE + "\n",
				);
			}
			insertBeforeEditor(new Text(withFooter, 0, 0));
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
		if (trimmed === "/memory" || trimmed.startsWith("/memory ")) {
			editor.setText("");
			const rest = trimmed.slice("/memory".length).trim();
			const sp = rest.indexOf(" ");
			const verb = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
			const arg = sp === -1 ? "" : rest.slice(sp + 1).trim();
			let action: "list" | "search" | "inspect" | "stats" = "list";
			let query: string | undefined;
			let memoryId: string | undefined;
			if (verb === "search") {
				action = "search";
				query = arg;
			} else if (verb === "inspect") {
				action = "inspect";
				memoryId = arg;
			} else if (verb === "stats") {
				action = "stats";
			} else if (verb === "list" || verb === "") {
				action = "list";
			} else {
				// bare "/memory <terms>" → treat the whole thing as a search
				action = "search";
				query = rest;
			}
			try {
				const res = (await client.request("memory-query", {
					...withBinding(),
					action,
					...(query ? { query } : {}),
					...(memoryId ? { memoryId } : {}),
				})) as MemoryQueryResult;
				const lines: string[] = [];
				if (res.action === "stats" && res.stats) {
					const s = res.stats;
					const segs = Object.entries(s.bySegment)
						.sort((a, b) => b[1] - a[1])
						.map(([k, v]) => `${k} ${v}`)
						.join(", ");
					lines.push(`  memory — ${s.active} active (${s.total} total, ${s.archived} archived)`);
					lines.push(`  by segment: ${segs || "—"}`);
					lines.push(
						`  by origin:  owner ${s.owner}, channel ${s.channel}   ·   added last 7d: ${s.addedLast7d}`,
					);
				} else if (res.facts.length === 0) {
					lines.push("  (no matching memories)");
				} else {
					res.facts.forEach((f, i) => {
						const sc = f.score !== undefined ? ` ·${f.score}` : "";
						const lifecycleTag = f.lifecycle && f.lifecycle !== "active"
							? ` ${brand.dim(`[${f.lifecycle}]`)}`
							: "";
						lines.push(`  ${i + 1}. ${f.content}${lifecycleTag}`);
						lines.push(`     ${f.segment} · ${f.origin} · ${f.memoryId}${sc}`);
					});
				}
				insertBeforeEditor(new Text(`${lines.join("\n")}\n`, 0, 0));
			} catch (err) {
				insertBeforeEditor(
					new Text(
						`  ${brand.error("✗")} ${brand.error(err instanceof Error ? err.message : String(err))}`,
						0,
						0,
					),
				);
			}
			return;
		}
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
				if (msg.includes("nothing to steer")) {
					// Stale busy flag — our lane has no live turn (it ended a beat
					// ago, or the busy signal came from another session before the
					// one-way snapshot rule existed). The operator's message must
					// never be lost: clear the flag and send it as a normal prompt.
					isAgentRunning = false;
					insertBeforeEditor(
						new Markdown(`${brand.user("you")}  ${trimmed}`, 1, 0, markdownTheme),
					);
					try {
						lastUserPrompt = trimmed; // remember it as the replay message for a later `/switch` (Carrow) handoff
			await client.request("prompt", withBinding({ text: trimmed }), { timeoutMs: 0 });
					} catch (err2) {
						const msg2 = err2 instanceof Error ? err2.message : String(err2);
						insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg2)}`, 0, 0));
					}
					return;
				}
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

		// /allow-all <on|off> — arm/disarm session-scoped exec approval bypass.
		// Skips the shell-approval PROMPT for this session only; it can't bypass
		// the config/path-write guards or hard-deny patterns, and clears on
		// gateway restart.
		if (trimmed === "/allow-all" || trimmed.startsWith("/allow-all ")) {
			editor.setText("");
			const arg =
				trimmed === "/allow-all" ? "" : trimmed.slice("/allow-all ".length).trim().toLowerCase();
			if (arg !== "on" && arg !== "off") {
				insertBeforeEditor(
					new Markdown(
						`${brand.dim("usage: /allow-all on|off")}\n` +
							`Skips the shell-approval prompt for THIS session. It can't bypass the safety ` +
							`guards (writes to brigade.json / encryption.key / auth, hard-deny patterns), ` +
							`doesn't affect sub-agents, and clears on gateway restart.`,
						1,
						0,
						markdownTheme,
					),
				);
				return;
			}
			const enabled = arg === "on";
			try {
				const res = (await client.request("exec-allow-all", { ...withBinding(), enabled })) as
					| { sessionKey?: string; enabled?: boolean }
					| undefined;
				insertBeforeEditor(
					new Text(
						enabled
							? `  ${brand.amber("⚠")} ${brand.dim(`allow-all ON for ${res?.sessionKey ?? "this session"} — shell commands run without asking (safety guards still apply). /allow-all off to disarm.`)}`
							: `  ${brand.amber("✓")} ${brand.dim("allow-all OFF — shell commands prompt for approval again.")}`,
						0,
						0,
					),
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.error(`allow-all failed: ${msg}`)}`, 0, 0),
				);
			}
			return;
		}

		// /grant-skill <name> [--yes] — preview (default) or apply a skill's
		// command grant. Preview shows the commands the skill declares; --yes
		// pre-approves them so the agent runs its own skill without prompting.
		// The grant is a SNAPSHOT — editing the skill later can't widen it.
		if (trimmed === "/grant-skill" || trimmed.startsWith("/grant-skill ")) {
			editor.setText("");
			const rest = trimmed === "/grant-skill" ? "" : trimmed.slice("/grant-skill ".length).trim();
			const apply = /(^|\s)(--yes|-y)(\s|$)/.test(rest);
			const name = rest.replace(/(^|\s)(--yes|-y)(\s|$)/g, " ").trim();
			if (!name) {
				insertBeforeEditor(
					new Markdown(
						`${brand.dim("usage: /grant-skill <name> [--yes]")}\n` +
							`Preview the shell commands a skill declares; add ${chalk.bold("--yes")} to pre-approve ` +
							`them for this agent so it stops asking. A grant is a snapshot — editing the skill ` +
							`later won't widen it. Revoke with /revoke-skill.`,
						1,
						0,
						markdownTheme,
					),
				);
				return;
			}
			try {
				const res = (await client.request("exec-grant-skill", {
					...withBinding(),
					skillName: name,
					apply,
				})) as {
					found?: boolean;
					skill?: string;
					emptyManifest?: boolean;
					applied?: boolean;
					manifest?: { commands: string[]; patterns: string[] };
					granted?: { commands: string[]; patterns: string[] };
					refused?: string[];
				};
				if (!res?.found) {
					insertBeforeEditor(
						new Text(
							`  ${brand.error("✗")} ${brand.error(`No skill named "${name}" is visible to this agent.`)}`,
							0,
							0,
						),
					);
					return;
				}
				if (res.emptyManifest) {
					insertBeforeEditor(
						new Markdown(
							`${brand.dim(`Skill "${res.skill}" declares no commands to grant.`)}\n` +
								`Add a ${chalk.bold("commands:")} / ${chalk.bold("command-patterns:")} block to its SKILL.md ` +
								`frontmatter, then re-run.`,
							1,
							0,
							markdownTheme,
						),
					);
					return;
				}
				const manifest = res.manifest ?? { commands: [], patterns: [] };
				const lines = [
					...manifest.commands.map((c) => `  • ${c}`),
					...manifest.patterns.map((p) => `  ~ /${p}/`),
				].join("\n");
				if (res.applied) {
					const granted = res.granted ?? { commands: [], patterns: [] };
					const n = granted.commands.length + granted.patterns.length;
					const refused =
						res.refused && res.refused.length > 0
							? `\n${brand.amber("refused (hard-deny):")} ${res.refused.join(", ")}`
							: "";
					insertBeforeEditor(
						new Markdown(
							`${brand.amber("✓")} Granted ${n} command(s) from ${chalk.bold(res.skill ?? name)} — ` +
								`the agent can now run them without prompting.\n${lines}${refused}\n` +
								`${brand.dim(`Revoke with /revoke-skill ${res.skill ?? name}`)}`,
							1,
							0,
							markdownTheme,
						),
					);
				} else {
					insertBeforeEditor(
						new Markdown(
							`${chalk.bold(res.skill ?? name)} declares these commands:\n${lines}\n\n` +
								`${brand.dim(`Approve them with: /grant-skill ${res.skill ?? name} --yes`)}`,
							1,
							0,
							markdownTheme,
						),
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.error(`grant-skill failed: ${msg}`)}`, 0, 0),
				);
			}
			return;
		}

		// /revoke-skill <name> — remove a skill's granted commands from the allowlist.
		if (trimmed === "/revoke-skill" || trimmed.startsWith("/revoke-skill ")) {
			editor.setText("");
			const name = trimmed === "/revoke-skill" ? "" : trimmed.slice("/revoke-skill ".length).trim();
			if (!name) {
				insertBeforeEditor(new Markdown(`${brand.dim("usage: /revoke-skill <name>")}`, 1, 0, markdownTheme));
				return;
			}
			try {
				const res = (await client.request("exec-grant-skill", {
					...withBinding(),
					skillName: name,
					revoke: true,
				})) as { found?: boolean; skill?: string; removed?: number };
				if (!res?.found) {
					insertBeforeEditor(
						new Text(
							`  ${brand.error("✗")} ${brand.error(`No skill named "${name}" is visible to this agent.`)}`,
							0,
							0,
						),
					);
					return;
				}
				insertBeforeEditor(
					new Text(
						`  ${brand.amber("✓")} ${brand.dim(`Revoked ${res.removed ?? 0} approval(s) from skill "${res.skill ?? name}".`)}`,
						0,
						0,
					),
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.error(`revoke-skill failed: ${msg}`)}`, 0, 0),
				);
			}
			return;
		}

		// /provider [<name>] — switch the active model PROVIDER mid-chat, or add a
		// brand-new one inline. No arg lists configured providers (switchable) plus
		// addable catalog providers. `/provider <configured>` switches to it (keeps
		// the current model id if that provider has it). `/provider <new>` for an
		// API-key catalog provider arms key capture: the next line you type is sent
		// to the gateway's `add-provider`, which validates + persists it server-side,
		// then we switch onto it. Subscription / local / custom providers still need
		// the full `brigade onboard` wizard.
		if (trimmed === "/provider" || trimmed.startsWith("/provider ")) {
			editor.setText("");
			const arg = trimmed === "/provider" ? "" : trimmed.slice("/provider ".length).trim();
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
			const configured = new Set(models.map((m) => m.provider));
			const current = lastSnapshot?.provider;
			// An addable catalog entry = plain API-key provider (not local/no-auth,
			// custom BYO-endpoint, OAuth subscription, or CLI-login) that isn't
			// already configured. Those excluded kinds need the full wizard.
			const isInlineAddable = (pr: (typeof PROVIDERS)[number]): boolean =>
				!pr.noAuth && !pr.custom && !pr.subscription && !pr.cliLogin;

			if (!arg) {
				const configuredList =
					[...configured]
						.sort()
						.map(
							(pName) =>
								`  ${pName === current ? brand.amber("●") : brand.dim("○")} ${brand.white(pName)}${pName === current ? brand.dim(" (current)") : ""}`,
						)
						.join("\n") || `  ${brand.dim("(none)")}`;
				const addable = PROVIDERS.filter(
					(pr) => isInlineAddable(pr) && !configured.has(pr.providerId ?? pr.id),
				)
					.map((pr) => `  ${brand.dim(pr.id)} ${brand.dim("·")} ${brand.dim(pr.name)}`)
					.join("\n");
				insertBeforeEditor(
					new Markdown(
						`${brand.dim("configured providers — switch with /provider <name>:")}\n${configuredList}\n\n` +
							`${brand.dim("add a new one — /provider <name>, then paste an API key:")}\n${addable}`,
						1,
						0,
						markdownTheme,
					),
				);
				return;
			}

			const name = arg.toLowerCase();
			if (configured.has(name)) {
				await applyProviderSwitch(name);
				return;
			}
			// Not configured — can we add it inline?
			const cat = findProvider(name);
			if (cat && isInlineAddable(cat)) {
				pendingProviderEntry = {
					providerId: cat.providerId ?? cat.id,
					providerName: cat.name,
				};
				insertBeforeEditor(
					new Markdown(
						`${brand.amber(`Add ${cat.name}`)} — paste your API key and press Enter ${brand.dim("(or /cancel)")}.\n` +
							`${brand.dim(`get a key: ${cat.keyUrl}`)}\n` +
							`${brand.dim("the key goes to your gateway and is saved there; it won't appear in this transcript.")}`,
						1,
						0,
						markdownTheme,
					),
				);
				return;
			}
			if (cat) {
				// Known catalog entry, but a kind the inline flow can't handle.
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(`${cat.name} needs the full setup wizard — run `)}${brand.white("brigade onboard")}${brand.dim(" on the gateway machine.")}`,
						0,
						0,
					),
				);
				return;
			}
			insertBeforeEditor(
				new Text(
					`  ${brand.error(`✗ unknown provider "${arg}".`)} ${brand.dim("Run /provider with no argument to see the list.")}`,
					0,
					0,
				),
			);
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
				// Scope the list to the CURRENT provider and show ALL of its models,
				// uncapped. `/model` is still a GLOBAL switcher — `/model <id>` switches
				// to any model on any provider — but the LIST stays a clean, complete
				// picker of what you're actually on, instead of a flat dump dominated by
				// a 300+-model cloud catalog. Use `/provider` to change providers.
				const current = lastSnapshot?.provider;
				const currentModels = current ? models.filter((m) => m.provider === current) : models;
				if (currentModels.length === 0) {
					insertBeforeEditor(
						new Text(
							`  ${brand.dim(`no models configured${current ? ` for ${current}` : ""} — type /model <id>, or /provider to switch.`)}`,
							0,
							0,
						),
					);
					return;
				}
				const head = current
					? `${brand.amber(current)} ${brand.dim("(current)")}`
					: brand.dim("models");
				const body = currentModels.map((m) => `    ${brand.white(m.id)}`).join("\n");
				insertBeforeEditor(
					new Markdown(
						`${brand.dim("models on your current provider:")}\n\n  ${head}\n${body}\n\n${brand.dim("usage: /model <id>  ·  switch provider with /provider")}`,
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

		// /switch <id> — Carrow cross-model handoff (vs /model = next turn): aborts an
		// in-flight gateway turn, swaps the model, and REPLAYS your last message on the
		// new one so the conversation continues across models. Idle ⇒ just sets the model.
		if (trimmed === "/switch" || trimmed.startsWith("/switch ")) {
			editor.setText("");
			const arg = trimmed === "/switch" ? "" : trimmed.slice("/switch ".length).trim();
			if (!arg) {
				insertBeforeEditor(
					new Markdown(`${brand.dim("usage: /switch <id> — Carrow mid-turn handoff (vs /model = next turn)")}`, 1, 0, markdownTheme),
				);
				return;
			}
			let switchModels: ModelSummary[];
			try {
				switchModels = await client.request("list-models");
			} catch (err) {
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(err instanceof Error ? err.message : String(err))}`, 0, 0));
				return;
			}
			const switchMatches = switchModels.filter((m) => m.id === arg);
			const switchTarget = switchMatches.find((m) => m.provider === lastSnapshot?.provider) ?? switchMatches[0];
			if (!switchTarget) {
				insertBeforeEditor(new Text(`  ${brand.error(`✗ no model with id "${arg}" on the gateway.`)}`, 0, 0));
				return;
			}
			try {
				await client.request(
					"switch-model-mid-turn",
					withBinding({ provider: switchTarget.provider, modelId: switchTarget.id, replayMessage: lastUserPrompt }),
				);
				insertBeforeEditor(
					new Text(`  ${brand.amber("✓")} ${brand.dim("Carrow handoff →")} ${brand.white(`${switchTarget.provider} · ${switchTarget.id}`)}`, 0, 0),
				);
			} catch (err) {
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(err instanceof Error ? err.message : String(err))}`, 0, 0));
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
			lastUserPrompt = trimmed; // remember it as the replay message for a later `/switch` (Carrow) handoff
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
