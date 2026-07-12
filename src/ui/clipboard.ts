/**
 * The clipboard, as a first-class cross-platform capability.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 * Reading a clipboard is not one problem, it is four, and they do not share an
 * answer across operating systems:
 *
 *   • an IMAGE (a screenshot) lives on the clipboard as raw bitmap data with no
 *     file behind it — the bytes must be materialised somewhere before anything
 *     else can touch them;
 *   • a FILE copied in Explorer/Finder is a REFERENCE, not bytes — which is
 *     exactly why copy-pasting a 400 MB video costs nothing: only the path moves;
 *   • TEXT that happens to be a PATH ("Copy as path", a path out of a log) is a
 *     third mechanism again, and the one most Windows users actually hit;
 *   • and CHANGE NOTIFICATION — knowing an image arrived without being told —
 *     has a different, and much cheaper, answer than "poll the clipboard".
 *
 * Each platform expresses all four differently, so they live behind one
 * `ClipboardBackend` and the rest of the product never learns that PowerShell,
 * osascript, or wl-paste exist.
 *
 * ── On watching, and why it matters more than Ctrl+V ──────────────────────
 * Ctrl+V cannot be intercepted for an image, on any mainstream terminal, ever.
 * The terminal binds that key to its own paste, which inserts the clipboard's
 * TEXT — and a screenshot has no text, so it inserts nothing and sends nothing.
 * The application receives no keystroke at all. There is no byte to hook.
 *
 * So we don't watch the keypress; we watch the CLIPBOARD. Take a screenshot and
 * it simply appears as an attachment. Crucially this is NOT a poll-by-shelling-
 * out loop, which would burn ~100 ms of CPU per tick forever to answer a question
 * that is almost always "no". Each platform has a cheap primitive for exactly
 * this and we use it:
 *
 *   Windows  `GetClipboardSequenceNumber()` — a Win32 counter that ticks on any
 *            clipboard write and is free to read. One long-lived PowerShell holds
 *            the watch and only touches the clipboard when the number moves.
 *   Wayland  `wl-paste --watch` — genuinely event-driven. No polling at all.
 *   macOS    one long-lived `osascript` whose `repeat` loop compares
 *            `clipboard info`; the process is spawned once, not per tick.
 *   X11      no cheap change primitive exists. Watching is unsupported rather
 *            than faked with an expensive poll — `/paste` still works.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { ClipboardWorker, type ClipboardSnapshot } from "./clipboard-worker.js";

export type { ClipboardSnapshot } from "./clipboard-worker.js";

const execFileAsync = promisify(execFile);

/** Ten seconds is generous for a clipboard read; past it something is wrong. */
const CLIPBOARD_TIMEOUT_MS = 10_000;

/** A running clipboard watch. `stop()` must be idempotent and must not throw. */
export interface ClipboardWatcher {
	stop(): void;
}

/**
 * One platform's answers. Every method is best-effort and non-throwing: a missing
 * tool, a locked clipboard, or a hostile OS must degrade the feature, never break
 * the turn the operator is in the middle of.
 */
export interface ClipboardBackend {
	/**
	 * Is there an image, WITHOUT decoding it?
	 *
	 * Separate from `saveImage` on purpose. `Clipboard::GetImage()` materialises
	 * and decodes the bitmap before you can ask whether one existed; on a clipboard
	 * holding a 4K screenshot that is real work done to answer "no". Every backend
	 * has a cheap containment probe and this is it.
	 */
	hasImage(): Promise<boolean>;
	/** Write the clipboard's image to `dest` as PNG. False when there wasn't one. */
	saveImage(dest: string): Promise<boolean>;
	/** Absolute paths of files copied in the file manager. */
	readFiles(): Promise<string[]>;
	/** The clipboard's plain text, or "". */
	readText(): Promise<string>;
	/** What the clipboard holds, in words, for when a paste found nothing. */
	describe(): Promise<string>;
	/**
	 * Call `onChange` whenever the clipboard changes. `null` when this platform has
	 * no cheap primitive for it — never fake it with an expensive poll.
	 */
	watch(onChange: () => void): ClipboardWatcher | null;
}

/* ────────────────────────────── Windows ──────────────────────────────── */

/**
 * PowerShell, always with `-STA`.
 *
 * The clipboard is an OLE single-threaded-apartment API. PowerShell 7 (`pwsh`)
 * runs MTA by default, where `Clipboard::GetImage()` returns null for reasons
 * that have nothing to do with the clipboard's contents — a silent, baffling
 * failure. `powershell.exe` (Windows PowerShell 5.1) ships on every Win10/11 box
 * and takes `-STA`, so it is the only reliably working combination.
 */
async function ps(script: string): Promise<{ stdout: string; code: number }> {
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
			{ timeout: CLIPBOARD_TIMEOUT_MS },
		);
		return { stdout, code: 0 };
	} catch (err) {
		const e = err as { stdout?: string; code?: number };
		return { stdout: e.stdout ?? "", code: typeof e.code === "number" ? e.code : 1 };
	}
}

const WINDOWS: ClipboardBackend = {
	async hasImage() {
		const { stdout } = await ps(
			"Add-Type -AssemblyName System.Windows.Forms; if ([Windows.Forms.Clipboard]::ContainsImage()) { 'yes' }",
		);
		return stdout.includes("yes");
	},

	async saveImage(dest) {
		// The containment check first, so a text clipboard costs one cheap call rather
		// than a full bitmap decode.
		//
		// `$img.Save()` to a bad path raises a NON-TERMINATING error, so without the
		// try/catch the script sailed on and printed 'ok' for a file it had not
		// written — this reported success for a save that never happened, and only a
		// test with an image actually on the clipboard exposed it. `-ErrorAction Stop`
		// via a trapping try is what makes the failure real.
		const q = dest.replace(/'/g, "''");
		const { stdout } = await ps(
			"Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
				"if (-not [Windows.Forms.Clipboard]::ContainsImage()) { exit 1 }; " +
				"$img = [Windows.Forms.Clipboard]::GetImage(); if ($null -eq $img) { exit 1 }; " +
				`try { $img.Save('${q}', [System.Drawing.Imaging.ImageFormat]::Png); $img.Dispose(); ` +
				`if (Test-Path -LiteralPath '${q}') { 'ok' } } catch { exit 1 }`,
		);
		return stdout.includes("ok");
	},

	async readFiles() {
		const { stdout } = await ps(
			"Add-Type -AssemblyName System.Windows.Forms; " +
				"$f = [Windows.Forms.Clipboard]::GetFileDropList(); " +
				"if ($f) { $f | ForEach-Object { Write-Output $_ } }",
		);
		return stdout.split(/\r?\n/);
	},

	async readText() {
		const { stdout } = await ps("Get-Clipboard -Raw");
		return stdout;
	},

	async describe() {
		const { stdout } = await ps(
			"Add-Type -AssemblyName System.Windows.Forms; " +
				"$d = [Windows.Forms.Clipboard]::GetDataObject(); if ($d) { $d.GetFormats() -join ',' }",
		);
		const formats = stdout.trim();
		if (!formats) return "the clipboard appears to be empty.";
		return `the clipboard holds ${formats.split(",").slice(0, 5).join(", ")} — no image and no file.`;
	},

	watch(onChange) {
		// Superseded by the persistent worker, which pushes the SAVED image path
		// directly (see `startClipboardService`). Kept only so a Windows box whose
		// worker refused to start still gets change notification — at the old cost.
		const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BrigadeClip {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
"@
$last = [BrigadeClip]::GetClipboardSequenceNumber()
while ($true) {
  Start-Sleep -Milliseconds 400
  $n = [BrigadeClip]::GetClipboardSequenceNumber()
  if ($n -ne $last) {
    $last = $n
    if ([Windows.Forms.Clipboard]::ContainsImage()) { Write-Output 'CHANGED' }
  }
}`.trim();
		return spawnWatcher(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
			onChange,
		);
	},
};

/* ─────────────────────────────── macOS ───────────────────────────────── */

async function osa(script: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("osascript", ["-e", script], {
			timeout: CLIPBOARD_TIMEOUT_MS,
		});
		return stdout;
	} catch {
		return "";
	}
}

/** AppleScript string literals escape like C's. */
const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const MACOS: ClipboardBackend = {
	async hasImage() {
		// `clipboard info` lists the flavours present without materialising any of them.
		const info = await osa("return (clipboard info) as string");
		return /PNGf|TIFF|GIFf|«class PNGf»/i.test(info);
	},

	async saveImage(dest) {
		// «class PNGf» is the clipboard's PNG flavour. The `try` makes a text-only
		// clipboard return "none" rather than raising.
		const out = await osa(
			[
				"try",
				"  set png to (the clipboard as «class PNGf»)",
				`  set fp to (open for access POSIX file "${esc(dest)}" with write permission)`,
				"  write png to fp",
				"  close access fp",
				'  return "ok"',
				"on error",
				'  return "none"',
				"end try",
			].join("\n"),
		);
		return out.includes("ok");
	},

	async readFiles() {
		// `the clipboard as «class furl»` returns only the FIRST file — copy three in
		// Finder and two vanish, silently. Ask for the list and convert each entry.
		const out = await osa(
			[
				"set out to {}",
				"try",
				"  set items_ to (the clipboard as list)",
				"  repeat with i in items_",
				"    try",
				"      set end of out to POSIX path of (i as alias)",
				"    end try",
				"  end repeat",
				"end try",
				"if (count of out) is 0 then",
				"  try",
				"    set end of out to POSIX path of (the clipboard as «class furl»)",
				"  end try",
				"end if",
				"set text item delimiters to linefeed",
				"return out as text",
			].join("\n"),
		);
		return out.split(/\r?\n/);
	},

	async readText() {
		try {
			const { stdout } = await execFileAsync("pbpaste", [], { timeout: CLIPBOARD_TIMEOUT_MS });
			return stdout;
		} catch {
			return "";
		}
	},

	async describe() {
		const info = (await osa("return (clipboard info) as string")).trim();
		if (!info) return "the clipboard appears to be empty.";
		return `the clipboard holds ${info.slice(0, 80)} — no image and no file.`;
	},

	watch(onChange) {
		// ONE osascript process whose `repeat` loop compares `clipboard info`. The
		// alternative — shelling out to osascript on a timer — pays process-spawn cost
		// forever to almost always learn nothing. `log` writes to stderr, which is why
		// the watcher below listens on both streams.
		const script = [
			"set lastInfo to \"\"",
			"repeat",
			"  try",
			"    set nowInfo to (clipboard info) as string",
			"  on error",
			"    set nowInfo to \"\"",
			"  end try",
			"  if nowInfo is not lastInfo then",
			"    set lastInfo to nowInfo",
			"    if nowInfo contains \"PNGf\" or nowInfo contains \"TIFF\" then log \"CHANGED\"",
			"  end if",
			"  delay 0.4",
			"end repeat",
		].join("\n");
		return spawnWatcher("osascript", ["-e", script], onChange);
	},
};

/* ─────────────────────────────── Linux ───────────────────────────────── */

async function tryExec(bin: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(bin, args, { timeout: CLIPBOARD_TIMEOUT_MS });
		return stdout;
	} catch {
		return null;
	}
}

const LINUX: ClipboardBackend = {
	async hasImage() {
		// Ask what FLAVOURS exist rather than fetching bytes — same idea as
		// ContainsImage() and `clipboard info`.
		const types =
			(await tryExec("wl-paste", ["--list-types"])) ??
			(await tryExec("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]));
		return typeof types === "string" && /image\/(png|bmp|jpeg)/i.test(types);
	},

	async saveImage(dest) {
		for (const [bin, args] of [
			["wl-paste", ["--no-newline", "--type", "image/png"]],
			["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
		] as Array<[string, string[]]>) {
			try {
				const { stdout } = await execFileAsync(bin, args, {
					timeout: CLIPBOARD_TIMEOUT_MS,
					encoding: "buffer",
					maxBuffer: 64 * 1024 * 1024,
				});
				const buf = stdout as unknown as Buffer;
				if (buf?.length > 0) {
					fs.writeFileSync(dest, buf);
					return true;
				}
			} catch {
				continue; // tool absent, or no image in that flavour
			}
		}
		return false;
	},

	async readFiles() {
		const uris =
			(await tryExec("wl-paste", ["--no-newline", "--type", "text/uri-list"])) ??
			(await tryExec("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"]));
		return (uris ?? "").split(/\r?\n/);
	},

	async readText() {
		return (
			(await tryExec("wl-paste", ["--no-newline"])) ??
			(await tryExec("xclip", ["-selection", "clipboard", "-o"])) ??
			""
		);
	},

	async describe() {
		const types =
			(await tryExec("wl-paste", ["--list-types"])) ??
			(await tryExec("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]));
		if (types === null) {
			// ENOENT on BOTH tools is a completely different situation from an empty
			// clipboard, and reporting the latter sends the operator hunting for a bug in
			// Brigade instead of running `apt install wl-clipboard`.
			return "no clipboard tool found — install wl-clipboard (Wayland) or xclip (X11).";
		}
		// X11's TARGETS list leads with protocol bookkeeping (TIMESTAMP, TARGETS,
		// MULTIPLE, SAVE_TARGETS) that is not clipboard CONTENT — reporting "the
		// clipboard holds TIMESTAMP, TARGETS, MULTIPLE" as if it were the payload is
		// noise. Filter it so the operator sees the actual MIME types.
		const XCLIP_META = new Set([
			"TIMESTAMP",
			"TARGETS",
			"MULTIPLE",
			"SAVE_TARGETS",
			"DELETE",
			"INSERT_SELECTION",
			"INSERT_PROPERTY",
		]);
		const list = types
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter((s) => s && !XCLIP_META.has(s))
			.slice(0, 5)
			.join(", ");
		if (!list) return "the clipboard appears to be empty.";
		return `the clipboard holds ${list} — no image and no file.`;
	},

	watch(onChange) {
		// Wayland gives us a genuinely event-driven watch — no polling whatsoever.
		// X11 has no cheap change primitive, so it gets NO watcher rather than an
		// expensive fake one; `/paste` still works there. Refusing to poll is the
		// honest answer, not a missing feature.
		if (!process.env.WAYLAND_DISPLAY) return null;
		return spawnWatcher("wl-paste", ["--watch", "echo", "CHANGED"], onChange);
	},
};

/* ────────────────────────────── plumbing ─────────────────────────────── */

/**
 * Spawn a long-lived watcher process and call `onChange` for each line it emits.
 *
 * Two containment rules, both of which this got wrong once:
 *
 *   • `unref()` — a child that by DESIGN never exits is a handle that keeps its
 *     parent's event loop alive forever. It hung the entire test suite the first
 *     time, because the e2e test boots the real UI. A convenience feature must
 *     never be the reason a process refuses to die.
 *   • never let it throw — a watcher failing is a lost convenience, not a lost
 *     turn. Every error path here ends in a no-op watcher.
 */
function spawnWatcher(bin: string, args: string[], onChange: () => void): ClipboardWatcher | null {
	let child: ChildProcess;
	try {
		child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		child.unref();
	} catch {
		return null;
	}

	// stdout AND stderr: AppleScript's `log` writes to stderr, so a macOS watcher
	// that only listened on stdout would hear nothing and look broken.
	const onData = (chunk: Buffer): void => {
		if (chunk.toString("utf8").includes("CHANGED")) onChange();
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	child.on("error", () => {});

	return {
		stop: () => {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
		},
	};
}

/** The backend for this OS. */
export function clipboardBackend(): ClipboardBackend {
	if (process.platform === "win32") return WINDOWS;
	if (process.platform === "darwin") return MACOS;
	return LINUX;
}

/* ─────────────────────────── the service ─────────────────────────────── */

/**
 * The clipboard, as the product actually consumes it: ONE call that reads
 * everything, and a push channel for images.
 *
 * The split matters. On Windows a persistent worker holds PowerShell open, so a
 * read is a few milliseconds and an auto-attach costs Node nothing at all. On
 * every other platform we fall back to the per-call backend — still correct, just
 * paying a process spawn. The rest of the product cannot tell which it got, and
 * must not care.
 */
export interface ClipboardService {
	/** Read the whole clipboard in one pass, saving any image to `imageDest`. */
	read(imageDest: string): Promise<ClipboardSnapshot>;
	/** Stop any background process. Idempotent; must never throw. */
	stop(): void;
}

/**
 * Start the clipboard service.
 *
 * `onImage` is called with a saved PNG path whenever an image lands on the
 * clipboard — the auto-attach channel, and the reason Ctrl+V is unnecessary.
 */
/** Read a whole snapshot via the per-call backend, all reads CONCURRENT. */
async function backendSnapshot(
	backend: ClipboardBackend,
	imageDest: string,
): Promise<ClipboardSnapshot> {
	const [imageSaved, files, text, formats] = await Promise.all([
		backend.hasImage().then((has) => (has ? backend.saveImage(imageDest) : false)),
		backend.readFiles(),
		backend.readText(),
		backend.describe().then((d) => [d]),
	]);
	return {
		...(imageSaved ? { imagePath: imageDest } : {}),
		files: files.filter(Boolean),
		text,
		formats,
	};
}

export function startClipboardService(onImage?: (imagePath: string) => void): ClipboardService {
	// EVERY platform gets the persistent worker. One interpreter, held open, reading
	// the whole clipboard in a single round-trip — the shape that was wrong before,
	// on all three: four separate reads issued as four separate processes, in series,
	// for one paste.
	const worker = new ClipboardWorker();
	worker.start(onImage, clipboardSpoolDir());
	const backend = clipboardBackend();

	// PUSH. Windows carries change notification inside the worker itself (a free
	// Win32 sequence counter). POSIX cannot: polling the clipboard from the worker
	// loop would mean spawning `osascript` every tick — the exact per-tick process
	// cost this design exists to remove. So the platform's own cheap primitive does
	// it: `wl-paste --watch` is genuinely event-driven, and macOS gets ONE long-lived
	// osascript `repeat` loop. Either way the operator sees the same thing: a
	// screenshot attaches itself.
	const pushWatcher =
		onImage && process.platform !== "win32"
			? backend.watch(() => {
					void (async () => {
						const dest = path.join(clipboardSpoolDir(), `clipboard-${Date.now()}.png`);
						const snap = await worker.snapshot(dest);
						if (snap.imagePath) onImage(snap.imagePath);
					})();
				})
			: null;

	return {
		read: async (dest) => {
			// `worker.available` is TRUE the instant spawn returns — but a missing
			// interpreter (no bash on Alpine, powershell.exe off PATH, ExecutionPolicy
			// still blocking) fails ASYNCHRONOUSLY, on a later tick, via the 'error'
			// event. So availability can't be judged synchronously. Ask the worker
			// whether it ACTUALLY became ready; only fall back to the slow per-call
			// backend when it did not. On the happy path this adds nothing — readiness
			// already resolved during boot.
			if (await worker.whenReady()) return worker.snapshot(dest);
			return backendSnapshot(backend, dest);
		},
		stop: () => {
			pushWatcher?.stop();
			worker.kill();
		},
	};
}

/** Where clipboard bitmaps are materialised. OS temp — never `~/.brigade`, which
 *  the convex-mode strict-zero guard requires to stay clean. Sweeps its own
 *  leavings, or every screenshot ever pasted would live on disk forever. */
export function clipboardSpoolDir(): string {
	const dir = path.join(os.tmpdir(), "brigade-attachments");
	fs.mkdirSync(dir, { recursive: true });
	try {
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		for (const name of fs.readdirSync(dir)) {
			const p = path.join(dir, name);
			try {
				if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
			} catch {
				/* in use, gone, or not ours */
			}
		}
	} catch {
		/* unreadable spool dir — pasting still works, we just don't sweep */
	}
	return dir;
}
