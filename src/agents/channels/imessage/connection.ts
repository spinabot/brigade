/**
 * iMessage transport connection — the live `imsg rpc` subprocess lifecycle.
 *
 * `connectIMessage` owns a long-lived {@link IMessageRpcLike} client, subscribes
 * to inbound notifications (`watch.subscribe`), runs each `message` notification
 * through the monitor's gating brain (`decideInbound`), and hands dispatched
 * inbounds to `onMessage`. It also exposes the outbound `sendText` / `sendMedia`
 * (which `remember` every send in the echo cache so the inbound poll drops the
 * echo) + reconnect with the shared jittered backoff.
 *
 * TEST SEAM: `clientFactory` builds the RPC client — production lets it default
 * to the real {@link createIMessageRpcClient} (which itself refuses to spawn in
 * tests); a unit test injects a fake satisfying {@link IMessageRpcLike}. The
 * adapter layers a second seam (`connectImpl`) on top, mirroring Discord. No
 * `isTestEnv` flag is consulted here — the seam is pure dependency injection.
 */

import { nextBackoffDelay } from "../sdk.js";
import {
	resolveIMessageAttachmentRoots,
	resolveIMessageRemoteAttachmentRoots,
	type ResolvedIMessageAccount,
} from "./account-config.js";
import {
	createIMessageRpcClient,
	type IMessageRpcLike,
	type IMessageRpcNotification,
} from "./client.js";
import { IMessageHistoryBuffer, renderIMessageHistoryBlock } from "./history.js";
import { inferOutboundMediaKind, resolveInboundAttachments, resolveInboundAttachmentsRemote } from "./media.js";
import {
	createMonitorState,
	decideInbound,
	echoScope,
	normalizeHandle,
	normalizeIMessageMessage,
	parseIMessageNotification,
	type MonitorState,
	type NormalizedIMessage,
} from "./monitor.js";
import { probeIMessage, type IMessageProbeResult } from "./probe.js";
import {
	detectRemoteHostFromCliPath,
	normalizeScpRemoteHost,
	type ScpCopyArgs,
	type ReadFileLike,
} from "./remote-attachments.js";
import { sendMessageIMessage, type IMessageSendResult } from "./send.js";
import { sanitizeIMessageWatchErrorPayload } from "./watch-error.js";
import type { BrigadeConfig } from "../sdk.js";
import type { OutboundMedia, OutboundSendOptions, InboundMediaAttachment } from "../sdk.js";

/** Reconnect schedule constants — mirror the shared WhatsApp curve. */
const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_JITTER = 0.25;
const RECONNECT_MAX_ATTEMPTS = 12;

/** Watch-subscribe startup retry — 3 quick attempts before falling to backoff. */
const WATCH_SUBSCRIBE_MAX_ATTEMPTS = 3;
const WATCH_SUBSCRIBE_RETRY_DELAY_MS = 1_000;

/** Transport-readiness gate — poll `probeIMessage` until the bridge is up. */
const TRANSPORT_READY_TIMEOUT_MS = 30_000;
const TRANSPORT_READY_POLL_INTERVAL_MS = 500;
const TRANSPORT_READY_LOG_INTERVAL_MS = 10_000;

/** Transient startup errors worth a quick subscribe retry (vs the slow backoff loop). */
function isRetriableSubscribeStartupError(error: unknown): boolean {
	return /imsg rpc timeout \(watch\.subscribe\)|imsg rpc (closed|exited|not running)/i.test(String(error));
}

/** The inbound message the connection hands the adapter (carries the deferred-media thunk). */
export interface IMessageInboundMessage extends NormalizedIMessage {
	/** Deferred inbound-media resolver (invoked only after the access gate admits the sender). */
	resolveMedia?: () => Promise<InboundMediaAttachment[]>;
	/**
	 * Rolling-history context block (`[recent conversation context]…`) to PREPEND
	 * to the body, set for an untagged group message when `historyLimit > 0`. The
	 * adapter folds it into the dispatched text. Unset when no context applies.
	 */
	historyContext?: string;
}

/** Args for {@link connectIMessage}. */
export interface ConnectIMessageArgs {
	account: ResolvedIMessageAccount;
	/** Active config — used to resolve inbound attachment roots per message. */
	loadConfig: () => BrigadeConfig;
	log: (msg: string, meta?: Record<string, unknown>) => void;
	/** Fired once the subscription is live. */
	onConnected?: () => void;
	/** Fired when the transport gives up (binary gone / fatal). */
	onClosed?: (reason: string) => void;
	/** Dispatched inbound (post gating + dedupe). */
	onMessage: (msg: IMessageInboundMessage) => void;
	signal?: AbortSignal;
	/** TEST SEAM: build the RPC client. Defaults to the real subprocess client. */
	clientFactory?: (opts: {
		cliPath: string;
		dbPath?: string;
		onNotification: (msg: IMessageRpcNotification) => void;
		runtime: { error?: (m: string) => void; info?: (m: string) => void };
	}) => Promise<IMessageRpcLike>;
	/** TEST SEAM: replace the real `sendMessageIMessage` (so outbound tests need no client). */
	sendImpl?: typeof sendMessageIMessage;
	/** TEST SEAM: replace the backoff sleep (instant reconnect in tests). */
	sleepImpl?: (ms: number) => Promise<void>;
	/**
	 * TEST SEAM: probe the transport readiness (the cold-bridge gate before the
	 * first subscribe). Defaults to the real `probeIMessage`.
	 */
	probeImpl?: (args: { cliPath: string; dbPath?: string; timeoutMs?: number }) => Promise<IMessageProbeResult>;
	/** TEST SEAM: read an SSH-wrapper `cliPath` for remote-host auto-detection. */
	readFileImpl?: ReadFileLike;
	/** TEST SEAM: run the `scp` copy for a remote-host inbound attachment. */
	scpRunner?: ScpCopyArgs["scpRunner"];
	/** TEST SEAM: temp-dir factory for the remote-attachment copy. */
	mkdtempImpl?: ScpCopyArgs["mkdtempImpl"];
}

/** The live connection handle the adapter drives. */
export interface IMessageConnection {
	isConnected(): boolean;
	connectedAt(): number | null;
	/**
	 * The last error the WATCH reported, if any.
	 *
	 * Distinct from a transport close: the subprocess is alive and the socket is
	 * fine, but the thing that reads chat.db has failed — so `isConnected()` is
	 * true while no message will ever arrive again. Exposed so `health()` can
	 * say that instead of reporting ok.
	 */
	lastWatchError(): string | undefined;
	/** Send text; returns the bridge message id when available. */
	sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<{ messageId?: string }>;
	/** Send media; returns the bridge message id when available. */
	sendMedia(conversationId: string, media: OutboundMedia): Promise<{ messageId?: string }>;
	/** Tear down the subprocess + stop reconnecting. */
	close(): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
	});

/**
 * Open the iMessage transport. Resolves once the first subscription is live (or
 * the connect terminally fails). Keeps reconnecting in the background until
 * `close()` / the abort signal fires.
 */
export async function connectIMessage(args: ConnectIMessageArgs): Promise<IMessageConnection> {
	const { account } = args;
	const state: MonitorState = createMonitorState();
	const sleep = args.sleepImpl ?? defaultSleep;
	const sendFn = args.sendImpl ?? sendMessageIMessage;
	const probe = args.probeImpl ?? ((a) => probeIMessage(a));
	const clientFactory =
		args.clientFactory ??
		(async (opts) =>
			createIMessageRpcClient({
				cliPath: opts.cliPath,
				...(opts.dbPath ? { dbPath: opts.dbPath } : {}),
				onNotification: opts.onNotification,
				runtime: opts.runtime,
			}));

	// Rolling per-conversation history buffer (untagged group-message context).
	const history = new IMessageHistoryBuffer();

	let client: IMessageRpcLike | null = null;
	let connected = false;
	let connectedAtMs: number | null = null;
	let lastWatchError: string | undefined;
	let closed = false;
	let attempt = 0;

	// Resolve the remote host once: explicit config wins; else auto-detect from an
	// SSH-wrapper `cliPath`. Only a safety-validated host is accepted (so it can
	// never inject an option/arg into the SCP command). Empty ⇒ same-host setup.
	let remoteHost = normalizeScpRemoteHost(account.remoteHost);
	if (account.remoteHost && !remoteHost) {
		args.log("imessage: ignoring unsafe channels.imessage.remoteHost value");
	}
	if (!remoteHost && account.cliPath && account.cliPath !== "imsg") {
		const detected = await detectRemoteHostFromCliPath(
			account.cliPath,
			...(args.readFileImpl ? [args.readFileImpl] : []),
		);
		const normalizedDetected = normalizeScpRemoteHost(detected);
		if (detected && !normalizedDetected) {
			args.log("imessage: ignoring unsafe auto-detected remoteHost from cliPath");
		}
		remoteHost = normalizedDetected;
		if (remoteHost && account.verbose) args.log(`imessage: detected remoteHost=${remoteHost} from cliPath`);
	}

	const handleNotification = (msg: IMessageRpcNotification): void => {
		// Wrap the whole handler so a synchronous throw (malformed payload, a
		// decideInbound bug, a downstream onMessage error) can NEVER escape into the
		// RPC client's notification loop and wedge the watch / crash the gateway.
		// The transport keeps reading; a single bad notification is logged + dropped.
		try {
			if (msg.method === "error") {
				// Sanitize before logging — the payload is attacker-influenced (a
				// crafted row / remote bridge could smuggle ANSI escapes or a huge
				// blob). Keep only a finite code + a stripped/truncated message.
				const sanitized = sanitizeIMessageWatchErrorPayload(msg.params);
				args.log("imessage watch error", { error: sanitized });
				// A DEAD WATCH MUST NOT REPORT HEALTHY.
				//
				// This was logged and nothing else: `connected` stayed true and
				// `health()` kept returning ok, so a watch that had died — chat.db
				// unreadable, Full Disk Access revoked mid-run, the watcher thread
				// gone — presented as a working channel that simply never received
				// anything. Silence is the one symptom an operator cannot
				// distinguish from "nobody messaged me".
				//
				// Recorded so `health()` can degrade and say what happened. The
				// supervise loop owns reconnection; this makes the state visible
				// rather than pretending it away.
				lastWatchError = sanitized.message ?? "the imsg watch reported an error";
				return;
			}
			if (msg.method !== "message") return;
			const payload = parseIMessageNotification(msg.params);
			if (!payload) {
				args.log("dropping malformed iMessage payload");
				return;
			}
			// `selfHandle` lets a group message naming the bot populate `mentions[]`
			// so the central group requireMention gate can fire.
			const decision = decideInbound(state, account.accountId, payload, account.selfHandle);
			if (decision.kind === "drop") {
				if (account.verbose) args.log(`inbound dropped: ${decision.reason}`);
				return;
			}
			const normalized = decision.message;
			// Rolling-history context: for an UNTAGGED group message (no self-mention,
			// not a reply) attach the last N seen messages as a fenced context block,
			// then record THIS message for the next turn. iMessage's `imsg rpc`
			// transport exposes no history method, so this is a pure in-memory buffer
			// of messages the monitor has already seen (mirrors the upstream monitor).
			const isUntaggedGroup =
				normalized.isGroup && (!normalized.mentions || normalized.mentions.length === 0) && !normalized.replyTo;
			if (account.historyLimit > 0 && isUntaggedGroup && normalized.text.trim()) {
				const entries = history.recent(normalized.conversationId, account.historyLimit);
				const block = renderIMessageHistoryBlock(entries);
				if (block) (normalized as IMessageInboundMessage).historyContext = block;
			}
			if (normalized.isGroup) {
				history.record(normalized.conversationId, {
					sender: normalized.fromName || normalized.from || "Unknown",
					body: normalized.text,
				});
			}
			// Deferred media — resolve only after the central access gate admits the
			// sender (the bridge has already saved the bytes to disk; we just map them).
			const inbound: IMessageInboundMessage = { ...normalized };
			// `includeAttachments:false` opts the account out of inbound media entirely.
			if (account.includeAttachments && Array.isArray(payload.attachments) && payload.attachments.length > 0) {
				const atts = payload.attachments;
				inbound.resolveMedia = remoteHost
					? async () => {
							const remoteRoots = resolveIMessageRemoteAttachmentRoots(args.loadConfig(), account.accountId);
							return resolveInboundAttachmentsRemote(atts, {
								remoteHost: remoteHost as string,
								remoteRoots,
								...(args.scpRunner ? { scpRunner: args.scpRunner } : {}),
								...(args.mkdtempImpl ? { mkdtempImpl: args.mkdtempImpl } : {}),
								log: (m) => args.log(m),
							});
						}
					: async () => {
							const roots = resolveIMessageAttachmentRoots(args.loadConfig(), account.accountId);
							return resolveInboundAttachments(atts, roots);
						};
			}
			args.onMessage(inbound);
		} catch (err) {
			args.log("imessage notification handler threw (dropped, loop continues)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	/** Build a client + issue one `watch.subscribe`. Throws on failure (client torn down). */
	const subscribeAttempt = async (): Promise<IMessageRpcLike> => {
		const c = await clientFactory({
			cliPath: account.cliPath,
			...(account.dbPath ? { dbPath: account.dbPath } : {}),
			onNotification: handleNotification,
			runtime: {
				error: (m) => args.log(m),
				info: (m) => account.verbose && args.log(m),
			},
		});
		try {
			await c.request(
				"watch.subscribe",
				{ attachments: account.includeAttachments },
				{ timeoutMs: account.probeTimeoutMs },
			);
		} catch (err) {
			// Tear down the failed client before rethrowing so a slow subscribe
			// can't keep emitting notifications into the next attempt's window.
			try {
				await c.stop();
			} catch {
				/* best-effort */
			}
			throw err;
		}
		return c;
	};

	/**
	 * Subscribe with a short 3× startup retry (≈1s apart, tearing the client down
	 * between attempts) on transient startup errors, BEFORE the slow reconnect
	 * backoff loop takes over. A cold `imsg` bridge often fails the very first
	 * subscribe; this rides over it without waiting the full backoff.
	 */
	const subscribeOnce = async (): Promise<void> => {
		let lastErr: unknown;
		for (let i = 1; i <= WATCH_SUBSCRIBE_MAX_ATTEMPTS; i++) {
			if (closed || args.signal?.aborted) return;
			try {
				client = await subscribeAttempt();
				connected = true;
				connectedAtMs = Date.now();
				attempt = 0;
				args.onConnected?.();
				return;
			} catch (err) {
				lastErr = err;
				const canRetry = i < WATCH_SUBSCRIBE_MAX_ATTEMPTS && isRetriableSubscribeStartupError(err);
				if (!canRetry) throw err;
				args.log(
					`imessage: watch.subscribe startup failed (attempt ${i}/${WATCH_SUBSCRIBE_MAX_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}; retrying`,
				);
				await sleep(WATCH_SUBSCRIBE_RETRY_DELAY_MS);
			}
		}
		throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
	};

	/**
	 * Poll `probeIMessage` until the `imsg` bridge is reachable (or the timeout
	 * elapses), so a cold bridge surfaces as a "waiting for transport" log rather
	 * than an immediate connect failure. A FATAL probe (old binary) is rethrown.
	 * Returns true when ready, false on timeout / abort.
	 */
	const waitForTransportReady = async (): Promise<boolean> => {
		const started = Date.now();
		let nextLogAt = started + TRANSPORT_READY_LOG_INTERVAL_MS;
		while (!closed && !args.signal?.aborted) {
			let result: IMessageProbeResult;
			try {
				result = await probe({
					cliPath: account.cliPath,
					...(account.dbPath ? { dbPath: account.dbPath } : {}),
					timeoutMs: account.probeTimeoutMs,
				});
			} catch (err) {
				result = { ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: 0 };
			}
			if (result.ok) return true;
			if (result.fatal) throw new Error(result.error ?? "imsg rpc unavailable");
			const now = Date.now();
			if (now - started >= TRANSPORT_READY_TIMEOUT_MS) return false;
			if (now >= nextLogAt) {
				args.log(`imessage: waiting for transport (imsg bridge not ready: ${result.error ?? "unreachable"})`);
				nextLogAt = now + TRANSPORT_READY_LOG_INTERVAL_MS;
			}
			await sleep(TRANSPORT_READY_POLL_INTERVAL_MS);
		}
		return false;
	};

	/** Background supervise loop — reconnect with jittered backoff until closed. */
	const supervise = async (): Promise<void> => {
		while (!closed && !args.signal?.aborted) {
			try {
				if (!connected) await subscribeOnce();
				// Block on the client closing; on close, fall through to reconnect.
				await client?.waitForClose();
			} catch (err) {
				args.log("imessage connect attempt failed", { error: err instanceof Error ? err.message : String(err) });
			}
			connected = false;
			try {
				await client?.stop();
			} catch {
				/* best-effort */
			}
			client = null;
			if (closed || args.signal?.aborted) break;
			attempt += 1;
			if (attempt > RECONNECT_MAX_ATTEMPTS) {
				args.onClosed?.(`gave up after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts`);
				break;
			}
			const delay = nextBackoffDelay({
				attempt,
				initialMs: RECONNECT_INITIAL_MS,
				maxMs: RECONNECT_MAX_MS,
				factor: RECONNECT_FACTOR,
				jitter: RECONNECT_JITTER,
			});
			await sleep(delay);
		}
	};

	// First connect — gate on transport readiness (a cold `imsg` bridge logs
	// "waiting for transport" instead of failing immediately), then subscribe.
	// Surface a failure to the caller; keep the loop running after.
	await waitForTransportReady();
	await subscribeOnce();
	void supervise();

	if (args.signal) {
		if (args.signal.aborted) closed = true;
		else args.signal.addEventListener("abort", () => void close(), { once: true });
	}

	const remember = (conversationId: string, sent: IMessageSendResult): void => {
		// Build the same scope the inbound poll keys on so the echo is suppressed.
		const numericChat = conversationId.startsWith("chat:") ? Number.parseInt(conversationId.slice(5), 10) : NaN;
		const scope = Number.isFinite(numericChat)
			? echoScope(account.accountId, { chat_id: numericChat })
			// Normalised the SAME way the inbound scope is, or the two disagree
			// on casing/phone punctuation and the echo is never suppressed.
			: `${account.accountId}:imessage:${normalizeHandle(conversationId)}`;
		state.sentMessageCache.remember(scope, { text: sent.sentText, messageId: sent.messageId });
	};

	async function close(): Promise<void> {
		if (closed) return;
		closed = true;
		try {
			await client?.stop();
		} catch {
			/* best-effort */
		}
		client = null;
		connected = false;
	}

	return {
		isConnected: () => connected,
		lastWatchError: () => lastWatchError,
		connectedAt: () => connectedAtMs,
		async sendText(conversationId, text, opts): Promise<{ messageId?: string }> {
			const result = await sendFn(conversationId, text, {
				cliPath: account.cliPath,
				...(account.dbPath ? { dbPath: account.dbPath } : {}),
				service: account.service,
				region: account.region,
				maxBytes: account.mediaMaxBytes,
				timeoutMs: account.probeTimeoutMs,
				...(client ? { client } : {}),
				...(opts?.replyToId ? { replyToId: opts.replyToId } : {}),
			});
			remember(conversationId, result);
			return result.messageId ? { messageId: result.messageId } : {};
		},
		async sendMedia(conversationId, media): Promise<{ messageId?: string }> {
			const result = await sendFn(conversationId, media.caption ?? "", {
				cliPath: account.cliPath,
				...(account.dbPath ? { dbPath: account.dbPath } : {}),
				service: account.service,
				region: account.region,
				maxBytes: account.mediaMaxBytes,
				timeoutMs: account.probeTimeoutMs,
				mediaPath: media.path,
				mediaKind: inferOutboundMediaKind(media),
				...(client ? { client } : {}),
			});
			remember(conversationId, result);
			return result.messageId ? { messageId: result.messageId } : {};
		},
		close,
	};
}

export { normalizeIMessageMessage };
