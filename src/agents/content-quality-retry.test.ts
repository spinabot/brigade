import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { detectContentIssue, runWithContentQualityRetry } from "./content-quality-retry.js";

describe("detectContentIssue — base cases", () => {
	it("returns null for non-assistant messages", () => {
		assert.equal(detectContentIssue({ role: "user", content: [] }, true), null);
		assert.equal(detectContentIssue({ role: "system", content: [] }, true), null);
		assert.equal(detectContentIssue(null, true), null);
		assert.equal(detectContentIssue(undefined, true), null);
	});

	it("returns 'empty' for assistant messages with no content blocks", () => {
		assert.equal(detectContentIssue({ role: "assistant", content: [] }, true), "empty");
		assert.equal(detectContentIssue({ role: "assistant", content: undefined }, true), "empty");
	});

	it("returns null for a healthy text reply", () => {
		assert.equal(
			detectContentIssue(
				{ role: "assistant", content: [{ type: "text", text: "Here's the answer: 42." }] },
				true,
			),
			null,
		);
	});
});

describe("detectContentIssue — reasoning-only", () => {
	it("flags thinking blocks with no text + no tool call", () => {
		assert.equal(
			detectContentIssue(
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "Let me reason about this..." }],
				},
				true,
			),
			"reasoning-only",
		);
	});

	it("does NOT flag when thinking has empty text in addition", () => {
		// An empty text block alongside thinking should still be reasoning-only
		// because the user sees no visible reply.
		assert.equal(
			detectContentIssue(
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "..." },
						{ type: "text", text: "   " },
					],
				},
				true,
			),
			"reasoning-only",
		);
	});

	it("does NOT flag thinking + visible text (healthy reply)", () => {
		assert.equal(
			detectContentIssue(
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "..." },
						{ type: "text", text: "The answer is 42." },
					],
				},
				true,
			),
			null,
		);
	});

	it("does NOT flag thinking + tool call (healthy action)", () => {
		assert.equal(
			detectContentIssue(
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "..." },
						{ type: "toolCall", name: "read", arguments: {} },
					],
				},
				true,
			),
			null,
		);
	});
});

describe("detectContentIssue — planning-only", () => {
	const planningContent = (text: string) => ({
		role: "assistant",
		content: [{ type: "text", text }],
	});

	it("flags 'I'll do X' patterns when tools are available", () => {
		assert.equal(detectContentIssue(planningContent("I'll write the script for you."), true), "planning-only");
		assert.equal(detectContentIssue(planningContent("Let me create the file."), true), "planning-only");
		assert.equal(detectContentIssue(planningContent("I will implement this now."), true), "planning-only");
		assert.equal(detectContentIssue(planningContent("Here's how I'll fix the bug."), true), "planning-only");
	});

	it("does NOT flag planning patterns when tools are NOT available", () => {
		// Without tools, "I'll write the script" IS the deliverable.
		assert.equal(detectContentIssue(planningContent("I'll write the script for you."), false), null);
	});

	it("does NOT flag when the planning phrase is mid-sentence (quoted user message)", () => {
		assert.equal(
			detectContentIssue(
				planningContent('The user said "I\'ll fix it" but they meant "fix you" instead.'),
				true,
			),
			null,
		);
	});

	it("does NOT flag a healthy direct answer", () => {
		assert.equal(detectContentIssue(planningContent("The answer is 42."), true), null);
		assert.equal(detectContentIssue(planningContent("Here's the result: 42."), true), null);
	});

	it("does NOT flag when a tool call is present alongside a planning phrase", () => {
		// Model said "I'll do X" AND actually did it via tool call → healthy.
		assert.equal(
			detectContentIssue(
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I'll create the file now." },
						{ type: "toolCall", name: "write", arguments: { path: "foo.ts" } },
					],
				},
				true,
			),
			null,
		);
	});
});

describe("detectContentIssue — empty fallthrough", () => {
	it("flags assistant message with only empty text blocks", () => {
		assert.equal(
			detectContentIssue(
				{ role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "   " }] },
				true,
			),
			"empty",
		);
	});

	it("does NOT flag empty text when a tool call is present", () => {
		assert.equal(
			detectContentIssue(
				{
					role: "assistant",
					content: [
						{ type: "text", text: "" },
						{ type: "toolCall", name: "read", arguments: { path: "foo" } },
					],
				},
				true,
			),
			null,
		);
	});
});

describe("detectContentIssue — slop (Step 31 post-generation gate)", () => {
	const txt = (text: string) => ({ role: "assistant" as const, content: [{ type: "text", text }] });
	it("flags a reply dense with filler / cliché phrasing", () => {
		const slop =
			"At the end of the day, it's important to note that we need to leverage synergy to unlock value. " +
			"In today's fast-paced world, let's circle back and move the needle going forward to take it to the next level.";
		assert.equal(detectContentIssue(txt(slop), true), "slop");
	});
	it("does NOT flag a concrete, substantive reply", () => {
		assert.equal(
			detectContentIssue(txt("Fixed the null check in parseConfig() at line 42; the failing test passes now."), true),
			null,
		);
	});
	it("structural issues take priority over slop (empty content stays empty)", () => {
		assert.equal(detectContentIssue({ role: "assistant", content: [] }, true), "empty");
	});
});

describe("runWithContentQualityRetry — slop gate forces rewrites until clean", () => {
	const txt = (text: string) => ({ role: "assistant" as const, content: [{ type: "text", text }] });
	const SLOP =
		"At the end of the day, it's important to note that we need to leverage synergy to unlock value. " +
		"In today's fast-paced world, let's circle back and move the needle going forward to take it to the next level.";
	const CLEAN = "Fixed the null check in parseConfig() at line 42; the failing test passes now.";

	// A fake session whose each prompt() pushes the next scripted assistant message
	// (the LAST entry repeats if prompts outrun the script). The body callback pushes
	// the initial message itself.
	function fakeSession(promptOutputs: Array<{ role: string; content: unknown }>) {
		const messages: Array<{ role: string; content: unknown }> = [];
		let prompts = 0;
		const session = {
			messages,
			agent: { state: { tools: [] } },
			prompt: async (_t: string) => {
				const out = promptOutputs[prompts] ?? promptOutputs[promptOutputs.length - 1];
				if (out) messages.push(out);
				prompts++;
			},
		} as unknown as Parameters<typeof runWithContentQualityRetry>[0];
		return { session, messages, getPrompts: () => prompts };
	}

	it("re-prompts until the reply clears the slop bar, then ships", async () => {
		// body=slop, rewrite#1 still slop, rewrite#2 clean → stops after 2 prompts.
		const { session, messages, getPrompts } = fakeSession([txt(SLOP), txt(CLEAN)]);
		const retries: string[] = [];
		await runWithContentQualityRetry(
			session,
			async () => {
				messages.push(txt(SLOP));
			},
			{ onRetry: (r) => retries.push(r), maxSlopRewrites: 4 },
		);
		assert.equal(getPrompts(), 2, "kept forcing a rewrite until the reply was clean");
		assert.deepEqual(retries, ["slop", "slop"], "each rewrite reported");
	});

	it("caps the rewrites and ships the last attempt if slop persists", async () => {
		const { session, messages, getPrompts } = fakeSession([txt(SLOP)]); // every rewrite still slop
		const retries: string[] = [];
		await runWithContentQualityRetry(
			session,
			async () => {
				messages.push(txt(SLOP));
			},
			{ onRetry: (r) => retries.push(r), maxSlopRewrites: 2 },
		);
		assert.equal(getPrompts(), 2, "stopped at maxSlopRewrites — no infinite loop");
		assert.deepEqual(retries, ["slop", "slop"], "onRetry fired exactly maxSlopRewrites times, all slop");
	});

	it("a recovery issue (empty) gets exactly ONE re-prompt, not a loop", async () => {
		const { session, messages, getPrompts } = fakeSession([txt(CLEAN)]);
		await runWithContentQualityRetry(session, async () => {
			messages.push({ role: "assistant", content: [] });
		});
		assert.equal(getPrompts(), 1, "one re-prompt for a recovery issue");
		assert.equal(messages.length, 2, "exactly two messages: initial empty + clean recovery reply");
	});
});

describe("harness backends: the recovery tier must not re-run side effects", () => {
	// A harness (claude-cli) runs tools in an external binary, so its assistant
	// message can only ever hold text/thinking. Every recovery heuristic reads
	// "never called a tool" and would re-prompt — and a re-prompt RESPAWNS the
	// binary, re-running `bash ./deploy.sh`. `toolActivity` is how the backend
	// says "I acted". A re-prompt is `session.prompt(...)`, so that is what we count.
	const plannedButActed = {
		role: "assistant",
		content: [{ type: "text", text: "Let me run the deploy for you." }],
	};

	function fakeSession(messages: unknown[]) {
		const state = { reprompts: 0 };
		const session = {
			messages,
			agent: { state: { tools: [{ name: "bash" }] } },
			prompt: async () => {
				state.reprompts++;
			},
		};
		return { session: session as never, state };
	}

	it("planning-only text does NOT re-prompt when the harness reports tool activity", async () => {
		const { session, state } = fakeSession([plannedButActed]);
		await runWithContentQualityRetry(session, async () => {}, { toolActivity: () => true });
		assert.equal(state.reprompts, 0, "the deploy must not run a second time");
	});

	it("...but WITHOUT that signal the same turn IS re-prompted (loop-backend behaviour, unchanged)", async () => {
		const { session, state } = fakeSession([plannedButActed]);
		await runWithContentQualityRetry(session, async () => {}, {});
		assert.equal(state.reprompts, 1, "recovery tier still fires for loop backends");
	});

	it("an empty reply after real harness work is accepted, not re-driven", async () => {
		const { session, state } = fakeSession([{ role: "assistant", content: [] }]);
		await runWithContentQualityRetry(session, async () => {}, { toolActivity: () => true });
		assert.equal(state.reprompts, 0);
	});

	it("toolActivity=false leaves loop-backend behaviour untouched", async () => {
		const { session, state } = fakeSession([plannedButActed]);
		await runWithContentQualityRetry(session, async () => {}, { toolActivity: () => false });
		assert.equal(state.reprompts, 1);
	});
});
