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
import { startChannels } from "./manager.js";

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
});

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
