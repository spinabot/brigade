/**
 * END-TO-END attachment test, driving the REAL TUI.
 *
 * Every previous bug in this feature survived a green unit suite, because the
 * units were fine and the WIRING was not. Three in a row:
 *
 *   • the `/attach` handlers sat below the mid-turn steer gate, so they were
 *     unreachable while the agent worked;
 *   • a dropped path was only turned into an attachment at SUBMIT time, so the
 *     operator watched a raw `C:\...\plant-cell.png` sit in the input box with
 *     nothing staged;
 *   • the drop hook tested `!data.startsWith("\x1b")` to avoid firing on arrow
 *     keys — but pi-tui wraps EVERY paste in bracketed-paste markers ("pasted
 *     data will always contain \x1b[200~" — pi-tui/keys.js), so the hook never
 *     fired on a single paste that has ever existed.
 *
 * Unit tests could not have caught any of them. So this test drives the real
 * `TUI`, the real `BrigadeEditor`, and the real `wireConnectUi` against a fake
 * Terminal and a fake gateway — feeding in the EXACT bytes a terminal emits when
 * you drop a file on it, and asserting on what the operator sees and on what
 * actually goes out over the wire.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { TUI, type Terminal } from "@earendil-works/pi-tui";

import { wireConnectUi } from "./connect.js";
import type { BrigadeClient } from "../../tui/client.js";
import type { SessionStateSnapshot } from "../../protocol.js";

/** A Terminal that renders nowhere and lets the test push input in. */
class FakeTerminal implements Terminal {
	onInput: (data: string) => void = () => {};
	output = "";
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.output += data;
	}
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

/** Records every RPC so the test can assert what actually left the client. */
interface SentRequest {
	method: string;
	params: Record<string, unknown> | undefined;
}

function makeFakeClient(sent: SentRequest[], snapshot: SessionStateSnapshot): BrigadeClient {
	const client = {
		on: () => {},
		connect: async () => {},
		resume: async () => {},
		close: () => {},
		request: async (method: string, params?: Record<string, unknown>) => {
			sent.push({ method, params });
			if (method === "get-state") return snapshot;
			if (method === "list-models") return [];
			if (method === "sessions.list" || method === "list-sessions") return [];
			if (method === "list-agents") return [];
			return undefined;
		},
	};
	return client as unknown as BrigadeClient;
}

const SNAPSHOT: SessionStateSnapshot = {
	provider: "anthropic",
	modelId: "claude-opus-4-8",
	modelName: "Claude Opus 4.8",
	thinkingLevel: "off",
	supportsThinking: true,
	supportsVision: true,
	availableThinkingLevels: ["off"],
	contextUsagePercent: null,
	totalTokensIn: 0,
	totalTokensOut: 0,
	totalCostUsd: 0,
} as SessionStateSnapshot;

let dir: string;
let png: string;

before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-e2e-att-"));
	png = path.join(dir, "plant-cell.png");
	// A tiny but real PNG header — enough that it stats as a non-empty file.
	fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
});

after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Boot the real UI against fakes, and hand back the levers a terminal would pull. */
async function bootUi() {
	const term = new FakeTerminal();
	const tui = new TUI(term);
	const sent: SentRequest[] = [];
	const client = makeFakeClient(sent, SNAPSHOT);
	const handle = await wireConnectUi(tui, client, "main", "agent:main:main");
	// The REAL BrigadeEditor instance — `wireConnectUi` calls `tui.setFocus(editor)`,
	// so this is the same object a keystroke would be routed to. Reaching through the
	// private field is deliberate: the point of this test is to exercise the actual
	// component the operator types into, not a stand-in.
	const editor = (tui as unknown as { focusedComponent: unknown }).focusedComponent as {
		handleInput(d: string): void;
		getText(): string;
		setText(t: string): void;
		onSubmit?: (v: string) => Promise<void> | void;
	};
	assert.ok(editor?.handleInput, "the editor must be focused after wiring");
	return { tui, term, sent, handle, editor };
}

/** EXACTLY what a terminal sends when a file is dropped onto it: a bracketed paste. */
const bracketedPaste = (text: string): string => `\x1b[200~${text}\x1b[201~`;

describe("TUI attachments — end to end, real editor + real wiring", () => {
	it("a DROPPED file becomes a staged pill immediately, before anything is submitted", async () => {
		const { editor } = await bootUi();

		// Drop the file. This is the byte sequence, markers and all.
		editor.handleInput(bracketedPaste(png));

		// The operator must SEE it — the raw path is gone, replaced by a pill.
		assert.equal(
			editor.getText(),
			"[plant-cell.png]",
			"the dropped path must be swapped for an attachment pill ON DROP",
		);
	});

	it("sends the file as a real ATTACHMENT on the wire, not as a path in the text", async () => {
		const { editor, sent } = await bootUi();

		editor.handleInput(bracketedPaste(png));
		// Type a question after the pill, exactly as an operator would.
		for (const ch of " what is this?") editor.handleInput(ch);

		await editor.onSubmit?.(editor.getText());

		const prompt = sent.find((s) => s.method === "prompt");
		assert.ok(prompt, "a prompt RPC must have been sent");

		const atts = prompt.params?.attachments as Array<Record<string, unknown>> | undefined;
		assert.ok(atts && atts.length === 1, "the file must ride as an attachment");
		assert.equal(atts[0]?.path, png);
		assert.equal(atts[0]?.kind, "image", "a .png must be classified as an inline-able image");

		// And the PILL must be stripped from the text — the model gets real bytes, so a
		// bare filename left in the prose would be a dangling reference.
		assert.equal(prompt.params?.text, "what is this?");
	});

	it("a wordless drop is a valid turn — attachment carries it, text is empty", async () => {
		const { editor, sent } = await bootUi();
		editor.handleInput(bracketedPaste(png));
		await editor.onSubmit?.(editor.getText());

		const prompt = sent.find((s) => s.method === "prompt");
		assert.ok(prompt);
		assert.equal(prompt.params?.text, "");
		assert.equal((prompt.params?.attachments as unknown[])?.length, 1);
	});

	it("a pasted NON-path stays ordinary text — no attachment, no rewrite", async () => {
		const { editor, sent } = await bootUi();
		editor.handleInput(bracketedPaste("just some pasted prose"));
		assert.equal(editor.getText(), "just some pasted prose");

		await editor.onSubmit?.(editor.getText());
		const prompt = sent.find((s) => s.method === "prompt");
		assert.equal(prompt?.params?.text, "just some pasted prose");
		assert.equal(prompt?.params?.attachments, undefined, "no attachments key on a plain turn");
	});

	it("a pasted CODE BLOCK keeps its indentation — the parser must not touch prose", async () => {
		const { editor, sent } = await bootUi();
		const code = "def f(x):\n    if x:\n        return 1";
		editor.handleInput(bracketedPaste(code));
		await editor.onSubmit?.(editor.getText());

		const prompt = sent.find((s) => s.method === "prompt");
		assert.equal(prompt?.params?.text, code, "indentation must survive byte-for-byte");
	});

	it("typing a path by hand (not pasting) also attaches it on submit", async () => {
		const { editor, sent } = await bootUi();
		for (const ch of png) editor.handleInput(ch);
		await editor.onSubmit?.(editor.getText());

		const prompt = sent.find((s) => s.method === "prompt");
		assert.equal((prompt?.params?.attachments as unknown[])?.length, 1);
	});
});

/**
 * TERMINALS DISAGREE about how a dropped file reaches the application, and every
 * bug in this feature so far came from assuming one particular shape:
 *
 *   • Windows Terminal and VS Code do not implement drops identically.
 *   • pi-tui wraps pastes in bracketed-paste markers — but only pastes it sees as
 *     pastes.
 *   • stdin coalescing decides whether 45 characters arrive as one chunk or five.
 *
 * So detection no longer looks at the input's SHAPE at all — it re-reads the line
 * on any change. These cases exist to hold that line: every delivery shape below
 * must produce an identical, staged, pilled result.
 */
describe("TUI attachments — a drop must work however the terminal delivers it", () => {
	const expectPilled = (editor: { getText(): string }) =>
		assert.equal(editor.getText(), "[plant-cell.png]");

	it("bracketed paste (what pi-tui documents)", async () => {
		const { editor } = await bootUi();
		editor.handleInput(`\x1b[200~${png}\x1b[201~`);
		expectPilled(editor);
	});

	it("RAW paste, no bracketed markers at all", async () => {
		const { editor } = await bootUi();
		editor.handleInput(png);
		expectPilled(editor);
	});

	it("split across several stdin chunks", async () => {
		const { editor } = await bootUi();
		const third = Math.ceil(png.length / 3);
		editor.handleInput(png.slice(0, third));
		editor.handleInput(png.slice(third, third * 2));
		editor.handleInput(png.slice(third * 2));
		expectPilled(editor);
	});

	it("one character at a time — the worst case, and it still pills", async () => {
		const { editor } = await bootUi();
		for (const ch of png) editor.handleInput(ch);
		expectPilled(editor);
	});

	it("a quoted drop (path with spaces) — what a terminal sends for `my report.pdf`", async () => {
		const { editor } = await bootUi();
		const spaced = path.join(dir, "my report.pdf");
		fs.writeFileSync(spaced, "%PDF-1.4 x");
		editor.handleInput(`\x1b[200~"${spaced}"\x1b[201~`);
		assert.equal(editor.getText(), "[my report.pdf]");
	});

	it("typing ordinary prose containing a slash never stages anything", async () => {
		const { editor } = await bootUi();
		for (const ch of "use the and/or operator") editor.handleInput(ch);
		assert.equal(editor.getText(), "use the and/or operator");
	});

	it("typing a slash command is left alone", async () => {
		const { editor } = await bootUi();
		for (const ch of "/model") editor.handleInput(ch);
		assert.equal(editor.getText(), "/model");
	});
});

/**
 * Ctrl+V for an image — the Claude-CLI model. The terminal handles the Ctrl+V key
 * itself but still emits a PASTE EVENT (bracketed paste). The editor reacts to
 * that event, reads the clipboard, and attaches any image found. This test proves
 * the wiring fires; the actual clipboard read is exercised live in dev.
 */
describe("TUI attachments — Ctrl+V fires the paste hook", () => {
	it("a bracketed paste triggers onPaste (the clipboard-image check)", async () => {
		const { editor } = await bootUi();
		let fired = 0;
		(editor as unknown as { onPaste?: () => void }).onPaste = () => {
			fired++;
		};
		// EXACTLY what a terminal sends on Ctrl+V: bracketed-paste markers.
		editor.handleInput("\x1b[200~\x1b[201~");
		assert.equal(fired, 1, "a bracketed paste must fire the paste hook");
	});

	it("the pasted TEXT still lands in the editor (paste is not swallowed)", async () => {
		const { editor } = await bootUi();
		editor.handleInput("\x1b[200~hello world\x1b[201~");
		assert.match(editor.getText(), /hello world/);
	});

	it("ordinary typing does NOT fire the paste hook", async () => {
		const { editor } = await bootUi();
		let fired = 0;
		(editor as unknown as { onPaste?: () => void }).onPaste = () => {
			fired++;
		};
		for (const ch of "just typing") editor.handleInput(ch);
		assert.equal(fired, 0);
	});
});
