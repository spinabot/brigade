/**
 * Brigade's Editor — thin Pi-TUI subclass that fixes one UX quirk.
 *
 * Pi-TUI's stock `Editor` treats Enter on a slash-command suggestion as
 * "accept + submit-immediately" (`editor.js:507-519` — `tui.select.confirm`
 * applies the completion and falls through to `submitValue()`). That works
 * for arg-less commands (`/help`, `/exit`) but is wrong for commands that
 * take a REQUIRED argument (`/reasoning <on|off>`, `/thinking <level>`,
 * `/mute <agent-id>`) — the user expects to inspect / edit the inserted
 * text before sending.
 *
 * Pi already has an "accept + don't submit" path on Tab
 * (`editor.js:492-505`). When the autocomplete popup is showing AND the
 * user has typed a command that needs an argument, we translate Enter →
 * Tab so the user's Enter on a popup selection just inserts the command
 * into the editor with a trailing space and waits for them to type the
 * arg + a real Enter to submit.
 *
 * For arg-less / optional-arg commands (`/agents`, `/help`, `/agent`,
 * `/sessions`, etc.) the user expects a single Enter to submit — same
 * as Pi's default. Two-Enter behaviour is a UX regression we explicitly
 * opt OUT of here.
 *
 * Outside the popup, Enter retains its normal "submit" semantics.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Editor, matchesKey } from "@earendil-works/pi-tui";

/** Where `BRIGADE_DEBUG_INPUT=1` writes the raw input trace. */
export const INPUT_TRACE_PATH = path.join(os.tmpdir(), "brigade-input-trace.log");

/** Append one raw input chunk, JSON-escaped so control bytes survive the round-trip. */
function traceInput(data: string): void {
	try {
		fs.appendFileSync(
			INPUT_TRACE_PATH,
			`${JSON.stringify({ len: data.length, data })}\n`,
			"utf8",
		);
	} catch {
		/* tracing must never break the editor */
	}
}

// Slash commands whose argument is OPTIONAL (or absent) — Enter should
// submit immediately even when the autocomplete popup is showing. Kept
// in sync with `SLASH_COMMANDS` in `src/cli/commands/connect.ts`.
const NO_REQUIRED_ARG = new Set([
	"help",
	"exit",
	"quit",
	"abort",
	"usage",
	"compact",
	"agents", // no arg
	"agent", // [<agent-id>] — optional
	"session", // [<session-key>] — optional
	"sessions", // [--all] — optional
	"model", // [<model-id>] — optional
	"provider", // [<provider>] — optional (no arg lists providers)
	"reasoning", // [on|off] — optional toggle
	"paste", // no arg — reads the clipboard
	"attach", // [<path>] — optional (no arg lists what's staged)
	"detach", // [<n>|all] — optional (no arg detaches everything)
	"clipboard", // no arg — diagnose
	// ALIASES BELONG HERE TOO, even though they are not in `SLASH_COMMANDS`.
	//
	// This set is consulted whenever the autocomplete popup is showing, and the
	// popup shows for any PREFIX of an advertised command. `/clip` is a live
	// alias of `/clipboard` and its prefix, so dropping it from this set turned
	// Enter into Tab: the operator's text silently became `/clipboard` and they
	// had to press Enter a second time. `/cancel` and `/switch` are not prefixes
	// of anything advertised today and so are unaffected — but they are listed
	// so that adding a command named `cancel-*` or `switch-*` later cannot
	// quietly reintroduce the same bug.
	"export", // [full] — optional
	"rewind", // [n] — optional (no arg lists the points)
	// NOTE: "search" is NOT here — it takes a REQUIRED argument, so Enter on the
	// bare command must insert it and wait rather than submitting an empty search.
	"flush", // no arg — promote the queue into the running turn
	"clip", // alias of /clipboard — no arg
	"cancel", // alias of /abort — no arg
	"switch", // [<agent>] — optional
	"copy", // [code] — optional (no arg copies the whole reply)
	"expand", // [<n>] — optional (no arg expands the most recent)
	"memory", // no arg
	"update", // no arg
	"new", // no arg — the primary "start over" gesture
	"rename", // [<name>] — optional
	"org", // no arg
]);

/**
 * Exported for tests. Aliases live in this set but NOT in `SLASH_COMMANDS`, so
 * nothing else in the codebase can cross-check the two lists — which is exactly
 * how `/clip` regressed into needing two Enters.
 */
export const NO_REQUIRED_ARG_FOR_TEST: ReadonlySet<string> = NO_REQUIRED_ARG;

export class BrigadeEditor extends Editor {
	/**
	 * Fired on a raw Ctrl+V (0x16) / Alt+V — "there may be an IMAGE on the clipboard;
	 * go ask the OS".
	 *
	 * The precise model, because it is easy to get wrong: a terminal's paste can only
	 * carry TEXT. Plain text and a copied file's PATH both have a text form, so those
	 * paste normally — Ctrl+V "works" for them, and the pasted text arrives as
	 * ordinary input (a dropped/pasted path is then auto-attached by `onTextChanged`).
	 * A raw screenshot has NO text form, so the terminal's paste injects nothing and
	 * there is no input to see.
	 *
	 * That image gap is the only thing this hook is for. Two wrinkles: on terminals
	 * that bind Ctrl+V to their own paste (Windows Terminal, VS Code) the 0x16 byte is
	 * consumed and never reaches us, so the hook can't fire there — which is why the
	 * clipboard WATCHER (auto-attach on copy) and `/paste` are the real answers, and
	 * this is a bonus for terminals that do forward the key.
	 */
	onImagePaste?: () => void;

	/**
	 * Fired on Ctrl+T — "show/hide the model's reasoning".
	 *
	 * Ctrl+T rather than the Ctrl+E other harnesses use, because pi-tui already
	 * binds `ctrl+e` to `tui.editor.cursorLineEnd` (keybindings.js) and taking it
	 * would break end-of-line for anyone using emacs keys. Ctrl+T is unbound in
	 * pi-tui's defaults, and `T` for Thinking is the mnemonic Claude Code uses
	 * for the same toggle.
	 */
	onToggleReasoning?: () => void;

	/**
	 * Fired whenever the editor's text CHANGES, by any means.
	 *
	 * This is the hook that makes a dropped file become an attachment instead of a
	 * wall of raw path. A terminal answers a drop by writing the file's PATH into
	 * stdin as text; without this the operator stares at
	 * `C:\Users\me\Downloads\plant-cell.png` sitting in the input box — nothing
	 * staged, no bar, no confirmation, no reason to think it worked.
	 *
	 * It fires on EVERY text change rather than trying to recognise "a paste",
	 * because two successive attempts to recognise one were both wrong:
	 *
	 *   1. `!data.startsWith("\x1b")`, to avoid firing on arrow keys — but pi-tui
	 *      wraps every paste in bracketed-paste markers before handing it over
	 *      ("pasted data will always contain \x1b[200~" — pi-tui/keys.js), so this
	 *      excluded every paste that has ever existed. It never fired once.
	 *   2. "text grew by more than one character" — which assumes the terminal
	 *      delivers a drop as ONE chunk. Not guaranteed: stdin coalescing and each
	 *      terminal's own drop implementation decide that, and VS Code's does not
	 *      behave like Windows Terminal's.
	 *
	 * Both bugs came from trying to infer intent from the SHAPE of the input. So we
	 * no longer infer anything: the host re-reads the whole line on any change and
	 * looks for a path that names a real file. Whether it arrived as one chunk, ten
	 * chunks, bracketed, unbracketed, or typed by hand stops mattering entirely.
	 */
	onTextChanged?: () => void;

	/**
	 * Fired on a PASTE gesture — a bracketed paste (`\x1b[200~…`), which is what the
	 * terminal emits when the operator presses Ctrl+V (or Ctrl+Shift+V).
	 *
	 * This is how Ctrl+V attaches an image, and it is exactly how Claude Code does
	 * it: you don't intercept the KEY (the terminal consumes it), you react to the
	 * paste EVENT the terminal sends, and at that moment you check the clipboard for
	 * an image. The real binary carries the same trio — `onPaste`, `isPasting`, and a
	 * clipboard `GetImage()` on paste.
	 *
	 * The text portion of the paste (if any) still flows into the editor normally;
	 * this fires ALONGSIDE that, so a text paste is unaffected and an image paste
	 * gets attached. Fires even for an empty paste, because an image-only clipboard
	 * pastes no text but still sends the bracketed markers.
	 */
	onPaste?: () => void;

	/**
	 * Fired when the operator presses Ctrl+C, or Ctrl+D on an empty line. What
	 * "interrupt" should DO is the host's choice: `connect.ts` raises SIGINT, and its
	 * handler aborts the turn or exits.
	 *
	 * Without this hook the keypress is simply lost. The terminal is in raw mode, so
	 * the kernel never turns Ctrl+C into SIGINT, and Pi's own `Editor` ignores the
	 * byte on purpose ("Ctrl+C - let parent handle (exit/clear)") to leave the
	 * decision to the application. This editor IS the application's, so the key
	 * travels no further unless it is forwarded from here.
	 *
	 * Hook the EDITOR, not the whole TUI: `ctrl+c` is also `tui.select.cancel`, so a
	 * global interceptor would quit the app where `/model` just closes its list.
	 */
	onInterrupt?: () => void;

	/**
	 * Fired on Ctrl+Enter / Cmd+Enter — "STEER the running turn", as opposed to
	 * a plain Enter, which queues.
	 *
	 * ─────────────────────────────────────────────────────────────────────────
	 * WHY THE MODIFIER CARRIES THE DESTRUCTIVE ACTION
	 * ─────────────────────────────────────────────────────────────────────────
	 * Steering injects text into a turn already in flight, changing a plan the
	 * model is halfway through. Queueing waits for a turn boundary. One of those
	 * is recoverable and one is not, so the irreversible one must not be the key
	 * your fingers press by reflex.
	 *
	 * Codex puts them the other way round (Enter steers, Tab queues) and Claude
	 * Code has five open steering issues plus a documented docs-vs-behaviour bug
	 * from exactly this ambiguity. DeepSeek's harness splits them the way this
	 * does, and that is the one worth copying.
	 *
	 * ─────────────────────────────────────────────────────────────────────────
	 * NOT EVERY TERMINAL CAN REPORT THIS
	 * ─────────────────────────────────────────────────────────────────────────
	 * `ctrl+enter` resolves only through the kitty keyboard protocol or xterm's
	 * `modifyOtherKeys` (`pi-tui/keys.js`). In Terminal.app and other basic
	 * terminals, Ctrl+Enter is byte-identical to Enter and this hook can never
	 * fire. That is why `/steer <text>` exists as the universal path, and why
	 * the host's hint checks `isKittyProtocolActive()` before advertising a
	 * keystroke the operator's terminal cannot send.
	 * Returns TRUE to proceed with a normal submit (the host has armed steering),
	 * FALSE to swallow the keystroke — an empty buffer, say. The editor does the
	 * submitting rather than the host, because `submitValue()` is private to
	 * pi-tui and reaching around it would fork the submit path; routing through
	 * `super.handleInput("\r")` keeps steering and ordinary Enter on exactly one
	 * code path, so they cannot drift.
	 */
	onSteerSubmit?: () => boolean;

	override handleInput(data: string): void {
		// `BRIGADE_DEBUG_INPUT=1` appends every raw input chunk to a trace file.
		//
		// Terminals disagree — loudly — about what they send for a dropped file and
		// for Ctrl+V, and two bugs in this editor came from guessing wrong about it.
		// When an operator reports "drag-drop does nothing in <terminal>", this is how
		// we find out what their terminal ACTUALLY sends instead of reasoning about
		// what it ought to.
		if (process.env.BRIGADE_DEBUG_INPUT) traceInput(data);

		// A PASTE just arrived. Fire the paste hook (which checks the clipboard for an
		// image) and STILL fall through so the base editor inserts any pasted text —
		// the two are complementary: text lands in the editor, an image gets attached.
		if (data.includes("\x1b[200~") && this.onPaste) this.onPaste();

		// Ctrl+C — see `onInterrupt`. `matchesKey` covers the bare `0x03` byte and the
		// Kitty encoding (`ESC[99;5u`) alike.
		if (this.onInterrupt && matchesKey(data, "ctrl+c")) {
			this.onInterrupt();
			return;
		}

		// Ctrl+Enter / Cmd+Enter — steer the running turn instead of queueing.
		// Checked BEFORE the autocomplete branch and before Pi's submit, because
		// both would otherwise treat it as a plain Enter. Only fires where the
		// terminal can actually report the modifier; elsewhere the byte is a bare
		// `\r` and this is unreachable by construction.
		if (
			this.onSteerSubmit &&
			(matchesKey(data, "ctrl+enter") || matchesKey(data, "super+enter"))
		) {
			// The host arms steering and says whether to submit at all. Submitting
			// via `super.handleInput("\r")` keeps this on the SAME path as an
			// ordinary Enter — attachment handling, the echo, the stale-busy-flag
			// recovery — so the two can never drift apart.
			if (this.onSteerSubmit()) super.handleInput("\r");
			return;
		}

		// Ctrl+T toggles reasoning visibility. Unbound in pi-tui's defaults, so
		// nothing is being taken away — unlike Ctrl+E, which is cursorLineEnd.
		if (this.onToggleReasoning && matchesKey(data, "ctrl+t")) {
			this.onToggleReasoning();
			return;
		}

		// Ctrl+D quits only on an EMPTY line; with text it stays Pi's delete-forward.
		// Matched by key, not by the `tui.editor.deleteCharForward` binding — that
		// binding also covers Delete, and Delete on an empty line must not quit.
		if (this.onInterrupt && matchesKey(data, "ctrl+d") && this.getText() === "") {
			this.onInterrupt();
			return;
		}

		// Ctrl+V (0x16) and Alt+V (ESC v) both mean "paste an image from the clipboard".
		//
		// BOTH exist because Ctrl+V alone is not enough on Windows. Windows Terminal
		// binds Ctrl+V to its OWN paste action, which inserts the clipboard's TEXT —
		// and when the clipboard holds an image with no text, it inserts nothing at
		// all. The keypress is consumed by the terminal and never reaches us, so
		// there is nothing for this method to hook. Alt+V is not bound by any
		// mainstream terminal, so it reaches the application intact and gives Windows
		// operators a real keystroke instead of a command they have to type.
		if ((data === "\x16" || data === "\x1bv" || data === "\x1bV") && this.onImagePaste) {
			this.onImagePaste();
			return;
		}
		// Pi's handleInput recognises both `\r` and `\n` as Enter (see
		// `editor.js:586-613`). Translate either to Tab `\t` ONLY when the
		// autocomplete popup is showing AND the command needs a required
		// argument. Otherwise Enter submits normally.
		if (this.isShowingAutocomplete() && (data === "\r" || data === "\n")) {
			const text = this.getText();
			// Match a slash command that hasn't been argument-typed yet:
			// `/<name>` with optional trailing whitespace. If the user has
			// already typed an arg (text contains a space + chars), we keep
			// Pi's default submit path too — the autocomplete popup at that
			// point is showing argument completions, not command completions.
			const match = text.match(/^\/([a-z][a-z0-9_-]*)\s*$/);
			if (match && NO_REQUIRED_ARG.has(match[1] ?? "")) {
				// Arg-less or optional-arg command typed in full — let Pi
				// accept + submit in one Enter (the default behaviour).
				super.handleInput(data);
				return;
			}
			// Either the command needs a required arg, the text is partial,
			// or the popup is showing argument completions — translate to
			// Tab so the user can edit before sending.
			super.handleInput("\t");
			return;
		}
		const before = this.getText();
		super.handleInput(data);
		// Any change at all — dropped, pasted, or typed. The host decides whether the
		// line now contains a real file path. No guessing about chunk shapes.
		if (this.getText() !== before && this.onTextChanged) {
			this.onTextChanged();
		}
	}
}
