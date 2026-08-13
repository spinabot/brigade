// Shared regex corpus for the exec-approval pattern guard tests.
//
// The catastrophic shapes are composed from a unit rather than spelled out as
// literals: four test files need the same corpus, and a single builder keeps
// them from drifting apart. Composing also keeps static analysers from reading
// a deliberately-hostile fixture as a regex the product actually uses.
//
// Excluded from tsconfig.build.json, so none of this reaches dist.

/** `^(<unit>+)+$` — a quantified group inside another quantifier. */
export function nestedQuantifier(unit: string, { head = "", tail = "" } = {}): string {
	return `^${head}(${unit}+)+${tail}$`;
}

/** `(<unit>+)+$` — the same ambiguity with no anchored head. */
export function unanchoredNestedQuantifier(unit: string): string {
	return `(${unit}+)+$`;
}

/** `^(<unit>|<unit>)*$` — alternation whose branches match the same input. */
export function ambiguousAlternation(unit: string): string {
	return `^(${unit}|${unit})*$`;
}

/** `^(<unit>*)*$` — a star nested directly inside a star. */
export function nestedStar(unit: string): string {
	return `^(${unit}*)*$`;
}

/** `^(a+)+(b+)+…$` — several ambiguous groups in series, to stack the cost. */
export function chainedNestedQuantifiers(units: string[]): string {
	return `^${units.map((u) => `(${u}+)+`).join("")}$`;
}

/**
 * Patterns `validateApprovalPattern` must refuse as `pattern-too-slow`.
 *
 * The first entry carries a literal head on purpose: without the literal-prefix
 * probing, `aaaa…` probes fail at `^git ` and never reach the ambiguous tail, so
 * the pattern measures fast and slips through.
 */
export const CATASTROPHIC_PATTERNS = [
	nestedQuantifier("a", { head: "git " }),
	ambiguousAlternation("a"),
	nestedQuantifier("[a-z]", { tail: "#" }),
	unanchoredNestedQuantifier("a"),
	nestedStar("a"),
];

/** The subset the RPC and bridge tests use — same shapes, fewer cases. */
export const CATASTROPHIC_TRIO = CATASTROPHIC_PATTERNS.slice(0, 3);
