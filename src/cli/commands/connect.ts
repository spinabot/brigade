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

import { ProcessTerminal, TUI, Text, CancellableLoader, Editor } from "@mariozechner/pi-tui";
import chalk from "chalk";

// Brigade's `Markdown` is a thin Pi-TUI subclass that normalizes `_text_`
// italic spans to `*text*` so the renderer applies italic styling instead
// of leaking literal underscores. Same shape as Pi-TUI's `Markdown` — drop-in.
import { Markdown } from "../../ui/markdown.js";
import { renderBrandHeader } from "../../ui/brand.js";
import { restoreTerminal } from "../../ui/terminal-cleanup.js";
import { brand, editorTheme, markdownTheme } from "../../ui/theme.js";
import { BrigadeClient } from "../../tui/client.js";
import type { ModelSummary, SessionStateSnapshot } from "../../protocol.js";

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
	let activeAssistant: Markdown | null = null;
	let activeLoader: CancellableLoader | null = null;
	const pendingTools = new Map<string, Text>();

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
		const tail = extra ? ` · ${extra}` : "";
		const dot = isAgentRunning ? brand.amber("●") : brand.dim("○");
		header.setText(
			`  ${dot} ${brand.white("Brigade")}  ${brand.dim(`${provider} · ${modelId}${tokens}${cost}`)}${usageStr}${brand.dim(tail)}`,
		);
	};
	updateHeader();

	const editor = new Editor(tui, editorTheme);
	tui.addChild(editor);
	tui.setFocus(editor);

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
			brand.dim("  Enter to send · Ctrl+C abort · Ctrl+D quit · /model /thinking /compact /help"),
			0,
			0,
		),
	);

	type AnyChild = Text | Markdown | CancellableLoader | Editor;
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

	const extractAssistantText = (message: any): string => {
		if (!message || !Array.isArray(message.content)) return "";
		return message.content
			.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("");
	};

	// Auto-kickoff state. Mirrors openclaw's TUI behaviour: when we attach to
	// a fresh-bootstrap workspace (BOOTSTRAP.md on disk + IDENTITY.md has no
	// Name + no turn yet), auto-fire "Wake up, my friend!" as the first user
	// message. The gateway exposes `firstRunBootstrap` in the state snapshot
	// for exactly this — the TUI doesn't need to stat the workspace itself.
	//
	// Why client-side: matches openclaw's `setup.finalize.ts` → `tui.ts:898`
	// pattern (TUI auto-sends), and keeps the gateway agnostic to whether
	// any client is attached. A gateway booted with no client still doesn't
	// fire a kickoff into the void.
	//
	// Latch: once we fire (or once we see `messageCount > 0`), never fire
	// again. Survives reconnects gracefully — the latch is per-process, not
	// per-connection, so a Ctrl+C during the kickoff turn + restart of
	// `brigade connect` will see `messageCount > 0` and skip.
	let kickoffFired = false;
	const KICKOFF_MESSAGE = "Wake up, my friend!";

	// State snapshots from the gateway — every mutation pushes one.
	client.on("state", (snap) => {
		lastSnapshot = snap;
		isAgentRunning = snap.isAgentRunning;
		updateHeader();

		// Fire kickoff on the FIRST snapshot that meets all conditions:
		// fresh-bootstrap mode, no turn yet, agent idle (so we don't race a
		// reconnect mid-turn), and we haven't already fired this process.
		if (
			!kickoffFired &&
			snap.firstRunBootstrap &&
			snap.messageCount === 0 &&
			!snap.isAgentRunning
		) {
			kickoffFired = true;
			// Mirror the message into the transcript like a normal user turn so
			// the user sees what was sent (and why). Identical visual treatment
			// to the regular prompt path below.
			insertBeforeEditor(
				new Markdown(`${brand.user("you")}  ${KICKOFF_MESSAGE}`, 1, 0, markdownTheme),
			);
			// Fire-and-forget; the request resolves when the turn completes,
			// which we don't need to await — Pi events stream the reply.
			// Disable client-side timeout for the same reason as the manual
			// prompt path (see editor.onSubmit below).
			void client
				.request("prompt", { text: KICKOFF_MESSAGE }, { timeoutMs: 0 })
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					insertBeforeEditor(
						new Text(`  ${brand.error("✗")} ${brand.error(`kickoff failed: ${msg}`)}`, 0, 0),
					);
				});
		}
	});

	// Server-side warnings/info (e.g. "primary failed, trying fallback") — the
	// gateway emits these via the wrapper-chain callbacks. Mirror to the TUI
	// so the user sees the same context they would in `brigade chat`.
	client.on("log", (entry) => {
		const tone =
			entry.level === "error"
				? brand.error(`✗ ${entry.message}`)
				: entry.level === "warn"
					? brand.dim(`⚠ ${entry.message}`)
					: brand.dim(`↻ ${entry.message}`);
		insertBeforeEditor(new Text(`  ${tone}`, 0, 0));
	});

	// Pi events are forwarded as `{ event: <pi event> }`. Same render logic
	// as src/ui/chat.ts but stripped of in-process state mutations.
	client.on("pi", ({ event }: { event: any }) => {
		switch (event?.type) {
			case "agent_start": {
				isAgentRunning = true;
				editor.disableSubmit = true;
				updateHeader("thinking…");
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
				if (!activeAssistant) {
					activeAssistant = new Markdown(`${brand.agent(label)}  ${text}`, 1, 0, markdownTheme);
					insertBeforeEditor(activeAssistant);
				} else {
					activeAssistant.setText(`${brand.agent(label)}  ${text}`);
					tui.requestRender();
				}
				break;
			}
			case "tool_execution_start": {
				if (activeLoader) {
					removeChild(activeLoader);
					activeLoader = null;
				}
				const indicator = new Text(`  ${brand.tool("⚡")} ${brand.tool(event.toolName)}`, 0, 0);
				pendingTools.set(event.toolCallId, indicator);
				insertBeforeEditor(indicator);
				break;
			}
			case "tool_execution_end": {
				const indicator = pendingTools.get(event.toolCallId);
				if (indicator) {
					const mark = event.isError ? brand.error("✗") : brand.tool("✓");
					indicator.setText(`  ${mark} ${brand.tool(event.toolName)}`);
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
				editor.disableSubmit = false;
				activeAssistant = null;
				if (activeLoader) {
					removeChild(activeLoader);
					activeLoader = null;
				}
				updateHeader();
				break;
			}
		}
	});

	// Reconnect notifications — let the user know what just happened so a
	// dropped/restored gateway doesn't look like phantom output.
	client.on("reconnected" as any, () => {
		insertBeforeEditor(new Text(`  ${brand.dim("↻ reconnected to gateway")}`, 0, 0));
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
						`- ${chalk.bold("Ctrl+C")} — abort the current turn\n` +
						`- ${chalk.bold("Ctrl+D")} — quit\n\n` +
						brand.dim("To add a new provider, run `brigade onboard` on the gateway machine."),
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
				await client.request("steer", { text: trimmed });
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
				await client.request("compact", undefined, { timeoutMs: 0 });
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
				await client.request("set-model", { provider: target.provider, modelId: target.id });
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
				await client.request("set-thinking", { level: arg });
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
			await client.request("prompt", { text: trimmed }, { timeoutMs: 0 });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0));
		}
	};

	tui.requestRender();

	return {
		abort: () => {
			if (!isAgentRunning) return false;
			void client.request("abort").catch(() => {});
			isAgentRunning = false;
			editor.disableSubmit = false;
			if (activeLoader) {
				removeChild(activeLoader);
				activeLoader = null;
			}
			insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.dim("aborted")}`, 0, 0));
			updateHeader();
			return true;
		},
		close: async () => {
			client.close();
		},
	};
}
