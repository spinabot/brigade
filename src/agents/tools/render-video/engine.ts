// Subprocess plumbing for the HyperFrames render engine. We drive the
// `@hyperframes/producer` pipeline (createRenderJob/executeRenderJob), which
// spins a headless Chrome (via puppeteer) + FFmpeg per render — heavy,
// occasionally hangs, can leak a browser process. Running it IN-PROCESS would
// put puppeteer/Chrome control on the gateway event loop, where a crash or leak
// takes the whole agent runtime down. So we render in an ISOLATED Node worker
// (a child `process.execPath`), exactly like Brigade isolates the `claude` CLI —
// with a hard timeout, tree-kill, and a force-settle backstop.
//
// The producer accepts a standalone HTML `inputPath` and serves it from its own
// local file server; the caller writes the composition to a temp project dir
// (index.html) and this renders it there.

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

/** No-output watchdog — reset on every stdout/stderr chunk. A render that keeps
 *  emitting progress survives; a wedged Chrome trips it and is killed. */
export const RENDER_NO_OUTPUT_TIMEOUT_MS = 180_000;
/** Absolute ceiling on a single render regardless of trickle output. */
export const RENDER_OVERALL_TIMEOUT_MS = 600_000;

/**
 * The render worker. Plain ESM (no build step): the tool writes it into the temp
 * project dir and runs it with `node`. It imports `@hyperframes/producer` by the
 * ABSOLUTE entry path the parent resolved (so module resolution works from any
 * cwd) and adapts to both published API arities:
 *   - `executeRenderJob(job, onProgress?)`            — paths carried in the job
 *   - `executeRenderJob(job, compDir, outputPath, …)` — paths passed positionally
 * argv: [node, worker, producerEntry, inputHtml, outputMp4, width, height, fps]
 */
export const RENDER_WORKER_SOURCE = `import { pathToFileURL } from "node:url";
import * as nodePath from "node:path";

const producerEntry = process.argv[2];
const inputPath = process.argv[3];
const outputPath = process.argv[4];
const width = Number(process.argv[5]) || 1920;
const height = Number(process.argv[6]) || 1080;
const fps = Number(process.argv[7]) || 30;

function emit(text) {
  try { process.stdout.write("progress " + text + "\\n"); } catch (_) {}
}

async function main() {
  const mod = await import(pathToFileURL(producerEntry).href);
  const createRenderJob = mod.createRenderJob || (mod.default && mod.default.createRenderJob);
  const executeRenderJob = mod.executeRenderJob || (mod.default && mod.default.executeRenderJob);
  if (typeof createRenderJob !== "function" || typeof executeRenderJob !== "function") {
    console.error("hyperframes producer API not found (createRenderJob/executeRenderJob)");
    process.exit(3);
  }
  const onProgress = (s) => {
    const t = typeof s === "string" ? s : (s && (s.status || s.phase || s.stage)) || "";
    if (t) emit(String(t));
  };
  const config = { inputPath, outputPath, width, height, fps, quality: "standard", format: "mp4" };
  const job = createRenderJob(config);
  if (executeRenderJob.length >= 3) {
    await executeRenderJob(job, nodePath.dirname(inputPath), outputPath, onProgress);
  } else {
    await executeRenderJob(job, onProgress);
  }
  emit("complete");
  process.exit(0);
}

main().catch((err) => {
  console.error((err && err.stack) || String(err));
  process.exit(1);
});
`;

/** Write the render worker into `dir` and return its path. */
export function writeRenderWorker(dir: string): string {
	const workerPath = path.join(dir, "render-worker.mjs");
	writeFileSync(workerPath, RENDER_WORKER_SOURCE, "utf8");
	return workerPath;
}

export interface RenderSpec {
	/** Absolute path to the resolved `@hyperframes/producer` entry module. */
	producerEntry: string;
	/** Path to the worker script (see `writeRenderWorker`). */
	workerPath: string;
	/** The composition HTML file to render. */
	inputPath: string;
	/** Where the worker writes the MP4. */
	outputPath: string;
	width: number;
	height: number;
	fps: number;
}

/** Args for the render worker (see `RENDER_WORKER_SOURCE`). */
export function buildWorkerArgs(spec: RenderSpec): string[] {
	return [
		spec.workerPath,
		spec.producerEntry,
		spec.inputPath,
		spec.outputPath,
		String(spec.width),
		String(spec.height),
		String(spec.fps),
	];
}

/** After a hard kill, how long to wait for the child's `close` before forcing
 *  the promise to settle. Windows can fail to emit `close` after a tree-kill of
 *  a wedged Chrome; without this backstop the render promise would hang until
 *  the tool's outer watchdog fires minutes later. */
const KILL_TREE_SETTLE_MS = 5_000;

/**
 * Kill the render subprocess AND its descendants. The worker forks puppeteer's
 * Chrome (which itself forks renderer/GPU children) plus FFmpeg — `child.kill()`
 * alone signals only the top process and orphans the browser tree, leaking real
 * memory. On Windows `taskkill /T` walks the tree; on POSIX the child is a
 * process-group leader (spawned `detached`) so a negative-pid signal hits the
 * whole group. We always also signal the direct child (belt-and-suspenders, and
 * so test doubles without a real pid still settle).
 */
function killProcessTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid !== undefined && process.platform === "win32") {
		try {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			// A spawn failure (taskkill missing/blocked) emits an ASYNC 'error';
			// with no listener Node would throw and crash the gateway. Swallow it.
			killer.on("error", () => {});
			killer.unref?.();
		} catch {
			/* fall through to the direct kill below */
		}
	} else if (pid !== undefined) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			/* group may already be gone — direct kill below */
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		/* already exited */
	}
}

export type RunKillReason = "no-output-timeout" | "overall-timeout" | "aborted";

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	killReason?: RunKillReason;
}

export interface RunOptions {
	signal?: AbortSignal;
	noOutputTimeoutMs?: number;
	overallTimeoutMs?: number;
	/** Best-effort progress lines (raw stdout lines) as the render streams. */
	onProgress?: (line: string) => void;
	/** Injectable spawn for tests. */
	spawnFn?: typeof spawn;
	/** cwd for the child — the temp project dir. */
	cwd?: string;
}

const OUT_CAP = 32_000;

/**
 * Spawn a child and run it to completion, streaming progress and enforcing both
 * watchdogs. Never rejects on a non-zero exit — the caller inspects `code` /
 * `killReason` / `stderr`. Rejects only if the process can't be spawned at all.
 */
function spawnWithWatchdogs(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
	const doSpawn = opts.spawnFn ?? spawn;
	const noOutputMs = opts.noOutputTimeoutMs ?? RENDER_NO_OUTPUT_TIMEOUT_MS;
	const overallMs = opts.overallTimeoutMs ?? RENDER_OVERALL_TIMEOUT_MS;

	return new Promise<RunResult>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let stdoutBuf = "";
		let killReason: RunKillReason | undefined;
		let settled = false;

		let noOutputTimer: NodeJS.Timeout | undefined;
		let overallTimer: NodeJS.Timeout | undefined;
		let settleTimer: NodeJS.Timeout | undefined;
		const clearTimers = (): void => {
			if (noOutputTimer) clearTimeout(noOutputTimer);
			if (overallTimer) clearTimeout(overallTimer);
			if (settleTimer) clearTimeout(settleTimer);
		};

		const flushProgress = (): void => {
			if (opts.onProgress && stdoutBuf.trim()) opts.onProgress(stdoutBuf.trim());
			stdoutBuf = "";
		};
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimers();
			flushProgress();
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, killReason });
		};

		let child: ChildProcess;
		try {
			child = doSpawn(command, args, {
				cwd: opts.cwd ?? path.resolve(process.env.TEMP ?? process.env.TMPDIR ?? "."),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				// POSIX: make the child a process-group leader so a kill takes down
				// the whole Chrome/FFmpeg tree (see killProcessTree). Windows uses
				// taskkill /T instead.
				detached: process.platform !== "win32",
			});
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		const kill = (reason: RunKillReason): void => {
			if (settled || killReason) return;
			killReason = reason;
			killProcessTree(child);
			// Backstop: if the (hard-killed) child never emits `close`, force the
			// promise to settle so it can't hang. `finish` no-ops once settled.
			settleTimer = setTimeout(() => finish(null), KILL_TREE_SETTLE_MS);
			settleTimer.unref?.();
		};
		const armNoOutput = (): void => {
			if (noOutputTimer) clearTimeout(noOutputTimer);
			noOutputTimer = setTimeout(() => kill("no-output-timeout"), noOutputMs);
			noOutputTimer.unref?.();
		};
		overallTimer = setTimeout(() => kill("overall-timeout"), overallMs);
		overallTimer.unref?.();
		armNoOutput();

		function onAbort(): void {
			kill("aborted");
		}
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			armNoOutput();
			if (stdout.length < OUT_CAP) stdout += chunk;
			if (opts.onProgress) {
				stdoutBuf += chunk;
				const lines = stdoutBuf.split("\n");
				stdoutBuf = lines.pop() ?? "";
				for (const line of lines) {
					const t = line.trim();
					if (t) opts.onProgress(t);
				}
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			armNoOutput();
			if (stderr.length < OUT_CAP) stderr += chunk;
		});

		child.on("close", (code) => finish(code));
		child.on("error", (err) => {
			// A post-kill teardown 'error' (EPIPE/EPERM) should honor the kill, not
			// masquerade as a spawn failure. Only a pre-settle error with no kill in
			// flight is a genuine spawn failure worth rejecting on.
			if (settled) return;
			if (killReason) {
				finish(null);
				return;
			}
			settled = true;
			clearTimers();
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			reject(err instanceof Error ? err : new Error(String(err)));
		});
	});
}

/**
 * Render a composition by running the worker under `node`. `process.execPath` is
 * always a real executable, so no shell/`.cmd`-shim handling is needed.
 */
export function runRender(spec: RenderSpec, opts: RunOptions = {}): Promise<RunResult> {
	return spawnWithWatchdogs(process.execPath, buildWorkerArgs(spec), opts);
}
