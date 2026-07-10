// Constants + pure builders for the `claude-cli` inference backend — the
// transport that drives an installed Claude Code binary (`claude`) as a
// provider so a turn bills against the operator's Claude subscription exactly
// like the Claude Code CLI / IDE extension, instead of Brigade's raw-HTTP
// OAuth path (which Anthropic routes into the "extra usage" overage tier).
//
// The argv/env construction, model catalog, and alias map are pure. The only
// side-effecting helper is the bundled-binary resolver (a cached fs read).

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/** The Pi `api` string + provider id + model-ref prefix for this backend. */
export const CLAUDE_CLI_API = "claude-cli";
export const CLAUDE_CLI_PROVIDER = "claude-cli";

/**
 * Resolve the `claude` binary to spawn. Precedence:
 *   1. `BRIGADE_CLAUDE_CLI_PATH` env override (explicit operator choice).
*   2. The binary BUNDLED with Brigade — `@anthropic-ai/claude-code` is a
 *      DIRECT dependency, so every `npm i` of Brigade installs it and we resolve
 *      its own `bin` entry. This makes the backend work with zero separate
 *      install ("everything automated").
 *   3. `claude` on PATH (a global Claude Code install) — a defensive fallback
 *      for the rare case the dependency's binary isn't resolvable on this host.
 */
export function resolveClaudeCliCommand(): string {
	const override = process.env.BRIGADE_CLAUDE_CLI_PATH?.trim();
	if (override && override.length > 0) return override;
	const bundled = resolveBundledClaudeBinary();
	if (bundled) return bundled;
	return "claude";
}

let bundledClaudeCache: string | null | undefined;

// The vendor tarball ships a ~500-byte PLACEHOLDER at `bin/claude.exe` (a stub
// that just prints "native binary not installed" and exits 1); the real native
// binary is hardlinked over it by the package's `postinstall` from a
// platform-specific optional dependency. In a degraded install
// (`--ignore-scripts`, `--omit=optional`, or an unsupported platform) the stub
// is left in place. `existsSync` can't tell the stub from the real binary, so
// we ALSO gate on size — the vendor's own installer uses `size < 4096` as its
// stub sentinel, so we mirror it. Below the threshold ⇒ treat as "not bundled"
// and fall through to `claude` on PATH instead of spawning a broken stub.
const CLAUDE_BUNDLED_MIN_SIZE_BYTES = 4096;

/**
 * Resolve the `claude` binary shipped by the `@anthropic-ai/claude-code`
 * dependency, or undefined when it isn't installed OR is only the placeholder
 * stub. Reads the package's own `bin` field so we spawn whatever entry the
 * vendor declares (a native `claude.exe` on Windows, a launcher elsewhere).
 * Cached; never throws.
 */
export function resolveBundledClaudeBinary(): string | undefined {
	if (bundledClaudeCache !== undefined) return bundledClaudeCache ?? undefined;
	try {
		const require = createRequire(import.meta.url);
		const pkgJsonPath = require.resolve("@anthropic-ai/claude-code/package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as { bin?: string | Record<string, string> };
		const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
		if (binRel) {
			const binPath = path.join(path.dirname(pkgJsonPath), binRel);
			// Reject the placeholder stub — a real native binary is far larger, so a
			// tiny file means postinstall never replaced it (degraded install).
			const size = fs.statSync(binPath).size; // throws if missing → caught below
			if (size >= CLAUDE_BUNDLED_MIN_SIZE_BYTES) {
				bundledClaudeCache = binPath;
				return binPath;
			}
		}
	} catch {
		/* dep not installed / stub missing / unreadable — fall through to PATH */
	}
	bundledClaudeCache = null;
	return undefined;
}

/** Test-only reset for the bundled-binary cache. */
export function __resetBundledClaudeCache(): void {
	bundledClaudeCache = undefined;
}

/**
 * Models Brigade advertises for the claude-cli provider. `id` is the Brigade-
 * side model id (what `claude-cli/<id>` resolves to); `cliModel` is what we
 * pass to `--model`. The CLI accepts the full snapshot id directly, so we send
 * it verbatim (the alias map below is only a fallback for bare families).
 *
 * Costs are ZERO on purpose: a subscription turn draws no per-token charge, so
 * reporting API pricing here would be a lie in the status footer.
 */
export interface ClaudeCliModelDef {
	id: string;
	name: string;
	cliModel: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

// Static FALLBACK catalog — used only when live discovery (models-live.ts,
// which queries the account's real `/v1/models`) is unavailable. Kept roughly
// current so an offline picker still offers sensible choices, but the live
// fetch is the source of truth and will surface anything newer (it's what puts
// Fable 5 / Sonnet 5 in front of the operator the moment their account has it).
export const CLAUDE_CLI_MODELS: readonly ClaudeCliModelDef[] = [
	{ id: "claude-sonnet-5", name: "Claude Sonnet 5 (subscription)", cliModel: "claude-sonnet-5", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-fable-5", name: "Claude Fable 5 (subscription)", cliModel: "claude-fable-5", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-opus-4-8", name: "Claude Opus 4.8 (subscription)", cliModel: "claude-opus-4-8", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
	{ id: "claude-opus-4-7", name: "Claude Opus 4.7 (subscription)", cliModel: "claude-opus-4-7", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (subscription)", cliModel: "claude-sonnet-4-6", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (subscription)", cliModel: "claude-sonnet-4-5", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (subscription)", cliModel: "claude-haiku-4-5", reasoning: false, contextWindow: 200_000, maxTokens: 32_000 },
] as const;

/** Default model ref when the operator picks the backend without naming a model. */
export const CLAUDE_CLI_DEFAULT_MODEL = "claude-sonnet-4-6";

// Sentinel credential seeded for the claude-cli provider so Pi's auth
// resolution treats a claude-cli turn as "authed" and dispatches to the
// transport instead of throwing "No API key for provider: claude-cli". It is
// NEVER a secret and NEVER goes on the wire — the spawned binary authenticates
// with its OWN stored login. Mirrors the local-Ollama sentinel-key pattern.
export const CLAUDE_CLI_SENTINEL_KEY = "claude-cli-subscription-login-no-key-required";

// Bare-family + legacy aliases → the value passed to `--model`. Only consulted
// when the requested id isn't already a known snapshot; a full id passes through
// unchanged (the CLI resolves the concrete snapshot itself).
const CLAUDE_CLI_MODEL_ALIASES: Readonly<Record<string, string>> = {
	opus: "opus",
	sonnet: "sonnet",
	haiku: "haiku",
	"claude-opus": "opus",
	"claude-sonnet": "sonnet",
	"claude-haiku": "haiku",
};

/** Drop a leading `claude-cli/` provider prefix from a model id. */
export function stripClaudeCliPrefix(modelId: string): string {
	const trimmed = (modelId ?? "").trim();
	return trimmed.startsWith(`${CLAUDE_CLI_PROVIDER}/`)
		? trimmed.slice(CLAUDE_CLI_PROVIDER.length + 1)
		: trimmed;
}

/**
 * Resolve the `--model` value for a requested Brigade model id. A catalogued
 * snapshot or any full `claude-*` id is sent verbatim; a bare family
 * ("opus"/"sonnet"/"haiku") maps through the alias table; anything else falls
 * back to the default so a turn never spawns with an empty `--model`.
 */
export function resolveCliModelArg(modelId: string): string {
	const id = stripClaudeCliPrefix(modelId).toLowerCase();
	if (!id) return CLAUDE_CLI_DEFAULT_MODEL;
	const known = CLAUDE_CLI_MODELS.find((m) => m.id.toLowerCase() === id);
	if (known) return known.cliModel;
	if (CLAUDE_CLI_MODEL_ALIASES[id]) return CLAUDE_CLI_MODEL_ALIASES[id]!;
	// A full snapshot id we don't catalogue (a newer release) — trust the CLI.
	if (id.startsWith("claude-")) return stripClaudeCliPrefix(modelId).trim();
	return CLAUDE_CLI_DEFAULT_MODEL;
}

/* ─────────────────────────── env scrubbing ─────────────────────────── */

// Env vars that must be REMOVED before spawning `claude`. Claude Code honours
// provider-routing / auth / config-root env BEFORE consulting its own stored
// login, so an inherited shell override could steer the managed run to a
// different provider, endpoint, token, config tree, or telemetry mode — and,
// worst of all, into a metered tier. We pass NO token: the binary uses its own
// login. Ported from the reference backend's clear list (brand tokens scrubbed).
export const CLAUDE_CLI_CLEAR_ENV: readonly string[] = [
	// Token / credential redirects — force a different identity than the login.
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_API_KEY_OLD",
	"ANTHROPIC_API_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
	"CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
	"CLAUDE_CODE_OAUTH_SCOPES",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
	// Endpoint / provider routing — send traffic off the subscription.
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_UNIX_SOCKET",
	"CLAUDE_CODE_REMOTE",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_VERTEX",
	// Config / plugin tree — load a foreign config root or plugin cache.
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_PLUGIN_CACHE_DIR",
	"CLAUDE_CODE_PLUGIN_SEED_DIR",
	"CLAUDE_CODE_USE_COWORK_PLUGINS",
	"CLAUDE_CONFIG_DIR",
	// Telemetry / OTEL bootstrap — alter/exfiltrate telemetry mode.
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_HEADERS",
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_LOGS_HEADERS",
	"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_METRICS_HEADERS",
	"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_HEADERS",
	"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
	"OTEL_LOGS_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_SDK_DISABLED",
	"OTEL_TRACES_EXPORTER",
];

// Marker that must NEVER be set on the child — unlike the clear list it can't be
// preserved by any escape hatch. It routes the run into Anthropic's separate
// host-managed usage tier instead of normal CLI subscription behaviour (i.e. it
// is one path to the very "extra usage" billing we're avoiding).
export const CLAUDE_CLI_FORBIDDEN_ENV = "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST";

/**
 * Build the scrubbed environment for the child `claude` process from a base
 * env (usually `process.env`). Deletes every clear-list var + the forbidden
 * host-managed marker. Pure: returns a new object, never mutates the input.
 *
 * `configDir` (optional) is Brigade's OWN managed Claude config dir — when
 * Brigade minted its own subscription grant, we point `CLAUDE_CONFIG_DIR` at it
 * so the binary authenticates + refreshes from Brigade's dedicated login
 * instead of the operator's personal `~/.claude` (no split-brain). The scrub
 * still runs first (an INHERITED CLAUDE_CONFIG_DIR is removed), then Brigade's
 * own value is set deliberately — the two never conflict.
 */
export function buildClaudeCliEnv(
	baseEnv: NodeJS.ProcessEnv = process.env,
	opts: { configDir?: string } = {},
): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...baseEnv };
	for (const key of CLAUDE_CLI_CLEAR_ENV) delete next[key];
	delete next[CLAUDE_CLI_FORBIDDEN_ENV];
	if (opts.configDir && opts.configDir.trim().length > 0) {
		next.CLAUDE_CONFIG_DIR = opts.configDir;
	}
	return next;
}

/* ─────────────────────────── argv construction ─────────────────────────── */

// Base flags for every fresh (non-resume) turn. `-p` = headless print mode;
// stream-json + partial messages give us token-level deltas; `--verbose` is
// required for stream-json to emit the per-event frames; `--setting-sources
// user` keeps the run on the user's own login/config and off any project
// `.claude` tree; `bypassPermissions` stops the CLI blocking on an approval
// prompt we can't answer headlessly.
const CLAUDE_CLI_BASE_ARGS: readonly string[] = [
	"-p",
	"--output-format",
	"stream-json",
	"--include-partial-messages",
	"--verbose",
	"--setting-sources",
	"user",
	"--permission-mode",
	"bypassPermissions",
];

// Mutating + network tools we deny as defense-in-depth. `bypassPermissions`
// (kept so the CLI never blocks on an unanswerable approval prompt) overrides
// the allow/deny lists for read-only tools, so a deny list can't make the CLI
// perfectly tool-free — but it still keeps the strongest footguns (shell,
// file writes, edits, network) off the table. The real containment is the
// isolated empty spawn cwd (see spawn.ts): any tool the CLI does reach acts on
// a throwaway directory, so a conversational turn stays harmless. The system-
// prompt nudge (appended below) asks it to just answer.
const CLAUDE_CLI_DENY_TOOLS = "Bash Edit Write MultiEdit NotebookEdit WebFetch WebSearch";

// Appended to Brigade's system prompt for claude-cli turns: this backend is a
// conversational voice, not an autonomous coder in the (throwaway) spawn cwd.
const CLAUDE_CLI_SYSTEM_SUFFIX =
	"You are answering as part of an ongoing conversation. Respond directly in prose; " +
	"do not use tools or act on the local filesystem — everything you need is in this conversation.";

// Appended INSTEAD of the prose nudge when the pinned system prompt is a machine
// JSON-output contract (the memory/skill utility subagents: extraction,
// consolidation, relink, behaviour/skill review). The chat-assistant base prompt
// baked into the `claude` binary biases toward prose + code fences; for a
// distiller that must return a bare `{"facts":[…]}` envelope, that prose bias is
// exactly what breaks parsing — the reply comes back un-parseable, the extraction
// cursor HOLDS forever, and the memory graph never fills. So we drop the prose
// nudge and hard-pin JSON-only output for these turns.
const CLAUDE_CLI_STRUCTURED_SUFFIX =
	"Output ONLY the JSON described above. No preamble, no explanation, no markdown code " +
	"fences — your entire response must be the raw JSON value, starting with { and ending with }.";

// Appended instead of the plain conversational nudge when the spawn carries the
// Brigade MCP tool-plane (owner chat turns — see tool-plane.ts). The plain
// suffix says "do not use tools", which would fight the memory tools we just
// handed the binary; this variant scopes the permission to exactly those.
const CLAUDE_CLI_TOOL_PLANE_SUFFIX =
	"You are answering as part of an ongoing conversation. You have Brigade memory tools " +
	"available via MCP (mcp__brigade__memory_add, mcp__brigade__memory_search, " +
	"mcp__brigade__memory_context) — use them to save or recall durable facts when relevant. " +
	"Do not use any other tools or act on the local filesystem; respond directly in prose.";

// Appended when the GATEWAY tool-plane is attached: Brigade's whole guarded tool
// surface is served over MCP as `mcp__brigade__<tool>`. The memory-only suffix
// above must NOT be reused here — it forbids "any other tools", which would tell
// the model to ignore the 31 tools we just handed it (and it obeys: it answers in
// prose and apologises that it cannot act).
//
// The binary's OWN built-ins stay denied — they would act on the throwaway temp
// cwd rather than the operator's workspace, and they bypass Brigade's guards
// entirely. The plane instead serves Brigade's GUARDED equivalents (see
// mcp/builtin-tools.ts): `mcp__brigade__bash` runs through the exec-gate (which
// may pause for the operator's approval) and `mcp__brigade__write` through the
// path-write guard. So the model is told it HAS a filesystem + shell, and told
// that a pause is expected rather than a failure.
const CLAUDE_CLI_FULL_PLANE_SUFFIX =
	"You are answering as part of an ongoing conversation. Brigade's tools are available to you " +
	"over MCP, named `mcp__brigade__<tool>` — including read, write, edit, bash, grep and ls on the " +
	"operator's real workspace, plus memory, sub-agents, channels, cron and media generation. Call " +
	"them whenever they help; do not describe what you would do instead of doing it. Your own " +
	"built-in tools are disabled — always use the `mcp__brigade__` ones. Some commands (via bash) " +
	"may pause for the operator's approval before they run; that is expected, so wait for the " +
	"result rather than assuming it failed.";

/** Flag delivering the MCP server config file (the Brigade tool-plane). */
export const CLAUDE_CLI_MCP_CONFIG_FLAG = "--mcp-config";
/** Companion flag: ONLY the servers from --mcp-config load — the operator's
 *  personal MCP servers (from their own claude config) never leak into a
 *  Brigade turn, and the tool surface stays deterministic. */
export const CLAUDE_CLI_STRICT_MCP_FLAG = "--strict-mcp-config";

/**
 * True when `systemPrompt` is one of Brigade's structured-JSON utility prompts.
 * Keyed on the "STRICT JSON only" contract every distiller states and that no
 * chat persona carries. Regression-guarded by a test asserting the real
 * EXTRACTION_PROMPT / CONSOLIDATION_PROMPT still trip it.
 */
export function isStructuredJsonPrompt(systemPrompt: string | undefined): boolean {
	return typeof systemPrompt === "string" && /\bSTRICT JSON only\b/i.test(systemPrompt);
}

export interface BuildArgsInput {
	/** Requested Brigade model id (with or without the `claude-cli/` prefix). */
	modelId: string;
	/** System prompt to append (Brigade's assembled persona). Omitted when blank. */
	systemPrompt?: string;
	/**
	 * Deny the mutating/network built-in tools + append the conversational
	 * system-prompt nudge. Default true — the backend is chat-first. Set false
	 * only for a future agentic mode that intentionally lets the CLI act.
	 */
	conversational?: boolean;
	/**
	 * This turn is a structured-JSON distiller. Defaults to detection from
	 * `systemPrompt`. Tool-less like a conversational turn, but reinforced toward
	 * a raw JSON envelope instead of prose.
	 */
	structured?: boolean;
}

/**
 * Compose the full system-prompt TEXT for a turn (Brigade's assembled persona +
 * the conversational nudge). Returned as a string so the caller can deliver it
 * via a FILE (`--append-system-prompt-file`) — Brigade's system prompt is tens
 * of KB (persona + skills + tools + memory), which blows the OS command-line
 * length limit if passed as an argv string (Windows `spawn ENAMETOOLONG`).
 * Returns "" when there's nothing to append.
 */
export function composeClaudeCliSystemPrompt(input: {
	systemPrompt?: string;
	conversational?: boolean;
	/** Force structured mode; defaults to detection from `systemPrompt`. */
	structured?: boolean;
	/** The spawn carries the memory-only MCP tool-plane (owner chat turns). */
	toolPlane?: boolean;
	/** The spawn carries the gateway-hosted FULL guarded tool surface. */
	fullPlane?: boolean;
}): string {
	const structured = input.structured ?? isStructuredJsonPrompt(input.systemPrompt);
	const conversational = input.conversational !== false;
	// Precedence: STRUCTURED (a JSON distiller must be reinforced toward JSON,
	// never nudged toward prose — and never given tools) > FULL PLANE (every
	// Brigade tool, use them) > memory-only TOOL-PLANE > plain conversational.
	const suffix = structured
		? CLAUDE_CLI_STRUCTURED_SUFFIX
		: input.fullPlane === true
			? CLAUDE_CLI_FULL_PLANE_SUFFIX
			: input.toolPlane === true
				? CLAUDE_CLI_TOOL_PLANE_SUFFIX
				: conversational
					? CLAUDE_CLI_SYSTEM_SUFFIX
					: "";
	const parts = [input.systemPrompt?.trim(), suffix].filter(
		(p): p is string => !!p && p.length > 0,
	);
	return parts.join("\n\n");
}

/**
 * Assemble the argv (excluding the leading command) for a fresh turn.
 * Order: base flags → `--model <m>` → tool policy. The system prompt is NOT put
 * on argv — it's delivered by the spawner via `--append-system-prompt-file`
 * (see spawn.ts) to avoid the OS command-line length limit — and the user
 * prompt is delivered on STDIN. So argv stays tiny + constant.
 */
export function buildClaudeCliArgs(input: BuildArgsInput): string[] {
	const args = [...CLAUDE_CLI_BASE_ARGS];
	args.push("--model", resolveCliModelArg(input.modelId));
	const structured = input.structured ?? isStructuredJsonPrompt(input.systemPrompt);
	const conversational = input.conversational !== false;
	// A distiller is tool-less too — it must emit JSON, never touch the fs.
	if (conversational || structured) args.push("--disallowedTools", CLAUDE_CLI_DENY_TOOLS);
	return args;
}

/** The flag the spawner uses to deliver the composed system prompt from a file. */
export const CLAUDE_CLI_SYSTEM_PROMPT_FILE_FLAG = "--append-system-prompt-file";
