import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	MAX_MODEL_PIN_LENGTH,
	clearSessionModelPin,
	pinSessionModel,
	readSessionModelPin,
	readSessionStore,
	resolveOrCreateSession,
	upsertSessionEntry,
} from "./session-store.js";

function withTempState(fn: () => void): void {
	const dir = mkdtempSync(path.join(tmpdir(), "brigade-model-pin-"));
	const prev = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

const KEY = "agent:main:t-pin";

test("pin round-trips and clears", () => {
	withTempState(() => {
		assert.equal(readSessionModelPin("main", KEY), null);
		assert.ok(pinSessionModel("main", KEY, "openrouter", "qwen/qwen-2.5-72b-instruct"));
		assert.deepEqual(readSessionModelPin("main", KEY), {
			provider: "openrouter",
			modelId: "qwen/qwen-2.5-72b-instruct",
		});
		clearSessionModelPin("main", KEY);
		assert.equal(readSessionModelPin("main", KEY), null);
	});
});

// THE migration guarantee. Every session that has ever run already carries a
// `provider`/`modelId` stamp from its last turn. If those were read as a pin,
// every historical thread would be frozen to its first turn's model and an
// agent-wide `/model` would silently fail to move any of them.
test("a legacy entry with provider/modelId but no pin reads as UNPINNED", () => {
	withTempState(() => {
		upsertSessionEntry("main", KEY, {
			provider: "claude-cli",
			modelId: "claude-opus-5",
		});
		const entry = readSessionStore("main").sessions[KEY];
		assert.equal(entry?.provider, "claude-cli", "stamp is present");
		assert.equal(readSessionModelPin("main", KEY), null, "but it is NOT a pin");
	});
});

// The bug that made per-session model look missing: every turn stamps the
// entry with whatever model served it. That must not disturb the pin.
test("a turn's stamp neither creates nor destroys a pin", () => {
	withTempState(() => {
		pinSessionModel("main", KEY, "openrouter", "qwen/qwen-2.5-72b-instruct");
		// Simulate a turn: exactly what runSingleTurn passes as overrides.
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: KEY,
			overrides: { provider: "claude-cli", modelId: "claude-opus-5" },
		});
		const entry = readSessionStore("main").sessions[KEY];
		assert.equal(entry?.provider, "claude-cli", "stamp records what actually ran");
		assert.deepEqual(
			readSessionModelPin("main", KEY),
			{ provider: "openrouter", modelId: "qwen/qwen-2.5-72b-instruct" },
			"pin survives a turn that used a different model",
		);

		// And on an UNPINNED session the same stamp must not conjure a pin.
		const other = "agent:main:t-unpinned";
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: other,
			overrides: { provider: "claude-cli", modelId: "claude-opus-5" },
		});
		assert.equal(readSessionModelPin("main", other), null);
	});
});

test("half a pin is not a pin", () => {
	withTempState(() => {
		// Only reachable by hand-editing the store; must degrade to "follow the
		// agent" rather than guess the missing half.
		upsertSessionEntry("main", KEY, { pinnedProvider: "openrouter" });
		assert.equal(readSessionModelPin("main", KEY), null);
	});
});

test("pin rejects unusable ids and never writes half a pin", () => {
	withTempState(() => {
		const controlChar = "a\u0000b";
		const tooLong = "x".repeat(MAX_MODEL_PIN_LENGTH + 1);
		for (const bad of ["", "   ", controlChar, tooLong]) {
			assert.equal(pinSessionModel("main", KEY, "openrouter", bad), null);
			assert.equal(pinSessionModel("main", KEY, bad, "some-model"), null);
		}
		assert.equal(pinSessionModel("main", KEY, 42, "some-model"), null);
		assert.equal(readSessionModelPin("main", KEY), null);
		assert.equal(readSessionStore("main").sessions[KEY], undefined, "no entry conjured");
	});
});

test("prototype keys neither read nor create", () => {
	withTempState(() => {
		assert.equal(readSessionModelPin("main", "constructor"), null);
		assert.equal(readSessionModelPin("main", "__proto__"), null);
		// A non-canonical key may not CREATE an entry.
		assert.equal(pinSessionModel("main", "constructor", "openrouter", "m"), null);
		assert.equal(pinSessionModel("main", "not-a-session-key", "openrouter", "m"), null);
		assert.equal(clearSessionModelPin("main", "constructor"), null);
	});
});

test("pin creates the entry for a thread that has not taken a turn yet", () => {
	withTempState(() => {
		// The TUI mints a thread key the moment you open a new thread, so
		// pinning before the first message has to persist.
		const fresh = "agent:main:t-brandnew";
		assert.equal(readSessionStore("main").sessions[fresh], undefined);
		assert.ok(pinSessionModel("main", fresh, "openrouter", "qwen/qwen-2.5-72b-instruct"));
		assert.deepEqual(readSessionModelPin("main", fresh), {
			provider: "openrouter",
			modelId: "qwen/qwen-2.5-72b-instruct",
		});
	});
});

test("clearing is idempotent and scoped to one session", () => {
	withTempState(() => {
		const a = "agent:main:t-a";
		const b = "agent:main:t-b";
		pinSessionModel("main", a, "openrouter", "qwen-a");
		pinSessionModel("main", b, "openrouter", "qwen-b");
		clearSessionModelPin("main", a);
		clearSessionModelPin("main", a);
		assert.equal(readSessionModelPin("main", a), null);
		assert.deepEqual(readSessionModelPin("main", b), {
			provider: "openrouter",
			modelId: "qwen-b",
		});
		assert.equal(clearSessionModelPin("main", "agent:main:t-missing"), null);
	});
});
