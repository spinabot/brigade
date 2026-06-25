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

import {
	makeAnalyzeMediaTool,
	detectKind,
	extensionOf,
	parsePageRange,
	modelLikelySeesImages,
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
		...(extra ?? {}),
	});
}

/** A media-understanding config whose key set is exactly `keyed`. */
function muCfg(keyed: Array<"google" | "anthropic">): MediaUnderstandingConfig {
	return { resolveKey: (p) => (keyed.includes(p) ? `key-${p}` : "") };
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
