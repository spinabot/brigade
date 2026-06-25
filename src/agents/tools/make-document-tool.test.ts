/**
 * Tests for the `make_document` tool (CREATE docx / xlsx / pptx / pdf).
 *
 * Each format is built for real (the libraries are local + pure-JS) and the
 * output is re-opened to prove validity:
 *   - docx/pptx/xlsx → fflate-unzip + assert the OOXML parts exist.
 *   - pdf            → @cantoo/pdf-lib loads it + page count matches.
 * Plus: the output path guard refuses a write outside the allowed roots, and
 * an auto-named output lands in the workspace.
 *
 * No network, no real model calls. Image embedding is exercised with an
 * injected loader stub (no real codec) so the embed branch runs deterministically.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { unzipSync, strFromU8 } from "fflate";

import { makeMakeDocumentTool, type MakeDocumentDetails } from "./make-document-tool.js";
import type { LoadedDocImage } from "./doc-shared.js";
import type { AgentToolResult } from "./types.js";

type Result = AgentToolResult<MakeDocumentDetails>;

let workspace: string;

before(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-makedoc-"));
});
beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-makedoc-ws-"));
});
after(() => {
	try {
		fs.rmSync(workspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function details(r: Result): MakeDocumentDetails {
	const text = r.content.find((b): b is { type: "text"; text: string } => b.type === "text");
	return JSON.parse(text?.text ?? "{}") as MakeDocumentDetails;
}

/** A 1×1 fake image loader — never touches a real codec. */
function stubLoader() {
	const load = async (): Promise<LoadedDocImage> => ({
		width: () => 100,
		height: () => 80,
		scaleToFit: () => {},
		encodePng: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
		encodeJpeg: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
	});
	return load;
}

function tool() {
	return makeMakeDocumentTool({ workspaceDir: workspace, cwd: workspace });
}

/* ─────────────────────────── docx ─────────────────────────── */

describe("make_document — docx", () => {
	it("creates a valid .docx with the OOXML parts + body text", async () => {
		const out = path.join(workspace, "report.docx");
		const r = (await tool().execute("c", {
			format: "docx",
			outputPath: out,
			content: {
				title: "Quarterly Report",
				sections: [
					{
						heading: "Summary",
						paragraphs: ["Revenue grew UNIQUEWORD this quarter."],
						bullets: ["First point", "Second point"],
						table: { rows: [["Metric", "Value"], ["Revenue", "100"]] },
					},
				],
			},
		})) as Result;
		const d = details(r);
		assert.equal(d.ok, true);
		assert.equal(d.format, "docx");
		assert.ok((d.bytes ?? 0) > 0);
		assert.ok(fs.existsSync(out));
		const entries = unzipSync(new Uint8Array(fs.readFileSync(out)));
		assert.ok("word/document.xml" in entries, "has word/document.xml");
		assert.ok("[Content_Types].xml" in entries, "has content types");
		const docText = strFromU8(entries["word/document.xml"] as Uint8Array);
		assert.match(docText, /UNIQUEWORD/);
	});
});

/* ─────────────────────────── xlsx ─────────────────────────── */

describe("make_document — xlsx", () => {
	it("creates a valid .xlsx with the workbook parts + multiple sheets", async () => {
		const out = path.join(workspace, "data.xlsx");
		const r = (await tool().execute("c", {
			format: "xlsx",
			outputPath: out,
			content: {
				sheets: [
					{ name: "Numbers", header: ["A", "B"], rows: [[1, 2], [3, 4]] },
					{ name: "Words", rows: [["x", "y"]] },
				],
			},
		})) as Result;
		const d = details(r);
		assert.equal(d.ok, true);
		assert.equal(d.sheets, 2);
		const entries = unzipSync(new Uint8Array(fs.readFileSync(out)));
		assert.ok("xl/workbook.xml" in entries, "has xl/workbook.xml");
		const sheetParts = Object.keys(entries).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
		assert.equal(sheetParts.length, 2, "two worksheet parts");
	});

	it("writes a formula cell (<f> element) + per-column number formats", async () => {
		const out = path.join(workspace, "calc.xlsx");
		const r = (await tool().execute("c", {
			format: "xlsx",
			outputPath: out,
			content: {
				sheets: [
					{
						name: "Calc",
						header: ["Item", "Amount"],
						rows: [
							["a", 10],
							["b", 20],
							["Total", { formula: "SUM(B2:B3)" } as never],
						],
						numberFormats: [null, "#,##0.00"] as never,
					},
				],
			},
		})) as Result;
		assert.equal(details(r).ok, true);
		const entries = unzipSync(new Uint8Array(fs.readFileSync(out)));
		const sheetXml = strFromU8(entries["xl/worksheets/sheet1.xml"] as Uint8Array);
		assert.match(sheetXml, /<f>SUM\(B2:B3\)<\/f>/, "an <f> formula element is written");
		// And exceljs reads the formula + the column number format back.
		const ExcelJS = (await import("exceljs")).default;
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.load(fs.readFileSync(out) as never);
		const ws = wb.getWorksheet("Calc");
		const total = ws?.getCell("B4");
		assert.equal(total?.type, ExcelJS.ValueType.Formula, "formula cell round-trips");
		assert.equal((total?.value as { formula?: string })?.formula, "SUM(B2:B3)");
		assert.equal(ws?.getCell("B2").numFmt, "#,##0.00", "column number format applied to data");
	});
});

/* ─────────────────────────── pptx ─────────────────────────── */

describe("make_document — pptx", () => {
	it("creates a valid .pptx with one slide part per slide", async () => {
		const out = path.join(workspace, "deck.pptx");
		const r = (await tool().execute("c", {
			format: "pptx",
			outputPath: out,
			content: {
				slides: [
					{ title: "Intro", bullets: ["Point SLIDEWORD one", "Point two"], notes: "speaker note" },
					{ title: "Next" },
				],
			},
		})) as Result;
		const d = details(r);
		assert.equal(d.ok, true);
		assert.equal(d.slides, 2);
		const entries = unzipSync(new Uint8Array(fs.readFileSync(out)));
		const slideParts = Object.keys(entries).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
		assert.equal(slideParts.length, 2, "two slide parts");
		const slide1 = strFromU8(entries["ppt/slides/slide1.xml"] as Uint8Array);
		assert.match(slide1, /SLIDEWORD/);
	});

	it("adds a bar chart to a slide (produces a chart part)", async () => {
		const out = path.join(workspace, "chart.pptx");
		const r = (await tool().execute("c", {
			format: "pptx",
			outputPath: out,
			content: {
				slides: [
					{
						title: "Revenue",
						chart: {
							type: "bar",
							title: "By quarter",
							categories: ["Q1", "Q2", "Q3"],
							series: [{ name: "Rev", values: [10, 20, 15] }],
						},
					},
				],
			} as never,
		})) as Result;
		assert.equal(details(r).ok, true);
		const entries = unzipSync(new Uint8Array(fs.readFileSync(out)));
		const chartParts = Object.keys(entries).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
		assert.ok(chartParts.length >= 1, "a chart part is embedded");
	});
});

/* ─────────────────────────── pdf ─────────────────────────── */

describe("make_document — pdf", () => {
	it("creates a valid PDF that pdf-lib can load with the expected page count", async () => {
		const out = path.join(workspace, "doc.pdf");
		const r = (await tool().execute("c", {
			format: "pdf",
			outputPath: out,
			content: {
				title: "Title Page",
				pages: [
					{ heading: "Page One", paragraphs: ["Some body text that wraps across the page width. ".repeat(6)] },
					{ heading: "Page Two", paragraphs: ["Second page."] },
				],
			},
		})) as Result;
		const d = details(r);
		assert.equal(d.ok, true);
		assert.equal(d.format, "pdf");
		const { PDFDocument } = await import("@cantoo/pdf-lib");
		const pdf = await PDFDocument.load(fs.readFileSync(out));
		assert.ok(pdf.getPageCount() >= 2, "at least two pages");
		assert.equal(d.pages, pdf.getPageCount());
	});

	it("strips non-WinAnsi glyphs so emoji/CJK never throw on the standard font", async () => {
		const out = path.join(workspace, "emoji.pdf");
		const r = (await tool().execute("c", {
			format: "pdf",
			outputPath: out,
			content: { pages: [{ paragraphs: ["hello 😀 世界 world"] }] },
		})) as Result;
		assert.equal(details(r).ok, true);
		const { PDFDocument } = await import("@cantoo/pdf-lib");
		assert.ok((await PDFDocument.load(fs.readFileSync(out))).getPageCount() >= 1);
	});

	it("renders Latin/Greek/Cyrillic/accents via the embedded Unicode font (no ? on re-extract)", async () => {
		const out = path.join(workspace, "unicode.pdf");
		const sample = "Café Ωμέγα Привет";
		const r = (await tool().execute("c", {
			format: "pdf",
			outputPath: out,
			content: { title: sample, pages: [{ paragraphs: [sample] }] },
		})) as Result;
		assert.equal(details(r).ok, true);
		// Re-extract the text layer and prove the accented/Greek/Cyrillic glyphs
		// survived (the old WinAnsi strip would have turned them all into "?").
		const { getDocumentProxy, extractText } = await import("unpdf");
		const proxy = await getDocumentProxy(new Uint8Array(fs.readFileSync(out)));
		const { text } = await extractText(proxy, { mergePages: true });
		assert.ok(text.includes("Café"), `accented Latin present: ${JSON.stringify(text)}`);
		assert.ok(text.includes("Ωμέγα"), "Greek present");
		assert.ok(text.includes("Привет"), "Cyrillic present");
		assert.ok(!text.includes("?"), `no '?' fallback in: ${JSON.stringify(text)}`);
	});
});

/* ─────────────────────────── image embedding ─────────────────────────── */

describe("make_document — image embedding (stub loader)", () => {
	it("embeds an image into a docx via the injected loader", async () => {
		const imgPath = path.join(workspace, "pic.png");
		fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const out = path.join(workspace, "withimg.docx");
		const t = makeMakeDocumentTool({ workspaceDir: workspace, cwd: workspace, loadImage: stubLoader() });
		const r = (await t.execute("c", {
			format: "docx",
			outputPath: out,
			content: { sections: [{ heading: "Pic", image: { path: imgPath } }] },
		})) as Result;
		assert.equal(details(r).ok, true);
		const entries = unzipSync(new Uint8Array(fs.readFileSync(out)));
		const mediaParts = Object.keys(entries).filter((n) => /^word\/media\//.test(n));
		assert.ok(mediaParts.length >= 1, "image landed in word/media/");
	});
});

/* ─────────────────────────── defaults + path guard ─────────────────────────── */

describe("make_document — output path handling", () => {
	it("auto-names the file in the workspace when outputPath is omitted", async () => {
		const r = (await tool().execute("c", {
			format: "docx",
			content: { sections: [{ paragraphs: ["hi"] }] },
		})) as Result;
		const d = details(r);
		assert.equal(d.ok, true);
		assert.ok(d.path, "a path was returned");
		assert.ok(path.resolve(d.path as string).startsWith(path.resolve(workspace)), "lands in workspace");
		assert.match(path.basename(d.path as string), /^document-[a-z0-9]+\.docx$/);
		assert.ok(fs.existsSync(d.path as string));
	});

	it("refuses to write outside the allowed roots", async () => {
		const outside =
			process.platform === "win32" ? "C:\\Windows\\Temp\\evil-brigade.docx" : "/etc/evil-brigade.docx";
		await assert.rejects(
			() => tool().execute("c", { format: "docx", outputPath: outside, content: {} }),
			/allowed roots|sensitive|system/i,
		);
	});

	it("a blank / whitespace outputPath falls back to an auto-named workspace file", async () => {
		// A whitespace-only path is treated as "not given" → auto-named in the
		// workspace (rather than erroring), matching the omitted-outputPath path.
		const r = (await tool().execute("c", { format: "docx", outputPath: "   ", content: {} })) as Result;
		const d = details(r);
		assert.equal(d.ok, true);
		assert.match(path.basename(d.path as string), /^document-[a-z0-9]+\.docx$/);
		assert.ok(path.resolve(d.path as string).startsWith(path.resolve(workspace)));
	});
});

/* ─────────────────────────── empty content still valid ─────────────────────────── */

describe("make_document — minimal/empty content", () => {
	it("an empty docx body still produces a valid file", async () => {
		const out = path.join(workspace, "empty.docx");
		const r = (await tool().execute("c", { format: "docx", outputPath: out, content: {} })) as Result;
		assert.equal(details(r).ok, true);
		const entries = unzipSync(new Uint8Array(fs.readFileSync(out)));
		assert.ok("word/document.xml" in entries);
	});

	it("an empty xlsx still produces a workbook with one sheet", async () => {
		const out = path.join(workspace, "empty.xlsx");
		const r = (await tool().execute("c", { format: "xlsx", outputPath: out, content: {} })) as Result;
		assert.equal(details(r).ok, true);
		const entries = unzipSync(new Uint8Array(fs.readFileSync(out)));
		assert.ok(Object.keys(entries).some((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)));
	});
});
