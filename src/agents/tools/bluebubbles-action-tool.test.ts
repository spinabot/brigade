/**
 * `bluebubbles_action` tool — dispatch + ownerOnly + Private-API gating + config gate.
 *
 * Tempdir-isolated (never reads the operator's real ~/.brigade or hits the
 * network). Covers:
 *   - each group-admin action dispatches to the right REST endpoint (asserted via
 *     a recording fetch's METHOD + PATH);
 *   - `ownerOnly` is set on the tool;
 *   - a refusal when the Private API is off (no REST round-trip);
 *   - missing-param actions fail cleanly (ok:false, no throw);
 *   - the tool is only ASSEMBLED by the registry when BlueBubbles is configured.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { makeBlueBubblesActionTool } from "./bluebubbles-action-tool.js";

const SERVER = "http://192.168.1.5:1234";
const PASSWORD = ["bb", "tool", "pw"].join("-");

/** Recording fake fetch — captures each call + returns a canned 200 `{ data }` body. */
function recordFetch(): { fetch: typeof fetch; calls: Array<{ url: string; method: string }> } {
	const calls: Array<{ url: string; method: string }> = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ status: 200, data: {} }),
			headers: new Map<string, string>() as unknown as Headers,
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, calls };
}

/** Default action flags — everything on, like the config default. */
const ALL_ACTIONS = { reactions: true, edit: true, unsend: true, effects: true, groupAdmin: true } as const;

/** Run an action with an injected account + Private-API status + recording fetch. */
async function run(
	args: Record<string, unknown>,
	overrides: {
		privateApi?: boolean | null;
		rec?: ReturnType<typeof recordFetch>;
		actions?: import("../channels/bluebubbles/account-config.js").BlueBubblesActionFlags;
	} = {},
): Promise<{ details: { action: string; ok: boolean; message: string }; calls: Array<{ url: string; method: string }> }> {
	const rec = overrides.rec ?? recordFetch();
	const tool = makeBlueBubblesActionTool({
		resolveAccount: () => ({ serverUrl: SERVER, password: PASSWORD }),
		resolvePrivateApi: async () => (overrides.privateApi === undefined ? true : overrides.privateApi),
		resolveActions: () => overrides.actions ?? { ...ALL_ACTIONS },
		fetchImpl: rec.fetch,
		readIcon: async () => new Uint8Array([1, 2, 3]),
	});
	const res = (await tool.execute("call-1", args as never)) as {
		details: { action: string; ok: boolean; message: string };
	};
	return { details: res.details, calls: rec.calls };
}

describe("bluebubbles_action — tool shape", () => {
	it("is ownerOnly with the right name", () => {
		const tool = makeBlueBubblesActionTool();
		assert.equal(tool.name, "bluebubbles_action");
		assert.equal(tool.ownerOnly, true);
	});

	it("fails cleanly when BlueBubbles is not configured", async () => {
		const tool = makeBlueBubblesActionTool({ resolveAccount: () => ({ serverUrl: "", password: "" }) });
		const res = (await tool.execute("c", { action: "leave-group", chatGuid: "G" } as never)) as {
			details: { ok: boolean; message: string };
		};
		assert.equal(res.details.ok, false);
		assert.match(res.details.message, /not configured/i);
	});
});

describe("bluebubbles_action — dispatch to the right endpoint", () => {
	const cases: Array<{ name: string; args: Record<string, unknown>; method: string; pathRe: RegExp }> = [
		{
			name: "add-participant",
			args: { action: "add-participant", chatGuid: "G", address: "+15551234567" },
			method: "POST",
			pathRe: /\/api\/v1\/chat\/G\/participant\/add\?/,
		},
		{
			name: "remove-participant",
			args: { action: "remove-participant", chatGuid: "G", address: "a@b.com" },
			method: "POST",
			pathRe: /\/api\/v1\/chat\/G\/participant\/remove\?/,
		},
		{
			name: "rename-group",
			args: { action: "rename-group", chatGuid: "G", displayName: "Team" },
			method: "PUT",
			pathRe: /\/api\/v1\/chat\/G\?/,
		},
		{
			name: "set-group-icon",
			args: { action: "set-group-icon", chatGuid: "G", iconPath: "/tmp/icon.png" },
			method: "POST",
			pathRe: /\/api\/v1\/chat\/G\/icon\?/,
		},
		{ name: "leave-group", args: { action: "leave-group", chatGuid: "G" }, method: "POST", pathRe: /\/api\/v1\/chat\/G\/leave\?/ },
	];

	for (const c of cases) {
		it(`${c.name} → ${c.method}`, async () => {
			const { details, calls } = await run(c.args);
			assert.equal(details.ok, true, details.message);
			assert.equal(calls.length, 1);
			assert.equal(calls[0]!.method, c.method);
			assert.match(calls[0]!.url, c.pathRe);
		});
	}

	it("strips an optional chat_guid: prefix from the chatGuid", async () => {
		const { details, calls } = await run({ action: "leave-group", chatGuid: "chat_guid:G" });
		assert.equal(details.ok, true);
		assert.match(calls[0]!.url, /\/api\/v1\/chat\/G\/leave\?/);
	});
});

describe("bluebubbles_action — send-effect + reply (Fix 5)", () => {
	it("send-effect POSTs to message/text with the resolved effectId", async () => {
		const rec = recordFetch();
		const { details } = await run({ action: "send-effect", chatGuid: "G", text: "surprise!", effect: "confetti" }, { rec });
		assert.equal(details.ok, true, details.message);
		assert.equal(rec.calls.length, 1);
		assert.match(rec.calls[0]!.url, /\/api\/v1\/message\/text\?/);
	});

	it("send-effect rejects an unknown effect name (no request)", async () => {
		const rec = recordFetch();
		const { details } = await run({ action: "send-effect", chatGuid: "G", text: "hi", effect: "nope" }, { rec });
		assert.equal(details.ok, false);
		assert.match(details.message, /Unknown effect/);
		assert.equal(rec.calls.length, 0);
	});

	it("send-effect is refused when actions.effects = false (umbrella)", async () => {
		const rec = recordFetch();
		const { details } = await run(
			{ action: "send-effect", chatGuid: "G", text: "hi", effect: "confetti" },
			{ rec, actions: { ...ALL_ACTIONS, effects: false } },
		);
		assert.equal(details.ok, false);
		assert.match(details.message, /send-effect is disabled/i);
		assert.equal(rec.calls.length, 0);
	});

	it("reply POSTs to message/text (the native inline reply path)", async () => {
		const rec = recordFetch();
		const { details } = await run({ action: "reply", chatGuid: "G", text: "got it", replyToId: "ORIG-1", partIndex: 0 }, { rec });
		assert.equal(details.ok, true, details.message);
		assert.equal(rec.calls.length, 1);
		assert.match(rec.calls[0]!.url, /\/api\/v1\/message\/text\?/);
	});

	it("reply without replyToId → ok:false (no request)", async () => {
		const rec = recordFetch();
		const { details } = await run({ action: "reply", chatGuid: "G", text: "got it" }, { rec });
		assert.equal(details.ok, false);
		assert.match(details.message, /requires a `replyToId`/);
		assert.equal(rec.calls.length, 0);
	});
});

describe("bluebubbles_action — groupAdmin gating (Fix 6)", () => {
	it("refuses a group action when actions.groupAdmin = false (umbrella, no request)", async () => {
		const rec = recordFetch();
		const { details } = await run(
			{ action: "rename-group", chatGuid: "G", displayName: "Team" },
			{ rec, actions: { ...ALL_ACTIONS, groupAdmin: false } },
		);
		assert.equal(details.ok, false);
		assert.match(details.message, /rename-group is disabled/i);
		assert.equal(rec.calls.length, 0);
	});

	it("proceeds with a group action when groupAdmin defaults true", async () => {
		const { details, calls } = await run({ action: "leave-group", chatGuid: "G" });
		assert.equal(details.ok, true);
		assert.equal(calls.length, 1);
	});
});

describe("bluebubbles_action — per-op gating (Fix: finer than coarse umbrella)", () => {
	it("disabling removeParticipant but leaving renameGroup: remove refused, rename proceeds", async () => {
		// groupAdmin umbrella ON; only removeParticipant explicitly OFF.
		const actions = { ...ALL_ACTIONS, removeParticipant: false } as never;
		const recRemove = recordFetch();
		const remove = await run({ action: "remove-participant", chatGuid: "G", address: "+1" }, { rec: recRemove, actions });
		assert.equal(remove.details.ok, false, "remove-participant is refused");
		assert.match(remove.details.message, /remove-participant is disabled/i);
		assert.equal(recRemove.calls.length, 0, "no REST call for the refused op");

		const recRename = recordFetch();
		const rename = await run({ action: "rename-group", chatGuid: "G", displayName: "Team" }, { rec: recRename, actions });
		assert.equal(rename.details.ok, true, "rename-group still works");
		assert.equal(recRename.calls.length, 1);
		assert.match(recRename.calls[0]!.url, /\/api\/v1\/chat\/G\?/);
	});

	it("an explicit renameGroup:true overrides a groupAdmin:false umbrella", async () => {
		const actions = { ...ALL_ACTIONS, groupAdmin: false, renameGroup: true } as never;
		const { details, calls } = await run({ action: "rename-group", chatGuid: "G", displayName: "Team" }, { actions });
		assert.equal(details.ok, true, "explicit per-op true wins over the umbrella");
		assert.equal(calls.length, 1);
	});

	it("send-effect honours an explicit sendWithEffect:false even when effects:true", async () => {
		const rec = recordFetch();
		const actions = { ...ALL_ACTIONS, effects: true, sendWithEffect: false } as never;
		const { details } = await run({ action: "send-effect", chatGuid: "G", text: "hi", effect: "confetti" }, { rec, actions });
		assert.equal(details.ok, false);
		assert.match(details.message, /send-effect is disabled/i);
		assert.equal(rec.calls.length, 0);
	});
});

describe("bluebubbles_action — Private-API gating", () => {
	it("refuses every action when the Private API is OFF (no REST round-trip)", async () => {
		const rec = recordFetch();
		const { details } = await run({ action: "rename-group", chatGuid: "G", displayName: "x" }, { privateApi: false, rec });
		assert.equal(details.ok, false);
		assert.match(details.message, /Private API/);
		assert.equal(rec.calls.length, 0);
	});

	it("proceeds when the Private-API status is unknown (null)", async () => {
		const { details, calls } = await run({ action: "leave-group", chatGuid: "G" }, { privateApi: null });
		assert.equal(details.ok, true);
		assert.equal(calls.length, 1);
	});
});

describe("bluebubbles_action — required-param refusals", () => {
	it("add-participant without address → ok:false, no request", async () => {
		const rec = recordFetch();
		const { details } = await run({ action: "add-participant", chatGuid: "G" }, { rec });
		assert.equal(details.ok, false);
		assert.match(details.message, /requires an `address`/);
		assert.equal(rec.calls.length, 0);
	});

	it("rename-group without displayName → ok:false", async () => {
		const { details } = await run({ action: "rename-group", chatGuid: "G" });
		assert.equal(details.ok, false);
		assert.match(details.message, /requires a `displayName`/);
	});

	it("any action with an empty chatGuid → ok:false", async () => {
		const { details } = await run({ action: "leave-group", chatGuid: "   " });
		assert.equal(details.ok, false);
		assert.match(details.message, /requires a `chatGuid`/);
	});
});

describe("bluebubbles_action — registry assembly gate", () => {
	let stateDir: string;
	let cfgPath: string;
	const prevConfigPath = process.env.BRIGADE_CONFIG_PATH;
	const prevComposio = process.env.COMPOSIO_API_KEY;

	before(() => {
		stateDir = mkdtempSync(join(tmpdir(), "brigade-bb-gate-"));
		cfgPath = join(stateDir, "brigade.json");
		delete process.env.COMPOSIO_API_KEY;
	});

	after(() => {
		if (prevConfigPath === undefined) delete process.env.BRIGADE_CONFIG_PATH;
		else process.env.BRIGADE_CONFIG_PATH = prevConfigPath;
		if (prevComposio !== undefined) process.env.COMPOSIO_API_KEY = prevComposio;
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	async function toolNamesForConfig(config: unknown): Promise<string[]> {
		writeFileSync(cfgPath, JSON.stringify(config), "utf8");
		process.env.BRIGADE_CONFIG_PATH = cfgPath;
		const { createBrigadeTools } = await import("./registry.js");
		const tools = createBrigadeTools({ workspaceDir: stateDir, agentId: "main", cwd: stateDir });
		return tools.map((t) => t.name);
	}

	it("is NOT assembled when BlueBubbles is disabled / unconfigured", async () => {
		const names = await toolNamesForConfig({ agents: {} });
		assert.equal(names.includes("bluebubbles_action"), false);
	});

	it("IS assembled when channels.bluebubbles.enabled is true", async () => {
		const names = await toolNamesForConfig({
			agents: {},
			channels: { bluebubbles: { enabled: true, serverUrl: SERVER, password: PASSWORD } },
		});
		assert.equal(names.includes("bluebubbles_action"), true);
	});
});
