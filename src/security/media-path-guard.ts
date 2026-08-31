/**
 * Outbound media-path guard — refuse to ATTACH a local file that is a secret or
 * a system file. A channel `sendMedia` takes a local path and uploads its bytes
 * to the conversation; without this guard a prompt-injected "send the file at
 * ~/.ssh/id_rsa" (or Brigade's own `~/.brigade/brigade.json` / sealed auth) would
 * exfiltrate credentials to whoever the agent is talking to. This is the
 * CONTENT-exfil sibling of the SSRF fetch guard (which protects inbound URLs).
 *
 * Posture = denylist, always-on, low false-positive: remote URLs and data URIs
 * pass (they aren't local-file reads; outbound fetch SSRF is handled elsewhere);
 * legitimate generated media under temp/cache/workspace passes; only known
 * secret/system targets are refused. Symlinks are resolved first so an
 * innocent-looking name can't smuggle a denied target.
 */

import fs from "node:fs";
import path from "node:path";

export interface MediaPathVerdict {
	ok: boolean;
	/** Non-sensitive reason (safe to surface to the agent / log — no full path leak). */
	reason?: string;
}

/** Basenames that are never legitimate as an outbound attachment (matched case-insensitively). */
const SENSITIVE_BASENAMES = new Set([
	".env",
	".netrc",
	".pgpass",
	".npmrc",
	".git-credentials",
	"credentials",
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"id_dsa",
	// Brigade's own secret/config store
	"brigade.json",
	"auth.json",
	"auth-profiles.json",
	"models.json",
	"exec-approvals.json",
	// Brigade encryption key (stored outside ~/.brigade by design)
	"encryption.key",
	// Convex local backend admin key
	"admin-key.txt",
]);

/** Path fragments that mark a credentials directory (platform-normalized separators). */
const SENSITIVE_DIR_NAMES = [".ssh", ".aws", ".gnupg", ".kube", ".docker", "gcloud", ".convex-data"];

let cachedSystemRoots: string[] | undefined;

/**
 * Resolved-prefix roots that are off-limits regardless of filename.
 *
 * Both spellings of each root are returned, because the caller compares against
 * a `realpathSync`'d path and some platforms symlink their own system dirs:
 * on macOS `/etc` IS a symlink to `/private/etc`, so `/etc/passwd` resolves to
 * `/private/etc/passwd` and never matches the literal `/etc` prefix. The
 * symlink resolution that stops a `photo.jpg -> /etc/shadow` trick is exactly
 * what defeated this check.
 */
function systemRoots(): string[] {
	if (cachedSystemRoots) return cachedSystemRoots;
	let roots: string[];
	if (process.platform === "win32") {
		roots = [process.env.SystemRoot || "C:\\Windows"];
	} else {
		roots = ["/etc", "/proc", "/sys", "/dev", "/boot", "/root"];
	}
	const all = new Set(roots);
	for (const r of roots) {
		try {
			all.add(fs.realpathSync(r));
		} catch {
			/* root absent on this platform — the literal spelling still stands */
		}
	}
	cachedSystemRoots = [...all];
	return cachedSystemRoots;
}

/** Test seam: the root set is process-lifetime cached. */
export function __resetSystemRootsCacheForTests(): void {
	cachedSystemRoots = undefined;
}

/**
 * Decide whether `rawPath` is safe to upload as an outbound attachment.
 * Never throws — returns a verdict the caller surfaces/throws.
 */
export function validateOutboundMediaPath(rawPath: string): MediaPathVerdict {
	if (!rawPath || typeof rawPath !== "string") return { ok: false, reason: "empty media path" };
	// Remote URLs / data URIs are not local-file reads — allow (SSRF on the fetch
	// is a separate concern of the fetch guard); this guard targets local exfil.
	if (/^(https?:|data:)/i.test(rawPath)) return { ok: true };

	// Resolve to an absolute, symlink-free path so a symlink named photo.jpg that
	// points at /etc/shadow can't slip through. If the file doesn't exist yet,
	// check the intended absolute path (the upload would fail anyway, but we still
	// refuse a sensitive target).
	let resolved: string;
	try {
		resolved = fs.realpathSync(path.resolve(rawPath));
	} catch {
		resolved = path.resolve(rawPath);
	}
	const lower = resolved.toLowerCase();
	const base = path.basename(resolved).toLowerCase();

	// Match the dotenv family by prefix (.env, .env.local, .env.production, …)
	// rather than enumerating every suffix — those suffixed files are the standard
	// secret stores and are not legitimate media attachments.
	if (base === ".env" || base.startsWith(".env.") || SENSITIVE_BASENAMES.has(base)) {
		return { ok: false, reason: `refusing to attach a sensitive file (${base})` };
	}
	const segments = lower.split(/[\\/]+/);
	for (const dir of SENSITIVE_DIR_NAMES) {
		if (segments.includes(dir)) return { ok: false, reason: "refusing to attach from a credentials directory" };
	}
	for (const root of systemRoots()) {
		const r = root.toLowerCase();
		if (lower === r || lower.startsWith(r + path.sep)) {
			return { ok: false, reason: "refusing to attach a system file" };
		}
	}
	// Brigade's sealed per-agent auth subtree (…/agents/<id>/agent/…) and any
	// `auth` path component under a .brigade dir — denied regardless of basename.
	// Walk the already-split segments (linear, no regex backtracking).
	const sealedPerAgent = segments.some(
		(seg, i) => seg === "agents" && i + 2 < segments.length && segments[i + 2] === "agent" && Boolean(segments[i + 1]),
	);
	const brigadeIdx = segments.indexOf(".brigade");
	const authUnderBrigade = brigadeIdx >= 0 && segments.slice(brigadeIdx + 1).some((seg) => seg.includes("auth"));
	if (sealedPerAgent || authUnderBrigade) {
		return { ok: false, reason: "refusing to attach from the credential store" };
	}
	return { ok: true };
}

/* ─────────────────────── allowed-root spelling ─────────────────────── */

/**
 * Every spelling of `p` that must be treated as the same allowed root.
 *
 * Containment checks resolve the CANDIDATE with `fs.realpathSync` so a
 * symlinked parent cannot redirect a write outside the allowed roots. That
 * makes the comparison asymmetric unless the ROOTS are realpathed too: on macOS
 * `os.tmpdir()` is `/var/folders/…`, a symlink to `/private/var/folders/…`, so
 * a realpathed candidate under the temp dir was compared against the `/var/…`
 * spelling and never matched. Every document-tool write into a temp dir was
 * refused as "outside the allowed roots". Linux `/tmp` is not symlinked, so CI
 * stayed green while every macOS checkout saw the failure.
 *
 * Returns the resolved spelling always, plus the realpathed spelling when the
 * path exists and differs. Keeping BOTH is safe and is not a widening: the
 * candidate side is always realpathed first, so on a symlinked system the
 * non-physical spelling simply never matches. It is retained only so a caller
 * that compares WITHOUT realpathing keeps its existing behaviour.
 */
export function rootSpellings(p: string): string[] {
	if (!p) return [];
	let resolved: string;
	try {
		resolved = path.resolve(p);
	} catch {
		return [];
	}
	const out = [resolved];
	try {
		const real = fs.realpathSync(resolved);
		if (real && real !== resolved) out.push(real);
	} catch {
		// Root does not exist yet (a state subtree created on first use). The
		// resolved spelling still stands on its own.
	}
	return out;
}
