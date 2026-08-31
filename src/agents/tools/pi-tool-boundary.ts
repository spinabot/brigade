/**
 * What survives the crossing into Pi's loop — and what silently does not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS EXISTS TO MAKE LOUD
 * ─────────────────────────────────────────────────────────────────────────
 * Pi does not pass a tool object through to its loop. `wrapToolDefinition`
 * (`pi-coding-agent/dist/core/tools/tool-definition-wrapper.js`) builds a NEW
 * object copying a FIXED list of fields:
 *
 *     name, label, description, parameters, prepareArguments, executionMode, execute
 *
 * Anything else on the object is dropped on the floor. No error, no warning,
 * no type failure — `BrigadeTool` extends `AgentTool`, so adding a field to it
 * compiles perfectly and then never arrives.
 *
 * Today nothing is broken: `ownerOnly` and `displaySummary` are both consumed
 * on Brigade's own side, before or around Pi, never read back off a wrapped
 * tool. But that is a fact about the current two fields, not a property of the
 * design. The next person to add a `BrigadeTool` field and expect Pi's loop to
 * see it gets a green build and a feature that does nothing.
 *
 * This session has already shipped that exact bug three times by other routes —
 * a dropped `transformContext` option, a repair matching the wrong message
 * dialect, a boundary rule looking for a role Pi never emits. Every one was
 * invisible because the failure mode is silence.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SO: DECLARE THE BOUNDARY
 * ─────────────────────────────────────────────────────────────────────────
 * `PI_CARRIED_TOOL_FIELDS` is what Pi carries. `BRIGADE_LOCAL_TOOL_FIELDS` is
 * what Brigade adds and consumes itself. A conformance test asserts that every
 * field on `BrigadeTool` is in one list or the other, so adding a third
 * category fails the build and forces an explicit decision:
 *
 *   • consume it Brigade-side (add to BRIGADE_LOCAL_TOOL_FIELDS), or
 *   • carry it across yourself, because Pi will not.
 */

/**
 * Fields `wrapToolDefinition` copies into the object Pi's loop actually sees.
 *
 * Verified against `pi-coding-agent/dist/core/tools/tool-definition-wrapper.js`.
 * If a Pi upgrade changes this list, the conformance test is where you find out.
 */
export const PI_CARRIED_TOOL_FIELDS = [
	"name",
	"label",
	"description",
	"parameters",
	"prepareArguments",
	"executionMode",
	"execute",
] as const;

/**
 * Brigade-only fields. Each MUST be consumed on Brigade's side of the
 * boundary, because Pi drops them.
 *
 *   • `ownerOnly` — enforced by wrapping `execute` in Brigade's registry
 *     (`tools/common.ts`), so the check rides inside a field Pi does carry.
 *   • `displaySummary` — read by the TUI off Brigade's own registry, never
 *     off a Pi-wrapped tool.
 */
export const BRIGADE_LOCAL_TOOL_FIELDS = ["ownerOnly", "displaySummary"] as const;

export type PiCarriedToolField = (typeof PI_CARRIED_TOOL_FIELDS)[number];
export type BrigadeLocalToolField = (typeof BRIGADE_LOCAL_TOOL_FIELDS)[number];

/**
 * Fields present on a tool that Pi will silently drop.
 *
 * Runtime counterpart to the conformance test: a tool assembled dynamically
 * (an MCP-sourced tool, a plugin's) can carry fields the type system never
 * saw. Callers use this to log rather than to fail — an unknown field is a
 * smell, not a reason to refuse a working tool.
 */
export function fieldsPiWillDrop(tool: object): string[] {
	const carried = new Set<string>(PI_CARRIED_TOOL_FIELDS);
	return Object.keys(tool).filter((k) => !carried.has(k));
}

/**
 * Does this tool rely on a field Pi drops that Brigade does NOT handle itself?
 *
 * Empty means the tool is safe to hand to Pi. A non-empty result names fields
 * that will vanish with no other symptom.
 */
export function unhandledPiDroppedFields(tool: object): string[] {
	const local = new Set<string>(BRIGADE_LOCAL_TOOL_FIELDS);
	return fieldsPiWillDrop(tool).filter((k) => !local.has(k));
}
