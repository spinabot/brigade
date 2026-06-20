// src/agents/memory/vault.ts
//
// Tideline Step 21 — the Obsidian markdown vault.
//
// Renders each fact as a markdown note: YAML frontmatter (id / segment / tier /
// status + typed `links` as a Bases-friendly array) over the content body, a
// `## Related` section of REAL `[[wikilinks]]` (what Obsidian's graph view
// actually draws edges from — it IGNORES YAML string arrays), and a PINNED
// region the human owns. Per distinct `subject` we ALSO write one TOPIC-HUB note
// that `[[wikilinks]]` every fact sharing it, so the graph visibly CLUSTERS
// facts around their topic instead of showing isolated, cryptically-named nodes.
//
// The bug this fixes was a RENDERING bug, not a data bug: the prior renderer
// named each note by the raw `memoryId` (e.g. `mem_mqmhnc52_eod06u.md`) and
// stored edges ONLY as YAML strings (`links: - "relates:mem_…"`), which the
// graph view never draws. Filenames are now derived from the fact CONTENT
// (readable, unique, filesystem-safe) and edges are emitted as body wikilinks.
//
// 3-WAY MERGE (the load-bearing property): the dream/system PROPOSES a fresh
// render, but a human-edited PINNED region (between the `%% pinned %%` markers)
// is spliced back in verbatim — the system never clobbers hand edits. So
// re-rendering after a dream pass updates the frontmatter + body + wikilinks
// while the human's notes survive untouched. In convex mode the vault is not
// written at all — callers gate on `mode !== "convex"` before calling
// `writeVault`.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { renameWithRetry } from "../../infra/fs/atomic-rename.js";
import { cosine, getDefaultEmbedder } from "./embedder.js";
import { linksFrom, type MemoryLinkKind } from "./links.js";
import { originBucketKey, type MemoryRecord, type MemorySegment } from "./records.js";

const PIN_OPEN = "%% pinned %%";
const PIN_CLOSE = "%% /pinned %%";

// A stable, machine-detectable sentinel placed near the top of every
// SYSTEM-authored note (fact notes AND topic hubs). Prune keys off this — NOT
// off the filename — so a readable, content-derived filename (e.g.
// `secret to be shredded.md`) is still recognised as the system's to remove,
// while a human's own vault note (an Index / Map-of-Content / daily note),
// which carries no sentinel, is NEVER pruned. It lives on its own line as an
// Obsidian comment, so it is invisible in the rendered note and outside the
// pinned region the merge preserves.
const FACT_SENTINEL = "%% tideline:fact %%";
const HUB_SENTINEL = "%% tideline:hub %%";
// The single root MAP / Map-of-Content note (one per vault). It links UP from
// every topic hub and is the graph's center node, so the hubs are no longer
// disconnected islands. It carries its OWN sentinel so the prune recognises a
// STALE Map (e.g. after every subject was purged) as the system's to rewrite/
// remove — exactly like a hub — instead of leaving it orphaned with dangling
// `[[topic — …]]` links. A human's own Index/MOC (no sentinel) is still untouched.
const MAP_SENTINEL = "%% tideline:map %%";
/** Matches any system sentinel (fact | hub | map) as a standalone line (after trim). */
const SENTINEL_RE = /^%% tideline:(?:fact|hub|map) %%$/m;

/** ASCII-safe basename (no extension) of the root Map note. Emoji lives in the
 *  H1/body ONLY — never the filename — so the file is portable across OSes. */
const MAP_BASENAME = "Memory Map";

/** Order links render in the `## Related` section (stable, kind-grouped). */
const LINK_KIND_ORDER: MemoryLinkKind[] = [
	"supersedes",
	"corrects",
	"transition",
	"contradicts",
	"derived_from",
	"supports",
	"relates",
];

/** Stable display order for the Map's per-segment cluster headings (most
 *  authoritative self-model first, ephemeral last — mirrors SEGMENT_SPECIFICITY).
 *  A segment not in this list (defensive — none today) sorts last, alphabetically. */
const SEGMENT_RENDER_ORDER: MemorySegment[] = [
	"identity",
	"correction",
	"preference",
	"relationship",
	"project",
	"knowledge",
	"context",
];

function segmentRank(seg: string): number {
	const i = SEGMENT_RENDER_ORDER.indexOf(seg as MemorySegment);
	return i === -1 ? SEGMENT_RENDER_ORDER.length : i;
}

/**
 * Cosine bar a semantic BRIDGE must clear to link two facts that have no typed
 * edge between them. Deliberately HIGH (0.6): a bridge is purely ADDITIVE
 * connective tissue, so it must fire only on genuinely-near content — a low bar
 * would web everything to everything and destroy the cluster structure the Map +
 * hubs create. Re-measure against any LEARNED embedder before lowering (the
 * bundled HRR embedder's unrelated-pair cosine on a small corpus already sits in
 * the low-0.3s — see embedder.ts — so 0.6 keeps a comfortable margin over noise).
 */
const BRIDGE_COSINE_BAR = 0.6;

/** Max semantic bridges added PER fact — caps degree so one chatty fact can't
 *  fan out into a hairball that drowns the typed edges. Highest-cosine first. */
const MAX_BRIDGES_PER_FACT = 3;

function yamlValue(v: string): string {
	// Bare when unambiguous; otherwise a JSON string IS a valid YAML double-quoted
	// scalar — it escapes backslash, quote, AND control chars (newline/tab/…),
	// which a hand-rolled quote-only escape would corrupt into invalid frontmatter.
	return /^[A-Za-z0-9 _./-]+$/.test(v) ? v : JSON.stringify(v);
}

/**
 * Sanitise arbitrary fact text into a filesystem-safe, readable note BASENAME
 * (no extension): replace the Windows/POSIX-reserved characters `\ / : * ? " < > |`
 * and any control char with a space, collapse internal whitespace to single
 * spaces, trim, and cap at ~80 chars (on a word boundary when one is near the
 * cap). Trailing dots and spaces — illegal at the END of a Windows filename —
 * are trimmed too. Hyphens/underscores/dots are LEGAL and kept (readability).
 * Empty/degenerate input falls back to `"untitled"` so a name always exists;
 * the caller still disambiguates collisions with a short id suffix.
 */
function sanitizeForFilename(content: string): string {
	// eslint-disable-next-line no-control-regex
	let s = content.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim();
	if (s.length > 80) {
		const cut = s.slice(0, 80);
		const lastSpace = cut.lastIndexOf(" ");
		s = lastSpace >= 40 ? cut.slice(0, lastSpace) : cut;
		s = s.trim();
	}
	// A Windows filename may not END in a space or dot.
	s = s.replace(/[. ]+$/g, "");
	return s.length > 0 ? s : "untitled";
}

/** Short, stable per-id suffix (8 hex of sha1(memoryId)) to break a basename
 *  collision. Derived from the id — NOT iteration order — so the same record
 *  always resolves to the same filename across passes (prune/merge depend on it). */
function idSuffix(memoryId: string): string {
	return createHash("sha1").update(memoryId).digest("hex").slice(0, 8);
}

/**
 * Build the id→filename map over the WHOLE record set FIRST, so every note's
 * `## Related` wikilinks (and each hub's member links) resolve to the real
 * on-disk filename. Deterministic and pass-stable:
 *   - a basename owned by exactly ONE record → `<basename>.md`;
 *   - a basename shared by MORE THAN ONE record → every sharer gets
 *     `<basename> (<idSuffix>).md`, so the choice never depends on which record
 *     was iterated first (a per-id suffix, not a positional one).
 * `.md` is appended by callers via {@link factFileName}.
 */
function buildNameMap(records: readonly MemoryRecord[]): Map<string, string> {
	// First pass: group ids by their sanitised basename to find collisions.
	const byBase = new Map<string, string[]>();
	for (const r of records) {
		const base = sanitizeForFilename(r.content);
		const ids = byBase.get(base);
		if (ids) ids.push(r.memoryId);
		else byBase.set(base, [r.memoryId]);
	}
	const map = new Map<string, string>();
	for (const [base, ids] of byBase) {
		if (ids.length === 1) {
			map.set(ids[0]!, base);
		} else {
			// Shared basename → disambiguate every sharer by its own id (stable).
			for (const id of ids) map.set(id, `${base} (${idSuffix(id)})`);
		}
	}
	return map;
}

/** `.md` filename for a fact, from its basename in the name map. */
function factFileName(memoryId: string, names: Map<string, string>): string {
	return `${names.get(memoryId) ?? `untitled (${idSuffix(memoryId)})`}.md`;
}

/** Hub BASENAME for a subject (no extension): `topic — <subject>`, sanitised. */
function hubBaseName(subject: string): string {
	return sanitizeForFilename(`topic — ${subject}`);
}

/** Synthetic name-map KEY for a subject's hub. A memoryId is always `mem_…`, so
 *  the `hub:` prefix can never collide with a real id — the hub can ride in the
 *  same id→filename map the facts use. */
function hubKey(subject: string): string {
	return `hub:${subject}`;
}

/** Tag-safe form of a subject/segment for an Obsidian `#tag` (spaces/slashes/
 *  reserved chars → `_`). Keeps `topic/<subject>` readable in the graph. */
function tagToken(raw: string): string {
	// eslint-disable-next-line no-control-regex
	const t = raw.replace(/[\\/:*?"<>|#\x00-\x1f]/g, " ").replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
	return t.length > 0 ? t : "misc";
}

function renderFrontmatter(r: MemoryRecord): string {
	const lines = ["---", `id: ${yamlValue(r.memoryId)}`, `segment: ${r.segment}`, `tier: ${r.tier}`];
	// Mark non-active (retracted/archived) notes so the vault distinguishes a live fact
	// from restorable history rather than rendering them identically.
	if (r.lifecycle && r.lifecycle !== "active") lines.push(`lifecycle: ${r.lifecycle}`);
	if (r.status) lines.push(`status: ${r.status}`);
	if (r.subjectKey) lines.push(`subject: ${yamlValue(r.subjectKey)}`);
	if (typeof r.confidence === "number") lines.push(`confidence: ${r.confidence}`);
	// Tags drive Obsidian's tag pane + are graph-visible. `topic/<subject>` is the
	// per-topic cluster tag (mirrors the hub note's wikilinks); the segment is a
	// coarse colour axis; `archived` marks restorable history so the graph shows
	// it distinctly from live facts. Stored as a YAML flow array.
	const tags: string[] = [];
	if (r.subjectKey) tags.push(`topic/${tagToken(r.subjectKey)}`);
	tags.push(tagToken(r.segment));
	if (r.lifecycle && r.lifecycle !== "active") tags.push("archived");
	lines.push(`tags: [${tags.join(", ")}]`);
	// Keep the machine-readable typed edges in the frontmatter too (Bases/queries
	// read these; the graph reads the `## Related` wikilinks below). Both kept.
	const links = linksFrom(r);
	if (links.length > 0) {
		lines.push("links:");
		for (const l of links) lines.push(`  - ${yamlValue(`${l.kind}:${l.target}`)}`);
	}
	lines.push("---");
	return lines.join("\n");
}

/**
 * The `## Related` section: every typed outbound edge whose target is IN the
 * current record set, rendered as a REAL wikilink `- <kind>: [[<file w/o .md>]]`
 * (kind-grouped, stable order, ALL seven kinds — supersedes/corrects/transition/
 * contradicts/derived_from/supports/relates). This is what makes Obsidian draw
 * graph edges. An edge to a target absent from `names` (purged/out-of-scope) is
 * skipped — a dangling `[[…]]` would otherwise spawn a phantom placeholder node.
 *
 * `bridges` are conservative SEMANTIC bridges (Step: connected-graph) — additional
 * `relates`-style edges to genuinely-near same-origin facts, computed by
 * {@link buildBridges} only when an embedder is available. They are appended as
 * `- relates (bridge): [[…]]` and de-duped against the typed edges above (a pair
 * already joined by a real edge gets no bridge). Returns "" when nothing links.
 */
function renderRelated(r: MemoryRecord, names: Map<string, string>, bridges?: ReadonlySet<string>): string {
	const links = linksFrom(r).filter((l) => names.has(l.target));
	links.sort((a, b) => LINK_KIND_ORDER.indexOf(a.kind) - LINK_KIND_ORDER.indexOf(b.kind));
	const items = links.map((l) => `- ${l.kind}: [[${names.get(l.target)!}]]`);
	// Append semantic bridges to targets NOT already joined by a typed edge above
	// (so a bridge never duplicates a real `relates`/`supersedes`/… edge). Only
	// targets present in `names` (existing notes) — buildBridges already guarantees
	// this, but re-check so a stale set can't emit a phantom node.
	if (bridges && bridges.size > 0) {
		const alreadyLinked = new Set(links.map((l) => l.target));
		for (const target of bridges) {
			if (alreadyLinked.has(target) || !names.has(target)) continue;
			items.push(`- relates (bridge): [[${names.get(target)!}]]`);
		}
	}
	if (items.length === 0) return "";
	return `## Related\n${items.join("\n")}\n`;
}

/**
 * Render a fact to a full markdown note: frontmatter (with tags) + the system
 * sentinel + body + an optional topic-hub backlink + `## Related` wikilinks +
 * empty pin region. `names` resolves link targets (and this fact's own topic
 * hub) to readable filenames; OMITTING it (e.g. a bare `renderNote(rec)`) means
 * no edges can be resolved, so the `## Related` / hub-backlink sections are
 * simply absent — the frontmatter + body + pin region still render. `bridges`
 * (optional) is this fact's set of semantic-bridge target ids from
 * {@link buildBridges}.
 */
export function renderNote(r: MemoryRecord, names?: Map<string, string>, bridges?: ReadonlySet<string>): string {
	const resolve = names ?? new Map<string, string>();
	const sections: string[] = [renderFrontmatter(r), FACT_SENTINEL, r.content];
	// Backlink to this fact's topic hub (the cluster anchor), when it has a subject
	// and the hub is in scope. The hub also links back — a two-way edge clusters the
	// fact tightly around its topic in the graph.
	if (r.subjectKey && resolve.has(hubKey(r.subjectKey))) {
		sections.push(`Topic: [[${hubBaseName(r.subjectKey)}]]`);
	}
	const related = renderRelated(r, resolve, bridges);
	if (related) sections.push(related.trimEnd());
	sections.push(`${PIN_OPEN}\n\n${PIN_CLOSE}`);
	return `${sections.join("\n\n")}\n`;
}

/**
 * Render a TOPIC-HUB note for `subject`: a system note whose body `[[wikilinks]]`
 * to every member fact (DOWN, the cluster anchor) AND — so the hubs form one
 * connected web rather than disconnected stars — UP to the root Map and ACROSS to
 * its sibling hubs in the SAME segment.
 *
 * `opts.linkMap` adds `Part of: [[Memory Map]]` (the UP edge to the graph centre);
 * the caller sets it only when a Map note is actually being written, so the
 * wikilink never dangles. `opts.siblingSubjects` are the OTHER subjects sharing
 * this hub's segment — rendered as a `Related topics:` list of `[[topic — …]]`
 * (the ACROSS edges that turn a segment into a visible cluster). Both are purely
 * structural: they link only to hubs/notes that exist. Members are listed in the
 * order given (the caller passes them subject-stable).
 */
export function renderHubNote(
	subject: string,
	memberIds: readonly string[],
	names: Map<string, string>,
	opts: { linkMap?: boolean; siblingSubjects?: readonly string[] } = {},
): string {
	const items = memberIds.filter((id) => names.has(id)).map((id) => `- [[${names.get(id)!}]]`);
	const front = ["---", `topic: ${yamlValue(subject)}`, `tags: [topic/${tagToken(subject)}, hub]`, "---"].join("\n");
	const body = items.length > 0 ? items.join("\n") : "_(no facts under this topic yet)_";
	const sections: string[] = [front, HUB_SENTINEL, `# ${subject}`];
	// UP edge to the root Map (the graph centre) — only when a Map is written.
	if (opts.linkMap) sections.push(`Part of: [[${MAP_BASENAME}]]`);
	sections.push(`Facts on this topic:\n\n${body}`);
	// ACROSS edges to sibling hubs in the same segment (the cluster's interlinks).
	const siblings = (opts.siblingSubjects ?? []).filter((s) => s !== subject);
	if (siblings.length > 0) {
		const links = siblings.map((s) => `- [[${hubBaseName(s)}]]`).join("\n");
		sections.push(`Related topics:\n\n${links}`);
	}
	sections.push(`${PIN_OPEN}\n\n${PIN_CLOSE}`);
	return `${sections.join("\n\n")}\n`;
}

/**
 * Render the root MAP / Map-of-Content note — the graph's CENTER node. It links to
 * EVERY topic hub (`[[topic — <subject>]]`), GROUPED under a per-segment heading
 * (`## identity`, `## preference`, …) so each segment reads as a cluster, with the
 * active-fact count shown per topic. This is what turns N disconnected hub-stars
 * into one connected web (Map → hubs → facts, plus the hubs' sibling interlinks).
 *
 * STRUCTURAL ONLY: it lists subjects/segments that ACTUALLY occur in the record
 * set — it never invents a topic, a fact, or a count. `segments` maps each segment
 * → its subjects (insertion-stable from the caller); `activeCounts` maps subject →
 * its ACTIVE-fact tally (archived facts are excluded from the headline number,
 * matching what the operator thinks of as "live" facts on a topic). Carries the
 * map sentinel so a STALE Map is pruned/rewritten like a hub, and the usual pinned
 * region so a human can annotate the map and have it survive a re-render.
 */
export function renderMapNote(
	segments: ReadonlyMap<string, readonly string[]>,
	activeCounts: ReadonlyMap<string, number>,
): string {
	const front = ["---", "title: Memory Map", "tags: [map]", "---"].join("\n");
	const orderedSegments = [...segments.keys()].sort((a, b) => segmentRank(a) - segmentRank(b) || a.localeCompare(b));
	const blocks: string[] = [];
	for (const seg of orderedSegments) {
		const subjects = segments.get(seg) ?? [];
		if (subjects.length === 0) continue;
		const lines = subjects.map((s) => {
			const n = activeCounts.get(s) ?? 0;
			// "(N active)" — the count is the LIVE-fact tally; pluralise for readability.
			return `- [[${hubBaseName(s)}]] (${n} active fact${n === 1 ? "" : "s"})`;
		});
		blocks.push(`## ${seg}\n\n${lines.join("\n")}`);
	}
	const body =
		blocks.length > 0 ? blocks.join("\n\n") : "_(no topics yet — facts with a subject will cluster here)_";
	return `${front}\n\n${MAP_SENTINEL}\n\n# 🗺️ Memory Map\n\n${body}\n\n${PIN_OPEN}\n\n${PIN_CLOSE}\n`;
}

/**
 * Build conservative SEMANTIC bridges between facts — `memoryId → set of target
 * memoryIds` to additionally link as `relates (bridge)` edges. Purely ADDITIVE
 * connective tissue so the graph reads as one web instead of isolated stars: it
 * connects ONLY facts that genuinely co-occur, and only ones that already exist as
 * notes. It NEVER fabricates content — it only draws edges between real records.
 *
 * Conditions for a bridge between facts A and B:
 *   - both are in `names` (i.e. both have an on-disk note to link);
 *   - SAME origin (`originBucketKey`) — never bridge an owner fact to a peer's, or
 *     two different peers' facts (mirrors every other cross-fact op's isolation);
 *   - NOT already joined by a typed edge in EITHER direction (no duplicate);
 *   - embedding cosine ≥ {@link BRIDGE_COSINE_BAR} (a HIGH bar — bridges fire only
 *     on genuinely-near content).
 * Each fact keeps at most {@link MAX_BRIDGES_PER_FACT} bridges (highest cosine
 * first) so one fact can't fan out into a hairball. Edges are SYMMETRIC (both
 * endpoints record the bridge) so the link renders from either note.
 *
 * EMBEDDER GUARD — the whole feature is opt-in on a usable embedder. A vector is
 * the record's stored `embedding` when present, else the fact's `content` embedded
 * on demand. If the embedder is async (returns a Promise), throws, or yields a
 * wrong-width vector, that record simply has NO vector and forms no bridges; if NO
 * record ends up with a vector, the function returns an empty map and the vault
 * renders with typed edges only. Nothing crosses the bar ⇒ empty map ⇒ no bridges.
 */
export function buildBridges(
	records: readonly MemoryRecord[],
	names: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	// Only facts that will actually have a note can be bridge endpoints.
	const linkable = records.filter((r) => names.has(r.memoryId));
	if (linkable.length < 2) return out;

	// Resolve a vector per record (stored, else embed-on-demand), embedder-guarded.
	// A single shared embedder instance; the bundled HRR/Hashing embedders are sync.
	let embed: ((text: string) => number[] | undefined) | undefined;
	try {
		const emb = getDefaultEmbedder();
		embed = (text: string): number[] | undefined => {
			try {
				const v = emb.embed([text]);
				if (v instanceof Promise) return undefined; // async model → skip (sync-only path)
				const vec = v[0];
				return Array.isArray(vec) && vec.length === emb.dims ? vec : undefined;
			} catch {
				return undefined;
			}
		};
	} catch {
		embed = undefined; // no embedder at all → no bridges
	}

	const vectors = new Map<string, number[]>();
	for (const r of linkable) {
		const stored = Array.isArray(r.embedding) && r.embedding.length > 0 ? r.embedding : undefined;
		const v = stored ?? (embed ? embed(r.content) : undefined);
		if (v) vectors.set(r.memoryId, v);
	}
	if (vectors.size < 2) return out; // need at least one comparable pair

	// Existing typed edges (either direction) — excluded so a bridge never dupes one.
	const typed = new Set<string>();
	const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
	for (const r of linkable) {
		for (const l of linksFrom(r)) {
			if (names.has(l.target)) typed.add(pairKey(r.memoryId, l.target));
		}
	}

	// Score every same-origin, comparable, not-already-typed pair once.
	type Cand = { a: string; b: string; cos: number };
	const cands: Cand[] = [];
	for (let i = 0; i < linkable.length; i++) {
		const ra = linkable[i]!;
		const va = vectors.get(ra.memoryId);
		if (!va) continue;
		for (let j = i + 1; j < linkable.length; j++) {
			const rb = linkable[j]!;
			const vb = vectors.get(rb.memoryId);
			if (!vb) continue;
			if (originBucketKey(ra) !== originBucketKey(rb)) continue; // origin isolation
			if (typed.has(pairKey(ra.memoryId, rb.memoryId))) continue; // already a typed edge
			if (va.length !== vb.length) continue; // mismatched embedder widths
			const cos = cosine(va, vb);
			if (cos >= BRIDGE_COSINE_BAR) cands.push({ a: ra.memoryId, b: rb.memoryId, cos });
		}
	}
	// Strongest first; ties broken by id pair for determinism (pass-stable output).
	cands.sort((x, y) => y.cos - x.cos || pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b)));

	const degree = new Map<string, number>();
	const deg = (id: string): number => degree.get(id) ?? 0;
	const add = (from: string, to: string): void => {
		let s = out.get(from);
		if (!s) {
			s = new Set<string>();
			out.set(from, s);
		}
		s.add(to);
		degree.set(from, deg(from) + 1);
	};
	for (const c of cands) {
		// Symmetric degree cap: add only if BOTH endpoints have headroom (keeps the
		// edge two-way so it renders from either note without a one-sided dangle).
		if (deg(c.a) >= MAX_BRIDGES_PER_FACT || deg(c.b) >= MAX_BRIDGES_PER_FACT) continue;
		add(c.a, c.b);
		add(c.b, c.a);
	}
	return out;
}

/** Index of the LAST line that is EXACTLY `marker` (after trim), or -1. */
function lastMarkerLine(lines: string[], marker: string): number {
	for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim() === marker) return i;
	return -1;
}

/**
 * Extract the pinned region's INNER text. LINE-ANCHORED: the open marker is the
 * LAST line that is exactly `%% pinned %%`, the close is the first subsequent line
 * exactly `%% /pinned %%` — so a marker token embedded MID-LINE in the human's own
 * prose (or in a fact body that discusses the `%%` comment syntax) is NOT treated as
 * a delimiter and cannot truncate/hijack the region. Missing close → captures
 * OPEN→EOF rather than discarding edits. `undefined` when there is no open-marker line.
 */
export function extractPinned(md: string): string | undefined {
	const lines = md.split("\n");
	const open = lastMarkerLine(lines, PIN_OPEN);
	if (open === -1) return undefined;
	let close = lines.length;
	for (let i = open + 1; i < lines.length; i++) {
		if (lines[i]!.trim() === PIN_CLOSE) {
			close = i;
			break;
		}
	}
	return lines.slice(open + 1, close).join("\n");
}

/**
 * 3-way merge: take the `proposed` render but splice the EXISTING note's pinned
 * region back in, so a human edit survives a re-render. Line-anchored (matches
 * extractPinned). No existing note / no pin region → `proposed` unchanged.
 */
export function mergeNote(existing: string | undefined, proposed: string): string {
	if (!existing) return proposed;
	const pinned = extractPinned(existing);
	if (pinned === undefined) return proposed;
	const lines = proposed.split("\n");
	const open = lastMarkerLine(lines, PIN_OPEN);
	if (open === -1) return proposed;
	let close = lines.length;
	for (let i = open + 1; i < lines.length; i++) {
		if (lines[i]!.trim() === PIN_CLOSE) {
			close = i;
			break;
		}
	}
	const tail = close < lines.length ? lines.slice(close) : [];
	return [...lines.slice(0, open + 1), ...pinned.split("\n"), ...tail].join("\n");
}

/** True if `md` is a SYSTEM-authored note (carries a fact/hub sentinel). Prune
 *  keys off this so a readable, content-derived filename is still recognised as
 *  the system's to remove, while a human's own note (no sentinel) is left alone. */
function isSystemNote(md: string): boolean {
	return SENTINEL_RE.test(md);
}

export interface VaultWriteResult {
	written: number;
	/** Notes whose pinned region was preserved from a prior hand edit. */
	mergedPinned: number;
	/** Topic-hub notes written this pass (one per distinct subject). */
	hubs?: number;
	/** Notes that could not be written this pass (locked/unwritable — best effort).
	 *  A non-zero count means the vault render is degraded but the pass still
	 *  completed (remaining notes + the integrity prune were not abandoned). */
	writeFailed?: number;
	/** Stale notes removed (only when `prune` is set). */
	pruned?: number;
}

/**
 * Write/refresh the vault for `records` under `dir`, preserving pinned edits.
 *
 * Produces a CONNECTED, CLUSTERED graph with the topology of a well-built
 * hand-crafted Obsidian vault — a root MAP → per-segment CLUSTERS → topic HUBS →
 * fact LEAVES, plus cross-links so it reads as one web, not disconnected stars:
 *   - one note per fact (readable filename), each with `## Related` `[[wikilinks]]`
 *     to its typed neighbours (all seven edge kinds) PLUS conservative semantic
 *     bridges, a `topic/<subject>` tag, and a backlink to its topic hub;
 *   - one TOPIC-HUB note per distinct subject — links DOWN to its facts, UP to the
 *     Map, and ACROSS to its same-segment sibling hubs (the cluster interlinks);
 *   - one root MAP note (`Memory Map.md`) — the graph's centre — linking to EVERY
 *     hub grouped under per-segment headings, with each topic's active-fact count.
 *
 * `prune` (default OFF) removes any SYSTEM note (fact, hub, OR the Map — detected
 * by the sentinel, NOT by filename) in `dir` NOT in the current render set — so an
 * evicted/PURGED fact's note can't linger as plaintext on disk after a
 * crypto-shred (the integrity counterpart to {@link FactStore.purge}), a hub for a
 * now-empty subject is cleaned up, and a stale Map (all subjects gone) is removed
 * rather than orphaned with dangling hub links. A human's own vault notes (their
 * OWN Index/MOC/daily) carry no sentinel and are NEVER pruned. Callers that pass
 * the FULL set for a vault (e.g. the whole owner origin) should enable it; callers
 * passing a partial set must not.
 *
 * DURABILITY: each note is written via a sibling temp + atomic rename (the same
 * tmp+rename pattern {@link FactStore} uses), so a crash mid-write leaves the
 * OLD note — and the human-pinned region that lives ONLY in the .md (the fact
 * body is recoverable from facts.jsonl; the pin is not) — intact rather than
 * truncated. `renameWithRetry` rides over the Windows EPERM/EBUSY window an
 * indexer/Obsidian briefly opens on the destination.
 *
 * BEST-EFFORT PER NOTE: a single unwritable/locked note (EACCES on a read-only
 * note, EBUSY while held) is isolated so it neither skips the remaining notes
 * nor — critically — skips the prune. The prune is the integrity step (it
 * removes a just-shredded fact's plaintext note); `keep` is computed before any
 * write, so it stays correct regardless of which renders succeeded, and so the
 * prune runs unconditionally after the loop.
 */
export function writeVault(
	dir: string,
	records: readonly MemoryRecord[],
	opts: { prune?: boolean } = {},
): VaultWriteResult {
	fs.mkdirSync(dir, { recursive: true });

	// Build the id→filename map over ALL records FIRST so every wikilink resolves
	// to a real on-disk name regardless of write order.
	const names = buildNameMap(records);

	// Group facts by subject for the topic hubs (stable insertion order). A fact
	// with no subject contributes no hub link (and falls under no cluster). Hub
	// basenames also enter `names` (under a synthetic hubKey) so a fact can render
	// a `Topic: [[hub]]` backlink and the hub can be pruned/tracked like any note.
	const subjects = new Map<string, string[]>();
	// Per subject: its SEGMENT (the cluster it lives in) + its ACTIVE-fact tally
	// (the Map's headline count). Segment is taken from the first ACTIVE fact under
	// the subject (an active fact defines the live cluster), else the first fact —
	// a subject is normally single-segment, but this is deterministic if not.
	const subjectSegment = new Map<string, MemorySegment>();
	const subjectSegmentFromActive = new Set<string>(); // segment was seeded by an active fact
	const subjectActiveCount = new Map<string, number>();
	for (const r of records) {
		if (!r.subjectKey) continue;
		const ids = subjects.get(r.subjectKey);
		if (ids) ids.push(r.memoryId);
		else subjects.set(r.subjectKey, [r.memoryId]);
		const isActive = (r.lifecycle ?? "active") === "active";
		if (isActive) subjectActiveCount.set(r.subjectKey, (subjectActiveCount.get(r.subjectKey) ?? 0) + 1);
		// Seed the segment if none yet, or UPGRADE a non-active seed to an active one.
		if (!subjectSegment.has(r.subjectKey) || (isActive && !subjectSegmentFromActive.has(r.subjectKey))) {
			subjectSegment.set(r.subjectKey, r.segment);
			if (isActive) subjectSegmentFromActive.add(r.subjectKey);
		}
	}
	for (const subject of subjects.keys()) names.set(hubKey(subject), hubBaseName(subject));

	// Subjects grouped by segment — drives BOTH the Map's per-segment clusters and
	// each hub's same-segment sibling interlinks. Insertion-stable within a segment.
	const subjectsBySegment = new Map<MemorySegment, string[]>();
	for (const [subject, seg] of subjectSegment) {
		const arr = subjectsBySegment.get(seg);
		if (arr) arr.push(subject);
		else subjectsBySegment.set(seg, [subject]);
	}

	// Conservative semantic bridges across facts (additive `relates` edges between
	// genuinely-near same-origin facts). Empty when no embedder / nothing crosses
	// the high cosine bar — purely additive, never fabricates a link. Computed once
	// over the whole set so a bridge resolves regardless of write order.
	const bridges = buildBridges(records, names);

	// A Map note is emitted whenever there is at least one topic to anchor — it is
	// the graph's centre (hubs link UP to it). With no subjects there are no hubs to
	// connect, so no Map is written (nothing to centre) and the count stays as before.
	const wantMap = subjects.size > 0;

	let written = 0;
	let mergedPinned = 0;
	let writeFailed = 0;
	let hubs = 0;
	const keep = new Set<string>();

	// Shared per-note write step: 3-way merge over any existing note, atomic
	// tmp+rename, best-effort isolation. Returns true on a successful write.
	const writeNote = (name: string, proposed: string): boolean => {
		const file = path.join(dir, name);
		let existing: string | undefined;
		try {
			existing = fs.readFileSync(file, "utf8");
		} catch {
			existing = undefined;
		}
		const pinned = existing ? extractPinned(existing) : undefined;
		const merged = mergeNote(existing, proposed);
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		try {
			fs.writeFileSync(tmp, merged, "utf8");
			renameWithRetry(tmp, file);
			if (pinned !== undefined && pinned.trim().length > 0) mergedPinned++;
			return true;
		} catch {
			writeFailed++;
			try {
				fs.rmSync(tmp);
			} catch {
				/* temp never landed / already gone */
			}
			return false;
		}
	};

	// Fact notes (with typed-edge wikilinks + any semantic bridges).
	for (const r of records) {
		const name = factFileName(r.memoryId, names);
		// Record the current set BEFORE attempting the write — a failed render must
		// still count as "kept" so the prune below never deletes its (stale-but-
		// present) on-disk note.
		keep.add(name);
		if (writeNote(name, renderNote(r, names, bridges.get(r.memoryId)))) written++;
	}

	// Topic-hub notes (one per distinct subject) — the cluster anchors. Each links
	// UP to the Map (when one is written) and ACROSS to its same-segment siblings.
	for (const [subject, memberIds] of subjects) {
		const name = `${hubBaseName(subject)}.md`;
		keep.add(name);
		const seg = subjectSegment.get(subject);
		const siblingSubjects = seg ? (subjectsBySegment.get(seg) ?? []) : [];
		const hubNote = renderHubNote(subject, memberIds, names, { linkMap: wantMap, siblingSubjects });
		if (writeNote(name, hubNote)) {
			written++;
			hubs++;
		}
	}

	// Root MAP note (the graph's centre) — links to EVERY hub, grouped by segment,
	// with each topic's active-fact count. Only when there is at least one topic.
	if (wantMap) {
		const name = `${MAP_BASENAME}.md`;
		keep.add(name);
		if (writeNote(name, renderMapNote(subjectsBySegment, subjectActiveCount))) written++;
	}

	const result: VaultWriteResult = { written, mergedPinned };
	if (hubs > 0) result.hubs = hubs;
	if (writeFailed > 0) result.writeFailed = writeFailed;
	if (!opts.prune) return result;

	// Remove stale notes (a purged/evicted fact must not survive as plaintext; a
	// hub for a now-empty subject is cleaned up). Runs unconditionally after the
	// loop — gated on `prune`, NOT on every render succeeding — so a transiently-
	// locked UNRELATED note can't leave a just-shredded fact's plaintext on disk.
	let pruned = 0;
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		entries = [];
	}
	for (const f of entries) {
		if (!f.endsWith(".md") || keep.has(f)) continue;
		const full = path.join(dir, f);
		// Only prune SYSTEM-authored notes (carry the fact/hub sentinel). A human's
		// own notes in the vault (an Index/Map-of-Content, a daily note) carry no
		// sentinel, so they're left alone — deleting them would contradict the whole
		// editable-Obsidian-vault premise (the prune exists to stop a shredded fact's
		// note lingering as plaintext, not to police the user's folder). Detection is
		// by FILE CONTENT, not filename, because filenames are now readable/arbitrary.
		let content: string;
		try {
			content = fs.readFileSync(full, "utf8");
		} catch {
			continue; // unreadable — leave it (best effort)
		}
		if (!isSystemNote(content)) continue;
		try {
			fs.rmSync(full);
			pruned++;
		} catch {
			/* concurrent removal / locked — best effort */
		}
	}
	result.pruned = pruned;
	return result;
}
