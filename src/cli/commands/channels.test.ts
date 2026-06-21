import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ChannelAdapter } from "../../agents/extensions/index.js";
import { __resetConfigParseCacheForTests } from "../../config/io.js";
import {
	__setChannelsAddTestHooksForTests,
	runChannelsAdd,
	runChannelsDisable,
	runChannelsEnable,
	runChannelsList,
	runChannelsStatus,
} from "./channels.js";

/**
 * Tests use BRIGADE_STATE_DIR to redirect ~/.brigade to a tempdir so a real
 * brigade.json is never touched. `__resetConfigParseCacheForTests` drops the
 * in-memory parse cache between cases so disk writes round-trip cleanly.
 */

let tmpRoot: string;
let prevStateDir: string | undefined;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "brigade-ch-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = tmpRoot;
	// Seed a minimal valid v2 config so loadConfig returns something coherent.
	writeFileSync(join(tmpRoot, "brigade.json"), JSON.stringify({ version: 2 }));
	__resetConfigParseCacheForTests();
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	__resetConfigParseCacheForTests();
	rmSync(tmpRoot, { recursive: true, force: true });
});

function readConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(tmpRoot, "brigade.json"), "utf8")) as Record<string, unknown>;
}

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
	const chunks: string[] = [];
	const orig = process.stdout.write.bind(process.stdout);
	(process.stdout.write as unknown as (s: string) => boolean) = (s) => {
		chunks.push(typeof s === "string" ? s : String(s));
		return true;
	};
	return fn()
		.then((result) => ({ result, out: chunks.join("") }))
		.finally(() => {
			process.stdout.write = orig;
		});
}

describe("brigade channels enable / disable", () => {
	it("enable writes channels.whatsapp.enabled=true", async () => {
		const code = await runChannelsEnable({ channel: "whatsapp" }, { json: true });
		assert.equal(code, 0);
		const cfg = readConfig();
		const channels = cfg.channels as Record<string, { enabled?: boolean }> | undefined;
		assert.equal(channels?.whatsapp?.enabled, true);
	});

	it("disable writes channels.whatsapp.enabled=false", async () => {
		await runChannelsEnable({ channel: "whatsapp" }, { json: true });
		const code = await runChannelsDisable({ channel: "whatsapp" }, { json: true });
		assert.equal(code, 0);
		assert.equal((readConfig().channels as Record<string, { enabled?: boolean }>).whatsapp?.enabled, false);
	});

	it("requires --channel when more than one channel is bundled", async () => {
		// BUNDLED_MODULES now bundles multiple channels (whatsapp + telegram),
		// so an omitted --channel is ambiguous and must error (exit 2) rather
		// than silently auto-pick one.
		const code = await runChannelsEnable({}, { json: true });
		assert.equal(code, 2);
	});

	it("enables telegram when explicitly selected", async () => {
		const code = await runChannelsEnable({ channel: "telegram" }, { json: true });
		assert.equal(code, 0);
		assert.equal((readConfig().channels as Record<string, { enabled?: boolean }>).telegram?.enabled, true);
	});

	it("rejects an unknown channel id with exit code 2", async () => {
		const code = await runChannelsEnable({ channel: "definitely-not-a-channel" }, { json: true });
		assert.equal(code, 2);
	});

	it("does not clobber sibling config fields when toggling", async () => {
		// Seed a richer config — gateway block + agents.defaults must survive a channel toggle.
		writeFileSync(
			join(tmpRoot, "brigade.json"),
			JSON.stringify({
				version: 2,
				gateway: { port: 7777 },
				agents: { defaults: { provider: "anthropic", model: { primary: "claude-opus-4-7" } } },
			}),
		);
		__resetConfigParseCacheForTests();
		await runChannelsEnable({ channel: "whatsapp" }, { json: true });
		const cfg = readConfig();
		assert.equal((cfg.gateway as { port?: number }).port, 7777);
		assert.equal((cfg.agents as { defaults?: { provider?: string } }).defaults?.provider, "anthropic");
		assert.equal((cfg.channels as Record<string, { enabled?: boolean }>).whatsapp?.enabled, true);
	});
});

describe("brigade channels list / status", () => {
	it("list emits the bundled whatsapp + telegram channels in JSON mode", async () => {
		const { result, out } = await captureStdout(() => runChannelsList({ json: true }));
		assert.equal(result, 0);
		const parsed = JSON.parse(out) as { channels: { id: string; label: string; enabled: boolean; linked: boolean }[] };
		const whatsapp = parsed.channels.find((c) => c.id === "whatsapp");
		assert.ok(whatsapp, "whatsapp should appear in `channels list`");
		assert.equal(whatsapp?.linked, false); // nothing on disk in the tempdir
		assert.equal(whatsapp?.enabled, false); // freshly seeded config
		const telegram = parsed.channels.find((c) => c.id === "telegram");
		assert.ok(telegram, "telegram should appear in `channels list`");
		assert.equal(telegram?.label, "Telegram");
		assert.equal(telegram?.enabled, false); // freshly seeded config
	});

	it("status reports the per-channel snapshot in JSON mode", async () => {
		const { result, out } = await captureStdout(() => runChannelsStatus({ channel: "whatsapp" }, { json: true }));
		assert.equal(result, 0);
		const parsed = JSON.parse(out) as { id: string; enabled: boolean; linked: boolean; gateway: boolean };
		assert.equal(parsed.id, "whatsapp");
		assert.equal(parsed.linked, false);
		assert.equal(parsed.enabled, false);
	});

	it("status returns 2 for an unknown channel", async () => {
		const code = await runChannelsStatus({ channel: "nope" }, { json: true });
		assert.equal(code, 2);
	});
});

/* ─────────────────────────── add (setup wizard) ─────────────────────────── */

/** Capture stderr alongside stdout — the wizard splits user prompts/errors there. */
function captureBoth<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
	const outChunks: string[] = [];
	const errChunks: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	(process.stdout.write as unknown as (s: string) => boolean) = (s) => {
		outChunks.push(typeof s === "string" ? s : String(s));
		return true;
	};
	(process.stderr.write as unknown as (s: string) => boolean) = (s) => {
		errChunks.push(typeof s === "string" ? s : String(s));
		return true;
	};
	return fn()
		.then((result) => ({ result, out: outChunks.join(""), err: errChunks.join("") }))
		.finally(() => {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
		});
}

/** Minimal stub adapter — only the bits the wizard touches. */
function stubAdapter(overrides: Partial<ChannelAdapter> & { id: string; label: string }): ChannelAdapter {
	return {
		isConfigured: () => false,
		start: async () => {},
		stop: async () => {},
		sendText: async () => {},
		...overrides,
	} as ChannelAdapter;
}

describe("brigade channels add (setup wizard)", () => {
	afterEach(() => {
		__setChannelsAddTestHooksForTests(undefined);
	});

	it("errors out gracefully when the channel has no setup adapter (WhatsApp shape)", async () => {
		// QR/OAuth channels leave `setup` undefined — the wizard should refuse
		// with a helpful redirect to `channels link`.
		const adapter = stubAdapter({ id: "whatsapp-stub", label: "WhatsApp" });
		__setChannelsAddTestHooksForTests({ channels: [adapter] });
		const { result, err } = await captureBoth(() =>
			runChannelsAdd({ channel: "whatsapp-stub" }, { json: false }),
		);
		assert.equal(result, 2);
		assert.match(err, /channels link/);
		assert.match(err, /whatsapp-stub/);
	});

	it("prompts for each credentialKey and persists them to brigade.json", async () => {
		const adapter = stubAdapter({
			id: "fakeslack",
			label: "FakeSlack",
			setup: {
				credentialKeys: [
					{ key: "botToken", prompt: "Bot token", secret: true },
					{ key: "signingSecret", prompt: "Signing secret", secret: true },
				],
			},
		});
		const supplied: Record<string, string> = {
			botToken: "xoxb-test-1234",
			signingSecret: "abc123def456",
		};
		const prompted: string[] = [];
		__setChannelsAddTestHooksForTests({
			channels: [adapter],
			prompter: async (key) => {
				prompted.push(key.key);
				return supplied[key.key] ?? "";
			},
		});
		const { result } = await captureBoth(() =>
			runChannelsAdd({ channel: "fakeslack" }, { json: true }),
		);
		assert.equal(result, 0);
		assert.deepEqual(prompted, ["botToken", "signingSecret"]);
		const cfg = readConfig();
		const channels = cfg.channels as Record<string, Record<string, unknown>> | undefined;
		assert.equal(channels?.fakeslack?.enabled, true);
		assert.equal(channels?.fakeslack?.botToken, "xoxb-test-1234");
		assert.equal(channels?.fakeslack?.signingSecret, "abc123def456");
	});

	it("--non-interactive errors when a required credential has no env var set", async () => {
		const adapter = stubAdapter({
			id: "fakeslack",
			label: "FakeSlack",
			setup: {
				credentialKeys: [
					{ key: "botToken", prompt: "Bot token", secret: true, envVar: "FAKE_SLACK_BOT_TOKEN" },
				],
			},
		});
		const prevEnv = process.env.FAKE_SLACK_BOT_TOKEN;
		delete process.env.FAKE_SLACK_BOT_TOKEN;
		try {
			__setChannelsAddTestHooksForTests({
				channels: [adapter],
				prompter: async () => {
					throw new Error("prompter should NOT be called in non-interactive mode");
				},
			});
			const { result, err } = await captureBoth(() =>
				runChannelsAdd({ channel: "fakeslack", nonInteractive: true }, { json: false }),
			);
			assert.equal(result, 2);
			assert.match(err, /Missing credential "botToken"/);
			assert.match(err, /FAKE_SLACK_BOT_TOKEN/);
		} finally {
			if (prevEnv === undefined) delete process.env.FAKE_SLACK_BOT_TOKEN;
			else process.env.FAKE_SLACK_BOT_TOKEN = prevEnv;
		}
	});

	it("--non-interactive succeeds when env vars cover every credential", async () => {
		const adapter = stubAdapter({
			id: "fakeslack",
			label: "FakeSlack",
			setup: {
				credentialKeys: [
					{ key: "botToken", prompt: "Bot token", secret: true, envVar: "FAKE_SLACK_BOT_TOKEN" },
				],
			},
		});
		const prevEnv = process.env.FAKE_SLACK_BOT_TOKEN;
		process.env.FAKE_SLACK_BOT_TOKEN = "xoxb-ci-9999";
		try {
			__setChannelsAddTestHooksForTests({ channels: [adapter] });
			const { result } = await captureBoth(() =>
				runChannelsAdd({ channel: "fakeslack", nonInteractive: true }, { json: true }),
			);
			assert.equal(result, 0);
			const cfg = readConfig();
			const channels = cfg.channels as Record<string, Record<string, unknown>> | undefined;
			assert.equal(channels?.fakeslack?.botToken, "xoxb-ci-9999");
			assert.equal(channels?.fakeslack?.enabled, true);
		} finally {
			if (prevEnv === undefined) delete process.env.FAKE_SLACK_BOT_TOKEN;
			else process.env.FAKE_SLACK_BOT_TOKEN = prevEnv;
		}
	});

	it("calls buildAccountConfig when the adapter provides one (verifies output shape)", async () => {
		let received: Record<string, string> | undefined;
		const adapter = stubAdapter({
			id: "fakeslack",
			label: "FakeSlack",
			setup: {
				credentialKeys: [
					{ key: "botToken", prompt: "Bot token", secret: true },
				],
				buildAccountConfig: (values) => {
					received = values;
					// Restructure into a nested shape — the wizard should write
					// THIS object verbatim under channels.fakeslack.
					return { account: { bot: { token: values.botToken } } };
				},
			},
		});
		__setChannelsAddTestHooksForTests({
			channels: [adapter],
			prompter: async () => "xoxb-shape-test",
		});
		const { result } = await captureBoth(() =>
			runChannelsAdd({ channel: "fakeslack" }, { json: true }),
		);
		assert.equal(result, 0);
		assert.deepEqual(received, { botToken: "xoxb-shape-test" });
		const cfg = readConfig();
		const channels = cfg.channels as Record<string, Record<string, unknown>> | undefined;
		const block = channels?.fakeslack as Record<string, unknown> | undefined;
		assert.equal(block?.enabled, true);
		assert.deepEqual(block?.account, { bot: { token: "xoxb-shape-test" } });
		// Raw `botToken` should NOT leak through — buildAccountConfig owns the shape.
		assert.equal(block?.botToken, undefined);
	});

	it("re-prompts on validateInput rejection then accepts a valid value", async () => {
		const adapter = stubAdapter({
			id: "fakeslack",
			label: "FakeSlack",
			setup: {
				credentialKeys: [{ key: "botToken", prompt: "Bot token", secret: true }],
				validateInput: (_key, value) =>
					value.startsWith("xoxb-") ? null : "Bot tokens must start with xoxb-",
			},
		});
		const answers = ["nope", "xoxb-ok"];
		let i = 0;
		__setChannelsAddTestHooksForTests({
			channels: [adapter],
			prompter: async () => answers[i++] ?? "",
		});
		const { result, err } = await captureBoth(() =>
			runChannelsAdd({ channel: "fakeslack" }, { json: true }),
		);
		assert.equal(result, 0);
		assert.equal(i, 2); // both prompts were used
		assert.match(err, /Bot tokens must start with xoxb-/);
		const cfg = readConfig();
		assert.equal(
			(cfg.channels as Record<string, Record<string, unknown>>).fakeslack?.botToken,
			"xoxb-ok",
		);
	});
});
