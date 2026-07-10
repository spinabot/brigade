// src/agents/harness-transcript.ts
//
// The HARNESS TRANSCRIPT layer.
//
// A "harness" backend is one where an external agent binary runs the loop and
// Brigade's tools are called back in (today: claude-cli, whose `claude` binary
// drives its own loop and reaches our tools over the MCP route). On such a
// backend Pi's loop never dispatches a tool, so it emits no tool events and —
// crucially — writes no `toolCall` / `toolResult` messages. Brigade's session
// transcript therefore recorded only the model's final prose, and everything
// downstream that reads the transcript went blind:
//
//   • a RESUMED session had no idea a file was written or a command was run;
//   • compaction had no tool history to summarize;
//   • the next turn's replayed context (`serializeConversationPrompt`) could
//     not render `[called tool: X]` / `[X result]: …`, so the model lost the
//     thread of its own actions across turns;
//   • memory extraction's cursor barely advanced (a tool-heavy turn added ONE
//     message instead of many).
//
// This layer restores that record from the only place that knows a tool ran —
// the MCP route — without letting Pi re-execute anything.
//
// ── THE TRAP (why this is not simply "put the tool calls back in the message")
//
// Pi's `runLoop` executes tool calls found in the message returned by the
// stream fn: `message.content.filter(c => c.type === "toolCall")`, guarded only
// by `stopReason === "error" | "aborted"`. So if the claude-cli transport
// reported the binary's `tool_use` blocks in its assistant message, Pi would
// dispatch every one of them AGAIN — a second `bash`, a second billed render.
// The synthetic messages here are appended to the transcript AFTER the turn's
// message has already been produced, so the loop never sees them as fresh
// output. Historical `toolCall` blocks in the context are inert: the loop only
// executes what the stream just produced.
//
// ── ORDERING (why we append to the JSONL immediately but the in-memory array late)
//
// `AgentSession.messages` is a getter over `agent.state.messages`, and Pi's own
// out-of-loop injection (a user-run bash) refuses to touch it mid-stream —
// it queues and flushes once streaming ends. We honour the same rule: tool calls
// happen WHILE the binary streams, so mutating the live array then would race
// the loop. But the JSONL is an append-only file, and Pi persists the turn's
// assistant message on `message_end` — which fires only after the binary (and
// therefore every tool call) has finished. So appending each record to the JSONL
// as it happens yields the true chronological order:
//
//     [ toolCall, toolResult, … , assistant-final-text ]
//
// and the in-memory array is reconciled to match once the turn stops streaming
// (see `mergeHarnessRecordsIntoSession`), so a live session and a resumed one
// agree.
//
// ── API COMPATIBILITY
//
// Each record is a PAIR: an assistant message carrying one `toolCall` block,
// immediately followed by its `toolResult`. Keeping the pair adjacent is what
// providers like Anthropic require (a `tool_use` must be answered by a
// `tool_result`), so the transcript stays valid if the operator switches this
// session to an API provider mid-conversation.

import { createSubsystemLogger } from "../logging/subsystem-logger.js";

const log = createSubsystemLogger("harness/transcript");

/** One tool call executed by an external harness on Brigade's behalf. */
export interface HarnessToolRecord {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	/** The tool's model-facing content blocks (Pi's `AgentToolResult.content`). */
	content: unknown[];
	isError: boolean;
}

/** The backend that produced the record — stamped onto the synthetic message. */
export interface HarnessModelInfo {
	api: string;
	provider: string;
	model: string;
}

/** A harness turn draws no per-token charge of its own; the tool call itself
 *  costs nothing. Zeroed rather than omitted so usage accumulators never see
 *  `undefined` and NaN their way into the footer. */
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/**
 * The two messages Pi's loop would have produced for one tool call: an assistant
 * message carrying the `toolCall` block, then its `toolResult`. Mirrors
 * `createToolResultMessage` in pi-agent-core's agent-loop.
 */
export function buildHarnessToolMessages(rec: HarnessToolRecord, model: HarnessModelInfo): unknown[] {
	const timestamp = Date.now();
	const assistant = {
		role: "assistant",
		content: [{ type: "toolCall", id: rec.toolCallId, name: rec.toolName, arguments: rec.args }],
		api: model.api,
		provider: model.provider,
		model: model.model,
		usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
		// "toolUse" is the honest stop reason for a message whose only content is a
		// tool call. It is inert here: the loop only executes what the stream fn
		// just returned, never what it reads back from the transcript.
		stopReason: "toolUse",
		timestamp,
	};
	const result = {
		role: "toolResult",
		toolCallId: rec.toolCallId,
		toolName: rec.toolName,
		content: rec.content,
		isError: rec.isError,
		timestamp,
	};
	return [assistant, result];
}

/**
 * One tool call's messages, tagged with WHERE they belong in the live array —
 * its length at the moment the tool finished.
 *
 * Why a position rather than "append at the end": a turn can produce SEVERAL
 * assistant messages (Brigade's continuation loop when a reply is cut off at
 * `stopReason: "length"`). A tool that ran before continuation #2 must land
 * before it, not after all of them. Capturing the index as the tool completes
 * makes the reconstruction exact instead of a heuristic, and keeps each
 * `assistant(toolCall)` adjacent to its `toolResult` even when the binary runs
 * several tools in parallel.
 */
export interface HarnessRecordBatch {
	/** `session.messages.length` when the tool completed. */
	insertAt: number;
	/** The assistant(toolCall) + toolResult pair, in order. */
	messages: unknown[];
}

/** Minimal shape we need off a Pi session — kept structural so tests need no Pi. */
interface HarnessSession {
	messages?: unknown[];
	isStreaming?: boolean;
	sessionManager?: { appendMessage?: (m: unknown) => unknown };
}

/**
 * Persist one tool call to the session's JSONL immediately, and return the
 * messages so the caller can reconcile the in-memory array after the turn.
 *
 * Safe to call while the binary is streaming: this only appends to a file. It
 * never touches `agent.state.messages` (see the ORDERING note above).
 * Best-effort — a transcript write must never fail a tool call.
 */
export function recordHarnessToolCall(
	session: unknown,
	rec: HarnessToolRecord,
	model: HarnessModelInfo,
): HarnessRecordBatch {
	const messages = buildHarnessToolMessages(rec, model);
	const s = session as HarnessSession | undefined;
	// Where this pair belongs: everything the turn has emitted so far precedes it.
	const insertAt = Array.isArray(s?.messages) ? s.messages.length : 0;
	const sm = s?.sessionManager;
	if (typeof sm?.appendMessage === "function") {
		for (const m of messages) {
			try {
				sm.appendMessage(m);
			} catch (err) {
				log.debug("could not persist harness tool message", {
					tool: rec.toolName,
					err: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
	return { insertAt, messages };
}

/**
 * Reconcile the in-memory context with what we already wrote to the JSONL.
 *
 * MUST be called once `session.prompt()` has settled — the loop is done by then
 * and the array is ours to touch. Each batch is inserted at the index it occupied
 * when its tool finished, so the live array ends up in exactly the order the
 * JSONL already holds. That is correct even for a turn with several assistant
 * messages (Brigade's continuation loop) and for tools the binary ran in
 * parallel; each `assistant(toolCall)` stays adjacent to its `toolResult`, which
 * is what an API provider requires if this session is later switched to one.
 *
 * If the session still reports `isStreaming` we WARN and proceed rather than
 * skip. Pi's guard exists to stop a mutation racing a LIVE run, and by contract
 * we are past that (`isStreaming` lingers until `agent_end` listeners settle).
 * Skipping is the worse failure: the JSONL would hold the tool history while the
 * live context silently lost it for the rest of the process — the model would
 * forget, mid-conversation, that it had just written a file.
 */
export function mergeHarnessRecordsIntoSession(session: unknown, batches: HarnessRecordBatch[]): void {
	if (batches.length === 0) return;
	const s = session as HarnessSession | undefined;
	const messages = s?.messages;
	if (!Array.isArray(messages)) return;
	if (s?.isStreaming === true) {
		log.warn("merging harness tool records while the session still reports streaming", {
			batches: batches.length,
		});
	}

	// Ascending by position; each insertion shifts everything after it.
	const ordered = [...batches].sort((a, b) => a.insertAt - b.insertAt);
	let offset = 0;
	for (const batch of ordered) {
		const at = Math.min(Math.max(batch.insertAt, 0) + offset, messages.length);
		messages.splice(at, 0, ...batch.messages);
		offset += batch.messages.length;
	}
}
