// The Pi `StreamFn` for the claude-cli backend. It turns one Brigade turn into
// a `claude -p` subprocess invocation and maps the CLI's stream-json frames
// onto pi-ai's `AssistantMessageEventStream` — so `api: "claude-cli"` models
// dispatch through the agent loop exactly like a built-in provider, but the
// inference runs on the operator's Claude subscription via the vendor binary.
//
// v1 is CHAT-first + STATELESS: Brigade already replays the full conversation
// each turn (like its HTTP providers), so we serialize that transcript into the
// CLI's stdin prompt and run a fresh process per turn — no --resume/session
// binding, no MCP tool bridge. The event-emission shape mirrors
// `ollama-native/stream.ts` (one stable per-turn timestamp; start → text/
// thinking deltas → done | error).

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import {
	buildClaudeCliArgs,
	composeClaudeCliSystemPrompt,
	isStructuredJsonPrompt,
	CLAUDE_CLI_API,
	CLAUDE_CLI_PROVIDER,
} from "./catalog.js";
import { buildClaudeCliHttpMcpConfig, buildClaudeCliMcpConfig, readClaudeCliToolPlane } from "./tool-plane.js";
import { registerHarnessWatchdog, unregisterHarnessWatchdog } from "../harness/watchdog.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";

const log = createSubsystemLogger("claude-cli");
import { spawnClaudeCli, type SpawnClaudeCliArgs } from "./spawn.js";
import {
	classifyResultFrame,
	foldUsage,
	type AnthropicStreamEvent,
	type AssistantFrameMessage,
	type ResultFrame,
} from "./stream-json.js";

/* ─────────────────────────── prompt serialization ─────────────────────────── */

interface CtxMessage {
	role: string;
	content: unknown;
	toolName?: unknown;
}

/** Flatten a Pi content value (string | blocks[]) to plain text. */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (!block || typeof block !== "object") continue;
		const type = block.type;
		if (type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (type === "thinking" && typeof block.thinking === "string") {
			/* skip prior thinking — not replayed to the CLI */
		} else if (type === "image") parts.push("[image omitted]");
		else if ((type === "toolCall" || type === "tool_use") && typeof block.name === "string") {
			parts.push(`[called tool: ${block.name}]`);
		}
	}
	return parts.join("\n");
}

/**
 * Serialize the conversation into a single stdin prompt. The current (final)
 * user message is the live request; everything before it is rendered as a
 * labelled transcript so the CLI has the multi-turn context Brigade would
 * otherwise pass as a messages array. The system prompt travels separately via
 * `--append-system-prompt`, so it's not duplicated here.
 */
export function serializeConversationPrompt(messages: CtxMessage[]): string {
	const rendered: string[] = [];
	let lastUserText = "";
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;
		const text = contentToText(msg.content).trim();
		if (!text) continue;
		const isLast = i === messages.length - 1;
		if (msg.role === "user") {
			if (isLast) {
				lastUserText = text;
				continue;
			}
			rendered.push(`Human: ${text}`);
		} else if (msg.role === "assistant") {
			rendered.push(`Assistant: ${text}`);
		} else if (msg.role === "tool" || msg.role === "toolResult") {
			const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
			rendered.push(`[${name} result]: ${text}`);
		}
	}
	if (rendered.length === 0) return lastUserText;
	const history = rendered.join("\n\n");
	return lastUserText
		? `Conversation so far:\n\n${history}\n\n---\n\nCurrent message:\n\n${lastUserText}`
		: history;
}

/* ─────────────────────────── message builders ─────────────────────────── */

interface ModelDescriptor {
	api: string;
	provider: string;
	id: string;
}

function usageNoCost(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as Usage;
}

function buildShell(params: {
	model: ModelDescriptor;
	content: (TextContent | ThinkingContent)[];
	stopReason: StopReason;
	usage: Usage;
	timestamp: number;
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: params.content,
		api: params.model.api,
		provider: params.model.provider,
		model: params.model.id,
		usage: params.usage,
		stopReason: params.stopReason,
		...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
		timestamp: params.timestamp,
	} as AssistantMessage;
}

/* ─────────────────────────── the stream fn ─────────────────────────── */

/** A limit failure carries a message that Brigade's classifier maps to
 *  `subscription_limit` (see error-classifier SUBSCRIPTION_LIMIT_PATTERNS). */
const SUBSCRIPTION_LIMIT_MESSAGE =
	"Claude subscription usage limit reached (out of extra usage). The plan window resets on its own.";

/** A dead-login failure — actionable: the operator must re-authenticate. The
 *  wording hits the error-classifier's `auth` patterns AND tells the operator
 *  the exact fix. */
const CLAUDE_CLI_REAUTH_MESSAGE =
	"Claude sign-in expired or was revoked — the CLI backend can't authenticate. Run `brigade login claude-cli` to sign in again.";

/** Auth-shaped stderr from a non-zero exit (the binary couldn't authenticate). */
function isAuthShapedText(text: string): boolean {
	return /\b401\b|unauthori[sz]ed|authenticat(?:e|ion)|invalid[_ ]grant|token (?:expired|revoked|invalid)|refresh[_ ]token|(?:please )?(?:re-?)?login|not (?:logged|signed) in|credentials?/i.test(
		text,
	);
}

export interface CreateClaudeCliStreamFnOpts {
	/** Injectable spawn for tests. */
	spawnFn?: SpawnClaudeCliArgs["spawnFn"];
}

/**
 * Build the Pi `StreamFn` for claude-cli models. Reads `model`, `context`
 * (systemPrompt + messages), and `options` (signal), spawns the CLI, and fills
 * the returned event stream from the parsed frames.
 */
export function createClaudeCliStreamFn(opts: CreateClaudeCliStreamFnOpts = {}): StreamFn {
	return ((model: Model<string>, context: unknown, options: Record<string, unknown> | undefined) => {
		const stream = createAssistantMessageEventStream();
		const modelInfo: ModelDescriptor = {
			api: model.api ?? CLAUDE_CLI_API,
			provider: model.provider ?? CLAUDE_CLI_PROVIDER,
			id: model.id,
		};
		// ONE stable timestamp for the whole turn — the connect render identity-keys
		// an assistant block by `<depth>:<timestamp>`; a per-frame Date.now() would
		// render each token as a new line.
		const messageTimestamp = Date.now();

		const run = async (): Promise<void> => {
			let started = false;
			let textStarted = false;
			let textClosed = false;
			let thinkingStarted = false;
			let thinkingEnded = false;
			let accumulatedText = "";
			let accumulatedThinking = "";
			let usageInput = 0;
			let usageOutput = 0;
			let sawResult = false;
			let limitHit = false;
			let authHit = false;
			let errorText: string | undefined;
			let stopReason: StopReason = "stop";

			const partial = (): AssistantMessage => {
				const content: (TextContent | ThinkingContent)[] = [];
				if (accumulatedThinking) content.push({ type: "thinking", thinking: accumulatedThinking } as ThinkingContent);
				if (accumulatedText) content.push({ type: "text", text: accumulatedText } as TextContent);
				return buildShell({
					model: modelInfo,
					content,
					stopReason: "stop",
					usage: usageNoCost(usageInput, usageOutput),
					timestamp: messageTimestamp,
				});
			};
			const ensureStarted = () => {
				if (started) return;
				started = true;
				stream.push({
					type: "start",
					partial: buildShell({
						model: modelInfo,
						content: [],
						stopReason: "stop",
						usage: usageNoCost(0, 0),
						timestamp: messageTimestamp,
					}),
				});
			};
			const closeThinking = () => {
				if (!thinkingStarted || thinkingEnded) return;
				thinkingEnded = true;
				stream.push({ type: "thinking_end", contentIndex: 0, content: accumulatedThinking, partial: partial() });
			};
			const textIdx = () => (thinkingStarted ? 1 : 0);
			const closeText = () => {
				if (!textStarted || textClosed) return;
				textClosed = true;
				stream.push({ type: "text_end", contentIndex: textIdx(), content: accumulatedText, partial: partial() });
			};
			const onThinkingDelta = (delta: string) => {
				ensureStarted();
				if (!thinkingStarted) {
					thinkingStarted = true;
					stream.push({ type: "thinking_start", contentIndex: 0, partial: partial() });
				}
				accumulatedThinking += delta;
				stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: partial() });
			};
			const onTextDelta = (delta: string) => {
				if (thinkingStarted && !thinkingEnded) closeThinking();
				ensureStarted();
				if (!textStarted) {
					textStarted = true;
					stream.push({ type: "text_start", contentIndex: textIdx(), partial: partial() });
				}
				accumulatedText += delta;
				stream.push({ type: "text_delta", contentIndex: textIdx(), delta, partial: partial() });
			};

			const handleStreamEvent = (ev: AnthropicStreamEvent | undefined) => {
				if (!ev || typeof ev.type !== "string") return;
				switch (ev.type) {
					case "message_start": {
						const u = foldUsage(ev.message?.usage);
						// FIRST step only. Pi reads an assistant message's `usage.input` as
						// "how many tokens are in the context window right now"
						// (`calculateContextTokens` = input + output + cacheRead + cacheWrite)
						// and compacts when that crosses its threshold.
						//
						// The binary runs its OWN tool loop inside one turn, emitting a
						// message_start per internal step whose prompt has grown by its own
						// tool output. Only the FIRST step's prompt is the conversation
						// Brigade handed it — the context Pi owns and can actually compact.
						// Taking the last step (or the cumulative total) reports the binary's
						// private scratch space as our context.
						if (u.input && usageInput === 0) usageInput = u.input;
						break;
					}
					case "content_block_delta": {
						const d = ev.delta;
						if (!d) break;
						if (d.type === "text_delta" && typeof d.text === "string") onTextDelta(d.text);
						else if (d.type === "thinking_delta" && typeof d.thinking === "string") onThinkingDelta(d.thinking);
						break;
					}
					case "message_delta": {
						const u = foldUsage(ev.usage);
						if (u.output) usageOutput = u.output;
						break;
					}
					default:
						break;
				}
			};

			// If partial frames never arrive (older CLI), fall back to the complete
			// assistant block's text so the turn still yields content.
			const handleAssistantFrame = (msg: AssistantFrameMessage | undefined) => {
				if (!msg || accumulatedText) return;
				for (const block of msg.content ?? []) {
					if (block?.type === "text" && typeof block.text === "string" && block.text) {
						onTextDelta(block.text);
					}
				}
			};

			let handle: ReturnType<typeof spawnClaudeCli> | undefined;
			let watchdogToken = "";
			try {
				const ctx = (context ?? {}) as { systemPrompt?: string; messages?: CtxMessage[] };
				const prompt = serializeConversationPrompt(ctx.messages ?? []);
				// A structured (JSON-distiller) turn — the memory/skill utility subagents —
				// must be reinforced toward JSON, never nudged toward prose. Detected from
				// the pinned system prompt so this backend returns a clean envelope and the
				// memory extraction cursor can actually advance (see isStructuredJsonPrompt).
				// Brigade MCP tool-plane (memory/graph on the free-tier engine). THREE
				// gates, all load-bearing (see tool-plane.ts): the turn was stamped by the
				// agent loop (claude-cli dispatch only), the sender is the OWNER (the
				// bundled memory MCP server is owner-origin pinned — a peer turn gets
				// nothing), and the turn is NOT a structured distiller (those stay
				// tool-less on every backend). buildClaudeCliMcpConfig itself fails open
				// (undefined) when the CLI entry path or agent id can't be resolved safely.
				const toolPlane = readClaudeCliToolPlane(context);
				const mcpHttpUrl = toolPlane?.mcpHttpUrl;

				// A structured (JSON-distiller) turn — the memory/skill utility subagents —
				// must be reinforced toward JSON, never nudged toward prose, or the memory
				// extraction cursor can never advance (see isStructuredJsonPrompt).
				//
				// The DECLARATION decides. A stamped turn states what it is: distiller
				// sessions stamp `structured: true`, the agent loop stamps agent turns. The
				// prompt-text sniff is the fallback for an unstamped (cold) context only —
				// on an agent turn `ctx.systemPrompt` is the assembled persona, which
				// splices operator-authored files and skill descriptions in verbatim, so the
				// words "STRICT JSON only" in TOOLS.md would silently strip a chat turn's
				// entire tool-plane and leave an agent that "won't use its tools".
				const structured = toolPlane ? toolPlane.structured === true : isStructuredJsonPrompt(ctx.systemPrompt);
				// Precedence: a STRUCTURED distiller turn gets NO tools (every backend).
				// Otherwise, if the gateway registered this turn's FULL guarded surface,
				// hand the binary that loopback HTTP endpoint; else fall back to the owner
				// memory-only stdio server. Both fail open to undefined.
				const mcpConfigJson = structured
					? undefined
					: toolPlane?.mcpHttpUrl
						? buildClaudeCliHttpMcpConfig(toolPlane.mcpHttpUrl)
						: toolPlane?.senderIsOwner === true
							? buildClaudeCliMcpConfig(toolPlane.agentId)
							: undefined;

				const fullPlane = mcpConfigJson !== undefined && toolPlane?.mcpHttpUrl !== undefined;
				// Which surface did this turn actually get? Without this line a silent
				// fallback (no stamp, no gateway host, a rejected config) is invisible —
				// the operator only sees an agent that "won't use its tools".
				log.debug("spawn tool-plane", {
					mode: structured ? "none (distiller)" : fullPlane ? "full (http)" : mcpConfigJson ? "memory (stdio)" : "none",
					owner: toolPlane?.senderIsOwner === true,
					stamped: toolPlane !== undefined,
				});
				// A full-plane spawn denies EVERY built-in the binary ships: Brigade serves
				// guarded equivalents bound to the REAL cwd, while the binary's own would
				// act on the throwaway one it is sandboxed in.
				const args = buildClaudeCliArgs({ modelId: model.id, structured, fullPlane });
				// System prompt goes via a file (not argv) — see spawn.ts. Composed here so
				// the right nudge (prose vs JSON-only vs which tools) is included.
				const systemPrompt = composeClaudeCliSystemPrompt({
					systemPrompt: ctx.systemPrompt,
					structured,
					toolPlane: mcpConfigJson !== undefined,
					fullPlane,
				});

				handle = spawnClaudeCli({
					args,
					stdin: prompt,
					systemPrompt,
					...(mcpConfigJson !== undefined ? { mcpConfigJson } : {}),
					// The args above already denied every built-in. If the plane can't attach,
					// the model would have nothing to act with — fail the spawn instead.
					...(fullPlane ? { requireMcpConfig: true } : {}),
					signal: options?.signal as AbortSignal | undefined,
					spawnFn: opts.spawnFn,
				});

				// While the binary blocks on one of OUR tool calls it writes nothing to
				// stdout, so its liveness watchdogs would eventually kill a perfectly
				// healthy child for waiting on us (a `spawn_agent` runs a whole sub-agent
				// turn; `generate_video` has its own 20-minute budget). Publish the
				// child's pause control under this turn's tool-plane token so the MCP
				// route can suspend them for exactly that window. Full-plane turns only —
				// the memory-only stdio config carries no token.
				watchdogToken = mcpHttpUrl ? (/\/mcp\/([0-9a-f]{64})$/.exec(mcpHttpUrl)?.[1] ?? "") : "";
				if (watchdogToken) registerHarnessWatchdog(watchdogToken, { pause: handle.pause });

				for await (const frame of handle.frames) {
					switch (frame.type) {
						case "stream_event":
							handleStreamEvent((frame as { event?: AnthropicStreamEvent }).event);
							break;
						case "assistant":
							handleAssistantFrame((frame as { message?: AssistantFrameMessage }).message);
							break;
						case "result": {
							sawResult = true;
							const rf = frame as ResultFrame;
							const verdict = classifyResultFrame(rf);
							if (verdict === "limit") {
								limitHit = true;
							} else if (verdict === "auth") {
								authHit = true;
							} else if (verdict === "error") {
								errorText = extractResultError(rf);
							} else {
								// Success — if nothing streamed (no partials, no assistant
								// frame), surface the final result text.
								if (!accumulatedText && typeof rf.result === "string" && rf.result) {
									onTextDelta(rf.result);
								}
								const u = foldUsage(rf.usage);
								// The result frame's usage is CUMULATIVE over every internal
								// step of the binary's loop — with prompt caching, its
								// `cache_read_input_tokens` is re-counted on each one. It is a
								// BILLING total, never a context size: a 40-step turn on a
								// 39%-full transcript reported 1,756,936 input tokens, which Pi
								// read as 889% of a 200k window and "compacted" a healthy
								// session, twice, discarding real history each time.
								//
								// So it may only ever FILL IN a missing input (an older CLI that
								// streams no partial frames, where the run is a single step and
								// the cumulative total IS that step's prompt).
								if (u.input && usageInput === 0) usageInput = u.input;
								if (u.output) usageOutput = u.output;
							}
							break;
						}
						default:
							break; // system / rate_limit_event / partial — no-op
					}
				}

				const { code, killReason, stderr } = await handle.done;

				if (killReason === "aborted") {
					throw makeAbort();
				}
				if (killReason === "no-output-timeout" || killReason === "overall-timeout") {
					throw new Error(
						`claude-cli ${killReason}: the CLI produced no output for too long (it may be waiting on an interactive prompt).`,
					);
				}
				if (killReason === "absolute-ceiling") {
					// Phrased to avoid the word the error classifier reads as a transient
					// timeout: this turn ran for HOURS, so respawning it on the same model
					// would just start the next four. Classified `unknown` => not retried.
					throw new Error(
						"claude-cli exceeded its absolute run ceiling and was stopped. The turn kept calling tools without finishing.",
					);
				}
				if (limitHit) {
					throw new Error(SUBSCRIPTION_LIMIT_MESSAGE);
				}
				// Dead login — from a result frame OR an auth-shaped non-zero exit.
				// Actionable: tell the operator the exact re-auth command.
				if (authHit || (code !== 0 && code !== null && isAuthShapedText(stderr))) {
					throw new Error(CLAUDE_CLI_REAUTH_MESSAGE);
				}
				if (errorText) {
					throw new Error(`claude-cli error: ${errorText}`);
				}
				if (!sawResult) {
					// No terminal frame — spawn failure (binary missing) or a crash.
					// An auth-shaped stderr here is a dead login, not a missing binary.
					if (isAuthShapedText(stderr)) {
						throw new Error(CLAUDE_CLI_REAUTH_MESSAGE);
					}
					const hint =
						code === null
							? "the `claude` binary could not be started (is Claude Code installed and on PATH?)"
							: `the CLI exited (code ${code}) without a result`;
					const detail = stderr.trim() ? ` — ${stderr.trim().slice(0, 300)}` : "";
					throw new Error(`claude-cli produced no result: ${hint}${detail}`);
				}

				closeThinking();
				closeText();
				const finalContent: (TextContent | ThinkingContent)[] = [];
				if (accumulatedThinking) finalContent.push({ type: "thinking", thinking: accumulatedThinking } as ThinkingContent);
				if (accumulatedText) finalContent.push({ type: "text", text: accumulatedText } as TextContent);
				const message = buildShell({
					model: modelInfo,
					content: finalContent,
					stopReason,
					usage: usageNoCost(usageInput, usageOutput),
					timestamp: messageTimestamp,
				});
				stream.push({ type: "done", reason: stopReason, message });
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(errorMessage));
				stream.push({
					type: "error",
					reason: aborted ? "aborted" : "error",
					error: buildShell({
						model: modelInfo,
						content: accumulatedText ? [{ type: "text", text: accumulatedText } as TextContent] : [],
						stopReason: aborted ? "aborted" : "error",
						usage: usageNoCost(usageInput, usageOutput),
						timestamp: messageTimestamp,
						errorMessage,
					}),
				});
			} finally {
				// The child is gone; its pause control must not outlive it.
				if (watchdogToken) unregisterHarnessWatchdog(watchdogToken);
				stream.end();
			}
		};

		queueMicrotask(() => void run());
		return stream as AssistantMessageEventStream;
	}) as StreamFn;
}

function extractResultError(rf: ResultFrame): string {
	const raw = rf.error ?? rf.message ?? rf.result ?? rf.subtype ?? "unknown error";
	return typeof raw === "string" ? raw.slice(0, 300) : String(raw);
}

function makeAbort(): Error {
	const e = new Error("Request was aborted");
	e.name = "AbortError";
	return e;
}
