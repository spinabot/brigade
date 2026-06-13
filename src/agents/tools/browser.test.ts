/**
 * Tests for the browser tool's schema + identity. The Playwright-driven
 * runtime is not exercised here (requires Chromium); the surface contract
 * is checked instead.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { BrowserSchema, BROWSER_ACTIONS, makeBrowserTool } from "./browser.js";

describe("makeBrowserTool — identity + schema", () => {
	const tool = makeBrowserTool();

	it("registers as `browser`", () => {
		assert.equal(tool.name, "browser");
	});

	it("description mentions system-browser auto-detection", () => {
		// `playwright-core` is a Brigade hard dep, so no install step in
		// the description any more. Operator just needs a system Chrome /
		// Chromium / Edge / Brave.
		assert.match(tool.description, /Chrome|Chromium|Edge|Brave/);
		assert.match(tool.description, /[Aa]uto-detects/);
	});

	it("schema requires `action` (a plain string) and documents the full surface", () => {
		const props = (BrowserSchema as unknown as { properties: Record<string, unknown> }).properties;
		assert.ok(props.action, "action is required");
		const required = (BrowserSchema as unknown as { required: string[] }).required ?? [];
		assert.ok(required.includes("action"));
		// `action` is a free string (validated in-tool against BROWSER_ACTIONS),
		// NOT a literal union — so an unknown action reaches the dispatch
		// `default` and returns a clean "unknown action — valid: …" error
		// instead of Pi's cryptic "must be equal to constant" repeated per
		// literal. Pin that shape here.
		const action = props.action as { type?: string; anyOf?: unknown; description?: string };
		assert.equal(action.type, "string", "action is a plain string param");
		assert.equal(action.anyOf, undefined, "action is no longer a literal union");
		// The model loses the JSON-schema enum, so the description MUST still
		// enumerate every action. If a new action ships without being named in
		// the description, this fails so we don't silently drop guidance.
		const desc = action.description ?? "";
		for (const a of BROWSER_ACTIONS) {
			assert.ok(desc.includes(a), `action "${a}" missing from the action description`);
		}
		// scroll is the action a live lead-gen test surfaced as missing;
		// scrollIntoView (single element) stays distinct from it.
		assert.ok((BROWSER_ACTIONS as readonly string[]).includes("scroll"), "scroll action present");
		assert.ok(
			(BROWSER_ACTIONS as readonly string[]).includes("scrollIntoView"),
			"scrollIntoView still present",
		);
	});

	it("schema exposes new params (profile / disposition / values / files / fields / loadState / endpoint / snapshotFormat)", () => {
		const props = (BrowserSchema as unknown as { properties: Record<string, unknown> }).properties;
		for (const param of [
			"profile",
			"disposition",
			"values",
			"files",
			"fields",
			"loadState",
			"endpoint",
			"snapshotFormat",
			"textGone",
			"timeMs",
			"targetSelector",
			"width",
			"height",
			"maxChars",
			"compact",
			"to",
			"pixels",
			"times",
		]) {
			assert.ok(props[param], `missing param: ${param}`);
		}
	});

	it("schema makes targetId / url / selector / text / script / profile optional", () => {
		const required = (BrowserSchema as unknown as { required: string[] }).required ?? [];
		assert.ok(!required.includes("targetId"));
		assert.ok(!required.includes("url"));
		assert.ok(!required.includes("selector"));
		assert.ok(!required.includes("text"));
		assert.ok(!required.includes("script"));
		assert.ok(!required.includes("profile"));
	});
});

describe("makeBrowserTool — system-browser discovery + error surface", () => {
	it("tool description points at host-installed browsers, not npm install", () => {
		const desc = makeBrowserTool().description;
		// `playwright-core` is a hard dep — operator doesn't run npm install.
		assert.doesNotMatch(desc, /npm install playwright/);
		assert.doesNotMatch(desc, /npx playwright install/);
	});
});
