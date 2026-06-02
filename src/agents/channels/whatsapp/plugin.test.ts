import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import type { ChannelAdapter, ChannelStartContext, InboundMessage, OutboundSendOptions } from "../../extensions/types.js";
import { addAllowFrom } from "../access-control/index.js";
import {
	listChannelApprovalDispatchers,
	resetChannelApprovalRouterForTests,
} from "../approval-router.js";
import { resetLastChannelRegistryForTests } from "../last-channel.js";
import {
	listWhatsAppAccountIds,
	resolveWhatsAppAccount,
	resolveWhatsAppAccountAuthDir,
	whatsappChannelEnabled,
} from "./account-config.js";
import { createWhatsAppPlugin } from "./plugin.js";

/** Build a fake adapter that records sends + exposes its start ctx. */
function makeFakeAdapter(accountId: string): {
	adapter: ChannelAdapter;
	ctx: () => ChannelStartContext;
	sent: { conversationId: string; text: string; opts?: OutboundSendOptions }[];
	stopped: () => boolean;
} {
	let ctx: ChannelStartContext | undefined;
	const sent: { conversationId: string; text: string; opts?: OutboundSendOptions }[] = [];
	let stopped = false;
	const adapter: ChannelAdapter = {
		id: "whatsapp",
		label: "WhatsApp",
		isConfigured: () => true,
		async start(c) {
			ctx = c;
		},
		async stop() {
			stopped = true;
		},
		async sendText(conversationId, text, opts) {
			sent.push({ conversationId, text, opts });
		},
		selfId: () => `self:${accountId}`,
	};
	return { adapter, ctx: () => ctx!, sent, stopped: () => stopped };
}

const cfgEmpty = {} as BrigadeConfig;
const cfgDisabled = { channels: { whatsapp: { enabled: false } } } as unknown as BrigadeConfig;
const cfgLegacy = { channels: { whatsapp: { enabled: true } } } as unknown as BrigadeConfig;
const cfgMulti = {
	channels: {
		whatsapp: {
			enabled: true,
			accounts: [{ id: "personal" }, { id: "work" }],
		},
	},
} as unknown as BrigadeConfig;
const cfgMalformed = {
	channels: {
		whatsapp: { enabled: true, accounts: [{}] },
	},
} as unknown as BrigadeConfig;

describe("WhatsApp account-config", () => {
	it("listAccountIds is empty when WhatsApp is disabled", () => {
		assert.deepEqual(listWhatsAppAccountIds(cfgEmpty), []);
		assert.deepEqual(listWhatsAppAccountIds(cfgDisabled), []);
	});

	it("legacy single-account configs surface ['default']", () => {
		assert.deepEqual(listWhatsAppAccountIds(cfgLegacy), ["default"]);
	});

	it("multi-account configs surface declared ids in order", () => {
		assert.deepEqual(listWhatsAppAccountIds(cfgMulti), ["personal", "work"]);
	});

	it("malformed accounts:[] still falls back to ['default']", () => {
		assert.deepEqual(listWhatsAppAccountIds(cfgMalformed), ["default"]);
	});

	it("resolveAccount fills in defaults when account is missing from config", () => {
		const account = resolveWhatsAppAccount(cfgLegacy, "default");
		assert.equal(account.accountId, "default");
		assert.equal(account.enabled, true);
		assert.match(account.authDir, /channels[\\/]whatsapp[\\/]auth$/);
	});

	it("resolveAccount partitions non-default accounts under <accountId>/auth", () => {
		const account = resolveWhatsAppAccount(cfgMulti, "work");
		assert.equal(account.accountId, "work");
		assert.equal(account.enabled, true);
		assert.match(account.authDir, /channels[\\/]whatsapp[\\/]work[\\/]auth$/);
	});

	it("resolveWhatsAppAccountAuthDir preserves the legacy layout for 'default'", () => {
		const legacy = resolveWhatsAppAccountAuthDir("default");
		const named = resolveWhatsAppAccountAuthDir("work");
		assert.notEqual(legacy, named);
		assert.match(legacy, /channels[\\/]whatsapp[\\/]auth$/);
		assert.match(named, /channels[\\/]whatsapp[\\/]work[\\/]auth$/);
	});

	it("whatsappChannelEnabled reads the legacy enabled flag", () => {
		assert.equal(whatsappChannelEnabled(cfgLegacy), true);
		assert.equal(whatsappChannelEnabled(cfgDisabled), false);
		assert.equal(whatsappChannelEnabled(cfgEmpty), false);
	});
});

describe("createWhatsAppPlugin", () => {
	function makePlugin() {
		return createWhatsAppPlugin({
			defaultAgentId: "main",
			loadConfig: () => cfgMulti,
			runTurn: async () => ({ reply: "" }),
		});
	}

	it("declares the WhatsApp meta + capabilities", () => {
		const plugin = makePlugin();
		assert.equal(plugin.id, "whatsapp");
		assert.equal(plugin.meta.label, "WhatsApp");
		assert.deepEqual(plugin.capabilities.chatTypes, ["direct", "group"]);
		assert.equal(plugin.capabilities.reactions, true);
		assert.equal(plugin.capabilities.media, true);
	});

	it("listAccountIds returns the declared accounts via plugin.config", () => {
		const plugin = makePlugin();
		assert.deepEqual(plugin.config.listAccountIds(cfgMulti), ["personal", "work"]);
		assert.deepEqual(plugin.config.listAccountIds(cfgLegacy), ["default"]);
	});

	it("resolveAccount returns a ResolvedWhatsAppAccount with a per-account authDir", () => {
		const plugin = makePlugin();
		const personal = plugin.config.resolveAccount(cfgMulti, "personal");
		const work = plugin.config.resolveAccount(cfgMulti, "work");
		assert.equal(personal.accountId, "personal");
		assert.equal(work.accountId, "work");
		assert.notEqual(personal.authDir, work.authDir);
	});

	it("outbound.sendText refuses sends for an unstarted account", async () => {
		const plugin = makePlugin();
		const result = await plugin.outbound?.sendText?.({
			cfg: cfgMulti,
			runtime: {},
			target: { channel: "whatsapp", to: "+1234567890", accountId: "personal" },
			text: "hi",
		});
		assert.ok(result);
		assert.equal(result!.ok, false);
		assert.match(result!.error ?? "", /not running/);
	});
});

describe("createWhatsAppPlugin — multi-account safety surface", () => {
	function withTempState<T>(fn: () => Promise<T>): Promise<T> {
		const tmp = mkdtempSync(join(tmpdir(), "brigade-wa-plugin-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		resetChannelApprovalRouterForTests();
		resetLastChannelRegistryForTests();
		return Promise.resolve(fn()).finally(() => {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
			resetChannelApprovalRouterForTests();
			resetLastChannelRegistryForTests();
		});
	}

	type PluginRunTurn = Parameters<typeof createWhatsAppPlugin>[0]["runTurn"];
	function bootPlugin(opts: {
		cfg: BrigadeConfig;
		fakes: Map<string, ReturnType<typeof makeFakeAdapter>>;
		runTurn?: PluginRunTurn;
	}) {
		const plugin = createWhatsAppPlugin({
			defaultAgentId: "main",
			loadConfig: () => opts.cfg,
			runTurn: opts.runTurn ?? (async () => ({ reply: "" })),
			adapterFactory: ({ accountId }) => {
				const fake = makeFakeAdapter(accountId);
				opts.fakes.set(accountId, fake);
				return fake.adapter;
			},
		});
		return plugin;
	}

	it("registers a per-account approval dispatcher on startAccount", async () => {
		await withTempState(async () => {
			const fakes = new Map<string, ReturnType<typeof makeFakeAdapter>>();
			const plugin = bootPlugin({ cfg: cfgMulti, fakes });
			const startAccount = plugin.gateway?.startAccount;
			assert.ok(startAccount, "startAccount must exist");
			await startAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "personal"),
				accountId: "personal",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			await startAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "work"),
				accountId: "work",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const keys = listChannelApprovalDispatchers();
			assert.ok(keys.includes("whatsapp::personal"), `personal dispatcher must be registered: ${keys.join(",")}`);
			assert.ok(keys.includes("whatsapp::work"), `work dispatcher must be registered: ${keys.join(",")}`);
			// Stop work — its dispatcher must drop.
			const stopAccount = plugin.gateway?.stopAccount;
			await stopAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "work"),
				accountId: "work",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const after = listChannelApprovalDispatchers();
			assert.ok(!after.includes("whatsapp::work"), `work dispatcher must be removed on stop: ${after.join(",")}`);
			assert.ok(after.includes("whatsapp::personal"), "personal dispatcher must survive");
		});
	});

	it("plugin path: stranger DM does NOT pin last-channel (ACL gate runs first)", async () => {
		await withTempState(async () => {
			const fakes = new Map<string, ReturnType<typeof makeFakeAdapter>>();
			let turnRan = false;
			const plugin = bootPlugin({
				cfg: cfgMulti,
				fakes,
				runTurn: async () => {
					turnRan = true;
					return { reply: "should never reach the agent" };
				},
			});
			await plugin.gateway!.startAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "personal"),
				accountId: "personal",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const fake = fakes.get("personal")!;
			const msg: InboundMessage = {
				channel: "whatsapp",
				conversationId: "+1555-stranger",
				from: "+1555-stranger",
				text: "hi",
				accountId: "personal",
			};
			await fake.ctx().onInbound(msg);
			// `pairing` is the default policy → stranger gets a challenge, NOT a turn.
			assert.equal(turnRan, false, "stranger must not reach the agent");
			// The last-channel pin lives in `last-channel.ts`'s in-memory map.
			// Since the access gate blocks the stranger, the pin must NOT fire.
			const { getLastChannelForAgent } = await import("../last-channel.js");
			assert.equal(
				getLastChannelForAgent("main"),
				undefined,
				"stranger DM must not pin last-channel — operator-scheduled crons would hijack",
			);
		});
	});

	it("plugin path: allow-listed sender routes through pipeline + reply on same account socket", async () => {
		await withTempState(async () => {
			// Pre-approve the sender on the "personal" account.
			addAllowFrom("whatsapp", "+1555-friend", "personal");
			const fakes = new Map<string, ReturnType<typeof makeFakeAdapter>>();
			const calls: { text: string; agentId: string }[] = [];
			const plugin = bootPlugin({
				cfg: cfgMulti,
				fakes,
				runTurn: async (a) => {
					calls.push({ text: a.text, agentId: a.agentId });
					return { reply: "pong from personal" };
				},
			});
			await plugin.gateway!.startAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "personal"),
				accountId: "personal",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const fake = fakes.get("personal")!;
			await fake.ctx().onInbound({
				channel: "whatsapp",
				conversationId: "+1555-friend",
				from: "+1555-friend",
				text: "ping",
				accountId: "personal",
			});
			assert.equal(calls.length, 1, "approved sender must drive an agent turn");
			assert.deepEqual(
				fake.sent.map((s) => ({ to: s.conversationId, text: s.text, accountId: s.opts?.accountId })),
				[{ to: "+1555-friend", text: "pong from personal", accountId: "personal" }],
				"reply must land on the personal account's socket with accountId stamped",
			);
		});
	});

	it("plugin path: thread suffix flows through to the session key", async () => {
		await withTempState(async () => {
			addAllowFrom("whatsapp", "+1555-thread", "personal");
			const fakes = new Map<string, ReturnType<typeof makeFakeAdapter>>();
			const calls: { sessionKey: string }[] = [];
			const plugin = bootPlugin({
				cfg: cfgMulti,
				fakes,
				runTurn: async (a) => {
					calls.push({ sessionKey: a.sessionKey });
					return { reply: "ok" };
				},
			});
			await plugin.gateway!.startAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "personal"),
				accountId: "personal",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const fake = fakes.get("personal")!;
			await fake.ctx().onInbound({
				channel: "whatsapp",
				conversationId: "+1555-thread",
				from: "+1555-thread",
				text: "hi",
				accountId: "personal",
				threadId: "t-42",
			});
			assert.equal(calls.length, 1);
			assert.match(
				calls[0]?.sessionKey ?? "",
				/:thread:t-42$/,
				"thread suffix must be appended to the resolver's base session key",
			);
		});
	});

	it("plugin path: stopAccount aborts in-flight turn signal", async () => {
		await withTempState(async () => {
			addAllowFrom("whatsapp", "+1555-abort", "personal");
			const fakes = new Map<string, ReturnType<typeof makeFakeAdapter>>();
			let observedSignal: AbortSignal | undefined;
			let release: () => void = () => {};
			const turnDone = new Promise<void>((r) => {
				release = r;
			});
			const plugin = bootPlugin({
				cfg: cfgMulti,
				fakes,
				runTurn: async (a) => {
					observedSignal = a.signal;
					await turnDone;
					return { reply: "late" };
				},
			});
			await plugin.gateway!.startAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "personal"),
				accountId: "personal",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const fake = fakes.get("personal")!;
			// Kick off the slow turn — it pends on `turnDone`.
			const inboundP = fake.ctx().onInbound({
				channel: "whatsapp",
				conversationId: "+1555-abort",
				from: "+1555-abort",
				text: "slow thing",
				accountId: "personal",
			});
			await new Promise((r) => setTimeout(r, 10));
			assert.ok(observedSignal, "runTurn must have been called with a signal");
			assert.equal(observedSignal?.aborted, false);
			// Stop the account — must abort the in-flight turn.
			await plugin.gateway!.stopAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "personal"),
				accountId: "personal",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			assert.equal(observedSignal?.aborted, true, "stopAccount must abort in-flight turn signals");
			release();
			await inboundP;
		});
	});
});
