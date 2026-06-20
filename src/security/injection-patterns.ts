/**
 * Injection / exfiltration / C2 threat-pattern scanner — the CONTENT-safety layer
 * for untrusted text that reaches the model (stored memory, recalled facts,
 * project-context files). Orthogonal to the memory write-gate's PROVENANCE layer:
 * the gate stops an untrusted SOURCE from authoring the self-model; this catches
 * an attack PAYLOAD riding a permitted (knowledge) write OR owner-pasted text the
 * gate can't see by provenance alone. Both layers run; neither replaces the other.
 *
 * Three widening scopes — all ⊆ context ⊆ strict:
 *   all     — classic prompt injection + obvious exfil (scan everywhere).
 *   context — + role-play/identity hijack + C2/promptware (project-context files).
 *   strict  — + send-to-URL exfil + persistence + secrets (stored MEMORY uses this).
 *
 * Patterns anchor on attack-SPECIFIC vocabulary (override phrases, C2 verbs, exfil
 * targets) — NOT generic "bossy English" — and tolerate filler words between key
 * tokens (`(?:\w+\s+)*`) so "ignore all PRIOR instructions" can't slip past a
 * naive "ignore instructions" match. Deterministic + pure (no I/O, no clock).
 */

export type ThreatScope = "all" | "context" | "strict";

interface ThreatPattern {
	readonly re: RegExp;
	readonly id: string;
	readonly scope: ThreatScope;
}

const PATTERNS: readonly ThreatPattern[] = [
	// ── classic prompt injection (scope: all) ──
	{ re: /ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+(?:\w+\s+)*instructions/i, id: "ignore_instructions", scope: "all" },
	{ re: /system\s+prompt\s+override/i, id: "system_prompt_override", scope: "all" },
	{ re: /disregard\s+(?:\w+\s+)*(?:instructions|rules|guidelines|safety)/i, id: "disregard_rules", scope: "all" },
	{ re: /act\s+as\s+if\s+(?:\w+\s+)*no\s+(?:restrictions|rules|limits)/i, id: "no_restrictions", scope: "all" },
	{ re: /<!--[^>]*(?:ignore|override|system\s+prompt|secret|hidden\s+instruction)[^>]*-->/i, id: "html_comment_injection", scope: "all" },
	{ re: /translate\s+(?:\w+\s+)*and\s+(?:execute|run|eval)/i, id: "translate_and_execute", scope: "all" },
	{ re: /do\s+not\s+(?:tell|inform|mention\s+to)\s+the\s+user/i, id: "do_not_tell_user", scope: "all" },
	// ── role-play / identity hijack (scope: context) ──
	{ re: /you\s+are\s+(?:\w+\s+)*now\s+(?:a|an|the)\b/i, id: "you_are_now", scope: "context" },
	{ re: /pretend\s+(?:you\s+are|to\s+be)/i, id: "pretend", scope: "context" },
	{ re: /(?:output|reveal|print|repeat)\s+(?:\w+\s+)*(?:system|initial|original)\s+prompt/i, id: "reveal_system_prompt", scope: "context" },
	{ re: /(?:respond|answer|reply)\s+without\s+(?:\w+\s+)*(?:restrictions|filters|safety)/i, id: "respond_without_safety", scope: "context" },
	{ re: /you\s+have\s+been\s+(?:updated|upgraded|patched|reprogrammed)\s+to/i, id: "you_have_been_updated", scope: "context" },
	// ── C2 / promptware (scope: context) ──
	{ re: /register\s+as\s+a\s+node/i, id: "c2_register_node", scope: "context" },
	{ re: /(?:heartbeat|beacon|check-?in)\s+(?:to|with)\b/i, id: "c2_beacon", scope: "context" },
	{ re: /\bpull\s+(?:\w+\s+)*task(?:ing|s)?\b/i, id: "c2_pull_tasks", scope: "context" },
	{ re: /you\s+must\s+(?:\w+\s+)*(?:register|connect|report|beacon)\b/i, id: "c2_must_connect", scope: "context" },
	{ re: /\b(?:cobalt\s+strike|sliver|havoc|mythic|metasploit)\b/i, id: "c2_framework", scope: "context" },
	{ re: /\bcommand\s+and\s+control\b|\bc2\s+(?:server|channel|node)\b/i, id: "command_and_control", scope: "context" },
	{ re: /\bunset\s+(?:\w+\s+)*(?:BRIGADE|CLAUDE|ANTHROPIC|OPENAI|AGENT)[A-Z_]*/, id: "anti_forensic_unset", scope: "context" },
	{ re: /\bname\s+yourself\s+\w+/i, id: "identity_override", scope: "context" },
	{ re: /never\s+(?:\w+\s+)*(?:create|write)\s+(?:\w+\s+)*(?:script|file)\s+(?:\w+\s+)*disk/i, id: "anti_forensic_disk", scope: "context" },
	{ re: /only\s+use\s+one[\s-]?liners?\b/i, id: "anti_forensic_oneliner", scope: "context" },
	{ re: /connect\s+to\s+the\s+network\b/i, id: "c2_network_connect", scope: "context" },
	// ── exfiltration ──
	{ re: /(?:curl|wget)\b[^\n]*\$?[A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD)/i, id: "exfil_curl_secret", scope: "all" },
	{ re: /\bcat\b[^\n]*(?:\.env\b|credentials\b|\.netrc\b|\.pgpass\b|\.npmrc\b|\.pypirc\b)/i, id: "exfil_cat_secrets", scope: "all" },
	{ re: /(?:send|post|upload|transmit|exfiltrate)\s+(?:\w+\s+)*to\s+https?:\/\//i, id: "exfil_send_url", scope: "strict" },
	{ re: /(?:include|output|print|share|leak|send|reveal|forward)\s+(?:\w+\s+)*(?:the\s+)?(?:conversation|chat\s+history|full\s+context)/i, id: "exfil_history", scope: "strict" },
	// ── persistence (scope: strict) ──
	{ re: /authorized_keys|~?\/?\.ssh\b|\.brigade\/\.env/i, id: "persistence_ssh", scope: "strict" },
	{ re: /(?:update|modify|append\s+to|overwrite|write\s+to|edit|change|add\s+to)\s+(?:\w+\s+)*(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules|SOUL\.md)/i, id: "persistence_context_file", scope: "strict" },
	// ── hardcoded secret (scope: strict) ──
	{ re: /(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["'](?:[^"']{20,}["']|[^"'\s]{20,})/i, id: "hardcoded_secret", scope: "strict" },
];

/** Zero-width / BOM / bidi codepoints (a hidden-payload vector). */
const INVISIBLE_CODEPOINTS = /[​-‍⁠⁢-⁤﻿‪-‮⁦-⁩]/;

function patternsForScope(scope: ThreatScope): readonly ThreatPattern[] {
	if (scope === "all") return PATTERNS.filter((p) => p.scope === "all");
	if (scope === "context") return PATTERNS.filter((p) => p.scope !== "strict");
	return PATTERNS; // strict ⊇ context ⊇ all
}

/** All matched threat-pattern ids in `content` at `scope` (+ invisible-unicode). Empty = clean. */
export function scanForThreats(content: string, scope: ThreatScope = "strict"): string[] {
	if (!content) return [];
	const out: string[] = [];
	for (const p of patternsForScope(scope)) {
		if (p.re.test(content)) out.push(p.id);
	}
	if (INVISIBLE_CODEPOINTS.test(content)) out.push("invisible_unicode");
	return out;
}

/** Human-readable block reason for the FIRST threat hit, or undefined if clean. */
export function firstThreatMessage(content: string, scope: ThreatScope = "strict"): string | undefined {
	const ids = scanForThreats(content, scope);
	return ids.length > 0 ? `matched threat pattern(s): ${ids.join(", ")}` : undefined;
}

/** Thrown when a memory WRITE carries an injection/exfil/C2 payload — a CONTENT
 *  block (distinct from the provenance WriteGateError). Callers that want a clean
 *  rejection (the write_memory tool) catch it; best-effort writers (extraction,
 *  reviewers) let it no-op the write (the poisoned text never persists). */
export class MemoryThreatError extends Error {
	readonly code = "memory:threat" as const;
	readonly threats: string[];
	constructor(threats: string[]) {
		super(`memory content matched threat pattern(s): ${threats.join(", ")}`);
		this.name = "MemoryThreatError";
		this.threats = threats;
	}
}
