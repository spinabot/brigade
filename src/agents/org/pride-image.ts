/**
 * Save the Pride org chart as a PNG on disk so any channel adapter
 * with `outbound.sendMedia` can attach it as a normal media message.
 * Called by the `org({action:"show", format:"image"})` tool path —
 * the LLM never sees the HTML/PNG bytes, only the file path it can
 * hand to a channel-send-media tool.
 *
 * Pipeline:
 *   1. `pride-html.ts` builds an HTML document (deterministic, in TS)
 *   2. This file's tiny Playwright wrapper opens system Chrome
 *      (headless), navigates to the HTML, and screenshots → PNG
 *   3. PNG saved to `~/.brigade/cache/org-charts/<hash>.png`
 *
 * No SVG, no twemoji fetch, no resvg — the browser handles HTML
 * parsing, CSS layout, font rendering, AND color emoji natively
 * via the OS emoji font (Apple Color Emoji / Segoe UI Emoji /
 * Noto Color Emoji). One engine, every emoji renders in color.
 *
 * Cache: same HTML body → same SHA1 hash → same file (idempotent).
 * `force:true` re-renders even when cached.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveCacheDir } from "../../config/paths.js";
import {
  renderPrideHtmlWithPins,
  type RenderPrideHtmlOptions,
} from "./pride-html.js";
import type { OrgGraph } from "./types.js";

export interface SaveOrgChartImageOptions extends RenderPrideHtmlOptions {
  /** Override the output directory. Default: `~/.brigade/cache/org-charts/`. */
  outDir?: string;
  /** When true, re-renders and overwrites even if a cached file exists. */
  force?: boolean;
  /**
   * Browser-screenshot test seam. Production callers leave this
   * undefined; the helper dynamically imports `playwright-core` and
   * launches system Chrome. Tests inject a stub buffer to avoid
   * spawning a real browser.
   */
  htmlScreenshot?: (
    html: string,
    viewport: { width: number; height: number },
  ) => Promise<{ buffer: Buffer; width: number; height: number }>;
}

export interface OrgChartImageResult {
  /** Absolute path to the written PNG. */
  filePath: string;
  /** Always `"image/png"` (HTML→PNG is the only engine now). */
  mimeType: "image/png";
  format: "png";
  /** Always `true` — we no longer ship a raw-SVG fallback. */
  rasterized: true;
  /** Pixel width of the PNG. */
  width: number;
  /** Pixel height of the PNG. */
  height: number;
  /** SHA1 hash prefix (12 chars) used in the filename. */
  hash: string;
  /** True when the file already existed and was reused. */
  cached: boolean;
  /** The visual theme id that produced this chart (see `pride-themes.ts`). */
  themeId: string;
  /** Human-readable name of the theme. */
  themeName: string;
}

/**
 * Render the Pride chart as a PNG. Throws if the browser launch
 * fails — there's no fallback path. The browser binary is provided
 * by either:
 *   - System Chrome (detected via `channel: "chrome"`)
 *   - Bundled Chromium (`npx playwright install chromium`)
 */
export async function saveOrgChartImage(
  graph: OrgGraph,
  departmentHeads: Record<string, string> | undefined,
  opts: SaveOrgChartImageOptions = {},
): Promise<OrgChartImageResult> {
  const outDir = opts.outDir ?? path.join(resolveCacheDir(), "org-charts");
  await fs.mkdir(outDir, { recursive: true });
  // Opportunistic cache GC — every render reaps stale + over-cap
  // files. Best-effort, swallowed errors. Don't await: keep the
  // happy path latency identical for the caller.
  void gcOrgChartsCache({ cacheDir: outDir });

  const { html, width, height, themeId, themeName } = renderPrideHtmlWithPins(
    graph,
    departmentHeads,
    {
      ...(opts.crewName !== undefined ? { crewName: opts.crewName } : {}),
      ...(opts.rng !== undefined ? { rng: opts.rng } : {}),
      ...(opts.story !== undefined ? { story: opts.story } : {}),
      ...(opts.themeId !== undefined ? { themeId: opts.themeId } : {}),
      ...(opts.platformTag !== undefined ? { platformTag: opts.platformTag } : {}),
    },
  );
  const hash = createHash("sha1").update(html).digest("hex").slice(0, 12);
  const filePath = path.join(outDir, `${hash}.png`);

  if (!opts.force && (await pathExists(filePath))) {
    return {
      filePath,
      mimeType: "image/png",
      format: "png",
      rasterized: true,
      width,
      height,
      hash,
      cached: true,
      themeId,
      themeName,
    };
  }

  const screenshot = opts.htmlScreenshot ?? defaultHtmlScreenshot;
  const png = await screenshot(html, { width, height });
  await fs.writeFile(filePath, png.buffer);
  return {
    filePath,
    mimeType: "image/png",
    format: "png",
    rasterized: true,
    width: png.width,
    height: png.height,
    hash,
    cached: false,
    themeId,
    themeName,
  };
}

/* ─── tiny Playwright wrapper (15 lines of real code) ────────────── */
/**
 * Launch system Chrome via `playwright-core` (already in deps),
 * navigate to the HTML, screenshot it. No SVG fallback — if the
 * browser can't launch, this throws and the caller sees the error.
 */
async function defaultHtmlScreenshot(
  html: string,
  viewport: { width: number; height: number },
): Promise<{ buffer: Buffer; width: number; height: number }> {
  // Dynamic import so the module typechecks even if `playwright-core`
  // is absent at compile time. (It IS in Brigade's deps, but using a
  // dynamic Function-based importer keeps the SDK-aware import flow
  // consistent with how Brigade lazy-loads other heavy modules.)
  const importer = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<unknown>;
  const mod = (await importer("playwright-core")) as {
    chromium?: typeof import("playwright-core").chromium;
  };
  if (!mod.chromium) {
    throw new Error("playwright-core missing chromium namespace");
  }
  const chromium = mod.chromium;

  // Try system Chrome first (zero-install for most users). Fall back
  // to bundled Chromium (`npx playwright install chromium`).
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 8000 });
    // Give the browser a beat to lay out + render emoji glyphs.
    await page.waitForTimeout(200);
    const buf = await page.screenshot({
      type: "png",
      fullPage: false,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      omitBackground: false,
    });
    await context.close();
    return {
      buffer: buf,
      width: viewport.width * 2,
      height: viewport.height * 2,
    };
  } finally {
    await browser.close();
  }
}

/* ─── helpers ────────────────────────────────────────── */

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/* ─── transient-image registry + cache GC ────────────────────────── */
/**
 * Module-level Set of image paths the producer (org-tool) considers
 * transient — they exist only to be dispatched once, then unlinked.
 * `send_media` consumes the entry on successful dispatch and unlinks
 * the file even if the LLM forgot to pass `deleteAfterSend:true`.
 * Belt + suspenders for the channel-served chart freshness contract.
 */
const transientImagePaths = new Set<string>();

function normaliseTransientKey(p: string): string {
  return path.resolve(p);
}

/**
 * Mark a generated PNG/SVG as transient. Org-tool calls this on
 * every channel-routed `format:"image"` render so the file is reaped
 * after delivery. Idempotent.
 */
export function markTransientImage(filePath: string): void {
  transientImagePaths.add(normaliseTransientKey(filePath));
}

/**
 * Check + clear a transient-marker for `filePath`. Returns true if
 * the path was registered (and was therefore consumed). `send_media`
 * uses this to decide whether to unlink even when the caller didn't
 * pass `deleteAfterSend:true` explicitly.
 */
export function consumeTransientImage(filePath: string): boolean {
  const key = normaliseTransientKey(filePath);
  return transientImagePaths.delete(key);
}

/**
 * Opportunistic cache GC for `~/.brigade/cache/org-charts/`. Reaps
 * (a) files older than `maxAgeMs` (default 6h), then (b) trims the
 * remaining set down to `maxFiles` (default 50) keeping the newest.
 *
 * Called lazily from `saveOrgChartImage` BEFORE writing a new file
 * so each render does its own cleanup — no separate timer to plumb
 * through the gateway lifecycle. Best-effort: every error is
 * swallowed; chart rendering must never fail because GC didn't.
 */
export async function gcOrgChartsCache(opts: {
  cacheDir?: string;
  maxAgeMs?: number;
  maxFiles?: number;
} = {}): Promise<void> {
  const cacheDir =
    opts.cacheDir ?? path.join(resolveCacheDir(), "org-charts");
  const maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60 * 1000;
  const maxFiles = opts.maxFiles ?? 50;
  try {
    const names = await fs.readdir(cacheDir);
    const stats = await Promise.allSettled(
      names.map(async (name) => {
        const file = path.join(cacheDir, name);
        const st = await fs.stat(file);
        return { file, mtimeMs: st.mtimeMs };
      }),
    );
    const entries = stats.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    const now = Date.now();
    const stale = entries.filter((e) => now - e.mtimeMs > maxAgeMs);
    const staleSet = new Set(stale.map((e) => e.file));
    await Promise.allSettled(stale.map((e) => fs.unlink(e.file)));
    const fresh = entries
      .filter((e) => !staleSet.has(e.file))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (fresh.length > maxFiles) {
      await Promise.allSettled(
        fresh.slice(maxFiles).map((e) => fs.unlink(e.file)),
      );
    }
  } catch {
    // GC is best-effort. Missing cache dir, permission errors,
    // mid-read mutations — all OK to ignore.
  }
}
