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
 * How long the binary's MCP client waits on one Brigade `tools/call`.
 *
 * This must exceed every budget on OUR side, because whoever times out first
 * decides — and the binary timing out first is the bad outcome: it closes the
 * socket, which aborts our handler, which tells the model the tool failed, all
 * while the operator is still reading the approval prompt that would have let it
 * succeed. Matched to the harness's absolute ceiling so Brigade's own deadlines
 * (exec-gate 5m, per-tool budgets, the route's wedge guard) are always the ones
 * that fire. An operator-set value wins.
 */
export const CLAUDE_CLI_MCP_TOOL_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h — matches the absolute ceiling
/** Handshake budget: the server is in-process, so a slow one means something is wrong. */
export const CLAUDE_CLI_MCP_STARTUP_TIMEOUT_MS = 30_000;

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
	// A Brigade tool call can legitimately block for a long time: `bash` waits on the
	// operator's exec approval (5 min), `generate_video` has a ~20 min budget. Left to
	// its default, the binary's MCP client could abandon the request first — closing
	// the socket, aborting our handler, and telling the model the tool failed WHILE the
	// operator is still reading the approval prompt. Pin both budgets above ours so
	// Brigade's own timeouts are always the ones that decide. Operator env wins.
	next.MCP_TOOL_TIMEOUT ??= String(CLAUDE_CLI_MCP_TOOL_TIMEOUT_MS);
	next.MCP_TIMEOUT ??= String(CLAUDE_CLI_MCP_STARTUP_TIMEOUT_MS);
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

/**
 * Every name the vendor's sub-agent tool answers to.
 *
 * The binary carries a legacy→canonical rename map (`{Task:"Agent",
 * KillShell:"TaskStop", BashOutputTool:"TaskOutput", …}`): the tool's canonical
 * name is `Agent` and `Task` is merely an alias it still accepts. Denying only
 * `Task` therefore bets the whole containment on the deny-matcher normalizing
 * aliases before it compares — which is undocumented, and which the very
 * existence of that map shows can change under us.
 *
 * So deny every spelling. A name the binary doesn't ship is ignored, which costs
 * nothing; a name we omit is a tool the model can still reach.
 */
const CLAUDE_CLI_SUBAGENT_TOOLS = "Agent Task TaskStop TaskOutput KillShell KillBash BashOutput BashOutputTool";

// Mutating + network tools we deny as defense-in-depth, plus the binary's own
// sub-agent (which would run unguarded, off-transcript, outside Brigade's crew).
//
// `--permission-mode bypassPermissions` is kept so the CLI never blocks on an
// approval prompt nobody can answer. Whether it also overrides the deny list for
// read-only tools is NOT settled: the binary ships deny-rule enforcement (it
// carries a "was blocked by a deny rule" message), but nothing in the package
// states the precedence, and it is compiled. Treat the deny list as best-effort.
//
// The containment we can actually prove is the isolated empty spawn cwd (see
// spawn.ts): any built-in the CLI does reach acts on a throwaway directory, so a
// conversational turn stays harmless either way. The system-prompt nudge
// (appended below) asks it to just answer.
const CLAUDE_CLI_DENY_TOOLS = `Bash Edit Write MultiEdit NotebookEdit WebFetch WebSearch ${CLAUDE_CLI_SUBAGENT_TOOLS}`;

/**
 * The deny list for a FULL-PLANE turn: every built-in that could act instead of
 * Brigade's `mcp__brigade__*`, so the plane is the model's one way to do work.
 *
 * Denying the mutating ones was never enough. The binary's READ-side tools
 * (`Read`, `Grep`, `Glob`) still worked — but they act on the isolated throwaway
 * cwd we spawn it in, NOT the operator's workspace. The model would read an empty
 * directory and conclude the file does not exist. The sub-agent tool would spin up
 * the binary's own executor instead of Brigade's `spawn_agent` (no guards, no
 * transcript, no crew). And none of them pass through the exec-gate, the
 * path-write guard, or the origin scoping.
 *
 * Brigade serves guarded equivalents (see mcp/builtin-tools.ts) bound to the turn's
 * REAL cwd, so the binary loses nothing by being denied these.
 *
 * This is NOT "every built-in the vendor ships" — the binary carries dozens, and
 * the rest are either inert without `Bash`, scoped to our own server by
 * `--strict-mcp-config`, or non-acting (plan mode, onboarding). It is every
 * built-in that can touch the filesystem, the shell, the network, or spawn an
 * unguarded agent. And per CLAUDE_CLI_DENY_TOOLS, enforcement under
 * `bypassPermissions` is unproven — the empty spawn cwd is the load-bearing
 * containment; this list is the belt.
 */
const CLAUDE_CLI_FULL_PLANE_DENY_TOOLS =
	`Bash Glob Grep Read Edit Write MultiEdit NotebookEdit WebFetch WebSearch TodoWrite ${CLAUDE_CLI_SUBAGENT_TOOLS}`;

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
	/**
	 * Pi's thinking level for this turn (`off` | `minimal` | `low` | `medium` |
	 * `high` | `xhigh`), read from `options.reasoning`.
	 *
	 * Was not passed at all, which made the operator's `/thinking` setting a
	 * no-op on this backend: the catalog advertises `reasoning: true` for every
	 * Opus/Sonnet/Fable entry, the TUI offers the levels, and nothing reached the
	 * binary — so every turn ran at the CLI's own default regardless.
	 */
	thinkingLevel?: string;
	/** System prompt to append (Brigade's assembled persona). Omitted when blank. */
	systemPrompt?: string;
	/**
	 * Deny the mutating/network built-in tools + append the conversational
	 * system-prompt nudge. Default true — the backend is chat-first. Set false
	 * only for a future agentic mode that intentionally lets the CLI act.
	 */
	conversational?: boolean;
	/**
	 * Feed stdin as `stream-json` (Anthropic content blocks) rather than plain text.
	 * Set ONLY when the turn carries an image — that is the sole thing plain text
	 * cannot express. See the comment in `buildClaudeCliArgs`.
	 */
	streamJsonInput?: boolean;
	/**
	 * This turn is a structured-JSON distiller. Defaults to detection from
	 * `systemPrompt`. Tool-less like a conversational turn, but reinforced toward
	 * a raw JSON envelope instead of prose.
	 */
	structured?: boolean;
	/**
	 * This spawn carries the gateway-hosted FULL tool-plane. The binary's own
	 * built-ins are denied wholesale so it uses Brigade's guarded equivalents,
	 * which act on the operator's real workspace rather than the throwaway cwd.
	 */
	fullPlane?: boolean;
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
/**
 * Map Pi's thinking level onto the binary's `--effort` vocabulary.
 *
 * Pi:  off | minimal | low | medium | high | xhigh
 * CLI: low | medium | high | xhigh | max        (`claude --help`, 2.1.234)
 *
 * `off` returns undefined — the caller then sends no reasoning flags at all,
 * rather than inventing a "lowest" effort the operator did not ask for. The two
 * vocabularies differ at both ends: Pi's `minimal` floors to the CLI's `low`,
 * and the CLI's `max` has no Pi equivalent so nothing maps to it. An
 * unrecognized value returns undefined rather than guessing.
 */
export function resolveClaudeCliEffort(level: string | undefined): string | undefined {
	switch ((level ?? "").trim().toLowerCase()) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		case "max":
			return "max";
		default:
			// Covers "off", "", and anything unrecognized.
			return undefined;
	}
}

export function buildClaudeCliArgs(input: BuildArgsInput): string[] {
	const args = [...CLAUDE_CLI_BASE_ARGS];
	// IMAGES. The default stdin protocol is plain text, which has nowhere to put an
	// image — which is why this backend used to flatten every attached picture to
	// the literal string "[image omitted]" and declare itself text-only. The binary
	// itself was never the limitation: with `--input-format stream-json` it accepts
	// Anthropic content blocks on stdin, image blocks included, and Opus describes
	// the picture perfectly.
	//
	// Switched on ONLY for a turn that actually carries an image, so every existing
	// text turn keeps the byte-identical plain-text stdin it has always had. Two
	// protocols is a cost, but it is a smaller cost than re-serialising every turn
	// in the product through a new path to fix a case most turns don't have.
	if (input.streamJsonInput === true) args.push("--input-format", "stream-json");
	args.push("--model", resolveCliModelArg(input.modelId));

	// REASONING. Two flags, both verified against `claude --help` on 2.1.234.
	//
	// `--effort <low|medium|high|xhigh|max>` carries the operator's chosen
	// thinking level. Without it every turn ran at the binary's default and
	// `/thinking` was decorative.
	//
	// `--settings` takes "a settings JSON file OR a JSON string", so the thinking
	// summaries can be requested PER TURN without mutating the operator's global
	// `~/.claude/settings.json`. `showThinkingSummaries` defaults to false in the
	// binary, and when false the CLI actively asks the API to redact reasoning
	// (the `redact-thinking-2026-02-12` beta — all three strings are present in
	// the 2.1.234 binary). That default is why this backend produced ZERO
	// thinking blocks across a real 591-message transcript history: the reasoning
	// was never sent, so there was nothing for any renderer to show.
	//
	// Only requested when the operator actually asked for thinking. At `off` we
	// send neither flag and the binary keeps its own behaviour.
	const effort = resolveClaudeCliEffort(input.thinkingLevel);
	if (effort) {
		args.push("--effort", effort);
		args.push("--settings", JSON.stringify({ showThinkingSummaries: true }));
	}
	const structured = input.structured ?? isStructuredJsonPrompt(input.systemPrompt);
	const conversational = input.conversational !== false;
	// A distiller is tool-less too — it must emit JSON, never touch the fs.
	// A full-plane turn denies EVERY built-in: Brigade serves guarded equivalents
	// bound to the real cwd, and the binary's own would act on the throwaway one.
	if (!structured && input.fullPlane === true) {
		args.push("--disallowedTools", CLAUDE_CLI_FULL_PLANE_DENY_TOOLS);
	} else if (conversational || structured) {
		args.push("--disallowedTools", CLAUDE_CLI_DENY_TOOLS);
	}
	return args;
}

/** The flag the spawner uses to deliver the composed system prompt from a file. */
export const CLAUDE_CLI_SYSTEM_PROMPT_FILE_FLAG = "--append-system-prompt-file";
