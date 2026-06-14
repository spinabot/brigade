/**
 * `manage_access` tests — tempdir-isolated via BRIGADE_STATE_DIR.
 *
 * Pins the production gap (2026-06-11): the model had no sanctioned way to
 * change the A2A access knobs, so it tried to hand-edit brigade.json (guard-
 * refused) and dead-ended. This tool is the sanctioned path: show + set for
 * visibility / agentToAgent / org.a2a.mode, writing through the same atomic
 * config helper org/manage_agent use, never the guarded write/edit tools.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { makeManageAccessTool } from "./manage-access-tool.js";

let tmpRoot: string;
let prevState: string | undefined;
let prevConfig: string | undefined;

function writeCfg(cfg: unknown): void {
	fs.writeFileSync(path.join(tmpRoot, "brigade.json"), JSON.stringify(cfg, null, 2), "utf8");
}

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-maccess-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	prevConfig = process.env.BRIGADE_CONFIG_PATH;
	process.env.BRIGADE_STATE_DIR = tmpRoot;
	process.env.BRIGADE_CONFIG_PATH = path.join(tmpRoot, "brigade.json");
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

function readCfg(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(tmpRoot, "brigade.json"), "utf8")) as Record<
		string,
		unknown
	>;
}

describe("manage_access — show", () => {
	it("reports defaults when nothing is configured", async () => {
		writeCfg({ agents: { defaults: {} } });
		const tool = makeManageAccessTool();
		const r = parse(await tool.execute("s1", { action: "show" } as never)) as {
			ok: boolean;
			settings: { visibility: string; a2aEnabled: boolean; orgConfigured: boolean; a2aMode: string | null };
		};
		assert.equal(r.ok, true);
		assert.equal(r.settings.visibility, "self");
		assert.equal(r.settings.a2aEnabled, false);
		assert.equal(r.settings.orgConfigured, false);
		assert.equal(r.settings.a2aMode, null);
	});
});

describe("manage_access — set", () => {
	it("enabling A2A seeds the wide-open allow list and persists", async () => {
		writeCfg({ agents: { defaults: {} } });
		const tool = makeManageAccessTool();
		const r = parse(
			await tool.execute("s2", { action: "set", visibility: "all", a2aEnabled: true } as never),
		) as { ok: boolean; after: { visibility: string; a2aEnabled: boolean; a2aAllow: unknown[] } };
		assert.equal(r.ok, true);
		assert.equal(r.after.visibility, "all");
		assert.equal(r.after.a2aEnabled, true);
		assert.deepEqual(r.after.a2aAllow, [{ from: "*", to: "*" }]);
		// Persisted to config (session.*), other keys untouched.
		const cfg = readCfg() as {
			session?: { sessionTools?: { visibility?: string }; agentToAgent?: { enabled?: boolean } };
			agents?: unknown;
		};
		assert.equal(cfg.session?.sessionTools?.visibility, "all");
		assert.equal(cfg.session?.agentToAgent?.enabled, true);
		assert.ok(cfg.agents, "unrelated agents block preserved");
	});

	it("sets org.a2a.mode when an org exists, preserving the rest of the org block", async () => {
		writeCfg({
			agents: { defaults: {} },
			org: { topOrder: "ceo-agent", a2a: { mode: "derived" } },
		});
		const tool = makeManageAccessTool();
		const r = parse(await tool.execute("s3", { action: "set", a2aMode: "explicit" } as never)) as {
			ok: boolean;
			after: { a2aMode: string };
		};
		assert.equal(r.ok, true);
		assert.equal(r.after.a2aMode, "explicit");
		const cfg = readCfg() as { org?: { topOrder?: string; a2a?: { mode?: string } } };
		assert.equal(cfg.org?.a2a?.mode, "explicit");
		assert.equal(cfg.org?.topOrder, "ceo-agent", "topOrder preserved");
	});

	it("refuses a2aMode when no org is configured (with the org init remedy)", async () => {
		writeCfg({ agents: { defaults: {} } });
		const tool = makeManageAccessTool();
		const r = parse(await tool.execute("s4", { action: "set", a2aMode: "explicit" } as never)) as {
			ok: boolean;
			message: string;
		};
		assert.equal(r.ok, false);
		assert.match(r.message, /no org is configured/i);
		// Nothing should have been written under org.
		const cfg = readCfg() as { org?: unknown };
		assert.equal(cfg.org, undefined);
	});

	it("rejects an empty set with a clear message", async () => {
		writeCfg({ agents: { defaults: {} } });
		const tool = makeManageAccessTool();
		const r = parse(await tool.execute("s5", { action: "set" } as never)) as { ok: boolean; message: string };
		assert.equal(r.ok, false);
		assert.match(r.message, /nothing to change/);
	});

	it("allowAll seeds the wide-open matrix without flipping enabled", async () => {
		writeCfg({ agents: { defaults: {} }, session: { agentToAgent: { enabled: true } } });
		const tool = makeManageAccessTool();
		const r = parse(await tool.execute("s6", { action: "set", allowAll: true } as never)) as {
			ok: boolean;
			after: { a2aAllow: unknown[] };
		};
		assert.equal(r.ok, true);
		assert.deepEqual(r.after.a2aAllow, [{ from: "*", to: "*" }]);
	});
});

describe("manage_access — tool shape", () => {
	it("is owner-only", () => {
		assert.equal(makeManageAccessTool().ownerOnly, true);
	});
});
