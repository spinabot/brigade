/**
 * Embedded-image extraction for OOXML documents (PPTX / DOCX / XLSX) — the
 * "see the wireframes inside the deck" half of `analyze_media`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE (read before changing)
 * ─────────────────────────────────────────────────────────────────────────
 * `analyze_media`'s OOXML readers return only the document TEXT (slide titles,
 * paragraph runs, cell strings). But a real deck carries its substance in the
 * PICTURES — wireframes, screenshots, diagrams, charts rendered to images. Asked
 * to "go through the wireframe images in this .pptx", the agent used to have to
 * shell out to `python zipfile` to pull `ppt/media/*.png`, then re-run
 * `analyze_media` on each PNG. This module closes that gap: it extracts the
 * embedded raster images straight from the already-unzipped OOXML entries the
 * reader has in hand, so the tool can route them through the SAME image path it
 * already uses (image blocks on a vision model / a provider on a text-only one).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SLIDE / PAGE SCOPING (the important part for PPTX)
 * ─────────────────────────────────────────────────────────────────────────
 * A PPTX maps images to slides through the relationship graph, NOT by filename:
 *   presentation.xml      → <p:sldId r:id="rIdN"/> in PRESENTATION order
 *   presentation.xml.rels → rIdN → ppt/slides/slideK.xml
 *   slideK.xml.rels       → rIdM → ../media/imageX.png (that slide's images)
 * So slide N's images are exactly the `../media/*` targets in that slide's rels
 * file — which is what the manual workaround discovered ("SLIDE 8 rId3
 * ../media/image16.png"). We resolve slides in presentation order, then honour
 * the existing `pages` range over THAT order, returning only the selected
 * slides' images. (Image filename numbering does NOT track slide order, so a
 * filename-only approach would scope wrong — we never use it for PPTX.)
 *
 * DOCX/XLSX have no robust per-page image mapping (a Word page is a layout-time
 * concept, not in the XML), so we return ALL embedded images (capped) when no
 * scope applies — the `pages` range is honoured only for PPTX.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UNSUPPORTED EMBEDS
 * ─────────────────────────────────────────────────────────────────────────
 * Only provider-DECODABLE raster types are surfaced (png/jpeg/gif/webp/bmp/
 * tiff). Vector / exotic embeds — `.emf` / `.wmf` (Windows metafiles) and
 * `.wdp` (JPEG-XR / HD Photo) — cannot be decoded without a native dep, so they
 * are SKIPPED with a count (the real failure case hit `hdphoto1.wdp`). The
 * caller reports "N image(s) skipped (unsupported format)" rather than throwing.
 *
 * Pure functions over an already-unzipped entry map; no I/O, no provider calls.
 */

/** An embedded image pulled out of an OOXML document. */
export interface ExtractedOoxmlImage {
	/** Zip entry name, e.g. `ppt/media/image16.png`. */
	entry: string;
	/** Raw image bytes. */
	bytes: Buffer;
	/** Detected MIME (always a provider-decodable raster type). */
	mime: string;
	/** 1-indexed slide number (PPTX only) when the image is mapped to a slide. */
	slide?: number;
	/** Human label, e.g. "slide 8 image 1" or "image 1". */
	label: string;
}

/** Result of an extraction pass. */
export interface OoxmlImageExtraction {
	/** Images selected (after `pages` scoping) and within the cap. */
	images: ExtractedOoxmlImage[];
	/** How many decodable images matched the scope BEFORE the cap (for "N of M"). */
	matched: number;
	/** How many embeds were skipped because their format is not decodable. */
	skipped: number;
}

/**
 * Extensions of embedded media that providers / jimp can decode. Everything
 * else (`emf`/`wmf` vector metafiles, `wdp` JPEG-XR) is skipped — see header.
 */
const DECODABLE_EXT_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jpe: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
};

/** Lowercase extension (no dot) of a zip entry path. */
function entryExt(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot < 0) return "";
	return name.slice(dot + 1).toLowerCase();
}

/** The media directory prefix for each OOXML kind. */
function mediaPrefix(kind: "pptx" | "docx" | "xlsx"): string {
	switch (kind) {
		case "pptx":
			return "ppt/media/";
		case "docx":
			return "word/media/";
		case "xlsx":
			return "xl/media/";
	}
}

/**
 * Decode `&amp;`-style entities just enough to compare relationship targets
 * (targets rarely contain entities, but `&amp;` in a path would otherwise miss).
 */
function decodeRelTarget(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

/**
 * Resolve a relationship Target (relative to a `_rels` file's owning part)
 * against a base directory, collapsing `../` and `./` segments. E.g. base
 * `ppt/slides/` + target `../media/image1.png` → `ppt/media/image1.png`.
 */
export function resolveRelTarget(baseDir: string, target: string): string {
	const t = decodeRelTarget(target.trim()).replace(/^\/+/, "");
	// Absolute-within-package targets (start with "/") resolve from the root.
	const fromRoot = target.trim().startsWith("/");
	const baseParts = fromRoot ? [] : baseDir.split("/").filter(Boolean);
	const parts = [...baseParts];
	for (const seg of t.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return parts.join("/");
}

/** Directory portion of a part path (e.g. `ppt/slides/slide1.xml` → `ppt/slides`). */
function partDir(part: string): string {
	const slash = part.lastIndexOf("/");
	return slash < 0 ? "" : part.slice(0, slash);
}

/** The `_rels` sidecar path for a part (e.g. `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`). */
function relsPathFor(part: string): string {
	const dir = partDir(part);
	const file = part.slice(dir.length ? dir.length + 1 : 0);
	return `${dir ? dir + "/" : ""}_rels/${file}.rels`;
}

/** Decode a zip entry to a UTF-8 string (entries are Uint8Array). */
function entryToString(entries: Record<string, Uint8Array>, name: string): string | undefined {
	const u8 = entries[name];
	if (!u8) return undefined;
	// Avoid a fflate import here (keep this module pure/sync); TextDecoder handles UTF-8.
	return new TextDecoder("utf-8").decode(u8);
}

/**
 * Parse a `.rels` XML blob into `[ {id, target} ]`. Tolerant of attribute order
 * (Id before/after Target) and self-closing `<Relationship .../>`.
 */
export function parseRelationships(xml: string): Array<{ id: string; target: string }> {
	const out: Array<{ id: string; target: string }> = [];
	const relRe = /<Relationship\b([^>]*?)\/?>/g;
	let m: RegExpExecArray | null;
	while ((m = relRe.exec(xml)) !== null) {
		const attrs = m[1] ?? "";
		const id = /\bId="([^"]*)"/.exec(attrs)?.[1];
		const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1];
		if (id && target) out.push({ id, target });
	}
	return out;
}

/**
 * Resolve slide part paths in PRESENTATION order from `presentation.xml` +
 * `presentation.xml.rels`. Returns `[]` when the presentation graph can't be
 * read (the caller then falls back to filename order).
 */
export function resolveSlideOrder(entries: Record<string, Uint8Array>): string[] {
	const presXml = entryToString(entries, "ppt/presentation.xml");
	const relsXml = entryToString(entries, "ppt/_rels/presentation.xml.rels");
	if (!presXml || !relsXml) return [];
	const idToTarget = new Map<string, string>();
	for (const rel of parseRelationships(relsXml)) idToTarget.set(rel.id, rel.target);
	const order: string[] = [];
	// <p:sldId id="256" r:id="rId2"/> — the r:id ordering IS the slide order.
	const sldIdRe = /<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/?>/g;
	let m: RegExpExecArray | null;
	while ((m = sldIdRe.exec(presXml)) !== null) {
		const rId = m[1] as string;
		const target = idToTarget.get(rId);
		if (!target) continue;
		// presentation.xml lives in ppt/, so targets resolve from ppt/.
		const resolved = resolveRelTarget("ppt", target);
		if (entries[resolved]) order.push(resolved);
	}
	return order;
}

/**
 * Map each slide part to the decodable `../media/*` images it references, in
 * presentation order. Returns one entry per slide (slide 1-indexed by position
 * in `slideOrder`). Each slide's images preserve their reference order.
 */
function imagesPerSlide(
	entries: Record<string, Uint8Array>,
	slideOrder: string[],
): Array<{ slide: number; entries: string[] }> {
	const result: Array<{ slide: number; entries: string[] }> = [];
	for (let i = 0; i < slideOrder.length; i++) {
		const slidePart = slideOrder[i] as string;
		const relsXml = entryToString(entries, relsPathFor(slidePart));
		const imgs: string[] = [];
		if (relsXml) {
			const base = partDir(slidePart);
			for (const rel of parseRelationships(relsXml)) {
				const resolved = resolveRelTarget(base, rel.target);
				if (!resolved.startsWith("ppt/media/")) continue;
				if (!(resolved in entries)) continue;
				if (!DECODABLE_EXT_MIME[entryExt(resolved)] && !isSkippableMedia(resolved)) continue;
				imgs.push(resolved);
			}
		}
		result.push({ slide: i + 1, entries: imgs });
	}
	return result;
}

/** True when a media entry is a known-but-undecodable embed (emf/wmf/wdp/svg/…). */
function isSkippableMedia(entry: string): boolean {
	const ext = entryExt(entry);
	return ext === "emf" || ext === "wmf" || ext === "wdp" || ext === "svg" || ext === "emz" || ext === "wmz";
}

/** All `<prefix>media/*` entries in stable (numeric-aware) name order. */
function allMediaEntries(entries: Record<string, Uint8Array>, prefix: string): string[] {
	return Object.keys(entries)
		.filter((n) => n.startsWith(prefix) && entryExt(n).length > 0)
		.sort(numericAwareCompare);
}

/** Sort `image2.png` before `image10.png` (numeric-aware on the trailing number). */
function numericAwareCompare(a: string, b: string): number {
	const na = /(\d+)\.[^.]+$/.exec(a);
	const nb = /(\d+)\.[^.]+$/.exec(b);
	if (na && nb) {
		const d = parseInt(na[1] as string, 10) - parseInt(nb[1] as string, 10);
		if (d !== 0) return d;
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Extract embedded images from already-unzipped OOXML entries.
 *
 *   • PPTX: resolves slide order via the presentation graph and maps images to
 *     slides through each slide's rels; honours `inRange` over slide position.
 *     Falls back to filename order (all slides) when the graph is unreadable.
 *   • DOCX/XLSX: returns all media-folder images (no page scoping).
 *
 * `inRange(slideNum)` is the page-range predicate (from `parsePageRange`) and is
 * applied to PPTX SLIDE numbers only. `cap` bounds the number of images RETURNED
 * (the per-call image cap); `matched` reports how many decodable images were in
 * scope before the cap so the caller can say "showing N of M". `skipped` counts
 * undecodable embeds in scope.
 */
export function extractOoxmlImages(
	entries: Record<string, Uint8Array>,
	kind: "pptx" | "docx" | "xlsx",
	opts: { inRange?: (slideNum: number) => boolean; cap: number },
): OoxmlImageExtraction {
	const prefix = mediaPrefix(kind);
	const inRange = opts.inRange ?? (() => true);

	// Build the ordered, scoped list of candidate entries (+ slide map for pptx).
	const ordered: Array<{ entry: string; slide?: number }> = [];
	if (kind === "pptx") {
		const slideOrder = resolveSlideOrder(entries);
		if (slideOrder.length > 0) {
			const perSlide = imagesPerSlide(entries, slideOrder);
			const seen = new Set<string>();
			for (const { slide, entries: imgs } of perSlide) {
				if (!inRange(slide)) continue;
				for (const e of imgs) {
					// An image shared across slides (rare) is attributed to its FIRST
					// in-scope slide to avoid duplicate blocks.
					if (seen.has(e)) continue;
					seen.add(e);
					ordered.push({ entry: e, slide });
				}
			}
		} else {
			// Presentation graph unreadable → fall back to every media file (no slide
			// scoping possible). This keeps a malformed-but-openable deck working.
			for (const e of allMediaEntries(entries, prefix)) ordered.push({ entry: e });
		}
	} else {
		for (const e of allMediaEntries(entries, prefix)) ordered.push({ entry: e });
	}

	// Partition into decodable (kept) vs skippable (counted), then apply the cap.
	let matched = 0;
	let skipped = 0;
	const images: ExtractedOoxmlImage[] = [];
	const perSlideSeq = new Map<number | "none", number>();
	for (const cand of ordered) {
		const mime = DECODABLE_EXT_MIME[entryExt(cand.entry)];
		if (!mime) {
			if (isSkippableMedia(cand.entry)) skipped += 1;
			continue;
		}
		matched += 1;
		if (images.length >= opts.cap) continue; // count toward `matched`, don't emit
		const u8 = entries[cand.entry];
		if (!u8) continue;
		const slideKey: number | "none" = cand.slide ?? "none";
		const seq = (perSlideSeq.get(slideKey) ?? 0) + 1;
		perSlideSeq.set(slideKey, seq);
		const label = cand.slide ? `slide ${cand.slide} image ${seq}` : `image ${seq}`;
		images.push({
			entry: cand.entry,
			bytes: Buffer.from(u8),
			mime,
			...(cand.slide ? { slide: cand.slide } : {}),
			label,
		});
	}
	return { images, matched, skipped };
}
