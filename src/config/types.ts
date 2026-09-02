/**
 * Re-export shim for Brigade's config type surface.
 *
 * Brigade's actual config types are declared inline in `config/io.ts` (where
 * the loader / writer lives). Lifted code references the shorter
 * `config/types.js` path used by the upstream reference codebase. This file
 * keeps the two import paths in lockstep without forking the source of truth.
 *
 * Do NOT add new types here — extend `config/io.ts` and re-export below.
 */

export type {
	BrigadeConfig,
	BrigadeAgentsConfig,
	BrigadeAgentDefaults,
	BrigadeModelEntry,
	BrigadeModelSelection,
	AgentConfig,
	BrigadeGatewayConfig,
	BrigadeSessionConfig,
	BrigadeChatConfig,
	BrigadeToolsConfig,
	BrigadeAuthConfig,
	BrigadeAuthProfileMeta,
	BrigadePluginsConfig,
	BrigadePluginEntry,
	BrigadeSkillsConfig,
	BrigadeSkillEntry,
	BrigadeWizardMetaConfig,
	BrigadeConfigMeta,
	// Multi-routing additions (Step 2 of SessionContext refactor):
	DmScope,
	SessionToolsVisibility,
	AgentToAgentPolicy,
	BindingEntry,
	BrigadeBindings,
	// Org / virtual-office additions (Stage A: inert):
	BrigadeOrgConfig,
} from "./io.js";
