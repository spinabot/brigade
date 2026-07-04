/**
 * Sensitive-text redactor for transcript fetches + audit logs.
 *
 * Used by `sessions_history` before returning transcript chunks to a
 * cross-session caller, and by any log line that could carry a token /
 * key / phone number. The redaction is opportunistic — false negatives
 * are acceptable (caller must still consider the visibility policy),
 * but false positives must be RARE so the model still gets useful
 * context.
 *
 * Patterns redacted (case-insensitive where relevant):
 *
 *   - Bearer / token / api key / secret prefixes followed by ≥16 alnum/=+/
 *     characters → `<redacted:bearer-token>` etc.
 *   - AWS access keys (`AKIA…`, `ASIA…`) → `<redacted:aws-key>`
 *   - GitHub PATs (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` + 36 alnum) →
 *     `<redacted:github-token>`
 *   - OpenAI / Anthropic / Google AI keys (`sk-…`, `sk-ant-…`, `AIza…`) , 
 *     AQ.…) → <redacted:provider-key>. Google issues both the legacy 
 *     AIza… and the newer AQ.… prefixes for Gemini / AI Studio keys; 
 *     both shapes must be caught so a fresh key doesn't leak into logs. 
 *   - Phone numbers in `+CCNNNNNNNNNN` form (≥10 digits after `+`) →
 *     `<redacted:phone>`
 *   - Email addresses → `<redacted:email>`
 *
 * Returns the input unchanged when no patterns matched (zero allocation
 * for the common clean-text case).
 */

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
	{ re: /\b(?:Bearer\s+)[A-Za-z0-9._\-+/=]{16,}/gi, replacement: "<redacted:bearer-token>" },
	{ re: /\b(?:api[_-]?key|secret|token)["'\s:=]+[A-Za-z0-9._\-+/=]{16,}/gi, replacement: "<redacted:secret>" },
	{ re: /\b(?:A[KS]IA[0-9A-Z]{16})\b/g, replacement: "<redacted:aws-key>" },
	{ re: /\bgh[opusr]_[A-Za-z0-9]{36}\b/g, replacement: "<redacted:github-token>" },
	{ re: /\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}\b/g, replacement: "<redacted:provider-key>" },
	{ re: /\bAIza[A-Za-z0-9_\-]{35}\b/g, replacement: "<redacted:provider-key>" },
	{ re: /\bAQ\.[A-Za-z0-9_\-]{30,}\b/g, replacement: "<redacted:provider-key>" },
	{ re: /\+\d{10,15}\b/g, replacement: "<redacted:phone>" },
	{ re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, replacement: "<redacted:email>" },
];

export function redactSensitiveText(input: string): string {
	if (!input) return input;
	let out = input;
	let touched = false;
	for (const { re, replacement } of PATTERNS) {
		const next = out.replace(re, replacement);
		if (next !== out) {
			touched = true;
			out = next;
		}
	}
	return touched ? out : input;
}
