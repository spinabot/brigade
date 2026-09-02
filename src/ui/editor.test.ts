/**
 * Key routing for `BrigadeEditor`: which keypresses reach `onInterrupt` and which
 * must not. What the host then does with an interrupt lives in `connect.ts`; these
 * only check that the key gets forwarded to it.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CombinedAutocompleteProvider, type TUI } from "@earendil-works/pi-tui";

import { BrigadeEditor, NO_REQUIRED_ARG_FOR_TEST } from "./editor.js";
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

describe("BrigadeEditor — reasoning toggle key", () => {
	function makeToggle(): { editor: BrigadeEditor; toggles: () => number } {
		const editor = new BrigadeEditor(tui, editorTheme);
		let count = 0;
		editor.onToggleReasoning = () => {
			count += 1;
		};
		return { editor, toggles: () => count };
	}

	it("forwards Ctrl+T (0x14) to the host without editing the line", () => {
		const { editor, toggles } = makeToggle();
		type(editor, "hi");
		editor.handleInput("\x14");
		assert.equal(toggles(), 1);
		assert.equal(editor.getText(), "hi", "the keypress must not reach the buffer");
	});

	it("leaves Ctrl+E alone — pi-tui binds it to cursorLineEnd", () => {
		// Other harnesses use Ctrl+E for this, but taking it here would break
		// end-of-line for anyone using emacs keys.
		const { editor, toggles } = makeToggle();
		type(editor, "hi");
		editor.handleInput("\x05");
		assert.equal(toggles(), 0, "Ctrl+E must not toggle reasoning");
	});

	it("does nothing when the host wired no handler", () => {
		const editor = new BrigadeEditor(tui, editorTheme);
		type(editor, "hi");
		assert.doesNotThrow(() => editor.handleInput("\x14"));
	});

	it("ordinary typing still reaches the buffer", () => {
		const { editor, toggles } = makeToggle();
		type(editor, "top hat");
		assert.equal(editor.getText(), "top hat");
		assert.equal(toggles(), 0);
	});
});

describe("slash aliases", () => {
	// The bug: `clip` was dropped from NO_REQUIRED_ARG while `/clip` remained a
	// live alias of `/clipboard`. The popup shows for any PREFIX of an
	// advertised command, so Enter was translated to Tab — the operator's text
	// silently became `/clipboard` and needed a second Enter.
	//
	// The previous version of this test asserted `NO_REQUIRED_ARG_FOR_TEST.has(
	// "clip")` — set membership, which is the same statement as the production
	// line it was checking, restated. It could not tell whether the SET is even
	// consulted, whether the popup gate matches, or what the operator's line
	// ends up containing. So these press the key instead.

	/** The advertised commands that matter here, as `connect.ts` registers them. */
	const COMMANDS = [
		{ name: "clipboard", description: "diagnose clipboard support" },
		{ name: "search", description: "search the transcript" },
		{ name: "compact", description: "summarize older turns" },
	];

	/** A real editor with the real pi-tui slash-command popup behind it. */
	function slashHarness(): { ed: BrigadeEditor; submitted: string[] } {
		const ed = new BrigadeEditor(tui, editorTheme);
		ed.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, process.cwd()));
		const submitted: string[] = [];
		ed.onSubmit = (v: string) => {
			submitted.push(v);
		};
		return { ed, submitted };
	}

	/** Type, then let the (async) autocomplete request settle so the popup is up. */
	async function typeAndOpenPopup(ed: BrigadeEditor, text: string): Promise<void> {
		type(ed, text);
		for (let i = 0; i < 5 && !ed.isShowingAutocomplete(); i += 1) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(ed.isShowingAutocomplete(), `the popup must be showing for "${text}"`);
	}

	it("/clip — a live alias that is also a PREFIX — submits on one Enter", async () => {
		const { ed, submitted } = slashHarness();
		await typeAndOpenPopup(ed, "/clip");
		ed.handleInput("\r");
		// Pi's own popup-Enter accepts the highlighted completion AND submits, so
		// what goes out is `/clipboard` — the point is that it goes out at ALL, on
		// the FIRST Enter. Dropping `clip` from the set turns this Enter into a
		// Tab: nothing is submitted and the operator has to press Enter again.
		assert.equal(submitted.length, 1, "one Enter must send the command");
		assert.match(submitted[0]!, /^\/clip(board)?$/, "and it must be the clipboard command");
		assert.equal(ed.getText(), "", "the line is consumed, not left waiting for a second Enter");
	});

	it("a command with a REQUIRED argument still completes instead of submitting", async () => {
		// The control. If Enter submitted here, `/search` would be sent with an
		// empty query — which is why the set is a set and not "always submit".
		const { ed, submitted } = slashHarness();
		await typeAndOpenPopup(ed, "/search");
		ed.handleInput("\r");
		assert.deepEqual(submitted, [], "an empty search must never be sent");
		assert.match(ed.getText(), /^\/search\s*$/, "Enter accepted the completion and waits for the query");
	});

	it("aliases that are not a prefix of anything advertised still submit on one Enter", () => {
		// `/cancel` and `/switch` open no popup today, so they take the ordinary
		// submit path. They are listed in NO_REQUIRED_ARG anyway, so that adding a
		// `cancel-*` / `switch-*` command later cannot quietly reintroduce the
		// two-Enter bug — assert both facts, the behaviour and the guard.
		for (const alias of ["cancel", "switch"]) {
			const { ed, submitted } = slashHarness();
			type(ed, `/${alias}`);
			ed.handleInput("\r");
			assert.deepEqual(submitted, [`/${alias}`], `/${alias} must send on one Enter`);
			assert.ok(
				NO_REQUIRED_ARG_FOR_TEST.has(alias),
				`/${alias} must stay listed, or a future /${alias}-* command reintroduces the bug`,
			);
		}
	});
});

describe("Ctrl+Enter steers, plain Enter does not", () => {
	// Steering injects text into a turn already in flight, changing a plan the
	// model is halfway through. Queueing waits for a turn boundary. One is
	// recoverable and one is not, so the irreversible one does not live on the
	// key the operator hits by reflex.
	//
	// Codex puts them the other way round; Claude Code has five open steering
	// issues and a documented docs-vs-behaviour bug from exactly this ambiguity.

	/** The CSI-u encoding a kitty-protocol terminal sends for Ctrl+Enter. */
	const CTRL_ENTER = "\x1b[13;5u";

	function harness() {
		const ed = new BrigadeEditor(tui, editorTheme);
		const submitted: string[] = [];
		ed.onSubmit = (v: string) => {
			submitted.push(v);
		};
		return { ed, submitted };
	}

	it("Ctrl+Enter asks the host, then submits through the SAME path as Enter", () => {
		const { ed, submitted } = harness();
		let asked = 0;
		ed.onSteerSubmit = () => {
			asked += 1;
			return true;
		};
		type(ed, "fix the test");
		ed.handleInput(CTRL_ENTER);
		assert.equal(asked, 1, "the host decides whether to steer");
		assert.deepEqual(submitted, ["fix the test"], "and the normal submit path ran");
	});

	it("the host can refuse, and the keystroke is swallowed", () => {
		// An empty buffer never submits — steering or not.
		const { ed, submitted } = harness();
		ed.onSteerSubmit = () => false;
		type(ed, "   ");
		ed.handleInput(CTRL_ENTER);
		assert.deepEqual(submitted, [], "nothing was sent");
	});

	it("a PLAIN Enter never reaches the steer hook", () => {
		// The whole point of the split: reflex Enter must not be able to steer.
		const { ed, submitted } = harness();
		let asked = 0;
		ed.onSteerSubmit = () => {
			asked += 1;
			return true;
		};
		type(ed, "just a message");
		ed.handleInput("\r");
		assert.equal(asked, 0, "plain Enter must not arm steering");
		assert.deepEqual(submitted, ["just a message"]);
	});

	it("without the hook, a kitty Ctrl+Enter is inert — and the text survives", () => {
		// pi-tui's own behaviour, documented here because the split depends on it:
		// the base editor matches Enter at modifier 0, and a kitty-encoded
		// Ctrl+Enter carries modifier 5, so it is not Enter to pi-tui at all.
		//
		// That is what makes this key safe to claim: wiring `onSteerSubmit` takes
		// a keystroke that previously did nothing, rather than overriding a
		// meaning operators already rely on. It also means the destructive
		// gesture can never fire by accident on a terminal that cannot encode it
		// — there, Ctrl+Enter is a bare `\r` and simply queues.
		const { ed, submitted } = harness();
		type(ed, "hello");
		ed.handleInput(CTRL_ENTER);
		assert.deepEqual(submitted, [], "inert without the hook");
		assert.equal(ed.getText(), "hello", "and it must not corrupt the line");
	});
});

