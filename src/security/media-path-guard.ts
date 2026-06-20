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
]);

/** Path fragments that mark a credentials directory (platform-normalized separators). */
const SENSITIVE_DIR_NAMES = [".ssh", ".aws", ".gnupg", ".kube", ".docker", "gcloud"];

/** Resolved-prefix roots that are off-limits regardless of filename. */
function systemRoots(): string[] {
	if (process.platform === "win32") {
		const roots: string[] = [];
		if (process.env.SystemRoot) roots.push(process.env.SystemRoot);
		else roots.push("C:\\Windows");
		return roots;
	}
	return ["/etc", "/proc", "/sys", "/dev", "/boot", "/root"];
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
	// auth* file under a .brigade dir — denied regardless of basename.
	if (/[\\/]agents[\\/][^\\/]+[\\/]agent[\\/]/.test(resolved) || /[\\/]\.brigade[\\/].*auth/i.test(resolved)) {
		return { ok: false, reason: "refusing to attach from the credential store" };
	}
	return { ok: true };
}
