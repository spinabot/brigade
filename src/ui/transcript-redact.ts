/**
 * Redaction for anything that leaves the machine.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS BEFORE THE EXPORTER DOES
 * ─────────────────────────────────────────────────────────────────────────
 * An exported transcript is a file a person sends to another person — attached
 * to a bug report, pasted into a ticket, dropped in a chat. It is built from
 * TOOL OUTPUT: `env`, a `.env` file someone read, a curl with an
 * `Authorization` header, a stack trace with a connection string in it. None of
 * that looked dangerous while it sat in a terminal on one machine.
 *
 * So redaction is not a feature of the export; it is a precondition for having
 * one. It runs on every path out — file, clipboard, anywhere.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS AND IS NOT
 * ─────────────────────────────────────────────────────────────────────────
 * These are pattern matchers. They will catch the shapes that leak most often
 * and they will miss a secret that looks like ordinary prose. That limitation
 * is stated in the export's own header rather than hidden, because a redactor
 * people over-trust is worse than one they check behind.
 *
 * Every rule keeps a recognisable PREFIX where it can (`sk-…`, `ghp_…`). A
 * reader debugging "which key did it use" needs to tell two keys apart; a
 * uniform `[REDACTED]` makes the export less useful without making it safer.
 */

/** One redaction rule: a pattern, and what replaces the sensitive part. */
interface RedactionRule {
	readonly name: string;
	readonly pattern: RegExp;
	readonly replace: (match: string, ...groups: string[]) => string;
}

/** Keep a short recognisable head so two different keys stay distinguishable. */
function maskTail(prefix: string, secret: string): string {
	return `${prefix}${secret.slice(0, 4)}…[redacted ${secret.length} chars]`;
}

const RULES: readonly RedactionRule[] = [
	{
		// PEM private keys. Whole block, because a partial key is still a key.
		name: "private-key",
		pattern:
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replace: () => "[redacted private key block]",
	},
	{
		// `Authorization: Bearer …`, and the same header spelled in JSON.
		name: "authorization-header",
		pattern: /((?:Authorization|X-Api-Key|api[-_]?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/-]{12,})/gi,
		replace: (_m, head: string, secret: string) => `${head}[redacted]` + (secret ? "" : ""),
	},
	{
		// Provider key shapes with a stable prefix. Anthropic, OpenAI, GitHub,
		// Slack, Google, Stripe.
		name: "prefixed-token",
		pattern:
			/\b(sk-ant-|sk-proj-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xoxb-|xoxp-|xapp-|AIza|rk_live_|sk_live_|pk_live_)([A-Za-z0-9_-]{12,})/g,
		replace: (_m, prefix: string, rest: string) => maskTail(prefix, rest),
	},
	{
		// AWS access key ids are a fixed, unmistakable shape.
		name: "aws-access-key-id",
		pattern: /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
		replace: (_m, key: string) => `${key.slice(0, 8)}…[redacted]`,
	},
	{
		// `SOMETHING_SECRET=value` / `SOMETHING_TOKEN: value` — the `env` dump case.
		name: "secret-env-assignment",
		// The leading `[A-Z0-9_]*` is OPTIONAL on purpose: a bare `PASSWORD=` is
		// one of the most common shapes there is, and requiring a prefix meant
		// only `DB_PASSWORD=` matched.
		pattern:
			/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"']{4,})\3/g,
		replace: (_m, key: string, sep: string, quote: string) =>
			`${key}${sep}${quote}[redacted]${quote}`,
	},
	{
		// Connection strings carry the password in the authority section.
		name: "url-credentials",
		pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@]+)@/gi,
		replace: (_m, scheme: string, user: string) => `${scheme}${user}:[redacted]@`,
	},
	{
		// JWTs. Three base64url segments; the payload is often personal data.
		name: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
		replace: () => "[redacted jwt]",
	},
];

export interface RedactionResult {
	text: string;
	/** Rule name → how many times it fired. Reported so the operator can check. */
	counts: Record<string, number>;
	/** Total redactions across all rules. */
	total: number;
}

/**
 * Redact secrets, and optionally replace the home directory with `~`.
 *
 * The home-path rewrite is not about secrets — it is about not publishing a
 * username to everyone who reads the export.
 */
export function redactForExport(
	text: string,
	opts: { homeDir?: string } = {},
): RedactionResult {
	const counts: Record<string, number> = {};
	let out = text;

	for (const rule of RULES) {
		let hits = 0;
		out = out.replace(rule.pattern, (...args: unknown[]) => {
			hits += 1;
			const match = args[0] as string;
			const groups = args.slice(1, -2) as string[];
			return rule.replace(match, ...groups);
		});
		if (hits > 0) counts[rule.name] = hits;
	}

	// Home path last, so it also rewrites paths inside text an earlier rule
	// left in place. Longest-first is irrelevant here (one path), but the
	// replacement is literal to avoid `$&` in a home dir being interpreted.
	const home = opts.homeDir?.trim();
	if (home && home.length > 1) {
		// COUNT BEFORE REPLACING, and count on the text actually being searched.
		//
		// This used to infer the hit count from `text.length - out.length > 0` —
		// comparing the ORIGINAL input against the fully-redacted output. Any
		// earlier rule that LENGTHENS the text (`maskTail` appends
		// "…[redacted N chars]") makes that difference negative, so genuine
		// home-path hits were silently dropped from `counts` and `total`, and the
		// operator-facing "redacted N secrets" line under-reported.
		const hits = out.split(home).length - 1;
		if (hits > 0) {
			out = out.split(home).join("~");
			counts["home-path"] = hits;
		}
	}

	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	return { text: out, counts, total };
}

/** One-line summary of what was redacted, for the export header and the TUI. */
export function describeRedactions(counts: Record<string, number>): string {
	const parts = Object.entries(counts)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, n]) => `${name}×${n}`);
	return parts.length > 0 ? parts.join(", ") : "none matched";
}
