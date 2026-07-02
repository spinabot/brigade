import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	resolveToolName,
	rewriteToolCallBlock,
	rewriteMessageToolNames,
} from "./tool-name-repair.js";

const ALLOWED = new Set(["browser", "read", "bash", "edit", "write", "grep", "web_search"]);

describe("resolveToolName", () => {
	it("returns null for an already-valid name", () => {
		assert.equal(resolveToolName("browser", ALLOWED), null);
		assert.equal(resolveToolName("read", ALLOWED), null);
	});

	it("maps the browser `action` discriminator used as a tool name → browser", () => {
		// The reported failure: tool=action {"action":"navigate", url}.
		assert.deepEqual(resolveToolName("action", ALLOWED), { name: "browser" });
	});

	it("maps a browser ACTION VALUE used as a tool name → browser + injects action", () => {
		assert.deepEqual(resolveToolName("navigate", ALLOWED), { name: "browser", action: "navigate" });
		assert.deepEqual(resolveToolName("screenshot", ALLOWED), { name: "browser", action: "screenshot" });
	});

	it("resolves case / whitespace variants", () => {
		assert.deepEqual(resolveToolName("Browser", ALLOWED), { name: "browser" });
		assert.deepEqual(resolveToolName("  read  ", ALLOWED), { name: "read" });
	});

	it("strips provider/namespace prefixes", () => {
		assert.deepEqual(resolveToolName("functions.browser", ALLOWED), { name: "browser" });
		assert.deepEqual(resolveToolName("browser.navigate", ALLOWED), { name: "browser" });
	});

	it("returns null when nothing plausibly matches", () => {
		assert.equal(resolveToolName("totally_made_up", ALLOWED), null);
		assert.equal(resolveToolName("", ALLOWED), null);
		assert.equal(resolveToolName(undefined, ALLOWED), null);
	});

	it("does not hijack a real tool that happens to share an action verb name", () => {
		// If "navigate" is itself a registered tool, keep it.
		assert.equal(resolveToolName("navigate", new Set(["navigate", "browser"])), null);
	});
});

describe("rewriteToolCallBlock", () => {
	it("rewrites tool=action {action:navigate} → browser, preserving existing args", () => {
		const out = rewriteToolCallBlock(
			{ type: "toolCall", id: "1", name: "action", arguments: { action: "navigate", url: "https://x" } },
			ALLOWED,
		) as any;
		assert.equal(out.name, "browser");
		assert.deepEqual(out.arguments, { action: "navigate", url: "https://x" });
	});

	it("injects action when the tool was named after an action value with args lacking it", () => {
		const out = rewriteToolCallBlock(
			{ type: "toolCall", id: "2", name: "navigate", arguments: { url: "https://y" } },
			ALLOWED,
		) as any;
		assert.equal(out.name, "browser");
		assert.equal(out.arguments.action, "navigate");
		assert.equal(out.arguments.url, "https://y");
	});

	it("returns null for a valid or non-toolCall block", () => {
		assert.equal(rewriteToolCallBlock({ type: "toolCall", id: "3", name: "read", arguments: {} }, ALLOWED), null);
		assert.equal(rewriteToolCallBlock({ type: "text", text: "hi" }, ALLOWED), null);
	});
});

describe("rewriteMessageToolNames", () => {
	it("rewrites toolCall blocks inside an assistant message and preserves identity when unchanged", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "let me look" },
				{ type: "toolCall", id: "1", name: "action", arguments: { action: "navigate", url: "u" } },
			],
		};
		const out = rewriteMessageToolNames(message, ALLOWED) as any;
		assert.notStrictEqual(out, message); // changed → new object
		assert.equal(out.content[1].name, "browser");

		const clean = { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] };
		assert.strictEqual(rewriteMessageToolNames(clean, ALLOWED), clean); // unchanged → same ref
	});
});
