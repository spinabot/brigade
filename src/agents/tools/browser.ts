/**
 * `browser` tool — Playwright-backed headless browser for tasks the raw
 * `fetch_url` path can't handle.
 *
 * Use when the page is heavily JS-driven, requires interaction (click,
 * fill, scroll), needs a screenshot, needs a PDF render, or needs
 * arbitrary JS evaluated in-page. For plain "fetch + read" use
 * `fetch_url` instead — it's an order of magnitude lighter.
 *
 * Activation: `playwright-core` is a Brigade hard dependency (ships the
 * engine, not Chromium). At launch time we auto-detect a system-installed
 * Chrome / Chromium / Edge / Brave; if none is found we surface a clear
 * actionable error listing the install options + the
 * BRIGADE_BROWSER_EXECUTABLE override.
 *
 * Single browser instance per Brigade process. Tabs are tracked by a
 * Brigade-issued targetId so the agent can drive multiple tabs across
 * turns. The browser auto-shuts when the process exits.
 *
 * Actions exposed (kept tight — composable beats kitchen-sink):
 *   - status / open / close / focus / tabs
 *   - navigate / snapshot / screenshot / pdf
 *   - click / type / evaluate / wait
 *
 * Result envelope: every action returns `{content, details}` where
 * `details.targetId` identifies the active tab. Page text + extracted
 * content is wrapped in the untrusted-content envelope.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve, sep } from "node:path";

import { Type, type Static } from "typebox";

import { buildExternalContentMeta, wrapWebContent } from "../../security/external-content.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { BRIGADE_DIR } from "../../core/config.js";
import { resolveOsCacheDir } from "../../config/paths.js";
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";
import { classifyUrlForSsrf, SsrfBlockedError } from "../../infra/net/fetch-guard.js";
import { htmlToMarkdown, stripEnvelopeMarkers, stripInvisibleUnicode } from "./web-fetch-utils.js";
import type { AgentToolResult, AgentToolUpdateCallback, AnyBrigadeTool, BrigadeTool } from "./types.js";

const log = createSubsystemLogger("brigade/browser");

/* ─────────────────────────── lazy Playwright loader ─────────────────────────── */

// `playwright-core` is a Brigade hard dep (~30 MB engine, no bundled
// Chromium). We type the surface loosely with structural interfaces
// instead of `typeof import("playwright-core")` so typechecking stays
// resilient against minor breaking changes in upstream type defs across
// versions. The real runtime satisfies these shapes transparently.
interface BrowserContextLike {
	close(): Promise<void>;
	/**
	 * Playwright's BrowserContext emits `close` when the underlying
	 * Chrome process disconnects, crashes, or is killed by the OS. We
	 * use this to invalidate `stateP` so the next call rebuilds a
	 * fresh context instead of throwing "context has been closed".
	 */
	on?(event: "close", listener: () => void): void;
	isConnected?(): boolean;
}
interface DialogLike {
	type(): string;
	message(): string;
	defaultValue(): string;
	accept(promptText?: string): Promise<void>;
	dismiss(): Promise<void>;
}
interface ConsoleMessageLike {
	type(): string;
	text(): string;
	location?(): { url?: string; lineNumber?: number; columnNumber?: number };
}
interface LocatorLike {
	hover(opts?: { timeout?: number }): Promise<void>;
	dragTo(other: LocatorLike, opts?: { timeout?: number }): Promise<void>;
	selectOption(values: string | string[], opts?: { timeout?: number }): Promise<unknown>;
	fill(value: string, opts?: { timeout?: number }): Promise<void>;
	scrollIntoViewIfNeeded(opts?: { timeout?: number }): Promise<void>;
	click(opts?: { timeout?: number; force?: boolean }): Promise<void>;
}
interface PageLike {
	goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number; headers(): Record<string, string> } | null>;
	url(): string;
	title(): Promise<string>;
	content(): Promise<string>;
	screenshot(opts?: { fullPage?: boolean; timeout?: number }): Promise<Buffer>;
	pdf(): Promise<Buffer>;
	click(selector: string, opts?: { timeout?: number; force?: boolean }): Promise<void>;
	fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
	evaluate<T = unknown>(source: string): Promise<T>;
	waitForSelector(selector: string, opts?: { timeout?: number; state?: string }): Promise<unknown>;
	waitForFunction<TArg>(fn: (arg: TArg) => boolean, arg: TArg, opts?: { timeout?: number }): Promise<unknown>;
	waitForURL(url: string, opts?: { timeout?: number }): Promise<void>;
	waitForLoadState(state: string, opts?: { timeout?: number }): Promise<void>;
	waitForTimeout(ms: number): Promise<void>;
	keyboard: { press(key: string, opts?: { delay?: number }): Promise<void> };
	setViewportSize(size: { width: number; height: number }): Promise<void>;
	setInputFiles(selector: string, files: string | string[]): Promise<void>;
	locator(selector: string): LocatorLike;
	on(event: "console", listener: (msg: ConsoleMessageLike) => void): void;
	on(event: "pageerror", listener: (err: Error) => void): void;
	on(event: "dialog", listener: (dialog: DialogLike) => void): void;
	off?(event: string, listener: (...args: unknown[]) => void): void;
	close(): Promise<void>;
	isClosed?(): boolean;
}
interface BrowserLike extends BrowserContextLike {
	newPage(): Promise<PageLike>;
	pages?(): PageLike[];
}
interface PlaywrightLike {
	chromium: {
		launch(opts?: {
			headless?: boolean;
			timeout?: number;
			executablePath?: string;
			channel?: string;
			args?: string[];
			ignoreDefaultArgs?: boolean | string[];
		}): Promise<BrowserLike>;
		launchPersistentContext(
			userDataDir: string,
			opts?: {
				headless?: boolean;
				timeout?: number;
				executablePath?: string;
				args?: string[];
				ignoreDefaultArgs?: boolean | string[];
			},
		): Promise<BrowserLike>;
		connectOverCDP(endpointURL: string, opts?: { timeout?: number }): Promise<{
			contexts(): BrowserLike[];
			newContext(): Promise<BrowserLike>;
			close(): Promise<void>;
		}>;
	};
}
type Browser = BrowserLike;
type Page = PageLike;

let playwrightP: Promise<PlaywrightLike> | null = null;

/**
 * Lazy-load Playwright. Prefers `playwright-core` (Brigade's hard dep —
 * ships the engine WITHOUT bundling Chromium) and falls back to
 * `playwright` (which bundles Chromium) when an operator has it
 * installed. Either works for our use case.
 */
async function loadPlaywright(): Promise<PlaywrightLike> {
	if (!playwrightP) {
		playwrightP = (async () => {
			try {
				return (await import(/* @vite-ignore */ "playwright-core" as string)) as unknown as PlaywrightLike;
			} catch {
				return (await import(/* @vite-ignore */ "playwright" as string)) as unknown as PlaywrightLike;
			}
		})().catch((err) => {
			playwrightP = null;
			throw err;
		});
	}
	return playwrightP;
}

/* ─────────────────────────── system browser discovery ─────────────────────────── */

/**
 * Find a Chromium-family browser binary on the host. Mirrors the
 * upstream reference's executable-discovery cascade: explicit env var
 * → standard system install paths per platform → null. Brigade ships
 * `playwright-core` (no bundled Chromium), so we rely on a
 * system-installed Chrome / Chromium / Edge / Brave.
 */
function findSystemBrowserExecutable(): string | null {
	const explicit = (process.env.BRIGADE_BROWSER_EXECUTABLE ?? "").trim();
	if (explicit) return explicit;

	const platform = process.platform;
	const candidates: string[] = [];

	if (platform === "win32") {
		const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
		const programFiles86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const localAppData = process.env["LocalAppData"] ?? "";
		candidates.push(
			`${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
			`${programFiles86}\\Google\\Chrome\\Application\\chrome.exe`,
			`${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
			`${programFiles86}\\Microsoft\\Edge\\Application\\msedge.exe`,
			`${programFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
			localAppData ? `${localAppData}\\Google\\Chrome\\Application\\chrome.exe` : "",
		);
	} else if (platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		);
	} else {
		// Linux / WSL / BSD
		candidates.push(
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/usr/bin/microsoft-edge",
			"/usr/bin/brave-browser",
			"/snap/bin/chromium",
			"/snap/bin/google-chrome",
		);
	}

	for (const p of candidates) {
		if (!p) continue;
		try {
			if (existsSync(p)) return p;
		} catch {
			/* permission denied — try the next */
		}
	}
	return null;
}

/* ─────────────────────────── single-process browser state ─────────────────────────── */

/** Captured console/page event for the `console` action. */
interface ConsoleEvent {
	type: string;
	text: string;
	url?: string;
	lineNumber?: number;
	timestamp: number;
}

/** Captured dialog event for the `dialog` action. */
interface DialogEvent {
	type: string;
	message: string;
	defaultValue: string;
	handled: "accepted" | "dismissed" | "pending";
	timestamp: number;
}

interface TabHandle {
	page: Page;
	consoleLog: ConsoleEvent[];
	dialogLog: DialogEvent[];
	/** Pending dialog handler — if set, the next dialog auto-applies this disposition. */
	pendingDialog: { disposition: "accept" | "dismiss"; promptText?: string } | null;
	/** Profile this tab was opened under. */
	profile: string;
	/** Bound listeners so we can detach on close. */
	consoleListener: (msg: ConsoleMessageLike) => void;
	dialogListener: (dialog: DialogLike) => void;
	pageErrorListener: (err: Error) => void;
}

interface BrowserState {
	browser: Browser;
	tabs: Map<string, TabHandle>; // targetId → TabHandle
	focusedTargetId: string | null;
	nextId: number;
	profile: string;
	/** Source of the browser process: "launched" = Brigade owns lifecycle; "attached" = CDP'd to a pre-existing Chrome. */
	source: "launched" | "attached";
}

/** Per-profile lazy state. Default profile is `"default"`; sub-agents
 *  + the operator can use named profiles to isolate cookies/storage. */
const PROFILE_STATE: Map<string, Promise<BrowserState>> = new Map();
const DEFAULT_PROFILE = "default";

/**
 * Brigade-managed profiles live under `~/.brigade/browser/<name>/`. The
 * default profile is always present; others are created on first use.
 * `attached:<endpoint>` is a special pseudo-profile that points at an
 * existing Chrome via CDP — no userDataDir, no lifecycle ownership.
 */
function isAttachedProfile(name: string): boolean {
	return name.startsWith("attached:");
}

function profileUserDataDir(name: string): string {
	if (isAttachedProfile(name))
		throw new Error("browser: attached profiles have no user data dir");
	// Keep profile names tame — restrict to a portable charset so we
	// don't generate unwriteable paths on Windows.
	const safe = name.replace(/[^a-z0-9_.-]/gi, "_");
	// Convex mode: Chromium owns this directory (SQLite + LevelDB + caches —
	// hundreds of files only Chromium can coherently write), so it cannot
	// ride Convex; it lives in the OS cache dir instead of ~/.brigade.
	// Machine-local by nature: cookies/logins don't roam, which is the
	// accepted trade-off. BRIGADE_BROWSER_USER_DATA_DIR overrides both modes.
	const override = process.env.BRIGADE_BROWSER_USER_DATA_DIR?.trim();
	if (override) return join(override, safe || DEFAULT_PROFILE);
	if (tryGetRuntimeContext()?.mode === "convex") {
		return join(resolveOsCacheDir(), "browser", safe || DEFAULT_PROFILE);
	}
	return join(BRIGADE_DIR, "browser", safe || DEFAULT_PROFILE);
}

async function ensureBrowser(opts: {
	headless: boolean;
	timeoutMs: number;
	profile?: string;
}): Promise<BrowserState> {
	const profile = (opts.profile ?? DEFAULT_PROFILE).trim() || DEFAULT_PROFILE;
	const existing = PROFILE_STATE.get(profile);
	if (existing) return existing;
	const launching = (async () => {
		const pw = await loadPlaywright();

		// CDP attach path — `attached:<endpoint>` profile attaches to a
		// pre-existing Chrome via /json/version handshake.
		if (isAttachedProfile(profile)) {
			const endpoint = profile.slice("attached:".length).trim();
			if (!endpoint) throw new Error("browser: attached profile is missing endpoint URL");
			const state = await attachOverCdp(pw, { endpoint, profile, timeoutMs: opts.timeoutMs });
			return state;
		}

		const executablePath = findSystemBrowserExecutable();
		if (!executablePath) {
			throw new Error(
				[
					"browser: no Chrome / Chromium / Edge / Brave found on this system.",
					"To use this tool, install one of:",
					"  - Google Chrome   (https://www.google.com/chrome/)",
					"  - Chromium        (apt install chromium-browser, brew install --cask chromium)",
					"  - Microsoft Edge",
					"  - Brave Browser",
					"Or set BRIGADE_BROWSER_EXECUTABLE=/absolute/path/to/your/browser before starting Brigade.",
				].join("\n"),
			);
		}
		// Persistent profile dir under `~/.brigade/browser/<profile>/`. Cookies,
		// cache, Cloudflare passes — everything survives across turns AND
		// across gateway restarts. First visit to a bot-protected site takes
		// the full challenge time; revisits go straight through.
		const userDataDir = profileUserDataDir(profile);
		try {
			mkdirSync(userDataDir, { recursive: true });
		} catch {
			/* best effort — playwright will surface a clearer error if it can't write */
		}

		// Chrome flags. `--headless=new` selects the modern headless renderer
		// (~2024+) which is dramatically faster than the legacy headless mode
		// Playwright defaults to. `--disable-gpu` is the recommended pairing
		// for headless. `--disable-http2` keeps real-world sites with broken
		// H/2 stacks (Justdial, IndiaMART, etc.) from throwing
		// ERR_HTTP2_PROTOCOL_ERROR.
		const args: string[] = [
			"--disable-http2",
			"--disable-blink-features=AutomationControlled",
			"--disable-features=Translate,OptimizationHints,MediaRouter",
			"--no-default-browser-check",
			"--no-first-run",
			"--disable-sync",
			"--disable-background-networking",
			"--disable-component-update",
		];
		if (opts.headless) {
			args.push("--headless=new", "--disable-gpu");
		}

		const browser = await pw.chromium.launchPersistentContext(userDataDir, {
			headless: opts.headless,
			timeout: opts.timeoutMs,
			executablePath,
			args,
		});
		const state: BrowserState = {
			browser,
			tabs: new Map(),
			focusedTargetId: null,
			nextId: 1,
			profile,
			source: "launched",
		};
		// Auto-invalidate when the context dies. Playwright emits `close`
		// on the BrowserContext (which is what launchPersistentContext
		// returns) when the underlying Chrome process disconnects,
		// crashes, or is killed externally. Without this, the next call
		// would dereference a dead context and throw
		// "browserContext.newPage: Target page, context or browser has been
		// closed". Clearing the profile cache makes the next `ensureBrowser`
		// rebuild a fresh one from scratch.
		try {
			browser.on?.("close", () => {
				log.debug("browser: context closed; resetting state for next call", { profile });
				PROFILE_STATE.delete(profile);
			});
		} catch {
			/* on() not available on this version — fall back to lazy retry below */
		}
		// Best-effort cleanup on process exit. We don't await here — the
		// process is exiting anyway; if the close hangs we'd rather get out.
		const cleanup = () => {
			void browser.close().catch(() => {});
		};
		process.once("exit", cleanup);
		process.once("SIGTERM", cleanup);
		process.once("SIGINT", cleanup);
		return state;
	})().catch((err) => {
		PROFILE_STATE.delete(profile);
		throw err;
	});
	PROFILE_STATE.set(profile, launching);
	return launching;
}

/**
 * Attach to an existing Chrome via the DevTools Protocol. The endpoint is
 * the WebSocket URL Chrome surfaces when launched with
 * `--remote-debugging-port=N`. Brigade uses the first existing context if
 * one exists; otherwise creates a fresh isolated one. The attached browser
 * is NOT owned by Brigade — `stop` does not close it (only detaches).
 */
async function attachOverCdp(
	pw: PlaywrightLike,
	args: { endpoint: string; profile: string; timeoutMs: number },
): Promise<BrowserState> {
	const cdpBrowser = await pw.chromium.connectOverCDP(args.endpoint, { timeout: args.timeoutMs });
	const contexts = cdpBrowser.contexts();
	const ctx = contexts.length > 0 && contexts[0] ? contexts[0] : await cdpBrowser.newContext();
	const state: BrowserState = {
		browser: ctx,
		tabs: new Map(),
		focusedTargetId: null,
		nextId: 1,
		profile: args.profile,
		source: "attached",
	};
	try {
		ctx.on?.("close", () => {
			log.debug("browser: attached context closed", { profile: args.profile });
			PROFILE_STATE.delete(args.profile);
		});
	} catch {
		/* best effort */
	}
	// Pre-populate tabs from already-open pages so the agent can act on
	// them without explicitly calling `open`.
	try {
		const existingPages = ctx.pages?.() ?? [];
		for (const p of existingPages) {
			const handle = buildTabHandle(state, p);
			const targetId = `tab-${state.nextId}`;
			state.nextId += 1;
			state.tabs.set(targetId, handle);
			if (!state.focusedTargetId) state.focusedTargetId = targetId;
		}
	} catch {
		/* page enumeration failed — agent can open fresh tabs */
	}
	return state;
}

/** Probe a CDP endpoint quickly to verify reachability before attach. */
async function probeCdpEndpoint(endpoint: string, timeoutMs: number): Promise<boolean> {
	// Accept ws:// + http:// forms. Most operators paste the
	// /json/version URL; some paste the bare ws endpoint. Normalize to
	// the discovery URL Chrome serves on the debug port.
	let discoveryUrl: string;
	try {
		const u = new URL(endpoint);
		const proto = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol;
		discoveryUrl = `${proto}//${u.host}/json/version`;
	} catch {
		return false;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	try {
		const res = await fetch(discoveryUrl, { signal: controller.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

function buildTabHandle(state: BrowserState, page: Page): TabHandle {
	const handle: TabHandle = {
		page,
		consoleLog: [],
		dialogLog: [],
		pendingDialog: null,
		profile: state.profile,
		consoleListener: (msg) => {
			try {
				const loc = msg.location?.();
				const ev: ConsoleEvent = {
					type: msg.type(),
					text: msg.text(),
					url: loc?.url,
					lineNumber: loc?.lineNumber,
					timestamp: Date.now(),
				};
				handle.consoleLog.push(ev);
				// Cap to last 500 entries to keep the buffer bounded — long
				// JS-heavy pages can spam thousands of console messages.
				if (handle.consoleLog.length > 500) handle.consoleLog.shift();
			} catch {
				/* ignore listener errors */
			}
		},
		dialogListener: (dialog) => {
			const ev: DialogEvent = {
				type: dialog.type(),
				message: dialog.message(),
				defaultValue: dialog.defaultValue(),
				handled: "pending",
				timestamp: Date.now(),
			};
			handle.dialogLog.push(ev);
			if (handle.dialogLog.length > 100) handle.dialogLog.shift();
			const pending = handle.pendingDialog;
			if (pending) {
				if (pending.disposition === "accept") {
					ev.handled = "accepted";
					void dialog.accept(pending.promptText).catch(() => {});
				} else {
					ev.handled = "dismissed";
					void dialog.dismiss().catch(() => {});
				}
				handle.pendingDialog = null;
			} else {
				// Default: auto-dismiss so pages can't hang the agent on a
				// modal. Operator can pre-arm `dialog:accept` to override.
				ev.handled = "dismissed";
				void dialog.dismiss().catch(() => {});
			}
		},
		pageErrorListener: (err) => {
			handle.consoleLog.push({
				type: "pageerror",
				text: err.message,
				timestamp: Date.now(),
			});
			if (handle.consoleLog.length > 500) handle.consoleLog.shift();
		},
	};
	try {
		page.on("console", handle.consoleListener);
		page.on("pageerror", handle.pageErrorListener);
		page.on("dialog", handle.dialogListener);
	} catch {
		/* listener registration failed — agent loses telemetry but tool still works */
	}
	return handle;
}

/**
 * Detach the console/dialog/pageerror listeners we attached in
 * `buildTabHandle`. Playwright's `Page.off` removes a specific listener
 * by reference — we kept the bound functions on the handle so we can
 * pass them back here. Best-effort: `off()` may not exist on every
 * Playwright minor version, in which case we leave the listeners
 * attached (the page is about to close anyway, so GC reclaims them).
 */
function detachTabListeners(handle: TabHandle): void {
	const page = handle.page;
	try {
		page.off?.("console", handle.consoleListener as unknown as (...args: unknown[]) => void);
		page.off?.("pageerror", handle.pageErrorListener as unknown as (...args: unknown[]) => void);
		page.off?.("dialog", handle.dialogListener as unknown as (...args: unknown[]) => void);
	} catch {
		/* off() unavailable — close-time GC handles it */
	}
}

function isStaleError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /has been closed|browser has crashed|Target page, context or browser|Target closed|Page closed/i.test(
		msg,
	);
}

async function getActivePage(
	state: BrowserState,
	requestedId?: string,
): Promise<{ handle: TabHandle; targetId: string }> {
	if (requestedId) {
		const handle = state.tabs.get(requestedId);
		if (!handle) throw new Error(`browser: unknown targetId "${requestedId}"`);
		// Stale-target recovery: if the page closed underneath us, drop the
		// handle and either return the next viable tab OR open a fresh one.
		if (handle.page.isClosed?.()) {
			state.tabs.delete(requestedId);
			if (state.focusedTargetId === requestedId) state.focusedTargetId = null;
			throw new Error(
				`browser: tab "${requestedId}" was closed underneath us — call the action again without targetId to use a fresh tab.`,
			);
		}
		return { handle, targetId: requestedId };
	}
	if (state.focusedTargetId) {
		const handle = state.tabs.get(state.focusedTargetId);
		if (handle && !handle.page.isClosed?.()) {
			return { handle, targetId: state.focusedTargetId };
		}
		// Focused tab is gone — clear + fall through.
		if (handle) state.tabs.delete(state.focusedTargetId);
		state.focusedTargetId = null;
	}
	// No focused tab — open a fresh one.
	return openNewTab(state);
}

async function openNewTab(
	state: BrowserState,
	url?: string,
	opts?: {
		waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
		timeout?: number;
	},
): Promise<{ handle: TabHandle; targetId: string }> {
	// Defensive recovery: if the persistent context died between
	// `ensureBrowser` and here (Chrome crashed, OS killed it, user closed
	// the visible window), `newPage()` throws "context has been closed".
	// Detect that, null out the cached state for this profile, and surface
	// a clear error so the next tool call rebuilds rather than re-using
	// the dead state.
	let page: Page;
	try {
		page = await state.browser.newPage();
	} catch (err) {
		if (isStaleError(err)) {
			PROFILE_STATE.delete(state.profile);
			throw new Error(
				"browser: the underlying Chrome process closed unexpectedly (window manually closed, OS killed it, or it crashed). Call the browser action again — it will re-launch automatically.",
			);
		}
		throw err;
	}
	const handle = buildTabHandle(state, page);
	const targetId = `tab-${state.nextId}`;
	state.nextId += 1;
	state.tabs.set(targetId, handle);
	state.focusedTargetId = targetId;
	if (url) {
		await page.goto(url, {
			waitUntil: opts?.waitUntil ?? "domcontentloaded",
			timeout: opts?.timeout,
		});
	}
	return { handle, targetId };
}

/* ─────────────────────────── schema + result ─────────────────────────── */

const BrowserSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("start"),
			Type.Literal("stop"),
			Type.Literal("profiles"),
			Type.Literal("attach"),
			Type.Literal("tabs"),
			Type.Literal("open"),
			Type.Literal("focus"),
			Type.Literal("close"),
			Type.Literal("navigate"),
			Type.Literal("snapshot"),
			Type.Literal("screenshot"),
			Type.Literal("pdf"),
			Type.Literal("click"),
			Type.Literal("type"),
			Type.Literal("press"),
			Type.Literal("hover"),
			Type.Literal("drag"),
			Type.Literal("select"),
			Type.Literal("fill"),
			Type.Literal("resize"),
			Type.Literal("scrollIntoView"),
			Type.Literal("evaluate"),
			Type.Literal("wait"),
			Type.Literal("console"),
			Type.Literal("dialog"),
			Type.Literal("upload"),
		],
		{
			description:
				"Action to perform. `start`/`stop`/`profiles`/`attach` manage lifecycle; `status`/`tabs` introspect; `open`/`navigate` for nav; `snapshot` returns the page as markdown; `screenshot` returns base64 PNG; `pdf` returns base64 PDF; `click`/`type`/`press`/`hover`/`drag`/`select`/`fill`/`scrollIntoView` for interaction; `resize` changes the viewport; `evaluate` runs JS; `wait` blocks on a condition; `console` returns captured logs; `dialog` arms an auto-handler; `upload` sets file inputs.",
		},
	),
	profile: Type.Optional(
		Type.String({
			description:
				"Named browser profile (defaults to 'default'). Each profile gets an isolated `~/.brigade/browser/<name>/` user-data dir — cookies/storage are independent. Use distinct profiles per sub-agent to avoid cross-contamination.",
		}),
	),
	targetId: Type.Optional(
		Type.String({
			description: "Tab id from a prior `open`. Omit to use the focused tab (or open one).",
		}),
	),
	targetId2: Type.Optional(
		Type.String({
			description: "Secondary tab id — currently unused; reserved for future cross-tab drag.",
		}),
	),
	url: Type.Optional(
		Type.String({
			description: "URL for `open` and `navigate` actions. Must be http(s); SSRF-guarded.",
		}),
	),
	selector: Type.Optional(
		Type.String({
			description:
				"CSS selector for `click`/`type`/`press`/`hover`/`select`/`fill`/`scrollIntoView`/`upload`/`wait` actions.",
		}),
	),
	targetSelector: Type.Optional(
		Type.String({
			description: "For `drag`: destination element selector (source is `selector`).",
		}),
	),
	text: Type.Optional(
		Type.String({
			description:
				"Text to type for `type`/`fill`, the key for `press` (e.g. 'Enter', 'Tab', 'a'), or substring to wait for in `wait`.",
		}),
	),
	textGone: Type.Optional(
		Type.String({
			description: "For `wait`: substring whose DISAPPEARANCE we wait for (opposite of `text`).",
		}),
	),
	values: Type.Optional(
		Type.Array(Type.String(), {
			description: "For `select`: one or more option values to select on a <select> element.",
		}),
	),
	fields: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "Field selector (CSS or label text in [data-testid] form)." }),
				value: Type.String({ description: "Value to type into the field." }),
			}),
			{
				description: "For `fill`: batch-fill an array of {name, value} pairs (replaces individual `selector`+`text` calls).",
			},
		),
	),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description: "For `upload`: absolute file paths to attach to the input[type=file] at `selector`.",
		}),
	),
	width: Type.Optional(
		Type.Integer({
			description: "For `resize`: viewport width in CSS pixels (must pair with `height`).",
			minimum: 100,
			maximum: 8192,
		}),
	),
	height: Type.Optional(
		Type.Integer({
			description: "For `resize`: viewport height in CSS pixels.",
			minimum: 100,
			maximum: 8192,
		}),
	),
	script: Type.Optional(
		Type.String({
			description: "Async JS body for the `evaluate` action. Wrapped in an async fn; return value is JSON-serialized.",
		}),
	),
	fullPage: Type.Optional(
		Type.Boolean({
			description: "For `screenshot`: capture entire scrollable page instead of viewport.",
		}),
	),
	outputPath: Type.Optional(
		Type.String({
			description:
				"For `screenshot`/`pdf`: absolute path to write to (must be under `~/.brigade/` or the current workspace). When omitted, Brigade auto-generates a path under `~/.brigade/captures/`.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			description: "Per-action timeout. Default 45 s; max 120 s.",
			minimum: 100,
			maximum: 120_000,
		}),
	),
	timeMs: Type.Optional(
		Type.Integer({
			description: "For `wait`: pure delay in ms (no other condition).",
			minimum: 0,
			maximum: 120_000,
		}),
	),
	loadState: Type.Optional(
		Type.Union(
			[
				Type.Literal("load"),
				Type.Literal("domcontentloaded"),
				Type.Literal("networkidle"),
			],
			{
				description: "For `wait`: wait for a specific page load lifecycle state.",
			},
		),
	),
	waitUntil: Type.Optional(
		Type.Union(
			[
				Type.Literal("commit"),
				Type.Literal("domcontentloaded"),
				Type.Literal("load"),
				Type.Literal("networkidle"),
			],
			{
				description:
					"For `navigate`: when to consider the nav done. `commit` = first byte (fastest, use for bot-protected pages like Justdial / Cloudflare-fronted that never fire load). `domcontentloaded` = HTML parsed (default). `load` = all resources fetched. `networkidle` = no requests for 500ms (slowest).",
			},
		),
	),
	endpoint: Type.Optional(
		Type.String({
			description:
				"For `attach`: CDP endpoint URL of an existing Chrome (e.g. `ws://127.0.0.1:9222`). Brigade attaches without owning the lifecycle.",
		}),
	),
	disposition: Type.Optional(
		Type.Union([Type.Literal("accept"), Type.Literal("dismiss")], {
			description:
				"For `dialog`: how to handle the NEXT dialog (alert/confirm/prompt). `accept` clicks OK + types `text` for prompts; `dismiss` clicks Cancel. Default behaviour (no `dialog` action called) is auto-dismiss.",
		}),
	),
	snapshotFormat: Type.Optional(
		Type.Union(
			[Type.Literal("markdown"), Type.Literal("interactive"), Type.Literal("text")],
			{
				description:
					"For `snapshot`: `markdown` (default) = readability + markdown; `interactive` = bullet list of interactive elements with `e<n>` refs the agent can target via :nth-of-type-style CSS selectors; `text` = page innerText only.",
			},
		),
	),
	maxChars: Type.Optional(
		Type.Integer({
			description: "For `snapshot`: cap on output length (default 60 000; head+tail truncated on overflow).",
			minimum: 500,
			maximum: 500_000,
		}),
	),
	compact: Type.Optional(
		Type.Boolean({
			description: "For `snapshot`: collapse runs of blank lines + strip empty list items.",
		}),
	),
});

export interface BrowserDetails {
	action: string;
	profile?: string;
	source?: "launched" | "attached";
	targetId?: string;
	url?: string;
	title?: string;
	status?: number;
	contentType?: string;
	text?: string;
	screenshotBase64?: string;
	pdfBase64?: string;
	/** Absolute path on disk where the screenshot/PDF was written. */
	path?: string;
	/** Bytes written to disk (matches the decoded blob size). */
	bytes?: number;
	tabs?: Array<{ targetId: string; url: string; title: string; profile?: string }>;
	profiles?: Array<{ name: string; dir?: string; source: "launched" | "attached"; tabCount: number }>;
	consoleEvents?: ConsoleEvent[];
	dialogEvents?: DialogEvent[];
	refs?: Array<{ ref: string; tag: string; role?: string; name?: string; selector: string }>;
	error?: string;
	externalContent: { untrusted: true; source: "web_fetch"; provider?: string; wrapped: boolean };
}

/* ─────────────────────────── public factory ─────────────────────────── */

export interface MakeBrowserToolOptions {
	headless?: boolean;
	defaultTimeoutMs?: number;
}

export function makeBrowserTool(opts: MakeBrowserToolOptions = {}): AnyBrigadeTool {
	// Default to a VISIBLE browser window so the operator can watch what
	// the agent is doing — heavy ops (challenge solving, slow loads) are
	// otherwise opaque. Override via `BRIGADE_BROWSER_HEADLESS=1` for the
	// gateway daemon case where there's no display attached.
	const envHeadless = process.env.BRIGADE_BROWSER_HEADLESS === "1";
	const headless = opts.headless ?? envHeadless;
	// 45 s default — Justdial / Cloudflare-fronted sites routinely take
	// 20-40 s to settle. 15 s was too tight; the model would fail a
	// navigation it could otherwise complete.
	const defaultTimeoutMs = opts.defaultTimeoutMs ?? 45_000;

	const tool: BrigadeTool<typeof BrowserSchema, BrowserDetails> = {
		name: "browser",
		label: "browser",
		description: [
			"Control the browser via Playwright + your system Chromium (status/start/stop/profiles/attach/tabs/open/focus/close/navigate/snapshot/screenshot/pdf/click/type/press/hover/drag/select/fill/resize/scrollIntoView/evaluate/wait/console/dialog/upload).",
			"Auto-detects Chrome / Chromium / Edge / Brave (a supported Chromium-based browser must be installed).",
			"Use only when existing logins/cookies matter, the page is JS-rendered, or you need UI automation / screenshots / PDF render.",
			"The browser keeps a persistent profile under `~/.brigade/browser/default/` — cookies and Cloudflare passes survive across turns.",
			"Screenshots + PDFs auto-save to `~/.brigade/captures/<timestamp>-<host>.<ext>` and the path is returned in details.path — point users at that path directly. Pass `outputPath` to override.",
			"When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (click/type/wait/etc).",
			"Use snapshot for UI automation. Avoid wait by default; use only in exceptional cases when no reliable UI state exists.",
			"For bot-protected pages pass `waitUntil: \"commit\"` so navigation doesn't hang.",
		].join(" "),
		parameters: BrowserSchema,
		ownerOnly: false,
		displaySummary: "driving the browser",
		async execute(
			_toolCallId: string,
			args: Static<typeof BrowserSchema>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<BrowserDetails>,
		): Promise<AgentToolResult<BrowserDetails>> {
			const timeoutMs = args.timeoutMs ?? defaultTimeoutMs;
			onUpdate?.({
				content: [{ type: "text", text: `browser: ${args.action}…` }],
				details: {} as BrowserDetails,
			});
			const profile = (args.profile ?? "").trim() || DEFAULT_PROFILE;

			// Lifecycle/introspection actions that don't need a live browser.
			if (args.action === "profiles") {
				return jsonResult(await buildProfilesSnapshot());
			}
			if (args.action === "stop") {
				return jsonResult(await stopProfile(profile));
			}

			try {
				// `attach` is a special bootstrap — it creates the
				// `attached:<endpoint>` profile and returns a status snapshot.
				let activeProfile = profile;
				if (args.action === "attach") {
					if (!args.endpoint?.trim()) throw new Error("browser attach: missing endpoint");
					const endpoint = args.endpoint.trim();
					const ok = await probeCdpEndpoint(endpoint, Math.min(timeoutMs, 5_000));
					if (!ok) {
						throw new Error(
							`browser attach: CDP endpoint not reachable at ${endpoint}. Verify Chrome was started with --remote-debugging-port and that the URL is correct (e.g. ws://127.0.0.1:9222).`,
						);
					}
					activeProfile = `attached:${endpoint}`;
				}
				const state = await ensureBrowser({
					headless,
					timeoutMs,
					profile: activeProfile,
				});
				const result = await runWithStaleRetry(state, () =>
					dispatchAction(state, args, timeoutMs, signal),
				);
				return jsonResult(result);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (/Cannot find module 'playwright|Cannot find package 'playwright/i.test(message)) {
					// playwright-core is a hard dep — if it can't load, the
					// build is broken. Surface a clear "this is a Brigade bug"
					// message rather than ask the operator to fix it.
					throw new Error(
						"browser: playwright-core couldn't load. This is a Brigade install issue — try `npm install` in your Brigade workspace.",
					);
				}
				throw err;
			}
		},
	};
	return tool;
}

/* ─────────────────────────── action dispatch ─────────────────────────── */

async function dispatchAction(
	state: BrowserState,
	args: Static<typeof BrowserSchema>,
	timeoutMs: number,
	_signal: AbortSignal | undefined,
): Promise<BrowserDetails> {
	const meta = buildExternalContentMeta({ source: "web_fetch", provider: "browser", wrapped: true });

	switch (args.action) {
		case "status": {
			return {
				action: "status",
				profile: state.profile,
				source: state.source,
				targetId: state.focusedTargetId ?? undefined,
				tabs: listTabs(state),
				externalContent: meta,
			};
		}

		case "start": {
			// `start` is a no-op shortcut — `ensureBrowser` already ran by
			// the time we got here. Useful as an explicit "wake the
			// profile" call.
			return {
				action: "start",
				profile: state.profile,
				source: state.source,
				tabs: listTabs(state),
				externalContent: meta,
			};
		}

		case "attach": {
			return {
				action: "attach",
				profile: state.profile,
				source: state.source,
				tabs: listTabs(state),
				externalContent: meta,
			};
		}

		case "tabs": {
			return {
				action: "tabs",
				profile: state.profile,
				tabs: listTabs(state),
				externalContent: meta,
			};
		}

		case "open": {
			const url = await guardUrl(args.url);
			const { handle, targetId } = await openNewTab(state, url, {
				waitUntil: args.waitUntil,
				timeout: timeoutMs,
			});
			return {
				action: "open",
				profile: state.profile,
				targetId,
				url: handle.page.url(),
				title: await handle.page.title().catch(() => ""),
				externalContent: meta,
			};
		}

		case "focus": {
			if (!args.targetId) throw new Error("browser focus: missing targetId");
			if (!state.tabs.has(args.targetId))
				throw new Error(`browser focus: unknown targetId "${args.targetId}"`);
			state.focusedTargetId = args.targetId;
			return {
				action: "focus",
				profile: state.profile,
				targetId: args.targetId,
				externalContent: meta,
			};
		}

		case "close": {
			if (args.targetId) {
				const handle = state.tabs.get(args.targetId);
				if (!handle) throw new Error(`browser close: unknown targetId "${args.targetId}"`);
				detachTabListeners(handle);
				try {
					await handle.page.close();
				} catch {
					/* already closed — fall through */
				}
				state.tabs.delete(args.targetId);
				if (state.focusedTargetId === args.targetId) state.focusedTargetId = null;
				return {
					action: "close",
					profile: state.profile,
					targetId: args.targetId,
					externalContent: meta,
				};
			}
			// No targetId — close all tabs + the browser itself for this profile.
			for (const handle of state.tabs.values()) detachTabListeners(handle);
			try {
				if (state.source === "launched") {
					await state.browser.close();
				} else {
					// Attached profile: close tabs WE opened, but leave the
					// underlying Chrome process running (we don't own it).
					for (const handle of state.tabs.values()) {
						try {
							await handle.page.close();
						} catch {
							/* ignore */
						}
					}
				}
			} catch {
				/* ignore */
			}
			PROFILE_STATE.delete(state.profile);
			return {
				action: "close",
				profile: state.profile,
				externalContent: meta,
			};
		}

		case "navigate": {
			const url = await guardUrl(args.url);
			const { handle, targetId } = await getActivePage(state, args.targetId);
			const waitUntil = args.waitUntil ?? "domcontentloaded";
			const resp = await handle.page.goto(url, { waitUntil, timeout: timeoutMs });
			return {
				action: "navigate",
				profile: state.profile,
				targetId,
				url: handle.page.url(),
				title: await handle.page.title().catch(() => ""),
				status: resp?.status() ?? undefined,
				contentType: resp?.headers()["content-type"],
				externalContent: meta,
			};
		}

		case "snapshot": {
			const { handle, targetId } = await getActivePage(state, args.targetId);
			const html = await handle.page.content();
			const format = args.snapshotFormat ?? "markdown";
			const maxChars = args.maxChars ?? 60_000;
			const compact = args.compact === true;
			let body: string;
			let refs: BrowserDetails["refs"];
			if (format === "interactive") {
				const result = await buildInteractiveSnapshot(handle.page);
				body = result.markdown;
				refs = result.refs;
			} else if (format === "text") {
				body = await handle.page
					.evaluate(
						`async () => (globalThis.document?.body?.innerText ?? "").toString()`,
					)
					.then((v) => (typeof v === "string" ? v : String(v ?? "")))
					.catch(() => "");
			} else {
				body = htmlToMarkdown(html);
			}
			if (compact) {
				body = body
					.split(/\r?\n/)
					.map((line) => line.replace(/\s+$/u, ""))
					.filter((line, idx, all) => !(line === "" && all[idx - 1] === ""))
					.join("\n");
			}
			const truncated = truncateHeadTail(body, maxChars);
			const safe = stripEnvelopeMarkers(stripInvisibleUnicode(truncated));
			const wrapped = wrapWebContent(safe, "web_fetch", { includeWarning: false });
			return {
				action: "snapshot",
				profile: state.profile,
				targetId,
				url: handle.page.url(),
				title: await handle.page.title().catch(() => ""),
				text: wrapped,
				refs,
				externalContent: meta,
			};
		}

		case "screenshot": {
			const { handle, targetId } = await getActivePage(state, args.targetId);
			const buf = await handle.page.screenshot({
				fullPage: args.fullPage === true,
				timeout: timeoutMs,
			});
			const saved = persistCapture({
				bytes: buf,
				kind: "png",
				url: handle.page.url(),
				outputPath: args.outputPath,
			});
			return {
				action: "screenshot",
				profile: state.profile,
				targetId,
				url: handle.page.url(),
				screenshotBase64: buf.toString("base64"),
				path: saved.path,
				bytes: saved.bytes,
				externalContent: meta,
			};
		}

		case "pdf": {
			const { handle, targetId } = await getActivePage(state, args.targetId);
			// Chromium-only API. Errors get bubbled up by Playwright with a
			// clear "PDF only supported in headless Chromium" message.
			// Playwright's pdf() accepts a `timeout` option; pass our budget
			// so a stalled render aborts on the same clock as everything else.
			const buf = await (
				handle.page as unknown as { pdf(opts?: { timeout?: number }): Promise<Buffer> }
			).pdf({ timeout: timeoutMs });
			const saved = persistCapture({
				bytes: buf,
				kind: "pdf",
				url: handle.page.url(),
				outputPath: args.outputPath,
			});
			return {
				action: "pdf",
				profile: state.profile,
				targetId,
				url: handle.page.url(),
				pdfBase64: buf.toString("base64"),
				path: saved.path,
				bytes: saved.bytes,
				externalContent: meta,
			};
		}

		case "click": {
			if (!args.selector) throw new Error("browser click: missing selector");
			const { handle, targetId } = await getActivePage(state, args.targetId);
			await handle.page.click(args.selector, { timeout: timeoutMs });
			return {
				action: "click",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "type": {
			if (!args.selector) throw new Error("browser type: missing selector");
			if (typeof args.text !== "string") throw new Error("browser type: missing text");
			const { handle, targetId } = await getActivePage(state, args.targetId);
			await handle.page.fill(args.selector, args.text, { timeout: timeoutMs });
			return {
				action: "type",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "press": {
			if (!args.text) throw new Error("browser press: missing text (key name)");
			const { handle, targetId } = await getActivePage(state, args.targetId);
			if (args.selector) {
				// Focus the target element first, then press — keeps the key
				// scoped to that element instead of whatever happens to have
				// focus globally.
				await handle.page.click(args.selector, { timeout: timeoutMs });
			}
			await handle.page.keyboard.press(args.text);
			return {
				action: "press",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "hover": {
			if (!args.selector) throw new Error("browser hover: missing selector");
			const { handle, targetId } = await getActivePage(state, args.targetId);
			await handle.page.locator(args.selector).hover({ timeout: timeoutMs });
			return {
				action: "hover",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "drag": {
			if (!args.selector || !args.targetSelector)
				throw new Error("browser drag: missing selector or targetSelector");
			const { handle, targetId } = await getActivePage(state, args.targetId);
			const source = handle.page.locator(args.selector);
			const dest = handle.page.locator(args.targetSelector);
			await source.dragTo(dest, { timeout: timeoutMs });
			return {
				action: "drag",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "select": {
			if (!args.selector) throw new Error("browser select: missing selector");
			if (!args.values || args.values.length === 0)
				throw new Error("browser select: missing values");
			const { handle, targetId } = await getActivePage(state, args.targetId);
			await handle.page
				.locator(args.selector)
				.selectOption(args.values, { timeout: timeoutMs });
			return {
				action: "select",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "fill": {
			const { handle, targetId } = await getActivePage(state, args.targetId);
			const fields = args.fields ?? [];
			if (fields.length === 0) {
				// Single-field fall-through: selector + text.
				if (!args.selector || typeof args.text !== "string")
					throw new Error("browser fill: missing selector/text or fields[]");
				await handle.page.fill(args.selector, args.text, { timeout: timeoutMs });
			} else {
				for (const field of fields) {
					await handle.page.fill(field.name, field.value, { timeout: timeoutMs });
				}
			}
			return {
				action: "fill",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "resize": {
			if (typeof args.width !== "number" || typeof args.height !== "number")
				throw new Error("browser resize: width + height required");
			const { handle, targetId } = await getActivePage(state, args.targetId);
			await handle.page.setViewportSize({ width: args.width, height: args.height });
			return {
				action: "resize",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "scrollIntoView": {
			if (!args.selector) throw new Error("browser scrollIntoView: missing selector");
			const { handle, targetId } = await getActivePage(state, args.targetId);
			await handle.page
				.locator(args.selector)
				.scrollIntoViewIfNeeded({ timeout: timeoutMs });
			return {
				action: "scrollIntoView",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "upload": {
			if (!args.selector) throw new Error("browser upload: missing selector");
			if (!args.files || args.files.length === 0)
				throw new Error("browser upload: missing files[]");
			const { handle, targetId } = await getActivePage(state, args.targetId);
			await handle.page.setInputFiles(args.selector, args.files);
			return {
				action: "upload",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "evaluate": {
			if (!args.script) throw new Error("browser evaluate: missing script");
			const { handle, targetId } = await getActivePage(state, args.targetId);
			// Wrap the script in an async fn so callers can use await.
			// Result is JSON-serialized; if it's a complex object it'll be
			// stringified, otherwise stringified primitive.
			const fnSource = `async () => { ${args.script} }`;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const value = await (handle.page as any).evaluate(fnSource);
			// `JSON.stringify(undefined)` returns `undefined` (NOT a string).
			// If the script didn't `return` anything, that undefined would
			// flow through `stripInvisibleUnicode` and trigger
			// `text is not iterable` because the iteration helper assumes
			// a string. Coerce to a stable string form here.
			const safe =
				typeof value === "string"
					? value
					: value === undefined
						? "undefined"
						: JSON.stringify(value) ?? "undefined";
			const wrapped = wrapWebContent(
				stripEnvelopeMarkers(stripInvisibleUnicode(safe)),
				"web_fetch",
				{ includeWarning: false },
			);
			return {
				action: "evaluate",
				profile: state.profile,
				targetId,
				text: wrapped,
				externalContent: meta,
			};
		}

		case "wait": {
			const { handle, targetId } = await getActivePage(state, args.targetId);
			const page = handle.page;
			if (typeof args.timeMs === "number") {
				await page.waitForTimeout(args.timeMs);
			} else if (args.selector) {
				await page.waitForSelector(args.selector, { timeout: timeoutMs });
			} else if (typeof args.textGone === "string" && args.textGone.length > 0) {
				await page.waitForFunction(
					(needle: string) =>
						!(
							globalThis as unknown as { document: { body: { innerText: string } } }
						).document.body.innerText.includes(needle),
					args.textGone,
					{ timeout: timeoutMs },
				);
			} else if (typeof args.text === "string" && args.text.length > 0) {
				await page.waitForFunction(
					(needle: string) =>
						(globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText.includes(
							needle,
						),
					args.text,
					{ timeout: timeoutMs },
				);
			} else if (args.url) {
				await page.waitForURL(args.url, { timeout: timeoutMs });
			} else if (args.loadState) {
				await page.waitForLoadState(args.loadState, { timeout: timeoutMs });
			} else {
				await page.waitForLoadState("networkidle", { timeout: timeoutMs });
			}
			return {
				action: "wait",
				profile: state.profile,
				targetId,
				externalContent: meta,
			};
		}

		case "console": {
			const { handle, targetId } = await getActivePage(state, args.targetId);
			const events = handle.consoleLog.slice();
			// Caller-controlled drain: `text === "clear"` resets the buffer
			// so subsequent reads see fresh events only. Default behaviour
			// (no text) leaves the buffer untouched.
			if (args.text === "clear") handle.consoleLog.length = 0;
			return {
				action: "console",
				profile: state.profile,
				targetId,
				url: handle.page.url(),
				consoleEvents: events,
				externalContent: meta,
			};
		}

		case "dialog": {
			const { handle, targetId } = await getActivePage(state, args.targetId);
			const disposition = args.disposition ?? "dismiss";
			handle.pendingDialog = {
				disposition,
				promptText: args.text,
			};
			const events = handle.dialogLog.slice();
			if (args.text === "clear") handle.dialogLog.length = 0;
			return {
				action: "dialog",
				profile: state.profile,
				targetId,
				url: handle.page.url(),
				dialogEvents: events,
				externalContent: meta,
			};
		}

		case "profiles":
		case "stop": {
			// Handled at the execute() level — should never reach dispatch.
			throw new Error(
				`browser: action "${args.action}" was not dispatched at the lifecycle layer (this is a Brigade bug).`,
			);
		}
	}
}

/**
 * Wrap a dispatch call so the FIRST stale-target failure (page closed,
 * context torn down) is silently retried with the focused tab dropped.
 * Single retry only — repeated failures bubble up so the agent can react.
 */
async function runWithStaleRetry(
	state: BrowserState,
	fn: () => Promise<BrowserDetails>,
): Promise<BrowserDetails> {
	try {
		return await fn();
	} catch (err) {
		if (!isStaleError(err)) throw err;
		// Drop closed tabs + clear focus, then retry once. If even the
		// browser is dead, the second call will rebuild via ensureBrowser.
		for (const [id, handle] of [...state.tabs.entries()]) {
			if (handle.page.isClosed?.()) state.tabs.delete(id);
		}
		state.focusedTargetId = null;
		log.debug("browser: stale target detected; retrying once", {
			profile: state.profile,
			err: err instanceof Error ? err.message : String(err),
		});
		return await fn();
	}
}

/* ─────────────────────────── profile lifecycle helpers ─────────────────────────── */

async function buildProfilesSnapshot(): Promise<BrowserDetails> {
	const meta = buildExternalContentMeta({ source: "web_fetch", provider: "browser", wrapped: true });
	const profiles: NonNullable<BrowserDetails["profiles"]> = [];
	for (const [name, statePromise] of PROFILE_STATE.entries()) {
		const attached = isAttachedProfile(name);
		let tabCount = 0;
		let source: "launched" | "attached" = attached ? "attached" : "launched";
		try {
			const state = await statePromise;
			tabCount = state.tabs.size;
			source = state.source;
		} catch {
			// Profile launch failed — surface the row with 0 tabs so the
			// agent can see it tried + failed.
		}
		profiles.push({
			name,
			dir: attached ? undefined : profileUserDataDir(name),
			source,
			tabCount,
		});
	}
	// Always include the default profile in the catalogue so the agent
	// knows it can pick it without configuring anything.
	if (!profiles.some((p) => p.name === DEFAULT_PROFILE)) {
		profiles.unshift({
			name: DEFAULT_PROFILE,
			dir: profileUserDataDir(DEFAULT_PROFILE),
			source: "launched",
			tabCount: 0,
		});
	}
	return {
		action: "profiles",
		profiles,
		externalContent: meta,
	};
}

async function stopProfile(profile: string): Promise<BrowserDetails> {
	const meta = buildExternalContentMeta({ source: "web_fetch", provider: "browser", wrapped: true });
	const cached = PROFILE_STATE.get(profile);
	if (!cached) {
		return { action: "stop", profile, externalContent: meta };
	}
	try {
		const state = await cached;
		for (const handle of state.tabs.values()) detachTabListeners(handle);
		if (state.source === "launched") {
			await state.browser.close().catch(() => {});
		} else {
			for (const handle of state.tabs.values()) {
				try {
					await handle.page.close();
				} catch {
					/* ignore */
				}
			}
		}
	} catch {
		/* profile failed to launch — nothing to close */
	}
	PROFILE_STATE.delete(profile);
	return { action: "stop", profile, externalContent: meta };
}

/* ─────────────────────────── snapshot helpers ─────────────────────────── */

/**
 * Build an "interactive" snapshot — a bullet list of clickable + form
 * elements with stable `e<n>` refs. Refs are minted in document order so
 * the agent can target `e3` etc. across follow-up calls via the
 * `[data-brigade-ref="e3"]` attribute we briefly stamp into the DOM.
 *
 * Not a full role-tree dump (that's substantially heavier); the goal is
 * "show the agent what it can click/fill" for UI automation.
 */
async function buildInteractiveSnapshot(page: Page): Promise<{
	markdown: string;
	refs: NonNullable<BrowserDetails["refs"]>;
}> {
	// Use a single in-page evaluate so we batch DOM walks instead of
	// shipping element-by-element back and forth.
	const SCRIPT = `async () => {
		const doc = globalThis.document;
		if (!doc?.body) return { items: [] };
		// Clear any prior refs we stamped in a previous snapshot.
		for (const el of doc.querySelectorAll('[data-brigade-ref]')) {
			el.removeAttribute('data-brigade-ref');
		}
		const interactiveSelector = [
			'a[href]', 'button', 'input', 'select', 'textarea', '[role="button"]',
			'[role="link"]', '[role="textbox"]', '[role="checkbox"]', '[role="combobox"]',
			'[role="menuitem"]', '[role="option"]', '[role="tab"]', '[contenteditable="true"]',
		].join(',');
		const items = [];
		let n = 1;
		for (const el of doc.querySelectorAll(interactiveSelector)) {
			if (!el || !(el instanceof HTMLElement)) continue;
			const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
			if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
			const rect = el.getBoundingClientRect();
			if (rect.width <= 0 && rect.height <= 0) continue;
			const ref = 'e' + n;
			el.setAttribute('data-brigade-ref', ref);
			const tag = el.tagName.toLowerCase();
			const role = el.getAttribute('role') || undefined;
			const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('value') || '').trim().slice(0, 120);
			const type = el.getAttribute('type') || undefined;
			items.push({ ref, tag, role, type, name });
			n += 1;
			if (n > 500) break;
		}
		return { items };
	}`;
	type PayloadItem = { ref: string; tag: string; role?: string; type?: string; name?: string };
	let payload: { items: PayloadItem[] } | undefined;
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		payload = (await (page as any).evaluate(SCRIPT)) as typeof payload;
	} catch {
		payload = { items: [] };
	}
	// Defensive: evaluate can return `undefined` on hostile pages with
	// broken CSP / closed contexts, even though our SCRIPT always returns
	// an object. Coerce to `[]` so the downstream `.map` never crashes.
	const items: PayloadItem[] = Array.isArray(payload?.items) ? payload.items : [];
	const refs: NonNullable<BrowserDetails["refs"]> = items.map((item) => ({
		ref: item.ref,
		tag: item.tag,
		role: item.role,
		name: item.name,
		selector: `[data-brigade-ref="${item.ref}"]`,
	}));
	const lines = items.map((item) => {
		const role = item.role ? ` role=${item.role}` : "";
		const type = item.type ? ` type=${item.type}` : "";
		const name = item.name ? ` — ${item.name}` : "";
		return `- \`${item.ref}\` <${item.tag}${role}${type}>${name}`;
	});
	const markdown =
		lines.length === 0
			? "(no interactive elements detected)"
			: `Interactive elements (${lines.length}):\n\n${lines.join("\n")}\n\nUse the \`selector\` field (\`[data-brigade-ref=\"eN\"]\`) for follow-up click/type/etc.`;
	return { markdown, refs };
}

/**
 * Persist a captured PDF/screenshot to disk and return the absolute path.
 *
 * Auto-generated path: `~/.brigade/captures/<iso-timestamp>-<safe-host>.<ext>`.
 * The timestamp + URL host combo means two captures of the same page never
 * clobber each other and the operator can `ls` the dir to find the latest.
 *
 * Operator-supplied path: validated to live under `~/.brigade/` OR under the
 * current working directory. Refuses absolute paths anywhere else so a
 * compromised agent can't drop a PDF into `/etc/cron.d/` or `~/Downloads/`.
 *
 * Always written 0o600 (owner-only) — captures of authed pages contain
 * cookies/session data the operator probably doesn't want world-readable.
 */
function persistCapture(args: {
	bytes: Buffer;
	kind: "pdf" | "png";
	url: string;
	outputPath?: string;
}): { path: string; bytes: number } {
	// Convex mode: captures land in the OS cache dir, never under ~/.brigade.
	// They're working artifacts the agent forwards (send_media reads the
	// path) — regenerable, machine-local.
	const captureDir =
		tryGetRuntimeContext()?.mode === "convex"
			? join(resolveOsCacheDir(), "captures")
			: join(BRIGADE_DIR, "captures");
	try {
		mkdirSync(captureDir, { recursive: true });
	} catch {
		/* best-effort — writeFileSync below will surface the real error */
	}
	let target: string;
	if (args.outputPath) {
		const resolved = pathResolve(args.outputPath);
		const brigadeRoot = pathResolve(BRIGADE_DIR);
		const cwdRoot = pathResolve(process.cwd());
		const underBrigade =
			resolved === brigadeRoot ||
			resolved.startsWith(brigadeRoot + sep) ||
			resolved.startsWith(brigadeRoot + "/");
		const underCwd =
			resolved === cwdRoot ||
			resolved.startsWith(cwdRoot + sep) ||
			resolved.startsWith(cwdRoot + "/");
		if (!underBrigade && !underCwd) {
			throw new Error(
				`browser: refused to write capture outside trusted dirs. outputPath="${args.outputPath}" resolves to "${resolved}" which is neither under "${BRIGADE_DIR}" nor under "${process.cwd()}".`,
			);
		}
		target = resolved;
	} else {
		const stamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.replace(/Z$/, "");
		let host = "page";
		try {
			host = new URL(args.url).hostname.replace(/[^a-z0-9.-]/gi, "_") || "page";
		} catch {
			/* invalid URL — fall through with default "page" */
		}
		target = join(captureDir, `${stamp}-${host}.${args.kind}`);
	}
	try {
		mkdirSync(dirname(target), { recursive: true });
	} catch {
		/* best-effort */
	}
	writeFileSync(target, args.bytes, { mode: 0o600 });
	return { path: target, bytes: args.bytes.length };
}

function truncateHeadTail(body: string, maxChars: number): string {
	if (body.length <= maxChars) return body;
	const headBudget = Math.floor(maxChars * 0.7);
	const tailBudget = Math.max(0, maxChars - headBudget - 64);
	const head = body.slice(0, headBudget);
	const tail = tailBudget > 0 ? body.slice(-tailBudget) : "";
	return `${head}\n\n…[${body.length - headBudget - tailBudget} chars truncated]…\n\n${tail}`;
}

/* ─────────────────────────── helpers ─────────────────────────── */

async function guardUrl(raw: string | undefined): Promise<string> {
	const url = (raw ?? "").trim();
	if (!url) throw new Error("browser: missing url");
	const reason = await classifyUrlForSsrf(url);
	if (reason) throw new SsrfBlockedError(url, reason);
	return url;
}

function listTabs(
	state: BrowserState,
): Array<{ targetId: string; url: string; title: string; profile?: string }> {
	const out: Array<{ targetId: string; url: string; title: string; profile?: string }> = [];
	for (const [targetId, handle] of state.tabs.entries()) {
		let url = "";
		try {
			url = handle.page.url();
		} catch {
			/* page already torn down */
		}
		out.push({ targetId, url, title: "", profile: handle.profile });
	}
	return out;
}

function jsonResult(payload: BrowserDetails): AgentToolResult<BrowserDetails> {
	// Strip large base64 blobs from the `content` text sent to the model —
	// the model sees the saved-to-disk path (concrete and actionable); the
	// full base64 bytes ride in `details` for the runtime/UI to consume
	// (preview render, save-as, share, etc.).
	const summarize = (base64: string, kind: "PNG" | "PDF", path?: string): string => {
		const bytes = Math.round((base64.length * 3) / 4);
		return path
			? `Saved ${bytes}-byte ${kind} to ${path}`
			: `<${bytes} bytes ${kind}, in details>`;
	};
	const forModel: BrowserDetails = {
		...payload,
		screenshotBase64: payload.screenshotBase64
			? summarize(payload.screenshotBase64, "PNG", payload.path)
			: undefined,
		pdfBase64: payload.pdfBase64
			? summarize(payload.pdfBase64, "PDF", payload.path)
			: undefined,
	};
	return {
		content: [{ type: "text", text: JSON.stringify(forModel, null, 2) }],
		details: payload,
	};
}

export { BrowserSchema };
