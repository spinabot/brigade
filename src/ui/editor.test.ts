/**
 * Key routing for `BrigadeEditor`: which keypresses reach `onInterrupt` and which
 * must not. What the host then does with an interrupt lives in `connect.ts`; these
 * only check that the key gets forwarded to it.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { TUI } from "@earendil-works/pi-tui";

import { BrigadeEditor } from "./editor.js";
import { editorTheme } from "./theme.js";

// `Editor` only reaches for `tui.requestRender` on input; `tui.terminal` is
// render/page-scroll territory, which these tests never enter.
const tui = { requestRender: () => {} } as unknown as TUI;

function make(): { editor: BrigadeEditor; interrupts: () => number } {
	const editor = new BrigadeEditor(tui, editorTheme);
	let count = 0;
	editor.onInterrupt = () => {
		count += 1;
	};
	return { editor, interrupts: () => count };
}

function type(editor: BrigadeEditor, text: string): void {
	for (const ch of text) editor.handleInput(ch);
}

describe("BrigadeEditor — interrupt key", () => {
	it("forwards a bare Ctrl+C (0x03) to the host", () => {
		const { editor, interrupts } = make();
		type(editor, "hi");
		editor.handleInput("\x03");
		assert.equal(interrupts(), 1);
		assert.equal(editor.getText(), "hi"); // the keypress must not edit the line
	});

	it("forwards Ctrl+C in the Kitty encoding the protocol negotiates", () => {
		const { editor, interrupts } = make();
		editor.handleInput("\x1b[99;5u");
		assert.equal(interrupts(), 1);
	});

	it("leaves ordinary typing untouched", () => {
		const { editor, interrupts } = make();
		type(editor, "hello");
		assert.equal(interrupts(), 0);
		assert.equal(editor.getText(), "hello");
	});

	it("quits on Ctrl+D only when the line is empty", () => {
		const withText = make();
		type(withText.editor, "abc");
		withText.editor.handleInput("\x1b[D"); // cursor between "ab" and "c"
		withText.editor.handleInput("\x04");
		assert.equal(withText.interrupts(), 0);
		assert.equal(withText.editor.getText(), "ab"); // delete-forward, as before

		const empty = make();
		empty.editor.handleInput("\x04");
		assert.equal(empty.interrupts(), 1);
	});

	// Delete and Ctrl+D share the `tui.editor.deleteCharForward` binding. Matching
	// on the BINDING instead of the key would make Delete on an empty line quit.
	it("never quits on the Delete key", () => {
		const { editor, interrupts } = make();
		editor.handleInput("\x1b[3~");
		assert.equal(interrupts(), 0);
	});
});
