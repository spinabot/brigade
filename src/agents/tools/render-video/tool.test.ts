import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { RenderVideoDoctor } from "./availability.js";
import type { RenderSpec, RunResult } from "./engine.js";
import { makeRenderVideoTool, type RenderVideoDeps } from "./tool.js";

/** A structurally-valid composition (has data-composition-id + a __timelines registration). */
const VALID_HTML =
	'<div data-composition-id="x" data-width="1080" data-height="1920" data-start="0" data-track-index="0"></div>' +
	"<script>window.__timelines = { x: {} };</script>";

const okDoctor = (over: Partial<RenderVideoDoctor> = {}): RenderVideoDoctor => ({
	ready: true,
	node: { ok: true, detail: "node" },
	ffmpeg: { ok: true, detail: "ffmpeg" },
	chrome: { ok: true, detail: "chrome" },
	hyperframes: { ok: true, detail: "/pkg/@hyperframes/producer/index.js" },
	...over,
});

/** A render fake that writes a dummy MP4 to the spec's outputPath. */
const writingRender = (bytes = "FAKE-MP4"): RenderVideoDeps["run"] => {
	return async (spec: RenderSpec): Promise<RunResult> => {
		fs.writeFileSync(spec.outputPath, Buffer.from(bytes));
		return { code: 0, stdout: "progress complete\n", stderr: "" };
	};
};

async function withPinnedState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-render-tool-"));
	const prev = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
	try {
		return await fn(stateDir);
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = prev;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
}

test("makeRenderVideoTool: exposes the render_video contract", () => {
	const tool = makeRenderVideoTool();
	assert.equal(tool.name, "render_video");
	assert.equal(tool.label, "Render Video");
	assert.equal(tool.ownerOnly, true);
	assert.ok(tool.description.length > 0);
	const props = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
	assert.ok(props.properties.html && props.properties.output_name && props.properties.lint && props.properties.fps);
	assert.deepEqual(props.required, ["html"]);
});

test("render_video: missing html is rejected before any spawn", async () => {
	await assert.rejects(() => makeRenderVideoTool().execute("c", {} as never, undefined), /html/i);
});

test("render_video: absent engine returns an actionable unavailable result (no spawn)", async () => {
	const prev = process.env.BRIGADE_HYPERFRAMES_PATH;
	process.env.BRIGADE_HYPERFRAMES_PATH = "/nope/producer-does-not-exist";
	try {
		const res = await makeRenderVideoTool().execute("c", { html: VALID_HTML }, undefined);
		const d = res.details as { status?: string; ok?: boolean; errorType?: string };
		assert.equal(d.ok, false);
		assert.equal(d.errorType, "render_unavailable");
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_HYPERFRAMES_PATH;
		else process.env.BRIGADE_HYPERFRAMES_PATH = prev;
	}
});

test("render_video: happy path renders, moves to cache under state dir, emits MEDIA + progress", async () => {
	await withPinnedState(async (stateDir) => {
		const updates: string[] = [];
		const res = await makeRenderVideoTool({ run: writingRender(), doctor: () => okDoctor() }).execute(
			"c",
			{ html: VALID_HTML, output_name: "my clip!!" },
			undefined,
			(partial) => {
				const b = partial.content?.[0];
				if (b && "text" in b) updates.push(b.text);
			},
		);
		const d = res.details as { ok?: boolean; path?: string; engine?: string };
		assert.equal(d.ok, true);
		assert.equal(d.engine, "hyperframes");
		assert.ok(d.path?.endsWith("my-clip.mp4"), "sanitized output name");
		assert.ok(d.path?.startsWith(stateDir), "cache stays under the pinned state dir");
		assert.ok(fs.existsSync(d.path ?? ""));
		assert.match(res.content.map((c) => ("text" in c ? c.text : "")).join("\n"), /MEDIA:.*my-clip\.mp4/);
		assert.ok(updates.length > 0, "streamed progress via onUpdate");
	});
});

test("render_video: adversarial output_name cannot escape the cache dir", async () => {
	await withPinnedState(async (stateDir) => {
		const cacheVideo = path.join(stateDir, "cache", "video");
		for (const name of ["../../etc/passwd", "..\\..\\secret", "///", "NUL"]) {
			const res = await makeRenderVideoTool({ run: writingRender(), doctor: () => okDoctor() }).execute(
				"c",
				{ html: VALID_HTML, output_name: name },
				undefined,
			);
			const d = res.details as { ok?: boolean; path?: string };
			assert.equal(d.ok, true, `rendered for ${name}`);
			assert.equal(path.dirname(d.path ?? ""), cacheVideo, `${name} stays in cache/video`);
			assert.ok(!(d.path ?? "").includes(".."), `${name} has no traversal`);
		}
	});
});

test("render_video: omitted output_name falls back to a render-<n>.mp4 name", async () => {
	await withPinnedState(async () => {
		const res = await makeRenderVideoTool({ run: writingRender(), doctor: () => okDoctor() }).execute(
			"c",
			{ html: VALID_HTML },
			undefined,
		);
		assert.match(path.basename((res.details as { path?: string }).path ?? ""), /^render-\d+\.mp4$/);
	});
});

test("render_video: chrome soft-gap still renders, appends a note", async () => {
	await withPinnedState(async () => {
		const res = await makeRenderVideoTool({
			run: writingRender(),
			doctor: () => okDoctor({ chrome: { ok: false, detail: "no system Chrome found" } }),
		}).execute("c", { html: VALID_HTML }, undefined);
		assert.equal((res.details as { ok?: boolean }).ok, true);
		assert.match(res.content.map((c) => ("text" in c ? c.text : "")).join("\n"), /\(note: no system Chrome/);
	});
});

test("render_video: invalid composition (missing __timelines) is rejected before render", async () => {
	let ran = false;
	const run: RenderVideoDeps["run"] = async (spec) => {
		ran = true;
		fs.writeFileSync(spec.outputPath, Buffer.from("X"));
		return { code: 0, stdout: "", stderr: "" };
	};
	const res = await makeRenderVideoTool({ run, doctor: () => okDoctor() }).execute(
		"c",
		{ html: '<div data-composition-id="x"></div>' }, // no window.__timelines
		undefined,
	);
	const d = res.details as { ok?: boolean; errorType?: string };
	assert.equal(d.errorType, "composition_invalid");
	assert.equal(ran, false, "no render subprocess for an invalid composition");
	assert.match(res.content.map((c) => ("text" in c ? c.text : "")).join("\n"), /window\.__timelines/);
});

test("render_video: missing data-composition-id is rejected", async () => {
	const res = await makeRenderVideoTool({ run: writingRender(), doctor: () => okDoctor() }).execute(
		"c",
		{ html: "<div></div><script>window.__timelines={};</script>" },
		undefined,
	);
	assert.equal((res.details as { errorType?: string }).errorType, "composition_invalid");
});

test("render_video: lint:false skips validation and renders anyway", async () => {
	await withPinnedState(async () => {
		const res = await makeRenderVideoTool({ run: writingRender(), doctor: () => okDoctor() }).execute(
			"c",
			{ html: "<div></div>", lint: false }, // structurally invalid, but validation skipped
			undefined,
		);
		assert.equal((res.details as { ok?: boolean }).ok, true);
	});
});

test("render_video: render timeout is reported (billed-render-safe)", async () => {
	await withPinnedState(async () => {
		const run: RenderVideoDeps["run"] = async () => ({
			code: null,
			stdout: "",
			stderr: "",
			killReason: "overall-timeout",
		});
		const res = await makeRenderVideoTool({ run, doctor: () => okDoctor() }).execute(
			"c",
			{ html: VALID_HTML },
			undefined,
		);
		const d = res.details as { errorType?: string; killReason?: string };
		assert.equal(d.errorType, "render_timeout");
		assert.equal(d.killReason, "overall-timeout");
	});
});

test("render_video: exit 0 but no output file → render_failed", async () => {
	await withPinnedState(async () => {
		const run: RenderVideoDeps["run"] = async () => ({ code: 0, stdout: "", stderr: "" }); // writes nothing
		const res = await makeRenderVideoTool({ run, doctor: () => okDoctor() }).execute(
			"c",
			{ html: VALID_HTML },
			undefined,
		);
		assert.equal((res.details as { errorType?: string }).errorType, "render_failed");
	});
});

test("render_video: non-zero render exit → render_failed with scrubbed temp path", async () => {
	await withPinnedState(async () => {
		const run: RenderVideoDeps["run"] = async (spec) => ({
			code: 1,
			stdout: "",
			stderr: `render error in ${path.dirname(spec.outputPath)}\\index.html`,
		});
		const res = await makeRenderVideoTool({ run, doctor: () => okDoctor() }).execute(
			"c",
			{ html: VALID_HTML },
			undefined,
		);
		const text = res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
		assert.equal((res.details as { errorType?: string }).errorType, "render_failed");
		assert.ok(!/brigade-render-video-/.test(text), "temp workDir path must be scrubbed");
		assert.match(text, /<composition>/);
	});
});

test("render_video: engine spawn failure → render_unavailable with install hint", async () => {
	await withPinnedState(async () => {
		const run: RenderVideoDeps["run"] = async () => {
			throw new Error("spawn ENOENT");
		};
		const res = await makeRenderVideoTool({ run, doctor: () => okDoctor() }).execute(
			"c",
			{ html: VALID_HTML },
			undefined,
		);
		assert.equal((res.details as { errorType?: string }).errorType, "render_unavailable");
		const text = res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
		// The hint must name the command that WORKS. It used to say `npm i
		// @hyperframes/producer`, which — run from a global install — walks up to the
		// operator's home directory and puts the engine where Brigade never resolves it.
		// An agent read that hint and did exactly that.
		assert.match(text, /brigade video install/);
		assert.match(text, /do NOT `npm i`/, "and it must warn against the thing that broke");
	});
});

test("render_video: oversized HTML is rejected before spawning", async () => {
	const res = await makeRenderVideoTool({ run: writingRender(), doctor: () => okDoctor() }).execute(
		"c",
		{ html: "x".repeat(2_000_001) },
		undefined,
	);
	const d = res.details as { ok?: boolean; errorType?: string };
	assert.equal(d.ok, false);
	assert.equal(d.errorType, "composition_invalid");
});
