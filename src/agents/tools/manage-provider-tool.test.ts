/**
 * `manage_provider` tests — tempdir-isolated via BRIGADE_STATE_DIR.
 *
 * Pins the production contract (2026-06-11): a pasted API key must land in
 * the canonical per-agent credential store (never echoed back), and
 * "agent X runs on provider/model" must both edit config AND seed the key
 * into that agent's own store so the next turn actually works.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { makeManageProviderTool } from "./manage-provider-tool.js";
import { readProfiles } from "../../auth/profiles.js";
import { resolveAuthProfilesPath } from "../../config/paths.js";

const TEST_KEY = "sk-test-abcdef1234567890abcdef1234567890";

let tmpRoot: string;
let prevState: string | undefined;
let prevConfig: string | undefined;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mprov-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	prevConfig = process.env.BRIGADE_CONFIG_PATH;
	process.env.BRIGADE_STATE_DIR = tmpRoot;
	process.env.BRIGADE_CONFIG_PATH = path.join(tmpRoot, "brigade.json");
	fs.writeFileSync(
		path.join(tmpRoot, "brigade.json"),
		JSON.stringify(
			{
				agents: {
					"marketing-lead": {
						name: "Marketing Lead",
						org: { department: "marketing", reportsTo: "cmo-agent" },
					},
				},
				org: { topOrder: "ceo-agent", a2a: { mode: "explicit" } },
			},
			null,
			2,
		),
		"utf8",
	);
});

afterEach(() => {
	if (prevState === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevState;
	if (prevConfig === undefined) delete process.env.BRIGADE_CONFIG_PATH;
	else process.env.BRIGADE_CONFIG_PATH = prevConfig;
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

function parse(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
	return JSON.parse(res.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("manage_provider — save-key", () => {
	it("stores the key in the default agent's credential store, masked in the result", async () => {
		const tool = makeManageProviderTool({ requesterAgentId: "main" });
		const res = await tool.execute("t1", {
			action: "save-key",
			provider: "openai",
			key: TEST_KEY,
		});
		const parsed = parse(res);
		assert.equal(parsed.ok, true);
		// The FULL key must never appear anywhere in the result.
		assert.ok(!JSON.stringify(res).includes(TEST_KEY), "full key must not be echoed");
		assert.match(String(parsed.maskedKey), /…7890/);
		// And it must be readable through the canonical store.
		const file = readProfiles("main") as unknown as {
			profiles: Record<string, { provider?: string; key?: string }>;
		};
		const stored = Object.values(file.profiles).find((p) => p.provider === "openai");
		assert.equal(stored?.key, TEST_KEY);
	});

	it("rejects unknown providers with the known list", async () => {
		const tool = makeManageProviderTool({ requesterAgentId: "main" });
		const parsed = parse(
			await tool.execute("t2", { action: "save-key", provider: "nonsense", key: TEST_KEY }),
		);
		assert.equal(parsed.ok, false);
		assert.match(String(parsed.message), /Unknown provider/);
	});
});

describe("manage_provider — set-agent-model", () => {
	it("updates config AND seeds the key from the default agent's store", async () => {
		const tool = makeManageProviderTool({ requesterAgentId: "main" });
		await tool.execute("t3", { action: "save-key", provider: "openai", key: TEST_KEY });

		const res = await tool.execute("t4", {
			action: "set-agent-model",
			agentId: "marketing-lead",
			provider: "openai",
			model: "gpt-4o",
		});
		const parsed = parse(res);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.seededKey, true);
		assert.ok(!JSON.stringify(res).includes(TEST_KEY), "seeding must not echo the key");

		// Config: agents.marketing-lead carries provider + model.primary.
		const cfg = JSON.parse(fs.readFileSync(path.join(tmpRoot, "brigade.json"), "utf8")) as {
			agents: Record<string, { provider?: string; model?: { primary?: string } }>;
		};
		assert.equal(cfg.agents["marketing-lead"]?.provider, "openai");
		assert.equal(cfg.agents["marketing-lead"]?.model?.primary, "gpt-4o");
		// Regression: the write must not drop unrelated top-level keys or the
		// agent's own org sub-block (org-wipe scare, 2026-06-11).
		assert.deepEqual((cfg as Record<string, unknown>).org, { topOrder: "ceo-agent", a2a: { mode: "explicit" } });
		assert.equal((cfg.agents["marketing-lead"] as { org?: { reportsTo?: string } }).org?.reportsTo, "cmo-agent");

		// Credential store: marketing-lead now has its OWN copy of the key.
		assert.ok(fs.existsSync(resolveAuthProfilesPath("marketing-lead")));
		const file = readProfiles("marketing-lead") as unknown as {
			profiles: Record<string, { provider?: string; key?: string }>;
		};
		const seeded = Object.values(file.profiles).find((p) => p.provider === "openai");
		assert.equal(seeded?.key, TEST_KEY);
	});

	it("does not re-seed when the target already has its own key", async () => {
		const tool = makeManageProviderTool({ requesterAgentId: "main" });
		await tool.execute("t5", { action: "save-key", provider: "openai", key: TEST_KEY });
		await tool.execute("t6", {
			action: "save-key",
			provider: "openai",
			key: "sk-test-own-key-9999999999999999",
			agentId: "marketing-lead",
		});
		const parsed = parse(
			await tool.execute("t7", {
				action: "set-agent-model",
				agentId: "marketing-lead",
				provider: "openai",
				model: "gpt-4o",
			}),
		);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.seededKey, false);
		const file = readProfiles("marketing-lead") as unknown as {
			profiles: Record<string, { provider?: string; key?: string }>;
		};
		const kept = Object.values(file.profiles).find((p) => p.provider === "openai");
		assert.match(String(kept?.key), /own-key/);
	});

	it("refuses unconfigured agents with the manage_agent remedy", async () => {
		const tool = makeManageProviderTool({ requesterAgentId: "main" });
		const parsed = parse(
			await tool.execute("t8", {
				action: "set-agent-model",
				agentId: "ghost-agent",
				provider: "openai",
				model: "gpt-4o",
			}),
		);
		assert.equal(parsed.ok, false);
		assert.match(String(parsed.message), /manage_agent\(\{action:"add"/);
	});
});

describe("manage_provider — list", () => {
	it("reports key presence with masked tails, never full keys", async () => {
		const tool = makeManageProviderTool({ requesterAgentId: "main" });
		await tool.execute("t9", { action: "save-key", provider: "openai", key: TEST_KEY });
		const res = await tool.execute("t10", { action: "list" });
		const parsed = parse(res) as unknown as {
			ok: boolean;
			providers: Array<{ provider: string; hasKey: boolean; maskedKey?: string }>;
		};
		assert.equal(parsed.ok, true);
		const openai = parsed.providers.find((p) => p.provider === "openai");
		assert.equal(openai?.hasKey, true);
		assert.match(String(openai?.maskedKey), /…7890/);
		assert.ok(!JSON.stringify(res).includes(TEST_KEY), "list must never expose full keys");
	});
});
