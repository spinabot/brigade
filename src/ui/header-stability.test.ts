/**
 * The identity line must not change while a turn streams.
 *
 * pi-tui's differential renderer bails to `fullRender(true)` when the first
 * changed line is above the previous viewport (tui.js:1169), and that path
 * emits `\x1b[2J\x1b[H\x1b[3J` — the `3J` CLEARS THE TERMINAL'S SCROLLBACK.
 * The connect header sits in that top block (added before the divider, above
 * the transcript), so anything volatile in it destroys the operator's scroll
 * history every time it ticks.
 *
 * These pin the split: identity in the header, everything that ticks in the
 * footer (which is pinned near the bottom and renders differentially).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS DRIVES THE REAL UI
 * ─────────────────────────────────────────────────────────────────────────
 * The previous version of this file re-declared a `headerFor()` helper and
 * asserted that it equalled itself. It imported nothing from `src/`, so
 * appending an elapsed ticker to the real `updateHeader` in `connect.ts` left
 * every assertion green. A test for "this string does not change" is worthless
 * unless the string is the one production actually paints.
 *
 * So this boots the REAL `wireConnectUi` against a fake Terminal and a fake
 * gateway, feeds it the state snapshots and lifecycle events the gateway
 * really sends, and reads the header component out of the live widget tree.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { TUI, type Component, type Terminal } from "@earendil-works/pi-tui";

import { wireConnectUi } from "../cli/commands/connect.js";
import type { BrigadeClient } from "../tui/client.js";
import type { SessionStateSnapshot } from "../protocol.js";

/** A Terminal that renders nowhere. */
class FakeTerminal implements Terminal {
	onInput: (data: string) => void = () => {};
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number {
		return 120;
	}
	get rows(): number {
		return 40;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

const AGENT = "main";
const SESSION = "agent:main:main";

/** The identity-only baseline. Everything volatile is at rest here. */
const BASE = {
	provider: "claude-cli",
	modelId: "opus-4-8",
	modelName: "Opus 4.8",
	thinkingLevel: "off",
	supportsThinking: true,
	supportsVision: true,
	availableThinkingLevels: ["off"],
	contextUsagePercent: null,
	contextTokens: null,
	contextWindow: null,
	totalTokensIn: 0,
	totalTokensOut: 0,
	totalCostUsd: 0,
	isAgentRunning: false,
	messageCount: 0,
	agentId: AGENT,
	agentName: "Brigade",
	sessionKey: SESSION,
} as unknown as SessionStateSnapshot;

function snapshot(patch: Partial<SessionStateSnapshot>): SessionStateSnapshot {
	return { ...BASE, ...patch } as SessionStateSnapshot;
}

type Handler = (...args: never[]) => void;

interface Booted {
	tui: TUI;
	emit(event: string, payload: unknown): void;
	state(snap: SessionStateSnapshot): void;
}

async function boot(): Promise<Booted> {
	const tui = new TUI(new FakeTerminal());
	const handlers = new Map<string, Handler[]>();
	const client = {
		on(event: string, fn: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
			return client;
		},
		connect: async () => {},
		resume: async () => {},
		close: () => {},
		request: async (method: string) => {
			if (method === "get-state") return BASE;
			if (method === "list-models") return [];
			if (method === "sessions.list" || method === "list-sessions") return [];
			if (method === "list-agents") return [];
			return undefined;
		},
	};
	await wireConnectUi(tui, client as unknown as BrigadeClient, AGENT, SESSION);
	const emit = (event: string, payload: unknown): void => {
		for (const fn of handlers.get(event) ?? []) (fn as (p: unknown) => void)(payload);
	};
	return { tui, emit, state: (snap) => emit("state", snap) };
}

function renderOf(c: Component): string {
	return (c as unknown as { render(width: number): string[] }).render(120).join("\n");
}

function children(tui: TUI): Component[] {
	return (tui as unknown as { children: Component[] }).children;
}

/**
 * The header component: the child immediately above the 80-dash divider, which
 * is exactly how `wireConnectUi` builds it (`addChild(header)` then
 * `addChild(divider)`). Located structurally rather than by index because
 * `renderBrandHeader` prepends a variable number of children.
 */
function headerLine(tui: TUI): string {
	const kids = children(tui);
	const dividerIdx = kids.findIndex((k) => renderOf(k).includes("─".repeat(80)));
	assert.ok(dividerIdx > 0, "the connect divider must exist, with the header above it");
	return renderOf(kids[dividerIdx - 1]!);
}

/** The live footer: the one line carrying the running/idle dot. */
function footerLine(tui: TUI): string {
	const kids = children(tui);
	const dividerIdx = kids.findIndex((k) => renderOf(k).includes("─".repeat(80)));
	for (let i = kids.length - 1; i > dividerIdx; i -= 1) {
		const text = renderOf(kids[i]!);
		if (text.includes("●") || text.includes("○")) return text;
	}
	assert.fail("the connect footer (the line carrying the ●/○ dot) must exist");
}

/** Stop any spinner interval the UI armed, so the test process can exit. */
function stopTimers(tui: TUI): void {
	for (const child of children(tui)) {
		(child as unknown as { stop?: () => void }).stop?.();
	}
}

let ui: Booted;

before(async () => {
	ui = await boot();
	ui.state(BASE);
});

after(() => {
	stopTimers(ui.tui);
});

describe("header stability (the identity line above the transcript)", () => {
	it("paints the identity it is supposed to carry", () => {
		// Guard against every assertion below being vacuously true: if the widget
		// we located were blank or static chrome, "it did not change" would prove
		// nothing at all.
		const header = headerLine(ui.tui);
		assert.match(header, /🦁/, "the mascot rides ahead of the persona");
		assert.match(header, /Brigade/, "the persona name is identity");
		assert.match(header, /claude-cli/, "the provider is identity");
		assert.match(header, /opus-4-8/, "the model is identity");
	});

	it("does not change as tokens, cost, context and reasoning accumulate", () => {
		// These update per TOKEN (the usage ledger made them live), so any of them
		// in the identity line would mean a full redraw — and a scrollback wipe —
		// per token.
		const before = headerLine(ui.tui);
		const footerBefore = footerLine(ui.tui);
		ui.state(
			snapshot({
				totalTokensIn: 4700,
				totalTokensOut: 120,
				totalCostUsd: 0.0231,
				billing: "metered",
				costComplete: true,
				contextTokens: 34_000,
				contextWindow: 200_000,
				contextUsagePercent: 17,
				reasoning: { active: true, visibility: "summary", startedAt: Date.now() - 12_000 },
			}),
		);
		assert.equal(headerLine(ui.tui), before, "the identity line must be byte-identical");
		// …and prove the churn actually reached the UI, rather than the snapshot
		// having been silently dropped on the way in.
		assert.notEqual(footerLine(ui.tui), footerBefore, "the footer is where live figures belong");
	});

	it("does not change as the reasoning phase closes", () => {
		const before = headerLine(ui.tui);
		ui.state(
			snapshot({
				totalTokensIn: 4700,
				totalTokensOut: 900,
				reasoning: { active: false, visibility: "summary", durationMs: 12_400 },
			}),
		);
		assert.equal(headerLine(ui.tui), before);
	});

	it("does not change when a turn starts, ticks, or ends", async () => {
		const before = headerLine(ui.tui);
		const footerAtRest = footerLine(ui.tui);
		ui.emit("pi", { event: { type: "agent_start" }, subagentDepth: 0, agentId: AGENT, sessionId: SESSION });
		assert.equal(headerLine(ui.tui), before, "the running dot and spinner phrase live in the footer");
		assert.notEqual(footerLine(ui.tui), footerAtRest, "the turn did start");
		assert.match(footerLine(ui.tui), /●/, "the footer carries the running dot");

		// The elapsed ticker repaints once a second for the whole turn — the main
		// offender, measured at ~39 scrollback wipes across a 40-second turn. Wait
		// for a real tick (the footer's elapsed figure moving is the proof it
		// fired) and require the identity line to have sat still through it.
		const footerRunning = footerLine(ui.tui);
		const deadline = Date.now() + 4000;
		while (footerLine(ui.tui) === footerRunning && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.notEqual(footerLine(ui.tui), footerRunning, "the elapsed ticker must have ticked");
		assert.equal(headerLine(ui.tui), before, "one second of elapsed time must not touch the header");

		ui.emit("pi", { event: { type: "agent_end" }, subagentDepth: 0, agentId: AGENT, sessionId: SESSION });
		assert.equal(headerLine(ui.tui), before);
		stopTimers(ui.tui);
	});

	it("carries no running dot — that is a per-turn flip", () => {
		const header = headerLine(ui.tui);
		assert.equal(header.includes("●"), false);
		assert.equal(header.includes("○"), false);
	});

	it("DOES change when the operator switches model", () => {
		// A real identity change must still repaint — this is the one time a full
		// redraw is worth its cost.
		const before = headerLine(ui.tui);
		ui.state(snapshot({ modelId: "sonnet-5", modelName: "Sonnet 5" }));
		assert.notEqual(headerLine(ui.tui), before);
		assert.match(headerLine(ui.tui), /sonnet-5/);
	});

	it("DOES change when the operator switches session or persona", () => {
		const before = headerLine(ui.tui);
		ui.state(snapshot({ modelId: "sonnet-5", modelName: "Sonnet 5", agentName: "Ops" }));
		assert.notEqual(headerLine(ui.tui), before, "a persona switch repaints");
		assert.match(headerLine(ui.tui), /Ops/);

		const afterPersona = headerLine(ui.tui);
		ui.state(
			snapshot({ modelId: "sonnet-5", modelName: "Sonnet 5", agentName: "Ops", sessionKey: `${SESSION}:sub` }),
		);
		assert.notEqual(headerLine(ui.tui), afterPersona, "a session switch repaints");
	});
});
