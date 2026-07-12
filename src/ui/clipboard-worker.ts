/**
 * A PERSISTENT clipboard worker — one process, held open, answering in milliseconds.
 *
 * ── The problem it exists to solve ────────────────────────────────────────
 * Every clipboard read used to spawn a fresh `powershell.exe`. A PowerShell cold
 * start is 200–500 ms, and it is paid EVERY time. `/paste` was worse than it
 * looks: it asked for files, then an image, then text — up to four spawns, one
 * after another, so a paste could take the better part of two seconds. The
 * auto-attach watcher was worse still: it noticed the clipboard change in one
 * process and then spawned two MORE to find out what was on it.
 *
 * That is not a clipboard being slow. That is us paying process-creation cost to
 * ask a question that takes the OS microseconds to answer.
 *
 * ── The fix ───────────────────────────────────────────────────────────────
 * Start ONE PowerShell, once, and keep it. It holds the Win32 clipboard APIs
 * already loaded and serves two roles at the same time:
 *
 *   • REQUEST/RESPONSE — Node writes `SNAPSHOT|<dest>` on stdin, the worker reads
 *     EVERYTHING the clipboard holds in a single pass (formats, files, text, and
 *     the image already decoded and saved to `<dest>`) and writes back one JSON
 *     line. A `/paste` is now one round-trip of a few milliseconds, not four
 *     process spawns.
 *
 *   • PUSH — the same loop polls `GetClipboardSequenceNumber()`, a free Win32
 *     counter that ticks on any clipboard write. When it moves AND an image is
 *     present, the worker saves the PNG ITSELF and pushes `IMAGE|<path>`. Node
 *     spawns nothing at all: a screenshot is attached ~150 ms after it is taken.
 *
 * Both roles share one process because `ReadLineAsync()` lets the loop check for
 * a pending command without blocking the poll — so we get request/response AND a
 * push channel without a second interpreter sitting in memory.
 *
 * The whole thing is best-effort. If PowerShell is missing, wedged, or refuses to
 * start, every method degrades to "no clipboard" and the operator loses a
 * convenience, never a turn.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Everything the clipboard holds, read in ONE pass. */
export interface ClipboardSnapshot {
	/** Absolute path to the PNG we saved, when the clipboard held an image. */
	imagePath?: string;
	/** Absolute paths of files copied in the file manager. */
	files: string[];
	/** Plain text, if any. */
	text: string;
	/** Format names, for telling the operator what IS there when a paste finds nothing. */
	formats: string[];
}

const EMPTY: ClipboardSnapshot = { files: [], text: "", formats: [] };

/**
 * The worker script.
 *
 * Every clipboard call is guarded: a clipboard can be LOCKED by another process
 * mid-read (Windows genuinely does this — an app holding it open makes
 * `GetImage()` throw), and a worker that dies on the first locked read is worse
 * than no worker.
 */
const WINDOWS_WORKER = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
# FORCE UTF-8 on stdout. Windows PowerShell 5.1 writes a REDIRECTED console in the
# OEM code page (CP437/CP1252), NOT UTF-8 — so a path or clipboard text containing
# any non-ASCII byte (C:\Users\Björn\…, résumé.pdf, any CJK name) arrives at Node
# as invalid UTF-8 and every such byte becomes U+FFFD. The screenshot then fails to
# attach because the path we echoed back no longer names a real file. One line fixes
# every non-English Windows install.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BrigadeClip {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
"@

function Emit([string]$msg) {
  # Write-Output goes through the pipeline and is block-buffered when stdout is a
  # pipe — so a worker that never exits would never flush a single line, and Node
  # would wait forever. Go straight to the console stream and flush by hand.
  [Console]::Out.WriteLine($msg)
  [Console]::Out.Flush()
}

function Save-ClipImage([string]$dest) {
  try {
    if (-not [Windows.Forms.Clipboard]::ContainsImage()) { return $null }
    $img = [Windows.Forms.Clipboard]::GetImage()
    if ($null -eq $img) { return $null }
    $img.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $img.Dispose()
    # CONFIRM it landed. Save() to a bad path raises a NON-terminating error, so
    # without this the worker would report a path to a file it never wrote, and the
    # attachment would fail later with no explanation of why.
    if (-not (Test-Path -LiteralPath $dest)) { return $null }
    return $dest
  } catch { return $null }
}

# [Console]::In is a SYNCHRONIZED TextReader, and its ReadLineAsync() is a lie: it
# calls ReadLine() on the calling thread and BLOCKS. With stdin an open pipe and no
# data yet, the worker blocked here forever and never announced itself — which the
# operator experienced as "the clipboard is slow". A StreamReader over the raw
# stdin handle is genuinely async.
# Where PUSHED (auto-attach) images are written. Passed in as argv[0] so it lands
# in the SAME directory the Node side sweeps after 24h — writing them to $env:TEMP
# (its parent) meant every screenshot ever copied leaked a full-size PNG that
# nothing ever deleted.
$spool = $args[0]
if ([string]::IsNullOrEmpty($spool)) { $spool = $env:TEMP }

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$last = [BrigadeClip]::GetClipboardSequenceNumber()

# Announce readiness only after the assemblies are loaded and the C# above has
# compiled (1-2s). A request written before that is one the worker is not yet
# listening for.
Emit 'READY'

while ($true) {
  # 1. Serve a request, if one has arrived. Async so the poll below never blocks.
  if ($pending.IsCompleted) {
    $line = $pending.Result
    if ($null -eq $line) { break }          # stdin closed: parent is gone
    $pending = $stdin.ReadLineAsync()
    $parts = $line -split '\|', 3
    if ($parts[0] -eq 'EXIT') { break }
    if ($parts[0] -eq 'SNAPSHOT') {
      # Every reply carries the request's id. Without it, a slow reply lands on
      # whoever asked NEXT and hands them somebody else's clipboard.
      $id = $parts[1]
      $dest = $parts[2]
      $files = @()
      $text = ''
      $formats = @()
      try { $d = [Windows.Forms.Clipboard]::GetDataObject(); if ($d) { $formats = @($d.GetFormats()) } } catch {}
      try { if ([Windows.Forms.Clipboard]::ContainsFileDropList()) { $files = @([Windows.Forms.Clipboard]::GetFileDropList()) } } catch {}
      try { if ([Windows.Forms.Clipboard]::ContainsText()) { $text = [Windows.Forms.Clipboard]::GetText() } } catch {}
      $img = Save-ClipImage $dest
      $o = [ordered]@{ imagePath = $img; files = $files; text = $text; formats = $formats }
      Emit ('SNAPSHOT ' + $id + ' ' + ($o | ConvertTo-Json -Compress -Depth 3))
      # A snapshot READS the clipboard; don't let it look like a change and re-push.
      $last = [BrigadeClip]::GetClipboardSequenceNumber()
    }
  }

  # 2. Push an image the moment one lands. The sequence number is free to read, so
  #    the steady-state cost of this loop is an integer compare.
  $n = [BrigadeClip]::GetClipboardSequenceNumber()
  if ($n -ne $last) {
    $last = $n
    try {
      if ([Windows.Forms.Clipboard]::ContainsImage()) {
        $p = Join-Path $spool ("clipboard-" + $n + ".png")
        $saved = Save-ClipImage $p
        if ($saved) { Emit ('IMAGE ' + $saved) }
      }
    } catch {}
  }

  Start-Sleep -Milliseconds 150
}
`.trim();

/**
 * The macOS / Linux worker.
 *
 * ── Why a shell script and not "the same thing as Windows" ────────────────
 * The Windows cost was never the clipboard, it was PowerShell: a 200-500 ms
 * interpreter boot, paid per call. `pbpaste`, `osascript`, `wl-paste` and `xclip`
 * are small C programs that spawn in 5-30 ms, so the per-spawn tax here is an
 * order of magnitude smaller. What actually hurt on every platform was the SHAPE:
 * four separate reads (files, image, text, formats) issued as four separate
 * processes, in series, for one paste.
 *
 * So this worker fixes the shape. It stays resident and answers a whole snapshot
 * in ONE round-trip, gathering everything in a single pass.
 *
 * ── Why the response isn't JSON ───────────────────────────────────────────
 * Emitting correct JSON from shell means escaping quotes, backslashes, newlines
 * and control bytes in clipboard TEXT that came from anywhere at all. That is a
 * quoting bug waiting to happen, and quoting bugs in this feature have already
 * cost a day. A line-block protocol with the text base64'd cannot be broken by its
 * own payload:
 *
 *     S <id> BEGIN
 *     I <image path, or empty>
 *     F <file path>            (0..n)
 *     T <base64 of the text>
 *     X <format name>          (0..n)
 *     S <id> END
 *
 * ── Change notification is NOT here ───────────────────────────────────────
 * Polling the clipboard from this loop would mean spawning `osascript` every tick
 * — the exact per-tick process cost the whole design exists to avoid. Push stays
 * with the platform's own cheap primitive (`wl-paste --watch` is genuinely
 * event-driven; a single long-lived osascript `repeat` loop covers macOS), wired
 * separately in `startClipboardService`.
 */
const POSIX_WORKER = String.raw`
set -u
set -f

# NOTE FOR ANYONE EDITING THIS SCRIPT: it must contain NO dollar-sign followed by
# an opening brace. It lives inside a JS template literal, and String.raw STILL
# performs interpolation — so a shell parameter expansion (the kind that strips a
# prefix or a suffix) is read by JavaScript as an expression and the file will not
# even parse. It must also contain no backticks, which would close the literal.
# Argument parsing below therefore uses "set --" plus IFS, which needs neither.
# (This comment originally broke both rules, which is how they were learned.)

PLAT="$1"

read_darwin() {
  dest="$1"
  FMTS=$(osascript -e 'try
return (clipboard info) as string
on error
return ""
end try' 2>/dev/null)
  case "$FMTS" in
    *PNGf*|*TIFF*|*GIFf*)
      osascript -e "try
set png to (the clipboard as «class PNGf»)
set fp to (open for access POSIX file \"$dest\" with write permission)
write png to fp
close access fp
end try" >/dev/null 2>&1
      if [ -s "$dest" ]; then IMG="$dest"; fi
      ;;
  esac
  FILES=$(osascript -e 'set out to {}
try
set items_ to (the clipboard as list)
repeat with i in items_
try
set end of out to POSIX path of (i as alias)
end try
end repeat
end try
set text item delimiters to linefeed
return out as text' 2>/dev/null)
  TXT=$(pbpaste 2>/dev/null)
}

read_linux() {
  dest="$1"
  if command -v wl-paste >/dev/null 2>&1; then
    FMTS=$(wl-paste --list-types 2>/dev/null)
    case "$FMTS" in
      *image/png*|*image/bmp*)
        wl-paste --no-newline --type image/png > "$dest" 2>/dev/null
        if [ -s "$dest" ]; then IMG="$dest"; fi
        ;;
    esac
    FILES=$(wl-paste --no-newline --type text/uri-list 2>/dev/null)
    TXT=$(wl-paste --no-newline 2>/dev/null)
  elif command -v xclip >/dev/null 2>&1; then
    FMTS=$(xclip -selection clipboard -t TARGETS -o 2>/dev/null)
    case "$FMTS" in
      *image/png*|*image/bmp*)
        xclip -selection clipboard -t image/png -o > "$dest" 2>/dev/null
        if [ -s "$dest" ]; then IMG="$dest"; fi
        ;;
    esac
    FILES=$(xclip -selection clipboard -t text/uri-list -o 2>/dev/null)
    TXT=$(xclip -selection clipboard -o 2>/dev/null)
  fi
}

snapshot() {
  id="$1"
  dest="$2"
  IMG=""
  FILES=""
  TXT=""
  FMTS=""
  if [ "$PLAT" = "darwin" ]; then
    read_darwin "$dest"
  else
    read_linux "$dest"
  fi
  printf 'S %s BEGIN\n' "$id"
  printf 'I %s\n' "$IMG"
  printf '%s\n' "$FILES" | while IFS= read -r f; do
    if [ -n "$f" ]; then printf 'F %s\n' "$f"; fi
  done
  # base64, so clipboard text containing a newline, a quote or a control byte can
  # never break the protocol carrying it.
  printf 'T %s\n' "$(printf '%s' "$TXT" | base64 | tr -d '\n')"
  printf '%s\n' "$FMTS" | while IFS= read -r x; do
    if [ -n "$x" ]; then printf 'X %s\n' "$x"; fi
  done
  printf 'S %s END\n' "$id"
}

echo READY

while IFS= read -r line; do
  case "$line" in
    EXIT)
      exit 0
      ;;
    SNAPSHOT*)
      oldIFS="$IFS"
      IFS='|'
      set -- $line
      IFS="$oldIFS"
      snapshot "$2" "$3"
      ;;
  esac
done
`.trim();

/**
 * Every live worker, so none can outlive the process that started it.
 *
 * `unref()` stops the worker from KEEPING Node alive — but it does not make Node
 * kill it on the way out, and a non-detached child is not reaped automatically on
 * Windows. Without this, every `brigade tui` that exited would leave a PowerShell
 * behind, polling the clipboard forever, and after a week of use the operator
 * would have a dozen of them and no idea why. `process.on("exit")` fires for every
 * exit path — normal return, an uncaught throw, an explicit `process.exit()` — and
 * the signal handlers in `terminal-cleanup.ts` funnel SIGINT/SIGTERM into it too.
 */
const LIVE_WORKERS = new Set<ClipboardWorker>();
let reaperInstalled = false;

function installReaper(): void {
	if (reaperInstalled) return;
	reaperInstalled = true;
	process.on("exit", () => {
		for (const w of LIVE_WORKERS) w.kill();
	});
}

/** What a worker line turned out to mean. */
export type WorkerEvent =
	| { type: "ready" }
	| { type: "image"; path: string }
	| { type: "snapshot"; id: number; snapshot: ClipboardSnapshot };

/**
 * Parses BOTH worker protocols, line by line, with no I/O.
 *
 * Pure on purpose. The POSIX worker cannot be exercised on a Windows dev box and
 * the Windows one cannot be exercised on a Mac, so the parsing — where the real
 * bugs hide (a one-element array collapsed to a scalar; clipboard text containing
 * a newline) — is the part that must be testable everywhere, without an
 * interpreter and without the OS it targets.
 */
export class SnapshotAssembler {
	/** The POSIX line-block currently being received. */
	private block: { id: number; snap: ClipboardSnapshot } | undefined;

	feed(line: string): WorkerEvent | null {
		if (!line) return null;
		if (line === "READY") return { type: "ready" };

		// The push channel — an image landed on the clipboard. Identical on both.
		if (line.startsWith("IMAGE ")) {
			const p = line.slice("IMAGE ".length).trim();
			return p ? { type: "image", path: p } : null;
		}

		// ── Windows: one JSON line, `SNAPSHOT <id> {…}` ────────────────────
		if (line.startsWith("SNAPSHOT ")) {
			const rest = line.slice("SNAPSHOT ".length);
			const sp = rest.indexOf(" ");
			if (sp < 0) return null;
			const id = Number.parseInt(rest.slice(0, sp), 10);
			if (Number.isNaN(id)) return null;
			try {
				const raw = JSON.parse(rest.slice(sp + 1)) as {
					imagePath?: string | null;
					files?: string[] | string | null;
					text?: string | null;
					formats?: string[] | string | null;
				};
				// PowerShell's ConvertTo-Json collapses a ONE-element array to a bare
				// scalar. Normalising is not pedantry: without it a single copied file
				// arrives as a string and `files.map` throws on the very common case of
				// copying exactly one file.
				const arr = (v: string[] | string | null | undefined): string[] =>
					Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
				return {
					type: "snapshot",
					id,
					snapshot: {
						...(raw.imagePath ? { imagePath: raw.imagePath } : {}),
						files: arr(raw.files),
						text: typeof raw.text === "string" ? raw.text : "",
						formats: arr(raw.formats),
					},
				};
			} catch {
				return { type: "snapshot", id, snapshot: { files: [], text: "", formats: [] } };
			}
		}

		// ── POSIX: a line block. Correct JSON out of shell means escaping whatever
		//    happens to be on the operator's clipboard, which is a quoting bug waiting
		//    to happen; the text rides base64 instead and cannot break its own frame.
		if (line.startsWith("S ")) {
			const parts = line.split(" ");
			const id = Number.parseInt(parts[1] ?? "", 10);
			if (Number.isNaN(id)) return null;
			if (parts[2] === "BEGIN") {
				this.block = { id, snap: { files: [], text: "", formats: [] } };
				return null;
			}
			if (parts[2] === "END" && this.block?.id === id) {
				const snapshot = this.block.snap;
				this.block = undefined;
				return { type: "snapshot", id, snapshot };
			}
			return null;
		}

		if (!this.block) return null;
		const body = line.slice(2);
		switch (line[0]) {
			case "I":
				if (body) this.block.snap.imagePath = body;
				break;
			case "F":
				if (body) this.block.snap.files.push(body);
				break;
			case "T":
				try {
					this.block.snap.text = Buffer.from(body, "base64").toString("utf8");
				} catch {
					this.block.snap.text = "";
				}
				break;
			case "X":
				if (body) this.block.snap.formats.push(body);
				break;
			default:
				break;
		}
		return null;
	}
}

export class ClipboardWorker {
	private child: ChildProcess | undefined;
	private buf = "";
	/** id → resolver. Keyed, because a slow reply must never land on the next caller. */
	private inflight = new Map<number, (s: ClipboardSnapshot) => void>();
	private nextId = 1;
	private onImage: ((imagePath: string) => void) | undefined;
	private dead = false;
	/** The mkdtemp dir holding the worker script; removed on kill. */
	private scriptDir: string | undefined;
	/** Where auto-attach (pushed) images are written; passed to the worker as argv[0]. */
	private spoolDir: string | undefined;
	/** Whatever the worker last printed on stderr — the reason it is not answering. */
	lastError = "";
	/**
	 * Resolves when the worker has finished loading assemblies and compiling its
	 * P/Invoke shim (1-2 s) and has actually started reading stdin.
	 *
	 * Every request waits on this. A request written before the worker is listening
	 * is not merely slow — it times out, and its reply then arrives while the NEXT
	 * caller is waiting, handing them a stale answer. That is a correctness bug, and
	 * it is what a benchmark caught before an operator did.
	 */
	private ready: Promise<boolean> = Promise.resolve(false);
	private markReady: (ok: boolean) => void = () => {};

	/**
	 * True when a worker process exists. NOT the same as "ready" — callers await
	 * `snapshot`, which gates on readiness itself.
	 */
	get available(): boolean {
		return !this.dead && this.child !== undefined;
	}

	/**
	 * Start the worker. `onImage` is pushed a path whenever an image lands on the
	 * clipboard — that is the auto-attach channel, and it costs Node nothing.
	 */
	start(onImage?: (imagePath: string) => void, spoolDir?: string): void {
		if (this.child) return;
		this.onImage = onImage;
		this.spoolDir = spoolDir;
		installReaper();
		LIVE_WORKERS.add(this);
		// Build the readiness promise with LOCALS. Referring to `this.ready` inside its
		// own executor reads the PREVIOUS promise — which cleared the boot timer the
		// instant it was set, so readiness could never resolve and every snapshot
		// awaited forever. It hung for five minutes before this was caught.
		let settle: (ok: boolean) => void = () => {};
		const readyPromise = new Promise<boolean>((resolve) => {
			settle = resolve;
		});
		// Boot is 1-2 s (assembly load + C# compile). If it hasn't announced itself in
		// 15 s it never will — give up rather than making every paste wait forever.
		const bootTimer = setTimeout(() => settle(false), 15_000);
		void readyPromise.then(() => clearTimeout(bootTimer));
		this.ready = readyPromise;
		this.markReady = settle;

		try {
			// Run from a FILE, never `-Command` / `-c`.
			//
			// The Windows script carries a C# here-string and therefore double quotes;
			// the POSIX one carries AppleScript with its own nested quotes. Passing
			// either inline means it must survive Node's argv quoting, then the OS's,
			// then the interpreter's own parser — and it does not: the Windows worker
			// died silently on a parse error and never announced itself, which read
			// exactly like "the clipboard is slow". A file has no quoting layer at all.
			const win = process.platform === "win32";
			// SECURE the script's temp location. A fixed name in a world-writable /tmp
			// (mode 1777) lets a local attacker pre-create or symlink that path — the
			// sticky bit stops deletion but NOT creation — and then swap the file
			// between our write and our spawn, running arbitrary code as the operator.
			// `mkdtempSync` creates a fresh directory with a random suffix, owned by us
			// at mode 0700, so there is no name to pre-claim.
			this.scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-clip-"));
			const scriptPath = path.join(this.scriptDir, win ? "worker.ps1" : "worker.sh");
			// A BOM on Windows: `powershell.exe -File` decodes a BOM-less file as the
			// ANSI code page, so the day this script grows a non-ASCII character outside
			// a comment (POSIX already has `«class PNGf»`) it would fail to parse. The
			// BOM makes the decode unambiguous.
			fs.writeFileSync(
				scriptPath,
				win ? `﻿${WINDOWS_WORKER}` : POSIX_WORKER,
				win ? { encoding: "utf8" } : { encoding: "utf8", mode: 0o700 },
			);

			const [bin, args] = win
				? ([
						"powershell.exe",
						[
							"-NoProfile",
							"-NonInteractive",
							// The clipboard is an OLE single-threaded-apartment API; pwsh runs MTA
							// by default, where GetImage() returns null for reasons unrelated to
							// the clipboard's contents.
							"-STA",
							"-ExecutionPolicy",
							"Bypass",
							"-File",
							scriptPath,
						],
					] as const)
				: // `bash`, not `sh`: the script uses `command -v` and `set --` parsing,
					// and Debian's `sh` is dash.
					(["bash", [scriptPath, process.platform]] as const);

			this.child = spawn(bin, [...args], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			// unref the PIPES too, not just the process handle. `child.unref()` alone
			// leaves the stdout/stderr libuv handles ref'd (attaching a 'data' listener
			// resumes them), so a consumer that lets Node exit naturally — a test, an
			// embedding — would hang on this never-exiting child. The reaper kills the
			// process on exit; this lets the loop drain so exit can happen at all.
			(this.child.stdout as { unref?: () => void } | undefined)?.unref?.();
			(this.child.stderr as { unref?: () => void } | undefined)?.unref?.();
			(this.child.stdin as { unref?: () => void } | undefined)?.unref?.();
			// A worker that by design never exits must never be the reason the process
			// stays alive. This hung the whole test suite once.
			this.child.unref();
		} catch {
			this.dead = true;
			this.markReady(false);
			return;
		}

		// stderr is captured, not discarded: a worker that fails to parse says WHY here,
		// and throwing that away is how a parse error masquerades as slowness.
		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.lastError = chunk.toString("utf8").trim().slice(0, 400);
		});

		this.child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
		this.child.on("error", () => this.kill());
		this.child.on("exit", () => {
			// Settle everyone waiting, or a /paste hangs forever on a dead worker.
			for (const resolve of this.inflight.values()) resolve(EMPTY);
			this.inflight.clear();
			this.markReady(false);
			this.child = undefined;
		});
	}

	private assembler = new SnapshotAssembler();

	private consume(text: string): void {
		this.buf += text;
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			// Strip a trailing CR: PowerShell emits CRLF, the POSIX worker emits LF.
			const line = this.buf.slice(0, nl).replace(/\r$/, "");
			this.buf = this.buf.slice(nl + 1);
			const ev = this.assembler.feed(line);
			if (!ev) continue;
			if (ev.type === "ready") this.markReady(true);
			else if (ev.type === "image") this.onImage?.(ev.path);
			else {
				const resolve = this.inflight.get(ev.id);
				this.inflight.delete(ev.id);
				resolve?.(ev.snapshot); // a reply to a timed-out request simply drops
			}
		}
	}

	/**
	 * Read the ENTIRE clipboard in one round-trip, saving any image to `imageDest`.
	 *
	 * One call, one answer. The old shape asked four separate questions down four
	 * separate PowerShell spawns — which is why a paste felt like it hung.
	 */
	/** Resolves true once the worker is answering, false if it never started. */
	whenReady(): Promise<boolean> {
		return this.ready;
	}

	async snapshot(imageDest: string, timeoutMs = 5000): Promise<ClipboardSnapshot> {
		// Wait for boot. Skipping this is what made the first paste of a session time
		// out, and then handed its late reply to whoever asked next.
		if (!(await this.ready)) return EMPTY;
		if (!this.child?.stdin) return EMPTY;

		const id = this.nextId++;
		return await new Promise<ClipboardSnapshot>((resolve) => {
			const timer = setTimeout(() => {
				this.inflight.delete(id);
				resolve(EMPTY);
			}, timeoutMs);
			this.inflight.set(id, (s) => {
				clearTimeout(timer);
				resolve(s);
			});
			try {
				this.child?.stdin?.write(`SNAPSHOT|${id}|${imageDest}\n`);
			} catch {
				clearTimeout(timer);
				this.inflight.delete(id);
				resolve(EMPTY);
			}
		});
	}

	kill(): void {
		this.dead = true;
		LIVE_WORKERS.delete(this);
		if (this.scriptDir) {
			try {
				fs.rmSync(this.scriptDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
			this.scriptDir = undefined;
		}
		this.markReady(false);
		for (const resolve of this.inflight.values()) resolve(EMPTY);
		this.inflight.clear();
		try {
			this.child?.stdin?.write("EXIT\n");
			this.child?.kill();
		} catch {
			/* already gone */
		}
		this.child = undefined;
	}
}
