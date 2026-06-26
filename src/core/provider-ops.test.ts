import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { readProfiles, writeProfiles } from "../auth/profiles.js";
import { handleProviderRemove } from "./provider-ops.js";

let prevStateDir: string | undefined;
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "brigade-provider-ops-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
});
afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
});

test("provider.remove deletes the matching provider's key, keeps others", () => {
	writeProfiles("main", {
		version: 1,
		profiles: {
			"anthropic:api": { provider: "anthropic", type: "api_key", key: "sk-x" },
			"openai:api": { provider: "openai", type: "api_key", key: "sk-y" },
		},
	} as never);
	const r = handleProviderRemove({ providerId: "anthropic" });
	assert.equal(r.ok, true);
	assert.equal(r.removed, 1);
	const after = readProfiles("main");
	assert.equal(after.profiles["anthropic:api"], undefined);
	assert.ok(after.profiles["openai:api"]);
});

test("provider.remove unknown provider → ok:false, removed 0", () => {
	const r = handleProviderRemove({ providerId: "nope" });
	assert.equal(r.ok, false);
	assert.equal(r.removed, 0);
});

test("provider.remove missing providerId → ok:false", () => {
	assert.equal(handleProviderRemove({}).ok, false);
});
