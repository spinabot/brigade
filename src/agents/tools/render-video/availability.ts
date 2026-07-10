// Availability + doctor for the `render_video` tool, which drives the
// `@hyperframes/producer` render pipeline (HTML → deterministic MP4) in an
// isolated worker. The pipeline spins a headless Chrome + FFmpeg, so "can we
// render?" is a multi-part question:
//   1. Node 22+          (producer requirement; Brigade already requires it)
//   2. FFmpeg on PATH    (the encoder — NOT a Brigade dependency, so detected)
//   3. a headless Chrome (puppeteer auto-downloads one; soft signal only)
// plus the `@hyperframes/producer` package itself (an OPTIONAL dependency —
// install it to enable video). The doctor folds these into ONE payload the
// gateway/TUI/`brigade` CLI can render, in the same shape as the other
// capability-status payloads. A pure PATH scan (no subprocess), cached with a short
// TTL so a mid-session install is picked up without a restart.

import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Resolve packages the same way Brigade's own modules do (from its node_modules),
 *  so the OPTIONAL `@hyperframes/producer` dep is found when installed. */
const requireFromHere = createRequire(import.meta.url);

/** Minimum Node major HyperFrames needs. */
const MIN_NODE_MAJOR = 22;
/** On Windows a bare command resolves via these extensions. Real executables and
 *  the cmd shim come FIRST so we never latch the extensionless bash shim (which
 *  can't be spawned); `.ps1` is omitted — it isn't directly spawnable. */
const WINDOWS_EXTS = [".exe", ".cmd", ".bat", ".com", ""];

export interface DepStatus {
	ok: boolean;
	/** Resolved path / version when found; a remediation hint when not. */
	detail: string;
}

export interface RenderVideoDoctor {
	/** True when the HARD deps (node + ffmpeg + engine) are present. Chrome is a
	 *  SOFT gap (HyperFrames may bundle its own Chromium) and does NOT affect this. */
	ready: boolean;
	node: DepStatus;
	ffmpeg: DepStatus;
	chrome: DepStatus;
	hyperframes: DepStatus;
}

function isExecutable(file: string): boolean {
	try {
		if (!statSync(file).isFile()) return false; // reject directories / devices
	} catch {
		return false; // doesn't exist
	}
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		// X_OK is unreliable on Windows (false for real .exe/.cmd). A regular file
		// that exists there is treated as runnable — shims are launched via a shell.
		return process.platform === "win32";
	}
}

/** Resolve `command` to a full path on PATH, or null. Windows-ext aware. An
 *  explicit path (contains a separator) is probed directly. */
export function whichOnPath(command: string): string | null {
	const exts = process.platform === "win32" ? WINDOWS_EXTS : [""];
	if (command.includes("/") || command.includes("\\")) {
		for (const ext of exts) if (isExecutable(command + ext)) return command + ext;
		return null;
	}
	const pathEnv = process.env.PATH ?? process.env.Path ?? "";
	for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
		for (const ext of exts) {
			const full = path.join(dir, command + ext);
			if (isExecutable(full)) return full;
		}
	}
	return null;
}

/** Node major from `process.versions.node`, or 0 when unparseable. */
function nodeMajor(): number {
	const m = /^(\d+)\./.exec(process.versions.node ?? "");
	return m ? Number(m[1]) : 0;
}

function checkNode(): DepStatus {
	const major = nodeMajor();
	return major >= MIN_NODE_MAJOR
		? { ok: true, detail: `node v${process.versions.node}` }
		: { ok: false, detail: `node ${MIN_NODE_MAJOR}+ required (have v${process.versions.node})` };
}

/** FFmpeg: honour the `FFMPEG_PATH` override HyperFrames itself reads, else PATH. */
function checkFfmpeg(): DepStatus {
	const override = process.env.FFMPEG_PATH?.trim();
	const resolved = override ? whichOnPath(override) : whichOnPath("ffmpeg");
	if (resolved) return { ok: true, detail: resolved };
	if (override) {
		return { ok: false, detail: `FFMPEG_PATH is set but no executable was found at "${override}"` };
	}
	return {
		ok: false,
		detail:
			"ffmpeg not found — install it (winget install ffmpeg / brew install ffmpeg / apt install ffmpeg) or set FFMPEG_PATH",
	};
}

/** A headless Chrome. A PATH scan for a system Chrome/Edge/Brave/Chromium, plus
 *  the `PUPPETEER_EXECUTABLE_PATH` / `BRIGADE_BROWSER_EXECUTABLE` overrides. On
 *  macOS these live in `.app` bundles off PATH, so a miss here is EXPECTED and
 *  soft — HyperFrames' bundled Chromium usually still renders. We don't launch it
 *  (that's a render-time cost); this only informs the doctor, it never gates. */
function checkChrome(): DepStatus {
	const override =
		process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
		process.env.BRIGADE_BROWSER_EXECUTABLE?.trim();
	const resolvedOverride = override ? whichOnPath(override) : null;
	if (resolvedOverride) return { ok: true, detail: resolvedOverride };
	for (const bin of ["chrome", "google-chrome", "chromium", "msedge", "brave"]) {
		const resolved = whichOnPath(bin);
		if (resolved) return { ok: true, detail: resolved };
	}
	// Puppeteer (bundled with HyperFrames) may have its own managed Chromium the
	// PATH scan can't see — so this is a soft gap, not a hard failure signal.
	return {
		ok: false,
		detail:
			"no system Chrome/Edge/Chromium found on PATH — HyperFrames' bundled Chromium may still work; if render fails, run `npx puppeteer browsers install chrome`",
	};
}

/**
 * Resolve the `@hyperframes/producer` render pipeline (the OPTIONAL dependency we
 * drive programmatically). Precedence:
 *   1. `BRIGADE_HYPERFRAMES_PATH` — an explicit producer entry FILE (advanced / tests).
 *   2. `@hyperframes/producer` resolvable from Brigade's node_modules.
 * Returns the resolved module entry path, or null when the engine isn't installed.
 */
export function resolveProducerEntry(): string | null {
	const override = process.env.BRIGADE_HYPERFRAMES_PATH?.trim();
	if (override) {
		try {
			return statSync(override).isFile() ? override : null;
		} catch {
			return null;
		}
	}
	try {
		return requireFromHere.resolve("@hyperframes/producer");
	} catch {
		return null;
	}
}

/** The HyperFrames render engine — the `@hyperframes/producer` package. */
function checkHyperFrames(): DepStatus {
	const override = process.env.BRIGADE_HYPERFRAMES_PATH?.trim();
	const resolved = resolveProducerEntry();
	if (resolved) return { ok: true, detail: resolved };
	if (override) {
		return {
			ok: false,
			detail: `BRIGADE_HYPERFRAMES_PATH is set but no file was found at "${override}"`,
		};
	}
	return {
		ok: false,
		detail: "hyperframes render engine not installed — run `npm i @hyperframes/producer`",
	};
}

/** Full doctor rollup. Never throws. */
export function renderVideoDoctor(): RenderVideoDoctor {
	const node = checkNode();
	const ffmpeg = checkFfmpeg();
	const chrome = checkChrome();
	const hyperframes = checkHyperFrames();
	// Chrome is a SOFT gap (Puppeteer may bundle its own), so `ready` keys off the
	// hard deps: node + ffmpeg + engine. Chrome surfaces as a warning at render.
	return { ready: node.ok && ffmpeg.ok && hyperframes.ok, node, ffmpeg, chrome, hyperframes };
}

interface AvailabilityCache {
	available: boolean;
	checkedAtMs: number;
}
let cache: AvailabilityCache | undefined;
const AVAILABILITY_TTL_MS = 60_000;

/**
 * Registration gate — the tool is only advertised when it can actually run.
 * Requires the `@hyperframes/producer` package (the distinctive dep) plus Node
 * 22. FFmpeg / Chrome gaps are surfaced as actionable render-time errors rather
 * than hiding the tool, but with no engine at all there's nothing to render.
 * Cached with a short TTL; `force` bypasses (e.g. right after an install).
 */
export function isRenderVideoAvailable(opts: { force?: boolean; nowMs?: number } = {}): boolean {
	const now = opts.nowMs ?? Date.now();
	if (!opts.force && cache && now - cache.checkedAtMs < AVAILABILITY_TTL_MS) {
		return cache.available;
	}
	let available = false;
	try {
		available = checkNode().ok && checkHyperFrames().ok;
	} catch {
		available = false;
	}
	cache = { available, checkedAtMs: now };
	return available;
}

/** Test-only cache reset. */
export function __resetRenderVideoAvailabilityCache(): void {
	cache = undefined;
}
