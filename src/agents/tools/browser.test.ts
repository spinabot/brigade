/**
 * Tests for the browser tool's schema + identity. The Playwright-driven
 * runtime is not exercised here (requires Chromium); the surface contract
 * is checked instead.
 */

import { strict as assert } from "node:assert";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	BrowserSchema,
	BROWSER_ACTIONS,
	closeRestoredStartupPages,
	findRealBrowserUserDataRoot,
	makeBrowserTool,
	realBrowserUserDataRoots,
	resolveUserDataDirOverride,
} from "./browser.js";

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

describe("BRIGADE_BROWSER_USER_DATA_DIR guard", () => {
	const winEnv = {
		LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
		APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
	};

	it("refuses an override resolving inside a real browser's user-data dir (win32)", () => {
		const override = "C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\User Data";
		assert.throws(
			() => resolveUserDataDirOverride(override, "default", winEnv, "win32"),
			/real browser's user-data dir/,
			"the classic accident — Chrome's User Data as the override — must throw",
		);
	});

	it("matches case-insensitively on win32 (default collides with Default)", () => {
		const override = "C:\\Users\\dev\\AppData\\Local\\google\\chrome\\user data";
		assert.ok(
			findRealBrowserUserDataRoot(`${override}\\default`, winEnv, "win32"),
			"on Windows, <User Data>/default IS Chrome's Default profile",
		);
	});

	it("allows a dedicated override outside every real browser dir", () => {
		const override = join("D:", "brigade-profiles");
		assert.equal(resolveUserDataDirOverride(override, "work", {}, "linux"), join(override, "work"));
	});

	it("finds no browser root under ~/.brigade", () => {
		assert.equal(
			findRealBrowserUserDataRoot("/home/dev/.brigade/browser/default", { HOME: "/home/dev" }, "linux"),
			undefined,
		);
	});

	it("matches linux chromium roots case-sensitively", () => {
		const env = { HOME: "/home/dev" };
		// Built with join() so the expectation tracks the host's separators;
		// the platform parameter controls only case-folding semantics.
		const chromiumRoot = join(env.HOME, ".config", "chromium");
		assert.equal(findRealBrowserUserDataRoot(chromiumRoot, env, "linux"), chromiumRoot);
		assert.equal(
			findRealBrowserUserDataRoot(chromiumRoot.replace("chromium", "Chromium"), env, "linux"),
			undefined,
			"a case-only near-miss on a case-sensitive filesystem is a different directory",
		);
	});

	it("refuses this machine's real browser dir, derived from the live environment", () => {
		const roots = realBrowserUserDataRoots();
		const browserRoot = roots.find((r) => /chrome|chromium|edge|brave|firefox|opera/i.test(r));
		assert.ok(browserRoot, `expected at least one browser root, got ${JSON.stringify(roots)}`);
		if (browserRoot) {
			assert.throws(() => resolveUserDataDirOverride(browserRoot, "default"), /real browser's user-data dir/);
		}
	});
});

describe("closeRestoredStartupPages", () => {
	function makePage(opts: { gotoFails?: boolean; closeFails?: boolean } = {}) {
		const events = { navigated: [] as string[], closed: 0 };
		return {
			events,
			page: {
				async goto(url: string): Promise<null> {
					events.navigated.push(url);
					if (opts.gotoFails) throw new Error("navigating blew up");
					return null;
				},
				async close(): Promise<void> {
					if (opts.closeFails) throw new Error("already gone");
					events.closed += 1;
				},
			},
		};
	}

	it("keeps one page on about:blank and closes the rest", async () => {
		const a = makePage();
		const b = makePage();
		const c = makePage();
		const closed = await closeRestoredStartupPages({
			pages: () => [a.page, b.page, c.page],
		});
		assert.equal(closed, 2);
		assert.deepEqual(a.events.navigated, ["about:blank"], "the kept page must not stay on a restored tab");
		assert.equal(b.events.closed, 1);
		assert.equal(c.events.closed, 1);
	});

	it("returns 0 when there is nothing to collapse (no pages(), no pages)", async () => {
		assert.equal(await closeRestoredStartupPages({}), 0);
		assert.equal(await closeRestoredStartupPages({ pages: () => [] }), 0);
	});

	it("still closes the rest when the kept page fails to navigate", async () => {
		const keep = makePage({ gotoFails: true });
		const rest = makePage();
		const closed = await closeRestoredStartupPages({ pages: () => [keep.page, rest.page] });
		assert.equal(closed, 1, "one bad goto must not leave the other restored tabs open");
	});

	it("tolerates a page that closes itself while we sweep", async () => {
		const keep = makePage();
		const gone = makePage({ closeFails: true });
		const closed = await closeRestoredStartupPages({ pages: () => [keep.page, gone.page] });
		assert.equal(closed, 0, "its own teardown is not our failure");
	});
});
