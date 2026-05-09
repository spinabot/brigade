/**
 * `EmbeddedChatClient` — `ChatClient` backed by an in-process Pi
 * `AgentSession`.
 *
 * Used by `brigade chat` (the in-process TUI). Wraps a long-lived Pi
 * session so the TUI can call `client.X` instead of `session.X`. Most
 * methods are passthrough; the only added value is:
 *
 *   1. Type narrowing — Pi's `Model<any>` becomes `Model<Api>` on the
 *      ChatClient interface, so the TUI gets stricter typing without
 *      Pi having to change.
 *
 *   2. `subscribe` returns an idempotent disposer (Pi's already does,
 *      but we wrap to make the contract explicit).
 *
 *   3. `steer` translates the structured `{text, images}` shape into
 *      Pi's positional `(text, images)` signature.
 *
 * The session is created and configured BEFORE this client is built —
 * by `buildAgent` (Runtime A entry today, Phase 5 will collapse onto
 * the same hardened path). The wrapper does NOT own the session
 * lifecycle; the caller is responsible for `dispose()` on shutdown.
 *
 * For the gateway path, a sibling `GatewayChatClient` (in
 * `cli/commands/connect.ts`) implements the same interface over
 * WebSocket. Both can be passed to `runChat` interchangeably.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

import type {
	ChatClient,
	ChatThinkingLevel,
	SteerOptions,
	Unsubscribe,
} from "./chat-client.js";

export interface EmbeddedChatClientOptions {
	/** A Pi `AgentSession`, fully constructed (auth + model + system
	 *  prompt + tool guards already applied). */
	session: AgentSession;
}

/**
 * Wrap an existing Pi `AgentSession` as a `ChatClient`. The session
 * stays long-lived — every `prompt` call reuses it. JSONL transcript
 * continuity, compaction, model switching all happen in-place.
 */
export function makeEmbeddedChatClient(opts: EmbeddedChatClientOptions): ChatClient {
	const { session } = opts;

	return {
		// ── Read-only metadata ────────────────────────────────────────

		get messages() {
			return session.messages;
		},

		get model() {
			return session.model ?? null;
		},

		get thinkingLevel() {
			return session.thinkingLevel as ChatThinkingLevel;
		},

		supportsThinking() {
			return session.supportsThinking();
		},

		getAvailableThinkingLevels() {
			return session.getAvailableThinkingLevels() as readonly ChatThinkingLevel[];
		},

		// ── Streaming events ──────────────────────────────────────────

		subscribe(handler): Unsubscribe {
			const detach = session.subscribe(handler);
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				try {
					detach();
				} catch {
					// session may already be torn down; harmless.
				}
			};
		},

		// ── Turn control ──────────────────────────────────────────────

		async prompt(text, opts) {
			// Pi's `prompt` doesn't accept an AbortSignal — the way to
			// cancel mid-stream is `session.abort()`. We bridge by
			// wiring a one-shot signal listener that calls abort when
			// the caller's signal fires.
			let onAbort: (() => void) | undefined;
			if (opts?.signal) {
				if (opts.signal.aborted) {
					await session.abort().catch(() => undefined);
					return;
				}
				onAbort = () => {
					session.abort().catch(() => undefined);
				};
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
			try {
				await session.prompt(text);
			} finally {
				if (onAbort && opts?.signal) {
					opts.signal.removeEventListener("abort", onAbort);
				}
			}
		},

		async abort() {
			await session.abort();
		},

		async steer(opts: SteerOptions): Promise<void> {
			// Pi accepts `(text, images?)` positional with each image
			// as `{type: "image", data, mimeType}`. Our public form
			// drops the redundant `type` discriminator and lets the
			// wrapper restore it. We `await` the underlying promise so
			// async errors (invalid encoding, transcript write failure)
			// reach the caller instead of getting silently dropped.
			const images = opts.images?.map((img) => ({
				type: "image" as const,
				data: img.data,
				mimeType: img.mimeType,
			}));
			await session.steer(opts.text, images);
		},

		// ── Configuration mutations ───────────────────────────────────

		async setModel(model) {
			await session.setModel(model);
		},

		setThinkingLevel(level) {
			session.setThinkingLevel(level);
		},

		// ── Context window ────────────────────────────────────────────

		getContextUsage() {
			return session.getContextUsage();
		},

		// ── Compaction ────────────────────────────────────────────────

		async compact() {
			// Pi returns a `CompactionResult`. ChatClient contract is
			// `Promise<void>` — callers inspect `getContextUsage()`
			// after to see the delta. We discard the result.
			await session.compact();
		},
	};
}
