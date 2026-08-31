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

import { COPILOT_AUTO_MODEL_ID } from "../../agents/github-copilot-transport.js";
import { describeReasoningVisibility } from "../../agents/reasoning/visibility.js";
import type { ProviderLimitWindow } from "../../agents/usage/limits.js";
import { PI_TOOL_CALL, PI_TOOL_RESULT } from "../../agents/pi-dialect.js";
import process from "node:process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

import { resolveStateDir } from "../../config/paths.js";
import { exportFileName, renderTranscriptMarkdown } from "../../ui/transcript-export.js";
import { searchTranscript } from "../../ui/transcript-search.js";
import { describeRedactions, redactForExport } from "../../ui/transcript-redact.js";

import { sanitizeSessionName } from "../../sessions/session-store.js";
import * as nodePath from "node:path";

import {
	CancellableLoader,
	CombinedAutocompleteProvider,
	isKittyProtocolActive,
	ProcessTerminal,
	type SlashCommand,
	Text,
	TUI,
} from "@earendil-works/pi-tui";

import { BrigadeEditor } from "../../ui/editor.js";
import {
	attachmentIcon,
	extractAttachmentPaths,
	formatBytes as formatAttachmentBytes,
	MAX_STAGED_ATTACHMENTS,
	readClipboardAttachments,
	stageAttachment,
	stopClipboard,
	toPromptAttachments,
	warmClipboard,
	type StagedAttachment,
} from "../../ui/attachments.js";
import { PROVIDERS, findProvider } from "../../providers/catalog.js";
import { sanitizeTerminalInput } from "../../security/terminal-input-sanitizer.js";
import chalk from "chalk";

// Brigade's `Markdown` is a thin Pi-TUI subclass that normalizes `_text_`
// italic spans to `*text*` so the renderer applies italic styling instead
// of leaking literal underscores. Same shape as Pi-TUI's `Markdown` — drop-in.
import { Markdown } from "../../ui/markdown.js";
import { loaderIndicator, probeTerminalAnimationSupport } from "../../ui/animations.js";
import { formatReasoningLine, formatTokens } from "../../agents/reasoning/format.js";
import { formatCostSegment, formatUsd} from "../../agents/usage/format.js";
import { describeRetry } from "../../protocol/errors.js";
import type { SessionListRow } from "../../protocol/methods.js";
import { mutateConfigAtomic, readConfigOrInit } from "../../config/io.js";
import { renderBrandHeader } from "../../ui/brand.js";
import { formatCrewLabel, formatSessionLabel } from "../../ui/format-session.js";
import { markTuiActive, restoreTerminal } from "../../ui/terminal-cleanup.js";
import { brand, editorTheme, markdownTheme } from "../../ui/theme.js";
import { summarizeToolResult, formatToolArgs, looksLikeUnifiedDiff, classifyDiffLine, summarizeDiffStats, parseTodoArgs, todoMarker, summarizeTodos, isShellLikeTool, tailLines, describeOutputSize} from "../../ui/tool-result.js";
import { notifyTurnComplete } from "../../ui/notify.js";
import { buildOsc52, lastCodeBlock } from "../../ui/osc52.js";
import { BrigadeClient } from "../../tui/client.js";
import { DEFAULT_AGENT_ID } from "../../config/paths.js";
import { loadConfig } from "../../core/config.js";
import { getBuildInfo } from "../../version.js";
import { resolveClientToken } from "../../core/gateway-auth.js";
import { asstKey, clipOneLine, extractUserText } from "./connect-transcript.js";
import { UPDATE_PRESERVES_MESSAGE } from "../../core/update-check.js";
import { runUpdateCommand } from "./update.js";
import { ApprovalPrompt, type ApprovalResolution } from "../../tui/approval-prompt.js";
import type {
	AgentSummary,
	EventPayload,
	ModelSummary,
	PromptAttachment,
	SessionDeleteResult,
	SessionRenameResult,
	SessionRewindResult,
	SessionStateSnapshot,
	SessionSummary,
	WireMessage,
} from "../../protocol.js";
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
	/**
	 * Open straight into an existing THREAD — `brigade tui --session t-0bf7c8e1`,
	 * equivalent to launching and immediately running `/session <key>`.
	 *
	 * Accepts the short label the header shows (`t-0bf7c8e1`) or the canonical key
	 * (`agent:main:t-0bf7c8e1`); the short form is expanded against the bound agent.
	 * Validated against `sessions.list` BEFORE the UI engages: an unknown key would
	 * otherwise create a brand-new EMPTY thread of that name, and the operator's next
	 * message — "please continue" — would land in a conversation that has never seen a
	 * word, while their real thread sat untouched on disk.
	 *
	 * Binding is what gives the AGENT its context: every prompt carries this session
	 * key, the gateway resolves that session, and the turn runs against its history.
	 */
	sessionKey?: string;
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
				// `.finally`, not `.then`: this listener is a `once` and is already
				// consumed here, so a rejected close() would leave the TUI with Ctrl+C
				// permanently dead and no way out but another terminal. Exit either way.
				void chatHandle.close().finally(() => {
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

	// Startup `--session <key>` binding. Same discipline as `--agent`, for a sharper
	// reason: an unknown AGENT falls back to `main` — wrong, but a real conversation.
	// An unknown SESSION KEY creates a brand-new EMPTY thread under that name, so
	// "please continue" lands in a conversation that has never seen a word while the
	// real thread sits on disk untouched. Resolve it, verify it, or stop.
	let initialSessionKey: string | undefined;
	if (opts.sessionKey) {
		const agentForKey = initialAgentId ?? DEFAULT_AGENT_ID;
		const target = opts.sessionKey.startsWith("agent:")
			? opts.sessionKey
			: `agent:${agentForKey}:${opts.sessionKey}`;
		try {
			const res: unknown = await client.request(
				"sessions.list",
				initialAgentId !== undefined ? { agentId: initialAgentId } : {},
			);
			const list = Array.isArray(res)
				? (res as SessionSummary[])
				: ((res as { sessions?: SessionSummary[] }).sessions ?? []);
			if (!list.some((s) => s.sessionKey === target)) {
				tui.stop();
				restoreTerminal();
				console.error(chalk.red(`✗ No thread with key "${target}".`));
				console.error(chalk.dim("  Opening an unknown key would start an EMPTY thread of that name."));
				const available = list.map((s) => s.sessionKey).slice(0, 12);
				console.error(chalk.dim(`  Your threads:\n    ${available.join("\n    ") || "(none)"}`));
				console.error(chalk.dim("  (`brigade sessions list` shows them all)"));
				process.exit(1);
			}
			initialSessionKey = target;
		} catch {
			// Lenient, exactly like `--agent`: a transient RPC hiccup must not block a
			// launch. `/session` inside the TUI re-validates.
			initialSessionKey = target;
		}
	}

	chatHandle = await wireConnectUi(tui, client, initialAgentId, initialSessionKey, host);
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
	initialSessionKey?: string,
	/**
	 * The gateway host this client is attached to. Only file attachments care:
	 * they travel as PATHS, so they are meaningful only when the gateway shares
	 * this machine's filesystem. Defaults to loopback — the shape every existing
	 * caller (and every test) already gets.
	 */
	gatewayHost = "127.0.0.1",
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
	// …and the files that rode it. Replaying the text alone would silently drop the
	// image, which is fatal to the single most common reason to switch mid-turn:
	// the current model can't see it, so move to one that can.
	let lastUserAttachments: PromptAttachment[] = [];
	let isAgentRunning = false;
	/**
	 * Set by Ctrl/Cmd+Enter, consumed by the very next submit.
	 *
	 * A one-shot flag rather than a mode: steering is the exceptional gesture,
	 * so it must be re-asserted every time rather than left armed where a later
	 * reflex Enter would inherit it.
	 */
	/**
	 * How many messages `resume` returns at most. `/export` and `/search` both
	 * read through it, so both must say when the head was clipped rather than
	 * presenting a window as the whole conversation.
	 */
	const RESUME_TRANSCRIPT_WINDOW = 200;
	let steerNextSubmit = false;
	/** The mid-turn queue/steer tip is shown once per session, never again. */
	let midTurnHintShown = false;
	/**
	 * Re-entrancy guard against a double-tapped Enter.
	 *
	 * The submit path is async (an RPC round-trip), so two fast Enters can both
	 * pass the `isAgentRunning` gate and send the same text twice. opencode uses
	 * a `submitting` flag for exactly this and Cline's boolean-returning handler
	 * is the same idea after a duplicate-execution bug.
	 */
	let submitInFlight = false;
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
	// Seeded by `--session <key>` (already resolved + verified against sessions.list).
	// Left undefined, the first `state` snapshot seeds it with the agent's main thread.
	let boundSessionKey: string | undefined = initialSessionKey;
	// A name typed before the thread exists on the gateway. `/new` mints a key
	// CLIENT-side and no store entry is written until the first turn, so
	// "start a thread and name it" — the most natural order — had nothing to
	// rename. Hold the name and apply it once the turn creates the entry.
	//
	// Bound to a SPECIFIC key, and re-checked at apply time: if the operator
	// moves to another thread first, this must never land on the wrong one.
	let pendingRename: { sessionKey: string; name: string } | undefined;
	// Key awaiting a confirming repeat of `/delete`. Cleared on any other
	// `/delete` form so a stale confirmation can never execute later.
	let pendingDeleteKey: string | undefined;
	/** Disarm a `/delete` confirmation. Called on EVERY other submitted line, so
	 *  an armed key cannot survive unrelated work and fire on a later repeat that
	 *  the operator expected to re-arm rather than execute. */
	const disarmPendingDelete = (): void => {
		pendingDeleteKey = undefined;
	};
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
			const nextParams: Record<string, string | boolean> = {};
			if (boundAgentId !== undefined) nextParams.agentId = boundAgentId;
			if (boundSessionKey !== undefined) nextParams.sessionId = boundSessionKey;
			// ASK FOR DELTAS EXPLICITLY.
			//
			// The gateway sends full frames unless a client opts in, because
			// stripping `message.content` from a client that has never heard of
			// deltas leaves it rendering nothing until `message_end` — and the
			// desktop app, the watch app and every third-party consumer are exactly
			// that client. Brigade's own TUI knows how to append, so it asks.
			//
			// The renderer below handles BOTH shapes — it appends when a frame
			// carries a delta and no content, and reconciles from the snapshot
			// whenever content IS present — so an older gateway that ignores this
			// flag and sends full frames works unchanged.
			if (Object.keys(nextParams).length > 0) {
				nextParams.deltas = true;
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
	/**
	 * What each tool call was ABOUT, and what it actually returned.
	 *
	 * Two jobs. The completed `✓` chip re-renders with `setText`, which would
	 * otherwise drop the argument summary the `⚡` chip showed — so the args are
	 * kept and re-applied. And the full result text is retained so `/expand` can
	 * show it: previews are hard-truncated at 120 chars (800 for errors) and the
	 * remainder used to be discarded on arrival, which silently swallowed
	 * citations, diffs and any long command output, unrecoverably.
	 *
	 * Bounded — this holds tool output, which can be large.
	 */
	/** Best-effort text for a non-string tool result. Never throws on a cycle. */
	const safeStringify = (v: unknown): string | undefined => {
		if (v === null || v === undefined) return undefined;
		if (typeof v === "string") return v;
		try {
			return JSON.stringify(v, null, 2);
		} catch {
			return String(v);
		}
	};
	/**
	 * Partial tool-call arguments, keyed by the message's `contentIndex`.
	 *
	 * Lives separately from `pendingTools` (keyed by `toolCallId`) because the
	 * call id is not minted until the arguments are COMPLETE — the whole point
	 * here is the window before that.
	 */
	/**
	 * Reconstructed assistant text per render key, for delta streaming.
	 *
	 * In delta mode a `message_update` arrives without `message.content`, so the
	 * text has to be rebuilt by appending. Keyed identically to the render blocks
	 * (`asstKey`), so a delta always lands on the block it belongs to.
	 *
	 * `message_start` and `message_end` still carry full content and RESET this
	 * from the authoritative snapshot, so any drift is corrected within one
	 * message rather than persisting.
	 */
	const deltaText = new Map<string, string>();
	/**
	 * Reasoning text per render key, for delta streaming.
	 *
	 * Delta mode strips `message.content`, and reasoning lives ONLY in that
	 * content — so without a parallel buffer, `thinking_delta` frames had nothing
	 * to paint and a 40-second reasoning phase rendered as a single lump at
	 * `message_end`. The two features shipped together and cancelled each other
	 * out. Reset from the authoritative snapshot exactly like `deltaText`.
	 */
	const deltaThinking = new Map<string, string>();
	/** The last completed assistant reply, for `/copy`. Plain text, unstyled. */
	let lastReplyText = "";

	/**
	 * Live tail panes for running shell-like tools, keyed by tool call id.
	 *
	 * One widget per running command, updated in place, retired when the command
	 * finishes — so a chatty build does not splice a new component per update.
	 */
	const liveOutputPanes = new Map<string, Text>();

	const pendingToolArgs = new Map<number, string>();
	const pendingToolArgRows = new Map<number, Text>();

	/** Paint or update the provisional "…writing call" row for one content block. */
	const renderPendingToolArgs = (contentIndex: number): void => {
		const raw = pendingToolArgs.get(contentIndex) ?? "";
		// Partial JSON is not parseable mid-stream, so show it verbatim —
		// collapsed to one line, scrubbed, and truncated. `formatToolArgs` needs a
		// complete object and would return nothing useful here.
		const flat = scrubRenderable(raw).replace(/\s+/g, " ").trim();
		const shown = flat.length > 72 ? `${flat.slice(0, 71)}…` : flat;
		const text = `  ${brand.tool("⚡")} ${brand.dim(shown ? `…${shown}` : "…preparing call")}`;
		const existing = pendingToolArgRows.get(contentIndex);
		if (existing) {
			existing.setText(text);
		} else {
			const row = new Text(text, 0, 0);
			pendingToolArgRows.set(contentIndex, row);
			insertBeforeEditor(row);
		}
		tui.requestRender();
	};

	/** Retire the provisional row — the real `⚡` chip takes over from here. */
	const clearPendingToolArgs = (contentIndex: number): void => {
		const row = pendingToolArgRows.get(contentIndex);
		if (row) {
			try {
				removeChild(row);
			} catch {
				/* already detached by a transcript rebuild */
			}
			pendingToolArgRows.delete(contentIndex);
		}
		pendingToolArgs.delete(contentIndex);
	};

	/** Drop every provisional row (turn ended, aborted, or transcript rebuilt). */
	const clearAllPendingToolArgs = (): void => {
		for (const idx of [...pendingToolArgRows.keys()]) clearPendingToolArgs(idx);
	};

	const toolCallInfo = new Map<string, { name: string; args?: string; result?: string; isError?: boolean }>();
	const TOOL_INFO_MAX = 200;
	/**
	 * Byte budget per retained tool result.
	 *
	 * The entry COUNT was capped and the bytes were not — a `read` of a large
	 * file or a chatty `bash` put megabytes into a single entry, so 200 entries
	 * could hold hundreds of MB in the TUI process. `/expand` exists to show what
	 * the 120-char preview cut, not to be a file viewer, so a generous per-entry
	 * cap costs nothing real.
	 */
	const TOOL_RESULT_MAX_CHARS = 64 * 1024;
	const rememberToolInfo = (id: string, patch: { name?: string; args?: string; result?: string; isError?: boolean }): void => {
		const prev = toolCallInfo.get(id);
		if (prev) toolCallInfo.delete(id); // keep insertion order = least-recently-used
		const capped =
			typeof patch.result === "string" && patch.result.length > TOOL_RESULT_MAX_CHARS
				? {
						...patch,
						result: `${patch.result.slice(0, TOOL_RESULT_MAX_CHARS)}\n… (truncated — ${patch.result.length.toLocaleString()} chars total)`,
					}
				: patch;
		toolCallInfo.set(id, { name: patch.name ?? prev?.name ?? "tool", ...prev, ...capped });
		while (toolCallInfo.size > TOOL_INFO_MAX) {
			const oldest = toolCallInfo.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			toolCallInfo.delete(oldest);
		}
	};
	// HARNESS backends (claude-cli) stream ONE assistant message for the whole turn:
	// the external binary emits text, calls a tool, then keeps writing into the SAME
	// message. So `asstKey` — which identity-keys a block by `<depth>:<timestamp>` —
	// resolves the post-tool continuation back to the block that was opened BEFORE the
	// tool. The chip stays pinned below while new prose grows above it, which reads as
	// a frozen UI. (A loop backend is unaffected: Pi genuinely starts a new message
	// after each tool result, so its continuation gets a new timestamp and a new key.)
	//
	// So when a tool fires we remember how much of that message's text was already on
	// screen; every later update for the same key renders only the text BEYOND that
	// mark, into a fresh block below the chip. `message_end`, which carries the whole
	// message, lands as the same tail — never a duplicate of the pre-tool prose.
	const asstTextLen = new Map<string, number>();
	const asstKeyByDepth = new Map<number, string>();
	const asstContinuation = new Map<string, { prefixLen: number; block?: Markdown }>();
	/** Turn boundary: these track ONE turn's message identities, like `activeAssistants`. */
	const clearHarnessContinuations = (): void => {
		asstTextLen.clear();
		asstKeyByDepth.clear();
		asstContinuation.clear();
	};
	/** Take the "thinking" spinner down. Called only when a paint is about to land. */
	const dismissLoader = (): void => {
		if (!activeLoader) return;
		removeChild(activeLoader);
		activeLoader = null;
	};

	// A newer Brigade is published. Say so ONCE per attach — every state mutation
	// pushes a snapshot, and a notice that reprints on each one is an advert.
	//
	// It asks; it never acts. An update restarts the gateway, and the operator may be
	// mid-turn. It also answers the question they will actually have — "will this eat
	// my work?" — before they have to ask it.
	let announcedUpdate = false;
	const maybeAnnounceUpdate = (upd: { current: string; latest: string } | null): void => {
		if (!upd || announcedUpdate) return;
		announcedUpdate = true;
		insertBeforeEditor(
			new Text(
				`  ${brand.amber("↑")} ${brand.dim(`Brigade ${upd.latest} is available — you're on ${upd.current}.`)}\n` +
					`    ${brand.dim(UPDATE_PRESERVES_MESSAGE)}\n` +
					`    ${brand.dim("Update now?")} ${chalk.bold("/update")} ${brand.dim("· or later, from any shell:")} ${chalk.bold("brigade update")}`,
				0,
				0,
			),
		);
		tui.requestRender();
	};
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
	// Thinking-block visibility. Defaults ON.
	//
	// It defaulted OFF, which meant most operators never learned reasoning
	// existed — and because the toggle is a plain local, anyone who did find
	// `/reasoning on` had to retype it every launch. Every comparable harness
	// surveyed shows reasoning by default (Cline, Roo, Continue, Aider, Grok
	// Build, Gemini CLI); the one that hides it, Claude Code, does so because
	// its CLI actively asks the API to redact it.
	//
	// Brigade now requests thinking summaries from the claude-cli backend (see
	// `buildClaudeCliArgs`), so on the most common install there is finally
	// something to show. The header carries the one-line state regardless of
	// this flag — this controls only whether the reasoning TEXT is rendered
	// inline with the reply.
	//
	// Persisted in `chat.showReasoning`, so a choice survives the next launch —
	// it used to be a bare local, which meant retyping `/reasoning on` every
	// time. Read defensively: a missing or unreadable config falls back to the
	// default rather than failing the session over a preference.
	let showThinking = true;
	// Ring when a long turn finishes. Default on; a short turn stays silent, so
	// this is not noise for the interactive case.
	let notifyOnComplete = true;
	try {
		const cfg = readConfigOrInit().chat;
		if (typeof cfg?.showReasoning === "boolean") showThinking = cfg.showReasoning;
		if (typeof cfg?.notifyOnComplete === "boolean") notifyOnComplete = cfg.notifyOnComplete;
	} catch {
		/* unreadable config — keep the defaults */
	}

	/**
	 * Render a failed request with the server's own guidance attached.
	 *
	 * The wire carries `retryable` and `retryAfterMs`; the client used to flatten
	 * every failure into a bare message, so a rate limit that clears in 30
	 * seconds and a permanent auth failure looked identical. Appending the hint
	 * is the difference between "try again in a moment" and "stop and fix your
	 * credentials".
	 */
	/** "just now" / "4m ago" / "2h ago" / "3d ago". Absent input renders nothing. */
	const formatRelativeAge = (at: number): string => {
		const ms = Date.now() - at;
		if (!Number.isFinite(ms) || ms < 0) return "";
		const s = Math.round(ms / 1000);
		if (s < 45) return "just now";
		const m = Math.round(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.round(h / 24)}d ago`;
	};

	const describeError = (err: unknown): string => {
		const msg = err instanceof Error ? err.message : String(err);
		const hint = describeRetry(err);
		return hint ? `${msg} (${hint})` : msg;
	};

	/**
	 * Apply a reasoning-visibility choice: update the session, persist it, and
	 * echo what happened. Shared by `/reasoning` and Ctrl+T so the two can never
	 * drift — the toggle must mean the same thing however it was reached.
	 */
	const applyReasoningVisibility = (next: boolean): void => {
		showThinking = next;
		void mutateConfigAtomic((cfg) => ({
			...cfg,
			chat: { ...(cfg.chat ?? {}), showReasoning: next },
		})).catch(() => {
			/* best-effort — the toggle still applies to this session */
		});
		insertBeforeEditor(
			new Text(
				`  ${brand.dim(
					next
						? "reasoning: on  (ctrl+t to hide)"
						: "reasoning: off (ctrl+t to show)",
				)}`,
				0,
				0,
			),
		);
		tui.requestRender();
	};

	/** Last header string actually written — see the no-op guard below. */
	let lastHeaderText = "";
	const updateHeader = (extra?: string): void => {
		const provider = lastSnapshot?.provider ?? "?";
		const modelId = lastSnapshot?.modelId ?? "?";
		const tokens = lastSnapshot && (lastSnapshot.totalTokensIn + lastSnapshot.totalTokensOut) > 0
			? ` · ${(lastSnapshot.totalTokensIn + lastSnapshot.totalTokensOut).toLocaleString()} tok`
			: "";
		// COST. Four situations used to render as the same `$0.0000`: a genuinely
		// cheap metered turn, a subscription with no marginal cost, local
		// inference, and an unpriced model that IS costing money. The last one is
		// why this can never print a bare zero by default.
		const costSegment = lastSnapshot
			? formatCostSegment({
					billing: lastSnapshot.billing,
					costUsd: lastSnapshot.totalCostUsd,
					...(lastSnapshot.costComplete !== undefined ? { costComplete: lastSnapshot.costComplete } : {}),
				})
			: undefined;
		const cost = costSegment ? ` · ${costSegment}` : "";
		// CONTEXT. Always visible, not just past 50%.
		//
		// The old `>= 50` gate meant that for most of a session's life the
		// operator saw nothing — and context fill is the one number that should
		// change their behaviour (compact, or start a fresh thread). Now that the
		// gateway sends `contextTokens`/`contextWindow` alongside the percentage,
		// show the pair: "34k/200k" answers "how much room is left" far better
		// than a bare percent, which is meaningless without the window size.
		const usage = lastSnapshot?.contextUsagePercent ?? null;
		const ctxTokens = lastSnapshot?.contextTokens ?? null;
		const ctxWindow = lastSnapshot?.contextWindow ?? null;
		let usageStr = "";
		if (ctxTokens != null && ctxWindow != null && ctxWindow > 0) {
			const pct = Math.round((ctxTokens / ctxWindow) * 100);
			const body = `${formatTokens(ctxTokens)}/${formatTokens(ctxWindow)} ctx`;
			usageStr = ` · ${pct >= 75 ? brand.amber(body) : brand.dim(body)}`;
		} else if (usage != null) {
			// No raw pair (an older gateway, or right after a compaction when Pi
			// deliberately reports unknown) — fall back to the percentage alone.
			const pct = Math.round(usage);
			const colored = pct >= 75 ? brand.amber(`${pct}% ctx`) : brand.dim(`${pct}% ctx`);
			usageStr = ` · ${colored}`;
		}

		// REASONING. The live phase, and what kind of reasoning this backend
		// actually exposes — a provider summary is not the model's own thinking,
		// and an omitted-but-billed phase is not "no thinking happened".
		const reasoningLine = formatReasoningLine({ state: lastSnapshot?.reasoning });
		const reasoningStr = reasoningLine ? ` · ${brand.dim(reasoningLine)}` : "";
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
		// ─────────────────────────────────────────────────────────────────────
		// THE HEADER IS LINE 0, AND LINE 0 IS EXPENSIVE.
		// ─────────────────────────────────────────────────────────────────────
		// `header` is the FIRST child, so it occupies render-buffer line 0. Once
		// the transcript grows past the terminal height, pi-tui's differential
		// renderer sees `firstChanged (0) < previousViewportTop` and bails to
		// `fullRender(true)` (tui.js:1169) — which emits `\x1b[2J\x1b[H\x1b[3J`.
		// That `3J` CLEARS THE USER'S SCROLLBACK.
		//
		// So anything volatile in the header destroys scroll history every time
		// it changes. With a 1s elapsed ticker, a 4s phrase rotation, and live
		// token/cost/context/reasoning, that was roughly once a second for the
		// whole turn — measured at ~39 scrollback wipes and 96% of all bytes
		// written across a 40-second turn.
		//
		// The header therefore carries only IDENTITY, which changes when the
		// operator switches agent/session/model and not otherwise. Everything
		// that ticks lives in the footer, which is pinned near the bottom of the
		// buffer where a change is inside the viewport and renders differentially.
		// The footer already mirrored this data for exactly that reason.
		const headerText = `  🦁 ${brand.white(personaLabel)}${crewSegment}${sessionSegment}  ${brand.dim(`${provider} · ${modelId}`)}`;
		// Guard against a no-op write: `setText` marks the widget dirty even when
		// the string is identical, and a dirty line 0 is a full redraw.
		if (headerText !== lastHeaderText) {
			lastHeaderText = headerText;
			header.setText(headerText);
		}
		// The live readout. Pinned under the editor, so it survives the viewport
		// scroll AND is cheap to repaint.
		footer.setText(
			`  ${dot} ${brand.dim(`${provider} · ${modelId}${tokens}${cost}`)}${usageStr}${reasoningStr}${brand.dim(elapsed)}${brand.dim(tail)}`,
		);
	};

	/**
	 * Tick the elapsed-time display every second while the agent is busy.
	 * Cheap (one timer per connect session, not per-turn), repaints only
	 * while a turn is running, and unref'd — connect exits via process.exit,
	 * which is what retires it (there is deliberately no clearInterval).
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
	/**
	 * The attachment bar. Lives in the BOTTOM region — with the editor and footer —
	 * because that is the only part Pi-TUI keeps pinned on screen.
	 *
	 * The first version of this printed chips into the scrollback instead, which
	 * meant that the moment anything else happened they scrolled away and there was
	 * no way to tell, at the instant you press Enter, whether a file was armed. An
	 * attachment you cannot SEE is one you cannot trust; this is the difference
	 * between the feature working and the feature feeling like it works.
	 */
	const attachBar = new Text("", 0, 0);
	tui.addChild(attachBar);
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
		{
			name: "copy",
			description: "copy the last reply to your clipboard (code = just the code block)",
			argumentHint: "[code]",
		},
		{
			name: "expand",
			description: "show a truncated tool result in full (no arg = the most recent)",
			argumentHint: "[<n>]",
		},
		{
			name: "steer",
			description: "interrupt the running turn — the model sees it mid-task (Enter queues instead)",
			argumentHint: "<text>",
		},
		{
			name: "flush",
			description: "promote everything you queued into the running turn, now",
		},
		{
			name: "export",
			description: "write this conversation to a redacted markdown file",
			argumentHint: "[full]",
		},
		{
			name: "search",
			description: "find text in this conversation, including tool output",
			argumentHint: "<text>",
		},
		{
			name: "rewind",
			description: "go back to an earlier message (conversation only — files are untouched)",
			argumentHint: "[n]",
		},
		{ name: "usage", description: "show token totals + estimated cost so far" },
		{ name: "compact", description: "summarize older turns to free context" },
		{
			name: "attach",
			description: "attach a file to the next turn (no arg = show staged files)",
			argumentHint: "[<path>]",
		},
		{
			name: "paste",
			description: "attach the image or file on your clipboard (screenshot → paste)",
		},
		{
			name: "clipboard",
			description: "diagnose the clipboard: build, worker health, and what it holds",
		},
		{
			name: "detach",
			description: "unstage an attached file — n, or all",
			argumentHint: "[<n> | all]",
		},
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
			name: "update",
			description: "install the newer Brigade (your sessions, memory and config are untouched)",
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
			description: "show/hide the model's reasoning (or press ctrl+t) — remembered across launches",
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
			name: "rename",
			description: "name this thread (no argument clears the name)",
			argumentHint: "[<name>]",
		},
		{
			name: "delete",
			description: "permanently delete a thread and its transcript (confirm by repeating)",
			argumentHint: "<session-key>",
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
			brand.dim("  connect-mode: /new /agent /agents /session /sessions /rename /delete · /model /provider /thinking /reasoning · /abort /steer /flush /compact · /export /search /rewind /usage /help"),
			0,
			0,
		),
	);
	tui.addChild(
		new Text(
			brand.dim("  Enter to send · Ctrl+C abort · attach: drag a file · @path · Ctrl+V an image · /help"),
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
				// A REDACTED block has no readable text — only an opaque payload in
				// `thinkingSignature`. It was dropped silently, which reads as "the
				// model didn't reason" when in fact it did, was billed for it, and a
				// safety filter removed the text. Say so.
				else if (b.redacted === true) thinkingParts.push("(reasoning redacted by the provider)");
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
		const vis = lastSnapshot?.reasoning?.visibility;
		if (showThinking && thinkingText) {
			// Label what this actually IS. A literal "[thinking]" over an
			// Anthropic / OpenAI / Grok response is wrong: those return a summary
			// written by a DIFFERENT model, not the model's own chain of thought.
			// The visibility rides the state snapshot precisely so the renderer
			// never has to hardcode provider knowledge.
			const label = vis === "summary" ? "[reasoning summary]" : "[reasoning]";
			parts.push(`${brand.dim(label)}\n${brand.dim(thinkingText)}`);
		} else if (showThinking && !thinkingText && (vis === "hidden" || vis === "redacted")) {
			// REASONING IS ON, THE MODEL REASONED, AND THERE IS NOTHING TO SHOW.
			//
			// Rendering nothing here is the worst of the three options: the
			// operator explicitly asked to see reasoning, the model demonstrably
			// produced some (the footer is showing a duration and a billed token
			// count), and the pane stays empty — which reads as "the toggle is
			// broken" or "it didn't think". Neither is true.
			//
			// `hidden` is the DEFAULT on the current Claude generation: the text
			// is omitted by provider policy and billed anyway. Say that once, in
			// the operator's words, so an empty pane becomes an explanation.
			parts.push(brand.dim(`[${describeReasoningVisibility(vis)}]`));
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

	// `extractUserText`, `clipOneLine` are imported from `connect-transcript.js`
	// (pure + unit-tested). Tool-result previews go through the SHARED
	// `summarizeToolResult`, so the resume view and the live view cannot drift.

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
		clearAllPendingToolArgs();
		liveOutputPanes.clear();
		deltaText.clear();
		deltaThinking.clear();
		clearHarnessContinuations();
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
					if (b?.type === PI_TOOL_CALL && typeof b.id === "string") {
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
		if (m.role === PI_TOOL_RESULT && typeof m.toolCallId === "string") {
			const mark = m.isError ? brand.error("✗") : brand.tool("✓");
			const name = typeof m.toolName === "string" ? m.toolName : "tool";
			// The SAME summariser the live path uses, not a second one. This view used
			// `joinToolResultText` + `clipOneLine` with an 80-char budget while live used
			// 120, so a `resume` silently re-clipped every tool result — and
			// `joinToolResultText` filters to text blocks, so an image-only result
			// rendered as a bare chip here and `[image …]` there. A transcript that
			// disagrees with what you just watched is worse than no transcript.
			const clipped = scrubRenderable(summarizeToolResult(m.content, { preserveNewlines: false }).preview);
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
	// remembers (best-in-class default: every serious chat client lands you back
	// in your thread WITH history). A genuinely clean slate is `/new` (a real
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
				if (!snap.snapshot.isAgentRunning) {
					isAgentRunning = false;
					// Belt-and-braces: a turn reconciled off by a resume must never
					// leave the editor unable to submit. Nothing sets this true today,
					// but a missed `agent_end` used to lock the input for the rest of
					// the session with no visible cause.
					editor.disableSubmit = false;
				}
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
	//
	// Extracted from the `on("state")` listener so startup can PULL one, because the
	// PUSH is a race we do not always win.
	//
	// The gateway sends one snapshot immediately after `helloOk` (server.ts) — before
	// any user action. `runConnectCommand` then registers this listener. With no flags
	// there is nothing between `connect()` and registration, so the frame lands. But
	// `--agent` awaits `agents.list` and `--session` awaits `sessions.list` FIRST; each
	// await yields to I/O, the snapshot is dispatched with no listener attached, and it
	// is gone. Nothing re-sends it.
	//
	// This listener is also where the lane subscription fires and where `doResume()`
	// loads the thread's history. So the flagged launches sat blank — header `? · ?`,
	// no transcript — until the operator typed something and a state CHANGE finally
	// triggered a broadcast. `--session` made it undeniable: it opened exactly the
	// right thread and showed none of it.
	const applyStateSnapshot = (snap: SessionStateSnapshot): void => {
		lastSnapshot = snap;
		maybeAnnounceUpdate(snap.updateAvailable ?? null);
		// `snap.isAgentRunning` is AGENT-wide — it goes true when ANY session
		// of this agent has a turn running (a WhatsApp chat, spawned
		// sub-agents, a cron run). Taking it as-is flipped THIS lane into
		// steer mode while our own session was idle, so typed messages
		// bounced with "nothing to steer" and were lost. Only the CLEARING
		// direction is safe from the snapshot (it reconciles a missed
		// agent_end after a disconnect); the lane's own agent_start /
		// agent_end events own the upward direction.
		if (!snap.isAgentRunning) {
			isAgentRunning = false;
			editor.disableSubmit = false;
		}
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
	};
	client.on("state", applyStateSnapshot);

	// Ask, rather than depend on having caught the push. Idempotent with the broadcast
	// above (same handler, latest snapshot wins), and it makes the launch deterministic
	// whether or not a pre-wiring `await` swallowed the connect-time frame. This is what
	// seeds the binding, fires the lane subscription, and drives `doResume()`.
	// Best-effort: a gateway that cannot answer `get-state` leaves the old behaviour.
	void (async () => {
		try {
			const snap = (await client.request("get-state")) as SessionStateSnapshot | undefined;
			if (snap) applyStateSnapshot(snap);
		} catch {
			/* the next broadcast will do it */
		}
	})();

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
		// A CHILD turn (`spawn_agent`) streams its own lifecycle: agent_start when it
		// begins, agent_end when it finishes. Those events describe the child, not this
		// turn — and the handlers below tear down THIS turn's state.
		//
		// Unguarded, a sub-agent finishing ran the parent's teardown mid-flight:
		// `activeAssistants.clear()` dropped the parent's streaming block identity, so
		// when the parent resumed it opened a FRESH block holding the whole message and
		// re-rendered its entire answer from the top; `pendingTools.clear()` orphaned the
		// parent's own `⚡ spawn_agent` chip so it never turned `✓`; `isAgentRunning=false`
		// and `disableSubmit=false` told the operator the turn was over while it ran on.
		// A child's agent_start was no better: it overwrote `activeLoader`, leaking the
		// parent's spinner widget into the transcript, and reset the elapsed clock.
		//
		// The child's WORK is still shown — its text, tool chips and approval prompts all
		// carry `depth` and render indented under `sub-agent`. Only the turn-lifecycle
		// bookkeeping is the parent's alone.
		const isChildTurn = depth > 0;
		switch (event?.type) {
			case "agent_start": {
				if (isChildTurn) {
					// Mark the handoff. Without it, a `spawn_agent` that thinks for a minute
					// before writing anything is a minute of blank screen under a `⚡` chip,
					// and when the child's prose finally arrives there is nothing saying
					// whose prose it is.
					insertBeforeEditor(
						new Text(`${subIndent}  ${brand.dim("↳ sub-agent working…")}`, 0, 0),
					);
					tui.requestRender();
					break;
				}
				isAgentRunning = true;
				agentStartedAt = Date.now();
				whimsicalIdx = 0; // reset so the first phrase is always "thinking"
				// Submit stays ENABLED during a turn.
				//
				// Blocking it made pi-tui return early from Enter
				// (components/editor.js: `if (this.disableSubmit) return`), which made
				// the entire mid-turn path below unreachable: steering, the queued
				// message notice, and the deliberate hoisting of `/attach` + `/paste`
				// above the steer gate so a screenshot can be staged while the model
				// works. All of it was written, tested by eye, and dead.
				//
				// Every comparable harness accepts input during a turn — it is how you
				// redirect a model that has misunderstood without throwing the turn
				// away. The submit handler already routes a mid-turn Enter to `steer`.
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
				// LIVE TOOL-CALL ARGUMENTS.
				//
				// The provider streams a tool's arguments as partial JSON while the
				// model is still writing them (`toolcall_delta`), and Pi carries that
				// on `message_update.assistantMessageEvent`. Every other harness
				// surveyed assembles the complete call before rendering anything —
				// three of them have the delta on the wire and discard it — so the
				// operator watches a spinner while the model decides which file to
				// edit. Showing it as it forms is the single clearest thing this
				// renderer can do that the others do not.
				//
				// Rendered as a PROVISIONAL row keyed by `contentIndex`, because the
				// real `toolCallId` does not exist until `tool_execution_start`, which
				// fires only once the call is complete. That handler retires this row.
				const inner = (event as { assistantMessageEvent?: { type?: string; contentIndex?: number; delta?: unknown } })
					.assistantMessageEvent;
				if (inner && typeof inner.contentIndex === "number" && depth === 0) {
					if (inner.type === "toolcall_start") {
						pendingToolArgs.set(inner.contentIndex, "");
						renderPendingToolArgs(inner.contentIndex);
					} else if (inner.type === "toolcall_delta" && typeof inner.delta === "string") {
						const prev = pendingToolArgs.get(inner.contentIndex) ?? "";
						// Bounded: partial JSON for a big write can be enormous, and only
						// the head is legible on one row anyway.
						pendingToolArgs.set(inner.contentIndex, (prev + inner.delta).slice(0, 2000));
						renderPendingToolArgs(inner.contentIndex);
					} else if (inner.type === "toolcall_end") {
						clearPendingToolArgs(inner.contentIndex);
					}
				}
				const msg = event.message;
				if (!msg || msg.role !== "assistant") break;
				// DELTA MODE. When we asked for deltas, `message_update` arrives with
				// no `content` — the cumulative blocks are exactly the payload we
				// asked the gateway to stop resending. Rebuild the text by appending,
				// keyed the same way the render block is.
				//
				// A frame that DOES carry content (message_start, message_end, an
				// older gateway, or a resume rebuild) is authoritative and RESETS the
				// accumulator, so drift can never outlive a single message.
				const deltaKey = asstKey(depth, msg);
				const hasFullContent = Array.isArray((msg as { content?: unknown }).content);
				if (!hasFullContent) {
					const innerDelta = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } })
						.assistantMessageEvent;
					if (innerDelta?.type === "text_delta" && typeof innerDelta.delta === "string") {
						deltaText.set(deltaKey, (deltaText.get(deltaKey) ?? "") + innerDelta.delta);
					} else if (innerDelta?.type === "thinking_delta" && typeof innerDelta.delta === "string") {
						// Reasoning DOES change visible text now that it renders by
						// default. Accumulating it here is what keeps the thinking phase
						// streaming under delta mode instead of arriving as one lump.
						deltaThinking.set(deltaKey, (deltaThinking.get(deltaKey) ?? "") + innerDelta.delta);
					} else {
						// A tool-call delta or a phase marker — no visible text changed.
						break;
					}
				}
				// Scrub server-pushed assistant text before it reaches the
				// Markdown widget (see `scrubRenderable`). The model can be
				// steered to emit ANSI/OSC control bytes; the widget preserves
				// raw escapes, so strip them here. The brand-coloured label
				// prefix added below is Brigade-internal chalk and stays intact.
				const text = hasFullContent
					? (() => {
							// Authoritative snapshot — reconcile the accumulator to it.
							const full = extractAssistantText(msg);
							if (event.type === "message_end" && depth === 0 && full.trim()) lastReplyText = full;
							deltaText.set(deltaKey, full);
							// The snapshot already contains the reasoning block, so the
							// parallel buffer must not be composed in on top of it.
							deltaThinking.delete(deltaKey);
							return scrubRenderable(full);
						})()
					: (() => {
							// Same composition `extractAssistantText` produces, so the two
							// modes render identically: the labelled reasoning block, then
							// a blank line, then the reply.
							const think = showThinking ? (deltaThinking.get(deltaKey) ?? "").trim() : "";
							const body = (deltaText.get(deltaKey) ?? "").trim();
							const vis = lastSnapshot?.reasoning?.visibility;
							const label = vis === "summary" ? "[reasoning summary]" : "[reasoning]";
							const composed = think
								? `${brand.dim(label)}\n${brand.dim(think)}${body ? `\n\n${body}` : ""}`
								: body;
							return scrubRenderable(composed);
						})();
				if (!text) break;
				// NOTE: the loader is dismissed further down, only once we know this
				// update actually paints something. A harness re-emits its partial on
				// every `thinking_delta`, carrying the SAME text — dismissing here would
				// clear the "thinking" spinner and leave a dead screen for the whole
				// reasoning window.
				// Label assistant turns with the agent's chosen name (from
				// IDENTITY.md, exposed via state snapshot). Falls back to
				// the runtime container name when the operator hasn't named
				// the agent yet — same convention as the brand colour, just
				// dynamic per-workspace.
				const label = lastSnapshot?.agentName ?? "brigade";
				const labelPrefix = depth > 0 ? "sub-agent" : label;
				const renderedText = `${subIndent}${brand.agent(labelPrefix)}  ${text}`;

				// A harness turn keeps ONE message across its tool calls (see
				// `asstContinuation`). Render only what arrived after the last chip.
				const contKey = asstKey(depth, msg);
				asstTextLen.set(contKey, text.length);
				asstKeyByDepth.set(depth, contKey);
				const cont = asstContinuation.get(contKey);
				if (cont) {
					// Strip the leading break the transport inserts between two text blocks
					// (see `separateTextBlock`). It belongs BETWEEN the blocks, and this
					// continuation IS the block boundary — kept, it would open the new block
					// with a blank line under its own label.
					const tail = text.slice(cont.prefixLen).replace(/^\n+/, "");
					// Nothing new since the chip — the model is still thinking. Leave the
					// spinner up and paint nothing.
					if (!tail.trim()) break;
					dismissLoader();
					const tailText = `${subIndent}${brand.agent(labelPrefix)}  ${tail}`;
					if (!cont.block) {
						cont.block = new Markdown(tailText, 1, 0, markdownTheme);
						insertBeforeEditor(cont.block);
					} else {
						cont.block.setText(tailText);
					}
					if (event.type === "message_end") {
						// The message is final and its block is static from here, so the
						// reconstruction buffer is dead weight. Dropping it keeps the map
						// bounded by the number of IN-FLIGHT messages rather than by the
						// length of the session.
						deltaText.delete(deltaKey);
						deltaThinking.delete(deltaKey);
						flushStreamingRender();
					} else scheduleStreamingRender();
					break;
				}
				// Identity-keyed streaming block (see `asstKey`). Each logical
				// message — top-level or sub-agent — owns ONE growing Markdown
				// block, resolved by `${depth}:${timestamp}`. A continuation after
				// a tool call is a new message (new timestamp) → a fresh block
				// that lands BELOW the tool; a late/duplicate update for an
				// earlier message resolves to its existing block and updates it in
				// place, so nothing is ever misplaced or duplicated.
				dismissLoader();
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
						// Final message — drop its reconstruction buffer (see the
						// continuation branch above), so the map stays bounded by
						// in-flight messages rather than session length.
						deltaText.delete(deltaKey);
						deltaThinking.delete(deltaKey);
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
				// …but a HARNESS backend never starts that new message: its binary
				// writes text, calls a tool, and keeps writing into the same one. Mark
				// how much of it is already rendered, so the continuation opens a fresh
				// block BELOW this chip instead of silently growing the one above it.
				// (Loop backends never take this path — their next update carries a new
				// timestamp, hence a new key, which has no mark.)
				const openKey = asstKeyByDepth.get(depth);
				if (openKey !== undefined) {
					asstContinuation.set(openKey, { prefixLen: asstTextLen.get(openKey) ?? 0 });
				}
				// A PLAN UPDATE is not a tool call to read — it is a checklist.
				//
				// `TodoWrite` is in the allowed tool set (claude-cli/catalog.ts), so the
				// model calls it, and it fell through to the generic chip: a naked
				// `✓ TodoWrite · {"todos":[{"content":"Rea…` clipped at 120 chars, once
				// per plan update. On a long task that is eight rows of noise where
				// most harnesses show live progress. Rendered as its own block, which
				// the `tool_execution_end` handler then leaves alone.
				const todoItems = /todo|plan/i.test(event.toolName) ? parseTodoArgs(event.args) : undefined;
				if (todoItems) {
					const lines = todoItems.map((item) => {
						const mark = todoMarker(item.status);
						const paint =
							item.status === "completed"
								? brand.dim
								: item.status === "in_progress"
									? brand.amber
									: item.status === "cancelled"
										? brand.dim
										: brand.white;
						return `${subIndent}      ${paint(`${mark} ${scrubRenderable(item.text)}`)}`;
					});
					insertBeforeEditor(
						new Text(
							`${subIndent}  ${brand.tool("▤")} ${brand.tool("plan")} ${brand.dim(summarizeTodos(todoItems))}\n${lines.join("\n")}`,
							0,
							0,
						),
					);
					tui.requestRender();
					break;
				}
				// Show WHAT the tool is acting on, not just that one is running.
				// `⚡ bash` / `⚡ edit` told the operator nothing — which command,
				// which file. `args` was on the wire the whole time and discarded.
				const argSummary = scrubRenderable(formatToolArgs(event.args) ?? "");
				const indicator = new Text(
					`${subIndent}  ${brand.tool("⚡")} ${brand.tool(event.toolName)}` +
						(argSummary ? ` ${brand.dim(argSummary)}` : ""),
					0,
					0,
				);
				// The real chip supersedes any provisional "…writing call" row.
				clearAllPendingToolArgs();
				pendingTools.set(event.toolCallId, indicator);
				rememberToolInfo(event.toolCallId, {
					name: event.toolName,
					...(argSummary ? { args: argSummary } : {}),
				});
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
					// A SHELL-LIKE tool's output is a running log, not a value. Collapsed
					// to a 120-char one-liner it was the worst moment in the product: a
					// four-minute test run showed one truncated flickering row, and you
					// could not see which test failed until it ended. Give it a bounded
					// tail pane instead — the last lines, updated in place.
					const raw =
						typeof event.partialResult === "string"
							? event.partialResult
							: (summarizeToolResult(event.partialResult, { preserveNewlines: true }).preview ?? "");
					if (isShellLikeTool(event.toolName) && raw.includes("\n")) {
						const argsTail = toolCallInfo.get(event.toolCallId)?.args;
						liveIndicator.setText(
							`${subIndent}  ${brand.tool("⚡")} ${brand.tool(event.toolName)}` +
								(argsTail ? ` ${brand.dim(argsTail)}` : "") +
								` ${brand.dim(`· ${describeOutputSize(raw)}`)}`,
						);
						const pane = liveOutputPanes.get(event.toolCallId);
						const body = tailLines(scrubRenderable(raw))
							.map((line) => `${subIndent}      ${brand.dim(line)}`)
							.join("\n");
						if (pane) {
							pane.setText(body);
						} else {
							const created = new Text(body, 0, 0);
							liveOutputPanes.set(event.toolCallId, created);
							insertBeforeEditor(created);
						}
					} else {
						const summary = summarizeToolResult(event.partialResult, { preserveNewlines: false });
						const previewText = scrubRenderable(summary.preview);
						const tail = summary.hasContent ? ` ${brand.dim(`· ${previewText}`)}` : "";
						liveIndicator.setText(`${subIndent}  ${brand.tool("⚡")} ${brand.tool(event.toolName)}${tail}`);
					}
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
					// Retain the FULL result (not the preview) so `/expand` can show
					// what was cut, and carry the argument summary onto the completed
					// chip — `setText` below replaces the whole row, so without this
					// the `✓` chip forgets which file or command it was about.
					const keptArgs = toolCallInfo.get(event.toolCallId)?.args;
					rememberToolInfo(event.toolCallId, {
						name: event.toolName,
						result: typeof event.result === "string" ? event.result : safeStringify(event.result),
						isError: event.isError,
					});
					const argTail = keptArgs ? ` ${brand.dim(keptArgs)}` : "";
					// A file edit's result is a unified diff on most backends. `+12 −3`
					// says more at a glance than the first 120 characters of it, and it
					// is what the operator actually wants to know.
					const rawResult = typeof event.result === "string" ? event.result : "";
					const diffTail = looksLikeUnifiedDiff(rawResult)
						? (() => {
								const { added, removed } = summarizeDiffStats(rawResult);
								return ` ${brand.tool(`+${added}`)} ${brand.error(`−${removed}`)}`;
							})()
						: "";
					if (event.isError && summary.multiline) {
						indicator.setText(`${subIndent}  ${mark} ${brand.tool(event.toolName)}${argTail}`);
						const errIndent = `${subIndent}      `;
						const indentedBody = previewText
							.split("\n")
							.map((line) => `${errIndent}${brand.dim(line)}`)
							.join("\n");
						insertBeforeEditor(new Text(indentedBody, 0, 0));
					} else {
						const preview = summary.hasContent ? ` ${brand.dim(`· ${previewText}`)}` : "";
						indicator.setText(`${subIndent}  ${mark} ${brand.tool(event.toolName)}${argTail}${diffTail}${preview}`);
					}
					// The final result replaces the live tail; retire the pane so the
					// finished command leaves one summary row, not a stale window.
					const donePane = liveOutputPanes.get(event.toolCallId);
					if (donePane) {
						try {
							removeChild(donePane);
						} catch {
							/* already detached by a transcript rebuild */
						}
						liveOutputPanes.delete(event.toolCallId);
					}
					tui.requestRender();
					pendingTools.delete(event.toolCallId);
				}
				// A harness backend goes quiet after a tool: its binary resumes the SAME
				// message and can think for half a minute before the next token. The
				// `agent_start` loader is long gone (the chip removed it), so the screen
				// sits dead and the turn reads as hung. Re-arm it until text resumes.
				// Gated on an OPEN continuation with no block yet — a condition only a
				// harness turn can produce, so loop backends render exactly as before.
				const openCont = asstContinuation.get(asstKeyByDepth.get(depth) ?? "");
				if (openCont && !openCont.block && !activeLoader && isAgentRunning) {
					activeLoader = new CancellableLoader(
						tui,
						(s) => brand.amber(s),
						(s) => brand.dim(s),
						"thinking",
						loaderIndicator(),
					);
					insertBeforeEditor(activeLoader);
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
				// A CHILD's context, not ours — never quote the parent's percentage for it.
				const pct = isChildTurn
					? "high"
					: lastSnapshot?.contextUsagePercent != null
						? `${Math.round(lastSnapshot.contextUsagePercent)}%`
						: "high";
				insertBeforeEditor(
					new Text(`${subIndent}  ${brand.dim(`⚡ compacting context (was ${pct})…`)}`, 0, 0),
				);
				break;
			}
			case "compaction_end": {
				// Pi emits `compaction_end` on FAILURE too, with `aborted: false`,
				// no `result`, and an `errorMessage` — a summarization error, a 401,
				// a rate limit, or overflow-recovery exhaustion. Branching on
				// `aborted` alone printed "✓ compacted" for a compaction that never
				// happened, which is exactly the unfalsifiable claim that let the
				// 1.33 loop report success while making no progress.
				const compactionFailed =
					typeof event.errorMessage === "string" && event.errorMessage.length > 0;
				if (event.aborted) {
					insertBeforeEditor(new Text(`${subIndent}  ${brand.dim("compaction aborted")}`, 0, 0));
				} else if (compactionFailed) {
					const why = clipOneLine(scrubRenderable(event.errorMessage ?? ""), 90);
					insertBeforeEditor(
						new Text(
							`${subIndent}  ${brand.error("✗")} ${brand.dim(`compaction failed · ${why}`)}`,
							0,
							0,
						),
					);
				} else if (isChildTurn) {
					// The child compacted its OWN context. Say so, and leave the parent's
					// header figure alone — it still describes the parent's session.
					insertBeforeEditor(
						new Text(`${subIndent}  ${brand.amber("✓")} ${brand.dim("compacted")}`, 0, 0),
					);
				} else {
					// Do NOT read `lastSnapshot` for an "after" figure. Pi's
					// getContextUsage() returns null right after compaction by design
					// (its estimate needs a fresh response), and the server's refreshed
					// snapshot arrives AFTER this event — so the snapshot in hand still
					// holds the PRE-compaction percent. Printing it read as "compacted ·
					// usage now 889%" on a turn that had just compacted from 889%.
					//
					// Drop our own stale copy too, so the header stops advertising a
					// context figure that no longer describes the session.
					if (lastSnapshot) lastSnapshot = { ...lastSnapshot, contextUsagePercent: null };
					// SAY WHAT IT FREED.
					//
					// "compacted · usage refreshes on the next reply" is honest about
					// the percentage being stale, and tells the operator nothing about
					// whether the compaction achieved anything — which is exactly how a
					// no-progress loop kept reporting success. The summarization's COST
					// cannot be priced (the provider reports no usage for it), but the
					// gateway measures what it RECLAIMED, so report that.
					const oc = (event as { outcome?: { freedTokens?: number; messagesBefore?: number; messagesAfter?: number; madeProgress?: boolean } }).outcome;
					const freedLine = oc
						? oc.madeProgress
							? `compacted · freed ${formatTokens(oc.freedTokens ?? 0)} tokens · ${oc.messagesBefore} → ${oc.messagesAfter} messages`
							: `compacted · reclaimed almost nothing (${oc.messagesBefore} → ${oc.messagesAfter} messages)`
						: "compacted · usage refreshes on the next reply";
					insertBeforeEditor(
						new Text(
							`  ${brand.amber("✓")} ${brand.dim(freedLine)}`,
							0,
							0,
						),
					);
					updateHeader();
				}
				break;
			}
			case "mid_turn_compaction_start": {
				// The turn is PAUSING to compact. Without this line the operator sees
				// a live tool loop stop dead for up to two minutes with no
				// explanation — indistinguishable from a hang, and the single most
				// likely reason someone kills a turn that was about to succeed.
				//
				// Say it is mid-turn and that the turn continues, because "compacting"
				// alone reads as "your conversation is being replaced".
				insertBeforeEditor(
					new Text(
						`${subIndent}  ${brand.dim(`⚡ context full mid-turn — compacting, the turn will continue…`)}`,
						0,
						0,
					),
				);
				break;
			}
			case "mid_turn_compaction_end": {
				const ev = event as {
					applied?: boolean;
					reason?: string;
					freedTokens?: number;
					messagesBefore?: number;
					messagesAfter?: number;
					durationMs?: number;
					errorMessage?: string;
				};
				if (ev.reason === "fallback-truncated") {
					// Summarization failed and we dropped the old prefix anyway, to
					// keep the turn alive. That is a LOSS, not a compaction, and
					// reporting it as "✓ compacted" would be the same unfalsifiable
					// claim this work exists to remove.
					insertBeforeEditor(
						new Text(
							`${subIndent}  ${brand.amber("!")} ${brand.dim(
								`summary unavailable — dropped ${formatTokens(ev.freedTokens ?? 0)} tokens of older context to keep the turn alive · full history kept on disk`,
							)}`,
							0,
							0,
						),
					);
				} else if (ev.applied) {
					const secs = ev.durationMs ? ` in ${Math.round(ev.durationMs / 100) / 10}s` : "";
					// SAY WHAT IT COST. A compaction on a full window is one of the
					// largest single model calls a harness makes, and of every harness
					// surveyed only Roo Code shows the operator a figure for it. We can
					// show one because the summarization runs on a session we own.
					const u = (
						event as {
							usage?: { cost?: number; costKnown?: boolean; input?: number; output?: number };
						}
					).usage;
					const costPart = u
						? u.costKnown && (u.cost ?? 0) > 0
							? ` · cost ${formatUsd(u.cost ?? 0)}`
							: u.costKnown
								? " · no charge"
								: " · cost unknown"
						: "";
					// The transcript is untouched — say so. This is the difference
					// between mid-turn compaction and Pi's `compact()`, and an operator
					// who thinks their history was just deleted will not trust it.
					insertBeforeEditor(
						new Text(
							`${subIndent}  ${brand.amber("✓")} ${brand.dim(
								`compacted${secs} · freed ${formatTokens(ev.freedTokens ?? 0)} tokens for this turn${costPart} · ${ev.messagesBefore} → ${ev.messagesAfter} messages sent · full history kept`,
							)}`,
							0,
							0,
						),
					);
				} else {
					// It declined or failed. Never silent: the turn is proceeding at
					// full size and may still overflow, and the operator should know
					// that is what happened rather than reading the failure as random.
					const why = ev.errorMessage
						? clipOneLine(scrubRenderable(ev.errorMessage), 80)
						: (ev.reason ?? "unknown");
					insertBeforeEditor(
						new Text(
							`${subIndent}  ${brand.dim(`compaction skipped (${why}) · continuing at full size`)}`,
							0,
							0,
						),
					);
				}
				break;
			}
			case "auto_retry_start": {
				// Pi auto-retries transient provider errors (rate limit, 5xx,
				// connection drop). Tell the user it's happening — without this,
				// a slow retry looks like the connection is just hanging.
				//
				// And say WHY. The event has carried `errorMessage` all along and we
				// dropped it, so a turn that died and restarted itself was reported as a
				// bare "retrying" — indistinguishable from a slow model. The reason is
				// the difference between "the provider hiccuped" and "your turn is being
				// killed and re-run from the top".
				const attempt = event.attempt ?? 1;
				const max = event.maxAttempts ?? 1;
				const waitS = Math.round((event.delayMs ?? 0) / 100) / 10;
				const why = clipOneLine(scrubRenderable(event.errorMessage ?? ""), 90);
				const because = why ? ` ${brand.dim(`· ${why}`)}` : "";
				insertBeforeEditor(
					new Text(
						`${subIndent}  ${brand.dim(`↻ retrying (attempt ${attempt}/${max}, waiting ${waitS}s)…`)}${because}`,
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
							`${subIndent}  ${brand.error("✗")} ${brand.error(`gave up after ${event.attempt} attempts`)}`,
							0,
							0,
						),
					);
				}
				break;
			}
			case "agent_end": {
				if (isChildTurn) {
					// The child is done. Its final text has already streamed; the parent's
					// `✓ spawn_agent` chip lands when the tool returns. Touch no parent state —
					// just close the child's section so the operator can see the seam.
					flushStreamingRender();
					// …except the spinner, which is a single shared widget. A loader armed by
					// the CHILD's last `tool_execution_end` would otherwise linger across the
					// seam and read as the parent thinking, until the parent's next paint.
					dismissLoader();
					insertBeforeEditor(
						new Text(`${subIndent}  ${brand.dim("↲ sub-agent done — back to the main agent")}`, 0, 0),
					);
					tui.requestRender();
					break;
				}
				isAgentRunning = false;
				// Tell the operator the turn is done, if it ran long enough that they
				// plausibly walked away. `turn_end` was an explicit no-op and a
				// six-minute turn finished in silence. Duration is read BEFORE the
				// start time is cleared.
				if (agentStartedAt != null) {
					notifyTurnComplete({
						durationMs: Date.now() - agentStartedAt,
						enabled: notifyOnComplete,
						isTty: Boolean(process.stderr.isTTY),
						summary: `${lastSnapshot?.agentName ?? "agent"} finished`,
					});
				}
				agentStartedAt = null;
				editor.disableSubmit = false;
				// A turn that ends mid-tool-call (error, refusal, abort) must not
				// strand a provisional "…writing call" row on screen.
				clearAllPendingToolArgs();
				liveOutputPanes.clear();
				// The turn is over; no message can still be streaming, so the
				// reconstruction buffers are dead. Without this the map grew for the
				// life of the connect process.
				deltaText.clear();
				deltaThinking.clear();
				activeAssistants.clear();
				// The turn just created the store entry a pre-turn `/rename` had
				// nothing to write to. Apply it now — but only if we are STILL on the
				// thread the name was typed for; the operator may have moved on.
				// Cleared either way: a queued name must not retry forever.
				if (pendingRename && pendingRename.sessionKey === (boundSessionKey ?? lastSnapshot?.sessionKey)) {
					const queued = pendingRename;
					pendingRename = undefined;
					void client
						.request("sessions.rename", { sessionKey: queued.sessionKey, name: queued.name })
						.then((r) => {
							const res = r as SessionRenameResult | undefined;
							if (res?.ok && res.name) {
								insertBeforeEditor(new Text(`  ${brand.amber("✓")} renamed to ${brand.white(scrubRenderable(res.name))}`, 0, 0));
							} else {
								// We PROMISED this name would land. Silence here left the
								// operator believing a rename happened that never did.
								insertBeforeEditor(
									new Text(`  ${brand.dim("could not name this thread — try /rename again")}`, 0, 0),
								);
							}
							tui.requestRender();
						})
						.catch(() => {
							insertBeforeEditor(
								new Text(`  ${brand.dim("could not name this thread — try /rename again")}`, 0, 0),
							);
							tui.requestRender();
						});
				}
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
				// These clear EVERY depth, not just this turn's. That is deliberate — a
				// child completes inside its parent's turn, so by the time the parent's
				// `agent_end` lands, the child's blocks and chips are finished artifacts.
				//
				// It is also the one asymmetry in the depth guard: the child cannot tear
				// down the parent, but the parent still tears down every depth. Safe only
				// because a sub-agent is fully awaited before the parent's turn ends —
				// `spawn_agent` awaits `runSubagent`, and `spawn_agents` awaits
				// `Promise.allSettled`. If a future fan-out lets a descendant's frames
				// arrive AFTER the parent's `agent_end`, that child would find its render
				// maps wiped, re-open a fresh block, and re-render its answer from the top:
				// exactly the bug the depth guard above exists to prevent. Gate these by
				// depth before shipping any detached sub-agent.
				pendingTools.clear();
				clearHarnessContinuations();
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
					`  ${brand.error("✗")} ${brand.error(describeError(err))}`,
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
	/**
	 * Files staged for the NEXT turn. Cleared once a turn actually ships, so an
	 * attachment can never silently ride a second, unrelated message — that
	 * failure mode is invisible to the operator and expensive (an 8 MiB image
	 * re-sent on every turn) so it's worth the explicit reset.
	 */
	let stagedAttachments: StagedAttachment[] = [];

	/**
	 * Attachments travel as PATHS, not bytes — which is what lets a 400 MB video
	 * cost nothing on the wire, but only works because the TUI and its gateway
	 * normally share a filesystem (the TUI auto-spawns one on 127.0.0.1).
	 *
	 * Against a REMOTE gateway (`brigade expose`, or an explicit `--host`), those
	 * paths mean nothing on the far side: every file would be rejected there, and a
	 * `prompt` response carries no payload to tell us so. The operator would watch
	 * their chips echo and get an answer that quietly ignored the file. Refusing at
	 * staging — loudly, with the reason — is the only honest option until the wire
	 * grows the `data` field that `PromptAttachment` documents.
	 */
	const gatewayIsLocal = ["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(gatewayHost);

	/**
	 * Repaint the always-visible attachment bar. Called after EVERY change to the
	 * staged list — staging, detaching, sending, switching context — so what the bar
	 * says and what will actually ride the next turn can never drift apart.
	 */
	const renderAttachBar = (): void => {
		if (stagedAttachments.length === 0) {
			attachBar.setText("");
			tui.requestRender();
			return;
		}
		const vision = lastSnapshot?.supportsVision;
		const chips = stagedAttachments
			.map((a, i) => {
				const blind = a.kind === "image" && vision === false;
				const mark = blind ? brand.error("⚠") : "";
				return `${brand.amber(`${i + 1}`)}${brand.dim(".")}${attachmentIcon(a.kind)} ${brand.white(a.fileName)} ${brand.dim(`(${formatAttachmentBytes(a.bytes)})`)}${mark}`;
			})
			.join(brand.dim(" · "));
		const n = stagedAttachments.length;
		const blindWarning =
			stagedAttachments.some((a) => a.kind === "image") && vision === false
				? ` ${brand.error("⚠ this model can't see images —")} ${brand.amber("/model")}`
				: "";
		attachBar.setText(
			`  ${brand.amber("📎")} ${brand.dim(`${n} attached:`)} ${chips}${blindWarning} ${brand.dim("· /detach to remove")}`,
		);
		tui.requestRender();
	};

	/** Verbose listing — only for an explicit bare `/attach`, which is a question. */
	const showTray = (): void => {
		renderAttachBar();
		if (stagedAttachments.length === 0) {
			insertBeforeEditor(new Text(`  ${brand.dim("no files staged.")}`, 0, 0));
			return;
		}
		// A staged image on a text-only model is the one genuinely confusing case:
		// the turn still "works" (the path note reaches the agent and it calls
		// `analyze_media`) but the model does NOT see the picture, and an operator
		// who doesn't know that reads the agent's tool-mediated description as
		// vision. Say so up front, while they can still `/model` out of it.
		//
		// Tri-state, deliberately. `supportsVision` is absent on a gateway older than
		// this feature — and such a gateway ignores `attachments` altogether, so the
		// file rides NOWHERE. Treating absent as "can see" would have us cheerfully
		// print "· seen inline" next to a file that was never sent at all, which is
		// the worst thing this tray could say. Unknown ⇒ claim nothing.
		const vision = lastSnapshot?.supportsVision;
		const blind = vision === false;
		const hasImage = stagedAttachments.some((a) => a.kind === "image");
		for (const [i, a] of stagedAttachments.entries()) {
			const inline = a.kind === "image" && vision === true ? brand.dim(" · seen inline") : "";
			const viaTool = a.kind !== "image" ? brand.dim(" · via analyze_media") : "";
			insertBeforeEditor(
				new Text(
					`  ${brand.amber(`${i + 1}.`)} ${attachmentIcon(a.kind)} ${brand.white(a.fileName)} ` +
						`${brand.dim(formatAttachmentBytes(a.bytes))}${inline}${viaTool}`,
					0,
					0,
				),
			);
		}
		if (hasImage && blind) {
			insertBeforeEditor(
				new Text(
					`  ${brand.error("⚠")} ${brand.dim(`${lastSnapshot?.modelName ?? "this model"} cannot see images — it will read the file with a tool instead. `)}${brand.amber("/model")}${brand.dim(" to switch to a vision model.")}`,
					0,
					0,
				),
			);
		}
	};

	/**
	 * Stage paths, reporting every one we refuse rather than dropping it silently.
	 *
	 * The count cap is enforced HERE and not left to the gateway, even though the
	 * gateway has one too. A `prompt` response carries no payload, so a gateway-side
	 * rejection has no route back to the operator — they would watch nine chips echo
	 * into their message and never learn that the ninth didn't travel. Refusing at
	 * the moment of staging is the only point at which we can actually say so.
	 */
	const stagePaths = (paths: readonly string[]): number => {
		if (!gatewayIsLocal) {
			insertBeforeEditor(
				new Text(
					`  ${brand.error("✗")} ${brand.dim(`can't attach files to a remote gateway (${gatewayHost}) — it can't read paths on this machine.`)}`,
					0,
					0,
				),
			);
			return 0;
		}
		let added = 0;
		for (const p of paths) {
			if (stagedAttachments.length >= MAX_STAGED_ATTACHMENTS) {
				insertBeforeEditor(
					new Text(
						`  ${brand.error("✗")} ${brand.dim(`${MAX_STAGED_ATTACHMENTS} files is the limit for one turn — `)}${brand.amber("/detach")}${brand.dim(" to make room. Not attached:")} ${nodePath.basename(p)}`,
						0,
						0,
					),
				);
				continue;
			}
			const att = stageAttachment(p);
			if (!att) {
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.dim("not a readable file:")} ${p}`, 0, 0),
				);
				continue;
			}
			if (stagedAttachments.some((s) => s.path === att.path)) continue; // already staged
			stagedAttachments.push(att);
			added++;
		}
		if (added > 0) renderAttachBar();
		return added;
	};

	/**
	 * THE send path. Every route that turns operator input into a `prompt` RPC goes
	 * through here — the normal submit AND the "nothing to steer" recovery below.
	 *
	 * It is one function on purpose. When there were two, the recovery path quietly
	 * lacked the attachment handling: it re-sent the text, dropped the staged files
	 * from that turn, left them armed for the next one, and updated `lastUserPrompt`
	 * without `lastUserAttachments` — so a later `/switch` would replay the NEW text
	 * carrying the PREVIOUS turn's files. Every one of those bugs was a consequence
	 * of the duplication, not of the logic.
	 */
	const sendTurn = async (rawText: string): Promise<void> => {
		// Capture files named IN the line itself — a `@path` completed by pi-tui's file
		// autocomplete, or the path a terminal pasted when a file was dropped on it.
		//
		// Skipped wholesale against a remote gateway: parsing there would rewrite the
		// path token to a basename (mangling the message) while `stagePaths` refused
		// the file — the worst of both outcomes. A remote operator's line goes through
		// untouched.
		const { text: cleanedText, staged: inlineStaged } = gatewayIsLocal
			? extractAttachmentPaths(rawText)
			: { text: rawText, staged: [] as StagedAttachment[] };
		if (inlineStaged.length > 0) stagePaths(inlineStaged.map((s) => s.path));

		const attachments = stagedAttachments;
		// Strip the visual `[image #1]` / `[file.pdf]` pills the paste handler dropped
		// into the line. They exist so the operator can SEE the attachment land; the
		// model gets the real thing (an inline image block, or the file's content), so
		// leaving the pill in the text would just be a confusing dangling reference.
		// Strip the visual pills the drop/paste handlers put in the line — `[image #1]`
		// for a clipboard bitmap, `[plant-cell.png]` for a dropped file. They exist so
		// the operator can SEE the attachment land; the model gets the real thing (the
		// image bytes, or the file's content), so leaving a bare filename in the prose
		// would just be a dangling reference to something already present.
		//
		// Deliberately allowed to end up EMPTY: dropping a file and pressing Enter with
		// no words is a legitimate turn — the attachment carries it. Falling back to the
		// raw line here would send the literal text "[plant-cell.png]" instead.
		// Each pill is removed WITH its own trailing space — never by collapsing
		// whitespace globally, which would wreck the indentation of a pasted code block
		// that happens to also carry an attachment.
		let outgoing = (cleanedText || rawText).replace(/\[image #\d+\][ \t]*/g, "");
		for (const a of attachments) {
			outgoing = outgoing.split(`[${a.fileName}] `).join("");
			outgoing = outgoing.split(`[${a.fileName}]`).join("");
		}
		outgoing = outgoing.trim();

		// `showTray` warns about a blind model when files are staged EXPLICITLY
		// (/attach, /paste). But the most natural flow — drag an image in and press
		// Enter — stages and sends in one breath and never opens the tray, so it would
		// miss the warning entirely and the operator would read the agent's
		// tool-mediated description as though the model had actually looked. Warn here
		// too. Non-blocking: the turn still goes (analyze_media reads the file); we
		// just refuse to let it look like vision when it isn't.
		if (attachments.some((a) => a.kind === "image") && lastSnapshot?.supportsVision === false) {
			insertBeforeEditor(
				new Text(
					`  ${brand.error("⚠")} ${brand.dim(`${lastSnapshot?.modelName ?? "this model"} cannot see images — reading the file with a tool instead. `)}${brand.amber("/model")}${brand.dim(" to switch to a vision model.")}`,
					0,
					0,
				),
			);
		}

		const chips =
			attachments.length > 0
				? ` ${brand.dim("·")} ${attachments.map((a) => `${attachmentIcon(a.kind)} ${a.fileName}`).join(" ")}`
				: "";
		insertBeforeEditor(new Markdown(`${brand.user("you")}  ${outgoing}${chips}`, 1, 0, markdownTheme));
		editor.setText("");
		// Unstage BEFORE the await so a file can never ride a second, unrelated turn.
		stagedAttachments = [];
		renderAttachBar();
		try {
			// Carry the connection's bound agentId when set so the gateway routes this
			// turn to that agent's session lane + runtime entry. Legacy single-agent
			// gateways receive the same boot agent the snapshot reported, so behaviour
			// is unchanged.
			//
			// Remember the message AND its files as the replay payload for a later
			// `/switch` (Carrow) handoff — replaying the text without the image would
			// defeat the commonest reason to switch (moving to a model that can see).
			lastUserPrompt = outgoing;
			lastUserAttachments = toPromptAttachments(attachments);
			await client.request(
				"prompt",
				withBinding({
					text: outgoing,
					// Omitted entirely when nothing is attached, so a plain text turn is
					// byte-identical on the wire to what a pre-attachment TUI sent.
					...(attachments.length > 0
						? { attachments: toPromptAttachments(attachments) }
						: {}),
				}),
				{ timeoutMs: 0 },
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0));
			// RE-STAGE on failure. The files never reached the gateway, and silently
			// discarding them would mean an operator who pasted an 8 MiB screenshot has
			// to go and paste it again — without being told that they must. Re-arming is
			// safe precisely because we say so.
			if (attachments.length > 0) {
				stagedAttachments = attachments;
				renderAttachBar();
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(`${attachments.length} file${attachments.length === 1 ? " is" : "s are"} still staged — resend when you're ready.`)}`,
						0,
						0,
					),
				);
			}
		}
	};

	/**
	 * Unstage everything on a context switch (`/new`, `/session`, `/agent`).
	 *
	 * A staged file belongs to the conversation the operator staged it IN. Carrying
	 * it across is worse than losing it: `/new` also clears the transcript region, so
	 * the chips scroll away while the files stay armed — and the image then rides the
	 * FRESH thread invisibly. `/agent research` would likewise hand a file staged for
	 * `main` to a different agent entirely. Announce the drop; never do it quietly.
	 */
	const clearTrayForContextSwitch = (what: string): void => {
		if (stagedAttachments.length === 0) return;
		const n = stagedAttachments.length;
		stagedAttachments = [];
		renderAttachBar();
		insertBeforeEditor(
			new Text(
				`  ${brand.dim(`unstaged ${n} file${n === 1 ? "" : "s"} — ${what} starts clean.`)}`,
				0,
				0,
			),
		);
	};

	/**
	 * Pull whatever is on the OS clipboard and stage it. Shared by Ctrl+V and `/paste`.
	 *
	 * Two DIFFERENT clipboard mechanisms, and we try both:
	 *   • a screenshot lives on the clipboard as raw BITMAP data with no file behind
	 *     it, so we spool the bytes to a temp PNG;
	 *   • a file copied in Explorer/Finder puts a FILE REFERENCE on the clipboard,
	 *     not its bytes — which is exactly why copy-pasting a 400 MB video is free
	 *     here: only the path moves.
	 *
	 * Files first: copying a file in Explorer ALSO exposes a thumbnail bitmap, and
	 * the operator meant the file, not its thumbnail.
	 */
	const pasteFromClipboard = async (opts?: { quiet?: boolean }): Promise<void> => {
		const before = stagedAttachments.length;
		// ONE read of the whole clipboard. This used to be up to four PowerShell spawns
		// in series — files, then image, then text, then formats — at 200-500 ms each,
		// which is exactly why a paste felt like it had hung. It is now a single
		// round-trip on a pipe that is already open.
		const { staged, reason } = await readClipboardAttachments();
		if (staged.length === 0) {
			if (!opts?.quiet && reason) {
				insertBeforeEditor(new Text(`  ${brand.dim(reason)}`, 0, 0));
			}
			return;
		}
		// Through `stagePaths`, not straight onto the array — otherwise a pasted image
		// would sidestep the count cap, the dedupe and the remote-gateway refusal that
		// every other route honours.
		stagePaths(staged.map((s) => s.path));

		// Drop a VISIBLE marker into the line you're typing, the way a chat client
		// shows an inline attachment pill. Without it, Ctrl+V looks like it did
		// nothing at all — the bytes are on the clipboard, there is no path to echo,
		// and the operator has no way to know the paste registered.
		for (let i = before; i < stagedAttachments.length; i++) {
			const a = stagedAttachments[i];
			if (!a) continue;
			editor.insertTextAtCursor(a.kind === "image" ? `[image #${i + 1}] ` : `[${a.fileName}] `);
		}
		tui.requestRender();
	};

	// In raw mode Ctrl+C (and Ctrl+D on an empty line) arrive as keypresses, never as
	// signals, so raise the signal ourselves and let `runConnectCommand`'s `onSigint`
	// do the rest: abort a running turn, or close and exit when the agent is idle.
	//
	// `process.emit`, not `process.kill(process.pid, "SIGINT")`: on Windows the latter
	// terminates instead of running the handler, turning "abort this turn" into "kill
	// the client mid-stream".
	/**
	 * Promote everything queued for this turn into immediate steering.
	 *
	 * Reports the count rather than a bare acknowledgement: "flushed" alone
	 * leaves the operator unsure whether it found anything, and the empty case
	 * is the one they most need told, since it means their messages already
	 * landed and the model has moved on.
	 */
	const flushQueuedMessages = async (): Promise<void> => {
		try {
			const res = (await client.request("flush-queue", withBinding({}))) as
				| { promoted?: number }
				| undefined;
			const n = res?.promoted ?? 0;
			insertBeforeEditor(
				new Text(
					n > 0
						? `  ${brand.amber("↳")} ${brand.dim(`flushed ${n} queued message${n === 1 ? "" : "s"} into the running turn`)}`
						: `  ${brand.dim("nothing queued — the model has already seen everything you sent")}`,
					0,
					0,
				),
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			insertBeforeEditor(new Text(`  ${brand.dim(`flush failed: ${msg}`)}`, 0, 0));
		}
		tui.requestRender();
	};

	editor.onInterrupt = () => {
		process.emit("SIGINT", "SIGINT");
	};

	// Ctrl+Enter / Cmd+Enter — steer instead of queue.
	//
	// Arms the one-shot flag and then submits through the SAME path a plain
	// Enter takes, so steering cannot drift from ordinary submit behaviour
	// (attachment handling, the echo, the stale-busy-flag recovery). Only fires
	// in terminals that can report the modifier; elsewhere `/steer` is the path,
	// which is what the first-touch hint says when it detects that.
	editor.onSteerSubmit = (): boolean => {
		// EMPTY DRAFT + the steer key = "flush what I already queued into the
		// running turn". DeepSeek's gesture, and the reason the empty case is a
		// distinct action rather than a no-op: having queued three messages, the
		// natural next thought is "actually, show it those now" — and there was
		// no way to say that without retyping them.
		//
		// Fire-and-forget: this handler is synchronous (it decides whether the
		// editor submits), and there is nothing to submit here.
		if (editor.getText().trim().length === 0) {
			if (isAgentRunning) void flushQueuedMessages();
			// Either way, an empty buffer never submits.
			return false;
		}
		// Nothing running means there is nothing to steer; submit as an ordinary
		// message rather than swallowing the keystroke. The operator did press
		// Enter, after all.
		if (isAgentRunning) steerNextSubmit = true;
		return true;
	};

	// Ctrl+V / Alt+V raw keystroke — reaches us only in terminals that DON'T bind
	// Ctrl+V to their own paste. See `BrigadeEditor.onImagePaste`.
	// Ctrl+T — show/hide reasoning. Same code path as `/reasoning`, so the key
	// and the command can never disagree about what the toggle means.
	editor.onToggleReasoning = () => {
		applyReasoningVisibility(!showThinking);
	};

	editor.onImagePaste = () => {
		void pasteFromClipboard({ quiet: false });
	};

	/**
	 * THE Ctrl+V image path, and the one that actually matters on Windows Terminal
	 * and VS Code — where the terminal handles Ctrl+V itself but still emits a paste
	 * EVENT (bracketed paste). This is precisely how Claude Code does it: react to the
	 * paste, read the clipboard, attach any image found.
	 *
	 * IMAGE ONLY, quiet, non-blocking:
	 *   • a plain TEXT paste already landed in the editor via the terminal — we must
	 *     not also stage anything from it here (a pasted file PATH is handled by
	 *     `onTextChanged`), so we look for an image and nothing else;
	 *   • quiet, because most pastes are text and "nothing to attach" on every paste
	 *     would be noise;
	 *   • non-blocking, so a normal text paste is never slowed by a clipboard read.
	 */
	editor.onPaste = () => {
		if (!gatewayIsLocal) return;
		void (async () => {
			try {
				const { staged } = await readClipboardAttachments();
				const img = staged.find((s) => s.kind === "image");
				if (!img) return;
				if (stagedAttachments.some((s) => s.path === img.path)) return;
				if (stagePaths([img.path]) === 0) return;
				insertBeforeEditor(
					new Text(
						`  ${brand.amber("📋")} ${brand.dim("image attached from your paste —")} ${brand.amber("/detach")} ${brand.dim("if you didn't mean to.")}`,
						0,
						0,
					),
				);
				tui.requestRender();
			} catch {
				/* a clipboard we can't read is not worth a word on a routine paste */
			}
		})();
	};

	/**
	 * AUTO-ATTACH a screenshot the moment it hits the clipboard.
	 *
	 * This is the answer to "I should just be able to paste, without a command",
	 * and it exists because Ctrl+V CANNOT be made to work: the terminal owns that
	 * key, its paste inserts the clipboard's TEXT, and a screenshot has no text — so
	 * it sends nothing and the application never sees a keystroke to hook. There is
	 * no byte to intercept.
	 *
	 * So we stop watching the keypress and watch the CLIPBOARD. Snip a screenshot
	 * and it is simply there, staged, pilled, visible in the bar — no key, no
	 * command. Which is less work than Ctrl+V would have been.
	 *
	 * It announces itself in the bar rather than attaching in silence: an image you
	 * copied for some entirely unrelated reason must not sneak into your next
	 * message without you noticing, and `/detach` is one word away.
	 */
	// Pre-boot the clipboard worker so the FIRST Ctrl+V is instant. The paste itself
	// does the attaching, via `editor.onPaste` above — this just means the worker is
	// already warm when that first paste arrives.
	if (gatewayIsLocal) warmClipboard();

	/**
	 * `/clipboard` — say exactly what Brigade sees, and which build is saying it.
	 *
	 * This exists because the single most expensive failure in this feature was not a
	 * bug: it was not knowing WHICH BUILD was running. The TUI is a thin client, the
	 * gateway is a long-lived daemon, and the globally-installed `brigade` is a third
	 * binary again — so "it doesn't work" and "it works on my machine" were both true
	 * at the same time, repeatedly, and we chased ghosts for hours.
	 *
	 * One command that prints the build stamp, whether the fast clipboard worker is
	 * alive, and what the clipboard actually holds, ends that whole class of argument.
	 */
	const showClipboardDiagnostics = async (): Promise<void> => {
		const build = getBuildInfo();
		const stamp = build.head ? `${build.version} (${build.head.slice(0, 7)})` : build.version;
		insertBeforeEditor(new Text(`  ${brand.dim("build   :")} ${brand.white(stamp)}`, 0, 0));
		insertBeforeEditor(
			new Text(
				`  ${brand.dim("gateway :")} ${brand.white(gatewayHost)} ${gatewayIsLocal ? brand.dim("(local — attachments enabled)") : brand.error("(remote — attachments disabled)")}`,
				0,
				0,
			),
		);
		insertBeforeEditor(new Text(`  ${brand.dim("reading clipboard…")}`, 0, 0));
		tui.requestRender();

		const started = Date.now();
		const { staged, reason } = await readClipboardAttachments();
		const ms = Date.now() - started;
		insertBeforeEditor(
			new Text(
				`  ${brand.dim("clipboard read in")} ${brand.white(`${ms} ms`)} ${brand.dim(ms > 800 ? "(slow — the fast worker did not start)" : "(fast worker)")}`,
				0,
				0,
			),
		);
		if (staged.length > 0) {
			for (const s of staged) {
				insertBeforeEditor(
					new Text(
						`  ${brand.amber("✓")} ${attachmentIcon(s.kind)} ${brand.white(s.fileName)} ${brand.dim(`${s.kind} · ${formatAttachmentBytes(s.bytes)}`)} ${brand.dim("— attachable")}`,
						0,
						0,
					),
				);
			}
			insertBeforeEditor(
				new Text(`  ${brand.dim("run")} ${brand.amber("/paste")} ${brand.dim("to attach.")}`, 0, 0),
			);
		} else {
			insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.dim(reason ?? "nothing attachable.")}`, 0, 0));
		}
		insertBeforeEditor(
			new Text(
				`  ${brand.dim("note: Ctrl+V works for images — Brigade reads the clipboard on the paste event your")}`,
				0,
				0,
			),
		);
		insertBeforeEditor(
			new Text(
				`  ${brand.dim("terminal sends, so a copied image attaches and pasted text still types.")} ${brand.amber("/paste")} ${brand.dim("is the same.")}`,
				0,
				0,
			),
		);
		tui.requestRender();
	};

	/**
	 * DRAG-AND-DROP, resolved the instant the file lands.
	 *
	 * A terminal answers a dropped file by pasting its PATH into stdin as text. The
	 * first version of this only noticed that path when the message was SUBMITTED —
	 * which meant you dropped a file and just… watched
	 * `C:\Users\me\Downloads\plant-cell.png` appear in the input box. Nothing staged,
	 * no bar, no pill, no reason to think it had worked. Deferred feedback is no
	 * feedback: an attachment has to become an attachment while you are still looking
	 * at it.
	 *
	 * So on every dropped/pasted chunk we re-read the line, stage any path that names
	 * a real file, and rewrite it in place as a `[plant-cell.png]` pill. The pill is
	 * stripped again at send (the model gets the real image bytes / file content, so
	 * a dangling filename in the prose would just be a confusing reference).
	 */
	let rewritingLine = false;
	editor.onTextChanged = () => {
		if (!gatewayIsLocal || rewritingLine) return;
		const line = editor.getText();
		if (!line) return;
		// Cheap pre-filter: a path needs a separator. Skips the regex + stat work on
		// the overwhelming majority of keystrokes, which are ordinary prose.
		if (!/[\\/]/.test(line)) return;
		// LIVE mode: length-capped, absolute-path-only. See the option's doc — this is
		// what stops a pasted log from costing 200-400 ms per keystroke, and stops a
		// typed `@mention` from silently attaching a cwd file while you type.
		const { text: pilled, staged } = extractAttachmentPaths(line, { pill: true, live: true });
		if (staged.length === 0) return;
		if (stagePaths(staged.map((s) => s.path)) === 0) return;
		// setText re-enters handleInput's change check; the flag keeps us from
		// re-scanning our own rewrite.
		rewritingLine = true;
		try {
			editor.setText(pilled);
		} finally {
			rewritingLine = false;
		}
		tui.requestRender();
	};

	editor.onSubmit = async (value: string) => {
		// RE-ENTRANCY GUARD. This handler is async — it awaits an RPC — so two
		// fast Enters can both pass the `isAgentRunning` gate and send the same
		// text twice. opencode carries a `submitting` flag for exactly this;
		// Cline's boolean-returning handler is the same fix after a
		// duplicate-execution bug. The flag is cleared in a `finally` so a throw
		// anywhere below cannot wedge the editor.
		if (submitInFlight) return;
		submitInFlight = true;
		// CONSUME THE STEER ARM HERE, unconditionally.
		//
		// It used to be cleared only inside the mid-turn branch, so any submit
		// that returned earlier — every slash command, an empty line — left it
		// armed. The next PLAIN Enter then inherited it and interrupted the model
		// mid-task: exactly the reflex-key mistake the queue/steer split exists to
		// prevent, reintroduced by the flag's lifetime. It also survived a thread
		// switch, arming a steer against a session the operator had left.
		const steerThisSubmit = steerNextSubmit;
		steerNextSubmit = false;
		try {
			await handleSubmit(value, steerThisSubmit);
		} finally {
			submitInFlight = false;
		}
	};

	const handleSubmit = async (value: string, steerThisSubmit = false): Promise<unknown> => {
		// SECURITY — scrub terminal escape sequences, leaked bracketed-paste markers,
		// and lone surrogates from input BEFORE it reaches command dispatch, the model
		// payload, or the echo. A hostile paste (or text the agent was told to copy
		// from a malicious page) can otherwise corrupt the terminal or smuggle control
		// bytes into the transcript. The single submit chokepoint covers every path.
		const trimmed = sanitizeTerminalInput(value).trim();
		// Up-arrow prompt recall. pi-tui's `Editor` ships the whole history stack
		// (`addToHistory` / `navigateHistory`, editor.js:218-330) and Brigade never
		// called the one method that fills it — so up-arrow recalled nothing and a
		// long prompt had to be retyped from scratch. Recorded on the sanitized
		// text so a hostile paste cannot smuggle control bytes back in via recall.
		if (trimmed) editor.addToHistory(trimmed);
		// Any line that is not a `/delete` disarms a pending confirmation. Without
		// this the armed key survived arbitrary intervening work, so repeating the
		// command an hour later — expecting the warning again — deleted on the
		// first Enter. Irreversible operations must not stay armed in the dark.
		if (!trimmed.startsWith("/delete")) disarmPendingDelete();
		// An empty line normally does nothing. The ONE exception is a wordless send of
		// staged files — "drop an image, press Enter" is a legitimate turn (the media
		// note alone is a valid prompt, and the agent describes what it sees).
		//
		// The two exclusions are not theoretical. Blank Enter while `pendingProviderEntry`
		// is armed would be consumed as THE API KEY and persisted as an empty
		// credential; blank Enter mid-turn would be sent as an empty `steer`. Both were
		// harmless no-ops before this exception existed, and both must stay no-ops.
		if (!trimmed && (stagedAttachments.length === 0 || pendingProviderEntry || isAgentRunning)) {
			return;
		}

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
						`- ${chalk.bold("/model <id>")} — switch this agent's model (every thread without a pin follows)\n` +
						`- ${chalk.bold("/model <id> --thread")} — pin THIS thread to a model, leaving the agent alone\n` +
						`- ${chalk.bold("/model --unpin")} — drop this thread's pin so it follows the agent again\n` +
						`- ${chalk.bold("/provider [<name>]")} — switch model provider, or add a new one with an API key (no arg = list)\n` +
						`- ${chalk.bold("/thinking <level>")} — set reasoning effort (off|minimal|low|medium|high|xhigh)\n` +
						`- ${chalk.bold("/compact")} — summarize older turns to free up context\n` +
					`- ${chalk.bold("/attach [<path>]")} — attach a file to the next turn (no arg = show staged files)\n` +
					`- ${chalk.bold("/paste")} — attach the image or file on your clipboard\n` +
					`  ${brand.dim("Ctrl+V just works: paste an image and it attaches, paste text and it types. /paste is the same,")}\n` +
					`  ${brand.dim("as a typed command.")}\n` +
					`- ${chalk.bold("/detach [<n>|all]")} — unstage an attached file\n` +
					`  ${brand.dim("…or just type")} ${chalk.bold("@path/to/file")} ${brand.dim("in your message, or drag a file onto the terminal.")}\n` +
						`- ${chalk.bold("/update")} — install a newer Brigade (sessions, memory and config are untouched)\n` +
						`- ${chalk.bold("/allow-all <on|off>")} — skip shell-approval prompts for this session (safety guards still apply)\n` +
						`- ${chalk.bold("/grant-skill <name> [--yes]")} — preview/approve a skill's declared commands so the agent runs them without asking\n` +
						`- ${chalk.bold("/revoke-skill <name>")} — remove a skill's granted commands\n` +
						`- ${chalk.bold("/abort")} — stop the in-flight turn\n` +
						`- ${chalk.bold("/usage")} — show token + cost totals for this session\n` +
						`- ${chalk.bold("/copy [code]")} — copy the last reply (or just its code block)\n` +
						`- ${chalk.bold("/expand [n]")} — show a truncated tool result in full (1 = most recent)\n` +
						`- ${chalk.bold("/search <query>")} — search this conversation, including tool results\n` +
						`- ${chalk.bold("/search --regex <pattern>")} — same, treating the query as a regular expression\n` +
						`- ${chalk.bold("/export [full]")} — write this transcript to a Markdown file (secrets redacted; \`full\` keeps whole tool results)\n` +
						`- ${chalk.bold("/rewind [n]")} — go back to one of your earlier messages (no arg = list; conversation only, never files)\n` +
						`- ${chalk.bold("/flush")} — send everything you queued to the running turn right now\n` +
						`- ${chalk.bold("/context")} — where this thread's context window is going\n` +
						`- ${chalk.bold("/steer <text>")} — redirect the running turn (or just type mid-turn)\n` +
						`- ${chalk.bold("/reasoning <on|off>")} — show/hide the model's reasoning, or press ctrl+t (default: on, remembered)\n` +
						`- ${chalk.bold("/new")} — start a fresh thread (new session, clean screen, no prior context)\n` +
						`- ${chalk.bold("/agent [<id>]")} — show/bind the connection's active agent\n` +
						`- ${chalk.bold("/session [<key>]")} — show/bind the connection's active session\n` +
						`- ${chalk.bold("/agents")} — list every agent the gateway knows about\n` +
						`- ${chalk.bold("/sessions [--all]")} — list live sessions (bound agent or all)\n` +
						`- ${chalk.bold("/rename [<name>]")} — name this thread (no argument clears the name)\n` +
						`- ${chalk.bold("/delete <session-key>")} — permanently delete a thread + transcript (repeat to confirm)\n` +
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
		// `/new` is how you deliberately start over — the same affordance as the
		// "new chat" button in Claude.ai / ChatGPT. `/sessions` lists threads,
		// `/session <key>` jumps back to one.
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
			// AFTER clearTranscriptRegion, or the notice is wiped along with the chips —
			// which is precisely the silent-carry this call exists to prevent.
			clearTrayForContextSwitch("the new thread");
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
			// Canonicalise, then tell the truth about what you just bound to.
			//
			// This took the key verbatim. The header shows a thread as `t-0bf7c8e1`, so
			// `/session t-0bf7c8e1` is the obvious thing to type — and it bound to a
			// LITERAL key of that name, not the canonical `agent:main:t-0bf7c8e1`. The
			// gateway created a brand-new empty session under it, the next message
			// ("please continue…") landed in a thread with no history, and a 16 MB
			// conversation was silently orphaned on disk.
			const agentForKey = boundAgentId ?? lastSnapshot?.agentId ?? DEFAULT_AGENT_ID;
			const target = arg.startsWith("agent:") ? arg : `agent:${agentForKey}:${arg}`;

			// A `/session` onto an unknown key is legal — that is how you name a new
			// thread — but it must never look like resuming an old one.
			let known: boolean | undefined;
			try {
				const res: unknown = await client.request(
					"sessions.list",
					boundAgentId !== undefined ? { agentId: boundAgentId } : {},
				);
				const list = Array.isArray(res)
					? (res as SessionListRow[])
					: ((res as { sessions?: SessionListRow[] }).sessions ?? []);
				known = list.some((s) => s.sessionKey === target);
			} catch {
				known = undefined; // gateway couldn't answer; claim nothing
			}

			boundSessionKey = target;
			clearTrayForContextSwitch("that thread");
			insertBeforeEditor(
				new Text(
					`  ${brand.amber("✓")} ${brand.dim("bound to session")} ${brand.amber(target)}`,
					0,
					0,
				),
			);
			if (known === false) {
				insertBeforeEditor(
					new Text(
						`    ${brand.amber("⚠")} ${brand.dim(
							"no thread with that key — this starts an EMPTY one. `/sessions` lists your threads.",
						)}`,
						0,
						0,
					),
				);
			}
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
						`  ${brand.error("✗")} ${brand.error(describeError(err))}`,
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

		// /delete <session-key> — delete a thread and its transcript.
		//
		// Requires an EXPLICIT key and a confirming repeat. Deletion is
		// irreversible and there is no agent tool for it, so the two frictions
		// are deliberate: no argument means the operator cannot fat-finger away
		// the thread they are sitting in, and the repeat means a key pasted from
		// `/sessions` is not executed on the first Enter.
		if (trimmed === "/delete" || trimmed.startsWith("/delete ")) {
			editor.setText("");
			// `/sessions` shows the short form (`t-c701aba6`) in its prominent column,
			// and `/session` accepts it — so `/delete` must too. Without this the
			// server's canonical-key guard rejected exactly the string the UI teaches,
			// after the operator had already confirmed twice.
			const deleteArg = trimmed === "/delete" ? "" : trimmed.slice("/delete ".length).trim();
			const agentForDelete = boundAgentId ?? lastSnapshot?.agentId ?? DEFAULT_AGENT_ID;
			const key = deleteArg && !deleteArg.startsWith("agent:")
				? `agent:${agentForDelete}:${deleteArg}`
				: deleteArg;
			if (!key) {
				insertBeforeEditor(
					new Text(
						`  ${brand.dim("usage: /delete <session-key> — deletes the thread AND its transcript, permanently")}\n  ${brand.dim("(`/sessions` lists the keys)")}`,
						0,
						0,
					),
				);
				pendingDeleteKey = undefined;
				return;
			}
			if (pendingDeleteKey !== key) {
				pendingDeleteKey = key;
				insertBeforeEditor(
					new Text(
						`  ${brand.error("!")} ${brand.dim("this permanently deletes")} ${brand.white(key)} ${brand.dim("and its transcript.")}\n  ${brand.dim("run the same command again to confirm")}`,
						0,
						0,
					),
				);
				return;
			}
			pendingDeleteKey = undefined;
			try {
				const res = (await client.request("sessions.delete", { sessionKey: key })) as SessionDeleteResult;
				if (!res?.ok) {
					insertBeforeEditor(
						new Text(`  ${brand.error("✗")} ${brand.error(res?.reason ?? "could not delete that session")}`, 0, 0),
					);
					return;
				}
				// An orphaned transcript is a disk leak the operator should hear about
				// — "deleted" must not quietly mean "mostly deleted".
				const note =
					res.transcriptRemoved === false
						? ` ${brand.dim("(entry removed; its transcript may still be on disk)")}`
						: "";
				const wasBound = (boundSessionKey ?? lastSnapshot?.sessionKey) === key;
				// The notice MUST come after any `clearTranscriptRegion()` below, which
				// removes every child between the divider and the editor — printing it
				// first wiped the "transcript may still be on disk" warning before it
				// painted. `/new` carries the same warning about this exact ordering.
				if (!wasBound) {
					insertBeforeEditor(new Text(`  ${brand.amber("✓")} deleted ${brand.white(key)}${note}`, 0, 0));
				}
				if (wasBound) {
					// Do NOT simply unbind: with no bound key the prompt handler falls
					// back to the BOOT session, so the next message would land in
					// `agent:main:main` with all its history — the opposite of what
					// deleting the thread you were in should do. Mint a fresh key, as
					// `/new` does.
					const agentForNext = boundAgentId ?? lastSnapshot?.agentId ?? DEFAULT_AGENT_ID;
					boundSessionKey = `agent:${agentForNext}:t-${randomUUID().slice(0, 8)}`;
					clearTranscriptRegion();
					insertBeforeEditor(new Text(`  ${brand.amber("✓")} deleted ${brand.white(key)}${note}`, 0, 0));
					insertBeforeEditor(
						new Text(`  ${brand.dim("moved to a new thread")} ${brand.amber(boundSessionKey)}`, 0, 0),
					);
					// The full context switch, matching `/new` / `/session` / `/agent`.
					// Omitting these left files staged for the DELETED thread armed to
					// upload into the new one, and the connection still subscribed to a
					// key that no longer exists — so the next turn streamed nothing.
					clearTrayForContextSwitch("the new thread");
					updateHeader();
					void applySubscription();
				}
				// A queued name for the deleted thread is dead regardless of whether we
				// were sitting in it — otherwise it lingers and can later retitle a
				// recreated thread with the same key.
				if (pendingRename?.sessionKey === key) pendingRename = undefined;
			} catch (err) {
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.error(describeError(err))}`, 0, 0),
				);
			}
			return;
		}

		// /rename [name] — name the thread you are in. No argument CLEARS the
		// name, so removing one is the same verb rather than a second command.
		// Naming is metadata, not activity: the gateway deliberately does not
		// touch `lastUsedAt`, so renaming never reorders the history.
		if (trimmed === "/rename" || trimmed.startsWith("/rename ")) {
			editor.setText("");
			// `String.trim()` does not strip C0 controls, so `/rename <ctrl>` looked
			// like a name here while the server's sanitizer reduced it to nothing and
			// CLEARED the existing name. Normalise with the same rules the server
			// applies so the branch below and the preview both match what is stored.
			const raw = sanitizeSessionName(trimmed === "/rename" ? "" : trimmed.slice("/rename ".length)) ?? "";
			const targetKey = boundSessionKey ?? lastSnapshot?.sessionKey;
			if (!targetKey) {
				insertBeforeEditor(
					new Text(`  ${brand.dim("no session bound yet — send a message first, or /session <key>")}`, 0, 0),
				);
				return;
			}
			try {
				const res = (await client.request("sessions.rename", {
					sessionKey: targetKey,
					name: raw,
				})) as SessionRenameResult;
				if (!res?.ok) {
					// The thread has no store entry yet — almost always a `/new` key.
					// Hold the name rather than dead-ending; the first turn creates the
					// entry and `agent_end` flushes it. Clearing (empty argument) has
					// nothing to hold: there is no name on a thread that does not exist.
					if (!raw) {
						pendingRename = undefined;
						insertBeforeEditor(new Text(`  ${brand.dim("nothing to clear — this thread has no name yet")}`, 0, 0));
						return;
					}
					pendingRename = { sessionKey: targetKey, name: raw };
					insertBeforeEditor(
						new Text(`  ${brand.amber("✓")} ${brand.dim("will name this thread")} ${brand.white(raw)} ${brand.dim("once you send a message")}`, 0, 0),
					);
					return;
				}
				// Supersede only a queue for THIS thread — a name waiting on a
				// different, not-yet-persisted thread was promised and must survive.
				if (pendingRename?.sessionKey === targetKey) pendingRename = undefined;
				insertBeforeEditor(
					new Text(
						res.name
							? `  ${brand.amber("✓")} renamed to ${brand.white(scrubRenderable(res.name))}`
							: `  ${brand.amber("✓")} ${brand.dim("name cleared")}`,
						0,
						0,
					),
				);
			} catch (err) {
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.error(describeError(err))}`, 0, 0),
				);
			}
			return;
		}

		// /sessions [--all] — list live (in-flight Pi) sessions. Defaults to
		// the bound agent's sessions; `--all` returns every agent's. Wave N5
		// (bug #9). Combine with /session <key> to bind to one of them.
		if (trimmed === "/sessions" || trimmed.startsWith("/sessions ")) {
			editor.setText("");
			const arg = trimmed === "/sessions" ? "" : trimmed.slice("/sessions ".length).trim();
			const wantsAll = /\b--?all\b/i.test(arg);
			let sessions: SessionListRow[];
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
						`  ${brand.error("✗")} ${brand.error(describeError(err))}`,
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
				// Show the name ALONGSIDE the derived label, never instead of it, and
				// quote it so it reads as operator-supplied data. `sessions_rename`
				// has no owner gate, so an untrusted channel peer can name their own
				// thread — replacing the label would let them make it render as e.g.
				// `Mom` in this picker. Scrubbed like every other gateway-pushed
				// string before it reaches the screen.
				const label = formatSessionLabel(s.sessionKey) ?? brand.dim("(home)");
				// This row is rendered through `Markdown`, and the name is operator- OR
				// channel-peer-supplied (`sessions_rename` has no owner gate). Escape
				// the metacharacters and the quote, or a name can style itself, emit a
				// link, or close the quoting and spoof the key / `← bound` marker.
				const named = s.displayName
					? scrubRenderable(s.displayName).replace(/[\\`*_[\]()"~|]/g, "\\$&")
					: undefined;
				const friendly = named ? `${label} ${brand.white(`"${named}"`)}` : label;
				const here = s.sessionKey === boundKey ? " " + brand.amber("← bound") : "";
				// The server has always sent state / last-activity / model / usage on
				// these rows; the TUI typed the response as a 3-field summary and threw
				// the rest away, so the picker could not say which thread was RUNNING,
				// when it last moved, or what it had cost.
				const running = s.state && s.state !== "idle" ? " " + brand.amber("● running") : "";
				const when = typeof s.updatedAt === "number" ? ` ${brand.dim(formatRelativeAge(s.updatedAt))}` : "";
				const model = s.pinnedModel ?? s.model;
				const modelTag = model ? ` ${brand.dim(`· ${model}${s.pinnedModel ? " (pinned)" : ""}`)}` : "";
				const spend =
					typeof s.estimatedCostUsd === "number" && s.estimatedCostUsd > 0
						? ` ${brand.dim(`· ${formatUsd(s.estimatedCostUsd)}`)}`
						: "";
				return `  ${brand.white(s.agentId ?? "?")}  ${friendly}  ${brand.dim(s.sessionKey)}${here}${running}${when}${modelTag}${spend}`;
			});
			const scopeLine = wantsAll
				? "live sessions (all agents):"
				: `live sessions for agent ${boundAgentId ?? lastSnapshot?.agentId ?? "main"}:`;
			insertBeforeEditor(
				new Markdown(
					`${brand.dim(scopeLine)}\n${lines.join("\n")}\n\n${brand.dim("usage: /session <key> to bind · /rename <name> to name this thread · /delete <key> to remove one · /mute <id|key> to unsubscribe")}`,
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
			clearTrayForContextSwitch(`agent ${arg}`);
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
						`  ${brand.error("✗")} ${brand.error(describeError(err))}`,
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
			applyReasoningVisibility(showThinking);
			return;
		}

		// /copy — put the last reply on the clipboard.
		//
		// OSC 52 rather than shelling out to pbcopy/clip.exe/wl-copy: the TERMINAL
		// owns the clipboard, so this is the only mechanism that works over SSH
		// and inside tmux, where a local binary would write to the REMOTE
		// machine's clipboard.
		if (trimmed === "/copy" || trimmed.startsWith("/copy ")) {
			editor.setText("");
			const arg = trimmed === "/copy" ? "" : trimmed.slice("/copy ".length).trim().toLowerCase();
			const wantCode = arg === "code" || arg === "block";
			const source = wantCode ? lastCodeBlock(lastReplyText) : lastReplyText;
			if (!source || !source.trim()) {
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(wantCode ? "no code block in the last reply" : "nothing to copy yet")}`,
						0,
						0,
					),
				);
				return;
			}
			const { sequence, bytes, truncated } = buildOsc52(source);
			try {
				process.stdout.write(sequence);
			} catch {
				/* a closed tty must not take down the session over a copy */
			}
			// Confirm explicitly: a terminal WITHOUT OSC 52 support discards the
			// sequence silently, so success can never be assumed.
			insertBeforeEditor(
				new Text(
					`  ${brand.dim(
						`copied ${wantCode ? "code block" : "reply"} (${bytes.toLocaleString()} bytes)${truncated ? " — truncated to fit" : ""}` +
							" · needs OSC 52 support (tmux: set-clipboard on)",
					)}`,
					0,
					0,
				),
			);
			tui.requestRender();
			return;
		}

		// /expand — recover a tool result the chip truncated.
		//
		// Previews are capped at 120 chars (800 for errors) and the remainder used
		// to be discarded on arrival, so a long command output, a diff, or a
		// web-search result's citations were gone the moment they rendered. The
		// full text is now retained per tool call; this is how you read it.
		if (trimmed === "/expand" || trimmed.startsWith("/expand ")) {
			editor.setText("");
			const withResults = [...toolCallInfo.entries()].filter(([, v]) => (v.result ?? "").trim().length > 0);
			if (withResults.length === 0) {
				insertBeforeEditor(new Text(`  ${brand.dim("no tool results to expand yet")}`, 0, 0));
				return;
			}
			// Newest first, so `/expand` with no argument means "the one I just saw".
			const newestFirst = withResults.reverse();
			const arg = trimmed === "/expand" ? "" : trimmed.slice("/expand ".length).trim();
			const idx = arg ? Number.parseInt(arg, 10) : 1;
			if (!Number.isFinite(idx) || idx < 1 || idx > newestFirst.length) {
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(`usage: /expand [1-${newestFirst.length}] — 1 is the most recent`)}`,
						0,
						0,
					),
				);
				return;
			}
			const entry = newestFirst[idx - 1]!;
			const info = entry[1];
			const head = `${info.isError ? brand.error("✗") : brand.tool("✓")} ${brand.tool(info.name)}${info.args ? ` ${brand.dim(info.args)}` : ""}`;
			insertBeforeEditor(new Text(`  ${head}`, 1, 0));
			// Scrubbed: a tool result is the most directly attacker-influenceable
			// text the TUI renders, and here it bypasses the preview's truncation.
			const body = scrubRenderable(info.result ?? "");
			const isDiff = looksLikeUnifiedDiff(body);
			// Cap the widget count. `insertBeforeEditor` splices a component per
			// line and pi-tui re-renders every child per frame, so expanding a
			// 20k-line build log would create 20k widgets via 20k splices and hang
			// the TUI. The preview exists to show what was cut, not to be a pager.
			const EXPAND_MAX_LINES = 500;
			const allLines = body.split("\n");
			const shownLines = allLines.slice(0, EXPAND_MAX_LINES);
			for (const line of shownLines) {
				if (!isDiff) {
					insertBeforeEditor(new Text(`      ${brand.dim(line)}`, 0, 0));
					continue;
				}
				// Colour by change kind so an edit reads as an edit. `brand.tool` is
				// the ✓ colour; the palette has no dedicated green.
				const kind = classifyDiffLine(line);
				const paint =
					kind === "add"
						? brand.tool
						: kind === "remove"
							? brand.error
							: kind === "hunk"
								? brand.amber
								: brand.dim;
				insertBeforeEditor(new Text(`      ${paint(line)}`, 0, 0));
			}
			if (allLines.length > EXPAND_MAX_LINES) {
				insertBeforeEditor(
					new Text(
						`      ${brand.dim(`… ${(allLines.length - EXPAND_MAX_LINES).toLocaleString()} more lines not shown`)}`,
						0,
						0,
					),
				);
			}
			tui.requestRender();
			return;
		}

		// /steer — redirect the turn that is already running.
		//
		// A bare mid-turn Enter steers too (the submit handler routes it), but the
		// explicit command is what the help line has always advertised, and it is
		// unambiguous when the operator is unsure whether a turn is still live.
		// /rewind — go back to an earlier point in the conversation.
		//
		// CONVERSATION ONLY. Files are named, never reverted. Every reported
		// failure in this space across the field is a file-restore failure —
		// `git clean -fd` deleting a gigabyte of files an agent had only READ
		// being the worst of them — and two projects (Codex, Amp) shipped file
		// rollback and then removed it, both now pointing users at git.
		if (trimmed === "/rewind" || trimmed.startsWith("/rewind ")) {
			editor.setText("");
			const arg = trimmed === "/rewind" ? "" : trimmed.slice("/rewind ".length).trim();
			try {
				// No argument → list. Nothing is mutated by the picker call.
				const listed = (await client.request(
					"sessions.rewind",
					withBinding({}),
				)) as SessionRewindResult;

				if (listed.blocked) {
					insertBeforeEditor(
						new Text(`  ${brand.error("✗")} ${brand.error(`cannot rewind: ${listed.blocked}`)}`, 0, 0),
					);
					tui.requestRender();
					return;
				}
				const targets = listed.targets ?? [];
				if (targets.length === 0) {
					insertBeforeEditor(
						new Text(`  ${brand.dim("nothing to rewind to yet — send a message first")}`, 0, 0),
					);
					tui.requestRender();
					return;
				}

				if (!arg) {
					insertBeforeEditor(
						new Text(`  ${brand.dim("rewind to which message?  /rewind <n>")}`, 0, 0),
					);
					for (const t of targets) {
						insertBeforeEditor(
							new Text(
								`  ${brand.dim(`#${t.ordinal}`)}  ${brand.dim(scrubRenderable(t.preview))}`,
								0,
								0,
							),
						);
					}
					insertBeforeEditor(
						new Text(
							`  ${brand.dim("↳ the conversation moves; your files are NOT reverted — use git for those")}`,
							0,
							0,
						),
					);
					tui.requestRender();
					return;
				}

				const n = Number.parseInt(arg, 10);
				const chosen = targets.find((t) => t.ordinal === n);
				if (!chosen) {
					insertBeforeEditor(
						new Text(`  ${brand.dim(`no message #${arg} — /rewind to see the list`)}`, 0, 0),
					);
					tui.requestRender();
					return;
				}

				const done = (await client.request(
					"sessions.rewind",
					withBinding({ entryId: chosen.entryId }),
				)) as SessionRewindResult;

				insertBeforeEditor(
					new Text(
						`  ${brand.amber("✓")} ${brand.dim(`rewound to #${chosen.ordinal} — ${done.abandoned ?? 0} entries are no longer on the active path (nothing was deleted)`)}`,
						0,
						0,
					),
				);
				// NAME the files, do not pretend to revert them. This is the honest
				// half of the contract and the reason the feature is safe to ship.
				const files = done.files ?? [];
				if (files.length > 0) {
					insertBeforeEditor(
						new Text(
							`  ${brand.amber("!")} ${brand.dim(`${files.length} file${files.length === 1 ? " was" : "s were"} written after that point and ${files.length === 1 ? "is" : "are"} NOT reverted:`)}`,
							0,
							0,
						),
					);
					for (const f of files.slice(0, 20)) {
						insertBeforeEditor(new Text(`     ${brand.dim(scrubRenderable(f))}`, 0, 0));
					}
					if (files.length > 20) {
						insertBeforeEditor(new Text(`     ${brand.dim(`… and ${files.length - 20} more`)}`, 0, 0));
					}
					insertBeforeEditor(
						new Text(`  ${brand.dim("↳ review them with `git diff`")}`, 0, 0),
					);
				}
				// Put the message back in the editor, so the operator can edit and
				// resend it — the affordance every harness with a picker provides.
				// Scrubbed again at the boundary. `previewOf` strips control bytes at
				// the source, but this string goes into the LIVE editor buffer, which
				// pi-tui re-emits every frame — the one place a miss repaints forever.
				editor.setText(scrubRenderable(chosen.preview));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(`rewind failed: ${msg}`)}`, 0, 0));
			}
			tui.requestRender();
			return;
		}

		// /search — find text in this conversation.
		//
		// There is deliberately no "jump to match": Brigade appends into the
		// terminal's own scrollback rather than owning a viewport, so there is no
		// cursor address for "eleven messages ago", and re-printing to fake one
		// would duplicate the conversation. Showing the matching lines is both
		// achievable and, for "what was that path", the more useful answer.
		if (trimmed === "/search" || trimmed.startsWith("/search ")) {
			editor.setText("");
			const q = trimmed === "/search" ? "" : trimmed.slice("/search ".length).trim();
			if (!q) {
				insertBeforeEditor(new Text(`  ${brand.dim("usage: /search <text>")}`, 0, 0));
				tui.requestRender();
				return;
			}
			try {
				const snap = await client.resume(withBinding());
				const messages = (snap?.messages ?? []) as WireMessage[];
				const { hits, truncated } = searchTranscript(messages, q);
				// A search that silently sees only a window is a false negative
				// dressed as an answer, so the scope is always stated.
				const windowed = messages.length >= RESUME_TRANSCRIPT_WINDOW;
				const scope = windowed
					? `the most recent ${messages.length} messages (earlier history not searched)`
					: `${messages.length} messages`;
				if (hits.length === 0) {
					insertBeforeEditor(
						new Text(`  ${brand.dim(`no matches for "${q}" in ${scope}`)}`, 0, 0),
					);
					tui.requestRender();
					return;
				}
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(`${hits.length}${truncated ? "+" : ""} match${hits.length === 1 ? "" : "es"} for "${q}"`)}`,
						0,
						0,
					),
				);
				for (const h of hits) {
					// Position in the conversation, so a hit can be located by eye in
					// the scrollback above.
					const where =
						h.where === "text"
							? h.role
							: h.where === "tool-call"
								? `→ ${h.toolName ?? "tool"}`
								: `← ${h.toolName ?? "tool"}`;
					const before = h.snippet.slice(0, h.matchStart);
					const hit = h.snippet.slice(h.matchStart, h.matchEnd);
					const after = h.snippet.slice(h.matchEnd);
					insertBeforeEditor(
						new Text(
							`  ${brand.dim(`#${h.index + 1} ${where}`)}  ${brand.dim(scrubRenderable(before))}${brand.amber(scrubRenderable(hit))}${brand.dim(scrubRenderable(after))}`,
							0,
							0,
						),
					);
				}
				if (truncated) {
					insertBeforeEditor(
						new Text(`  ${brand.dim("↳ more matches were found; narrow the search to see them")}`, 0, 0),
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(`search failed: ${msg}`)}`, 0, 0));
			}
			tui.requestRender();
			return;
		}

		// /export — write the conversation to a file.
		//
		// Read-only and client-side: the transcript comes from `resume`, which the
		// TUI already calls on connect, so there is no new RPC and no server state.
		// The file is REDACTED on the way out, because an export is a thing people
		// attach to bug reports and it is built out of raw tool output.
		if (trimmed === "/export" || trimmed.startsWith("/export ")) {
			editor.setText("");
			const arg = trimmed === "/export" ? "" : trimmed.slice("/export ".length).trim();
			const full = arg === "full";
			if (arg && !full) {
				insertBeforeEditor(new Text(`  ${brand.dim("usage: /export [full]")}`, 0, 0));
				tui.requestRender();
				return;
			}
			try {
				const snap = await client.resume(withBinding());
				const messages = (snap?.messages ?? []) as WireMessage[];
				if (messages.length === 0) {
					insertBeforeEditor(
						new Text(`  ${brand.dim("nothing to export — this session has no messages yet")}`, 0, 0),
					);
					tui.requestRender();
					return;
				}
				const at = new Date();
				const home = os.homedir();
				const rendered = renderTranscriptMarkdown(messages, {
					full,
					sessionKey: boundSessionKey,
					now: () => at,
					// Per-block redaction BEFORE truncation. A PEM key clipped at 2000
					// chars loses its END marker, and the rule that catches it stops
					// matching — so the default export leaked key material while the
					// banner said "no secrets matched". The whole-document pass below
					// still runs, for the count and as defence in depth.
					redact: (t) => redactForExport(t, { homeDir: home }).text,
				});
				const { text, counts, total } = redactForExport(rendered, { homeDir: home });
				const dir = nodePath.join(resolveStateDir(), "exports");
				// 0700 — the filenames embed session keys, so the directory listing is
				// itself information. Matches the convention used for other sensitive
				// dirs in this repo.
				await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
				const file = nodePath.join(dir, exportFileName(boundSessionKey, at));
				// 0600 — it is a conversation transcript, not world-readable content.
				await fs.promises.writeFile(file, text, { encoding: "utf8", mode: 0o600 });

				insertBeforeEditor(
					new Text(`  ${brand.amber("✓")} ${brand.dim(`exported ${messages.length} messages → ${file}`)}`, 0, 0),
				);
				// SAY SO WHEN THE WINDOW CLIPPED THE HEAD. `resume` returns at most
				// RESUME_TRANSCRIPT_MAX messages, so a long session exports a PARTIAL
				// transcript that otherwise reads as complete — attached to a bug
				// report, that is a misleading artifact.
				if (messages.length >= RESUME_TRANSCRIPT_WINDOW) {
					insertBeforeEditor(
						new Text(
							`  ${brand.amber("!")} ${brand.dim(`this is the most recent ${RESUME_TRANSCRIPT_WINDOW} messages — earlier history is not in the file`)}`,
							0,
							0,
						),
					);
				}
				// SAY WHAT WAS REDACTED, and say what that does not cover. A redactor
				// people over-trust is worse than one they check behind.
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(
							total > 0
								? `↳ redacted ${total} secret${total === 1 ? "" : "s"} (${describeRedactions(counts)}) — pattern matching, so read it before sharing`
								: "↳ no secrets matched — pattern matching only, so read it before sharing",
						)}`,
						0,
						0,
					),
				);
				if (!full) {
					insertBeforeEditor(
						new Text(`  ${brand.dim("↳ tool output was truncated; /export full keeps it whole")}`, 0, 0),
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(`export failed: ${msg}`)}`, 0, 0));
			}
			tui.requestRender();
			return;
		}

		// /flush — the universal form of the empty-draft Ctrl+Enter gesture, for
		// terminals that cannot encode the modifier at all (Terminal.app sends a
		// bare `\r` for Ctrl+Enter, indistinguishable from Enter).
		if (trimmed === "/flush") {
			editor.setText("");
			if (!isAgentRunning) {
				insertBeforeEditor(
					new Text(`  ${brand.dim("nothing is running — there is no turn to flush into")}`, 0, 0),
				);
				tui.requestRender();
				return;
			}
			await flushQueuedMessages();
			return;
		}

		if (trimmed === "/steer" || trimmed.startsWith("/steer ")) {
			editor.setText("");
			const text = trimmed === "/steer" ? "" : trimmed.slice("/steer ".length).trim();
			if (!text) {
				insertBeforeEditor(new Text(`  ${brand.dim("usage: /steer <text>")}`, 0, 0));
				return;
			}
			if (!isAgentRunning) {
				// Steering an idle session would silently vanish — the gateway has no
				// turn to inject into. Say so rather than swallowing the message.
				insertBeforeEditor(
					new Text(`  ${brand.dim("nothing is running — send it as a normal message instead")}`, 0, 0),
				);
				return;
			}
			try {
				// EXPLICIT steer. `/steer` is the universal path for terminals that
				// cannot encode Ctrl+Enter — Terminal.app and friends send a bare
				// `\r` for it, indistinguishable from Enter — so this command must
				// genuinely interrupt, not queue like a plain Enter now does.
				await client.request("steer", withBinding({ text, deliverAs: "steer" as const }));
				insertBeforeEditor(new Markdown(`${brand.user("you")}  ${text}`, 1, 0, markdownTheme));
				insertBeforeEditor(
					new Text(
						`  ${brand.amber("↳")} ${brand.dim("steering — the model sees this mid-turn, after the current tool finishes")}`,
						0,
						0,
					),
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				insertBeforeEditor(new Text(`  ${brand.dim(`steer failed: ${msg}`)}`, 0, 0));
			}
			tui.requestRender();
			return;
		}

		// /usage — render the cumulative usage block from the latest state
		// snapshot. All fields come from the server's SessionStateSnapshot
		// — no extra RPC needed.
		/**
		 * Provider consumption windows, one line each.
		 *
		 * Renders nothing at all when the provider reported none — "unknown" and
		 * "none left" are opposites, and a bar drawn from absent data claims a
		 * measurement that was never taken. Counts are shown only when present
		 * for the same reason: a missing `remaining` must not render as 0.
		 */
		const formatLimitLines = (windows: readonly ProviderLimitWindow[] | undefined): string[] => {
			if (!windows || windows.length === 0) return [];
			const out: string[] = [];
			for (const w of windows) {
				const parts: string[] = [];
				if (typeof w.remaining === "number" && typeof w.limit === "number") {
					parts.push(`${formatTokens(w.remaining)} of ${formatTokens(w.limit)} left`);
				} else if (typeof w.remaining === "number") {
					parts.push(`${formatTokens(w.remaining)} left`);
				}
				if (typeof w.usedFraction === "number") {
					parts.push(`${Math.round(w.usedFraction * 100)}% used`);
				}
				if (typeof w.resetsAt === "number") {
					const ms = w.resetsAt - Date.now();
					if (ms > 0) parts.push(`resets in ${formatElapsed(ms)}`);
				}
				const body = parts.length > 0 ? parts.join(" · ") : "reported, no counts";
				// `exhausted` is the one state a UI must never soften.
				const label = w.label || w.kind;
                const line = `${label}: ${body}`;
				out.push(w.status === "exhausted" ? brand.amber(`${line} — EXHAUSTED`) : brand.dim(line));
			}
			return out;
		};

		if (trimmed === "/context") {
			editor.setText("");
			const snap = lastSnapshot;
			if (!snap) {
				insertBeforeEditor(
					new Text(`  ${brand.dim("no snapshot yet — the server hasn't reported state")}`, 0, 0),
				);
				return;
			}
			// WHERE THE WINDOW IS GOING.
			//
			// Deliberately reports only what is actually MEASURED. A per-category
			// split (system prompt / tools / history) would be a better answer,
			// but the gateway does not measure those separately today and
			// inventing the split would be worse than admitting its absence —
			// this whole subsystem exists because confident wrong numbers are the
			// failure mode.
			const lines: string[] = [];
			if (snap.contextTokens != null && snap.contextWindow != null && snap.contextWindow > 0) {
				const used = snap.contextTokens;
				const win = snap.contextWindow;
				const pct = Math.round((used / win) * 100);
				const left = Math.max(0, win - used);
				// A 24-cell bar. Coarse on purpose: this answers "am I close?",
				// and a finer bar would imply a precision the estimate lacks.
				const filled = Math.max(0, Math.min(24, Math.round((used / win) * 24)));
				const bar = `${"█".repeat(filled)}${"░".repeat(24 - filled)}`;
				const colored = pct >= 75 ? brand.amber(bar) : brand.dim(bar);
				lines.push(`- ${chalk.bold("window:")}   ${colored} ${pct}%`);
				lines.push(
					`- ${chalk.bold("used:")}     ${formatTokens(used)} of ${formatTokens(win)} · ${formatTokens(left)} left`,
				);
			} else {
				lines.push(`- ${chalk.bold("window:")}   ${brand.dim("not reported yet — send a message first")}`);
			}
			lines.push(`- ${chalk.bold("messages:")} ${snap.messageCount} ${brand.dim("(user + assistant + tool results)")}`);
			const reasoningCtx = formatReasoningLine({ state: snap.reasoning });
			if (reasoningCtx) lines.push(`- ${chalk.bold("reasoning:")} ${reasoningCtx}`);
			lines.push(`- ${chalk.bold("compaction:")} ${brand.dim("automatic — older turns are summarized before the window fills")}`);
			const limitLines = formatLimitLines(snap.limits);
			if (limitLines.length > 0) {
				lines.push(`- ${chalk.bold("provider limits:")}`);
				for (const l of limitLines) lines.push(`    ${l}`);
			}
			lines.push(
				`  ${brand.dim("context is what the NEXT request sends; /usage shows all-time billing for this thread")}`,
			);
			insertBeforeEditor(new Markdown(`${brand.dim("context")}\n${lines.join("\n")}`, 0, 0, markdownTheme));
			return;
		}

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
			// Honest cost. `$0.0000` was printed for four different situations —
			// a cheap metered turn, a subscription with no marginal cost, local
			// inference, and an unpriced model that IS costing money.
			const costStr =
				formatCostSegment({
					billing: snap.billing,
					costUsd: snap.totalCostUsd,
					...(snap.costComplete !== undefined ? { costComplete: snap.costComplete } : {}),
				}) ?? "—";
			// Context as the pair, not a bare percent: "34k / 200k (17%)" answers
			// "how much room is left", which a percentage alone cannot.
			const ctxStr =
				snap.contextTokens != null && snap.contextWindow != null && snap.contextWindow > 0
					? `${formatTokens(snap.contextTokens)} / ${formatTokens(snap.contextWindow)}` +
						` (${Math.round((snap.contextTokens / snap.contextWindow) * 100)}%)`
					: snap.contextUsagePercent != null
						? `${Math.round(snap.contextUsagePercent)}%`
						: "—";
			const reasoningStrUsage = formatReasoningLine({ state: snap.reasoning });
			insertBeforeEditor(
				new Markdown(
					`${brand.dim("usage")}\n` +
						`- ${chalk.bold("model:")}    ${snap.provider ?? "?"} · ${snap.modelId ?? "?"}\n` +
						// `messageCount` counts user + assistant + toolResult messages,
						// so labelling it "turns" over-reported a 5-turn conversation
						// with tool use as ~40.
						`- ${chalk.bold("messages:")} ${snap.messageCount}\n` +
						// TWO DIFFERENT MEASUREMENTS, AND THEY LOOK CONTRADICTORY.
						//
						// `billed` is CUMULATIVE over the whole session, and `in`
						// counts input + cache reads + cache writes. Every turn
						// re-sends the entire history, so after 30 messages the sum
						// is several times the context window — while `context`
						// reports only what the NEXT request will send.
						//
						// Rendered unlabelled ("282,932 in … context: 68k") this
						// reads as a contradiction, and an operator reasonably
						// concludes one of the numbers is broken. Neither is. Say
						// which question each answers, in the line itself.
						`- ${chalk.bold("billed:")}   ${tokenTotal} tokens all-time this thread\n` +
						`  ${brand.dim(`${tokenIn} in (incl. cache reads) · ${tokenOut} out · every turn re-sends the history`)}\n` +
						`- ${chalk.bold("cost:")}     ${costStr}\n` +
						`- ${chalk.bold("context:")}  ${ctxStr}\n` +
						`  ${brand.dim("what the NEXT request sends — this is the one that can run out")}\n` +
						(reasoningStrUsage ? `- ${chalk.bold("reasoning:")} ${reasoningStrUsage}\n` : "") +
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

		/* ─── attachments ───────────────────────────────────────────────────
		 *
		 * These three MUST sit above the `isAgentRunning` steer gate below.
		 * Everything past that gate is unreachable while a turn is in flight — it
		 * gets queued at the model as chat text instead of running as a command. And
		 * "stage a file while the agent is working" is not an edge case, it is the
		 * natural rhythm: you watch it work, you see what it needs, you paste a
		 * screenshot. Below the gate, `/paste` would have been typed AT the model.
		 */

		// /attach [path] — no arg lists what's staged.
		if (trimmed === "/attach" || trimmed.startsWith("/attach ")) {
			editor.setText("");
			const arg = trimmed === "/attach" ? "" : trimmed.slice("/attach ".length).trim();
			if (!arg) {
				showTray();
				return;
			}
			// Reuse the submit-line parser so `/attach` accepts every shape a terminal
			// might hand us — quoted, escaped, `file://`, or bare. The arg is nothing
			// but a path, so the parser reads it as a "pure drop" and applies no
			// extension gate: `/attach` is explicit intent and takes ANY file.
			const { staged } = extractAttachmentPaths(arg);
			// Fallback for an unquoted path with spaces (`/attach C:\my files\a.png`),
			// which no token pattern can bound — but which, as the whole argument, is
			// unambiguous. Strip any wrapping the operator typed and take it verbatim.
			const bare = arg.replace(/^@/, "").replace(/^["'](.*)["']$/, "$1");
			const added = staged.length > 0 ? stagePaths(staged.map((s) => s.path)) : stagePaths([bare]);
			if (added > 0) showTray();
			return;
		}

		// /detach [n | all]
		if (trimmed === "/detach" || trimmed.startsWith("/detach ")) {
			editor.setText("");
			const arg = trimmed === "/detach" ? "" : trimmed.slice("/detach ".length).trim();
			if (!arg || arg === "all") {
				const n = stagedAttachments.length;
				stagedAttachments = [];
				renderAttachBar();
				insertBeforeEditor(
					new Text(`  ${brand.dim(`detached ${n} file${n === 1 ? "" : "s"}.`)}`, 0, 0),
				);
				return;
			}
			const idx = Number.parseInt(arg, 10);
			if (!Number.isInteger(idx) || idx < 1 || idx > stagedAttachments.length) {
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.dim(`no staged file #${arg}.`)}`, 0, 0),
				);
				return;
			}
			const [gone] = stagedAttachments.splice(idx - 1, 1);
			renderAttachBar();
			insertBeforeEditor(new Text(`  ${brand.dim(`detached ${gone?.fileName ?? ""}.`)}`, 0, 0));
			return;
		}

		// /clipboard — what does Brigade actually see, and which build is saying so.
		if (trimmed === "/clipboard" || trimmed === "/clip") {
			editor.setText("");
			await showClipboardDiagnostics();
			return;
		}

		// /paste — pull whatever is on the OS clipboard.
		//
		// Two DIFFERENT clipboard mechanisms, and we try both:
		//   - a screenshot lives on the clipboard as raw BITMAP data with no file
		//     behind it, so we spool the bytes to a temp PNG;
		//   - a file copied in Explorer/Finder puts a FILE REFERENCE on the
		//     clipboard, not its bytes — which is exactly why copy-pasting a 400 MB
		//     video is fine here: only the path moves.
		// Files first: when you copy a file in Explorer, Windows ALSO exposes a
		// thumbnail bitmap, and the operator meant the file, not its thumbnail.
		if (trimmed === "/paste") {
			editor.setText("");
			insertBeforeEditor(new Text(`  ${brand.dim("reading clipboard…")}`, 0, 0));
			await pasteFromClipboard();
			return;
		}

		// Mid-turn submit → QUEUE by default, STEER only on the deliberate gesture.
		//
		// ─────────────────────────────────────────────────────────────────────────
		// WHY ENTER QUEUES
		// ─────────────────────────────────────────────────────────────────────────
		// Steering injects text into a turn already in flight, changing a plan the
		// model is halfway through executing. A follow-up waits for a turn
		// boundary. One is recoverable, the other is not — so the irreversible one
		// does not go on the key the operator hits by reflex.
		//
		// Claude Code drains its queue "at the next LLM pause", which lands user
		// text in the middle of a plan; it has five open steering issues and a
		// documented docs-vs-behaviour bug from that ambiguity. Codex puts steer on
		// Enter and queue on Tab — the same two operations with the dangerous one
		// under the reflex finger. DeepSeek's harness splits them the way this
		// does.
		if (isAgentRunning) {
			editor.setText("");
			const deliverAs: "steer" | "followUp" = steerThisSubmit ? "steer" : "followUp";
			// A steer injects TEXT into a turn that is already running — there is no
			// place in that mechanism for a file. Staged attachments therefore stay
			// staged, and we SAY so. Saying so is the whole point: silently carrying
			// them into whatever the operator types next is the single worst behaviour
			// this feature could have, and it is what happened before these handlers
			// moved above the gate.
			if (stagedAttachments.length > 0) {
				const n = stagedAttachments.length;
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(`↳ steering can't carry files — your ${n} staged file${n === 1 ? "" : "s"} stay staged and will ride your next message.`)}`,
						0,
						0,
					),
				);
			}
			try {
				await client.request("steer", withBinding({ text: trimmed, deliverAs }));
				insertBeforeEditor(
					new Markdown(`${brand.user("you")}  ${trimmed}`, 1, 0, markdownTheme),
				);
				insertBeforeEditor(
					new Text(
						deliverAs === "steer"
							? `  ${brand.amber("↳")} ${brand.dim("steering — the model sees this mid-turn, after the current tool finishes")}`
							: `  ${brand.dim("↳ queued — the model will see this when the current turn finishes")}`,
						0,
						0,
					),
				);
				// FIRST-TOUCH HINT. Shown once per session, the first time a message
				// is queued mid-turn — the moment the operator is actually wondering
				// what just happened. Hermes does the same thing and it is the
				// cheapest good idea in this whole area: teach the split instead of
				// blocking the key or burying it in `/help`.
				//
				// It tells the truth about THIS terminal. `ctrl+enter` only resolves
				// through the kitty keyboard protocol or xterm modifyOtherKeys; in
				// Terminal.app it is byte-identical to Enter, so advertising the
				// keystroke there would send the operator chasing a key that cannot
				// work.
				if (!midTurnHintShown && deliverAs === "followUp") {
					midTurnHintShown = true;
					const kitty = isKittyProtocolActive();
					const steerGesture = kitty ? "Ctrl+Enter" : "/steer <text>";
					const flushGesture = kitty ? "Ctrl+Enter on an empty line" : "/flush";
					insertBeforeEditor(
						new Text(
							`  ${brand.dim(`↳ tip: Enter queues. ${steerGesture} interrupts the model mid-task; ${flushGesture} sends everything queued so far.`)}`,
							0,
							0,
						),
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("nothing to steer")) {
					// Stale busy flag — our lane has no live turn (it ended a beat
					// ago, or the busy signal came from another session before the
					// one-way snapshot rule existed). The operator's message must
					// never be lost: clear the flag and send it as a normal prompt.
					isAgentRunning = false;
					// Through the ONE send path — which echoes, attaches, clears the tray
					// and records the replay payload. Hand-rolling the `prompt` request
					// here is what silently dropped staged files from this turn while
					// leaving them armed for the next.
					await sendTurn(trimmed);
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

		// /update — the operator answered "yes" to the update notice.
		//
		// Runs the REAL updater in this process, not a detached child: the TUI owns the
		// terminal, so we hand it back first and let `brigade update` print its own npm
		// output. It restarts the gateway itself. Nothing under ~/.brigade is touched,
		// which is the thing the operator actually wants to know.
		if (trimmed === "/update") {
			editor.setText("");
			const upd = lastSnapshot?.updateAvailable;
			if (!upd) {
				insertBeforeEditor(
					new Text(`  ${brand.dim("You're on the latest published version.")}`, 0, 0),
				);
				tui.requestRender();
				return true;
			}
			tui.stop();
			process.stdout.write(
				`\n${chalk.hex("#E8B34A")("↑")} Updating Brigade ${upd.current} → ${upd.latest}\n` +
					`${chalk.dim(UPDATE_PRESERVES_MESSAGE)}\n` +
					`${chalk.dim("The gateway restarts when this finishes; reconnect with")} ${chalk.bold("brigade connect")}.\n\n`,
			);
			const code = await runUpdateCommand({});
			process.exit(code);
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
						`  ${brand.error("✗")} ${brand.error(describeError(err))}`,
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
						`  ${brand.error("✗")} ${brand.error(describeError(err))}`,
						0,
						0,
					),
				);
				return;
			}

			const rawArg = trimmed === "/model" ? "" : trimmed.slice("/model ".length).trim();
			// Scope flags. `/model <id>` stays AGENT-wide (every thread without a
			// pin of its own follows it, existing and future alike); `--thread`
			// pins just this thread; `--unpin` drops that pin so the thread
			// follows its agent again.
			const argTokens = rawArg.split(/\s+/).filter(Boolean);
			const flags = argTokens.filter((t) => t.startsWith("--"));
			const arg = argTokens.filter((t) => !t.startsWith("--")).join(" ");
			const wantsThread = flags.includes("--thread") || flags.includes("--session");
			const wantsUnpin = flags.includes("--unpin");
			// An unrecognised flag must NOT fall through to the agent-wide path —
			// a typo like `--thred` would silently move every thread instead of
			// the one the operator meant.
			const unknownFlag = flags.find(
				(f) => f !== "--thread" && f !== "--session" && f !== "--unpin",
			);
			if (unknownFlag) {
				insertBeforeEditor(
					new Text(
						`  ${brand.error(`✗ unknown option ${unknownFlag}`)} ${brand.dim("— usage: /model <id> [--thread] · /model --unpin")}`,
						0,
						0,
					),
				);
				return;
			}
			if (wantsUnpin) {
				try {
					const res = await client.request("clear-session-model", withBinding());
					insertBeforeEditor(
						new Text(
							res.cleared
								? `  ${brand.amber("✓")} ${brand.dim("this thread follows the agent again —")} ${brand.white(`${lastSnapshot?.provider ?? "?"} · ${lastSnapshot?.modelId ?? "?"}`)}`
								: `  ${brand.dim("this thread wasn't pinned — it already follows the agent.")}`,
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
			if (wantsThread && !arg) {
				insertBeforeEditor(
					new Text(
						`  ${brand.error("✗ --thread needs a model id")} ${brand.dim("— usage: /model <id> --thread")}`,
						0,
						0,
					),
				);
				return;
			}
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
				// `auto` (GitHub Copilot) leads the list and is ruled off from the
				// concrete ids below it — it's a different KIND of choice, and on a
				// plan that can't pick its own model it's the one that works.
				const body = currentModels
					.map((m) =>
						m.id === COPILOT_AUTO_MODEL_ID
							? `    ${brand.amber(m.id)}  ${brand.dim("— picks a model your plan allows")}\n    ${brand.dim("─".repeat(24))}`
							: `    ${brand.white(m.id)}`,
					)
					.join("\n");
				insertBeforeEditor(
					new Markdown(
						`${brand.dim("models on your current provider:")}\n\n  ${head}\n${body}\n\n${brand.dim("usage: /model <id>  ·  pin one thread: /model <id> --thread  ·  provider: /provider")}`,
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
					withBinding({
						provider: target.provider,
						modelId: target.id,
						scope: wantsThread ? ("session" as const) : ("agent" as const),
					}),
				);
				insertBeforeEditor(
					new Text(
						wantsThread
							? `  ${brand.amber("✓")} ${brand.dim("this thread pinned to")} ${brand.white(`${target.provider} · ${target.id}`)} ${brand.dim("— other threads unaffected; /model --unpin to undo")}`
							: `  ${brand.amber("✓")} ${brand.dim("switched to")} ${brand.white(`${target.provider} · ${target.id}`)}`,
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
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(describeError(err))}`, 0, 0));
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
					withBinding({
						provider: switchTarget.provider,
						modelId: switchTarget.id,
						replayMessage: lastUserPrompt,
						...(lastUserAttachments.length > 0
							? { replayAttachments: lastUserAttachments }
							: {}),
					}),
				);
				insertBeforeEditor(
					new Text(`  ${brand.amber("✓")} ${brand.dim("Carrow handoff →")} ${brand.white(`${switchTarget.provider} · ${switchTarget.id}`)}`, 0, 0),
				);
			} catch (err) {
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(describeError(err))}`, 0, 0));
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

		// Default — send as a prompt, through the ONE send path.
		await sendTurn(trimmed);
	};

	tui.requestRender();

	return {
		abort: () => {
			if (!isAgentRunning) return false;
			void client.request("abort", withBinding()).catch(() => {});
			isAgentRunning = false;
			agentStartedAt = null;
			editor.disableSubmit = false;
			clearAllPendingToolArgs();
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
			clearHarnessContinuations();
			insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.dim("aborted")}`, 0, 0));
			updateHeader();
			return true;
		},
		close: async () => {
			// The clipboard worker is a long-lived child process. Stop it on exit — a
			// process.on("exit") reaper is the backstop, but tearing it down here is the
			// clean path.
			stopClipboard();
			client.close();
		},
	};
}
