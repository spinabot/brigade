import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// HOME → tempdir BEFORE importing (BRIGADE_DIR is pinned at module load).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-sysprompt-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.BRIGADE_HOME;

const { refreshSessionSystemPrompt } = await import("./system-prompt.js");
const { getBrigadeWorkspaceDir } = await import("./config.js");

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
	const ws = getBrigadeWorkspaceDir();
	fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
	fs.writeFileSync(path.join(ws, "IDENTITY.md"), "# IDENTITY\n- **Name:** Brigade", "utf8");
});

after(() => {
	try {
		const ws = getBrigadeWorkspaceDir();
		fs.rmSync(ws, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

/**
 * Build a fake Pi-shaped session. Pi's `Model` exposes the model id as
 * `.id` (NOT `.modelId`) — these tests pin that the prompt assembly reads
 * the right property (the bug that made `pickModelFamilyGuidance` see
 * "unknown" and skip the gemma identity override on the TUI/gateway).
 */
function fakeSession(model: { provider: string; id: string }, tools: string[]) {
	let pinned = "";
	return {
		session: {
			model,
			thinkingLevel: "off",
			agent: {
				state: {
					tools: tools.map((name) => ({ name })),
					get systemPrompt() {
						return pinned;
					},
					set systemPrompt(v: string) {
						pinned = v;
					},
				},
			},
		},
		getPinned: () => pinned,
	};
}

describe("refreshSessionSystemPrompt — reads model.id (not model.modelId)", () => {
	it("fires the Google family identity override for an ollama gemma model via .id", async () => {
		const { session, getPinned } = fakeSession(
			{ provider: "ollama", id: "gemma4:e2b" },
			["read", "recall_memory", "read_memory"],
		);
		await refreshSessionSystemPrompt(session as never, getBrigadeWorkspaceDir());
		const text = getPinned();
		// The whole point: with the .id fix, modelId resolves to "gemma4:e2b"
		// (not "unknown"), so the family guidance fires.
		assert.match(text, /Identity override \(Google family\)/);
		assert.match(text, /I am Gemini/);
	});

	it("does NOT fire a family override for Claude (id read correctly, returns null)", async () => {
		const { session, getPinned } = fakeSession(
			{ provider: "anthropic", id: "claude-opus-4-7" },
			["read"],
		);
		await refreshSessionSystemPrompt(session as never, getBrigadeWorkspaceDir());
		assert.doesNotMatch(getPinned(), /Identity override/);
	});

	it("derives ## Memory + tool list from the session's live tools", async () => {
		const { session, getPinned } = fakeSession(
			{ provider: "ollama", id: "llama3.2:3b" },
			["read", "write", "recall_memory", "read_memory"],
		);
		await refreshSessionSystemPrompt(session as never, getBrigadeWorkspaceDir());
		const text = getPinned();
		assert.match(text, /## Memory/);
		assert.match(text, /recall_memory/);
	});

	it("no ## Memory when the session has no memory tools", async () => {
		const { session, getPinned } = fakeSession(
			{ provider: "anthropic", id: "claude-opus-4-7" },
			["read", "write", "bash"],
		);
		await refreshSessionSystemPrompt(session as never, getBrigadeWorkspaceDir());
		assert.doesNotMatch(getPinned(), /## Memory/);
	});
});
