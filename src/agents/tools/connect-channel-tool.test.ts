/**
 * `connect_channel` tool tests.
 *
 * Covers:
 *   - list / status response shape (read-only, available + connected + health).
 *   - owner-gating: a non-owner `connect` / `disconnect` is refused (per-call
 *     senderIsOwner gate), while list/status stay open.
 *   - `connect` writes config (enabled=true) AND calls the manager's live
 *     `startChannel`; a supplied token is stored as a `${VAR}` secret-ref on
 *     disk (NEVER the raw value) and the raw token lands in process.env.
 *   - `disconnect` calls the manager's `stopChannel` and disables the channel.
 *
 * Isolation: BRIGADE_STATE_DIR → tempdir so config reads/writes hit a throwaway
 * brigade.json; the active-registry + active-channel-manager singletons are
 * stubbed per-test and cleared after.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import type { ChannelAdapter } from "../extensions/types.js";
import type { ChannelManager, StartChannelResult, StopChannelResult } from "../channels/manager.js";

// Pin HOME + state dir to a tempdir BEFORE importing modules that resolve
// config paths at load. Mirrors the session-wiring/owner-only test pattern.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-connch-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.BRIGADE_HOME;

const { makeConnectChannelTool } = await import("./connect-channel-tool.js");
const { BrigadeExtensionRegistry } = await import("../extensions/registry.js");
const { setActiveRegistry } = await import("../extensions/active-registry.js");
const { setActiveChannelManager } = await import("../channels/active-manager.js");
const { __resetConfigParseCacheForTests } = await import("../../config/io.js");

import type { BrigadeConfig } from "../../config/io.js";

let stateDir: string;
let prevStateDir: string | undefined;

before(() => {
	process.on("exit", () => {
		if (originalHome !== undefined) process.env.HOME = originalHome;
		else delete process.env.HOME;
		if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
		else delete process.env.USERPROFILE;
		try {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});
});

beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-connch-state-"));
	fs.mkdirSync(path.join(stateDir, "agents"), { recursive: true });
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
	__resetConfigParseCacheForTests();
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	setActiveRegistry(undefined);
	setActiveChannelManager(null);
	delete process.env.BRIGADE_TELEGRAM_TOKEN;
	try {
		fs.rmSync(stateDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	__resetConfigParseCacheForTests();
});

after(() => {
	setActiveRegistry(undefined);
	setActiveChannelManager(null);
});

/* ───────────────────────────── helpers ───────────────────────────── */

/** Minimal fake channel adapter for catalog/registry purposes. */
function fakeAdapter(id: string, label: string, configured = false): ChannelAdapter {
	return {
		id,
		label,
		isConfigured: () => configured,
		async start() {},
		async stop() {},
		async sendText() {},
		health: () => ({ ok: true }),
	} as ChannelAdapter;
}

/** Register a set of adapters as the active registry. */
function mountRegistry(adapters: ChannelAdapter[]): void {
	const reg = new BrigadeExtensionRegistry();
	const b = reg.context({
		agentId: "main",
		workspaceDir: path.join(stateDir, "ws"),
		cwd: path.join(stateDir, "ws"),
		config: {} as BrigadeConfig,
	});
	for (const a of adapters) b.channel(a);
	setActiveRegistry(reg);
}

/** Build + mount a controllable fake channel manager. */
function mountManager(opts: {
	started?: string[];
	startResult?: StartChannelResult;
	stopResult?: StopChannelResult;
}): {
	startCalls: Array<{ id: string; hadConfig: boolean }>;
	stopCalls: string[];
	startedRef: string[];
} {
	const startedRef = [...(opts.started ?? [])];
	const startCalls: Array<{ id: string; hadConfig: boolean }> = [];
	const stopCalls: string[] = [];
	const manager: ChannelManager = {
		get started() {
			return startedRef;
		},
		adapter() {
			return undefined;
		},
		async startChannel(id: string, config?: BrigadeConfig): Promise<StartChannelResult> {
			startCalls.push({ id, hadConfig: config !== undefined });
			const res = opts.startResult ?? { ok: true, started: true };
			if (res.ok && res.started && !startedRef.includes(id)) startedRef.push(id);
			return res;
		},
		async stopChannel(id: string): Promise<StopChannelResult> {
			stopCalls.push(id);
			const res = opts.stopResult ?? { ok: true, stopped: true };
			const idx = startedRef.indexOf(id);
			if (idx !== -1) startedRef.splice(idx, 1);
			return res;
		},
		async stop() {},
	};
	setActiveChannelManager(manager);
	return { startCalls, stopCalls, startedRef };
}

/** Parse the tool result's JSON details. */
function parse(result: { details: unknown }): Record<string, unknown> {
	return result.details as Record<string, unknown>;
}

/** Read the RAW on-disk config (no secret resolution) to assert what persisted. */
function readRawConfig(): Record<string, unknown> {
	const file = path.join(stateDir, "brigade.json");
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** Read one channel's raw config slice; asserts the channels map + slice exist. */
function readRawChannel(raw: Record<string, unknown>, channel: string): Record<string, unknown> {
	const channels = raw.channels as Record<string, Record<string, unknown>> | undefined;
	assert.ok(channels, "config.channels must exist");
	const ch = channels[channel];
	assert.ok(ch, `config.channels.${channel} must exist`);
	return ch;
}

/* ───────────────────────────── list / status ───────────────────────────── */

describe("connect_channel — list / status (read-only)", () => {
	it("list returns available + connected channels", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram"), fakeAdapter("whatsapp", "WhatsApp")]);
		mountManager({ started: ["whatsapp"] });
		const tool = makeConnectChannelTool();
		const res = await tool.execute("c1", { action: "list" } as never);
		const d = parse(res);
		assert.equal(d.action, "list");
		assert.equal(d.ok, true);
		const channels = d.channels as Array<{ channel: string; connected: boolean }>;
		assert.equal(channels.length, 2);
		const tg = channels.find((c) => c.channel === "telegram");
		const wa = channels.find((c) => c.channel === "whatsapp");
		assert.equal(tg?.connected, false, "telegram not started → not connected");
		assert.equal(wa?.connected, true, "whatsapp started → connected");
	});

	it("status narrows to one channel and reports its state", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram")]);
		mountManager({ started: [] });
		const tool = makeConnectChannelTool();
		const res = await tool.execute("c1", { action: "status", channel: "telegram" } as never);
		const d = parse(res);
		assert.equal(d.action, "status");
		assert.equal(d.ok, true);
		const state = d.channelState as { channel: string; connected: boolean };
		assert.equal(state.channel, "telegram");
		assert.equal(state.connected, false);
	});

	it("status for an unknown channel returns ok:false", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram")]);
		mountManager({ started: [] });
		const tool = makeConnectChannelTool();
		const res = await tool.execute("c1", { action: "status", channel: "discord" } as never);
		const d = parse(res);
		assert.equal(d.ok, false);
	});

	it("list/status are allowed even for a non-owner sender", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram")]);
		mountManager({ started: [] });
		const tool = makeConnectChannelTool({ senderIsOwner: false });
		const res = await tool.execute("c1", { action: "list" } as never);
		assert.equal(parse(res).ok, true, "list stays open to peers");
	});
});

/* ───────────────────────────── owner-gating ───────────────────────────── */

describe("connect_channel — owner gating on connect/disconnect", () => {
	it("a non-owner connect is REFUSED (no config write, no start)", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram")]);
		const m = mountManager({ started: [] });
		const tool = makeConnectChannelTool({ senderIsOwner: false });
		const res = await tool.execute("c1", {
			action: "connect",
			channel: "telegram",
			token: "123456:ABCDEF",
		} as never);
		const d = parse(res);
		assert.equal(d.ok, false, "non-owner connect refused");
		assert.match(String(d.message), /owner-only/i);
		assert.equal(m.startCalls.length, 0, "startChannel must NOT be called for a refused connect");
		// No brigade.json written by the refused call.
		assert.equal(
			fs.existsSync(path.join(stateDir, "brigade.json")),
			false,
			"refused connect must not write config",
		);
	});

	it("a non-owner disconnect is REFUSED (no stop)", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram")]);
		const m = mountManager({ started: ["telegram"] });
		const tool = makeConnectChannelTool({ senderIsOwner: false });
		const res = await tool.execute("c1", { action: "disconnect", channel: "telegram" } as never);
		assert.equal(parse(res).ok, false);
		assert.equal(m.stopCalls.length, 0, "stopChannel must NOT be called for a refused disconnect");
	});

	it("connect to an unregistered channel id is refused even for the owner", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram")]);
		const m = mountManager({ started: [] });
		const tool = makeConnectChannelTool({ senderIsOwner: true });
		const res = await tool.execute("c1", { action: "connect", channel: "discord", token: "x" } as never);
		assert.equal(parse(res).ok, false);
		assert.equal(m.startCalls.length, 0);
	});
});

/* ───────────────────────────── connect (owner) ───────────────────────────── */

describe("connect_channel — connect writes config + starts live + seals token", () => {
	it("owner connect: enables config, starts live, stores token as ${VAR} (not raw)", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram", true)]);
		const m = mountManager({ started: [], startResult: { ok: true, started: true } });
		const tool = makeConnectChannelTool({ senderIsOwner: true });
		const token = "7654321:SECRETOKENVALUE_abcdef1234567890";
		const res = await tool.execute("c1", {
			action: "connect",
			channel: "telegram",
			token,
		} as never);
		const d = parse(res);
		assert.equal(d.ok, true);
		assert.equal(d.started, true, "live start reported");

		// startChannel was called WITH the fresh config snapshot.
		assert.equal(m.startCalls.length, 1);
		assert.equal(m.startCalls[0]?.id, "telegram");
		assert.equal(m.startCalls[0]?.hadConfig, true, "fresh config passed to startChannel");

		// Config persisted: enabled true + token as a ${VAR} secret-ref, NOT raw.
		const raw = readRawConfig();
		const ch = readRawChannel(raw, "telegram");
		assert.equal(ch.enabled, true);
		assert.equal(ch.botToken, "${BRIGADE_TELEGRAM_TOKEN}", "token stored as a secret-ref literal");
		// The raw token must NOT appear anywhere in the on-disk config.
		assert.doesNotMatch(JSON.stringify(raw), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "raw token must never persist");

		// The raw token IS available in-process so the adapter can resolve it.
		assert.equal(process.env.BRIGADE_TELEGRAM_TOKEN, token, "raw token set in env for live resolution");

		// The token is ALSO durably sealed in the encrypted credential store so
		// it survives a gateway reboot (env-only would evaporate on restart).
		const { readSealedChannelToken } = await import("../channels/channel-secrets.js");
		assert.equal(readSealedChannelToken("telegram"), token, "token durably sealed for reboot survival");
	});

	it("owner connect without a token still enables + starts (QR-style channel)", async () => {
		mountRegistry([fakeAdapter("whatsapp", "WhatsApp", true)]);
		const m = mountManager({ started: [], startResult: { ok: true, started: true } });
		const tool = makeConnectChannelTool({ senderIsOwner: true });
		const res = await tool.execute("c1", { action: "connect", channel: "whatsapp" } as never);
		assert.equal(parse(res).ok, true);
		assert.equal(m.startCalls.length, 1);
		const raw = readRawConfig();
		const ch = readRawChannel(raw, "whatsapp");
		assert.equal(ch.enabled, true);
		assert.equal(ch.botToken, undefined, "no token field when none supplied");
	});

	it("connect reports an honest failure when the live start does not take", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram")]);
		const m = mountManager({
			started: [],
			startResult: { ok: false, started: false, reason: "not-configured", message: "still not configured" },
		});
		const tool = makeConnectChannelTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			action: "connect",
			channel: "telegram",
			token: "123:abc",
		} as never);
		const d = parse(res);
		assert.equal(d.ok, false, "failed start surfaces ok:false");
		assert.equal(d.started, false);
		assert.equal(m.startCalls.length, 1, "the start was attempted");
		// Config was still written (enabled + token) even though the start failed.
		const raw = readRawConfig();
		assert.equal(readRawChannel(raw, "telegram").enabled, true);
	});

	it("connect falls back to config-only when no manager is mounted", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram", true)]);
		setActiveChannelManager(null); // no live manager
		const tool = makeConnectChannelTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			action: "connect",
			channel: "telegram",
			token: "123:abc",
		} as never);
		const d = parse(res);
		assert.equal(d.ok, true, "config write succeeds");
		assert.equal(d.started, false, "no live manager → started:false");
		assert.match(String(d.message), /restart|next start|gateway/i);
		// Token still sealed as a ref.
		const raw = readRawConfig();
		assert.equal(readRawChannel(raw, "telegram").botToken, "${BRIGADE_TELEGRAM_TOKEN}");
	});
});

/* ───────────────────────────── disconnect (owner) ───────────────────────────── */

describe("connect_channel — disconnect stops + disables", () => {
	it("owner disconnect: stops live + disables in config", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram", true)]);
		const m = mountManager({ started: ["telegram"], stopResult: { ok: true, stopped: true } });
		const tool = makeConnectChannelTool({ senderIsOwner: true });
		const res = await tool.execute("c1", { action: "disconnect", channel: "telegram" } as never);
		const d = parse(res);
		assert.equal(d.ok, true);
		assert.equal(d.stopped, true, "live stop reported");
		assert.equal(m.stopCalls.length, 1);
		assert.equal(m.stopCalls[0], "telegram");
		// Config disabled.
		const raw = readRawConfig();
		assert.equal(readRawChannel(raw, "telegram").enabled, false);
	});

	it("disconnect when nothing is running still disables config (stopped:false)", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram", true)]);
		const m = mountManager({ started: [], stopResult: { ok: true, stopped: false } });
		const tool = makeConnectChannelTool({ senderIsOwner: true });
		const res = await tool.execute("c1", { action: "disconnect", channel: "telegram" } as never);
		const d = parse(res);
		assert.equal(d.ok, true);
		assert.equal(d.stopped, false);
		const raw = readRawConfig();
		assert.equal(readRawChannel(raw, "telegram").enabled, false);
	});
});

/* ───────────────────────────── durable seal survives reboot ───────────────────────────── */

describe("connect_channel — token survives a gateway reboot", () => {
	it("after a simulated reboot (env cleared), the token resolves from the sealed store", async () => {
		mountRegistry([fakeAdapter("telegram", "Telegram", true)]);
		mountManager({ started: [], startResult: { ok: true, started: true } });
		const tool = makeConnectChannelTool({ senderIsOwner: true });
		const token = "9988776:REBOOT_SURVIVOR_token_value_0123456789";

		// 1) Connect — seals durably + sets the live env.
		const res = await tool.execute("c1", { action: "connect", channel: "telegram", token } as never);
		assert.equal(parse(res).ok, true);
		assert.equal(process.env.BRIGADE_TELEGRAM_TOKEN, token, "env set this process");

		// 2) Simulate a gateway REBOOT: the process env evaporates, the config
		//    parse cache is cold. The on-disk config still has the `${VAR}` ref,
		//    which now resolves to NOTHING (env is gone) — only the durable sealed
		//    store can supply the token.
		delete process.env.BRIGADE_TELEGRAM_TOKEN;
		__resetConfigParseCacheForTests();

		const { resolveTelegramBotToken } = await import("../channels/telegram/account-config.js");
		const raw = readRawConfig();
		// Sanity: the on-disk config carries only the ${VAR} ref (no raw token).
		assert.equal(readRawChannel(raw, "telegram").botToken, "${BRIGADE_TELEGRAM_TOKEN}");

		// Resolve with an EMPTY env (post-reboot) — must come from the sealed store.
		const resolved = resolveTelegramBotToken(raw as unknown as BrigadeConfig, "default", {});
		assert.equal(resolved, token, "token recovered from the durable sealed store after reboot");
	});

	it("with NO sealed token and a dangling ${VAR} ref, resolution is empty (proves the seal is what saves it)", async () => {
		// Write a config with a ${VAR} ref but DON'T seal anything; clear env.
		// This is the pre-fix failure mode — confirms the durable seal (not some
		// other fallback) is what makes the reboot case work above.
		mountRegistry([fakeAdapter("telegram", "Telegram", true)]);
		const cfg = {
			channels: { telegram: { enabled: true, botToken: "${BRIGADE_TELEGRAM_TOKEN}" } },
		} as unknown as BrigadeConfig;
		delete process.env.BRIGADE_TELEGRAM_TOKEN;
		const { resolveTelegramBotToken } = await import("../channels/telegram/account-config.js");
		assert.equal(resolveTelegramBotToken(cfg, "default", {}), "", "no seal + no env => no token");
	});
});
