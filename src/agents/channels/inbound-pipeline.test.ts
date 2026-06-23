/**
 * Pipeline-level tests for the new channel commands wired into
 * `buildBundledCommands`:
 *
 *   - `/agent <id>` writes a peer binding to brigade.json and the next
 *     inbound from the same peer routes to the pinned agent via tier-1
 *     `binding.peer` of the resolver (no LLM turn runs for the slash
 *     command itself).
 *   - `cmdCtx` carries `accountId` + `isGroup` so the slash handler can
 *     build the correct peer scope without re-deriving it.
 *
 * These tests exercise the same `startChannels` path the gateway uses, with
 * a controllable fake channel adapter that captures sent text.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import { __resetConfigParseCacheForTests } from "../../config/io.js";
import { loadConfig } from "../../core/config.js";
import type {
	ChannelAdapter,
	ChannelCommandContext,
	ChannelStartContext,
	InboundMessage,
	OutboundSendOptions,
} from "../extensions/types.js";
import {
	buildBundledCommands,
	runChannelInboundPipeline,
	createInboundPipelineContext,
} from "./inbound-pipeline.js";
import { readChannelOwner, setChannelOwner } from "./access-control/index.js";
import {
	registerChannelSecurityAdapter,
	resetChannelSecurityRegistryForTests,
} from "./channel-security-registry.js";
import { startChannels } from "./manager.js";
import { BrigadeExtensionRegistry } from "../extensions/registry.js";
import { setActiveRegistry } from "../extensions/active-registry.js";
import type { BrigadeHookName } from "../extensions/hook-runner.js";
import type { HookResult } from "../extensions/types.js";

let stateDir: string;
let prevStateDir: string | undefined;

function writeConfig(cfg: unknown): void {
	writeFileSync(join(stateDir, "brigade.json"), JSON.stringify(cfg, null, 2));
}

const ACL_OPEN = { channels: { fake: { dmPolicy: "open" } } } as unknown as BrigadeConfig;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-pipeline-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
	__resetConfigParseCacheForTests();
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(stateDir, { recursive: true, force: true });
	__resetConfigParseCacheForTests();
	// Always clear the process-wide registry singleton so a hook registered by
	// one test can never leak into another.
	setActiveRegistry(undefined);
	// Same for the channel-security registry (the supplementary DM-policy consult).
	resetChannelSecurityRegistryForTests();
});

/**
 * Mount a fresh registry as the active singleton with a single hook handler
 * for `event`. Returns the registry so the test can read it back if needed.
 * The `afterEach` above clears it.
 */
function mountRegistryWithHook(
	event: BrigadeHookName,
	handler: (payload: unknown) => HookResult | void | Promise<HookResult | void>,
): BrigadeExtensionRegistry {
	const reg = new BrigadeExtensionRegistry();
	const b = reg.context({
		agentId: "main",
		workspaceDir: join(stateDir, "ws"),
		cwd: join(stateDir, "ws"),
		config: {} as BrigadeConfig,
	});
	b.hook(event, handler as (...args: unknown[]) => unknown);
	setActiveRegistry(reg);
	return reg;
}

function makeFakeChannel(overrides: Partial<ChannelAdapter> = {}): {
	adapter: ChannelAdapter;
	ctx: () => ChannelStartContext;
	sent: { conversationId: string; text: string }[];
	sentWithOpts: { conversationId: string; text: string; opts?: OutboundSendOptions }[];
} {
	let ctx: ChannelStartContext | undefined;
	const sent: { conversationId: string; text: string }[] = [];
	const sentWithOpts: { conversationId: string; text: string; opts?: OutboundSendOptions }[] = [];
	const adapter: ChannelAdapter = {
		id: "fake",
		label: "Fake",
		isConfigured: () => true,
		async start(c) {
			ctx = c;
		},
		async stop() {
			/* no-op */
		},
		async sendText(conversationId, text, opts) {
			sent.push({ conversationId, text });
			sentWithOpts.push({ conversationId, text, opts });
		},
		...overrides,
	};
	return { adapter, ctx: () => ctx!, sent, sentWithOpts };
}

describe("inbound-pipeline: bundled commands include /agent /agents /whoami", () => {
	it("buildBundledCommands surfaces the four legacy + four new commands", () => {
		const fake = makeFakeChannel();
		const commands = buildBundledCommands(fake.adapter);
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("help"));
		assert.ok(names.includes("status"));
		assert.ok(names.includes("allowlist"));
		assert.ok(names.includes("agent"));
		assert.ok(names.includes("agents"));
		assert.ok(names.includes("whoami"));
		assert.ok(names.includes("org"));
	});

	it("/help mentions the four new commands", () => {
		const fake = makeFakeChannel();
		const commands = buildBundledCommands(fake.adapter);
		const helpCmd = commands.find((c) => c.name === "help");
		assert.ok(helpCmd);
		const ctx = {
			channel: "fake",
			conversationId: "c1",
			from: "u1",
			fromName: "u",
			args: "",
			config: {} as BrigadeConfig,
		} satisfies ChannelCommandContext;
		const out = helpCmd.handler(ctx);
		assert.ok(typeof out === "string");
		assert.match(out, /\/agent /);
		assert.match(out, /\/agents /);
		assert.match(out, /\/whoami/);
		assert.match(out, /\/org /);
	});
});

describe("inbound-pipeline: /agent <id> interception writes binding + suppresses turn", () => {
	it("a /agent <id> message is handled by the slash handler, not the LLM", async () => {
		writeConfig({
			agents: { main: {}, ops: {} },
			channels: { fake: { dmPolicy: "open" } },
		});
		const fake = makeFakeChannel();
		let turnRan = false;
		const mgr = await startChannels({
			adapters: [fake.adapter],
			config: loadConfig(),
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "should not happen" };
			},
		});
		await fake.ctx().onInbound({
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "/agent ops",
		});
		assert.equal(turnRan, false, "slash command must not trigger a turn");
		assert.equal(fake.sent.length, 1);
		assert.match(fake.sent[0]?.text ?? "", /Pinned \+12025550100 → agent:ops/);

		// On-disk binding written.
		__resetConfigParseCacheForTests();
		const cfg = loadConfig();
		const entries = cfg.bindings?.entries ?? [];
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.agentId, "ops");
		assert.equal(entries[0]?.match?.peer?.id, "+12025550100");
		assert.equal(entries[0]?.match?.peer?.kind, "direct");
		assert.equal(entries[0]?.match?.channel, "fake");
		await mgr.stop();
	});

	it("/agents typed as a slash command lists pins + does not run a turn", async () => {
		writeConfig({
			agents: { main: {}, ops: {} },
			channels: { fake: { dmPolicy: "open" } },
			bindings: {
				entries: [
					{
						agentId: "ops",
						match: {
							channel: "fake",
							accountId: "default",
							peer: { kind: "direct", id: "+12025550100" },
						},
					},
				],
			},
		});
		const fake = makeFakeChannel();
		let turnRan = false;
		const mgr = await startChannels({
			adapters: [fake.adapter],
			config: loadConfig(),
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "should not happen" };
			},
		});
		await fake.ctx().onInbound({
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "/agents",
		});
		assert.equal(turnRan, false);
		assert.match(fake.sent[0]?.text ?? "", /Pins on fake:/);
		assert.match(fake.sent[0]?.text ?? "", /agent:ops/);
		await mgr.stop();
	});
});

describe("inbound-pipeline: native replyToId on the answer send", () => {
	it("the dispatched answer quotes the inbound (opts.replyToId === msg.messageId)", async () => {
		writeConfig({ agents: { main: {} }, channels: { fake: { dmPolicy: "open" } } });
		const fake = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [fake.adapter],
			config: loadConfig(),
			agentId: "main",
			runTurn: async () => ({ reply: "here is my answer" }),
		});
		await fake.ctx().onInbound({
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			messageId: "INBOUND-42",
			text: "what's up?",
		});
		// One reply send carrying the answer, quoting the inbound message id.
		const answer = fake.sentWithOpts.find((s) => s.text === "here is my answer");
		assert.ok(answer, "the agent's answer was sent");
		assert.equal(answer?.opts?.replyToId, "INBOUND-42", "answer natively quotes the inbound");
		await mgr.stop();
	});

	it("back-compat: an inbound with NO messageId yields an answer send with no replyToId", async () => {
		writeConfig({ agents: { main: {} }, channels: { fake: { dmPolicy: "open" } } });
		const fake = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [fake.adapter],
			config: loadConfig(),
			agentId: "main",
			runTurn: async () => ({ reply: "no-id answer" }),
		});
		await fake.ctx().onInbound({
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			// no messageId
			text: "ping",
		});
		const answer = fake.sentWithOpts.find((s) => s.text === "no-id answer");
		assert.ok(answer, "the agent's answer was sent");
		assert.equal(answer?.opts?.replyToId, undefined, "no quote when the inbound has no id");
		await mgr.stop();
	});

	it("a slash-command reply is NOT quoted (only genuine reply-to-inbound sends set replyToId)", async () => {
		writeConfig({ agents: { main: {}, ops: {} }, channels: { fake: { dmPolicy: "open" } } });
		const fake = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [fake.adapter],
			config: loadConfig(),
			agentId: "main",
			runTurn: async () => ({ reply: "should not happen" }),
		});
		await fake.ctx().onInbound({
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			messageId: "INBOUND-7",
			text: "/agent ops",
		});
		// The slash handler's confirmation send must NOT carry a reply quote.
		const cmdReply = fake.sentWithOpts.find((s) => /Pinned/.test(s.text));
		assert.ok(cmdReply, "slash command produced a reply");
		assert.equal(cmdReply?.opts?.replyToId, undefined, "command replies are not quoted");
		await mgr.stop();
	});
});

describe("inbound-pipeline: recorded owner on a separate-bot channel (secure model)", () => {
	const BOT_ID = "bot999"; // adapter.selfId() — the bot, NOT the operator
	const OWNER = "operator123";
	const STRANGER = "stranger456";

	function makeSeparateBotChannel() {
		return makeFakeChannel({
			selfId: () => BOT_ID,
			pairing: { idLabel: "account", botIsSeparateFromOperator: true },
		});
	}

	it("a bare /start NEVER grants ownership — the sender is challenged like any stranger", async () => {
		writeConfig({ agents: { main: {} }, channels: { fake: { dmPolicy: "pairing" } } });
		const fake = makeSeparateBotChannel();
		let turnRan = false;
		const mgr = await startChannels({
			adapters: [fake.adapter],
			config: loadConfig(),
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "nope" };
			},
		});
		await fake.ctx().onInbound({ channel: "fake", conversationId: STRANGER, from: STRANGER, text: "/start" });
		assert.equal(turnRan, false);
		assert.equal(readChannelOwner("fake"), null, "no owner is set just by texting /start");
		assert.match(fake.sent[0]?.text ?? "", /approve/i, "sender gets the approval challenge");
		await mgr.stop();
	});

	it("once an owner is recorded, they are admitted (no challenge) and can run operator commands", async () => {
		writeConfig({ agents: { main: {} }, channels: { fake: { dmPolicy: "pairing" } } });
		// Owner established out-of-band (the CLI `pairing approve` bootstrap path).
		setChannelOwner("fake", OWNER);
		const fake = makeSeparateBotChannel();
		let turnRan = false;
		const mgr = await startChannels({
			adapters: [fake.adapter],
			config: loadConfig(),
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "hi owner" };
			},
		});
		// Normal message → admitted, runs a turn (not challenged).
		await fake.ctx().onInbound({ channel: "fake", conversationId: OWNER, from: OWNER, text: "hello" });
		assert.equal(turnRan, true, "owner's normal message runs a turn");
		// Operator-only command → handler runs (no "operator only" refusal).
		fake.sent.length = 0;
		await fake.ctx().onInbound({ channel: "fake", conversationId: OWNER, from: OWNER, text: "/pending" });
		assert.doesNotMatch(fake.sent[0]?.text ?? "", /only be run by the operator/i);
		await mgr.stop();
	});

	it("a stranger is still challenged after an owner exists", async () => {
		writeConfig({ agents: { main: {} }, channels: { fake: { dmPolicy: "pairing" } } });
		setChannelOwner("fake", OWNER);
		const fake = makeSeparateBotChannel();
		let turnRan = false;
		const mgr = await startChannels({
			adapters: [fake.adapter],
			config: loadConfig(),
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "nope" };
			},
		});
		await fake.ctx().onInbound({ channel: "fake", conversationId: STRANGER, from: STRANGER, text: "hi" });
		assert.equal(turnRan, false);
		assert.match(fake.sent[0]?.text ?? "", /approve/i, "stranger gets the challenge, not access");
		await mgr.stop();
	});
});

describe("inbound-pipeline: cmdCtx carries accountId + isGroup", () => {
	it("populates accountId from msg.accountId when set", async () => {
		// Build a probe command that records the context it receives.
		let captured: ChannelCommandContext | undefined;
		const probe = {
			name: "probe",
			handler: (ctx: ChannelCommandContext) => {
				captured = ctx;
				return "ok";
			},
		};
		const fake = makeFakeChannel();
		const commandMap = new Map<string, typeof probe>();
		commandMap.set("probe", probe);
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => ({ reply: "x" }),
			commandMap,
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "/probe",
			accountId: "work",
		});
		assert.ok(captured, "probe handler ran");
		assert.equal(captured.accountId, "work");
		// Not a group message — isGroup is false (additive but always populated).
		assert.equal(captured.isGroup, false);
	});

	it("populates isGroup=true when InboundMessage.isGroup is true", async () => {
		let captured: ChannelCommandContext | undefined;
		const probe = {
			name: "probe",
			handler: (ctx: ChannelCommandContext) => {
				captured = ctx;
				return "ok";
			},
		};
		// Group ACL gate requires `@-mention`d-bot → selfId + mentions array
		// must line up. Without this the message is silently dropped before
		// the command map ever runs.
		const SELF_ID = "+15550000000";
		const fake = makeFakeChannel({ selfId: () => SELF_ID });
		const commandMap = new Map<string, typeof probe>();
		commandMap.set("probe", probe);
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: { channels: { fake: { dmPolicy: "open", groupPolicy: "open" } } } as unknown as BrigadeConfig,
			agentId: "main",
			runTurn: async () => ({ reply: "x" }),
			commandMap,
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "12025550100@g.us",
			from: "+15559998888",
			text: "/probe",
			isGroup: true,
			mentions: [SELF_ID],
		});
		assert.ok(captured);
		assert.equal(captured.isGroup, true);
	});
});

describe("inbound-pipeline: deferred media downloads only AFTER the access gate admits", () => {
	// Production incident (2026-06-12): strangers' group videos were
	// downloaded from WhatsApp, sealed, and archived into the backend even
	// though every one of their messages was DROPPED by policy — media
	// download ran at the socket layer, before the gate. The fix defers the
	// download behind msg.resolveMedia, invoked only post-admission.
	it("BLOCKED group sender: resolveMedia is NEVER invoked", async () => {
		let downloads = 0;
		const SELF_ID = "+15550000000";
		const fake = makeFakeChannel({ selfId: () => SELF_ID });
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			// Groups not allowlisted → evaluateAccess blocks (group:not-allowlisted).
			config: {
				channels: { fake: { dmPolicy: "open", groupPolicy: "allowlist" } },
			} as unknown as BrigadeConfig,
			agentId: "main",
			runTurn: async () => ({ reply: "x" }),
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "12025550100@g.us",
			from: "+15551112222",
			text: "", // media-only — exactly the production shape
			isGroup: true,
			resolveMedia: async () => {
				downloads += 1;
				return [{ kind: "video", path: "/tmp/spam.mp4", mimeType: "video/mp4" }];
			},
		});
		assert.equal(downloads, 0, "blocked sender's media must never be downloaded/archived");
	});

	it("ADMITTED sender: resolveMedia runs once and the media note reaches the turn", async () => {
		let downloads = 0;
		let turnText: string | undefined;
		const fake = makeFakeChannel();
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async (args) => {
				turnText = args.text;
				return { reply: "ok" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "",
			resolveMedia: async () => {
				downloads += 1;
				return [{ kind: "image", path: "C:/cache/pic.png", mimeType: "image/png" }];
			},
		});
		assert.equal(downloads, 1, "admitted sender's media downloads exactly once");
		assert.match(turnText ?? "", /attached image/, "media note reaches the agent turn");
	});

	it("ADMITTED sender whose deferred download FAILS: message drops quietly (no turn)", async () => {
		let turns = 0;
		const fake = makeFakeChannel();
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => {
				turns += 1;
				return { reply: "x" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "", // media-only
			resolveMedia: async () => {
				throw new Error("media expired on server");
			},
		});
		assert.equal(turns, 0, "no usable content → no agent turn (mirrors pre-change empty-drop)");
	});
});

describe("inbound-pipeline: /agent persists across gateway restart", () => {
	it("a /agent <id> binding written by one process is read by a fresh startChannels()", async () => {
		writeConfig({
			agents: { main: {}, ops: {} },
			channels: { fake: { dmPolicy: "open" } },
		});
		const fake = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [fake.adapter],
			config: loadConfig(),
			agentId: "main",
			runTurn: async () => ({ reply: "" }),
		});
		await fake.ctx().onInbound({
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "/agent ops",
		});
		await mgr.stop();

		// Restart simulation: drop the parse cache, re-load brigade.json, fresh manager.
		__resetConfigParseCacheForTests();
		const reloaded = loadConfig();
		const entries = reloaded.bindings?.entries ?? [];
		assert.equal(entries.length, 1, "binding survived restart");
		assert.equal(entries[0]?.agentId, "ops");

		// Future inbound from the same peer must route to ops via tier-1.
		const { resolveAgentRoute } = await import("../routing/resolve-route.js");
		const route = resolveAgentRoute({
			cfg: reloaded,
			channel: "fake",
			accountId: "default",
			peer: { kind: "direct", id: "+12025550100" },
		});
		assert.equal(route.agentId, "ops");
		assert.equal(route.matchedBy, "binding.peer");
	});
});

describe("inbound-pipeline: live reply streaming", () => {
	it("FINALIZES the stream and SKIPS the plain sendText when a stream is open", async () => {
		const deltas: string[] = [];
		let finalized: string | undefined;
		let plainSends = 0;
		const fake = makeFakeChannel({
			async sendText() {
				plainSends += 1;
			},
			beginReplyStream() {
				return {
					update: (t: string) => deltas.push(t),
					async finalize(t: string) {
						finalized = t;
						return { messageId: "777" };
					},
					stop: () => {},
				};
			},
		});
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async (args) => {
				// Simulate the gateway forwarding accumulating deltas.
				args.onReplyDelta?.("Hel");
				args.onReplyDelta?.("Hello");
				return { reply: "Hello world" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "hi",
		});
		assert.deepEqual(deltas, ["Hel", "Hello"], "deltas forwarded to the stream");
		assert.equal(finalized, "Hello world", "stream finalized with the full reply");
		assert.equal(plainSends, 0, "the plain sendText is SKIPPED when streaming delivered");
	});

	it("falls back to sendText when the adapter does NOT stream (final-only)", async () => {
		let plainSends = 0;
		let deltaSeen = false;
		const fake = makeFakeChannel({
			async sendText() {
				plainSends += 1;
			},
		});
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async (args) => {
				deltaSeen = args.onReplyDelta !== undefined;
				return { reply: "final only" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "hi",
		});
		assert.equal(deltaSeen, false, "no onReplyDelta is passed when the adapter can't stream");
		assert.equal(plainSends, 1, "final reply delivered via the normal sendText path");
	});

	it("falls back to sendText when stream.finalize THROWS", async () => {
		let plainSends = 0;
		const fake = makeFakeChannel({
			async sendText() {
				plainSends += 1;
			},
			beginReplyStream() {
				return {
					update: () => {},
					async finalize() {
						throw new Error("edit failed");
					},
					stop: () => {},
				};
			},
		});
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => ({ reply: "recovered reply" }),
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "hi",
		});
		assert.equal(plainSends, 1, "a failed stream finalize falls back to the plain send");
	});
});

describe("inbound-pipeline: reasoning lane + general button callbacks", () => {
	it("calls deliverReasoning with the RAW reply before the answer", async () => {
		const reasoningCalls: string[] = [];
		const fake = makeFakeChannel({
			async deliverReasoning(_conversationId, rawReply) {
				reasoningCalls.push(rawReply);
			},
		});
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => ({ reply: "<think>plan</think>The answer." }),
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "hi",
		});
		assert.equal(reasoningCalls.length, 1);
		assert.match(reasoningCalls[0] ?? "", /<think>plan<\/think>/, "raw reply (with reasoning) handed to the adapter");
	});

	it("routes a GENERAL button callback through the pipeline as a turn", async () => {
		let turnText: string | undefined;
		const fake = makeFakeChannel();
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async (args) => {
				turnText = args.text;
				return { reply: "ack" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "",
			callbackQuery: { data: "g:buy", callbackId: "cb1" },
		});
		assert.match(turnText ?? "", /buy/, "the button token reaches the agent as a turn");
	});

	it("DROPS a non-approval, non-general callback (no turn)", async () => {
		let turns = 0;
		const fake = makeFakeChannel();
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => {
				turns += 1;
				return { reply: "x" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "",
			callbackQuery: { data: "stale-approval-payload", callbackId: "cb2" },
		});
		assert.equal(turns, 0, "an unrecognized callback is dropped silently");
	});
});

describe("inbound-pipeline: plugin hooks wired into the live pipeline", () => {
	it("a claiming `inbound_claim` handler SKIPS the turn entirely (no gate, no dispatch, no send)", async () => {
		let claimedPayloadChannel: string | undefined;
		mountRegistryWithHook("inbound_claim", (payload) => {
			claimedPayloadChannel = (payload as { channel?: string }).channel;
			return { handled: true };
		});
		let turnRan = false;
		const fake = makeFakeChannel();
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "should not happen" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "hello",
		});
		assert.equal(turnRan, false, "a claimed inbound never reaches the agent turn");
		assert.equal(fake.sent.length, 0, "a claimed inbound sends nothing");
		assert.equal(claimedPayloadChannel, "fake", "the handler saw the inbound's channel id in the payload");
	});

	it("a NON-claiming `inbound_claim` handler lets the turn proceed normally", async () => {
		mountRegistryWithHook("inbound_claim", () => {
			// observes but does not claim
			return;
		});
		let turnRan = false;
		const fake = makeFakeChannel();
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "normal reply" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "hello",
		});
		assert.equal(turnRan, true, "an unclaimed inbound runs the turn");
		assert.match(fake.sent[0]?.text ?? "", /normal reply/);
	});

	it("a claiming `before_dispatch` handler runs the gate but SKIPS dispatch (no turn, no send)", async () => {
		mountRegistryWithHook("before_dispatch", () => ({ handled: true }));
		let turnRan = false;
		const fake = makeFakeChannel();
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "should not happen" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "hello",
		});
		assert.equal(turnRan, false, "a claimed dispatch never runs the agent turn");
		assert.equal(fake.sent.length, 0, "a claimed dispatch sends nothing");
	});

	it("a claiming `reply_dispatch` handler SUPPRESSES the outgoing send (turn still ran)", async () => {
		let replyInPayload: string | undefined;
		mountRegistryWithHook("reply_dispatch", (payload) => {
			replyInPayload = (payload as { reply?: string }).reply;
			return { handled: true };
		});
		let turnRan = false;
		const fake = makeFakeChannel();
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "the reply that gets suppressed" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "hi",
		});
		assert.equal(turnRan, true, "the turn still runs — only the send is suppressed");
		assert.equal(fake.sent.length, 0, "a claimed reply_dispatch suppresses the adapter send");
		assert.match(replyInPayload ?? "", /the reply that gets suppressed/, "the handler saw the reply text");
	});

	it("a NON-claiming `reply_dispatch` handler lets the reply send normally", async () => {
		mountRegistryWithHook("reply_dispatch", () => {
			return; // observe only
		});
		const fake = makeFakeChannel();
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => ({ reply: "delivered" }),
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "hi",
		});
		assert.equal(fake.sent.length, 1, "an unclaimed reply_dispatch sends the reply");
		assert.match(fake.sent[0]?.text ?? "", /delivered/);
	});

	it("a void `message_sent` handler FIRES after a successful send (and can never block it)", async () => {
		const sentEvents: Array<{ channel?: string; text?: string }> = [];
		mountRegistryWithHook("message_sent", (payload) => {
			const p = payload as { channel?: string; text?: string };
			sentEvents.push({ channel: p.channel, text: p.text });
			// void handlers may throw — the runner swallows it; delivery is unaffected.
			throw new Error("telemetry handler boom (must be swallowed)");
		});
		const fake = makeFakeChannel();
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => ({ reply: "shipped" }),
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: "+12025550100",
			from: "+12025550100",
			text: "hi",
		});
		assert.equal(fake.sent.length, 1, "the reply is delivered");
		assert.match(fake.sent[0]?.text ?? "", /shipped/);
		assert.equal(sentEvents.length, 1, "message_sent fired exactly once, AFTER the send");
		assert.equal(sentEvents[0]?.channel, "fake");
		assert.match(sentEvents[0]?.text ?? "", /shipped/, "the payload carried the sent reply text");
	});
});

describe("inbound-pipeline: ChannelSecurityAdapter supplementary DM-policy consult", () => {
	const STRANGER = "+15557654321";

	it("a registered security adapter TIGHTENS open → pairing (stranger is challenged, no turn)", async () => {
		// Config says the loosest policy: open (anyone may DM).
		const fake = makeFakeChannel();
		// But the channel's security adapter returns "owner" (→ pairing). The
		// stranger must be CHALLENGED, not let straight through.
		registerChannelSecurityAdapter("fake", { resolveDmPolicy: () => "owner" });
		let turnRan = false;
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN, // { channels: { fake: { dmPolicy: "open" } } }
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "should not happen" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: STRANGER,
			from: STRANGER,
			text: "hello",
		});
		assert.equal(turnRan, false, "tightened to pairing → stranger does not get a turn");
		assert.match(fake.sent[0]?.text ?? "", /approve/i, "stranger gets the pairing challenge");
	});

	it("back-compat: NO security adapter → open policy unchanged (stranger's turn runs)", async () => {
		const fake = makeFakeChannel();
		// No registerChannelSecurityAdapter call → registry is empty.
		let turnRan = false;
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: ACL_OPEN,
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "welcome" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: STRANGER,
			from: STRANGER,
			text: "hello",
		});
		assert.equal(turnRan, true, "open policy stands when no security adapter is registered");
		assert.match(fake.sent[0]?.text ?? "", /welcome/);
	});

	it("a security adapter CANNOT loosen: config pairing + adapter 'all' stays pairing", async () => {
		const fake = makeFakeChannel();
		// Adapter tries to OPEN the channel up; the authoritative config (pairing)
		// must win — the stranger is still challenged.
		registerChannelSecurityAdapter("fake", { resolveDmPolicy: () => "all" });
		let turnRan = false;
		const pipeline = createInboundPipelineContext({
			adapter: fake.adapter,
			config: { channels: { fake: { dmPolicy: "pairing" } } } as unknown as BrigadeConfig,
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "should not happen" };
			},
			commandMap: new Map(),
		});
		await runChannelInboundPipeline(pipeline, {
			channel: "fake",
			conversationId: STRANGER,
			from: STRANGER,
			text: "hello",
		});
		assert.equal(turnRan, false, "adapter cannot loosen pairing → stranger still challenged");
		assert.match(fake.sent[0]?.text ?? "", /approve/i);
	});
});
