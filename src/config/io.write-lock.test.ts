/**
 * H8: concurrent read-modify-write callers must all land in the final cfg.
 *
 * Without an in-process queue, two async tasks each doing
 * `loadConfig() → mutate → saveConfig()` would both read the same empty
 * baseline and the last writer would silently stomp the others. The
 * `mutateConfigAtomic` helper serializes the read+mutate+write so every
 * mutation observes (and persists) the freshest state on disk.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

let stateDir: string;
let prev: string | undefined;
let prevMode: string | undefined;
let prevConvexUrl: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "brigade-iolock-"));
	prev = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
	// Hermeticity: a stray BRIGADE_MODE/BRIGADE_CONVEX_URL in the dev shell
	// would make peekConvexMode see convex (no context, no tmpdir sentinel)
	// and the config writer fail closed. Same isolation as boot.test.ts.
	prevMode = process.env.BRIGADE_MODE;
	prevConvexUrl = process.env.BRIGADE_CONVEX_URL;
	delete process.env.BRIGADE_MODE;
	delete process.env.BRIGADE_CONVEX_URL;
});

afterEach(() => {
	if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prev;
	if (prevMode === undefined) delete process.env.BRIGADE_MODE;
	else process.env.BRIGADE_MODE = prevMode;
	if (prevConvexUrl === undefined) delete process.env.BRIGADE_CONVEX_URL;
	else process.env.BRIGADE_CONVEX_URL = prevConvexUrl;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("config/io mutateConfigAtomic (H8)", () => {
	it("serializes 5 concurrent mutators so every diff lands", async () => {
		const { mutateConfigAtomic } = await import("./io.js");
		const { loadConfig } = await import("../core/config.js");

		const ids = ["alpha", "bravo", "charlie", "delta", "echo"];
		await Promise.all(
			ids.map((id) =>
				mutateConfigAtomic((current) => {
					const agents = {
						...((current.agents as Record<string, unknown> | undefined) ?? {}),
					};
					agents[id] = { name: id };
					return { ...current, agents: agents as never };
				}),
			),
		);

		const final = loadConfig();
		const agents = (final.agents as Record<string, unknown> | undefined) ?? {};
		for (const id of ids) {
			assert.ok(id in agents, `agent "${id}" should have survived the concurrent write storm`);
		}
	});
});
