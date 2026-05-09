/**
 * Brigade's Editor — thin Pi-TUI subclass that fixes one UX quirk.
 *
 * Pi-TUI's stock `Editor` treats Enter on a slash-command suggestion as
 * "accept + submit-immediately" (`editor.js:507-519` — `tui.select.confirm`
 * applies the completion and falls through to `submitValue()`). That works
 * for arg-less commands (`/help`, `/exit`) but is wrong for commands that
 * take arguments (`/reasoning <on|off>`, `/thinking <level>`, `/model <id>`)
 * — the user expects to inspect / edit the inserted text before sending.
 *
 * Pi already has an "accept + don't submit" path on Tab
 * (`editor.js:492-505`). When the autocomplete popup is showing, we
 * translate Enter → Tab so the user's Enter on a popup selection just
 * inserts the command into the editor with a trailing space, leaves the
 * cursor at the end, and waits for the user to type the arg + a real
 * Enter to submit.
 *
 * Outside the popup, Enter retains its normal "submit" semantics.
 */

import { Editor } from "@mariozechner/pi-tui";

export class BrigadeEditor extends Editor {
	override handleInput(data: string): void {
		// Pi's handleInput recognises both `\r` and `\n` as Enter (see
		// `editor.js:586-613`). Translate either to Tab `\t` only when the
		// autocomplete popup is currently showing — outside the popup, Enter
		// is the regular submit key and must keep working.
		if (this.isShowingAutocomplete() && (data === "\r" || data === "\n")) {
			super.handleInput("\t");
			return;
		}
		super.handleInput(data);
	}
}
