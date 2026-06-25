/**
 * Tests for the `analyze_media` tool.
 *
 * Coverage (per the build spec):
 *   - image → image content block (+ text-only model → clear "no image" message)
 *   - pdf → extracted text (real unpdf path, hand-built minimal PDF) + `pages` range
 *   - docx / pptx / xlsx → extracted text (real fflate unzip of real OOXML zips)
 *   - html → markdown (real readability/regex extractor)
 *   - video → clear "needs a video-capable model" message (returned: none)
 *   - URL source → routed through the SSRF guard (private IP refused)
 *   - local path outside allowed roots → rejected
 *   - unsupported / empty → clean error
 *
 * No network and no real model calls: URL/local byte acquisition is injected
 * via the tool's test seams (`acquireUrl` / `acquireLocal`); the SSRF + path
 * guards are exercised against the REAL guard functions in dedicated tests.
 * The document extractors run for real against in-memory fixtures (unpdf and
 * fflate are local, model-free libraries).
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { zipSync, strToU8 } from "fflate";
import { Value } from "typebox/value";

import {
	makeAnalyzeMediaTool,
	detectKind,
	extensionOf,
	parsePageRange,
	modelLikelySeesImages,
	DEFAULT_IMAGE_MAX_BYTES,
	type AnalyzeMediaDetails,
	type MakeAnalyzeMediaToolOptions,
} from "./analyze-media-tool.js";
import type { AgentToolResult } from "./types.js";
import type {
	MediaUnderstandingConfig,
	RunMediaUnderstandingRequest,
	RunMediaUnderstandingResult,
} from "../media-understanding/index.js";

/* ─────────────────────────── helpers ─────────────────────────── */

type Result = AgentToolResult<AnalyzeMediaDetails>;

/**
 * Build a tool whose byte acquisition is stubbed to return `bytes` + `mime`.
 * Extra options (model context, a stubbed understanding runner / config) are
 * merged so routing tests can mock the provider layer without real HTTP.
 */
function toolWithBytes(
	bytes: Buffer,
	mime?: string,
	modelContext?: { provider?: string; modelId?: string; imageInput?: boolean },
	extra?: Partial<MakeAnalyzeMediaToolOptions>,
) {
	return makeAnalyzeMediaTool({
		...(modelContext ? { modelContext } : {}),
		acquireLocal: async () => ({ bytes, ...(mime ? { mime } : {}), truncated: false }),
		acquireUrl: async () => ({ bytes, ...(mime ? { mime } : {}), truncated: false }),
		// Disable the disk result cache by default so identical stub inputs across
		// tests stay isolated; the cache has its own dedicated tests below.
		resultCache: false,
		...(extra ?? {}),
	});
}

/** A media-understanding config whose key set is exactly `keyed`. */
function muCfg(keyed: Array<"google" | "anthropic">): MediaUnderstandingConfig {
	return {
		resolveKey: (p) =>
			keyed.includes(p as "google" | "anthropic") ? `key-${p}` : "",
	};
}

/** A stub `runMediaUnderstanding` that records the request and returns canned text. */
function stubRunner(text: string, provider: "google" | "anthropic" = "google", model = "stub-model") {
	const calls: RunMediaUnderstandingRequest[] = [];
	const run = async (req: RunMediaUnderstandingRequest): Promise<RunMediaUnderstandingResult> => {
		calls.push(req);
		return { text, provider, model };
	};
	return { run, calls };
}

function textOf(r: Result): string {
	return r.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

function imageBlocks(r: Result) {
	return r.content.filter(
		(b): b is { type: "image"; data: string; mimeType: string } => b.type === "image",
	);
}

/** A minimal valid one-page PDF whose content stream shows "Hello PDF". */
const MINIMAL_PDF = Buffer.from(
	`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 100 700 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
trailer<</Root 1 0 R/Size 6>>
startxref
0
%%EOF`,
	"latin1",
);

/** Build a minimal .docx (zip with word/document.xml) carrying `text`. */
function buildDocx(text: string): Buffer {
	const docXml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
	const zip = zipSync({
		"[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
		"word/document.xml": strToU8(docXml),
	});
	return Buffer.from(zip);
}

/** Build a minimal .pptx with N slides; slide K text = `Slide K body`. */
function buildPptx(n: number): Buffer {
	const files: Record<string, Uint8Array> = {
		"[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
	};
	for (let i = 1; i <= n; i++) {
		const xml = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:p><a:r><a:t>Slide ${i} body</a:t></a:r></a:p></p:sld>`;
		files[`ppt/slides/slide${i}.xml`] = strToU8(xml);
	}
	return Buffer.from(zipSync(files));
}

/** Build a minimal .xlsx with one sheet + a shared-strings table. */
function buildXlsx(): Buffer {
	const sharedStrings = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
<si><t>Name</t></si><si><t>Alice</t></si></sst>`;
	const sheet = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row>
</sheetData></worksheet>`;
	return Buffer.from(
		zipSync({
			"[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
			"xl/sharedStrings.xml": strToU8(sharedStrings),
			"xl/worksheets/sheet1.xml": strToU8(sheet),
		}),
	);
}

const HTML_DOC = Buffer.from(
	`<!doctype html><html><head><title>Doc Title</title></head>
<body><article><h1>Heading One</h1><p>First paragraph of body text that is long enough to be real content for the readability extractor to keep around.</p>
<script>console.log("evil")</script></article></body></html>`,
	"utf8",
);

/* ─────────────────────────── pure-helper unit tests ─────────────────────────── */

describe("analyze_media — kind detection", () => {
	it("detects by extension (path + URL)", () => {
		assert.equal(detectKind({ source: "/a/b/photo.JPG" }), "image");
		assert.equal(detectKind({ source: "report.pdf" }), "pdf");
		assert.equal(detectKind({ source: "deck.pptx" }), "pptx");
		assert.equal(detectKind({ source: "sheet.xlsx" }), "xlsx");
		assert.equal(detectKind({ source: "doc.docx" }), "docx");
		assert.equal(detectKind({ source: "https://x.com/page.html?q=1" }), "html");
		assert.equal(detectKind({ source: "clip.mp4" }), "video");
	});

	it("falls back to MIME when extension is missing", () => {
		assert.equal(detectKind({ source: "https://x.com/dl", mime: "application/pdf" }), "pdf");
		assert.equal(detectKind({ source: "https://x.com/dl", mime: "image/png" }), "image");
		assert.equal(detectKind({ source: "https://x.com/dl", mime: "text/html; charset=utf-8" }), "html");
		assert.equal(detectKind({ source: "https://x.com/dl", mime: "video/mp4" }), "video");
	});

	it("override wins over extension", () => {
		assert.equal(detectKind({ source: "data.bin", override: "pdf" }), "pdf");
	});

	it("returns undefined for unsupported", () => {
		assert.equal(detectKind({ source: "archive.zip" }), undefined);
		assert.equal(detectKind({ source: "https://x.com/x", mime: "application/octet-stream" }), undefined);
	});

	it("extensionOf parses path + URL", () => {
		assert.equal(extensionOf("/a/b.PNG"), "png");
		assert.equal(extensionOf("https://x.com/a/b.pdf?z=1#frag"), "pdf");
		assert.equal(extensionOf("noext"), "");
	});
});

describe("analyze_media — parsePageRange", () => {
	it("range, single, open-ended", () => {
		const r1 = parsePageRange("2-4", 10);
		assert.deepEqual([1, 2, 3, 4, 5].map(r1), [false, true, true, true, false]);
		const r2 = parsePageRange("3", 10);
		assert.deepEqual([2, 3, 4].map(r2), [false, true, false]);
		const r3 = parsePageRange("3-", 5);
		assert.deepEqual([2, 3, 4, 5].map(r3), [false, true, true, true]);
	});
	it("empty / invalid → accept all", () => {
		assert.equal(parsePageRange(undefined, 5)(3), true);
		assert.equal(parsePageRange("garbage", 5)(3), true);
	});
});

describe("analyze_media — modelLikelySeesImages", () => {
	it("explicit imageInput wins", () => {
		assert.equal(modelLikelySeesImages({ imageInput: false, modelId: "claude-opus-4-8" }), false);
		assert.equal(modelLikelySeesImages({ imageInput: true }), true);
	});
	it("infers vision families", () => {
		assert.equal(modelLikelySeesImages({ modelId: "claude-opus-4-8" }), true);
		assert.equal(modelLikelySeesImages({ modelId: "google/gemini-2.5-flash" }), true);
		assert.equal(modelLikelySeesImages({ modelId: "openai/gpt-4o" }), true);
	});
	it("flags known non-vision + unknown", () => {
		assert.equal(modelLikelySeesImages({ modelId: "openai/gpt-3.5-turbo" }), false);
		assert.equal(modelLikelySeesImages({ modelId: "some-obscure-model" }), undefined);
		assert.equal(modelLikelySeesImages(undefined), undefined);
	});
});

/* ─────────────────────────── image ─────────────────────────── */

describe("analyze_media — image", () => {
	it("returns an image content block for a vision-capable model", async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // PNG-ish
		const tool = toolWithBytes(bytes, "image/png", { modelId: "claude-opus-4-8" });
		const r = (await tool.execute("c1", { source: "/ws/pic.png", question: "what is this?" })) as Result;
		const imgs = imageBlocks(r);
		assert.equal(imgs.length, 1);
		assert.equal(imgs[0]?.mimeType, "image/png");
		assert.equal(imgs[0]?.data, bytes.toString("base64"));
		assert.equal(r.details.returned, "image");
		assert.equal(r.details.ok, true);
		// the question is echoed in the leading text block
		assert.match(textOf(r), /what is this\?/);
	});

	it("text-only model + NO provider key → does NOT attach an image, returns a clear message", async () => {
		const bytes = Buffer.from([1, 2, 3, 4]);
		// No runner/config provided AND no real keys: the lazily-built config
		// resolves no key, so the provider path is unavailable → honest message.
		const tool = toolWithBytes(bytes, "image/png", { imageInput: false, modelId: "text-only-model" }, {
			mediaUnderstandingConfig: muCfg([]),
		});
		const r = (await tool.execute("c1", { source: "/ws/pic.png" })) as Result;
		assert.equal(imageBlocks(r).length, 0);
		assert.equal(r.details.returned, "none");
		assert.equal(r.details.ok, false);
		assert.match(textOf(r), /does not appear to accept images|vision-capable/i);
	});

	it("text-only model + provider key → understands the image via the provider (returns TEXT, no block)", async () => {
		const bytes = Buffer.from([1, 2, 3, 4]);
		const { run, calls } = stubRunner("A blue circle on white.", "anthropic", "claude-sonnet-4-5");
		const tool = toolWithBytes(bytes, "image/png", { imageInput: false, modelId: "text-only-model" }, {
			mediaUnderstandingConfig: muCfg(["anthropic"]),
			runMediaUnderstanding: run,
		});
		const r = (await tool.execute("c1", { source: "/ws/pic.png", question: "what is this?" })) as Result;
		assert.equal(imageBlocks(r).length, 0, "no image block for a text-only model");
		assert.equal(r.details.returned, "text");
		assert.equal(r.details.ok, true);
		assert.equal(r.details.provider, "anthropic");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.kind, "image");
		assert.match(textOf(r), /A blue circle on white\./);
		// provider output is wrapped in the untrusted-content envelope
		assert.match(textOf(r), /EXTERNAL_UNTRUSTED_CONTENT/);
	});

	it("warns on HEIC pass-through", async () => {
		const tool = toolWithBytes(Buffer.from([1, 2, 3]), "image/heic", { modelId: "claude-opus-4-8" });
		const r = (await tool.execute("c1", { source: "/ws/pic.heic" })) as Result;
		assert.equal(imageBlocks(r).length, 1, "HEIC still attached (model may reject)");
		assert.match(textOf(r), /HEIC/i);
	});

	it("notes uncertainty when model capability is unknown", async () => {
		const tool = toolWithBytes(Buffer.from([1, 2, 3]), "image/png", { modelId: "mystery-model-x" });
		const r = (await tool.execute("c1", { source: "/ws/pic.png" })) as Result;
		assert.equal(imageBlocks(r).length, 1);
		assert.match(textOf(r), /could not confirm/i);
	});
});

/* ─────────────────────────── pdf ─────────────────────────── */

describe("analyze_media — pdf", () => {
	it("extracts text (real unpdf path) when NO provider key is configured", async () => {
		const tool = toolWithBytes(MINIMAL_PDF, "application/pdf", undefined, {
			mediaUnderstandingConfig: muCfg([]),
		});
		const r = (await tool.execute("c1", { source: "/ws/report.pdf", question: "summarize" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.returned, "text");
		assert.equal(r.details.kind, "pdf");
		assert.equal(r.details.provider, undefined, "local path, no provider");
		const t = textOf(r);
		assert.match(t, /Hello PDF/);
		assert.match(t, /Page 1/);
		assert.match(t, /summarize/);
		// document text is wrapped in the untrusted-content envelope
		assert.match(t, /EXTERNAL_UNTRUSTED_CONTENT/);
	});

	it("honors a `pages` range that selects nothing → clean empty error (text mode)", async () => {
		const tool = toolWithBytes(MINIMAL_PDF, "application/pdf", undefined, {
			mediaUnderstandingConfig: muCfg([]),
		});
		// page 5 of a 1-page doc → no text selected
		const r = (await tool.execute("c1", { source: "/ws/report.pdf", pages: "5" })) as Result;
		assert.equal(r.details.ok, false);
		assert.match(textOf(r), /No selectable text|scanned image/i);
	});

	it("sends the PDF NATIVELY to the provider when a key is configured (scanned PDFs work)", async () => {
		// A buffer that unpdf could not read as a PDF — proves the provider path
		// does NOT depend on a text layer (i.e. scanned-PDF support).
		const scanned = Buffer.from("NOT-A-REAL-PDF-TEXT-LAYER");
		const { run, calls } = stubRunner("Invoice total: $1,200.", "anthropic", "claude-sonnet-4-5");
		const tool = toolWithBytes(scanned, "application/pdf", undefined, {
			mediaUnderstandingConfig: muCfg(["anthropic"]),
			runMediaUnderstanding: run,
		});
		const r = (await tool.execute("c1", { source: "/ws/scan.pdf", question: "total?" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.returned, "text");
		assert.equal(r.details.provider, "anthropic");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.kind, "pdf");
		assert.equal(calls[0]?.mimeType, "application/pdf");
		assert.match(textOf(r), /Invoice total: \$1,200\./);
		assert.match(textOf(r), /EXTERNAL_UNTRUSTED_CONTENT/);
	});

	it("mode:'text' forces local extraction even when a provider key exists", async () => {
		const { run, calls } = stubRunner("should not be called");
		const tool = toolWithBytes(MINIMAL_PDF, "application/pdf", undefined, {
			mediaUnderstandingConfig: muCfg(["anthropic", "google"]),
			runMediaUnderstanding: run,
		});
		const r = (await tool.execute("c1", { source: "/ws/report.pdf", mode: "text" })) as Result;
		assert.equal(calls.length, 0, "provider not called in text mode");
		assert.equal(r.details.returned, "text");
		assert.match(textOf(r), /Hello PDF/);
	});

	it("mode:'provider' with no key → clean error (does not silently extract)", async () => {
		const tool = toolWithBytes(MINIMAL_PDF, "application/pdf", undefined, {
			mediaUnderstandingConfig: muCfg([]),
		});
		const r = (await tool.execute("c1", { source: "/ws/report.pdf", mode: "provider" })) as Result;
		assert.equal(r.details.ok, false);
		assert.match(textOf(r), /Anthropic or Google\/Gemini API key|needs an/i);
	});

	it("auto mode falls back to local text extraction when the provider call fails", async () => {
		const run = async (): Promise<RunMediaUnderstandingResult> => {
			throw new Error("Anthropic error: HTTP 500");
		};
		const tool = toolWithBytes(MINIMAL_PDF, "application/pdf", undefined, {
			mediaUnderstandingConfig: muCfg(["anthropic"]),
			runMediaUnderstanding: run,
		});
		const r = (await tool.execute("c1", { source: "/ws/report.pdf" })) as Result;
		// fell back to unpdf text → ok with extracted text
		assert.equal(r.details.ok, true);
		assert.equal(r.details.returned, "text");
		assert.match(textOf(r), /Hello PDF/);
	});
});

/* ─────────────────────────── docx / pptx / xlsx ─────────────────────────── */

describe("analyze_media — office documents", () => {
	it("docx → extracted text", async () => {
		const tool = toolWithBytes(buildDocx("The quarterly report body."));
		const r = (await tool.execute("c1", { source: "/ws/doc.docx" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.returned, "text");
		assert.match(textOf(r), /The quarterly report body\./);
	});

	it("pptx → per-slide text, slide-numbered", async () => {
		const tool = toolWithBytes(buildPptx(3));
		const r = (await tool.execute("c1", { source: "/ws/deck.pptx" })) as Result;
		assert.equal(r.details.ok, true);
		const t = textOf(r);
		assert.match(t, /Slide 1 ---/);
		assert.match(t, /Slide 1 body/);
		assert.match(t, /Slide 3 body/);
	});

	it("pptx honors a slide `pages` range", async () => {
		const tool = toolWithBytes(buildPptx(4));
		const r = (await tool.execute("c1", { source: "/ws/deck.pptx", pages: "2-3" })) as Result;
		const t = textOf(r);
		assert.match(t, /Slide 2 body/);
		assert.match(t, /Slide 3 body/);
		assert.ok(!/Slide 1 body/.test(t), "slide 1 excluded by range");
		assert.ok(!/Slide 4 body/.test(t), "slide 4 excluded by range");
	});

	it("xlsx → CSV-ish text resolving shared strings", async () => {
		const tool = toolWithBytes(buildXlsx());
		const r = (await tool.execute("c1", { source: "/ws/sheet.xlsx" })) as Result;
		assert.equal(r.details.ok, true);
		const t = textOf(r);
		assert.match(t, /Sheet 1 ---/);
		assert.match(t, /Name/);
		assert.match(t, /Alice/);
		assert.match(t, /42/);
	});

	it("corrupt docx → clean error (not a throw to the model)", async () => {
		const tool = toolWithBytes(Buffer.from("not a zip at all"));
		const r = (await tool.execute("c1", { source: "/ws/doc.docx" })) as Result;
		assert.equal(r.details.ok, false);
		assert.equal(r.details.returned, "none");
	});
});

/* ─────────────────────────── html ─────────────────────────── */

describe("analyze_media — html", () => {
	it("extracts markdown and drops <script>", async () => {
		const tool = toolWithBytes(HTML_DOC, "text/html");
		const r = (await tool.execute("c1", { source: "https://example.com/page.html", question: "what is the heading?" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.returned, "text");
		const t = textOf(r);
		assert.match(t, /Heading One/);
		assert.match(t, /First paragraph/);
		assert.ok(!/console\.log\("evil"\)/.test(t), "script content stripped");
		assert.match(t, /EXTERNAL_UNTRUSTED_CONTENT/);
	});
});

/* ─────────────────────────── video ─────────────────────────── */

describe("analyze_media — video", () => {
	it("routes video to the understanding provider (Gemini) and returns its TEXT", async () => {
		const { run, calls } = stubRunner("A cat plays piano for 12 seconds.", "google", "gemini-2.5-pro");
		const tool = toolWithBytes(Buffer.from([0, 0, 0, 0]), "video/mp4", undefined, {
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
		});
		const r = (await tool.execute("c1", { source: "/ws/clip.mp4", question: "what happens?" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.returned, "text");
		assert.equal(r.details.kind, "video");
		assert.equal(r.details.provider, "google");
		assert.equal(imageBlocks(r).length, 0);
		// the subsystem got the video bytes + mime + question
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.kind, "video");
		assert.equal(calls[0]?.mimeType, "video/mp4");
		assert.equal(calls[0]?.prompt, "what happens?");
		assert.match(textOf(r), /A cat plays piano/);
		assert.match(textOf(r), /EXTERNAL_UNTRUSTED_CONTENT/);
	});

	it("with NO Gemini key → returns a clear 'configure a key' message (returned: none)", async () => {
		const tool = toolWithBytes(Buffer.from([0, 0, 0, 0]), "video/mp4", undefined, {
			mediaUnderstandingConfig: muCfg([]),
		});
		const r = (await tool.execute("c1", { source: "/ws/clip.mp4", question: "what happens?" })) as Result;
		assert.equal(r.details.ok, false);
		assert.equal(r.details.returned, "none");
		assert.equal(r.details.kind, "video");
		assert.match(textOf(r), /video/i);
		assert.match(textOf(r), /Gemini API key/i);
	});

	it("derives a video MIME from the extension when none is declared", async () => {
		const { run, calls } = stubRunner("clip summary", "google");
		const tool = toolWithBytes(Buffer.from([0]), undefined, undefined, {
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
		});
		await tool.execute("c1", { source: "/ws/clip.webm" });
		assert.equal(calls[0]?.mimeType, "video/webm");
	});

	it("surfaces a provider HTTP failure as a clean error result", async () => {
		const run = async (): Promise<RunMediaUnderstandingResult> => {
			throw new Error("Gemini error: HTTP 500");
		};
		const tool = toolWithBytes(Buffer.from([0]), "video/mp4", undefined, {
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
		});
		const r = (await tool.execute("c1", { source: "/ws/clip.mp4" })) as Result;
		assert.equal(r.details.ok, false);
		assert.equal(r.details.returned, "none");
		assert.match(textOf(r), /failed/i);
	});
});

/* ─────────────────────────── unsupported / empty ─────────────────────────── */

describe("analyze_media — unsupported + bad input", () => {
	it("unsupported kind → clean error", async () => {
		const tool = toolWithBytes(Buffer.from([1, 2, 3]), "application/octet-stream");
		const r = (await tool.execute("c1", { source: "/ws/archive.zip" })) as Result;
		assert.equal(r.details.ok, false);
		assert.match(textOf(r), /Unsupported or undetectable/i);
	});

	it("empty source → input error (thrown for the model to self-correct)", async () => {
		const tool = makeAnalyzeMediaTool();
		await assert.rejects(() => tool.execute("c1", { source: "   " }), /source required/);
	});
});

/* ─────────────────────────── security: SSRF + path guard (real guards) ─────────────────────────── */

describe("analyze_media — URL routed through the SSRF guard", () => {
	it("refuses a private-IP URL via the real guarded fetch", async () => {
		// No acquireUrl seam → the REAL acquireUrlBytes runs, which calls
		// guardedFetch; a loopback/private target is refused by the SSRF guard
		// and surfaced as a clean input error (no throw of the raw SsrfBlockedError).
		const tool = makeAnalyzeMediaTool();
		await assert.rejects(
			() => tool.execute("c1", { source: "http://169.254.169.254/latest/meta-data/", kind: "html" }),
			(err: unknown) => /refused to fetch|SSRF|cloud-metadata|forbidden/i.test((err as Error).message),
		);
	});

	it("refuses localhost via the real guarded fetch", async () => {
		const tool = makeAnalyzeMediaTool();
		await assert.rejects(
			() => tool.execute("c1", { source: "http://localhost:8080/x.pdf" }),
			(err: unknown) => /refused to fetch|forbidden|SSRF/i.test((err as Error).message),
		);
	});
});

describe("analyze_media — local path guard (real guard)", () => {
	let tmpRoot: string;
	before(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-analyze-"));
	});
	after(() => {
		try {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("rejects a path outside the allowed roots", async () => {
		// A file in a dir that is NOT under workspace/cwd/cache/temp/state.
		// Use a sibling temp dir as the workspace so the target (a different
		// absolute root) is out of bounds. We avoid system files (those hit the
		// media-path guard first); this asserts the allowed-root scoping.
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-ws-"));
		const outsideDir = "C:\\Windows\\System32".replace(/\\/g, path.sep);
		const outside = path.join(path.parse(process.cwd()).root, "definitely-not-allowed", "x.pdf");
		void outsideDir;
		const tool = makeAnalyzeMediaTool({ workspaceDir: workspace, cwd: workspace });
		await assert.rejects(
			() => tool.execute("c1", { source: outside }),
			(err: unknown) => /outside the allowed roots|not found|sensitive|system file/i.test((err as Error).message),
		);
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("refuses a sensitive filename via the media-path guard", async () => {
		const tool = makeAnalyzeMediaTool({ workspaceDir: tmpRoot, cwd: tmpRoot });
		// `.env` is denied by validateOutboundMediaPath regardless of location.
		const target = path.join(tmpRoot, ".env");
		fs.writeFileSync(target, "SECRET=x");
		await assert.rejects(
			() => tool.execute("c1", { source: target, kind: "html" }),
			(err: unknown) => /sensitive|refus/i.test((err as Error).message),
		);
	});

	it("reads a file that IS under an allowed root (workspace) — happy path", async () => {
		const tool = makeAnalyzeMediaTool({ workspaceDir: tmpRoot, cwd: tmpRoot });
		const target = path.join(tmpRoot, "page.html");
		fs.writeFileSync(target, "<html><body><h1>Local Heading</h1><p>Body content here that is sufficiently long.</p></body></html>");
		const r = (await tool.execute("c1", { source: target })) as Result;
		assert.equal(r.details.ok, true);
		assert.match(textOf(r), /Local Heading/);
	});
});

/* ─────────── convex-mode inbound media root (the Convex break fix) ─────────── */

describe("analyze_media — convex-mode OS-cache channel root is allowed", () => {
	let cacheRoot: string;
	let prevCacheDir: string | undefined;
	before(() => {
		cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-oscache-"));
		// `resolveOsCacheDir()` honours BRIGADE_CACHE_DIR — point it at our temp so
		// the allowed-root computation includes a dir we control. This simulates
		// convex mode, where inbound channel media lands under
		// `resolveOsCacheDir()/channels/<id>/...` (and BlueBubbles under
		// `resolveOsCacheDir()/bluebubbles/...`) instead of ~/.brigade.
		prevCacheDir = process.env.BRIGADE_CACHE_DIR;
		process.env.BRIGADE_CACHE_DIR = cacheRoot;
	});
	after(() => {
		if (prevCacheDir === undefined) delete process.env.BRIGADE_CACHE_DIR;
		else process.env.BRIGADE_CACHE_DIR = prevCacheDir;
		try {
			fs.rmSync(cacheRoot, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("reads inbound WhatsApp media under the OS cache (simulated convex inbound)", async () => {
		// A workspace dir that is NOT the cache root, proving the file is allowed by
		// the NEW OS-cache root, not by the workspace/cwd roots.
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-ws2-"));
		const mediaDir = path.join(cacheRoot, "channels", "whatsapp", "media", "2026-06-25");
		fs.mkdirSync(mediaDir, { recursive: true });
		const target = path.join(mediaDir, "msg123.html");
		fs.writeFileSync(
			target,
			"<html><body><h1>Inbound Attachment</h1><p>Body content that is sufficiently long to keep.</p></body></html>",
		);
		const tool = makeAnalyzeMediaTool({ workspaceDir: workspace, cwd: workspace });
		const r = (await tool.execute("c1", { source: target })) as Result;
		assert.equal(r.details.ok, true, "OS-cache channel media must be allowed in convex mode");
		assert.match(textOf(r), /Inbound Attachment/);
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("reads inbound BlueBubbles media under the OS cache", async () => {
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-ws3-"));
		const mediaDir = path.join(cacheRoot, "bluebubbles", "acct1", "inbound-media");
		fs.mkdirSync(mediaDir, { recursive: true });
		const target = path.join(mediaDir, "att.html");
		fs.writeFileSync(
			target,
			"<html><body><h1>iMessage Photo Caption</h1><p>Body content long enough for the extractor.</p></body></html>",
		);
		const tool = makeAnalyzeMediaTool({ workspaceDir: workspace, cwd: workspace });
		const r = (await tool.execute("c1", { source: target })) as Result;
		assert.equal(r.details.ok, true);
		assert.match(textOf(r), /iMessage Photo Caption/);
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("still refuses a secret file even inside the OS cache root", async () => {
		// Widening to the OS cache must NOT bypass the media-path guard.
		const target = path.join(cacheRoot, ".env");
		fs.writeFileSync(target, "SECRET=1");
		const tool = makeAnalyzeMediaTool();
		await assert.rejects(
			() => tool.execute("c1", { source: target, kind: "html" }),
			(err: unknown) => /sensitive|refus/i.test((err as Error).message),
		);
	});
});

/* ──────── macOS Messages Attachments root (the native-iMessage doc fix) ──────── */

describe("analyze_media — macOS Messages Attachments root is allowed (native iMessage)", () => {
	let fakeHome: string;
	let prevHome: string | undefined;
	let prevUserProfile: string | undefined;
	before(() => {
		fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-home-"));
		// `os.homedir()` reads $HOME (POSIX) / %USERPROFILE% (Windows); override both
		// so the computed Messages Attachments root points under our temp dir.
		prevHome = process.env.HOME;
		prevUserProfile = process.env.USERPROFILE;
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
	});
	after(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevUserProfile;
		try {
			fs.rmSync(fakeHome, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("resolves an iMessage attachment path instead of throwing 'outside allowed roots'", async () => {
		// The native imessage adapter surfaces the bridge's raw
		// ~/Library/Messages/Attachments/... path — previously NOT in the allowed
		// roots, so an iMessage PDF/doc threw. A workspace dir that is NOT under
		// that root proves the file is admitted by the NEW Messages root.
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-imsg-ws-"));
		const attachDir = path.join(fakeHome, "Library", "Messages", "Attachments", "ab", "01");
		fs.mkdirSync(attachDir, { recursive: true });
		const target = path.join(attachDir, "report.html");
		fs.writeFileSync(
			target,
			"<html><body><h1>iMessage Document</h1><p>Body content long enough for the readability extractor to keep it.</p></body></html>",
		);
		const tool = makeAnalyzeMediaTool({ workspaceDir: workspace, cwd: workspace });
		const r = (await tool.execute("c1", { source: target })) as Result;
		assert.equal(r.details.ok, true, "native iMessage attachment must be readable");
		assert.match(textOf(r), /iMessage Document/);
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("still refuses a secret file under the Messages Attachments root", async () => {
		// Admitting the Apple data dir must NOT bypass the media-path guard.
		const attachDir = path.join(fakeHome, "Library", "Messages", "Attachments");
		fs.mkdirSync(attachDir, { recursive: true });
		const target = path.join(attachDir, ".env");
		fs.writeFileSync(target, "SECRET=1");
		const tool = makeAnalyzeMediaTool();
		await assert.rejects(
			() => tool.execute("c1", { source: target, kind: "html" }),
			(err: unknown) => /sensitive|refus/i.test((err as Error).message),
		);
	});
});

/* ───── owner local file access (the TUI/desktop user-typed-path fix, #5) ───── */

describe("analyze_media — owner local access widens roots to the home dir", () => {
	let fakeHome: string;
	let fakeTmp: string;
	const saved: Record<string, string | undefined> = {};
	before(() => {
		// IMPORTANT: `os.tmpdir()` is ALWAYS an allowed root. If the fake home lived
		// under the real temp dir, a ~/Downloads path would be admitted via tmpdir
		// regardless of ownerLocalAccess — defeating the non-owner test. So point the
		// temp env at a DEDICATED fakeTmp and make fakeHome a SIBLING of it (not
		// contained), so the home widening is the ONLY thing that can admit it.
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-owner-base-"));
		fakeTmp = path.join(base, "tmp");
		fakeHome = path.join(base, "home");
		fs.mkdirSync(fakeTmp, { recursive: true });
		fs.mkdirSync(fakeHome, { recursive: true });
		for (const k of ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"]) saved[k] = process.env[k];
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
		process.env.TMPDIR = fakeTmp;
		process.env.TEMP = fakeTmp;
		process.env.TMP = fakeTmp;
	});
	after(() => {
		for (const k of ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"]) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		try {
			fs.rmSync(path.dirname(fakeHome), { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	/** Write a small HTML doc under the fake home's Downloads dir; return its path. */
	function downloadsDoc(name = "report.html"): string {
		const dir = path.join(fakeHome, "Downloads");
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, name);
		fs.writeFileSync(
			target,
			"<html><body><h1>Owner Download</h1><p>Body content long enough for the readability extractor to keep it.</p></body></html>",
		);
		return target;
	}

	it("OWNER turn reads a user-typed path in ~/Downloads (outside workspace/cwd)", async () => {
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-owner-ws-"));
		const target = downloadsDoc();
		const tool = makeAnalyzeMediaTool({ workspaceDir: workspace, cwd: workspace, ownerLocalAccess: true });
		const r = (await tool.execute("c1", { source: target })) as Result;
		assert.equal(r.details.ok, true, "owner may read a personal-dir path they typed");
		assert.match(textOf(r), /Owner Download/);
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("NON-owner turn is STILL refused a ~/Downloads path (remote sender can't read the home dir)", async () => {
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-nonowner-ws-"));
		const target = downloadsDoc("remote.html");
		// ownerLocalAccess omitted (false) → the home widening must NOT apply.
		const tool = makeAnalyzeMediaTool({ workspaceDir: workspace, cwd: workspace });
		await assert.rejects(
			() => tool.execute("c1", { source: target }),
			(err: unknown) => /outside the allowed roots/i.test((err as Error).message),
		);
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("OWNER access still refuses a secret in the home dir (denylist wins over the widening)", async () => {
		// Widening to the home dir must NOT expose ~/.ssh — the media-path guard
		// refuses credential dirs regardless of ownerLocalAccess.
		const sshDir = path.join(fakeHome, ".ssh");
		fs.mkdirSync(sshDir, { recursive: true });
		const target = path.join(sshDir, "id_rsa");
		fs.writeFileSync(target, "PRIVATE KEY");
		const tool = makeAnalyzeMediaTool({ ownerLocalAccess: true });
		await assert.rejects(
			() => tool.execute("c1", { source: target, kind: "text" }),
			(err: unknown) => /credentials directory|sensitive|refus/i.test((err as Error).message),
		);
	});
});

/* ─────────────────────────── audio (#6) ─────────────────────────── */

describe("analyze_media — audio", () => {
	it("detects audio by extension + MIME", () => {
		assert.equal(detectKind({ source: "/a/voice.mp3" }), "audio");
		assert.equal(detectKind({ source: "/a/note.m4a" }), "audio");
		assert.equal(detectKind({ source: "/a/clip.flac" }), "audio");
		assert.equal(detectKind({ source: "https://x.com/dl", mime: "audio/ogg" }), "audio");
		// .ogg defaults to audio (voice notes); explicit override still works.
		assert.equal(detectKind({ source: "/a/voice.ogg" }), "audio");
	});

	it("routes an .ogg voice note to audio understanding and returns TEXT", async () => {
		const { run, calls } = stubRunner("Transcript: see you at 5pm.", "google", "gemini-2.5-flash");
		const tool = toolWithBytes(Buffer.from([1, 2, 3]), undefined, undefined, {
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
		});
		const r = (await tool.execute("c1", { source: "/ws/voice.ogg", question: "what time?" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.returned, "text");
		assert.equal(r.details.kind, "audio");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.kind, "audio");
		assert.equal(calls[0]?.mimeType, "audio/ogg");
		assert.match(textOf(r), /Transcript: see you at 5pm/);
		assert.match(textOf(r), /EXTERNAL_UNTRUSTED_CONTENT/);
	});

	it("routes an .m4a source by explicit kind and derives the MIME", async () => {
		const { run, calls } = stubRunner("audio summary", "google");
		const tool = toolWithBytes(Buffer.from([0]), undefined, undefined, {
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
		});
		await tool.execute("c1", { source: "/ws/note.m4a" });
		assert.equal(calls[0]?.kind, "audio");
		assert.equal(calls[0]?.mimeType, "audio/mp4");
	});

	it("with NO capable key → clear 'configure a key' message (returned: none)", async () => {
		const tool = toolWithBytes(Buffer.from([1]), "audio/ogg", undefined, {
			mediaUnderstandingConfig: muCfg([]),
		});
		const r = (await tool.execute("c1", { source: "/ws/voice.ogg" })) as Result;
		assert.equal(r.details.ok, false);
		assert.equal(r.details.returned, "none");
		assert.equal(r.details.kind, "audio");
		assert.match(textOf(r), /audio/i);
	});
});

/* ───────────── text-only model image via the Pi path (multi-provider #5) ───────────── */

describe("analyze_media — text-only image via the Pi path (any provider)", () => {
	it("understands an image with ONLY an OpenAI-style key (no google/anthropic)", async () => {
		// Real runMediaUnderstanding (not stubbed) so the actual selection → Pi
		// routing is exercised through the tool. The config has NO google/anthropic
		// key, but a wired Pi path with an image-capable OpenAI model + a piComplete
		// stub — proving image understanding now covers every configured provider.
		const piConfig: MediaUnderstandingConfig = {
			resolveKey: (p) => (p === "openai" ? "sk-openai" : ""),
			resolveModel: (provider) =>
				provider === "openai"
					? { provider, id: "gpt-4o", input: ["text", "image"] }
					: undefined,
			listKeyedProviders: () => ["openai"],
			piComplete: async () => "A bar chart trending upward.",
		};
		const tool = toolWithBytes(Buffer.from([1, 2, 3, 4]), "image/png", {
			imageInput: false,
			modelId: "text-only-model",
		}, {
			mediaUnderstandingConfig: piConfig,
		});
		const r = (await tool.execute("c1", { source: "/ws/chart.png", question: "trend?" })) as Result;
		assert.equal(imageBlocks(r).length, 0, "no image block for a text-only model");
		assert.equal(r.details.returned, "text");
		assert.equal(r.details.ok, true);
		assert.equal(r.details.provider, "pi");
		assert.match(textOf(r), /A bar chart trending upward/);
		assert.match(textOf(r), /EXTERNAL_UNTRUSTED_CONTENT/);
	});

	it("BUG-1: text-only model + provider HTTP failure → actionable guidance", async () => {
		const run = async (): Promise<RunMediaUnderstandingResult> => {
			throw new Error("Anthropic error: HTTP 503");
		};
		const tool = toolWithBytes(Buffer.from([1, 2, 3]), "image/png", {
			imageInput: false,
			modelId: "text-only-model",
		}, {
			mediaUnderstandingConfig: muCfg(["anthropic"]),
			runMediaUnderstanding: run,
		});
		const r = (await tool.execute("c1", { source: "/ws/pic.png" })) as Result;
		assert.equal(r.details.ok, false);
		assert.equal(r.details.returned, "none");
		// The failure now carries the transport error AND a "do this next" hint.
		assert.match(textOf(r), /HTTP 503/);
		assert.match(textOf(r), /vision-capable model|media-understanding provider key/i);
	});
});

/* ─────────── video provider-override message (#4a) ─────────── */

describe("analyze_media — video with anthropic override", () => {
	it("says anthropic cannot do video (not a generic Gemini-key message)", async () => {
		const tool = toolWithBytes(Buffer.from([0, 0, 0]), "video/mp4", undefined, {
			mediaUnderstandingConfig: muCfg(["anthropic", "google"]),
		});
		const r = (await tool.execute("c1", {
			source: "/ws/clip.mp4",
			provider: "anthropic",
		})) as Result;
		assert.equal(r.details.ok, false);
		assert.equal(r.details.returned, "none");
		assert.match(textOf(r), /Anthropic cannot analyze video|no video ingestion/i);
	});
});

/* ─────────── oversize image is DOWNSCALED, not truncated (#2) ─────────── */

describe("analyze_media — oversize image is downscaled (not truncated)", () => {
	// A fake downscaler that proves the tool calls it with the right budget and
	// returns its bytes verbatim — the real jimp path is exercised separately in
	// image-downscale.test.ts (with a real codec).
	function fakeDownscale(stamp: Buffer): MakeAnalyzeMediaToolOptions["downscaleImage"] {
		return async (_bytes, opts) => ({
			bytes: stamp,
			mimeType: "image/jpeg",
			width: 1024,
			height: 768,
			resized: true,
			rotated: false,
			// echo the budget so the test can assert it (not part of the type — cast)
			...({ _budget: opts.maxBytes } as object),
		});
	}

	it("downscales an oversize image to a VALID image under the budget (no truncation)", async () => {
		// Bytes larger than the image budget. The OLD behaviour truncated to the
		// cap (corrupt); the NEW behaviour downscales to a valid image.
		const big = Buffer.alloc(DEFAULT_IMAGE_MAX_BYTES + 10_000, 7);
		const downscaled = Buffer.from("VALID-SMALL-JPEG-BYTES");
		const tool = makeAnalyzeMediaTool({
			modelContext: { modelId: "claude-opus-4-8" }, // vision-capable → image block
			acquireLocal: async () => ({ bytes: big, mime: "image/png", truncated: false }),
			downscaleImage: fakeDownscale(downscaled),
		});
		const r = (await tool.execute("c1", { source: "/ws/huge.png" })) as Result;
		const imgs = imageBlocks(r);
		assert.equal(imgs.length, 1);
		// The block carries the DOWNSCALED bytes, not a truncated prefix of `big`.
		assert.equal(imgs[0]?.data, downscaled.toString("base64"));
		assert.equal(imgs[0]?.mimeType, "image/jpeg", "re-encoded as JPEG");
		assert.equal(r.details.bytes, downscaled.length);
		// A successful downscale yields a valid image → NOT marked truncated.
		assert.notEqual(r.details.truncated, true);
		assert.match(textOf(r), /downscaled/i);
	});

	it("does NOT downscale a small image (returns it untouched)", async () => {
		const small = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
		let called = false;
		const tool = makeAnalyzeMediaTool({
			modelContext: { modelId: "claude-opus-4-8" },
			acquireLocal: async () => ({ bytes: small, mime: "image/png", truncated: false }),
			downscaleImage: async (b) => {
				called = true;
				return { bytes: b, mimeType: "image/png", width: 1, height: 1, resized: false, rotated: false };
			},
		});
		const r = (await tool.execute("c1", { source: "/ws/tiny.png" })) as Result;
		assert.equal(called, false, "downscaler not invoked for a small image");
		assert.equal(imageBlocks(r)[0]?.data, small.toString("base64"));
	});

	it("an extension-less image URL (kind via MIME) is also downscaled to the budget", async () => {
		// Up-front `looksImage` is false (no extension), so it is read at the
		// ceiling; after MIME detection it must be downscaled to the image budget.
		const big = Buffer.alloc(DEFAULT_IMAGE_MAX_BYTES + 50_000, 9);
		const downscaled = Buffer.from("SMALL");
		let sawBudget = -1;
		const tool = makeAnalyzeMediaTool({
			modelContext: { modelId: "claude-opus-4-8" },
			acquireUrl: async () => ({ bytes: big, mime: "image/png", truncated: false }),
			downscaleImage: async (_b, opts) => {
				sawBudget = opts.maxBytes;
				return { bytes: downscaled, mimeType: "image/jpeg", width: 800, height: 600, resized: true, rotated: false };
			},
		});
		const r = (await tool.execute("c1", { source: "https://x.com/download" })) as Result;
		assert.equal(imageBlocks(r)[0]?.data, downscaled.toString("base64"));
		assert.equal(sawBudget, DEFAULT_IMAGE_MAX_BYTES, "downscaled to the image budget");
	});

	it("keeps original bytes when downscaling fails (undecodable) + warns truncated", async () => {
		const big = Buffer.alloc(DEFAULT_IMAGE_MAX_BYTES + 1000, 1);
		const tool = makeAnalyzeMediaTool({
			modelContext: { modelId: "claude-opus-4-8" },
			acquireLocal: async () => ({ bytes: big, mime: "image/png", truncated: true }),
			downscaleImage: async () => {
				throw new Error("undecodable image");
			},
		});
		const r = (await tool.execute("c1", { source: "/ws/broken.png" })) as Result;
		// Falls back to the original bytes; still flagged as a possibly-corrupt block.
		assert.equal(imageBlocks(r).length, 1);
		assert.equal(r.details.truncated, true);
		assert.match(textOf(r), /could not be re-encoded|may be corrupt/i);
	});
});

/* ───────── provider-bound image MIME normalization (bmp/tiff → JPEG) ───────── */

describe("analyze_media — non-web-safe image MIME is re-encoded before a provider call", () => {
	it("re-encodes a small image/bmp to JPEG before the (Anthropic) provider call — no 400", async () => {
		// A SMALL bmp (under budget) on a text-only model routed to Anthropic. The
		// OLD behaviour shipped media_type image/bmp, which Anthropic rejects (400);
		// the NEW behaviour re-encodes it to JPEG first so the provider accepts it.
		const bmp = Buffer.from([0x42, 0x4d, 1, 2, 3, 4]); // "BM" + a few bytes
		const jpeg = Buffer.from("RE-ENCODED-JPEG");
		let downscaleCalled = false;
		const { run, calls } = stubRunner("A red square.", "anthropic", "claude-sonnet-4-5");
		const tool = makeAnalyzeMediaTool({
			modelContext: { imageInput: false, modelId: "text-only-model" },
			acquireLocal: async () => ({ bytes: bmp, mime: "image/bmp", truncated: false }),
			mediaUnderstandingConfig: muCfg(["anthropic"]),
			runMediaUnderstanding: run,
			resultCache: false,
			downscaleImage: async (_b, opts) => {
				downscaleCalled = true;
				void opts.maxBytes;
				return { bytes: jpeg, mimeType: "image/jpeg", width: 10, height: 10, resized: true, rotated: false };
			},
		});
		const r = (await tool.execute("c1", { source: "/ws/pic.bmp", question: "what is this?" })) as Result;
		assert.equal(downscaleCalled, true, "the bmp must be re-encoded before the provider call");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.mimeType, "image/jpeg", "provider receives JPEG, not image/bmp");
		assert.deepEqual(calls[0]?.bytes, jpeg, "provider receives the re-encoded bytes");
		assert.equal(r.details.ok, true);
		assert.match(textOf(r), /A red square\./);
	});

	it("does NOT re-encode a small image/png heading to a provider (already provider-safe)", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
		let downscaleCalled = false;
		const { run, calls } = stubRunner("A blue dot.", "anthropic", "claude-sonnet-4-5");
		const tool = makeAnalyzeMediaTool({
			modelContext: { imageInput: false, modelId: "text-only-model" },
			acquireLocal: async () => ({ bytes: png, mime: "image/png", truncated: false }),
			mediaUnderstandingConfig: muCfg(["anthropic"]),
			runMediaUnderstanding: run,
			resultCache: false,
			downscaleImage: async (b) => {
				downscaleCalled = true;
				return { bytes: b, mimeType: "image/png", width: 1, height: 1, resized: false, rotated: false };
			},
		});
		await tool.execute("c1", { source: "/ws/pic.png", question: "what is this?" });
		assert.equal(downscaleCalled, false, "a provider-safe PNG is not re-encoded");
		assert.equal(calls[0]?.mimeType, "image/png");
	});
});

/* ─────────────────────────── text / structured-text kind (#3) ─────────────────────────── */

describe("analyze_media — plain / structured text", () => {
	it("detects text by extension (csv/json/md/log/yaml/source)", () => {
		assert.equal(detectKind({ source: "/a/data.csv" }), "text");
		assert.equal(detectKind({ source: "/a/config.json" }), "text");
		assert.equal(detectKind({ source: "/a/notes.md" }), "text");
		assert.equal(detectKind({ source: "/a/server.log" }), "text");
		assert.equal(detectKind({ source: "/a/conf.yaml" }), "text");
		assert.equal(detectKind({ source: "/a/script.py" }), "text");
		assert.equal(detectKind({ source: "/a/app.ts" }), "text");
	});

	it("detects text by MIME (text/* + application/json/xml)", () => {
		assert.equal(detectKind({ source: "https://x.com/d", mime: "text/plain" }), "text");
		assert.equal(detectKind({ source: "https://x.com/d", mime: "application/json" }), "text");
		assert.equal(detectKind({ source: "https://x.com/d", mime: "application/xml" }), "text");
		assert.equal(detectKind({ source: "https://x.com/d", mime: "application/vnd.api+json" }), "text");
		// html still wins over the generic text branch
		assert.equal(detectKind({ source: "https://x.com/d", mime: "text/html" }), "html");
	});

	it("reads a CSV as text wrapped in the untrusted envelope", async () => {
		const csv = Buffer.from("name,age\nAlice,30\nBob,25\n");
		const tool = toolWithBytes(csv);
		const r = (await tool.execute("c1", { source: "/ws/data.csv", question: "who is oldest?" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.kind, "text");
		assert.equal(r.details.returned, "text");
		const t = textOf(r);
		assert.match(t, /Alice,30/);
		assert.match(t, /who is oldest\?/);
		assert.match(t, /EXTERNAL_UNTRUSTED_CONTENT/);
	});

	it("reads a JSON file and a Markdown file", async () => {
		const json = toolWithBytes(Buffer.from('{"key":"value","n":42}'));
		const rj = (await json.execute("c1", { source: "/ws/x.json" })) as Result;
		assert.equal(rj.details.kind, "text");
		assert.match(textOf(rj), /"key":"value"/);

		const md = toolWithBytes(Buffer.from("# Heading\n\nSome **markdown** body."));
		const rm = (await md.execute("c1", { source: "/ws/x.md" })) as Result;
		assert.equal(rm.details.kind, "text");
		assert.match(textOf(rm), /# Heading/);
	});

	it("strips a UTF-8 BOM", async () => {
		const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello after bom")]);
		const tool = toolWithBytes(withBom);
		const r = (await tool.execute("c1", { source: "/ws/x.txt" })) as Result;
		assert.match(textOf(r), /hello after bom/);
		assert.ok(!textOf(r).includes("﻿"), "BOM stripped");
	});

	it("falls back to text for an unknown extension whose bytes are UTF-8", async () => {
		const tool = toolWithBytes(Buffer.from("key = value\n[section]\nx = 1\n"));
		const r = (await tool.execute("c1", { source: "/ws/config.weirdext" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.kind, "text");
		assert.match(textOf(r), /\[section\]/);
	});

	it("still rejects true binary as unsupported (NUL bytes)", async () => {
		const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe, 0x00]);
		const tool = toolWithBytes(binary, "application/octet-stream");
		const r = (await tool.execute("c1", { source: "/ws/blob.weirdbin" })) as Result;
		assert.equal(r.details.ok, false);
		assert.match(textOf(r), /Unsupported or undetectable/i);
	});
});

/* ─────────────────────────── multi-source batch (#4) ─────────────────────────── */

describe("analyze_media — multi-source sources[]", () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
	function batchTool(extra?: Partial<MakeAnalyzeMediaToolOptions>) {
		const bytesFor = (s: string): { bytes: Buffer; mime?: string; truncated: boolean } => {
			if (/\.png$/.test(s)) return { bytes: png, mime: "image/png", truncated: false };
			if (/\.csv$/.test(s)) return { bytes: Buffer.from("a,b\n1,2\n"), truncated: false };
			if (/\.md$/.test(s)) return { bytes: Buffer.from("# Doc\nbody long enough to keep around"), truncated: false };
			return { bytes: Buffer.from("plain text body"), truncated: false };
		};
		return makeAnalyzeMediaTool({
			modelContext: { modelId: "claude-opus-4-8" },
			acquireLocal: async (s) => bytesFor(s),
			resultCache: false,
			...(extra ?? {}),
		});
	}

	it("multiple images → multiple image blocks with per-image labels", async () => {
		const r = (await batchTool().execute("c1", {
			sources: ["/ws/a.png", "/ws/b.png"],
			question: "compare these",
		})) as Result;
		assert.equal(imageBlocks(r).length, 2, "two image blocks in one result");
		assert.equal(r.details.returned, "image");
		const t = textOf(r);
		assert.match(t, /--- Image 1: a\.png ---/);
		assert.match(t, /--- Image 2: b\.png ---/);
		assert.match(t, /compare these/);
	});

	it("multiple documents → labeled concatenated text", async () => {
		const r = (await batchTool().execute("c1", {
			sources: ["/ws/x.csv", "/ws/y.md"],
			question: "summarize both",
		})) as Result;
		assert.equal(imageBlocks(r).length, 0);
		const t = textOf(r);
		assert.match(t, /--- File 1: x\.csv ---/);
		assert.match(t, /--- File 2: y\.md ---/);
		assert.match(t, /a,b/);
		assert.match(t, /# Doc/);
	});

	it("`source` (singular) still works exactly as before", async () => {
		const r = (await batchTool().execute("c1", { source: "/ws/a.png" })) as Result;
		assert.equal(imageBlocks(r).length, 1);
		assert.equal(r.details.source, "/ws/a.png", "single-source detail unchanged");
	});

	it("caps images at 20 with an overflow note", async () => {
		const many = Array.from({ length: 23 }, (_, i) => `/ws/img${i}.png`);
		const r = (await batchTool().execute("c1", { sources: many })) as Result;
		assert.equal(imageBlocks(r).length, 20, "capped to 20 image blocks");
		assert.match(textOf(r), /beyond the per-call cap/i);
	});

	it("empty sources[] + no source → input error", async () => {
		await assert.rejects(() => batchTool().execute("c1", { sources: [] as string[] }), /source required/);
	});

	it("an unsupported source in a batch is reported inline (labeled) without aborting", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
		const tool = makeAnalyzeMediaTool({
			modelContext: { modelId: "claude-opus-4-8" },
			acquireLocal: async (s) =>
				/\.png$/.test(s)
					? { bytes: png, mime: "image/png", truncated: false }
					: { bytes: Buffer.from([0x00, 0x01, 0x02, 0xff]), mime: "application/octet-stream", truncated: false },
			resultCache: false,
		});
		// One good image + one unsupported binary blob (treated as a doc in the batch).
		const r = (await tool.execute("c1", { sources: ["/ws/a.png", "/ws/blob.bin"] })) as Result;
		// The good image still produced a block; the bad file's message is inline.
		assert.equal(imageBlocks(r).length, 1, "the valid image still analyzed");
		assert.match(textOf(r), /--- File 1: blob\.bin ---/);
		assert.match(textOf(r), /Unsupported or undetectable/i);
	});
});

/* ─────────────────────────── audio language hint (#5) ─────────────────────────── */

describe("analyze_media — audio language hint", () => {
	it("folds the language hint into the provider prompt", async () => {
		const { run, calls } = stubRunner("Transcripción: hola.", "google", "gemini-2.5-flash");
		const tool = toolWithBytes(Buffer.from([1, 2, 3]), "audio/ogg", undefined, {
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
		});
		await tool.execute("c1", { source: "/ws/voice.ogg", question: "what was said?", language: "Spanish" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.kind, "audio");
		// The provider prompt carries BOTH the question and the language hint.
		assert.match(calls[0]?.prompt ?? "", /what was said\?/);
		assert.match(calls[0]?.prompt ?? "", /Spanish/);
	});

	it("defaults to transcribe+summarize when no question, still honoring language", async () => {
		const { run, calls } = stubRunner("ok", "google");
		const tool = toolWithBytes(Buffer.from([1]), "audio/ogg", undefined, {
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
		});
		await tool.execute("c1", { source: "/ws/voice.ogg", language: "fr" });
		assert.match(calls[0]?.prompt ?? "", /[Tt]ranscribe/);
		assert.match(calls[0]?.prompt ?? "", /fr/);
	});
});

/* ─────────────────────────── extra document formats (#6) ─────────────────────────── */

describe("analyze_media — extra document formats", () => {
	function buildOdt(text: string): Buffer {
		const content = `<?xml version="1.0"?><office:document-content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>${text}</text:p></office:text></office:body></office:document-content>`;
		return Buffer.from(zipSync({ mimetype: strToU8("application/vnd.oasis.opendocument.text"), "content.xml": strToU8(content) }));
	}
	function buildEpub(): Buffer {
		const opf = `<?xml version="1.0"?><package><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
		const ch1 = `<html><body><h1>Chapter One</h1><p>Opening paragraph long enough for the readability extractor to keep.</p></body></html>`;
		return Buffer.from(zipSync({ mimetype: strToU8("application/epub+zip"), "content.opf": strToU8(opf), "ch1.xhtml": strToU8(ch1) }));
	}

	it("odt → extracted text", async () => {
		const tool = toolWithBytes(buildOdt("OpenDocument body text here."));
		const r = (await tool.execute("c1", { source: "/ws/d.odt" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.kind, "odt");
		assert.match(textOf(r), /OpenDocument body text here\./);
	});

	it("epub → readable text in spine order", async () => {
		const tool = toolWithBytes(buildEpub());
		const r = (await tool.execute("c1", { source: "/ws/book.epub" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.kind, "epub");
		assert.match(textOf(r), /Chapter One/);
		assert.match(textOf(r), /Opening paragraph/);
	});

	it("rtf → plain text (control words stripped)", async () => {
		const rtf = Buffer.from(String.raw`{\rtf1\ansi\deff0 {\fonttbl{\f0 Times;}}\f0\fs24 Hello \b world\b0 .\par Second line.\par}`);
		const tool = toolWithBytes(rtf);
		const r = (await tool.execute("c1", { source: "/ws/doc.rtf" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.kind, "rtf");
		const t = textOf(r);
		assert.match(t, /Hello world/);
		assert.match(t, /Second line/);
		assert.ok(!/fonttbl/.test(t), "control tables stripped");
	});

	it("ipynb → cell source with code fences (outputs skipped)", async () => {
		const nb = {
			cells: [
				{ cell_type: "markdown", source: ["# My Notebook\n", "Intro."] },
				{ cell_type: "code", source: "print('hi')\nx = 2", outputs: [{ text: "SHOULD-NOT-APPEAR" }] },
			],
			nbformat: 4,
		};
		const tool = toolWithBytes(Buffer.from(JSON.stringify(nb)));
		const r = (await tool.execute("c1", { source: "/ws/nb.ipynb" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.kind, "ipynb");
		const t = textOf(r);
		assert.match(t, /My Notebook/);
		assert.match(t, /print\('hi'\)/);
		assert.match(t, /Cell 1 \(markdown\)/);
		assert.ok(!/SHOULD-NOT-APPEAR/.test(t), "cell outputs are not included");
	});

	it("corrupt odt → clean error", async () => {
		const tool = toolWithBytes(Buffer.from("not a zip"));
		const r = (await tool.execute("c1", { source: "/ws/d.odt" })) as Result;
		assert.equal(r.details.ok, false);
		assert.equal(r.details.returned, "none");
	});

	it("detects the new formats by extension", () => {
		assert.equal(detectKind({ source: "/a/x.odt" }), "odt");
		assert.equal(detectKind({ source: "/a/x.ods" }), "ods");
		assert.equal(detectKind({ source: "/a/x.odp" }), "odp");
		assert.equal(detectKind({ source: "/a/x.epub" }), "epub");
		assert.equal(detectKind({ source: "/a/x.rtf" }), "rtf");
		assert.equal(detectKind({ source: "/a/x.ipynb" }), "ipynb");
	});

	it("accepts an explicit kind:'epub' override and routes it (rescues a mis-named file)", async () => {
		// The source extension is a generic .bin (would NOT auto-detect as epub) —
		// forcing kind:"epub" must be accepted by the schema AND drive EPUB parsing.
		const tool = toolWithBytes(buildEpub());
		const r = (await tool.execute("c1", { source: "/ws/mystery.bin", kind: "epub" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.kind, "epub");
		assert.match(textOf(r), /Chapter One/);
	});

	it("accepts an explicit kind:'odt' override over a wrong extension", async () => {
		const tool = toolWithBytes(buildOdt("Forced ODT content."));
		// Extension says .pdf; the override must win and parse it as ODT.
		const r = (await tool.execute("c1", { source: "/ws/wrong.pdf", kind: "odt" })) as Result;
		assert.equal(r.details.ok, true);
		assert.equal(r.details.kind, "odt");
		assert.match(textOf(r), /Forced ODT content\./);
	});

	it("detectKind honors odt/ods/odp/epub/rtf/ipynb overrides", () => {
		// The override branch must recognise every new literal the schema now accepts.
		assert.equal(detectKind({ source: "x.bin", override: "odt" }), "odt");
		assert.equal(detectKind({ source: "x.bin", override: "ods" }), "ods");
		assert.equal(detectKind({ source: "x.bin", override: "odp" }), "odp");
		assert.equal(detectKind({ source: "x.bin", override: "epub" }), "epub");
		assert.equal(detectKind({ source: "x.bin", override: "rtf" }), "rtf");
		assert.equal(detectKind({ source: "x.bin", override: "ipynb" }), "ipynb");
	});

	it("the tool's `kind` param schema accepts the new literals (so the agent can pass them)", () => {
		// The runtime validates tool args against this schema BEFORE execute — assert
		// every new kind passes and a bogus one is rejected.
		const tool = makeAnalyzeMediaTool();
		const schema = tool.parameters;
		for (const k of ["odt", "ods", "odp", "epub", "rtf", "ipynb", "image", "text"]) {
			assert.equal(Value.Check(schema, { source: "/ws/x", kind: k }), true, `kind:"${k}" must validate`);
		}
		assert.equal(Value.Check(schema, { source: "/ws/x", kind: "not-a-kind" }), false, "garbage kind rejected");
	});
});

/* ─────────────────────────── maxTokens plumbing (#8) ─────────────────────────── */

describe("analyze_media — maxTokens", () => {
	it("threads maxTokens to the provider understanding request (pdf)", async () => {
		const { run, calls } = stubRunner("summary", "anthropic", "claude-sonnet-4-5");
		const tool = toolWithBytes(Buffer.from("PDFISH"), "application/pdf", undefined, {
			mediaUnderstandingConfig: muCfg(["anthropic"]),
			runMediaUnderstanding: run,
		});
		await tool.execute("c1", { source: "/ws/x.pdf", question: "summarize", maxTokens: 1234, mode: "provider" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.maxTokens, 1234, "maxTokens reached the request");
	});

	it("threads maxTokens for video", async () => {
		const { run, calls } = stubRunner("clip", "google");
		const tool = toolWithBytes(Buffer.from([0]), "video/mp4", undefined, {
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
		});
		await tool.execute("c1", { source: "/ws/clip.mp4", maxTokens: 555 });
		assert.equal(calls[0]?.maxTokens, 555);
	});
});

/* ─────────────────────────── result cache (#8) ─────────────────────────── */

describe("analyze_media — result cache", () => {
	it("returns the cached result on a hit WITHOUT calling the provider", async () => {
		const store = new Map<string, { text: string; provider: string; model: string }>();
		let providerCalls = 0;
		const run = async (): Promise<RunMediaUnderstandingResult> => {
			providerCalls += 1;
			return { text: "fresh provider answer", provider: "google", model: "gemini-2.5-flash" };
		};
		const tool = makeAnalyzeMediaTool({
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
			acquireLocal: async () => ({ bytes: Buffer.from([5, 6, 7]), mime: "video/mp4", truncated: false }),
			resultCache: true,
			readCache: async (key) => store.get(key),
			writeCache: async (key, value) => {
				store.set(key, value);
			},
		});
		const r1 = (await tool.execute("c1", { source: "/ws/clip.mp4", question: "what?" })) as Result;
		assert.equal(providerCalls, 1, "first call hits the provider");
		assert.match(textOf(r1), /fresh provider answer/);
		assert.equal(store.size, 1, "result written to cache");

		const r2 = (await tool.execute("c2", { source: "/ws/clip.mp4", question: "what?" })) as Result;
		assert.equal(providerCalls, 1, "second identical call served from cache (provider NOT called)");
		assert.match(textOf(r2), /fresh provider answer/);
		assert.match(textOf(r2), /cached result/);
	});

	it("a different question is a cache MISS (re-calls the provider)", async () => {
		const store = new Map<string, { text: string; provider: string; model: string }>();
		let providerCalls = 0;
		const run = async (req: RunMediaUnderstandingRequest): Promise<RunMediaUnderstandingResult> => {
			providerCalls += 1;
			return { text: `answer for ${req.prompt}`, provider: "google", model: "m" };
		};
		const tool = makeAnalyzeMediaTool({
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
			acquireLocal: async () => ({ bytes: Buffer.from([9]), mime: "video/mp4", truncated: false }),
			resultCache: true,
			readCache: async (key) => store.get(key),
			writeCache: async (key, value) => {
				store.set(key, value);
			},
		});
		await tool.execute("c1", { source: "/ws/clip.mp4", question: "q1" });
		await tool.execute("c2", { source: "/ws/clip.mp4", question: "q2" });
		assert.equal(providerCalls, 2, "different question → provider called again");
		assert.equal(store.size, 2, "two distinct cache entries");
	});

	it("does NOT read/write the cache when resultCache is false", async () => {
		let reads = 0;
		let writes = 0;
		const { run } = stubRunner("x", "google");
		const tool = makeAnalyzeMediaTool({
			mediaUnderstandingConfig: muCfg(["google"]),
			runMediaUnderstanding: run,
			acquireLocal: async () => ({ bytes: Buffer.from([1]), mime: "video/mp4", truncated: false }),
			resultCache: false,
			readCache: async () => {
				reads += 1;
				return undefined;
			},
			writeCache: async () => {
				writes += 1;
			},
		});
		await tool.execute("c1", { source: "/ws/clip.mp4" });
		assert.equal(reads, 0, "no cache read when disabled");
		assert.equal(writes, 0, "no cache write when disabled");
	});
});
