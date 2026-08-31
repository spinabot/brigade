/**
 * The one place that knows how Pi spells things.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * Brigade speaks two dialects for the same ideas, and mixing them up is the
 * single most productive bug generator in this codebase — four separate
 * production bugs in one day, all the same mistake:
 *
 *   IN MEMORY (Pi)                    ON THE WIRE (Anthropic)
 *   ──────────────────                ───────────────────────
 *   block.type === "toolCall"         block.type === "tool_use"
 *   block.arguments                   block.input
 *   role === "toolResult" MESSAGE     a "tool_result" BLOCK in a user message
 *   message.toolCallId                block.tool_use_id
 *
 * Both spellings are correct — in their own layer. The bugs came from code
 * that walks Pi `Message[]` reaching for the wire spelling:
 *
 *   • `findSafeBoundary`   looked for `role === "user"`, never `"toolResult"`,
 *     so it cut between a tool call and its result.
 *   • `transcript-repair`  looked for `"tool_use"` blocks and found none.
 *   • `renderTranscript`   read `.input`, so every tool call rendered empty.
 *   • `approxMessageChars` read `.input`, estimating a 153,000-token
 *     transcript at 5 tokens — which silently disabled tier-2 compaction.
 *
 * Every one of those compiled, shipped, and passed a green test suite.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY TYPESCRIPT DID NOT CATCH ANY OF THEM
 * ─────────────────────────────────────────────────────────────────────────
 * Because nothing was ever typed. Pi exports real types — `ToolCall` with
 * `type: "toolCall"` and `arguments: Record<string, any>` — and Brigade
 * imported that type in ZERO files. Instead, 51 sites hand-wrote the shape
 * inline at the point of use:
 *
 *     const b = block as { type?: unknown; arguments?: unknown };
 *
 * A cast to a shape you invented on the spot cannot be wrong: the compiler
 * checks the access against your invention, not against Pi. Write `.input`
 * in that cast and it type-checks perfectly and returns `undefined` forever.
 *
 * So the fix is not "be more careful". It is to make the spelling a thing the
 * compiler owns. Every constant below is derived FROM Pi's exported types
 * rather than written as a string literal, so if Pi ever renames a field —
 * or if someone here reaches for the wire spelling — it fails at BUILD time
 * instead of returning `undefined` at 2am.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY DOES NOT COVER
 * ─────────────────────────────────────────────────────────────────────────
 * The wire layer. `payload-mutators`' cache hints, `claude-cli/stream-json`
 * and `ollama-native/stream` all correctly speak `tool_use` / `tool_result`
 * because they operate on outbound HTTP bodies and inbound provider frames.
 * Routing those through here would not fix a bug; it would create one.
 */

import type {
	AssistantMessage,
	Message,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";

/**
 * The discriminants, TAKEN FROM the types.
 *
 * `ToolCall["type"]` is the literal `"toolCall"`, so the annotation below is
 * an assertion the compiler enforces: if Pi renames the variant, this line
 * stops compiling and every caller is found for you. Writing
 * `const TOOL_CALL = "toolCall"` would assert nothing.
 */
const TOOL_CALL_TYPE: ToolCall["type"] = "toolCall";
const TOOL_RESULT_ROLE: ToolResultMessage["role"] = "toolResult";
const ASSISTANT_ROLE: AssistantMessage["role"] = "assistant";
const THINKING_TYPE: ThinkingContent["type"] = "thinking";
const TEXT_TYPE: TextContent["type"] = "text";

/**
 * Field names, checked against the types with `satisfies`.
 *
 * These are not used to index — they exist so that renaming `arguments` to
 * `input` upstream is a compile error here rather than a silent `undefined`
 * at every call site. They are the tripwire.
 */
const _ARGUMENTS_KEY = "arguments" satisfies keyof ToolCall;
const _TOOL_CALL_ID_KEY = "toolCallId" satisfies keyof ToolResultMessage;
const _TOOL_NAME_KEY = "toolName" satisfies keyof ToolResultMessage;
void _ARGUMENTS_KEY;
void _TOOL_CALL_ID_KEY;
void _TOOL_NAME_KEY;

/**
 * Anything with a `role`, which is all a caller usually has.
 *
 * Input is typed `unknown` on purpose: transcripts arrive from disk, from the
 * wire, and from other Brigade versions. The value of this module is that the
 * OUTPUT is Pi's real type — the narrowing happens once, here, correctly.
 */
type Unknownish = Record<string, unknown>;

function isObject(v: unknown): v is Unknownish {
	return typeof v === "object" && v !== null;
}

/** A `toolCall` content block, in Pi's in-memory dialect. */
export function isToolCall(block: unknown): block is ToolCall {
	return isObject(block) && block.type === TOOL_CALL_TYPE;
}

/** A `thinking` content block. */
export function isThinking(block: unknown): block is ThinkingContent {
	return isObject(block) && block.type === THINKING_TYPE;
}

/** A `text` content block. */
export function isText(block: unknown): block is TextContent {
	return isObject(block) && block.type === TEXT_TYPE;
}

/**
 * A tool RESULT — which in Pi is a whole message, not a block.
 *
 * This is the distinction `findSafeBoundary` got wrong. On the wire a tool
 * result is a block inside a `user` message, so code ported from wire-shaped
 * thinking looks for `role === "user"` and never finds it.
 */
export function isToolResultMessage(msg: unknown): msg is ToolResultMessage {
	return isObject(msg) && msg.role === TOOL_RESULT_ROLE;
}

/** An assistant message, which is the only kind that carries `toolCall` blocks. */
export function isAssistantMessage(msg: unknown): msg is AssistantMessage {
	return isObject(msg) && msg.role === ASSISTANT_ROLE;
}

/**
 * A tool call's arguments.
 *
 * Returns `{}` rather than `undefined` for a malformed block so callers can
 * destructure without a guard — the four bugs above were all "this read
 * produced nothing and no one noticed", and an empty object at least keeps
 * `Object.keys(...).length === 0` meaningful.
 */
export function toolCallArguments(block: unknown): Record<string, unknown> {
	if (!isToolCall(block)) return {};
	const args = block.arguments;
	return isObject(args) ? args : {};
}

/** A tool call's name, or `""` when the block is not one. */
export function toolCallName(block: unknown): string {
	return isToolCall(block) && typeof block.name === "string" ? block.name : "";
}

/** A tool call's id — the thing a `ToolResultMessage.toolCallId` points back at. */
export function toolCallId(block: unknown): string {
	return isToolCall(block) && typeof block.id === "string" ? block.id : "";
}

/**
 * The id a tool-result MESSAGE answers.
 *
 * Returns `undefined` for anything that is not a tool result, so a caller can
 * use it as both the test and the accessor.
 */
export function toolResultCallId(msg: unknown): string | undefined {
	if (!isToolResultMessage(msg)) return undefined;
	return typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
}

/** The tool name a result came from, for labelling. */
export function toolResultName(msg: unknown): string | undefined {
	if (!isToolResultMessage(msg)) return undefined;
	return typeof msg.toolName === "string" ? msg.toolName : undefined;
}

/**
 * Every `toolCall` block in a message, in order.
 *
 * Empty for user and toolResult messages, which is the correct answer rather
 * than an error — callers iterate transcripts and should not have to branch.
 */
export function toolCallsIn(msg: unknown): ToolCall[] {
	if (!isObject(msg)) return [];
	const content = msg.content;
	if (!Array.isArray(content)) return [];
	return content.filter(isToolCall);
}

/**
 * A message's content blocks as an array, normalising the string form.
 *
 * `UserMessage.content` is `string | Content[]`. Forgetting the string case
 * is the fifth version of this same bug waiting to happen, so it is handled
 * once here.
 */
export function contentBlocks(msg: unknown): unknown[] {
	if (!isObject(msg)) return [];
	const content = msg.content;
	if (typeof content === "string") {
		return content ? [{ type: TEXT_TYPE, text: content }] : [];
	}
	return Array.isArray(content) ? content : [];
}

/** Concatenated plain text of a message, ignoring thinking and tool calls. */
export function messageText(msg: unknown): string {
	const parts: string[] = [];
	for (const block of contentBlocks(msg)) {
		if (isText(block) && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * A block's text, read TOLERANTLY.
 *
 * Deliberately does not require `type === "text"`. Transcripts arrive from
 * disk and from older Brigade versions where the discriminant may be absent,
 * and a tool result's blocks are plain text carriers. Callers that need the
 * strict check have `isText`; this is for "give me whatever prose is here".
 */
export function blockText(block: unknown): string | undefined {
	if (!isObject(block)) return undefined;
	return typeof block.text === "string" ? block.text : undefined;
}

/** A block's thinking text, read tolerantly. See `blockText`. */
export function blockThinking(block: unknown): string | undefined {
	if (!isObject(block)) return undefined;
	return typeof block.thinking === "string" ? block.thinking : undefined;
}

/**
 * The literal discriminants, for the three modules that CONVERT between
 * dialects (`claude-cli/stream`, `ollama-native/stream`, `payload-mutators`).
 *
 * Those modules legitimately write `tool_use` on one side of the conversion;
 * exporting the Pi side as a checked constant means the OTHER side of their
 * mapping is still compiler-owned, so a rename upstream breaks the build
 * rather than silently producing blocks Pi will not recognise.
 */
export const PI_TOOL_CALL = TOOL_CALL_TYPE;
export const PI_TOOL_RESULT = TOOL_RESULT_ROLE;
export const PI_THINKING = THINKING_TYPE;
export const PI_TEXT = TEXT_TYPE;
export const PI_ASSISTANT = ASSISTANT_ROLE;

/* ───────────────────── the wire dialect, named honestly ───────────────────── */

/**
 * Anthropic's WIRE spellings.
 *
 * A handful of call sites legitimately see both dialects — `mid-turn` decides
 * boundaries on transcripts that `transcript-repair` may have synthesised in
 * Anthropic shape, and the stream converters map one onto the other. Those
 * sites should say so out loud with these constants rather than sprinkling bare
 * string literals that read like a mistake.
 */
export const WIRE_TOOL_USE = "tool_use";
export const WIRE_TOOL_RESULT = "tool_result";

/** A `tool_use` block in Anthropic's wire dialect. */
export function isWireToolUse(block: unknown): boolean {
	return isObject(block) && block.type === WIRE_TOOL_USE;
}

/** A `tool_result` block in Anthropic's wire dialect. */
export function isWireToolResult(block: unknown): boolean {
	return isObject(block) && block.type === WIRE_TOOL_RESULT;
}

/**
 * Tool arguments from EITHER dialect — Pi's `arguments` or the wire's `input`.
 *
 * For the sites that provably see both. This is not a licence to be sloppy: it
 * is narrower than an inline cast because it names both spellings explicitly
 * and cannot miss one. `messageTokens` needed it — it read only `arguments`, so
 * a wire-shaped transcript had every tool call's payload counted as zero, which
 * is the same under-estimation that once left tier-2 compaction disabled on a
 * 153,000-token history.
 */
export function anyDialectToolArguments(block: unknown): Record<string, unknown> | undefined {
	if (!isObject(block)) return undefined;
	const pi = block.arguments;
	if (isObject(pi)) return pi;
	const wire = block.input;
	if (isObject(wire)) return wire;
	return undefined;
}

/** Re-exported so callers can type their own signatures without a second import. */
export type { Message, ToolCall, ToolResultMessage, AssistantMessage };
