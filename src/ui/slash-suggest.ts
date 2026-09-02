/**
 * "Did you mean …?" for a mistyped slash command.
 *
 * A refusal that only says "unknown command" leaves the operator to guess
 * whether they misremembered the name or the build lacks the feature. Naming
 * the nearest registered command answers that in one line, and the common case
 * — a transposition or a dropped letter — becomes a single keystroke to fix.
 *
 * Deliberately conservative. A suggestion that is not obviously right is worse
 * than none: it sends someone off to try a command that does something else.
 * So the distance budget scales with the word's length (one edit for a short
 * name, at most two for a long one), and a candidate must share the first
 * letter — nearly every real typo does, and requiring it removes the
 * suggestions that read as non-sequiturs.
 */

/**
 * Damerau-Levenshtein distance, with an early exit once the budget is blown.
 *
 * Damerau rather than plain Levenshtein because an ADJACENT TRANSPOSITION is
 * the most common typing error there is, and plain Levenshtein scores it as
 * two edits — so `hlep` would not reach `help` under any budget tight enough
 * to keep the suggestions honest.
 */
function editDistance(a: string, b: string, budget: number): number {
	if (Math.abs(a.length - b.length) > budget) return budget + 1;
	// Two rolling rows rather than a full matrix — these are short words, but
	// this runs on every mistyped command and allocating a matrix for it is
	// pointless.
	let prevPrev = new Array<number>(b.length + 1).fill(0);
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	let cur = new Array<number>(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		cur[0] = i;
		let rowMin = cur[0]!;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
			// Adjacent transposition costs ONE, not two.
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				v = Math.min(v, prevPrev[j - 2]! + 1);
			}
			cur[j] = v;
			if (cur[j]! < rowMin) rowMin = cur[j]!;
		}
		// Every remaining row can only add to the minimum, so once the best cell
		// in this row exceeds the budget the answer cannot come back under it.
		if (rowMin > budget) return budget + 1;
		const swap = prevPrev;
		prevPrev = prev;
		prev = cur;
		cur = swap;
	}
	return prev[b.length]!;
}

/**
 * The closest command name to `word`, or undefined when nothing is close
 * enough to be worth suggesting.
 *
 * `word` is the command WITHOUT its leading slash, lowercased by the caller.
 */
export function nearestSlashCommand(
	word: string,
	commands: readonly string[],
): string | undefined {
	const w = word.trim().toLowerCase();
	if (!w) return undefined;

	// A prefix is a stronger signal than edit distance — someone who typed
	// `/sess` wants `/session`, which is 3 edits away and would otherwise lose
	// to a nearer but unrelated name.
	const prefix = commands.filter((c) => c.toLowerCase().startsWith(w));
	if (prefix.length === 1) return prefix[0];
	if (prefix.length > 1) {
		// One special case is not really ambiguous: when the shortest candidate
		// is itself a prefix of every other (`session` inside `sessions`), it is
		// the minimal completion and the one the operator asked for.
		const shortest = prefix.reduce((a, b) => (a.length <= b.length ? a : b));
		if (prefix.every((c) => c.toLowerCase().startsWith(shortest.toLowerCase()))) return shortest;
		// Otherwise (`/se` → search, session, sessions) choosing one would be a
		// coin flip presented as advice. Say nothing; `/help` lists them all.
		return undefined;
	}

	const budget = w.length <= 4 ? 1 : 2;
	let best: string | undefined;
	let bestScore = budget + 1;
	for (const c of commands) {
		const cand = c.toLowerCase();
		// Same first letter: true of nearly every real typo, and dropping the
		// rest keeps the suggestion from reading as a non-sequitur.
		if (cand[0] !== w[0]) continue;
		const d = editDistance(w, cand, budget);
		if (d < bestScore) {
			bestScore = d;
			best = c;
		} else if (d === bestScore) {
			// A tie is an ambiguous answer. Prefer silence over a guess.
			best = undefined;
		}
	}
	return bestScore <= budget ? best : undefined;
}
