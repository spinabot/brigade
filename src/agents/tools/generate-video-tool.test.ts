import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { makeGenerateVideoTool, findVideoUrl, downloadVideo } from "./generate-video-tool.js";

let outDir: string;
beforeEach(() => {
	outDir = mkdtempSync(join(tmpdir(), "brigade-video-"));
});
afterEach(() => rmSync(outDir, { recursive: true, force: true }));

/** A minimal JSON Response stand-in. */
function jsonResponse(payload: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => payload,
		text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
		arrayBuffer: async () => new ArrayBuffer(0),
		headers: { get: () => null },
	} as unknown as Response;
}

/** A minimal binary Response stand-in (the downloaded mp4 bytes). */
function bytesResponse(bytes: number[]): Response {
	return {
		ok: true,
		status: 200,
		json: async () => ({}),
		text: async () => "",
		arrayBuffer: async () => new Uint8Array(bytes).buffer,
		headers: { get: () => null },
	} as unknown as Response;
}

const MP4_DATA_URL = `data:video/mp4;base64,${Buffer.from([0x00, 0x00, 0x00, 0x18]).toString("base64")}`;

test("openrouter generate: submit → poll(completed) → /content download → saved mp4 + MEDIA", async () => {
	let submitUrl = "";
	let body: unknown;
	let polled = false;
	let downloaded = false;
	const fetchFn = (async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u === "https://openrouter.ai/api/v1/videos") {
			submitUrl = u;
			body = JSON.parse(String(init?.body));
			return jsonResponse({ id: "vid_1", polling_url: "x", status: "pending" });
		}
		if (u === "https://openrouter.ai/api/v1/videos/vid_1") {
			polled = true;
			return jsonResponse({ status: "completed" });
		}
		if (u === "https://openrouter.ai/api/v1/videos/vid_1/content?index=0") {
			downloaded = true;
			return bytesResponse([0x00, 0x00, 0x00, 0x18]);
		}
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "openrouter" ? "sk-or" : ""),
	});
	const res = await tool.execute("c1", { prompt: "a cat surfing" }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "openrouter");
	assert.equal(submitUrl, "https://openrouter.ai/api/v1/videos");
	assert.equal((body as { prompt?: string }).prompt, "a cat surfing");
	assert.ok(polled && downloaded, "polled the job + downloaded /content");
	const saved = res.details.path!;
	assert.ok(saved.endsWith(".mp4"));
	assert.ok(existsSync(saved));
	const first = res.content[0];
	assert.ok(first?.type === "text" && first.text.includes(`MEDIA:${saved}`));
});

test("fal: submit → poll(COMPLETED) → response_url → download mp4", async () => {
	const calls: string[] = [];
	let pollCount = 0;
	const fetchFn = (async (url: string, init?: RequestInit) => {
		const u = String(url);
		calls.push(u);
		if (u === "https://queue.fal.run/fal-ai/wan/v2.2-a14b/text-to-video") {
			// Authorization must be `Key …`, not Bearer.
			const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
			assert.ok(auth.startsWith("Key "), `expected "Key …" auth, got "${auth}"`);
			return jsonResponse({
				status_url: "https://queue.fal.run/status/abc",
				response_url: "https://queue.fal.run/response/abc",
				request_id: "abc",
			});
		}
		if (u === "https://queue.fal.run/status/abc") {
			pollCount += 1;
			return jsonResponse({ status: pollCount >= 2 ? "COMPLETED" : "IN_PROGRESS" });
		}
		if (u === "https://queue.fal.run/response/abc") {
			return jsonResponse({ video: { url: "https://cdn.fal/out.mp4" } });
		}
		if (u === "https://cdn.fal/out.mp4") {
			return bytesResponse([1, 2, 3, 4]);
		}
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "fal" ? "fal-key" : ""),
	});
	const res = await tool.execute("c1", { prompt: "waves", provider: "fal" }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "fal");
	assert.ok(pollCount >= 2, "should have polled until COMPLETED");
	assert.ok(calls.includes("https://cdn.fal/out.mp4"), "should have downloaded the final url");
	const saved = res.details.path!;
	assert.ok(saved.endsWith(".mp4"));
	assert.equal(readFileSync(saved).length, 4);
});

test("explicit provider override hits the right submit URL (runway)", async () => {
	let submitUrl = "";
	const fetchFn = (async (url: string) => {
		const u = String(url);
		if (u.endsWith("/v1/text_to_video")) {
			submitUrl = u;
			return jsonResponse({ id: "task_1" });
		}
		if (u.includes("/v1/tasks/task_1")) {
			return jsonResponse({ status: "SUCCEEDED", output: ["https://cdn.runway/clip.mp4"] });
		}
		if (u === "https://cdn.runway/clip.mp4") return bytesResponse([9, 9]);
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({ fetchFn, outDirOverride: outDir, pollIntervalMs: 1, resolveKey: () => "key" });
	const res = await tool.execute("c1", { prompt: "a sunset", provider: "runway" }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "runway");
	assert.equal(submitUrl, "https://api.dev.runwayml.com/v1/text_to_video");
});

test("image given to runway switches to the image_to_video endpoint", async () => {
	// Write a tiny local image file to feed as the seed frame.
	const imgPath = join(outDir, "seed.png");
	writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	let submitUrl = "";
	let submitBody: Record<string, unknown> = {};
	const fetchFn = (async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.endsWith("/v1/image_to_video")) {
			submitUrl = u;
			submitBody = JSON.parse(String(init?.body));
			return jsonResponse({ id: "task_2" });
		}
		if (u.includes("/v1/tasks/task_2")) return jsonResponse({ status: "SUCCEEDED", output: ["https://cdn.runway/i.mp4"] });
		if (u === "https://cdn.runway/i.mp4") return bytesResponse([1]);
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({ fetchFn, outDirOverride: outDir, pollIntervalMs: 1, resolveKey: () => "key" });
	const res = await tool.execute("c1", { prompt: "animate", provider: "runway", image: imgPath }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(submitUrl, "https://api.dev.runwayml.com/v1/image_to_video");
	assert.ok(String(submitBody.promptImage).startsWith("data:image/png;base64,"), "image should be a png data URL");
});

test("auto-select preference: openrouter before fal", async () => {
	const fetchFn = (async (url: string) => {
		const u = String(url);
		if (u.endsWith("/content?index=0")) return bytesResponse([1, 2, 3]);
		if (u.includes("/api/v1/videos/")) return jsonResponse({ status: "completed" });
		return jsonResponse({ id: "j1", status: "pending" }); // submit
	}) as unknown as typeof fetch;
	// Both openrouter + fal keyed → openrouter wins (preference order).
	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "openrouter" || p === "fal" ? "key" : ""),
	});
	const res = await tool.execute("c1", { prompt: "hi" }, undefined as never);
	assert.equal(res.details.provider, "openrouter");
});

test("no key configured → ok:false with a clear message, no file written", async () => {
	const fetchFn = (async () => jsonResponse({})) as unknown as typeof fetch;
	const tool = makeGenerateVideoTool({ fetchFn, outDirOverride: outDir, pollIntervalMs: 1, resolveKey: () => "" });
	const res = await tool.execute("c1", { prompt: "hi" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /no video provider|configured/i);
});

test("empty prompt → ok:false", async () => {
	const tool = makeGenerateVideoTool({ outDirOverride: outDir, pollIntervalMs: 1, resolveKey: () => "key" });
	const res = await tool.execute("c1", { prompt: "   " }, undefined as never);
	assert.equal(res.details.ok, false);
});

test("action=list reports configured providers", async () => {
	const tool = makeGenerateVideoTool({
		outDirOverride: outDir,
		resolveKey: (p) => (p === "openrouter" || p === "minimax" ? "k" : ""),
	});
	const res = await tool.execute("c1", { action: "list" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.deepEqual(res.details.providers, ["openrouter", "minimax"]);
});

test("FAILED poll status → ok:false", async () => {
	let pollCount = 0;
	const fetchFn = (async (url: string) => {
		const u = String(url);
		if (u === "https://queue.fal.run/fal-ai/wan/v2.2-a14b/text-to-video") {
			return jsonResponse({ status_url: "https://queue.fal.run/status/x", response_url: "https://queue.fal.run/response/x" });
		}
		if (u === "https://queue.fal.run/status/x") {
			pollCount += 1;
			return jsonResponse({ status: "FAILED" });
		}
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "fal" ? "k" : ""),
	});
	const res = await tool.execute("c1", { prompt: "x", provider: "fal" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /FAILED/i);
	assert.equal(pollCount, 1, "should stop polling on FAILED");
});

test("HTTP error on submit → ok:false, message carries the status", async () => {
	const fetchFn = (async () => jsonResponse("bad key", false, 401)) as unknown as typeof fetch;
	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "openrouter" ? "k" : ""),
	});
	const res = await tool.execute("c1", { prompt: "x" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /401/);
});

test("openrouter: submit returns {id}, poll yields a video url → downloaded", async () => {
	let pollCount = 0;
	const fetchFn = (async (url: string) => {
		const u = String(url);
		if (u === "https://openrouter.ai/api/v1/videos") return jsonResponse({ id: "job_77", status: "pending" });
		if (u === "https://openrouter.ai/api/v1/videos/job_77") {
			pollCount += 1;
			return pollCount >= 2 ? jsonResponse({ status: "completed" }) : jsonResponse({ status: "in_progress" });
		}
		if (u === "https://openrouter.ai/api/v1/videos/job_77/content?index=0") return bytesResponse([7, 7, 7]);
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "openrouter" ? "k" : ""),
	});
	const res = await tool.execute("c1", { prompt: "poll me" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.ok(pollCount >= 2, "should have polled the job by id");
	assert.equal(readFileSync(res.details.path!).length, 3);
});

test("byteplus: submit → poll(succeeded) → content.video_url → download mp4", async () => {
	let submitUrl = "";
	let submitBody: Record<string, unknown> = {};
	let pollCount = 0;
	let downloaded = false;
	const fetchFn = (async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u === "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks") {
			submitUrl = u;
			submitBody = JSON.parse(String(init?.body));
			const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
			assert.ok(auth.startsWith("Bearer "), `expected Bearer auth, got "${auth}"`);
			return jsonResponse({ id: "task_bp" });
		}
		if (u === "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/task_bp") {
			pollCount += 1;
			return pollCount >= 2
				? jsonResponse({ status: "succeeded", content: { video_url: "https://cdn.byteplus/out.mp4" } })
				: jsonResponse({ status: "running" });
		}
		if (u === "https://cdn.byteplus/out.mp4") {
			downloaded = true;
			return bytesResponse([1, 2, 3, 4]);
		}
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "byteplus" ? "bp-key" : ""),
	});
	const res = await tool.execute("c1", { prompt: "a dragon", provider: "byteplus" }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "byteplus");
	assert.equal(submitUrl, "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks");
	assert.equal((submitBody.content as Array<{ text?: string }>)[0]?.text, "a dragon");
	assert.ok(pollCount >= 2 && downloaded, "polled until succeeded + downloaded");
	const saved = res.details.path!;
	assert.ok(saved.endsWith(".mp4"));
	assert.equal(readFileSync(saved).length, 4);
});

test("alibaba: async submit (X-DashScope-Async) → poll(SUCCEEDED) → results[0].video_url → download", async () => {
	let submitUrl = "";
	let asyncHeader = "";
	let pollCount = 0;
	const fetchFn = (async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u === "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis") {
			submitUrl = u;
			asyncHeader = (init?.headers as Record<string, string> | undefined)?.["X-DashScope-Async"] ?? "";
			return jsonResponse({ output: { task_id: "ali_1" } });
		}
		if (u === "https://dashscope-intl.aliyuncs.com/api/v1/tasks/ali_1") {
			pollCount += 1;
			return pollCount >= 2
				? jsonResponse({ output: { task_status: "SUCCEEDED", results: [{ video_url: "https://cdn.ali/v.mp4" }] } })
				: jsonResponse({ output: { task_status: "RUNNING" } });
		}
		if (u === "https://cdn.ali/v.mp4") return bytesResponse([5, 6, 7]);
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "alibaba" ? "ali-key" : ""),
	});
	const res = await tool.execute("c1", { prompt: "a river", provider: "alibaba" }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "alibaba");
	assert.equal(submitUrl, "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis");
	assert.equal(asyncHeader, "enable", "must send X-DashScope-Async: enable on submit");
	assert.ok(pollCount >= 2, "polled until SUCCEEDED");
	const saved = res.details.path!;
	assert.ok(saved.endsWith(".mp4"));
	assert.equal(readFileSync(saved).length, 3);
});

test("together: submit → poll(completed) → outputs[0].video_url → download mp4", async () => {
	let submitUrl = "";
	let pollCount = 0;
	const fetchFn = (async (url: string) => {
		const u = String(url);
		if (u === "https://api.together.xyz/v1/videos") {
			submitUrl = u;
			return jsonResponse({ id: "tg_1" });
		}
		if (u === "https://api.together.xyz/v1/videos/tg_1") {
			pollCount += 1;
			return pollCount >= 2
				? jsonResponse({ status: "completed", outputs: [{ video_url: "https://cdn.together/clip.mp4" }] })
				: jsonResponse({ status: "in_progress" });
		}
		if (u === "https://cdn.together/clip.mp4") return bytesResponse([8, 8]);
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "together" ? "tg-key" : ""),
	});
	const res = await tool.execute("c1", { prompt: "a forest", provider: "together" }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "together");
	assert.equal(submitUrl, "https://api.together.xyz/v1/videos");
	assert.ok(pollCount >= 2, "polled until completed");
	const saved = res.details.path!;
	assert.ok(saved.endsWith(".mp4"));
	assert.equal(readFileSync(saved).length, 2);
});

test("together: outputs as a single object (not array) still resolves the url", async () => {
	const fetchFn = (async (url: string) => {
		const u = String(url);
		if (u === "https://api.together.xyz/v1/videos") return jsonResponse({ id: "tg_2" });
		if (u === "https://api.together.xyz/v1/videos/tg_2") {
			return jsonResponse({ status: "completed", outputs: { url: "https://cdn.together/single.mp4" } });
		}
		if (u === "https://cdn.together/single.mp4") return bytesResponse([3, 3, 3]);
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "together" ? "tg-key" : ""),
	});
	const res = await tool.execute("c1", { prompt: "x", provider: "together" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.equal(readFileSync(res.details.path!).length, 3);
});

test("google veo: predictLongRunning submit → operation poll(done) → uri (+key) download", async () => {
	let submitUrl = "";
	let pollUrl = "";
	let downloadUrl = "";
	let pollCount = 0;
	const fetchFn = (async (url: string) => {
		const u = String(url);
		if (u.includes(":predictLongRunning")) {
			submitUrl = u;
			return jsonResponse({ name: "operations/abc123" });
		}
		if (u.includes("/v1beta/operations/abc123")) {
			pollUrl = u;
			pollCount += 1;
			return pollCount >= 2
				? jsonResponse({
						done: true,
						response: {
							generateVideoResponse: {
								generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/xyz:download" } }],
							},
						},
					})
				: jsonResponse({ done: false });
		}
		if (u.startsWith("https://generativelanguage.googleapis.com/v1beta/files/xyz:download")) {
			downloadUrl = u;
			return bytesResponse([4, 4, 4, 4]);
		}
		throw new Error(`unexpected url ${u}`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "google" ? "g-key" : ""),
	});
	const res = await tool.execute("c1", { prompt: "a comet", provider: "google" }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "google");
	assert.ok(
		submitUrl.startsWith(
			"https://generativelanguage.googleapis.com/v1beta/models/veo-3.0-fast-generate-001:predictLongRunning?key=",
		),
		`submit URL was ${submitUrl}`,
	);
	assert.ok(pollUrl.includes("?key="), "operation poll must carry the api key");
	assert.ok(pollCount >= 2, "polled the operation until done");
	assert.ok(downloadUrl.includes("key="), "the file uri download must have the key appended");
	const saved = res.details.path!;
	assert.ok(saved.endsWith(".mp4"));
	assert.equal(readFileSync(saved).length, 4);
});

test("google veo: inline base64 sample (no uri) is decoded directly", async () => {
	const fetchFn = (async (url: string) => {
		const u = String(url);
		if (u.includes(":predictLongRunning")) return jsonResponse({ name: "operations/inline1" });
		if (u.includes("/v1beta/operations/inline1")) {
			return jsonResponse({
				done: true,
				response: {
					generateVideoResponse: {
						generatedSamples: [{ video: { bytesBase64Encoded: Buffer.from([0xaa, 0xbb, 0xcc]).toString("base64") } }],
					},
				},
			});
		}
		throw new Error(`unexpected url ${u} (inline base64 must NOT be fetched)`);
	}) as unknown as typeof fetch;

	const tool = makeGenerateVideoTool({
		fetchFn,
		outDirOverride: outDir,
		pollIntervalMs: 1,
		resolveKey: (p) => (p === "google" ? "g-key" : ""),
	});
	const res = await tool.execute("c1", { prompt: "inline", provider: "google" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.equal(readFileSync(res.details.path!).length, 3);
});

test("findVideoUrl deep-searches for data:video and …mp4 urls", () => {
	assert.equal(findVideoUrl({ a: { b: MP4_DATA_URL } }), MP4_DATA_URL);
	assert.equal(findVideoUrl({ data: [{ url: "https://x.test/out.mp4" }] }), "https://x.test/out.mp4");
	assert.equal(findVideoUrl({ nothing: "here", n: 5 }), undefined);
});

test("downloadVideo decodes a base64 data:video URL without fetching", async () => {
	const calls: string[] = [];
	const fetchFn = (async (u: string) => {
		calls.push(String(u));
		return bytesResponse([0]);
	}) as unknown as typeof fetch;
	const bytes = await downloadVideo(MP4_DATA_URL, fetchFn, "k");
	assert.equal(bytes.length, 4);
	assert.equal(calls.length, 0, "data URLs are decoded inline, never fetched");
});
