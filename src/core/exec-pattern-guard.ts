/**
 * Exec-approval pattern guard — the bar an operator-supplied regex has to
 * clear before it lands in an agent's allowlist.
 *
 * Why a guard and not an escaper: the operator is SUPPOSED to hand us a regex.
 * `brigade exec allow-pattern "^git (status|diff)( |$)"` is the whole feature.
 * What the gate cannot accept is a pattern that costs unbounded time to
 * evaluate — `decideApproval` re-runs every stored pattern against EVERY bash
 * command at the tool-call boundary, so one `(a+)+`-shaped entry doesn't fail
 * once, it wedges the agent loop on every call, from disk, forever. There is no
 * error to grep for; the operator just sees a hang.
 *
 * This lives in `core/` rather than in the CLI command because four surfaces
 * write patterns — `brigade exec allow-pattern`, the `exec.allow-pattern` RPC,
 * the approval bridge, and the TUI prompt — and `recordApproval` enforces the
 * guard for all of them. The module imports nothing on purpose so the read path
 * and the TUI can use it without pulling in the approvals store.
 */

/**
 * Upper bound on an approval pattern. A pattern describes a family of shell
 * commands — anything past this is a paste accident, and every stored pattern
 * is recompiled and re-run against EVERY bash command the gate sees.
 */
export const MAX_APPROVAL_PATTERN_LENGTH = 512;

/**
 * Repetitive inputs the backtracking canary escalates through. Sizes stop at 26
 * deliberately: a doubly-nested quantifier costs ~2^n there (~0.5s worst case,
 * measured), which is slow enough to flag and fast enough to bound the check.
 */
const BACKTRACK_PROBE_UNITS: readonly string[] = ["a", "a ", "1", "/a", "-a"];
const BACKTRACK_PROBE_SIZES: readonly number[] = [16, 20, 24, 26];
const BACKTRACK_BUDGET_MS = 50;

/** Why a pattern was refused. Surfaces map these onto their own error shape. */
export type ApprovalPatternRefusalCode = "pattern-too-long" | "invalid-regex" | "pattern-too-slow";

export interface ApprovalPatternRefusal {
	code: ApprovalPatternRefusalCode;
	/** One-line summary in the CLI's voice, with no surface-specific prefix. */
	message: string;
	/** Actionable follow-ups, one per rendered line. Empty when none apply. */
	hint: readonly string[];
	/** Present for `invalid-regex` — the engine's own SyntaxError text. */
	syntaxError?: string;
}

export type ApprovalPatternCheck =
	| { ok: true; regex: RegExp }
	| { ok: false; refusal: ApprovalPatternRefusal };

/**
 * The literal head of a pattern — `^git (a+)+$` → `"git "`. Probes carry it so
 * an anchored pattern actually reaches its own ambiguous tail instead of
 * failing on the first character. Best effort: stops at the first
 * metacharacter, and gives back a trailing literal that a quantifier owns
 * (`^gitx*` → `"git"`).
 */
function literalPrefix(pattern: string): string {
	const body = pattern.startsWith("^") ? pattern.slice(1) : pattern;
	let out = "";
	for (const ch of body) {
		if ("\\^$.|?*+()[]{}".includes(ch)) break;
		out += ch;
	}
	const next = body[out.length];
	if (next !== undefined && "?*+{".includes(next)) out = out.slice(0, -1);
	return out;
}

/**
 * Does this pattern backtrack catastrophically? A pattern is not a one-shot
 * check — the gate re-tests it on every bash tool call, so a `(a+)+`-shaped
 * regex doesn't fail, it HANGS the agent, and the operator sees a wedge with no
 * error to search for. Cheaper to refuse it at write time.
 *
 * We time the compiled regex against repetitive inputs of growing length and
 * bail the moment the budget is gone. A well-behaved pattern clears the whole
 * sweep in microseconds; an exponential one blows past 50ms by n=24.
 *
 * A net, not a proof: a pattern whose ambiguity sits behind more structure than
 * a literal prefix can slip through. It never refuses a pattern that isn't
 * measurably slow, which is the trade we want — a wrongly rejected allowlist
 * entry is a worse bug than a missed one.
 */
function backtracksCatastrophically(re: RegExp, pattern: string): boolean {
	const prefix = literalPrefix(pattern);
	const started = Date.now();
	for (const size of BACKTRACK_PROBE_SIZES) {
		for (const unit of BACKTRACK_PROBE_UNITS) {
			re.test(`${prefix}${unit.repeat(size)}!`);
			if (Date.now() - started > BACKTRACK_BUDGET_MS) return true;
		}
	}
	return false;
}

/**
 * Check an operator-supplied approval pattern and hand back the compiled regex
 * on success. Callers that only need a yes/no can read `.ok`; callers that
 * evaluate the pattern later (the gate's load path) should keep `.regex` so the
 * pattern is compiled — and measured — exactly once.
 *
 * The input is trimmed here so every surface agrees on what "the pattern" is.
 * An empty pattern is NOT a refusal: each surface already rejects it with its
 * own wording before it gets this far.
 */
export function validateApprovalPattern(pattern: string): ApprovalPatternCheck {
	const pat = pattern.trim();
	if (pat.length > MAX_APPROVAL_PATTERN_LENGTH) {
		return {
			ok: false,
			refusal: {
				code: "pattern-too-long",
				message: `pattern is too long (${pat.length} chars, max ${MAX_APPROVAL_PATTERN_LENGTH})`,
				hint: [
					"a pattern describes a family of commands — if you need one this big, add the commands with `brigade exec allow` instead.",
				],
			},
		};
	}
	let re: RegExp;
	try {
		re = new RegExp(pat);
	} catch (err) {
		const syntaxError = (err as Error).message;
		return {
			ok: false,
			refusal: {
				code: "invalid-regex",
				message: `invalid regex pattern: ${syntaxError}`,
				hint: [],
				syntaxError,
			},
		};
	}
	if (backtracksCatastrophically(re, pat)) {
		return {
			ok: false,
			refusal: {
				code: "pattern-too-slow",
				message: "that pattern backtracks catastrophically and won't be stored",
				hint: [
					"the gate re-tests every pattern on every bash command, so this one would hang the agent rather than fail.",
					"usually a quantifier inside a quantified group — write `a+` instead of `(a+)+`, and anchor the pattern with `^`.",
				],
			},
		};
	}
	return { ok: true, regex: re };
}

/**
 * Flatten a refusal into one sentence, for transports that carry a single
 * string (RPC `reason`, thrown error message, channel reply) instead of a
 * headline plus dim hint lines.
 */
export function describeApprovalPatternRefusal(refusal: ApprovalPatternRefusal): string {
	return [refusal.message, ...refusal.hint].join(" ");
}
