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
import { listTelegramAccountIds, resolveTelegramAccount, telegramChannelEnabled } from "./account-config.js";
import { createTelegramPlugin } from "./plugin.js";

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
		id: "telegram",
		label: "Telegram",
		isConfigured: () => true,
		async start(c) {
			ctx = c;
		},
		async stop() {
			stopped = true;
		},
		async sendText(conversationId, text, opts) {
			sent.push({ conversationId, text, opts });
			return { messageId: String(sent.length) };
		},
		selfId: () => `self:${accountId}`,
		capabilities: { chatTypes: ["direct", "group"], edit: true, unsend: true, reactions: true, reply: true },
		async handleAction() {
			return { ok: true, messageId: "ha-1" };
		},
	};
	return { adapter, ctx: () => ctx!, sent, stopped: () => stopped };
}

const cfgEmpty = {} as BrigadeConfig;
const cfgDisabled = { channels: { telegram: { enabled: false } } } as unknown as BrigadeConfig;
const cfgLegacy = { channels: { telegram: { enabled: true, botToken: "1:AAA" } } } as unknown as BrigadeConfig;
const cfgMulti = {
	channels: {
		telegram: {
			enabled: true,
			accounts: [
				{ id: "main", botToken: "1:AAA" },
				{ id: "ops", botToken: "2:BBB" },
			],
		},
	},
} as unknown as BrigadeConfig;
const cfgMalformed = {
	channels: { telegram: { enabled: true, accounts: [{}] } },
} as unknown as BrigadeConfig;

describe("Telegram account-config (multi-account)", () => {
	it("listAccountIds is empty when Telegram is disabled", () => {
		assert.deepEqual(listTelegramAccountIds(cfgEmpty), []);
		assert.deepEqual(listTelegramAccountIds(cfgDisabled), []);
	});

	it("legacy single-account configs surface ['default']", () => {
		assert.deepEqual(listTelegramAccountIds(cfgLegacy), ["default"]);
	});

	it("multi-account configs surface declared ids in order", () => {
		assert.deepEqual(listTelegramAccountIds(cfgMulti), ["main", "ops"]);
	});

	it("malformed accounts:[] still falls back to ['default']", () => {
		assert.deepEqual(listTelegramAccountIds(cfgMalformed), ["default"]);
	});

	it("resolveAccount resolves per-account tokens", () => {
		const main = resolveTelegramAccount(cfgMulti, "main");
		const ops = resolveTelegramAccount(cfgMulti, "ops");
		assert.equal(main.botToken, "1:AAA");
		assert.equal(ops.botToken, "2:BBB");
	});

	it("telegramChannelEnabled reads the enabled flag", () => {
		assert.equal(telegramChannelEnabled(cfgLegacy), true);
		assert.equal(telegramChannelEnabled(cfgDisabled), false);
		assert.equal(telegramChannelEnabled(cfgEmpty), false);
	});
});

describe("createTelegramPlugin", () => {
	function makePlugin() {
		return createTelegramPlugin({
			defaultAgentId: "main",
			loadConfig: () => cfgMulti,
			runTurn: async () => ({ reply: "" }),
		});
	}

	it("declares the Telegram meta + full capabilities", () => {
		const plugin = makePlugin();
		assert.equal(plugin.id, "telegram");
		assert.equal(plugin.meta.label, "Telegram");
		assert.equal(plugin.capabilities.edit, true);
		assert.equal(plugin.capabilities.unsend, true);
		assert.equal(plugin.capabilities.polls, true);
		assert.equal(plugin.capabilities.nativeCommands, true);
	});

	it("listAccountIds returns the declared accounts via plugin.config", () => {
		const plugin = makePlugin();
		assert.deepEqual(plugin.config.listAccountIds(cfgMulti), ["main", "ops"]);
		assert.deepEqual(plugin.config.listAccountIds(cfgLegacy), ["default"]);
	});

	it("outbound.sendText refuses sends for an unstarted account", async () => {
		const plugin = makePlugin();
		const result = await plugin.outbound?.sendText?.({
			cfg: cfgMulti,
			runtime: {},
			target: { channel: "telegram", to: "555", accountId: "main" },
			text: "hi",
		});
		assert.ok(result);
		assert.equal(result!.ok, false);
		assert.match(result!.error ?? "", /not running/);
	});

	it("actions.handleAction refuses for an unstarted account", async () => {
		const plugin = makePlugin();
		const result = await plugin.actions?.handleAction?.({
			cfg: cfgMulti,
			runtime: {},
			accountId: "main",
			target: { channel: "telegram", to: "555", accountId: "main" },
			action: { kind: "delete", messageId: "1" },
		});
		assert.ok(result);
		assert.equal(result!.ok, false);
		assert.match(result!.error ?? "", /cannot perform message actions/);
	});

	it("declares secret-target registry entries for tokens + webhook secret", () => {
		const plugin = makePlugin();
		const paths = (plugin.secrets?.secretTargetRegistryEntries ?? []).map((e) => e.path);
		assert.ok(paths.includes("channels.telegram.botToken"));
		assert.ok(paths.includes("channels.telegram.accounts.*.botToken"));
		assert.ok(paths.includes("channels.telegram.webhook.secretToken"));
	});
});

describe("createTelegramPlugin — multi-account lifecycle", () => {
	function withTempState<T>(fn: () => Promise<T>): Promise<T> {
		const tmp = mkdtempSync(join(tmpdir(), "brigade-tg-plugin-"));
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

	type PluginRunTurn = Parameters<typeof createTelegramPlugin>[0]["runTurn"];
	function bootPlugin(opts: {
		cfg: BrigadeConfig;
		fakes: Map<string, ReturnType<typeof makeFakeAdapter>>;
		runTurn?: PluginRunTurn;
	}) {
		return createTelegramPlugin({
			defaultAgentId: "main",
			loadConfig: () => opts.cfg,
			runTurn: opts.runTurn ?? (async () => ({ reply: "" })),
			adapterFactory: ({ accountId }) => {
				const existing = opts.fakes.get(accountId);
				if (existing) return existing.adapter;
				const fake = makeFakeAdapter(accountId);
				opts.fakes.set(accountId, fake);
				return fake.adapter;
			},
		});
	}

	it("registers a per-account approval dispatcher on startAccount + drops it on stop", async () => {
		await withTempState(async () => {
			const fakes = new Map<string, ReturnType<typeof makeFakeAdapter>>();
			const plugin = bootPlugin({ cfg: cfgMulti, fakes });
			const startAccount = plugin.gateway?.startAccount;
			assert.ok(startAccount, "startAccount must exist");
			await startAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "main"),
				accountId: "main",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			await startAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "ops"),
				accountId: "ops",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const keys = listChannelApprovalDispatchers();
			assert.ok(keys.includes("telegram::main"), `main dispatcher must register: ${keys.join(",")}`);
			assert.ok(keys.includes("telegram::ops"), `ops dispatcher must register: ${keys.join(",")}`);
			await plugin.gateway!.stopAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "ops"),
				accountId: "ops",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const after = listChannelApprovalDispatchers();
			assert.ok(!after.includes("telegram::ops"), `ops dispatcher must drop on stop: ${after.join(",")}`);
			assert.ok(after.includes("telegram::main"), "main dispatcher must survive");
		});
	});

	it("allow-listed sender routes through pipeline + reply lands on the same account socket", async () => {
		await withTempState(async () => {
			addAllowFrom("telegram", "999-friend", "main");
			const fakes = new Map<string, ReturnType<typeof makeFakeAdapter>>();
			const calls: { text: string; agentId: string }[] = [];
			const plugin = bootPlugin({
				cfg: cfgMulti,
				fakes,
				runTurn: async (a) => {
					calls.push({ text: a.text, agentId: a.agentId });
					return { reply: "pong from main" };
				},
			});
			await plugin.gateway!.startAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "main"),
				accountId: "main",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const fake = fakes.get("main")!;
			await fake.ctx().onInbound({
				channel: "telegram",
				conversationId: "999-friend",
				from: "999-friend",
				text: "ping",
				accountId: "main",
			});
			assert.equal(calls.length, 1, "approved sender must drive a turn");
			assert.deepEqual(
				fake.sent.map((s) => ({ to: s.conversationId, text: s.text, accountId: s.opts?.accountId })),
				[{ to: "999-friend", text: "pong from main", accountId: "main" }],
				"reply must land on the main account socket with accountId stamped",
			);
		});
	});

	it("stranger DM does NOT pin last-channel (ACL gate runs first)", async () => {
		await withTempState(async () => {
			const fakes = new Map<string, ReturnType<typeof makeFakeAdapter>>();
			let turnRan = false;
			const plugin = bootPlugin({
				cfg: cfgMulti,
				fakes,
				runTurn: async () => {
					turnRan = true;
					return { reply: "nope" };
				},
			});
			await plugin.gateway!.startAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "main"),
				accountId: "main",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const fake = fakes.get("main")!;
			const msg: InboundMessage = {
				channel: "telegram",
				conversationId: "555-stranger",
				from: "555-stranger",
				text: "hi",
				accountId: "main",
			};
			await fake.ctx().onInbound(msg);
			assert.equal(turnRan, false, "stranger must not reach the agent");
			const { getLastChannelForAgent } = await import("../last-channel.js");
			assert.equal(getLastChannelForAgent("main"), undefined, "stranger DM must not pin last-channel");
		});
	});

	it("stopAccount aborts an in-flight turn signal", async () => {
		await withTempState(async () => {
			addAllowFrom("telegram", "999-abort", "main");
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
				account: plugin.config.resolveAccount(cfgMulti, "main"),
				accountId: "main",
				cfg: cfgMulti,
				runtime: {},
				signal: new AbortController().signal,
			});
			const fake = fakes.get("main")!;
			const inboundP = fake.ctx().onInbound({
				channel: "telegram",
				conversationId: "999-abort",
				from: "999-abort",
				text: "slow thing",
				accountId: "main",
			});
			await new Promise((r) => setTimeout(r, 10));
			assert.ok(observedSignal, "runTurn must have been called with a signal");
			assert.equal(observedSignal?.aborted, false);
			await plugin.gateway!.stopAccount!({
				account: plugin.config.resolveAccount(cfgMulti, "main"),
				accountId: "main",
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
