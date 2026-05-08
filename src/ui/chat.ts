/**
 * Brigade chat TUI.
 *
 * Pi-TUI components, glued to the Pi Agent event stream:
 *   - Status header (model · token usage · cost)
 *   - Conversation log (Markdown components, one per assistant turn)
 *   - Tool call indicators (Text components inserted inline)
 *   - Loader (CancellableLoader during agent thinking)
 *   - Editor (multi-line input with history)
 *   - Footer hint
 *
 * Streaming: each `message_delta` event updates the current Markdown component.
 * Differential rendering means only changed lines repaint — no flicker.
 */

import * as path from "node:path";

import type { AgentSession, AgentSessionEvent, AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
	CancellableLoader,
	Editor,
	Input,
	type SelectItem,
	SelectList,
	Text,
	TUI,
} from "@mariozechner/pi-tui";
import chalk from "chalk";

// Brigade's `Markdown` is a thin Pi-TUI subclass that normalizes `_text_`
// italic to `*text*` before rendering. Pi-TUI's parser doesn't accept the
// underscore form, so without this wrapper agent replies that quote
// IDENTITY.md placeholders (or any underscored emphasis) leak with literal
// underscores into the chat output.
import { Markdown } from "./markdown.js";

import {
	classifySensitiveStopReason,
	runWithContentQualityRetry,
	runWithFallback,
	runWithHeartbeat,
	runWithLengthContinuation,
	runWithStreamTimeout,
	runWithThinkingFallback,
	switchModelMidTurn,
} from "../core/agent.js";
import { BRIGADE_DIR, loadConfig, saveConfig } from "../core/config.js";
import { cleanProviderError, describeModelCapabilities, pickStreamIdleMs } from "../core/model-caps.js";
import { buildLoginGuidanceMessage, friendlyError, translateAuthError } from "../core/auth-error.js";
import { discoverOllamaModels, writeOllamaToModelsJson } from "../integrations/ollama.js";
import { findProvider, PROVIDERS } from "../providers/catalog.js";
import { validateApiKeyOnline } from "../providers/validate-key.js";
import { renderBrandHeader } from "./brand.js";
import { restoreTerminal } from "./terminal-cleanup.js";
import { brand, editorTheme, markdownTheme, selectListTheme } from "./theme.js";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevelName = (typeof VALID_THINKING_LEVELS)[number];

export interface ChatTUIOptions {
	session: AgentSession;
	tui: TUI;
	provider: string;
	modelId: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	/**
	 * Optional first user message to fire automatically once the chat is fully
	 * wired. Used by onboarding to kick off the BOOTSTRAP.md name-discovery
	 * conversation on a truly fresh workspace — without this, the agent sits
	 * silently waiting for the user to type, and the seeded BOOTSTRAP.md
	 * (which expects the model to open the conversation) never gets exercised.
	 *
	 * Whitespace-only / empty values are silently ignored.
	 */
	kickoffMessage?: string;
	/**
	 * Render a one-line slash-command discoverability tip after the kickoff turn
	 * is queued. Gated by the caller on the same fresh-workspace signal that
	 * gates `kickoffMessage`, so we never spam returning users.
	 */
	firstRun?: boolean;
}

/** Returned so the top-level (index.ts) can wire the SIGINT handler exactly once per process. */
export interface ChatHandle {
	abort(): boolean; // returns true if a turn was in flight; false otherwise
	isRunning(): boolean;
}

export async function runChat(opts: ChatTUIOptions): Promise<ChatHandle> {
	const { session, tui, authStorage, modelRegistry } = opts;
	let provider = opts.provider;
	let modelId = opts.modelId;

	// ── brand wordmark at the top of the chat screen ────────────────────
	// Same chunky 4-stop metallic wordmark from onboarding. Pi-TUI is
	// stream-based, so this appears once at boot and naturally scrolls
	// out of view as the conversation grows below. We render the still
	// (last-frame) variant here — onboarding gets the looping clip as a
	// one-time wow moment, but in chat the looping animation competes
	// with the conversation for attention, so we freeze it at the
	// artist's intended resting pose.
	renderBrandHeader(tui, { animate: false });

	// ── status header (model · tokens · cost) ───────────────────────────
	const header = new Text("", 0, 0);
	tui.addChild(header);

	const divider = new Text(brand.dim("─".repeat(80)), 0, 0);
	tui.addChild(divider);

	// usage state we render in the header
	let totalIn = 0;
	let totalOut = 0;
	let totalCost = 0;

	// Cost is only displayed when the provider reports it. Many free-tier providers
	// (Groq, free Gemini tier, Ollama) don't report usage cost, so we hide the field
	// instead of permanently showing $0.0000 — which would mislead users.
	//
	// Also includes per-model capabilities (thinking level, vision, ctx, $/Mtok)
	// derived from the live `session.model` + `session.thinkingLevel` so it stays
	// accurate across thinking-level changes and (future) model swaps.
	const updateHeader = (extra?: string): void => {
		const providerName = findProvider(provider)?.name ?? provider;
		const caps = session.model
			? describeModelCapabilities(session.model, session.thinkingLevel)
			: "";
		const capsStr = caps ? ` · ${caps}` : "";
		const tokens = totalIn + totalOut > 0 ? ` · ${(totalIn + totalOut).toLocaleString()} tok` : "";
		const cost = totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : "";

		// Live context usage. Pi recomputes this after each LLM response, so
		// the percentage stays accurate as the conversation grows. We only
		// show it once it crosses 50% — below that the user doesn't need to
		// worry. Highlights in amber at 75%+ to warn before auto-compact fires.
		const usage = session.getContextUsage();
		let usageStr = "";
		if (usage?.percent != null && usage.percent >= 50) {
			const pct = Math.round(usage.percent);
			const colored = pct >= 75 ? brand.amber(`${pct}% ctx`) : brand.dim(`${pct}% ctx`);
			usageStr = ` · ${colored}`;
		}

		const tail = extra ? ` · ${extra}` : "";
		header.setText(
			`  ${brand.amber("●")} ${brand.white("Brigade")}  ${brand.dim(`${providerName} · ${modelId}${capsStr}${tokens}${cost}`)}${usageStr}${brand.dim(tail)}`,
		);
	};
	updateHeader();

	// ── editor ──────────────────────────────────────────────────────────
	const editor = new Editor(tui, editorTheme);
	tui.addChild(editor);
	tui.setFocus(editor);

	// Hint line below the editor
	tui.addChild(
		new Text(brand.dim("  Enter to send · Ctrl+C abort · Ctrl+D quit · /model /provider /thinking /compact /help"), 0, 0),
	);

	// ── streaming state ─────────────────────────────────────────────────
	let isAgentRunning = false;
	let activeAssistant: Markdown | null = null;
	let activeLoader: CancellableLoader | null = null;
	let pendingTools = new Map<string, Text>();

	/**
	 * Extract concatenated text from an assistant message's content blocks.
	 * The cumulative content is what Pi maintains — we read from it instead of
	 * trying to stitch deltas ourselves, because not every provider emits
	 * `text_delta` events (some only emit `text_start` + `text_end`, and
	 * reasoning models intersperse `thinking_*` events). Reading from
	 * `event.message.content` is what Pi's own interactive mode does and is
	 * the only robust approach across providers.
	 */
	const extractAssistantText = (message: any): string => {
		if (!message || !Array.isArray(message.content)) return "";
		return message.content
			.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("");
	};

	/** Pull text from a user message — used by mid-turn /model switch to replay the last user message on the new model. */
	const extractUserText = (message: any): string => {
		if (!message) return "";
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("");
	};

	type AnyChild = Text | Markdown | CancellableLoader | SelectList | Input;

	const insertBeforeEditor = (component: AnyChild): void => {
		// children: [header, divider, ...messages, editor, hint]
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
	 * Run an inline picker over the conversation: insert a SelectList right above
	 * the editor, steal focus, await a choice, then remove the list and any
	 * supporting label rows. Returns the chosen value, or `null` if the user
	 * pressed Esc/Ctrl+C. The chat stays scrolled and intact throughout —
	 * no clear-screen, no flash.
	 */
	const inlinePick = async <T,>(
		title: string,
		items: Array<SelectItem & { _value: T }>,
		opts: { primaryWidth?: [number, number] } = {},
	): Promise<T | null> => {
		const labelRow = new Text(`  ${brand.amber(title)}`, 0, 0);
		insertBeforeEditor(labelRow);

		const [minW, maxW] = opts.primaryWidth ?? [22, 38];
		const list = new SelectList(items, Math.min(items.length, 12), selectListTheme, {
			minPrimaryColumnWidth: minW,
			maxPrimaryColumnWidth: maxW,
		});
		insertBeforeEditor(list);
		tui.setFocus(list);
		tui.requestRender();

		try {
			const chosen = await new Promise<SelectItem & { _value: T }>((resolve, reject) => {
				list.onSelect = (item) => resolve(item as SelectItem & { _value: T });
				list.onCancel = () => reject(new Error("cancel"));
			});
			return chosen._value;
		} catch {
			return null;
		} finally {
			removeChild(list);
			removeChild(labelRow);
			tui.setFocus(editor);
			tui.requestRender();
		}
	};

	/**
	 * Inline single-line text input — same lifecycle as inlinePick. Used for
	 * API-key entry, base-URL prompts, and the like during /provider.
	 * Returns the typed value, or `null` if the user pressed Esc.
	 */
	const inlinePrompt = async (label: string, hint?: string): Promise<string | null> => {
		const labelRow = new Text(`  ${brand.amber(label)}`, 0, 0);
		insertBeforeEditor(labelRow);
		const hintRow = hint ? new Text(brand.dim(`  ${hint}`), 0, 0) : null;
		if (hintRow) insertBeforeEditor(hintRow);

		const input = new Input();
		insertBeforeEditor(input);
		tui.setFocus(input);
		tui.requestRender();

		try {
			return await new Promise<string>((resolve, reject) => {
				input.onSubmit = (value: string) => resolve(value.trim());
				input.onEscape = () => reject(new Error("cancel"));
			});
		} catch {
			return null;
		} finally {
			removeChild(input);
			if (hintRow) removeChild(hintRow);
			removeChild(labelRow);
			tui.setFocus(editor);
			tui.requestRender();
		}
	};

	/**
	 * Switch to a new (provider, modelId) pair. Resolves the model object via
	 * ModelRegistry, calls Pi's setModel (which validates auth + persists to
	 * session), and updates Brigade's local state + saved config so the next
	 * boot resumes here. Returns whether the switch succeeded.
	 */
	const switchToModel = async (newProvider: string, newModelId: string): Promise<boolean> => {
		const model = modelRegistry.find(newProvider, newModelId);
		if (!model) {
			insertBeforeEditor(
				new Text(`  ${brand.error("✗")} ${brand.error(`No model "${newModelId}" found for provider "${newProvider}".`)}`, 0, 0),
			);
			return false;
		}
		try {
			await session.setModel(model);
		} catch (err) {
			const raw = err instanceof Error ? err.message : String(err);
			const friendly = friendlyError(raw, cleanProviderError);
			insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(friendly)}`, 0, 0));
			return false;
		}
		provider = newProvider;
		modelId = newModelId;
		await saveConfig({ defaultProvider: newProvider, defaultModelId: newModelId });
		updateHeader();
		insertBeforeEditor(
			new Text(`  ${brand.amber("✓")} ${brand.dim("switched to")} ${brand.white(`${newProvider} · ${newModelId}`)}`, 0, 0),
		);
		return true;
	};

	// ── replay: print prior conversation if resumed ────────────────────
	for (const m of session.messages) {
		if (m.role === "user" && Array.isArray(m.content)) {
			const text = m.content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("");
			if (text) {
				insertBeforeEditor(new Markdown(`${brand.user("you")}  ${text}`, 1, 0, markdownTheme));
			}
		} else if (m.role === "assistant" && Array.isArray(m.content)) {
			const text = m.content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("");
			if (text) {
				insertBeforeEditor(new Markdown(`${brand.agent("brigade")}  ${text}`, 1, 0, markdownTheme));
			}
		}
	}

	// ── subscribe to Pi events ─────────────────────────────────────────
	session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
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
			case "message_update": {
				// Pull text from the cumulative message — works for every provider
				// regardless of whether they emit text_delta, text_end, or just
				// the final message all at once. This is the same pattern Pi's
				// own interactive mode uses.
				const msg = (event as any).message;
				if (!msg || msg.role !== "assistant") break;
				const text = extractAssistantText(msg);
				if (!text) break; // tool calls / thinking blocks only — nothing to render yet

				if (activeLoader) {
					removeChild(activeLoader);
					activeLoader = null;
				}
				if (!activeAssistant) {
					activeAssistant = new Markdown(`${brand.agent("brigade")}  ${text}`, 1, 0, markdownTheme);
					insertBeforeEditor(activeAssistant);
				} else {
					activeAssistant.setText(`${brand.agent("brigade")}  ${text}`);
					tui.requestRender();
				}
				break;
			}
			case "message_end": {
				// Final safety net: some providers don't stream incrementally —
				// they only emit message_end with the full message. If we never
				// rendered any text from message_update, render it now.
				const msg = (event as any).message;
				if (!msg || msg.role !== "assistant") break;
				const text = extractAssistantText(msg);
				if (!text) break;

				if (activeLoader) {
					removeChild(activeLoader);
					activeLoader = null;
				}
				if (!activeAssistant) {
					activeAssistant = new Markdown(`${brand.agent("brigade")}  ${text}`, 1, 0, markdownTheme);
					insertBeforeEditor(activeAssistant);
				} else {
					activeAssistant.setText(`${brand.agent("brigade")}  ${text}`);
					tui.requestRender();
				}
				break;
			}
			case "tool_execution_start": {
				if (activeLoader) {
					removeChild(activeLoader);
					activeLoader = null;
				}
				const summary = formatToolArgs(event.toolName, event.args);
				const indicator = new Text(`  ${brand.tool("⚡")} ${brand.tool(event.toolName)} ${brand.dim(summary)}`, 0, 0);
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
				const usage = (event as any).message?.usage;
				if (usage) {
					totalIn += usage.input ?? 0;
					totalOut += usage.output ?? 0;
					totalCost += usage.cost ?? 0;
					updateHeader();
				}
				break;
			}
			case "compaction_start": {
				// Pi auto-compacts when context fills. Surface it so the user
				// understands the brief pause + the assistant message that
				// follows comes from a fresh summary.
				const usage = session.getContextUsage();
				const pct = usage?.percent != null ? `${Math.round(usage.percent)}%` : "high";
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(`⚡ compacting context (was ${pct})…`)}`,
						0,
						0,
					),
				);
				break;
			}
			case "compaction_end": {
				const ev = event as any;
				if (ev.aborted) {
					insertBeforeEditor(
						new Text(`  ${brand.dim("compaction aborted")}`, 0, 0),
					);
				} else {
					// Pi's getContextUsage returns null right after compaction by
					// design — token estimates need a fresh LLM response to
					// recalculate. Show that explicitly instead of a confusing "?".
					const after = session.getContextUsage();
					const afterStr =
						after?.percent != null
							? `usage now ${Math.round(after.percent)}%`
							: "usage refreshes after your next message";
					insertBeforeEditor(
						new Text(`  ${brand.amber("✓")} ${brand.dim(`compacted · ${afterStr}`)}`, 0, 0),
					);
				}
				updateHeader();
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

				// Last-resort safety net: if no text was ever rendered (no message_update,
				// no message_end), surface the final message text or any error message
				// from the agent end event. Without this, a bad request leaves the user
				// staring at "thinking…" gone-but-no-reply. Provider errors arrive as
				// nested JSON blobs (Pi wraps the upstream response) — cleanProviderError
				// peels them down to a single human-readable line.
				const messages = (event as any).messages;
				if (Array.isArray(messages) && messages.length > 0) {
					const last = messages[messages.length - 1];
					if (last && last.role === "assistant") {
						const text = extractAssistantText(last);
						const errMsg = last.errorMessage as string | undefined;
						// Sensitive stop reasons (refusal, content filter, policy block)
						// produce empty content with a meaningful stopReason. Translate
						// to a friendly message — without this the user sees nothing.
						const sensitive = !text ? classifySensitiveStopReason(last) : null;
						if (!text && errMsg) {
							// Pi's auth-resolution failures arrive with `/login` (a Pi command
							// Brigade doesn't have) and raw `node_modules/.../docs/...` paths
							// embedded — both are Brigade-UX violations. friendlyError() runs
							// translateAuthError first (which carries no `✗` prefix because
							// it includes its own `⚠`), then falls back to cleanProviderError
							// for non-auth provider errors (with `✗` prefix).
							const translated = translateAuthError(errMsg);
							if (translated) {
								insertBeforeEditor(new Text(`  ${brand.error(translated)}`, 0, 0));
							} else {
								const cleaned = cleanProviderError(errMsg);
								insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(cleaned)}`, 0, 0));
							}
						} else if (sensitive) {
							insertBeforeEditor(
								new Text(`  ${brand.error("✗")} ${brand.error(sensitive.userMessage)}`, 0, 0),
							);
						} else if (!text && (last.stopReason === "error" || last.stopReason === "aborted")) {
							insertBeforeEditor(
								new Text(`  ${brand.error("✗")} ${brand.error(`Agent ended with no reply (${last.stopReason})`)}`, 0, 0),
							);
						}
					}
				}

				updateHeader();
				break;
			}
			case "auto_retry_start": {
				// Pi auto-retries transient provider errors (rate limit, 5xx,
				// connection drop). Tell the user it's happening — without this,
				// a slow retry looks like the model is just hanging.
				const ev = event as any;
				const attempt = ev.attempt ?? 1;
				const max = ev.maxAttempts ?? 1;
				const waitS = Math.round((ev.delayMs ?? 0) / 100) / 10;
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
				const ev = event as any;
				if (ev.success === false) {
					insertBeforeEditor(
						new Text(
							`  ${brand.error("✗")} ${brand.error(`gave up after ${ev.attempt} attempts`)}`,
							0,
							0,
						),
					);
				}
				break;
			}
		}
	});

	// ── input handling ─────────────────────────────────────────────────
	editor.onSubmit = async (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;

		// Mid-turn submit → STEER, not drop. Pi queues the message and the
		// model sees it after the current tool round completes — no abort,
		// no lost context. This is what "steer" means at the loop level and
		// it's a key part of a production-grade chat UX.
		if (isAgentRunning) {
			// Slash commands during a turn are still handled locally — they
			// shouldn't reach the model. (This block intentionally mirrors the
			// post-loop set; if a new local command lands below, mirror it here.)
			if (trimmed === "/exit" || trimmed === "/quit") {
				tui.stop();
				restoreTerminal();
				process.exit(0);
			}

			// /model <id> mid-turn → live model switch. Aborts the current
			// turn cleanly, swaps the model, re-prompts with the user's
			// original message. Hot-swap UX; way better than "abort, wait,
			// /model, retype".
			if (trimmed.startsWith("/model ")) {
				editor.setText("");
				const targetId = trimmed.slice("/model ".length).trim();
				const matches = modelRegistry.getAvailable().filter((m) => m.id === targetId);
				const target = matches.find((m) => m.provider === provider) ?? matches[0];
				if (!target) {
					insertBeforeEditor(
						new Text(
							`  ${brand.error(`✗ no configured model with id "${targetId}". Type /model to list.`)}`,
							0,
							0,
						),
					);
					return;
				}
				// Find the most recent user message to replay on the new model.
				const lastUser = [...session.messages].reverse().find((m: any) => m.role === "user");
				const replayMsg = lastUser ? extractUserText(lastUser) : "";
				if (!replayMsg) {
					insertBeforeEditor(
						new Text(
							`  ${brand.error("✗ no user message to replay on the new model.")}`,
							0,
							0,
						),
					);
					return;
				}
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(`↻ aborting current turn, switching to ${targetId}, re-running…`)}`,
						0,
						0,
					),
				);
				try {
					const swapped = await switchModelMidTurn(session, target, replayMsg);
					if (!swapped) {
						// Turn ended between our `isAgentRunning` check and switchModelMidTurn —
						// the in-flight signal had already cleared. Fall back to a normal
						// post-turn switch using the same code path the post-turn /model uses.
						await switchToModel(target.provider, target.id);
						return;
					}
					provider = target.provider;
					modelId = target.id;
					await saveConfig({ defaultProvider: provider, defaultModelId: modelId });
					updateHeader();
				} catch (err) {
					const raw = err instanceof Error ? err.message : String(err);
					const friendly = friendlyError(raw, cleanProviderError);
					insertBeforeEditor(
						new Text(`  ${brand.error("✗")} ${brand.error(`Switch failed: ${friendly}`)}`, 0, 0),
					);
				}
				return;
			}

			editor.setText("");
			session.agent.steer({
				role: "user",
				content: [{ type: "text", text: trimmed }],
			} as any);
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
			return;
		}

		// slash commands (handled locally, never sent to the model)
		if (trimmed === "/exit" || trimmed === "/quit") {
			tui.stop();
			restoreTerminal();
			process.exit(0);
		}
		if (trimmed === "/clear") {
			editor.setText("");
			return;
		}
		if (trimmed === "/help") {
			insertBeforeEditor(
				new Markdown(
					`${brand.dim("commands")}\n` +
						`- ${chalk.bold("/exit")} or ${chalk.bold("/quit")} — quit Brigade\n` +
						`- ${chalk.bold("/help")} — this list\n` +
						`- ${chalk.bold("/clear")} — clear the input\n` +
						`- ${chalk.bold("/model")} — switch to another configured model\n` +
						`- ${chalk.bold("/model <id>")} — switch directly by model id\n` +
						`- ${chalk.bold("/provider")} — add a new provider mid-session\n` +
						`- ${chalk.bold("/thinking <level>")} — set reasoning effort (off|minimal|low|medium|high|xhigh)\n` +
						`- ${chalk.bold("/compact")} — summarize older turns to free up context\n` +
						`- ${chalk.bold("Ctrl+C")} — abort the current turn\n` +
						`- ${chalk.bold("Ctrl+D")} — quit`,
					1,
					0,
					markdownTheme,
				),
			);
			editor.setText("");
			return;
		}

		// `/login` is a Pi slash command — Brigade doesn't have one. Pi's
		// auth-error text tells users to type `/login`, so users WILL try it.
		// Translate the attempt into Brigade's actual flow rather than
		// silently sending `/login` to the model as a user message.
		if (trimmed === "/login" || trimmed === "/auth" || trimmed === "/onboard") {
			editor.setText("");
			insertBeforeEditor(new Text(`  ${brand.error(buildLoginGuidanceMessage())}`, 0, 0));
			return;
		}

		// /compact — manually trigger Pi's compaction. Auto-compaction runs in
		// the background at high context usage; this lets the user trigger it
		// on demand (or summarize early before a long task).
		if (trimmed === "/compact") {
			editor.setText("");
			const usage = session.getContextUsage();
			if (usage?.percent != null) {
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(`Compacting (current usage ${Math.round(usage.percent)}%)…`)}`,
						0,
						0,
					),
				);
			} else {
				insertBeforeEditor(new Text(`  ${brand.dim("Compacting…")}`, 0, 0));
			}
			try {
				const result = await session.compact();
				// getContextUsage returns null right after compaction (Pi: token
				// estimate needs a fresh LLM response). Show that explicitly.
				const after = session.getContextUsage();
				const afterStr =
					after?.percent != null
						? `usage now ${Math.round(after.percent)}%`
						: "usage refreshes after your next message";
				const before = result?.tokensBefore ? `${(result.tokensBefore / 1000).toFixed(1)}k` : "?";
				insertBeforeEditor(
					new Text(
						`  ${brand.amber("✓")} ${brand.dim(`Compacted ${before} of older context · ${afterStr}`)}`,
						0,
						0,
					),
				);
				updateHeader();
			} catch (err) {
				const raw = err instanceof Error ? err.message : String(err);
				const friendly = friendlyError(raw, cleanProviderError);
				insertBeforeEditor(
					new Text(`  ${brand.error("✗")} ${brand.error(`Compaction failed: ${friendly}`)}`, 0, 0),
				);
			}
			return;
		}

		// /model — list/switch already-configured models. Without args, opens an
		// inline picker over every model with auth set. With args, switches directly
		// (matches by id; if multiple providers expose the same id, prefers the
		// current provider, otherwise the first match).
		if (trimmed === "/model" || trimmed.startsWith("/model ")) {
			editor.setText("");
			const available = modelRegistry.getAvailable();
			if (available.length === 0) {
				insertBeforeEditor(
					new Text(`  ${brand.error("✗ no configured models — try /provider to add one.")}`, 0, 0),
				);
				return;
			}

			const arg = trimmed === "/model" ? "" : trimmed.slice("/model ".length).trim();

			if (arg) {
				// Direct switch by id. Prefer current provider on tie.
				const matches = available.filter((m) => m.id === arg);
				const target =
					matches.find((m) => m.provider === provider) ?? matches[0];
				if (!target) {
					insertBeforeEditor(
						new Text(
							`  ${brand.error(`✗ no configured model with id "${arg}".`)} ${brand.dim(`Run /model to see the list.`)}`,
							0,
							0,
						),
					);
					return;
				}
				await switchToModel(target.provider, target.id);
				return;
			}

			// Inline picker. Sort by current-provider-first, then reasoning, then ctx.
			const sorted = [...available].sort((a, b) => {
				if (a.provider !== b.provider) {
					if (a.provider === provider) return -1;
					if (b.provider === provider) return 1;
					return a.provider.localeCompare(b.provider);
				}
				if (!!a.reasoning !== !!b.reasoning) return a.reasoning ? -1 : 1;
				return (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
			});

			const items = sorted.map((m) => ({
				value: `${m.provider}::${m.id}`,
				label: `${m.id}${m.id === modelId && m.provider === provider ? brand.amber(" (current)") : ""}`,
				description: `${findProvider(m.provider)?.name ?? m.provider} · ${describeModelCapabilities(m)}`,
				_value: { p: m.provider, id: m.id },
			}));

			const picked = await inlinePick("Switch model", items, { primaryWidth: [22, 38] });
			if (!picked) return;
			if (picked.p === provider && picked.id === modelId) {
				insertBeforeEditor(new Text(`  ${brand.dim("already on that model.")}`, 0, 0));
				return;
			}
			await switchToModel(picked.p, picked.id);
			return;
		}

		// /provider — add a new provider mid-session. Picks the unconfigured ones,
		// runs the same key-entry / Ollama-discovery code as onboarding, and (on
		// success) auto-switches to the first model from that provider.
		if (trimmed === "/provider") {
			editor.setText("");

			// Show only providers we don't already have credentials/registration for.
			const configuredProviders = new Set(
				modelRegistry.getAvailable().map((m) => m.provider),
			);
			const candidates = PROVIDERS.filter((p) => !configuredProviders.has(p.id));
			// Track whether this add results in 2+ providers being configured —
			// drives the "all providers stay configured · use /model to switch"
			// reassurance line shown after a successful add. Captured BEFORE the
			// add so we know the prior count.
			const willBeMultiProvider = configuredProviders.size >= 1;
			const renderMultiProviderTip = (): void => {
				if (!willBeMultiProvider) return;
				insertBeforeEditor(
					new Text(
						`  ${brand.dim("All your providers stay configured · use /model to switch any time · saved across restarts.")}`,
						0,
						0,
					),
				);
			};
			if (candidates.length === 0) {
				insertBeforeEditor(
					new Text(`  ${brand.dim("all curated providers are already configured. Use /model to switch.")}`, 0, 0),
				);
				return;
			}

			const items = candidates.map((p) => ({
				value: p.id,
				label: p.name,
				description: p.description,
				_value: p,
			}));
			const picked = await inlinePick("Add a provider", items, { primaryWidth: [18, 22] });
			if (!picked) return;

			// Three paths now:
			//   - custom: user supplies provider id + baseUrl + apiKey + a model id
			//   - local (ollama): discover models via /api/tags
			//   - remote: just collect API key + use Pi's catalog
			if (picked.custom) {
				const providerId = await inlinePrompt(
					"Give this connection a short name",
					"Lowercase letters and dashes only — for example: together, fireworks, on-prem.",
				);
				if (!providerId) return;
				if (!/^[a-z][a-z0-9_-]*$/.test(providerId)) {
					insertBeforeEditor(new Text(`  ${brand.error("✗ Use lowercase letters, numbers, and dashes only.")}`, 0, 0));
					return;
				}
				const baseUrl = await inlinePrompt(
					"Endpoint URL",
					"The OpenAI-compatible URL — for example: https://api.together.xyz/v1",
				);
				if (!baseUrl) return;
				if (!/^https?:\/\//i.test(baseUrl)) {
					insertBeforeEditor(new Text(`  ${brand.error("✗ The URL should start with https:// or http://.")}`, 0, 0));
					return;
				}
				const apiKey = await inlinePrompt(
					"API key",
					"Type \"none\" if your endpoint doesn't require one.",
				);
				if (!apiKey) return;
				const oneModelId = await inlinePrompt(
					"Model name",
					"Pick the model you'd like to use first — for example: meta-llama/Llama-3.3-70B-Instruct-Turbo",
				);
				if (!oneModelId) return;

				// Confirmation step — show the user a summary of what we're about
				// to save before we write anything. Catches typos in the URL or
				// model id before they cause failed requests later.
				const maskedKey = apiKey.length > 8
					? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`
					: apiKey === "none"
						? "none"
						: "(hidden)";
				insertBeforeEditor(new Text(`  ${brand.amber("Review:")}`, 0, 0));
				insertBeforeEditor(new Text(`    ${brand.dim("Name:")}     ${brand.white(providerId)}`, 0, 0));
				insertBeforeEditor(new Text(`    ${brand.dim("Endpoint:")} ${brand.white(baseUrl)}`, 0, 0));
				insertBeforeEditor(new Text(`    ${brand.dim("API key:")}  ${brand.white(maskedKey)}`, 0, 0));
				insertBeforeEditor(new Text(`    ${brand.dim("Model:")}    ${brand.white(oneModelId)}`, 0, 0));

				const confirmed = await inlinePick("Save this connection?", [
					{ value: "save", label: "Yes, save and switch", description: "Adds this connection and switches to it now", _value: true },
					{ value: "cancel", label: "No, cancel", description: "Discard everything you typed", _value: false },
				], { primaryWidth: [22, 28] });
				if (!confirmed) {
					insertBeforeEditor(new Text(`  ${brand.dim("Cancelled — nothing was saved.")}`, 0, 0));
					return;
				}

				// Write the custom provider into models.json. We write a single model
				// with conservative defaults; the user can extend the entry by hand
				// for additional models. Reasoning is heuristic — set true if the id
				// hints at a reasoning model.
				const guessReasoning =
					/o[13]\b/i.test(oneModelId) || /r1\b/i.test(oneModelId) || /think/i.test(oneModelId) || /qwen[23]/i.test(oneModelId);
				const fs = await import("node:fs/promises");
				const modelsPath = path.join(BRIGADE_DIR, "models.json");
				let existing: { providers?: Record<string, any> } = { providers: {} };
				try {
					existing = JSON.parse(await fs.readFile(modelsPath, "utf8"));
					if (!existing.providers) existing.providers = {};
				} catch {
					/* file missing — start fresh */
				}
				existing.providers![providerId] = {
					baseUrl: baseUrl.replace(/\/$/, ""),
					api: "openai-completions",
					apiKey,
					models: [
						{
							id: oneModelId,
							name: oneModelId,
							reasoning: guessReasoning,
							input: ["text"],
							contextWindow: 32_768,
							maxTokens: 8_192,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				};
				try {
					await fs.writeFile(modelsPath, JSON.stringify(existing, null, 2), "utf8");
					modelRegistry.refresh();
				} catch (err) {
					insertBeforeEditor(
						new Text(`  ${brand.error("✗")} ${brand.error(`Couldn't save the connection: ${err instanceof Error ? err.message : String(err)}`)}`, 0, 0),
					);
					return;
				}
				insertBeforeEditor(
					new Text(`  ${brand.amber("✓")} ${brand.dim(`Connected ${providerId} · switching to ${oneModelId}…`)}`, 0, 0),
				);
				renderMultiProviderTip();
				await switchToModel(providerId, oneModelId);
				return;
			}

			if (picked.local && picked.id === "ollama") {
				const baseUrl = picked.baseUrl ?? "http://localhost:11434";
				insertBeforeEditor(new Text(`  ${brand.dim("Scanning Ollama…")}`, 0, 0));
				let discovered;
				try {
					discovered = await discoverOllamaModels(baseUrl);
				} catch (err) {
					insertBeforeEditor(
						new Text(`  ${brand.error("✗")} ${brand.error(err instanceof Error ? err.message : String(err))}`, 0, 0),
					);
					return;
				}
				try {
					await writeOllamaToModelsJson(path.join(BRIGADE_DIR, "models.json"), baseUrl, discovered);
					modelRegistry.refresh();
				} catch (err) {
					insertBeforeEditor(
						new Text(`  ${brand.error("✗")} ${brand.error(`Couldn't save the connection: ${err instanceof Error ? err.message : String(err)}`)}`, 0, 0),
					);
					return;
				}
				insertBeforeEditor(
					new Text(`  ${brand.amber("✓")} ${brand.dim(`Ollama connected · ${discovered.length} model${discovered.length === 1 ? "" : "s"} ready. Switching…`)}`, 0, 0),
				);
				renderMultiProviderTip();
				// Auto-switch to the first discovered model.
				if (discovered[0]) await switchToModel("ollama", discovered[0].id);
				return;
			}

			// Remote provider — collect API key inline, validate, save.
			const key = await inlinePrompt(
				`Paste your ${picked.name} API key`,
				`We'll keep it private to this device.  Need a key? ${picked.keyUrl}`,
			);
			if (!key) return;
			if (key.length < 16 || /\s/.test(key)) {
				insertBeforeEditor(
					new Text(`  ${brand.error("✗ That doesn't look right — try copying the key again.")}`, 0, 0),
				);
				return;
			}

			const validating = new CancellableLoader(
				tui,
				(s) => brand.amber(s),
				(s) => brand.dim(s),
				`Connecting to ${picked.name}…`,
			);
			insertBeforeEditor(validating);
			const onlineCheck = await validateApiKeyOnline(picked.id, key);
			removeChild(validating);

			if (!onlineCheck.ok) {
				insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(onlineCheck.reason)}`, 0, 0));
				return;
			}

			authStorage.set(picked.id, { type: "api_key", key });
			authStorage.reload();
			modelRegistry.refresh();

			// Auto-switch to a sensible default model from the new provider —
			// reasoning-first, then largest context window.
			const newModels = modelRegistry.getAvailable().filter((m) => m.provider === picked.id);
			if (newModels.length === 0) {
				insertBeforeEditor(
					new Text(
						`  ${brand.amber("✓")} ${brand.dim(`${picked.name} connected, but no models are available right now. Try /model later.`)}`,
						0,
						0,
					),
				);
				renderMultiProviderTip();
				return;
			}
			const sorted = [...newModels].sort((a, b) => {
				if (!!a.reasoning !== !!b.reasoning) return a.reasoning ? -1 : 1;
				return (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
			});
			insertBeforeEditor(
				new Text(`  ${brand.amber("✓")} ${brand.dim(`${picked.name} connected · switching to ${sorted[0]!.id}…`)}`, 0, 0),
			);
			renderMultiProviderTip();
			await switchToModel(picked.id, sorted[0]!.id);
			return;
		}

		// /thinking [level] — reads or sets the model's reasoning effort.
		// Pi clamps to model capabilities (e.g. "off" gets coerced for non-reasoning
		// models), so we can pass through the user's choice and let Pi decide what's
		// actually applicable. Without args, reports current state + valid options.
		if (trimmed === "/thinking" || trimmed.startsWith("/thinking ")) {
			editor.setText("");
			if (!session.supportsThinking()) {
				insertBeforeEditor(
					new Text(
						`  ${brand.dim(`This model (${modelId}) does not support thinking — nothing to set.`)}`,
						0,
						0,
					),
				);
				return;
			}
			const arg = trimmed === "/thinking" ? "" : trimmed.slice("/thinking ".length).trim().toLowerCase();
			const available = session.getAvailableThinkingLevels();
			if (!arg) {
				insertBeforeEditor(
					new Text(
						`  ${brand.dim("thinking is")} ${brand.amber(session.thinkingLevel)} ${brand.dim("· available:")} ${brand.dim(available.join(" "))}`,
						0,
						0,
					),
				);
				return;
			}
			if (!VALID_THINKING_LEVELS.includes(arg as ThinkingLevelName)) {
				insertBeforeEditor(
					new Text(
						`  ${brand.error(`✗ unknown level "${arg}".`)} ${brand.dim(`Try one of: ${available.join(", ")}`)}`,
						0,
						0,
					),
				);
				return;
			}
			if (!available.includes(arg as ThinkingLevelName)) {
				insertBeforeEditor(
					new Text(
						`  ${brand.error(`✗ "${arg}" is not supported on ${modelId}.`)} ${brand.dim(`Available: ${available.join(", ")}`)}`,
						0,
						0,
					),
				);
				return;
			}
			session.setThinkingLevel(arg as ThinkingLevelName);
			updateHeader();
			insertBeforeEditor(
				new Text(
					`  ${brand.amber("✓")} ${brand.dim("thinking set to")} ${brand.amber(arg)}`,
					0,
					0,
				),
			);
			return;
		}

		// echo user message
		insertBeforeEditor(new Markdown(`${brand.user("you")}  ${trimmed}`, 1, 0, markdownTheme));
		editor.setText("");

		try {
			// Build the fallback chain from config. F:\Brigade's brigade.json
			// stores `agents.defaults.model.fallbacks` (an array); the lifted
			// code expected the older flat `cfg.fallbackProvider` /
			// `cfg.fallbackModelId` fields. Read the new shape and project to
			// the older single-fallback API the wrappers below consume.
			const cfg = await loadConfig();
			const wizardModel = (cfg.agents as { defaults?: { provider?: string; model?: { fallbacks?: string[] } } } | undefined)?.defaults;
			const fallbackProvider: string | undefined = wizardModel?.provider;
			const fallbackModelId: string | undefined = wizardModel?.model?.fallbacks?.[0];
			const fallbackModel =
				fallbackProvider && fallbackModelId
					? modelRegistry.find(fallbackProvider, fallbackModelId)
					: undefined;

			// Compose the loop wrappers from the inside out:
			//   1. session.prompt()         — Pi's actual loop
			//   2. runWithStreamTimeout()   — aborts if the loop goes silent for 60s
			//   3. runWithFallback()        — on hard error, walks the fallback chain
			// Order matters: timeout wraps the prompt INSIDE fallback, so each
			// fallback attempt gets its own fresh 60s watcher.
			await runWithFallback(session, trimmed, {
				fallbacks: fallbackModel ? [{ model: fallbackModel }] : [],
				// Per-attempt wrappers. Composition (outer → inner):
				//   1. runWithHeartbeat            — every 30s of silence, show "still
				//                                    working… Ns elapsed" so the user
				//                                    knows we're alive (esp. local 30B
				//                                    models that take minutes per turn)
				//   2. runWithStreamTimeout        — abort after per-provider idle threshold
				//                                    (60s cloud / 5min Ollama)
				//   3. runWithContentQualityRetry  — re-prompt with a steer if the model
				//                                    returned empty / reasoning-only /
				//                                    planning-only output
				//   4. runWithThinkingFallback     — auto-downgrade thinking on rejection
				//   5. session.prompt              — Pi's actual loop
				wrapAttempt: (promptFn) =>
					runWithHeartbeat(
						session,
						() =>
							runWithStreamTimeout(
								session,
								() =>
									runWithLengthContinuation(
										session,
										() =>
											runWithContentQualityRetry(
												session,
												() =>
													runWithThinkingFallback(session, promptFn, {
														onDowngrade: (originalLevel) => {
															insertBeforeEditor(
																new Text(
																	`  ${brand.dim(`This model doesn't support thinking — switching from ${originalLevel} to off and retrying…`)}`,
																	0,
																	0,
																),
															);
														},
													}),
										{
											onRetry: (reason) => {
												const label =
													reason === "empty"
														? "no visible answer — re-prompting"
														: reason === "reasoning-only"
															? "model emitted only reasoning — asking for visible answer"
															: "model described an action but didn't take it — asking it to actually do it";
												insertBeforeEditor(
													new Text(`  ${brand.dim(`↻ ${label}…`)}`, 0, 0),
												);
											},
										},
									),
									{
										onContinue: () => {
											insertBeforeEditor(
												new Text(
													`  ${brand.dim("↻ reply was truncated — asking the model to continue…")}`,
													0,
													0,
												),
											);
										},
									},
								),
								{
									// Per-provider timeout. Cloud non-reasoning: 60s; cloud
									// reasoning: 180s; Ollama: 5min; custom: 3min.
									idleMs: session.model ? pickStreamIdleMs(session.model) : 60_000,
									onTimeout: (ms) => {
										insertBeforeEditor(
											new Text(
												`  ${brand.dim(`⏳ no response for ${Math.round(ms / 1000)}s — aborting…`)}`,
												0,
												0,
											),
										);
									},
								},
							),
						{
							intervalMs: 30_000,
							onHeartbeat: (ms) => {
								const sec = Math.round(ms / 1000);
								insertBeforeEditor(
									new Text(`  ${brand.dim(`still working… ${sec}s elapsed`)}`, 0, 0),
								);
							},
						},
					),
				onFallback: (reason: string) => {
					insertBeforeEditor(
						new Text(
							`  ${brand.dim(`↻ primary failed (${friendlyError(reason, cleanProviderError)}) — trying ${cfg.fallbackModelId}…`)}`,
							0,
							0,
						),
					);
				},
				onFallbackExhausted: (reason: string) => {
					insertBeforeEditor(
						new Text(
							`  ${brand.error("✗ all fallback models failed:")} ${brand.error(friendlyError(reason, cleanProviderError))}`,
							0,
							0,
						),
					);
				},
			});
		} catch (err: unknown) {
			// Provider errors arrive here when the request itself throws (vs being
			// captured into an assistant message and surfaced via agent_end). They're
			// often nested-JSON blobs — clean them before showing.
			//
			// We reset isAgentRunning + disableSubmit defensively because some error
			// paths fire BEFORE `agent_start` (e.g. sync auth-resolver failures), so
			// the `agent_end` event handler never runs. Re-assigning false when it's
			// already false is a no-op, so this is safe even when agent_end did fire.
			const raw = err instanceof Error ? err.message : String(err);
			const msg = friendlyError(raw, cleanProviderError);
			insertBeforeEditor(new Text(`  ${brand.error("✗")} ${brand.error(msg)}`, 0, 0));
			isAgentRunning = false;
			editor.disableSubmit = false;
			updateHeader();
		}
	};

	// NOTE: tui.start() is called once in index.ts BEFORE splash + onboarding,
	// so the renderer is already alive by the time we get here. Don't start twice.
	// Likewise, the SIGINT handler is wired ONCE at the top level (index.ts) and
	// delegates here via the returned ChatHandle — preventing handler stacking.
	tui.requestRender();

	// Optional first-run kickoff. Caller (post-onboard chat boot) passes
	// `kickoffMessage` only when the workspace is truly fresh (BOOTSTRAP.md
	// just seeded), so the agent reads BOOTSTRAP.md from its system prompt
	// and opens the "who am I, who are you?" name-discovery conversation
	// instead of sitting silently waiting for the user to type first.
	//
	// We dispatch through `editor.onSubmit` (the same surface a real Enter
	// keypress hits) instead of calling `session.prompt` directly, so the
	// turn flows through every wrapper (timeout, heartbeat, fallback chain,
	// content-quality retry, …) just like a user-typed turn would. The
	// kickoff message also renders as a normal "you" bubble in the
	// conversation log, keeping the UI honest about what was sent.
	//
	// Fire-and-forget on a microtask so we return the ChatHandle promptly —
	// the caller can wire SIGINT against the handle while the kickoff turn
	// is still streaming.
	const kickoff = opts.kickoffMessage?.trim();
	if (kickoff && editor.onSubmit) {
		const dispatchKickoff = editor.onSubmit;
		queueMicrotask(() => {
			void dispatchKickoff(kickoff);
		});
	}

	// First-run discoverability tip. Only shown on a truly fresh workspace
	// (same signal that gates the kickoff) so returning users don't see it
	// every boot. The slash command list mirrors the editor footer hint,
	// minus /help itself (we tell them how to find /help so they can read
	// the full list).
	if (opts.firstRun) {
		insertBeforeEditor(
			new Text(
				`  ${brand.dim("tip: type /help for slash commands (/model · /provider · /thinking · /compact)")}`,
				0,
				0,
			),
		);
	}

	return {
		abort: () => {
			if (!isAgentRunning) return false;
			session.abort().catch(() => {});
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
		isRunning: () => isAgentRunning,
	};
}

/* ────────────────────────────── helpers ──────────────────────────────── */

function formatToolArgs(name: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	if (args.path) return String(args.path);
	if (args.command) return String(args.command).slice(0, 60);
	if (args.pattern) return String(args.pattern);
	if (args.query) return `"${String(args.query)}"`;
	const keys = Object.keys(args);
	if (keys.length === 0) return "";
	return keys
		.slice(0, 2)
		.map((k) => `${k}=${JSON.stringify(args[k]).slice(0, 30)}`)
		.join(" ");
}
