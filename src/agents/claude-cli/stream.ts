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

import { buildClaudeCliArgs, CLAUDE_CLI_API, CLAUDE_CLI_PROVIDER } from "./catalog.js";
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
						if (u.input) usageInput = u.input;
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
			try {
				const ctx = (context ?? {}) as { systemPrompt?: string; messages?: CtxMessage[] };
				const prompt = serializeConversationPrompt(ctx.messages ?? []);
				const args = buildClaudeCliArgs({ modelId: model.id, systemPrompt: ctx.systemPrompt });

				handle = spawnClaudeCli({
					args,
					stdin: prompt,
					signal: options?.signal as AbortSignal | undefined,
					spawnFn: opts.spawnFn,
				});

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
								if (u.input) usageInput = u.input;
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
