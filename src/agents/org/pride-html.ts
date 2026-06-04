/**
 * Pride org chart — HTML generator (theme-aware, 180+ visual themes).
 *
 * Brigade renders the org chart as HTML, then a tiny ~15-line
 * Playwright wrapper in `pride-image.ts` opens system Chrome
 * (headless), loads the HTML, and screenshots it to PNG. That gives
 * us color emojis everywhere via the OS emoji font (Apple Color
 * Emoji / Segoe UI Emoji / Noto Color Emoji), pixel-perfect
 * positioning, and a workflow that mirrors any "html-to-png" library
 * — just without the wrapper around our own code.
 *
 * The 3-tier Pride policy is preserved exactly:
 *   - Higher Office (1 card, 👑 avatar)
 *   - Department Lead (1 per dept, dept-themed avatar + LEAD badge)
 *   - Team (everyone else, grouped in dept blocks)
 * Middle-management ranks collapse into the team band — that's the
 * brand: "no managers, just leads and the team". Locked.
 *
 * 180 visual themes live in `pride-themes.ts`. Each render picks
 * a random theme (or honours the caller's pinned `themeId`). Theme
 * affects palette + fonts + decorations; the structural layout
 * stays constant so the chart is always recognisable.
 *
 * Mascot slot: when a theme has `mascot: true` AND PNGs exist in
 * `src/agents/org/assets/mascots/` (copied to `dist/.../assets/mascots/`
 * by the postbuild step), the lion mascot is embedded as a base64
 * data URI in the corner of the chart. Otherwise, the theme just
 * uses the 🦁 emoji in the header and skips the corner mascot.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { flattenToThreeTiersWithPins } from "./pride-template.js";
import {
  pickFooterRule,
  pickStory,
  pickTaunt,
  type PrideStory,
} from "./pride-taunts.js";
import {
  pickPrideTheme,
  getPrideTheme,
  PRIDE_THEMES,
  PRIDE_THEME_COUNT,
  type PrideTheme,
} from "./pride-themes.js";
import type { OrgGraph } from "./types.js";

// Re-export so existing import sites (pride-image.test.ts) keep working.
export { pickPrideTheme, getPrideTheme, PRIDE_THEMES, PRIDE_THEME_COUNT };
export type { PrideTheme };

export interface RenderPrideHtmlOptions {
  /** Crew name appended after the lion in the header. */
  crewName?: string;
  /** Deterministic RNG for taunt/footer/story/theme selection (test seam). */
  rng?: () => number;
  story?: "auto" | "always" | "never";
  /**
   * Pin a theme by id. When undefined, a random theme is picked via
   * `rng()` so every render looks fresh.
   */
  themeId?: string;
  /** Monospace platform tag printed at the bottom of each card. */
  platformTag?: string;
}

export interface RenderPrideHtmlResult {
  html: string;
  width: number;
  height: number;
  /** The theme that was used (so callers can log / link to it). */
  themeId: string;
  themeName: string;
}

const PAD = 56;
const HEADER_H = 90;
const TOP_CARD = { w: 240, h: 132 };
const LEAD_CARD = { w: 240, h: 132 };
const TEAM_CARD_1COL = { w: 240, h: 96 };
const TEAM_CARD_2COL = { w: 116, h: 100 };
const BLOCK_PAD = 14;
const TEAM_GAP = 10;
const COL_GUTTER_X = 40;
const SPINE_Y_GAP = 40;
const FOOTER_GAP = 32;

export function renderPrideHtml(
  graph: OrgGraph,
  opts: RenderPrideHtmlOptions = {},
): RenderPrideHtmlResult {
  return renderPrideHtmlWithPins(graph, undefined, opts);
}

export function renderPrideHtmlWithPins(
  graph: OrgGraph,
  departmentHeads: Record<string, string> | undefined,
  opts: RenderPrideHtmlOptions = {},
): RenderPrideHtmlResult {
  const flat = flattenToThreeTiersWithPins(graph, departmentHeads);
  const rng = opts.rng ?? Math.random;
  const storyMode = opts.story ?? "auto";
  const crewName = (opts.crewName ?? "").trim();
  const platformTag = opts.platformTag ?? "";

  // Theme selection: pick BEFORE consuming rng for taunts so the same
  // seed deterministically picks the same theme + same taunt order.
  const theme: PrideTheme = opts.themeId
    ? getPrideTheme(opts.themeId) ?? pickPrideTheme(rng)
    : pickPrideTheme(rng);

  const N = flat.departments.length;

  const blocks = flat.departments.map((d) => {
    const team = d.team;
    const cols = team.length >= 4 ? 2 : 1;
    const card = cols === 2 ? TEAM_CARD_2COL : TEAM_CARD_1COL;
    const rows = Math.ceil(team.length / cols);
    const innerW = cols === 2 ? card.w * 2 + TEAM_GAP : card.w;
    const innerH = rows === 0 ? 0 : rows * card.h + (rows - 1) * TEAM_GAP;
    return {
      cols,
      card,
      rows,
      blockW: innerW + BLOCK_PAD * 2,
      blockH: innerH === 0 ? 0 : innerH + BLOCK_PAD * 2,
    };
  });

  const colWidths = blocks.map((b) => Math.max(LEAD_CARD.w, b.blockW));
  const colsTotalW =
    colWidths.reduce((a, b) => a + b, 0) +
    Math.max(0, N - 1) * COL_GUTTER_X;
  // Higher Office band can also push canvas width when there are
  // multiple c-suite members in a row.
  const HIGHER_OFFICE_GAP_PEEK = 24;
  const higherOfficeBandWidth =
    flat.higherOffice.length * TOP_CARD.w +
    Math.max(0, flat.higherOffice.length - 1) * HIGHER_OFFICE_GAP_PEEK;
  const contentW = Math.max(higherOfficeBandWidth, colsTotalW);
  const totalW = contentW + PAD * 2;

  const maxBlockH = Math.max(0, ...blocks.map((b) => b.blockH));
  const orgBlockH =
    N === 0
      ? 0
      : SPINE_Y_GAP +
        LEAD_CARD.h +
        (maxBlockH > 0 ? SPINE_Y_GAP + maxBlockH : 0);

  const includeStory =
    storyMode === "always" || (storyMode === "auto" && rng() < 0.5);
  const taunt = pickTaunt(rng);
  const footerRule = pickFooterRule(rng);
  const story: PrideStory | null = includeStory ? pickStory(rng) : null;

  const footerH = 64 + (story ? 80 : 0);
  const totalH =
    PAD + HEADER_H + TOP_CARD.h + orgBlockH + FOOTER_GAP + footerH + PAD;

  const groupStart = (totalW - colsTotalW) / 2;
  const colLefts: number[] = [];
  let cur = groupStart;
  for (let i = 0; i < N; i++) {
    colLefts.push(cur);
    cur += colWidths[i]! + COL_GUTTER_X;
  }
  const colCenters = colLefts.map((left, i) => left + colWidths[i]! / 2);

  const topCardY = PAD + HEADER_H;
  // Higher Office band layout — when there are co-execs (CFO/COO/...)
  // the band is a HORIZONTAL ROW of cards. CEO sits at the centre slot
  // so the spine still drops cleanly from its bottom-centre into the
  // dept row below; co-execs flank alternating right/left for visual
  // balance. With a single Higher Office member this collapses to the
  // original single centred card.
  const HIGHER_OFFICE_GAP = 24;
  const N_HO = flat.higherOffice.length;
  const bandWidth = N_HO * TOP_CARD.w + Math.max(0, N_HO - 1) * HIGHER_OFFICE_GAP;
  const bandStart = (totalW - bandWidth) / 2;
  const ceoSlot = Math.floor((N_HO - 1) / 2);
  const topCardX = bandStart + ceoSlot * (TOP_CARD.w + HIGHER_OFFICE_GAP);
  const topCenterX = topCardX + TOP_CARD.w / 2;
  const leadCardY = topCardY + TOP_CARD.h + SPINE_Y_GAP;
  const spineY = topCardY + TOP_CARD.h + SPINE_Y_GAP / 2;

  // ── Connector overlay ──
  const lines: string[] = [];
  if (N > 0) {
    lines.push(svgLine(topCenterX, topCardY + TOP_CARD.h, topCenterX, spineY));
    if (N > 1) {
      lines.push(
        svgLine(colCenters[0]!, spineY, colCenters[colCenters.length - 1]!, spineY),
      );
    }
    for (const cx of colCenters) {
      lines.push(svgLine(cx, spineY, cx, leadCardY));
    }
    flat.departments.forEach((d, i) => {
      if (d.team.length === 0) return;
      const left = colLefts[i]!;
      const cardLeft = left + (colWidths[i]! - LEAD_CARD.w) / 2;
      const leadBottomX = cardLeft + LEAD_CARD.w / 2;
      const blockY = leadCardY + LEAD_CARD.h + SPINE_Y_GAP;
      lines.push(svgLine(leadBottomX, leadCardY + LEAD_CARD.h, leadBottomX, blockY));
    });
  }

  // Resolve mascot data URI (if theme wants one + assets/mascots/ has PNGs).
  const mascotUri = theme.mascot ? resolveMascotDataUri(rng) : null;

  // ── Body ──
  const body: string[] = [];

  body.push(`
    <div class="header" style="top:${PAD + 8}px;left:${PAD}px;width:${totalW - PAD * 2}px;">
      <div class="header-title"><span class="emoji-lg">🦁</span><span>The Pride${crewName ? ` <span class="header-crew">· ${escHtml(crewName)}</span>` : ""}</span></div>
      <div class="header-taunt">${escHtml(taunt)}</div>
      <div class="theme-tag">${escHtml(theme.name)}</div>
    </div>`);

  if (mascotUri) {
    body.push(
      `<img class="mascot" src="${mascotUri}" alt="" style="top:${PAD - 8}px;right:${PAD - 8}px;width:120px;height:120px;"/>`,
    );
  }

  const totalTeamCount = flat.departments.reduce(
    (a, d) => a + 1 + d.team.length,
    0,
  );
  // Higher Office band — emit one card per member. CEO goes in
  // `ceoSlot` (the centre), co-execs alternate right/left around it
  // for visual balance. Slot layout is deterministic so renders are
  // order-stable across calls with the same graph.
  const slotOrder: number[] = new Array(N_HO).fill(0);
  slotOrder[ceoSlot] = 0;
  {
    let leftCursor = ceoSlot - 1;
    let rightCursor = ceoSlot + 1;
    for (let i = 1; i < N_HO; i++) {
      if (i % 2 === 1 && rightCursor < N_HO) {
        slotOrder[rightCursor] = i;
        rightCursor += 1;
      } else if (leftCursor >= 0) {
        slotOrder[leftCursor] = i;
        leftCursor -= 1;
      } else if (rightCursor < N_HO) {
        slotOrder[rightCursor] = i;
        rightCursor += 1;
      }
    }
  }
  for (let slot = 0; slot < N_HO; slot++) {
    const memberIdx = slotOrder[slot]!;
    const member = flat.higherOffice[memberIdx]!;
    const isCeo = memberIdx === 0;
    const cardX = bandStart + slot * (TOP_CARD.w + HIGHER_OFFICE_GAP);
    body.push(
      leadCardHtml({
        x: cardX,
        y: topCardY,
        w: TOP_CARD.w,
        h: TOP_CARD.h,
        emoji: isCeo ? "👑" : "✦",
        name: member.id,
        role: member.role ?? (isCeo ? "Top of org" : "C-suite"),
        platformTag,
        badgeCount: isCeo && totalTeamCount > 0 ? totalTeamCount : undefined,
        tier: "top",
        tierBadge: "HIGHER OFFICE",
      }),
    );
  }

  if (N > 0) {
    flat.departments.forEach((d, i) => {
      const left = colLefts[i]!;
      const cardLeft = left + (colWidths[i]! - LEAD_CARD.w) / 2;
      body.push(
        leadCardHtml({
          x: cardLeft,
          y: leadCardY,
          w: LEAD_CARD.w,
          h: LEAD_CARD.h,
          emoji: deptEmoji(d.slug),
          name: d.lead.id,
          role: d.lead.role ?? `${capitalize(d.slug)} Lead`,
          platformTag,
          badgeCount: d.team.length || undefined,
          tier: "lead",
          tierBadge: theme.decorations.leadBadgeText,
        }),
      );
    });

    flat.departments.forEach((d, i) => {
      const b = blocks[i]!;
      if (d.team.length === 0) return;
      const left = colLefts[i]!;
      const blockX = left + (colWidths[i]! - b.blockW) / 2;
      const blockY = leadCardY + LEAD_CARD.h + SPINE_Y_GAP;

      body.push(
        `<div class="block" style="top:${blockY}px;left:${blockX}px;width:${b.blockW}px;height:${b.blockH}px;">`,
      );
      d.team.forEach((m, idx) => {
        const col = idx % b.cols;
        const row = Math.floor(idx / b.cols);
        const cardX = BLOCK_PAD + col * (b.card.w + TEAM_GAP);
        const cardY = BLOCK_PAD + row * (b.card.h + TEAM_GAP);
        const emoji = teamEmoji(d.slug, m.role);
        const small = b.card.w <= TEAM_CARD_2COL.w;
        body.push(`
          <div class="team-card${small ? " small" : ""}" style="top:${cardY}px;left:${cardX}px;width:${b.card.w}px;height:${b.card.h}px;">
            <div class="team-avatar"><span class="emoji">${emoji}</span></div>
            <div class="team-name">${escHtml(m.id)}</div>
            ${m.role ? `<div class="team-role">${escHtml(m.role)}</div>` : ""}
            ${platformTag && !small ? `<div class="team-platform">${escHtml(platformTag)}</div>` : ""}
          </div>`);
      });
      body.push(`</div>`);
    });
  }

  const footerY = topCardY + TOP_CARD.h + orgBlockH + FOOTER_GAP;
  body.push(`
    <div class="footer" style="top:${footerY}px;left:${PAD}px;width:${totalW - PAD * 2}px;">
      <div class="footer-rule"><span class="emoji">⚡</span> ${escHtml(footerRule)}</div>
      ${
        story
          ? `
        <div class="story-head"><span class="emoji">📖</span> ${escHtml(story.name)} · ${escHtml(story.role)}</div>
        <div class="story-body">${escHtml(story.story)}</div>`
          : ""
      }
    </div>`);

  const connectorsSvg = `<svg class="spine" xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">${lines.join("")}</svg>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"/><style>${css(theme)}</style></head><body><div class="chart" style="width:${totalW}px;height:${totalH}px;">${connectorsSvg}${body.join("")}</div></body></html>`;

  return { html, width: totalW, height: totalH, themeId: theme.id, themeName: theme.name };
}

/* ─── card builder ──────────────────────────────────── */

interface LeadHtmlOpts {
  x: number; y: number; w: number; h: number;
  emoji: string; name: string; role: string; platformTag: string;
  badgeCount: number | undefined;
  tier: "top" | "lead";
  tierBadge: string;
}

function leadCardHtml(o: LeadHtmlOpts): string {
  return `
    <div class="lead-card tier-${o.tier}" style="top:${o.y}px;left:${o.x}px;width:${o.w}px;height:${o.h}px;">
      ${o.badgeCount !== undefined ? `<div class="badge count">${o.badgeCount}</div>` : ""}
      <div class="badge tier">${escHtml(o.tierBadge)}</div>
      <div class="avatar"><span class="emoji-lg">${o.emoji}</span></div>
      <div class="name">${escHtml(o.name)}</div>
      <div class="role">${escHtml(o.role)}</div>
      ${o.platformTag ? `<div class="platform">${escHtml(o.platformTag)}</div>` : ""}
    </div>`;
}

/* ─── theme-aware stylesheet ─────────────────────────── */

function css(theme: PrideTheme): string {
  const p = theme.palette;
  const f = theme.fonts;
  const d = theme.decorations;

  // Shadow style → CSS
  const shadowCss = (() => {
    switch (d.cardShadowStyle) {
      case "none":       return "none";
      case "subtle":     return `0 1px 2px ${p.cardShadow}, 0 1px 3px ${p.cardShadow}`;
      case "pronounced": return `0 4px 8px ${p.cardShadow}, 0 8px 16px ${p.cardShadow}`;
      case "glow":       return `0 0 12px ${p.accent}44, 0 0 4px ${p.accent}22`;
      case "hard":       return `4px 4px 0 ${p.spine}`;
    }
  })();

  // Spine style → stroke
  const spineCss = (() => {
    const base = `stroke:${p.spine};stroke-width:`;
    switch (d.spineStyle) {
      case "none":   return `${base}0`;
      case "thin":   return `${base}1.25`;
      case "thick":  return `${base}3`;
      case "dotted": return `${base}1.5;stroke-dasharray:2 3`;
      case "dashed": return `${base}1.5;stroke-dasharray:6 4`;
    }
  })();

  // Avatar shape
  const avatarShape = (() => {
    switch (d.avatarStyle) {
      case "circle":   return "border-radius:50%;";
      case "square":   return "border-radius:0;";
      case "rounded":  return "border-radius:12px;";
      case "hexagon":  return "clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0% 50%);";
    }
  })();

  // Background pattern
  const bgPattern = (() => {
    switch (d.backgroundPattern) {
      case "none":  return "";
      case "dots":  return `background-image: radial-gradient(${p.spine}55 1px, transparent 1px); background-size: 18px 18px;`;
      case "grid":  return `background-image: linear-gradient(${p.spine}33 1px, transparent 1px), linear-gradient(90deg, ${p.spine}33 1px, transparent 1px); background-size: 24px 24px;`;
      case "lines": return `background-image: repeating-linear-gradient(45deg, ${p.spine}22 0 1px, transparent 1px 12px);`;
      case "noise": return `background-image: radial-gradient(${p.spine}22 0.5px, transparent 0.5px); background-size: 5px 5px;`;
    }
  })();

  return `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: ${p.bg}; }
    body {
      font-family: ${f.body};
      color: ${p.name};
      -webkit-font-smoothing: antialiased;
    }
    .emoji, .emoji-lg {
      font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', sans-serif;
      font-style: normal;
    }
    .emoji-lg { font-size: 28px; line-height: 1; }
    .emoji { font-size: 18px; line-height: 1; }

    .chart { position: relative; background: ${p.bg}; ${bgPattern} }
    .spine { position: absolute; top: 0; left: 0; pointer-events: none; }
    .spine line { ${spineCss}; }

    .header { position: absolute; text-align: center; }
    .header-title {
      font-family: ${f.display};
      font-size: 26px; font-weight: 800; color: ${p.accent};
      letter-spacing: 0.3px;
      display: flex; align-items: center; justify-content: center; gap: 10px;
    }
    .header-crew { color: ${p.headerText}; font-weight: 600; }
    .header-taunt { font-size: 12px; color: ${p.taunt}; font-style: italic; margin-top: 6px; }
    .theme-tag {
      font-family: ${f.mono};
      font-size: 9px;
      color: ${p.footer};
      letter-spacing: 1px;
      text-transform: uppercase;
      margin-top: 4px;
      opacity: 0.55;
    }

    .mascot { position: absolute; object-fit: contain; pointer-events: none; }

    .lead-card {
      position: absolute;
      background: ${p.cardBg};
      border: ${d.cardBorderWidth}px solid ${p.cardBorder};
      border-radius: ${d.cardRadius}px;
      box-shadow: ${shadowCss};
      padding: 16px 12px 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .badge {
      position: absolute;
      height: 18px;
      padding: 0 8px;
      border-radius: 9px;
      font-family: ${f.mono};
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.8px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-transform: uppercase;
    }
    .badge.count {
      top: 10px; left: 10px;
      min-width: 22px;
      background: ${p.badgeBg};
      color: ${p.badgeText};
    }
    .badge.tier {
      top: 10px; right: 10px;
      background: ${p.accent};
      color: ${p.cardBg};
      letter-spacing: 1px;
    }
    .lead-card.tier-top .badge.tier { background: ${p.headerText}; color: ${p.cardBg}; }
    .avatar {
      width: 52px; height: 52px;
      ${avatarShape}
      background: ${p.avatarBg};
      border: 2px solid ${p.avatarBorder};
      display: flex; align-items: center; justify-content: center;
      margin-top: 14px; margin-bottom: 10px;
    }
    .lead-card .name {
      font-family: ${f.display};
      font-size: 15px; font-weight: 700; color: ${p.name}; line-height: 1.2;
    }
    .lead-card .role { font-size: 11px; color: ${p.role}; margin-top: 4px; line-height: 1.3; }
    .lead-card .platform { font-family: ${f.mono}; font-size: 9px; color: ${p.footer}; margin-top: 4px; }

    .block {
      position: absolute;
      background: ${p.blockBg};
      border: ${d.cardBorderWidth}px solid ${p.blockBorder};
      border-radius: ${d.cardRadius + 2}px;
      box-shadow: ${d.cardShadowStyle === "none" ? "none" : `0 1px 3px ${p.cardShadow}`};
    }
    .team-card {
      position: absolute;
      background: ${p.cardBg};
      border: ${d.cardBorderWidth}px solid ${p.cardBorder};
      border-radius: ${Math.max(4, d.cardRadius - 4)}px;
      padding: 10px 8px;
      display: flex; flex-direction: column; align-items: center; text-align: center;
    }
    .team-avatar {
      width: 36px; height: 36px;
      ${avatarShape}
      background: ${p.avatarBg};
      border: 1.5px solid ${p.avatarBorder};
      display: flex; align-items: center; justify-content: center;
      margin-bottom: 6px;
    }
    .team-card .team-name {
      font-family: ${f.display};
      font-size: 12px; font-weight: 700; color: ${p.name}; line-height: 1.2;
    }
    .team-card.small .team-name { font-size: 11px; }
    .team-card .team-role { font-size: 10px; color: ${p.role}; margin-top: 3px; line-height: 1.25; }
    .team-card.small .team-role { font-size: 9px; }
    .team-card .team-platform { font-family: ${f.mono}; font-size: 8px; color: ${p.footer}; margin-top: 3px; }

    .footer { position: absolute; border-top: 1px dashed ${p.cardBorder}; padding-top: 14px; }
    .footer-rule { font-size: 13px; font-weight: 600; color: ${p.footer}; }
    .story-head { font-family: ${f.display}; font-size: 12px; font-weight: 700; color: ${p.story}; margin-top: 14px; }
    .story-body { font-size: 11px; font-style: italic; color: ${p.taunt}; margin-top: 4px; line-height: 1.4; }
  `;
}

/* ─── mascot loader ─────────────────────────────────── */

let mascotCache: string[] | null = null;

/**
 * Resolve a random mascot PNG from `src/agents/org/assets/mascots/`
 * (dev) or `dist/agents/org/assets/mascots/` (installed). Returns
 * a base64 data URI suitable for `<img src=...>`. Returns null when
 * no PNGs are present — caller falls back to lion emoji.
 *
 * Mascot list is cached on first call; subsequent renders pick from
 * the cached list deterministically via rng.
 */
function resolveMascotDataUri(rng: () => number): string | null {
  if (mascotCache === null) {
    mascotCache = loadMascots();
  }
  if (mascotCache.length === 0) return null;
  const idx = Math.floor(rng() * mascotCache.length);
  return mascotCache[idx] ?? mascotCache[0]!;
}

function loadMascots(): string[] {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(thisDir, "assets", "mascots");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.toLowerCase().endsWith(".png")) continue;
    try {
      const bytes = readFileSync(path.join(dir, file));
      const b64 = bytes.toString("base64");
      out.push(`data:image/png;base64,${b64}`);
    } catch {
      // skip unreadable files
    }
  }
  return out;
}

/* ─── department + role → emoji ────────────────────── */

export const DEPT_EMOJI: Record<string, string> = {
  executive: "👑",
  exec: "👑",
  office: "👑",
  leadership: "👑",
  engineering: "⚙️",
  eng: "⚙️",
  ops: "📦",
  operations: "📦",
  logistics: "📦",
  strategy: "🎯",
  strat: "🎯",
  growth: "📈",
  marketing: "📣",
  brand: "📣",
  sales: "💼",
  finance: "💰",
  legal: "⚖️",
  design: "🎨",
  product: "🧩",
  support: "🎧",
  success: "🎧",
  data: "📊",
  analytics: "📊",
  research: "🔬",
  security: "🛡️",
  people: "🤝",
  hr: "🤝",
  community: "🦁",
  pride: "🦁",
};

export function deptEmoji(slug: string): string {
  return DEPT_EMOJI[slug.toLowerCase()] ?? "🏛";
}

const ROLE_EMOJI_RULES: Array<{ re: RegExp; emoji: string }> = [
  { re: /writer|content|copy|editor/i, emoji: "✍️" },
  { re: /design|brand|visual|creative/i, emoji: "🎨" },
  { re: /\bqa\b|test|quality/i, emoji: "🧪" },
  { re: /engineer|developer|programmer|coder/i, emoji: "💻" },
  { re: /analy(s|z)t|data/i, emoji: "📊" },
  { re: /logistic|warehouse|inventory|supply/i, emoji: "📦" },
  { re: /strateg|planner|forecast/i, emoji: "🎯" },
  { re: /finance|account|treas/i, emoji: "💰" },
  { re: /legal|counsel|compliance/i, emoji: "⚖️" },
  { re: /support|success|service/i, emoji: "🎧" },
  { re: /security|safety/i, emoji: "🛡️" },
  { re: /research|scientist/i, emoji: "🔬" },
  { re: /people|hr|talent|recruit/i, emoji: "🤝" },
  { re: /marketing|growth/i, emoji: "📣" },
  { re: /sales|exec/i, emoji: "💼" },
  { re: /scout|signal|intelligence/i, emoji: "🔭" },
  { re: /product|pm/i, emoji: "🧩" },
];

export function teamEmoji(deptSlug: string, role: string | undefined): string {
  if (role) {
    for (const rule of ROLE_EMOJI_RULES) {
      if (rule.re.test(role)) return rule.emoji;
    }
  }
  return deptEmoji(deptSlug);
}

/* ─── helpers ───────────────────────────────────────── */

function svgLine(x1: number, y1: number, x2: number, y2: number): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function escHtml(s: string): string {
  // Only `<`, `&`, `>` need escaping inside HTML text content.
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
