/**
 * `render_video` — render an HTML composition to a deterministic MP4 via the
 * `@hyperframes/producer` pipeline (Apache-2.0). This is the PROGRAMMATIC,
 * data-driven counterpart to `generate_video` (which calls a generative
 * text/image→video model): the producer steps a GSAP timeline frame-by-frame in
 * a headless Chrome and encodes with FFmpeg, so the same input always yields the
 * same MP4. Ideal for animated charts/dashboards, explainers, text/quote cards,
 * and branded short-form clips — things generative video can't render reliably.
 *
 * The producer renders a standalone HTML file, so this tool writes the agent's
 * composition as `index.html` in an isolated temp dir and renders it there via
 * an isolated Node worker (never in-process — headless Chrome would take the
 * gateway down on a crash). The finished MP4 is moved into Brigade's media cache
 * and returned as a `MEDIA:<path>` line the model delivers with `send_media`.
 * The composition-authoring conventions (GSAP timeline + data-attributes) live
 * in the `hyperframes` skill.
 *
 * Owner-gated like the rest of the media family: a render legitimately burns a
 * minute of CPU + RAM AND executes sender-authored HTML in a real browser, so
 * it's not something an arbitrary non-owner channel peer should be able to fire.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type } from "typebox";

import { resolveCacheDir } from "../../../config/paths.js";
import { failedTextResult, readBooleanParam, readNumberParam, readStringParam, textResult } from "../common.js";
import type { AgentToolResult, BrigadeTool } from "../types.js";
import { HYPERFRAMES_INSTALL_COMMAND, renderVideoDoctor } from "./availability.js";
import { runRender, writeRenderWorker } from "./engine.js";

/** Keep subprocess error text short in user/model-facing copy (peers cap ~200). */
const RENDER_ERROR_CHARS = 400;
/** Upper bound on the composition HTML. A self-contained composition with inlined
 *  GSAP + assets is large but not this large; beyond it is almost certainly a
 *  mistake or a self-inflicted DoS. */
const MAX_HTML_CHARS = 2_000_000;
/** Windows reserved device names — a file named after one resolves to the device. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;

const RenderVideoParams = Type.Object({
	html: Type.String({
		description:
			"The FULL, self-contained HTML composition to render. Root element needs " +
			"data-composition-id, data-width, data-height, data-start; timed children " +
			"use class=\"clip\" + data-start + data-track-index. Animation + total " +
			"duration come from a PAUSED GSAP timeline registered to " +
			"window.__timelines[<composition-id>] (see the `hyperframes` skill). Inline " +
			"GSAP (e.g. a CDN <script>) + all assets.",
	}),
	output_name: Type.Optional(
		Type.String({ description: "Base filename for the MP4 (no extension). Optional." }),
	),
	fps: Type.Optional(Type.Number({ description: "Frame rate (24, 30, or 60). Default 30." })),
	lint: Type.Optional(
		Type.Boolean({ description: "Validate the composition before rendering (default true)." }),
	),
});

/** Strip unsafe filename chars, block traversal + reserved names, cap length. */
function sanitizeName(name: string | undefined): string | null {
	if (!name) return null;
	const cleaned = name
		.replace(/\.[a-z0-9]{1,5}$/i, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 60);
	if (!cleaned || WINDOWS_RESERVED.test(cleaned)) return null;
	return cleaned;
}

/** Replace the ephemeral scratch-dir path with a friendly token so internal
 *  temp paths never leak into user/model-facing error text (Brigade copy rule). */
function scrubWorkDir(text: string, workDir: string): string {
	return text.split(workDir).join("<composition>");
}

/** Pull a positive integer `data-<attr>` from the composition, else the fallback. */
function readDimension(html: string, attr: string, fallback: number): number {
	const m = new RegExp(`data-${attr}\\s*=\\s*["']?(\\d{2,5})`, "i").exec(html);
	const n = m ? Number(m[1]) : NaN;
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Cheap structural check for the two things a HyperFrames composition MUST have.
 *  Returns a remediation string when invalid, or null when it looks well-formed. */
function validateComposition(html: string): string | null {
	const problems: string[] = [];
	if (!/data-composition-id\s*=/.test(html)) {
		problems.push("the root element needs a data-composition-id attribute");
	}
	if (!/window\.__timelines/.test(html)) {
		problems.push(
			"a PAUSED GSAP timeline must be registered to window.__timelines[<composition-id>]",
		);
	}
	return problems.length ? problems.join("; ") : null;
}

/** Test seam — inject a fake render/doctor to exercise the orchestration without
 *  a real subprocess. Both default to the real implementations. */
export interface RenderVideoDeps {
	run?: typeof runRender;
	doctor?: typeof renderVideoDoctor;
}

export function makeRenderVideoTool(deps: RenderVideoDeps = {}): BrigadeTool<typeof RenderVideoParams> {
	const run = deps.run ?? runRender;
	const doctorFn = deps.doctor ?? renderVideoDoctor;
	return {
		name: "render_video",
		label: "Render Video",
		displaySummary: "rendering video",
		ownerOnly: true,
		description:
			"Render an HTML composition to a deterministic MP4 (HyperFrames engine). " +
			"Use for programmatic, data-driven video — animated charts/dashboards, " +
			"explainers, text/quote cards, branded motion-graphics, short-form social " +
			"clips. NOT for photoreal/AI-generated footage (use generate_video for " +
			"that). You write the HTML composition (GSAP-timeline based — see the " +
			"`hyperframes` skill); this renders it. Returns a saved MP4 path (a " +
			"`MEDIA:` line) to hand to send_media. Requires @hyperframes/producer + " +
			"FFmpeg installed.",
		parameters: RenderVideoParams,
		async execute(_toolCallId, params, signal, onUpdate): Promise<AgentToolResult<unknown>> {
			const html = readStringParam(params, "html", { required: true, label: "html" });
			if (html.length > MAX_HTML_CHARS) {
				return failedTextResult(
					`The composition HTML is too large (${html.length} chars; limit ${MAX_HTML_CHARS}). Trim it or split into multiple clips.`,
					{ status: "failed", ok: false, errorType: "composition_invalid", htmlChars: html.length },
				);
			}
			const lint = readBooleanParam(params, "lint", { default: true });
			const outputName = readStringParam(params, "output_name") ?? readStringParam(params, "output");
			const fps = Math.min(120, Math.max(1, Math.round(readNumberParam(params, "fps") ?? DEFAULT_FPS)));

			// Dependency gate — clear, actionable remediation before spawning anything.
			const doctor = doctorFn();
			if (!doctor.node.ok || !doctor.hyperframes.ok || !doctor.ffmpeg.ok) {
				const missing = [
					doctor.node.ok ? null : doctor.node.detail,
					doctor.hyperframes.ok ? null : doctor.hyperframes.detail,
					doctor.ffmpeg.ok ? null : doctor.ffmpeg.detail,
				].filter((x): x is string => Boolean(x));
				return failedTextResult(`render_video is unavailable:\n- ${missing.join("\n- ")}`, {
					status: "failed",
					ok: false,
					errorType: "render_unavailable",
					missing,
				});
			}
			// The doctor resolved the producer entry into `hyperframes.detail`.
			const producerEntry = doctor.hyperframes.detail;

			// Cheap structural validation (no subprocess) so obvious mistakes come
			// back instantly instead of after a minute of failed rendering.
			if (lint) {
				const problem = validateComposition(html);
				if (problem) {
					return failedTextResult(`Composition is not valid — fix the HTML and retry:\n${problem}`, {
						status: "failed",
						ok: false,
						errorType: "composition_invalid",
						problem,
					});
				}
			}

			// Live progress → the agent event bus (via Pi's onUpdate tee).
			const emit = (line: string): void => {
				if (!onUpdate) return;
				try {
					onUpdate({ content: [{ type: "text", text: line }], details: { status: "progress", line } });
				} catch {
					/* the caller's update channel — their bug, not ours */
				}
			};

			const workDir = mkdtempSync(path.join(tmpdir(), "brigade-render-video-"));
			const indexPath = path.join(workDir, "index.html");
			const tmpOutPath = path.join(workDir, "out.mp4");
			try {
				writeFileSync(indexPath, html, "utf8");
				const workerPath = writeRenderWorker(workDir);
				const width = readDimension(html, "width", DEFAULT_WIDTH);
				const height = readDimension(html, "height", DEFAULT_HEIGHT);

				emit("Rendering composition…");
				let res: Awaited<ReturnType<typeof runRender>>;
				try {
					res = await run(
						{ producerEntry, workerPath, inputPath: indexPath, outputPath: tmpOutPath, width, height, fps },
						{ signal, cwd: workDir, onProgress: emit },
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return failedTextResult(
						`Could not start the render engine (${message}). Install it with \`${HYPERFRAMES_INSTALL_COMMAND}\` — ` +
							"do NOT `npm i` it yourself; npm would install it where Brigade cannot find it.",
						{ status: "failed", ok: false, errorType: "render_unavailable", error: message },
					);
				}
				if (res.killReason) {
					return failedTextResult(
						res.killReason === "aborted"
							? "Render aborted."
							: "Render exceeded its time budget and was stopped.",
						{ status: "failed", ok: false, errorType: "render_timeout", killReason: res.killReason },
					);
				}
				if (res.code !== 0 || !existsSync(tmpOutPath) || statSync(tmpOutPath).size === 0) {
					const detailMsg = scrubWorkDir(
						(res.stderr || res.stdout || "no output produced").slice(-RENDER_ERROR_CHARS),
						workDir,
					);
					return failedTextResult(`Render failed (exit ${res.code ?? "?"}):\n${detailMsg}`, {
						status: "failed",
						ok: false,
						errorType: "render_failed",
						code: res.code,
					});
				}

				// Move the finished MP4 into Brigade's shared media cache. Guard the
				// move: a locked/mid-copy destination must not throw a raw temp-path
				// error out of execute or leave a partial file in the cache.
				const outDir = path.join(resolveCacheDir(), "video");
				mkdirSync(outDir, { recursive: true });
				const finalPath = path.join(
					outDir,
					`${sanitizeName(outputName) ?? `render-${process.hrtime.bigint()}`}.mp4`,
				);
				try {
					try {
						renameSync(tmpOutPath, finalPath);
					} catch {
						copyFileSync(tmpOutPath, finalPath);
					}
				} catch (err) {
					try {
						rmSync(finalPath, { force: true });
					} catch {
						/* nothing to clean */
					}
					const message = scrubWorkDir(err instanceof Error ? err.message : String(err), workDir);
					return failedTextResult(`Rendered the video but could not save it: ${message}`, {
						status: "failed",
						ok: false,
						errorType: "render_failed",
					});
				}

				const bytes = statSync(finalPath).size;
				const mb = (bytes / 1024 / 1024).toFixed(1);
				const chromeNote = doctor.chrome.ok ? "" : `\n(note: ${doctor.chrome.detail})`;
				return textResult(
					`Rendered the composition to MP4 (${mb} MB).\nMEDIA:${finalPath}\nDeliver with send_media({path}) — rendering does not auto-send.${chromeNote}`,
					{ action: "render", ok: true, path: finalPath, bytes, engine: "hyperframes" },
				);
			} finally {
				try {
					rmSync(workDir, { recursive: true, force: true });
				} catch {
					/* leave for the OS temp reaper */
				}
			}
		},
	};
}
