import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetConfigParseCacheForTests } from "../../config/io.js";
import { runChannelsDisable, runChannelsEnable, runChannelsList, runChannelsStatus } from "./channels.js";

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

	it("auto-picks the only available channel when --channel is omitted", async () => {
		// BUNDLED_MODULES has exactly one channel (whatsapp) in this phase.
		const code = await runChannelsEnable({}, { json: true });
		assert.equal(code, 0);
		assert.equal((readConfig().channels as Record<string, { enabled?: boolean }>).whatsapp?.enabled, true);
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
	it("list emits at least the bundled whatsapp channel in JSON mode", async () => {
		const { result, out } = await captureStdout(() => runChannelsList({ json: true }));
		assert.equal(result, 0);
		const parsed = JSON.parse(out) as { channels: { id: string; label: string; enabled: boolean; linked: boolean }[] };
		const whatsapp = parsed.channels.find((c) => c.id === "whatsapp");
		assert.ok(whatsapp, "whatsapp should appear in `channels list`");
		assert.equal(whatsapp?.linked, false); // nothing on disk in the tempdir
		assert.equal(whatsapp?.enabled, false); // freshly seeded config
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
