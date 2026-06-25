/**
 * `make_document` — CREATE a Word / Excel / PowerPoint / PDF file from
 * structured content. The WRITE keystone of Brigade's "cowork assistant"
 * surface; the create-side sibling of `analyze_media` (read) and the producer
 * for `send_media` (deliver).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A NATIVE TOOL (read before changing)
 * ─────────────────────────────────────────────────────────────────────────
 * Brigade has NO code sandbox and is pure-JS by doctrine — there is no
 * python / pandoc / libreoffice to shell out to. Hand-rolling a .docx in
 * `bash` is impossible (OOXML is a zip of XML) and producing one any other way
 * silently fails. So document creation is a first-class tool backed by pure-JS
 * libraries with zero native build:
 *   - docx  → `docx` (Document + Packer)
 *   - xlsx  → `exceljs` (Workbook)
 *   - pptx  → `pptxgenjs`
 *   - pdf   → `@cantoo/pdf-lib` (maintained pdf-lib fork)
 * Images embed via `jimp` (decode + fit + re-encode to a library-friendly
 * raster) — see `doc-shared.ts`.
 *
 * SECURITY: the output path is resolved + scoped through the SAME guard as
 * `analyze_media`'s local reads (`resolveOutputPath` → media-path denylist +
 * allowed-root containment). Writing outside workspace / cwd / cache / temp is
 * refused. Default output lands in the workspace. NOT owner-only — creating a
 * file into the workspace is safe, and the path guard is the real boundary.
 *
 * DELIVERY: the tool writes the file + returns `{ok, path, format, bytes}`. The
 * agent hands it to the user via `send_media({path})` on a channel (the doc MIME
 * is already mapped there) or reports the workspace path on the TUI.
 */

import { Type, type Static } from "typebox";

import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";
import {
	acquireImageForEmbed,
	defaultOutputName,
	embedUnicodeFont,
	isFormulaCell,
	resolveOutputPath,
	sanitizeForFont,
	toExcelCellValue,
	writeDocFile,
	type DocCellInput,
	type DocFormat,
	type ImageLoader,
	type PdfFontLike,
} from "./doc-shared.js";

/* ─────────────────────────── params ─────────────────────────── */

/** An image reference embeddable in docx/pptx/pdf content. */
const ImageRef = Type.Object({
	path: Type.Optional(Type.String({ description: "Local file path to the image (scoped to allowed roots)." })),
	url: Type.Optional(Type.String({ description: "http(s) URL to the image (SSRF-guarded)." })),
});

/** A simple table (rows of string cells). */
const TableSpec = Type.Object({
	rows: Type.Array(Type.Array(Type.String()), {
		description: "Table rows; each row is an array of cell strings. The first row is treated as a header.",
	}),
});

const DocxSection = Type.Object({
	heading: Type.Optional(Type.String({ description: "Section heading text." })),
	level: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 6, description: "Heading level 1-6 (default 1)." }),
	),
	paragraphs: Type.Optional(Type.Array(Type.String(), { description: "Body paragraphs." })),
	bullets: Type.Optional(Type.Array(Type.String(), { description: "Bulleted list items." })),
	table: Type.Optional(TableSpec),
	image: Type.Optional(ImageRef),
});

const PdfPage = Type.Object({
	heading: Type.Optional(Type.String({ description: "Page heading." })),
	paragraphs: Type.Optional(Type.Array(Type.String(), { description: "Body paragraphs (wrapped to the page width)." })),
	image: Type.Optional(ImageRef),
});

/** A formula cell: `{ formula: "SUM(B2:B10)" }` (no leading "="). */
const FormulaCell = Type.Object({
	formula: Type.String({ description: 'An Excel formula WITHOUT the leading "=" (e.g. "SUM(B2:B10)").' }),
	numFmt: Type.Optional(Type.String({ description: 'Optional number format for this cell (e.g. "#,##0.00").' })),
});

/** A cell value: a string, a number, or a formula object. */
const XlsxCellValue = Type.Union([Type.String(), Type.Number(), FormulaCell]);

const XlsxSheet = Type.Object({
	name: Type.Optional(Type.String({ description: "Sheet name (default Sheet1, Sheet2, …)." })),
	header: Type.Optional(Type.Array(Type.String(), { description: "Optional header row (bolded)." })),
	rows: Type.Array(Type.Array(XlsxCellValue), {
		description:
			'Data rows; each cell is a string, a number, or a formula object { formula: "SUM(A1:A3)", numFmt? }.',
	}),
	numberFormats: Type.Optional(
		Type.Array(Type.Union([Type.String(), Type.Null()]), {
			description:
				'Optional per-column number formats, by column index (e.g. ["@", "#,##0.00", "0%"]). null/"" leaves a column default.',
		}),
	),
});

/** A single named data series for a chart. */
const ChartSeries = Type.Object({
	name: Type.Optional(Type.String({ description: "Series label (legend)." })),
	values: Type.Array(Type.Number(), { description: "Numeric values, aligned to `categories`." }),
});

/** A chart placed on a slide (bar / line / pie). */
const ChartSpec = Type.Object({
	type: Type.Union([Type.Literal("bar"), Type.Literal("line"), Type.Literal("pie")], {
		description: "Chart type: bar, line, or pie.",
	}),
	title: Type.Optional(Type.String({ description: "Chart title." })),
	categories: Type.Array(Type.String(), { description: "Category (x-axis) labels." }),
	series: Type.Array(ChartSeries, { description: "One or more data series (pie uses the first)." }),
});

const PptxSlide = Type.Object({
	title: Type.Optional(Type.String({ description: "Slide title." })),
	bullets: Type.Optional(Type.Array(Type.String(), { description: "Slide bullet points." })),
	image: Type.Optional(ImageRef),
	chart: Type.Optional(ChartSpec),
	notes: Type.Optional(Type.String({ description: "Speaker notes." })),
});

const DocContent = Type.Object({
	title: Type.Optional(Type.String({ description: "Document title (docx/pdf cover heading)." })),
	sections: Type.Optional(Type.Array(DocxSection, { description: "docx sections." })),
	pages: Type.Optional(Type.Array(PdfPage, { description: "pdf pages." })),
	sheets: Type.Optional(Type.Array(XlsxSheet, { description: "xlsx sheets." })),
	slides: Type.Optional(Type.Array(PptxSlide, { description: "pptx slides." })),
});

const MakeDocumentParams = Type.Object({
	format: Type.Union(
		[Type.Literal("docx"), Type.Literal("xlsx"), Type.Literal("pptx"), Type.Literal("pdf")],
		{
			description:
				"The document format to create: docx (Word), xlsx (Excel), pptx (PowerPoint), or pdf.",
		},
	),
	outputPath: Type.Optional(
		Type.String({
			description:
				"Where to write the file. Relative paths resolve against the workspace; omit for an auto-named file in the workspace (e.g. document-ab12cd.docx). Must land inside an allowed root (workspace / cwd / cache / temp).",
		}),
	),
	content: Type.Optional(
		Type.Intersect([DocContent], {
			description:
				"Structured content keyed by format: docx→{title?, sections:[{heading?,level?,paragraphs?,bullets?,table?,image?}]}; xlsx→{sheets:[{name?,header?,rows}]}; pptx→{slides:[{title?,bullets?,image?,notes?}]}; pdf→{title?, pages:[{heading?,paragraphs?,image?}]}.",
		}),
	),
});

export interface MakeDocumentDetails {
	ok: boolean;
	path?: string;
	format: DocFormat;
	bytes?: number;
	pages?: number;
	sheets?: number;
	slides?: number;
	sections?: number;
	warning?: string;
	message?: string;
}

/* ─────────────────────────── tool factory ─────────────────────────── */

export interface MakeMakeDocumentToolOptions {
	/** Workspace dir — the default output root + an allowed write root. */
	workspaceDir?: string;
	/** Process cwd — an allowed write root + relative-path base. */
	cwd?: string;
	/** Caller's agent id (currently informational; reserved for per-agent scoping). */
	agentId?: string;
	/** Test seam — replace the jimp image loader so embeds run without a codec. */
	loadImage?: ImageLoader;
}

type Content = Static<typeof DocContent>;

export function makeMakeDocumentTool(
	opts: MakeMakeDocumentToolOptions = {},
): BrigadeTool<typeof MakeDocumentParams, MakeDocumentDetails> {
	const rootOpts = {
		...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
		...(opts.cwd ? { cwd: opts.cwd } : {}),
	};
	const imageOpts = {
		...rootOpts,
		...(opts.loadImage ? { loadImage: opts.loadImage } : {}),
	};

	return {
		name: "make_document",
		label: "Make Document",
		displaySummary: "creating a document",
		// NOT owner-only: creating a file into the workspace is a safe, read-like
		// capability. The path guard (resolveOutputPath) is the real boundary and
		// runs for every sender.
		ownerOnly: false,
		description: [
			"Create a Word (docx), Excel (xlsx), PowerPoint (pptx), or PDF file from structured content, then return its path.",
			"Pass `format` and `content` (shape depends on format): docx→{title?, sections:[{heading?,level?,paragraphs?,bullets?,table?,image?}]}; xlsx→{sheets:[{name?,header?,rows}]}; pptx→{slides:[{title?,bullets?,image?,notes?}]}; pdf→{title?, pages:[{heading?,paragraphs?,image?}]}.",
			"Images embed from a local `path` or `url`. The file is written into the workspace by default (pass `outputPath` to choose). To send it to the user, follow up with `send_media({path})`; to change an existing file use `edit_document`. Never hand-roll a document in bash — this is the only correct surface.",
		].join(" "),
		parameters: MakeDocumentParams,
		execute: async (
			_toolCallId,
			args: Static<typeof MakeDocumentParams>,
			signal,
		): Promise<AgentToolResult<MakeDocumentDetails>> => {
			const format = args.format as DocFormat;
			const content: Content = (args.content as Content | undefined) ?? {};
			const outRaw =
				typeof args.outputPath === "string" && args.outputPath.trim()
					? args.outputPath.trim()
					: defaultOutputName(format);
			// Resolve + scope the output path BEFORE building bytes (fail fast on a
			// refused path so we don't waste the build).
			const absPath = resolveOutputPath(outRaw, rootOpts);

			let bytes: Buffer;
			let details: MakeDocumentDetails;
			switch (format) {
				case "docx": {
					const built = await buildDocx(content, imageOpts, signal);
					bytes = built.bytes;
					details = { ok: true, format, sections: built.sections };
					break;
				}
				case "xlsx": {
					const built = await buildXlsx(content);
					bytes = built.bytes;
					details = { ok: true, format, sheets: built.sheets };
					break;
				}
				case "pptx": {
					const built = await buildPptx(content, imageOpts, signal);
					bytes = built.bytes;
					details = { ok: true, format, slides: built.slides };
					break;
				}
				case "pdf": {
					const built = await buildPdf(content, imageOpts, signal);
					bytes = built.bytes;
					details = { ok: true, format, pages: built.pages };
					break;
				}
			}

			const written = await writeDocFile(absPath, bytes);
			return jsonResult({ ...details, path: absPath, bytes: written }) as AgentToolResult<MakeDocumentDetails>;
		},
	};
}

/* ─────────────────────────── docx builder ─────────────────────────── */

async function buildDocx(
	content: Content,
	imageOpts: Parameters<typeof acquireImageForEmbed>[1],
	signal: AbortSignal | undefined,
): Promise<{ bytes: Buffer; sections: number }> {
	const docx = await import("docx");
	const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, ImageRun, WidthType } = docx;

	const headingFor = (level: number | undefined): (typeof HeadingLevel)[keyof typeof HeadingLevel] => {
		switch (level) {
			case 1:
				return HeadingLevel.HEADING_1;
			case 2:
				return HeadingLevel.HEADING_2;
			case 3:
				return HeadingLevel.HEADING_3;
			case 4:
				return HeadingLevel.HEADING_4;
			case 5:
				return HeadingLevel.HEADING_5;
			case 6:
				return HeadingLevel.HEADING_6;
			default:
				return HeadingLevel.HEADING_1;
		}
	};

	const children: InstanceType<typeof Paragraph>[] | Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];
	const blocks: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];

	if (content.title && content.title.trim()) {
		blocks.push(new Paragraph({ text: content.title.trim(), heading: HeadingLevel.TITLE }));
	}

	const sections = Array.isArray(content.sections) ? content.sections : [];
	for (const section of sections) {
		if (section.heading && section.heading.trim()) {
			blocks.push(new Paragraph({ text: section.heading.trim(), heading: headingFor(section.level) }));
		}
		for (const para of section.paragraphs ?? []) {
			blocks.push(new Paragraph({ children: [new TextRun(String(para ?? ""))] }));
		}
		for (const bullet of section.bullets ?? []) {
			blocks.push(new Paragraph({ text: String(bullet ?? ""), bullet: { level: 0 } }));
		}
		if (section.table && Array.isArray(section.table.rows) && section.table.rows.length > 0) {
			const rows = section.table.rows.map(
				(row, rowIdx) =>
					new TableRow({
						children: (row ?? []).map(
							(cell) =>
								new TableCell({
									children: [
										new Paragraph({
											children: [new TextRun({ text: String(cell ?? ""), bold: rowIdx === 0 })],
										}),
									],
								}),
						),
					}),
			);
			blocks.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
		}
		if (section.image && (section.image.path || section.image.url)) {
			const img = await acquireImageForEmbed(section.image, { ...imageOpts, ...(signal ? { signal } : {}) });
			const { width, height } = fitDimensions(img.width, img.height, 600, 600);
			blocks.push(
				new Paragraph({
					children: [
						new ImageRun({
							// docx's ImageRun uses "jpg" (not the MIME "jpeg") for its type tag.
							type: img.format === "jpeg" ? "jpg" : "png",
							data: img.bytes,
							transformation: { width, height },
						}),
					],
				}),
			);
		}
	}

	// A wholly-empty doc still needs at least one paragraph to be valid.
	if (blocks.length === 0) blocks.push(new Paragraph({ children: [new TextRun("")] }));
	void children;

	const doc = new Document({ sections: [{ children: blocks }] });
	const bytes = await Packer.toBuffer(doc);
	return { bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), sections: sections.length };
}

/* ─────────────────────────── xlsx builder ─────────────────────────── */

async function buildXlsx(content: Content): Promise<{ bytes: Buffer; sheets: number }> {
	const ExcelJSImport = await import("exceljs");
	const ExcelJS =
		(ExcelJSImport as unknown as { default?: typeof ExcelJSImport }).default ?? ExcelJSImport;
	const workbook = new ExcelJS.Workbook();
	workbook.creator = "Brigade";
	workbook.created = new Date();

	type SheetSpec = NonNullable<Content["sheets"]>[number];
	const sheets = Array.isArray(content.sheets) ? content.sheets : [];
	const effective: SheetSpec[] = sheets.length > 0 ? sheets : [{ rows: [] } as SheetSpec];
	let idx = 0;
	for (const sheet of effective) {
		idx += 1;
		const name = sanitizeSheetName(sheet.name, idx);
		const ws = workbook.addWorksheet(name);
		// Optional per-column number formats applied to data rows below.
		const columnFormats = Array.isArray((sheet as { numberFormats?: unknown }).numberFormats)
			? ((sheet as { numberFormats?: Array<string | null> }).numberFormats ?? [])
			: [];
		if (Array.isArray(sheet.header) && sheet.header.length > 0) {
			const headerRow = ws.addRow(sheet.header.map((h) => String(h ?? "")));
			headerRow.font = { bold: true };
		}
		const dataRows = (sheet.rows ?? []) as DocCellInput[][];
		for (const row of dataRows) {
			const added = ws.addRow([]);
			(row ?? []).forEach((c, colIdx) => {
				const cell = added.getCell(colIdx + 1);
				cell.value = toExcelCellValue(c as DocCellInput);
				// Per-cell numFmt (formula objects may carry one) wins over the column.
				const cellFmt = isFormulaCell(c) && typeof c.numFmt === "string" ? c.numFmt : undefined;
				const colFmt = typeof columnFormats[colIdx] === "string" ? columnFormats[colIdx] : undefined;
				const fmt = cellFmt || colFmt;
				if (fmt) cell.numFmt = fmt;
			});
			added.commit();
		}
	}

	const out = await workbook.xlsx.writeBuffer();
	return { bytes: Buffer.from(out as ArrayBuffer), sheets: effective.length };
}

/** Excel sheet names: ≤31 chars, no []:*?/\ — fall back to SheetN. */
function sanitizeSheetName(name: string | undefined, idx: number): string {
	const cleaned = (name ?? "").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31);
	return cleaned.length > 0 ? cleaned : `Sheet${idx}`;
}

/* ─────────────────────────── pptx builder ─────────────────────────── */

async function buildPptx(
	content: Content,
	imageOpts: Parameters<typeof acquireImageForEmbed>[1],
	signal: AbortSignal | undefined,
): Promise<{ bytes: Buffer; slides: number }> {
	const PptxImport = await import("pptxgenjs");
	const PptxGenJS =
		(PptxImport as unknown as { default?: new () => unknown }).default ??
		(PptxImport as unknown as new () => unknown);
	const pres = new (PptxGenJS as new () => PptxLike)();

	const slides = Array.isArray(content.slides) ? content.slides : [];
	const effective = slides.length > 0 ? slides : [{} as (typeof slides)[number]];
	for (const spec of effective) {
		const slide = pres.addSlide();
		if (spec.title && spec.title.trim()) {
			slide.addText(spec.title.trim(), {
				x: 0.5,
				y: 0.3,
				w: 9,
				h: 1,
				fontSize: 28,
				bold: true,
			});
		}
		const bullets = (spec.bullets ?? []).filter((b) => typeof b === "string");
		if (bullets.length > 0) {
			slide.addText(
				bullets.map((b) => ({ text: String(b ?? ""), options: { bullet: true } })),
				{ x: 0.7, y: 1.5, w: spec.image ? 5.3 : 8.6, h: 4.5, fontSize: 18 },
			);
		}
		if (spec.image && (spec.image.path || spec.image.url)) {
			const img = await acquireImageForEmbed(spec.image, { ...imageOpts, ...(signal ? { signal } : {}) });
			const { width, height } = fitDimensions(img.width, img.height, 360, 360);
			slide.addImage({
				data: `data:${img.mimeType};base64,${img.bytes.toString("base64")}`,
				x: bullets.length > 0 ? 6.2 : 2.5,
				y: 1.6,
				w: width / 96,
				h: height / 96,
			});
		}
		if (spec.chart && typeof slide.addChart === "function") {
			addSlideChart(slide, spec.chart);
		}
		if (spec.notes && spec.notes.trim() && typeof slide.addNotes === "function") {
			slide.addNotes(spec.notes.trim());
		}
	}

	const out = await pres.write({ outputType: "nodebuffer" });
	return { bytes: Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer), slides: effective.length };
}

/** A chart spec from the slide content. */
type ChartContent = NonNullable<Static<typeof PptxSlide>["chart"]>;

/**
 * Add a bar / line / pie chart to a slide via pptxgenjs `addChart`. The data is
 * shaped as pptxgenjs expects (one `{ name, labels, values }` per series); pie
 * uses the first series only. Malformed series (empty values) are dropped, and a
 * chart with nothing left to draw is skipped (never throws).
 */
function addSlideChart(slide: PptxSlideLike, chart: ChartContent): void {
	if (!slide.addChart) return;
	const categories = (chart.categories ?? []).map((c) => String(c ?? ""));
	const allSeries = (chart.series ?? [])
		.filter((s) => Array.isArray(s.values) && s.values.length > 0)
		.map((s, i) => ({
			name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : `Series ${i + 1}`,
			labels: categories,
			values: s.values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)),
		}));
	if (allSeries.length === 0) return;
	// Pie shows a single series; bar/line show all.
	const data = chart.type === "pie" ? allSeries.slice(0, 1) : allSeries;
	const opts: Record<string, unknown> = {
		x: 0.7,
		y: 1.6,
		w: 8.6,
		h: 4.4,
		showLegend: data.length > 1 || chart.type === "pie",
		showTitle: Boolean(chart.title && chart.title.trim()),
		...(chart.title && chart.title.trim() ? { title: chart.title.trim() } : {}),
	};
	slide.addChart(chart.type, data, opts);
}

/** Structural subset of the pptxgenjs API we drive. */
interface PptxSlideLike {
	addText(text: unknown, opts: Record<string, unknown>): void;
	addImage(opts: Record<string, unknown>): void;
	addChart?(type: string, data: unknown, opts: Record<string, unknown>): void;
	addNotes?(notes: string): void;
}
interface PptxLike {
	addSlide(): PptxSlideLike;
	write(opts: { outputType: string }): Promise<unknown>;
}

/* ─────────────────────────── pdf builder ─────────────────────────── */

async function buildPdf(
	content: Content,
	imageOpts: Parameters<typeof acquireImageForEmbed>[1],
	signal: AbortSignal | undefined,
): Promise<{ bytes: Buffer; pages: number }> {
	const pdfLib = await import("@cantoo/pdf-lib");
	const { PDFDocument, StandardFonts, rgb } = pdfLib;
	const pdf = await PDFDocument.create();
	// Prefer the bundled Unicode font (DejaVu Sans) so Latin/Greek/Cyrillic/accents
	// render; fall back to the WinAnsi standard fonts only if the asset is missing.
	let font: PdfFontLike;
	let bold: PdfFontLike;
	let unicodeFont = false;
	try {
		const uni = await embedUnicodeFont(pdf);
		// DejaVu Sans ships as a single face here; use it for both weights (bold is
		// approximated by the heading size, not a separate bold asset).
		font = uni;
		bold = uni;
		unicodeFont = true;
	} catch {
		font = await pdf.embedFont(StandardFonts.Helvetica);
		bold = await pdf.embedFont(StandardFonts.HelveticaBold);
	}

	const PAGE_W = 612;
	const PAGE_H = 792;
	const MARGIN = 54;
	const LINE = 16;
	const usableW = PAGE_W - MARGIN * 2;

	type Page = ReturnType<typeof pdf.addPage>;
	let page: Page = pdf.addPage([PAGE_W, PAGE_H]);
	let cursorY = PAGE_H - MARGIN;
	let pageCount = 1;

	const newPage = () => {
		page = pdf.addPage([PAGE_W, PAGE_H]);
		cursorY = PAGE_H - MARGIN;
		pageCount += 1;
	};
	const ensure = (need: number) => {
		if (cursorY - need < MARGIN) newPage();
	};
	const drawLines = (text: string, size: number, useBold: boolean) => {
		const f = useBold ? bold : font;
		for (const raw of String(text ?? "").split(/\r?\n/)) {
			// Strip only glyphs the chosen font lacks (with the Unicode font that
			// is just CJK/emoji; with the standard-font fallback it is non-WinAnsi).
			const safe = unicodeFont ? sanitizeForFont(raw, f) : stripUnsupportedGlyphs(raw);
			const wrapped = wrapText(safe, f, size, usableW);
			for (const line of wrapped) {
				ensure(size + 4);
				page.drawText(line, {
					x: MARGIN,
					y: cursorY - size,
					size,
					font: f as NonNullable<Parameters<typeof page.drawText>[1]>["font"],
					color: rgb(0, 0, 0),
				});
				cursorY -= size + 4;
			}
			// Preserve blank lines as paragraph spacing.
			if (wrapped.length === 0) cursorY -= size + 4;
		}
	};

	if (content.title && content.title.trim()) {
		ensure(26);
		drawLines(content.title.trim(), 22, true);
		cursorY -= LINE;
	}

	const pages = Array.isArray(content.pages) ? content.pages : [];
	for (let i = 0; i < pages.length; i++) {
		const spec = pages[i];
		if (!spec) continue;
		// Each spec starts a fresh page (after the first, which may carry the title).
		if (i > 0 || (content.title && content.title.trim())) newPage();
		if (spec.heading && spec.heading.trim()) {
			drawLines(spec.heading.trim(), 16, true);
			cursorY -= 6;
		}
		for (const para of spec.paragraphs ?? []) {
			drawLines(String(para ?? ""), 12, false);
			cursorY -= 6;
		}
		if (spec.image && (spec.image.path || spec.image.url)) {
			const img = await acquireImageForEmbed(spec.image, { ...imageOpts, ...(signal ? { signal } : {}) });
			const embedded = img.format === "png" ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
			const { width, height } = fitDimensions(img.width, img.height, usableW, 420);
			ensure(height + 8);
			page.drawImage(embedded, { x: MARGIN, y: cursorY - height, width, height });
			cursorY -= height + 10;
		}
	}

	// pdf-lib requires at least one page (we always added one) AND some content
	// or it is still a valid empty page — fine.
	void pageCount;
	const out = await pdf.save();
	return { bytes: Buffer.from(out), pages: pdf.getPageCount() };
}

/**
 * Greedy word-wrap to fit `maxWidth` at `size` for `font`. Hard-breaks overlong
 * tokens. The caller is responsible for glyph sanitation (so the Unicode-font
 * path keeps Latin/Greek/Cyrillic that the WinAnsi strip would have dropped).
 */
function wrapText(
	text: string,
	font: { widthOfTextAtSize: (s: string, size: number) => number },
	size: number,
	maxWidth: number,
): string[] {
	const sanitized = String(text ?? "");
	if (sanitized.trim().length === 0) return [];
	const words = sanitized.split(/\s+/).filter((w) => w.length > 0);
	const lines: string[] = [];
	let current = "";
	const widthOf = (s: string): number => {
		try {
			return font.widthOfTextAtSize(s, size);
		} catch {
			return s.length * size * 0.5;
		}
	};
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (widthOf(candidate) <= maxWidth) {
			current = candidate;
			continue;
		}
		if (current) lines.push(current);
		// The single word itself may exceed the width — hard-break it.
		if (widthOf(word) > maxWidth) {
			let chunk = "";
			for (const ch of word) {
				if (widthOf(chunk + ch) > maxWidth && chunk) {
					lines.push(chunk);
					chunk = ch;
				} else {
					chunk += ch;
				}
			}
			current = chunk;
		} else {
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

/**
 * The 14 PDF standard fonts are WinAnsi-encoded and throw on characters outside
 * that set (e.g. emoji, CJK). Replace anything non-WinAnsi with "?" so a stray
 * glyph never turns a valid call into a raw pdf-lib encode throw.
 */
function stripUnsupportedGlyphs(text: string): string {
	// Keep printable ASCII + the common Latin-1 supplement range; replace the rest.
	return String(text ?? "").replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ]/g, "?");
}

/* ─────────────────────────── shared ─────────────────────────── */

/** Fit (w,h) inside (maxW,maxH) preserving aspect ratio; never upscales. */
function fitDimensions(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
	if (w <= 0 || h <= 0) return { width: maxW, height: maxH };
	const scale = Math.min(1, maxW / w, maxH / h);
	return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
