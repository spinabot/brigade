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
import { PI_TOOL_CALL, PI_TOOL_RESULT, WIRE_TOOL_USE } from "../pi-dialect.js";

import {
	buildClaudeCliArgs,
	composeClaudeCliSystemPrompt,
	isStructuredJsonPrompt,
	CLAUDE_CLI_API,
	CLAUDE_CLI_PROVIDER,
} from "./catalog.js";
import { BrigadeRetryError } from "../error-classifier.js";
import { hasBrigadeClaudeLogin, healClaudeKeychainShadow, readBrigadeClaudeCredential } from "./claude-config.js";
import { buildClaudeCliHttpMcpConfig, buildClaudeCliMcpConfig, readClaudeCliToolPlane } from "./tool-plane.js";
import { registerHarnessWatchdog, unregisterHarnessWatchdog } from "../harness/watchdog.js";
import { recordPlanLimit } from "./plan-limits.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";

const log = createSubsystemLogger("claude-cli");
import { spawnClaudeCli, type SpawnClaudeCliArgs } from "./spawn.js";
import {
	classifyResultFrame,
	foldUsage,
	mapStopReason,
	splitUsage,
	type RateLimitInfo,
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

/** An Anthropic image content block, the shape the CLI accepts on stream-json stdin. */
export interface ClaudeCliImageBlock {
	type: "image";
	source: { type: "base64"; media_type: string; data: string };
}

/**
 * Pull the image blocks out of the LAST user message.
 *
 * Only the last one: this backend replays prior turns as a flattened `Human:` /
 * `Assistant:` transcript, and re-sending every historical image on every turn
 * would re-bill and re-transmit the whole album each time the operator says
 * "and?". The current message is the one being asked about.
 *
 * Pi's `ImageContent` is `{ type:"image", data, mimeType }`; Anthropic wants
 * `{ type:"image", source:{ type:"base64", media_type, data } }`. This is the
 * only place the two shapes meet.
 */
export function collectPromptImages(messages: CtxMessage[]): ClaudeCliImageBlock[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "user") continue;
		if (!Array.isArray(msg.content)) return [];
		const out: ClaudeCliImageBlock[] = [];
		for (const block of msg.content as Array<Record<string, unknown>>) {
			if (!block || block.type !== "image") continue;
			const data = block.data;
			const mime = block.mimeType ?? block.media_type;
			if (typeof data !== "string" || !data) continue;
			out.push({
				type: "image",
				source: {
					type: "base64",
					media_type: typeof mime === "string" && mime ? mime : "image/png",
					data,
				},
			});
		}
		return out;
	}
	return [];
}

/**
 * Build the single stdin line for an image-carrying turn: one Anthropic user
 * message whose content is the flattened conversation text plus the image blocks.
 */
export function serializeStreamJsonPrompt(
	text: string,
	images: readonly ClaudeCliImageBlock[],
): string {
	const content: Array<Record<string, unknown>> = [];
	if (text.trim()) content.push({ type: "text", text });
	for (const img of images) content.push(img as unknown as Record<string, unknown>);
	return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
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
		else if ((type === PI_TOOL_CALL || type === WIRE_TOOL_USE) && typeof block.name === "string") {
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
		} else if (msg.role === "tool" || msg.role === PI_TOOL_RESULT) {
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

/**
 * Build a `Usage` for a claude-cli turn.
 *
 * TWO invariants, and they pull in opposite directions — hence the split.
 *
 * 1. CONTEXT MATH. Pi's `calculateContextTokens` is
 *    `usage.totalTokens || input + output + cacheRead + cacheWrite`. Because we
 *    always set `totalTokens` explicitly, the `||` short-circuits and the cache
 *    legs are never double-counted. `totalTokens` must stay EXACTLY the folded
 *    sum the inflation guard below reasons about — a 40-step turn once reported
 *    1,756,936 tokens, which Pi read as 889% of a 200k window and "compacted" a
 *    healthy session twice, destroying real history. Do not change this without
 *    re-reading the guard at the `result` frame.
 *
 * 2. REPORTING FIDELITY. `cacheRead`/`cacheWrite` were previously hardcoded to
 *    0 and folded into `input`, so the one backend where prompt caching
 *    dominates could never show it — and `input` meant a different quantity here
 *    than on the Pi-native providers. We now carry the legs separately and pass
 *    FRESH input in `input`, so the sum is identical and each field means what
 *    its name says.
 *
 * `costUsd` is the binary's own `total_cost_usd` from the result frame — the
 * real equivalent spend for the turn. `undefined` means "not reported", which
 * is NOT the same as zero; see `costKnown`.
 */
function buildUsage(parts: {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	costUsd?: number;
	/** Reasoning tokens the API reported. `undefined` = not reported, which is
	 *  NOT the same as zero and must never render as such. */
	reasoningTokens?: number;
}): Usage {
	const cacheRead = parts.cacheRead ?? 0;
	const cacheWrite = parts.cacheWrite ?? 0;
	const total = parts.input + cacheRead + cacheWrite + parts.output;
	const costKnown = typeof parts.costUsd === "number" && Number.isFinite(parts.costUsd);
	const costUsd = costKnown ? (parts.costUsd as number) : 0;
	return {
		input: parts.input,
		output: parts.output,
		cacheRead,
		cacheWrite,
		totalTokens: total,
		// The CLI reports ONE cumulative dollar figure for the whole turn, not a
		// per-leg split, so the legs stay 0 and only `total` is authoritative.
		// `costKnown` lets a renderer tell "this turn was free" (subscription,
		// genuinely $0 marginal) apart from "we have no cost signal" — a
		// distinction `cost.total === 0` alone cannot carry.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
		costKnown,
		// Carried as an extra field: Pi's `Usage` has no reasoning slot, and Pi
		// folds reasoning into `output` for its own providers. Brigade owns this
		// transport end to end, so it can report the breakdown no Pi provider can.
		...(typeof parts.reasoningTokens === "number" ? { reasoningTokens: parts.reasoningTokens } : {}),
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

/** A stale keychain shadow was masking a VALID Brigade login — now cleared. */
const CLAUDE_CLI_SHADOW_REPAIRED_MESSAGE =
	"A stale macOS keychain entry was shadowing Brigade's Claude login — cleared it and retried. No re-login needed.";

/**
 * Brigade's own credential is present and NOT expired, yet the binary refused
 * to authenticate. Re-running the login would rewrite the same good file and
 * change nothing, so do not send the operator down that path — say what we
 * actually know. On macOS this is the keychain shadow (already reconciled
 * above, so reaching here means something else owns the login); elsewhere the
 * binary is resolving a credential from somewhere other than our config dir.
 */
const CLAUDE_CLI_CREDENTIAL_IGNORED_MESSAGE =
	"Brigade's Claude credential is still valid, but the CLI rejected it — the binary is authenticating from somewhere other than Brigade's config dir. Re-running `brigade login claude-cli` will not help; check for another Claude login on this machine (`brigade doctor`).";

/**
 * A dead-login failure is not always a dead login. On macOS the binary reads its
 * credential from the login keychain, which OUTRANKS Brigade's managed
 * `.credentials.json`; a shadow the binary tombstoned on a failed refresh
 * (empty accessToken) makes every turn report "expired" while our credential is
 * still valid — and `brigade login claude-cli` cannot fix it, because it
 * rewrites the file the binary never reads.
 *
 * So before telling the operator to re-authenticate, reconcile the two stores.
 * Runs ONLY on the failure path (zero cost on a healthy turn). If we cleared a
 * tombstone, the credential we already hold is good and the next spawn will
 * bootstrap from it — say so instead of sending them through a pointless login.
 */
function claudeCliAuthFailure(): Error {
	try {
		if (hasBrigadeClaudeLogin() && healClaudeKeychainShadow() === "cleared") {
			// We repaired the actual cause, so this turn is recoverable: hand the
			// loop a classified retry rather than an error the operator must act on.
			// `auth_recovered` retries ONCE, in place, without rotating profile or
			// model — rotating would abandon the path we just fixed.
			return new BrigadeRetryError({
				message: CLAUDE_CLI_SHADOW_REPAIRED_MESSAGE,
				reason: "auth_recovered",
				provider: CLAUDE_CLI_PROVIDER,
			});
		}
	} catch {
		/* reconciliation is best-effort — fall through to the diagnosis below */
	}
	// Nothing to repair. Distinguish "the credential really is dead" (re-login
	// fixes it) from "the credential is fine and something else is answering"
	// (re-login is a dead end). Platform-agnostic on purpose: it holds wherever
	// the binary sources a login we did not write.
	try {
		const ours = readBrigadeClaudeCredential();
		const live =
			typeof ours?.accessToken === "string" &&
			ours.accessToken.length > 0 &&
			typeof ours.expiresAt === "number" &&
			ours.expiresAt > Date.now();
		if (live) return new Error(CLAUDE_CLI_CREDENTIAL_IGNORED_MESSAGE);
	} catch {
		/* fall through */
	}
	return new Error(CLAUDE_CLI_REAUTH_MESSAGE);
}

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
			// Cache legs, reported separately from `input` so a caller can see how
			// much of the prompt was reused. They do NOT change `totalTokens`.
			let usageCacheRead = 0;
			let usageCacheWrite = 0;
			// True once the FIRST step's prompt legs are recorded. The three-leg
			// spelling of the old `usageInput === 0` guard: the binary emits a
			// message_start per internal step, and only the first one's prompt is the
			// context Brigade owns.
			let promptCaptured = false;
			// The binary's own `total_cost_usd` for the turn. `undefined` until the
			// result frame reports it — deliberately not 0, so "free" and "unknown"
			// stay distinguishable all the way to the renderer.
			let turnCostUsd: number | undefined;
			// Reasoning tokens, when the relayed API frames report them. Anthropic
			// puts this on the FINAL message_delta, so it arrives late in the turn.
			let usageReasoning: number | undefined;
			let sawResult = false;
			let limitHit = false;
			let authHit = false;
			let errorText: string | undefined;
			let stopReason: StopReason = "stop";

			/** Usage as known RIGHT NOW — rides every partial, so a consumer that
			 *  reads `partial.usage` gets a live count instead of waiting for `done`. */
			const currentUsage = (): Usage =>
				buildUsage({
					input: usageInput,
					output: usageOutput,
					cacheRead: usageCacheRead,
					cacheWrite: usageCacheWrite,
					...(turnCostUsd !== undefined ? { costUsd: turnCostUsd } : {}),
					...(usageReasoning !== undefined ? { reasoningTokens: usageReasoning } : {}),
				});

			const partial = (): AssistantMessage => {
				const content: (TextContent | ThinkingContent)[] = [];
				if (accumulatedThinking) content.push({ type: "thinking", thinking: accumulatedThinking } as ThinkingContent);
				if (accumulatedText) content.push({ type: "text", text: accumulatedText } as TextContent);
				return buildShell({
					model: modelInfo,
					content,
					stopReason: "stop",
					usage: currentUsage(),
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
						usage: buildUsage({ input: 0, output: 0 }),
						timestamp: messageTimestamp,
					}),
				});
			};
			const closeThinking = () => {
				if (!thinkingStarted || thinkingEnded) return;
				thinkingEnded = true;
				stream.push({ type: "thinking_end", contentIndex: 0, content: accumulatedThinking, partial: partial() });
			};
			// PINNED at `text_start`, never recomputed. It used to be
			// `() => (thinkingStarted ? 1 : 0)` — a function of MUTABLE state. When a step
			// emitted text before ever thinking, and a LATER step opened a thinking block,
			// the same logical text block reported `text_start` at index 0 and its
			// `text_delta`/`text_end` at index 1. A consumer that keyed on `contentIndex`
			// would have torn the block in half.
			let textContentIndex = 0;
			const textIdx = () => textContentIndex;
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
					// Pin the index for the whole block: whether thinking preceded us is
					// settled NOW and cannot change under later steps.
					textContentIndex = thinkingStarted ? 1 : 0;
					stream.push({ type: "text_start", contentIndex: textIdx(), partial: partial() });
				}
				accumulatedText += delta;
				stream.push({ type: "text_delta", contentIndex: textIdx(), delta, partial: partial() });
			};

			/**
			 * Put a paragraph break between two text blocks of the same turn.
			 *
			 * Routed through `onTextDelta` so the break streams to the TUI like any other
			 * text — appending it straight to `accumulatedText` would leave the rendered
			 * block one delta behind the string we finally return.
			 *
			 * No-ops before any text, and when the text already ends in a blank line: the
			 * binary often closes a block with its own newlines and we must not stack them.
			 */
			const separateTextBlock = (): void => {
				if (!accumulatedText) return;
				if (/\n\s*\n$/.test(accumulatedText)) return;
				onTextDelta(accumulatedText.endsWith("\n") ? "\n" : "\n\n");
			};

			/**
			 * The same break between two THINKING blocks. Steps 2..N of the binary's own
			 * loop each open one, and without this the model's separate trains of thought
			 * fuse: "hmm" + "second thought" → "hmmsecond thought", in the transcript and in
			 * `/reasoning`.
			 *
			 * Appended straight to the accumulator rather than pushed as a `thinking_delta`:
			 * by the time a later thinking block opens, `thinking_end` has already been
			 * emitted, and adding another delta after it would make the stream more
			 * malformed, not less. `partial()` rebuilds its content from this accumulator on
			 * the next event either way, so the operator still sees it.
			 *
			 * On that malformation, deliberately left alone: because the binary runs several
			 * internal steps inside ONE Brigade turn, a later step's thinking deltas are
			 * emitted after we already sent `thinking_end`. The event LABELS are therefore
			 * out of order. The payloads are not, and only the payloads are read — Pi's loop
			 * treats every block event identically (`partialMessage = event.partial`) and
			 * takes the final message from `response.result()` (pi-agent-core/dist/
			 * agent-loop.js:196-240). Re-indexing the blocks to satisfy a consumer that
			 * doesn't exist would be risk without benefit.
			 */
			const separateThinkingBlock = (): void => {
				if (!accumulatedThinking) return;
				if (/\n\s*\n$/.test(accumulatedThinking)) return;
				accumulatedThinking += accumulatedThinking.endsWith("\n") ? "\n" : "\n\n";
			};

			const handleStreamEvent = (ev: AnthropicStreamEvent | undefined) => {
				if (!ev || typeof ev.type !== "string") return;
				switch (ev.type) {
					case "message_start": {
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
						//
						// The prompt legs are captured SPLIT (fresh / cacheRead / cacheWrite)
						// rather than folded, so the turn can report how much was cached. The
						// first-step-only rule is unchanged — `promptCaptured` is just the
						// three-leg spelling of the old `usageInput === 0`.
						if (!promptCaptured) {
							const legs = splitUsage(ev.message?.usage);
							if (legs.input || legs.cacheRead || legs.cacheWrite) {
								usageInput = legs.input;
								usageCacheRead = legs.cacheRead;
								usageCacheWrite = legs.cacheWrite;
								promptCaptured = true;
							}
						}
						break;
					}
					case "content_block_start": {
						// A NEW text block opens. The binary runs its own tool loop, so one
						// Brigade turn is many internal steps, each with its own text blocks —
						// "…let me look." → tool_use → "Good, real assets:". We accumulate them
						// all into one string, and without a separator here the two sentences
						// fuse: "let me look.Good, real assets:". Every screenshot of a
						// tool-using turn was littered with them.
						//
						// A blank line, not a space: these are separate utterances, one before
						// the model acted and one after. Markdown renders them as paragraphs,
						// which is what they are.
						if (ev.content_block?.type === "text") separateTextBlock();
						else if (ev.content_block?.type === "thinking") separateThinkingBlock();
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
						// Anthropic reports the reasoning breakdown on the final
						// message_delta only, so take it whenever it appears.
						const legsDelta = splitUsage(ev.usage);
						if (legsDelta.reasoning !== undefined) usageReasoning = legsDelta.reasoning;
						// Anthropic puts the terminating reason here. Without this the
						// backend reported every turn as a clean "stop", so a response
						// truncated at the output cap looked finished and the agent loop's
						// auto-continuation never fired.
						const mapped = mapStopReason(ev.delta?.stop_reason);
						if (mapped) stopReason = mapped;
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
						// Separate here too. A frame can carry several text blocks, and the
						// streaming path would have put a paragraph break between them — this
						// fallback (an older CLI that emits no partial frames) must not render
						// "block1block2" where the streaming path renders two paragraphs.
						separateTextBlock();
						onTextDelta(block.text);
					}
				}
			};

			let handle: ReturnType<typeof spawnClaudeCli> | undefined;
			let watchdogToken = "";
			try {
				const ctx = (context ?? {}) as { systemPrompt?: string; messages?: CtxMessage[] };
				const prompt = serializeConversationPrompt(ctx.messages ?? []);
				// Images on THIS turn. Plain-text stdin has nowhere to put them — which is
				// why the flattener used to replace an attached photo with the literal
				// "[image omitted]" and the backend declared itself text-only. It isn't:
				// `--input-format stream-json` carries real Anthropic content blocks and the
				// model sees the picture. Empty for every text turn, which then takes the
				// unchanged plain-text path.
				const promptImages = collectPromptImages(ctx.messages ?? []);
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
				const args = buildClaudeCliArgs({
					modelId: model.id,
					structured,
					fullPlane,
					// Pi puts the turn's thinking level on `options.reasoning` — the
					// same field `ollama-native` reads to derive its `think` flag.
					...(typeof options?.reasoning === "string" ? { thinkingLevel: options.reasoning } : {}),
					...(promptImages.length > 0 ? { streamJsonInput: true } : {}),
				});
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
					// A JSON content-block line when the turn carries an image; otherwise the
					// byte-identical plain-text stdin every turn has always used.
					stdin:
						promptImages.length > 0
							? serializeStreamJsonPrompt(prompt, promptImages)
							: prompt,
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
								// The binary's OWN dollar figure for the whole turn. This is the
								// only cost signal a subscription backend gets — there is no
								// per-token price to compute from — and it was parsed into a
								// typed field and never read, which is why every claude-cli turn
								// reported $0.0000 regardless of what it actually consumed.
								// Cumulative over internal steps, which is exactly right for a
								// turn total (unlike the token counts guarded below).
								if (typeof rf.total_cost_usd === "number" && Number.isFinite(rf.total_cost_usd)) {
									turnCostUsd = rf.total_cost_usd;
								}
								const rfLegs = splitUsage(rf.usage);
								if (rfLegs.reasoning !== undefined && usageReasoning === undefined) {
									usageReasoning = rfLegs.reasoning;
								}
								const rfStop = mapStopReason(rf.stop_reason);
								if (rfStop) stopReason = rfStop;
								// The result frame's usage is CUMULATIVE over every internal
								// step of the binary's loop — with prompt caching, its
								// `cache_read_input_tokens` is re-counted on each one. It is a
								// BILLING total, never a context size: a 40-step turn on a
								// 39%-full transcript reported 1,756,936 input tokens, which Pi
								// read as 889% of a 200k window and "compacted" a healthy
								// session, twice, discarding real history each time.
								//
								// So it may only ever FILL IN a missing value (an older CLI that
								// streams no partial frames, where the run is a single step and
								// the cumulative total IS that step's usage).
								//
								// BOTH fields, symmetrically. `output_tokens` on this same frame is
								// just as cumulative as `input_tokens` — every step's generation,
								// tool-call JSON included — and `calculateContextTokens` is
								// `input + output`. Guarding only the input left the other half of
								// the very inflation this guard exists to prevent.
								if (!promptCaptured) {
									const legs = splitUsage(rf.usage);
									if (legs.input || legs.cacheRead || legs.cacheWrite) {
										usageInput = legs.input;
										usageCacheRead = legs.cacheRead;
										usageCacheWrite = legs.cacheWrite;
										promptCaptured = true;
									}
								}
								if (u.output && usageOutput === 0) usageOutput = u.output;
							}
							break;
						}
						case "rate_limit_event": {
							// Plan-window telemetry. On a subscription backend this is the
							// ONLY consumption signal that exists — there is no per-token
							// price — so dropping it left the operator with neither a cost
							// figure nor a quota figure, unable to tell a healthy session
							// from one about to be cut off mid-turn.
							recordPlanLimit((frame as { rate_limit_info?: RateLimitInfo }).rate_limit_info);
							break;
						}
						default:
							break; // system / partial — no-op
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
					throw claudeCliAuthFailure();
				}
				if (errorText) {
					throw new Error(`claude-cli error: ${errorText}`);
				}
				if (!sawResult) {
					// No terminal frame — spawn failure (binary missing) or a crash.
					// An auth-shaped stderr here is a dead login, not a missing binary.
					if (isAuthShapedText(stderr)) {
						throw claudeCliAuthFailure();
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
					usage: currentUsage(),
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
						usage: currentUsage(),
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
