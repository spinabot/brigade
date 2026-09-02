/**
 * Clipboard WRITE via OSC 52.
 *
 * Brigade's clipboard subsystem is read-only — `clipboard.ts` can pull an image
 * IN (paste a screenshot, auto-attach a copy) and has no path OUT. So the one
 * thing an operator does constantly with a chat reply, take the code block
 * somewhere else, meant mouse-selecting wrapped ANSI text out of a terminal.
 * Every comparable harness ships `/copy`.
 *
 * OSC 52 rather than shelling out to `pbcopy` / `clip.exe` / `wl-copy`, because
 * it is the terminal itself that owns the clipboard: the sequence works over
 * SSH and inside tmux, where a local clipboard binary would write to the
 * REMOTE machine's clipboard — i.e. nowhere useful. That is the whole reason
 * the escape exists.
 *
 * Support is good but not universal (iTerm2, WezTerm, kitty, Ghostty, Alacritty,
 * foot, Windows Terminal; tmux needs `set -g set-clipboard on`). A terminal that
 * does not implement it discards the sequence silently — which is why the caller
 * confirms with a visible line rather than assuming success.
 */

/**
 * Terminals commonly reject very large OSC 52 payloads (tmux's default buffer
 * is famously small). Truncating with a visible notice beats a copy that
 * silently does nothing.
 */
export const OSC52_MAX_BYTES = 74_994;

export interface Osc52Result {
	/** The escape sequence to write, or "" when there was nothing to copy. */
	sequence: string;
	/** Bytes of payload actually encoded. */
	bytes: number;
	/** True when the payload was cut to fit. */
	truncated: boolean;
}

/**
 * Build an OSC 52 "set clipboard" sequence for `text`.
 *
 * Uses the `c` (clipboard) selection. Terminated with BEL rather than ST
 * because BEL is accepted everywhere OSC 52 is, and ST has more variance in
 * how multiplexers pass it through.
 */
export function buildOsc52(text: string): Osc52Result {
	if (!text) return { sequence: "", bytes: 0, truncated: false };

	let payload = Buffer.from(text, "utf8");
	let truncated = false;
	if (payload.byteLength > OSC52_MAX_BYTES) {
		// Cut on a character boundary — slicing raw bytes can split a multi-byte
		// sequence and put a replacement character in the operator's clipboard.
		const cut = payload.subarray(0, OSC52_MAX_BYTES).toString("utf8");
		const safe = cut.endsWith("�") ? cut.slice(0, -1) : cut;
		payload = Buffer.from(safe, "utf8");
		truncated = true;
	}

	return {
		sequence: `\x1b]52;c;${payload.toString("base64")}\x07`,
		bytes: payload.byteLength,
		truncated,
	};
}

/**
 * Extract the last fenced code block from a markdown reply, or `undefined`.
 *
 * The common case for `/copy` is "give me the command / the snippet", not the
 * prose around it.
 */
export function lastCodeBlock(markdown: string): string | undefined {
	if (!markdown) return undefined;
	// Non-greedy body, so consecutive blocks stay separate; the LAST match wins.
	const re = /```[^\n]*\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	let found: string | undefined;
	while ((match = re.exec(markdown)) !== null) {
		const body = match[1];
		if (body && body.trim()) found = body.replace(/\n$/, "");
	}
	return found;
}
