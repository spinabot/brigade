/**
 * Brigade tool framework — public entry point.
 *
 * Re-exports the types, helpers, and registry that tool authors and
 * the agent runtime need. Primitives #4-6 will add tool implementations
 * (`write_memory`, `recall_memory`, `spawn_agent`) as siblings of this
 * file; they are NOT re-exported here so the public surface stays
 * narrow until those primitives stabilise.
 */

export type {
	AgentToolResult,
	AgentToolUpdateCallback,
	AnyBrigadeTool,
	BrigadeTool,
} from "./types.js";

export {
	BrigadeToolAuthorizationError,
	BrigadeToolInputError,
	OWNER_ONLY_TOOL_ERROR,
	failedTextResult,
	jsonResult,
	payloadTextResult,
	readBooleanParam,
	readNumberParam,
	readStringArrayParam,
	readStringParam,
	stringifyToolPayload,
	textResult,
} from "./common.js";
export type {
	NumberParamOptions,
	StringParamOptions,
} from "./common.js";

export {
	createBrigadeTools,
	listBrigadeToolNames,
	type CreateBrigadeToolsOptions,
} from "./registry.js";
