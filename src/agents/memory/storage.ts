/**
 * Brigade memory storage — the abstraction Primitive #4 ships and Phase 2
 * (DB-backed multi-user) swaps out.
 *
 * Deliberately narrow v1 surface: `search` + `read` + `status`. No
 * embeddings, no SQLite, no vector index in v1 — `search` is a lexical
 * (term-overlap) scan over `MEMORY.md` (persona-level, always also
 * injected into the prompt) plus the daily notes under
 * `memory/YYYY-MM-DD.md`.
 *
 * Writing is NOT part of this interface. Durable structured facts are
 * persisted via the `write_memory` tool (see `memory-tools.ts`), which
 * routes through `FactStore` / `MemoryCapability`. The agent may also
 * append free-form notes directly to `memory/<today>.md` using its
 * ordinary `write` / `edit` tool — Pi's session cwd is the workspace dir,
 * so `write({path: "memory/2026-05-21.md"})` lands in the right place.
 *
 * Phase 2 implements `BrigadeStorage` over a database. Because the contract
 * is just these three methods, the memory tools (`recall_memory`,
 * `read_memory`) and the recall prompt section don't change — they depend
 * on the interface, not the filesystem.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** One scored hit from a memory search. */
export interface MemorySearchResult {
	/** Path RELATIVE to the workspace dir, e.g. "MEMORY.md" or "memory/2026-05-21.md". */
	relPath: string;
	/** 1-based line where the matched chunk starts. */
	startLine: number;
	/** 1-based line where the matched chunk ends (inclusive). */
	endLine: number;
	/** Relevance score (higher = better). v1 = term-overlap count, see scoreChunk. */
	score: number;
	/** The matched text chunk, trimmed. */
	snippet: string;
}

/** Result of a bounded memory-file read. */
export interface MemoryReadResult {
	/** Path RELATIVE to the workspace dir. */
	relPath: string;
	/** The (possibly windowed) file text. */
	text: string;
	/** True when the read was windowed and more lines exist after `nextFrom`. */
	truncated: boolean;
	/** 1-based line the returned window starts at. */
	from: number;
	/** Number of lines returned. */
	lines: number;
	/** 1-based line a follow-up read should start at, when truncated. */
	nextFrom?: number;
}

/** Backend health/shape snapshot for `brigade doctor` / `brigade status`. */
export interface MemoryStatus {
	/** v1 is always "file"; Phase 2 DB-backed impl reports "db". */
	backend: "file";
	/** Number of memory files present (MEMORY.md + memory/*.md). */
	fileCount: number;
	/** Total bytes across all memory files. */
	totalBytes: number;
	/** Absolute path to the memory corpus root (the workspace dir). */
	root: string;
}

export interface MemorySearchOptions {
	/** Max results to return. Default 8. */
	maxResults?: number;
	/** Drop hits below this score. Default 1 (at least one query term present). */
	minScore?: number;
}

export interface MemoryReadOptions {
	/** 1-based line to start at. Default 1. */
	from?: number;
	/** Max lines to return. Default 200. */
	lines?: number;
}

/**
 * The storage contract. Filesystem impl ships in v1; DB impl in Phase 2.
 * Consumers (the memory tools + the recall prompt) depend ONLY on this.
 */
export interface BrigadeStorage {
	search(query: string, opts?: MemorySearchOptions): Promise<MemorySearchResult[]>;
	read(relPath: string, opts?: MemoryReadOptions): Promise<MemoryReadResult>;
	status(): Promise<MemoryStatus>;
}

const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MIN_SCORE = 1;
const DEFAULT_READ_LINES = 200;
/** Hard cap so a recall_memory call can't dump a giant note into the context. */
const MAX_READ_LINES = 1000;
/**
 * Per-file byte cap for SEARCH reads. Daily notes are append-only and can
 * grow unbounded; without this a single 10 MB note would be slurped +
 * tokenised on every recall_memory call. Matches the precedent in
 * `workspace-loader.ts` (2 MB). Files larger than this are read head-only
 * for search — the head is where the most recent appends land if the agent
 * writes newest-first, and search still works on the truncated head.
 */
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
/**
 * Per-snippet character cap so one giant blank-line-free paragraph can't
 * become a 50 KB snippet. Longer chunks are truncated with an ellipsis.
 */
const MAX_SNIPPET_CHARS = 1500;
/**
 * Total-output character ceiling across all returned snippets, so a search
 * can't flood the model's context. Results past this budget are dropped
 * (they're the lowest-scored, since results are sorted before slicing).
 */
const MAX_TOTAL_SNIPPET_CHARS = 8000;

/**
 * Thrown when a caller asks to read a path outside the allowed memory
 * corpus (anything that isn't `MEMORY.md` or a file under `memory/`).
 * The memory tools translate this into a tool-result error the model sees.
 */
export class BrigadeMemoryPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrigadeMemoryPathError";
	}
}

/**
 * Filesystem-backed `BrigadeStorage`. The corpus is rooted at the agent's
 * workspace dir:
 *   - `MEMORY.md`            (optional; present once the agent writes it)
 *   - `memory/*.md`          (daily notes the agent appends to)
 *
 * Read-only — writes go through Pi's `write`/`edit` tool, not here.
 */
export class FileMemoryStore implements BrigadeStorage {
	private readonly workspaceDir: string;

	constructor(workspaceDir: string) {
		this.workspaceDir = path.resolve(workspaceDir);
	}

	/**
	 * Lexical search across MEMORY.md + memory/*.md. Splits each file into
	 * blank-line-separated chunks, scores each chunk by how many distinct
	 * query terms it contains, and returns the top `maxResults` chunks
	 * across all files. No embeddings — this is the v1 builtin backend.
	 */
	async search(query: string, opts: MemorySearchOptions = {}): Promise<MemorySearchResult[]> {
		const terms = tokenize(query);
		if (terms.length === 0) return [];
		const maxResults = clampPositive(opts.maxResults, DEFAULT_MAX_RESULTS);
		const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;

		const files = await this.listCorpusFiles();
		const hits: MemorySearchResult[] = [];
		for (const relPath of files) {
			const text = await this.readForSearch(relPath);
			if (text === undefined) continue; // vanished / unreadable — skip
			for (const chunk of splitIntoChunks(text)) {
				const score = scoreChunk(chunk.text, terms);
				if (score >= minScore) {
					hits.push({
						relPath,
						startLine: chunk.startLine,
						endLine: chunk.endLine,
						score,
						snippet: truncateSnippet(chunk.text.trim()),
					});
				}
			}
		}
		// Highest score first; ties broken by shorter snippet (more focused),
		// then by path for determinism.
		hits.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (a.snippet.length !== b.snippet.length) return a.snippet.length - b.snippet.length;
			return a.relPath.localeCompare(b.relPath);
		});
		// Apply BOTH caps: at most `maxResults` hits AND a total snippet-char
		// budget so a recall can't flood the context window. Iterate the
		// already-sorted hits and stop when either limit is reached.
		const out: MemorySearchResult[] = [];
		let totalChars = 0;
		for (const hit of hits) {
			if (out.length >= maxResults) break;
			if (totalChars + hit.snippet.length > MAX_TOTAL_SNIPPET_CHARS && out.length > 0) break;
			out.push(hit);
			totalChars += hit.snippet.length;
		}
		return out;
	}

	/**
	 * Read a corpus file for SEARCH with a byte cap. Files over
	 * `MAX_SEARCH_FILE_BYTES` are read head-only so an unbounded daily note
	 * can't OOM the process. Returns undefined when the file can't be read.
	 */
	private async readForSearch(relPath: string): Promise<string | undefined> {
		const full = path.join(this.workspaceDir, relPath);
		try {
			const stat = await fs.stat(full);
			if (stat.size <= MAX_SEARCH_FILE_BYTES) {
				return await fs.readFile(full, "utf8");
			}
			// Oversized: read the first MAX_SEARCH_FILE_BYTES only.
			const handle = await fs.open(full, "r");
			try {
				const buf = Buffer.alloc(MAX_SEARCH_FILE_BYTES);
				const { bytesRead } = await handle.read(buf, 0, MAX_SEARCH_FILE_BYTES, 0);
				return buf.subarray(0, bytesRead).toString("utf8");
			} finally {
				await handle.close();
			}
		} catch {
			return undefined;
		}
	}

	/**
	 * Bounded read of a single memory file. `relPath` must be `MEMORY.md`
	 * or a file under `memory/` — anything else throws
	 * `BrigadeMemoryPathError` (no reading arbitrary workspace files
	 * through the memory tool).
	 */
	async read(relPath: string, opts: MemoryReadOptions = {}): Promise<MemoryReadResult> {
		const safeRel = this.assertCorpusPath(relPath);
		const from = clampPositive(opts.from, 1);
		const requested = clampPositive(opts.lines, DEFAULT_READ_LINES);
		const lineBudget = Math.min(requested, MAX_READ_LINES);

		let raw: string;
		try {
			raw = await fs.readFile(path.join(this.workspaceDir, safeRel), "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				throw new BrigadeMemoryPathError(
					`memory file "${safeRel}" does not exist. Use recall_memory to find what's stored, ` +
						`or write to "memory/<today>.md" to create a note.`,
				);
			}
			// EACCES / EISDIR / EBUSY / etc — report the actual problem rather
			// than the misleading "does not exist".
			throw new BrigadeMemoryPathError(
				`memory file "${safeRel}" could not be read (${code ?? "unknown error"}).`,
			);
		}
		const allLines = raw.split(/\r?\n/);
		// A file ending in a newline produces a trailing "" element from the
		// split — drop exactly one so a 2-line "a\nb\n" reports 2 lines, not
		// 3 (and a genuine blank last line "a\n\n" still reports 2: a + blank).
		if (allLines.length > 1 && allLines[allLines.length - 1] === "") {
			allLines.pop();
		}
		const startIdx = Math.max(0, from - 1);
		const slice = allLines.slice(startIdx, startIdx + lineBudget);
		const endIdx = startIdx + slice.length; // exclusive
		const truncated = endIdx < allLines.length;
		return {
			relPath: safeRel,
			text: slice.join("\n"),
			truncated,
			from: startIdx + 1,
			lines: slice.length,
			...(truncated ? { nextFrom: endIdx + 1 } : {}),
		};
	}

	async status(): Promise<MemoryStatus> {
		const files = await this.listCorpusFiles();
		let totalBytes = 0;
		for (const relPath of files) {
			try {
				const stat = await fs.stat(path.join(this.workspaceDir, relPath));
				totalBytes += stat.size;
			} catch {
				// skip vanished file
			}
		}
		return {
			backend: "file",
			fileCount: files.length,
			totalBytes,
			root: this.workspaceDir,
		};
	}

	/**
	 * List the corpus files (relative paths): MEMORY.md if present, plus
	 * every `*.md` under `memory/`. Sorted for deterministic search output.
	 */
	private async listCorpusFiles(): Promise<string[]> {
		const out: string[] = [];
		// MEMORY.md (persona-level memory) — optional.
		try {
			const stat = await fs.stat(path.join(this.workspaceDir, "MEMORY.md"));
			if (stat.isFile()) out.push("MEMORY.md");
		} catch {
			// absent — fine
		}
		// memory/*.md daily notes.
		const memoryDir = path.join(this.workspaceDir, "memory");
		try {
			const entries = await fs.readdir(memoryDir, { withFileTypes: true });
			for (const e of entries) {
				if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
					out.push(path.posix.join("memory", e.name));
				}
			}
		} catch {
			// no memory dir yet — fine
		}
		return out.sort();
	}

	/**
	 * Validate + normalise a caller-supplied relPath. Accepts only
	 * `MEMORY.md` (case-insensitive) or a `*.md` directly under `memory/`.
	 * Rejects traversal, absolute paths, nested subdirs, and non-md files.
	 */
	private assertCorpusPath(relPath: string): string {
		const raw = (relPath ?? "").trim().replace(/\\/g, "/");
		if (!raw) {
			throw new BrigadeMemoryPathError("memory path is empty.");
		}
		if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
			throw new BrigadeMemoryPathError(
				`memory path "${relPath}" must be relative (MEMORY.md or memory/<file>.md), not absolute.`,
			);
		}
		if (raw.includes("..")) {
			throw new BrigadeMemoryPathError(
				`memory path "${relPath}" must not contain "..".`,
			);
		}
		// MEMORY.md at the workspace root.
		if (raw.toLowerCase() === "memory.md") return "MEMORY.md";
		// memory/<name>.md — exactly one segment under memory/, must be .md.
		const m = /^memory\/([^/]+\.md)$/i.exec(raw);
		if (m) return `memory/${m[1]}`;
		throw new BrigadeMemoryPathError(
			`memory path "${relPath}" is not a memory file. Allowed: "MEMORY.md" or "memory/<name>.md".`,
		);
	}
}

/* ───────────────────────── lexical search helpers ───────────────────────── */

/** Lowercase + split on non-word chars; drop terms shorter than 2 chars. */
export function tokenize(text: string): string[] {
	return (text ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.filter((t) => t.length >= 2);
}

interface Chunk {
	text: string;
	startLine: number; // 1-based
	endLine: number; // 1-based inclusive
}

/**
 * Split a file into blank-line-separated chunks, tracking 1-based line
 * numbers so search hits can cite where they came from. A run of one or
 * more blank lines is the separator.
 */
export function splitIntoChunks(text: string): Chunk[] {
	const lines = text.split(/\r?\n/);
	const chunks: Chunk[] = [];
	let buf: string[] = [];
	let chunkStart = 1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "") {
			if (buf.length > 0) {
				chunks.push({ text: buf.join("\n"), startLine: chunkStart, endLine: i });
				buf = [];
			}
			chunkStart = i + 2; // next non-blank line is i+2 (1-based)
		} else {
			if (buf.length === 0) chunkStart = i + 1;
			buf.push(line);
		}
	}
	if (buf.length > 0) {
		chunks.push({ text: buf.join("\n"), startLine: chunkStart, endLine: lines.length });
	}
	return chunks;
}

/**
 * Score a chunk by how many DISTINCT query terms it contains, plus a
 * small bonus for total term frequency. Distinct-term coverage dominates
 * so a chunk mentioning all query terms once beats a chunk repeating one
 * term many times.
 */
export function scoreChunk(chunkText: string, queryTerms: string[]): number {
	if (queryTerms.length === 0) return 0;
	const chunkTokens = tokenize(chunkText);
	if (chunkTokens.length === 0) return 0;
	const freq = new Map<string, number>();
	for (const tok of chunkTokens) freq.set(tok, (freq.get(tok) ?? 0) + 1);
	let distinct = 0;
	let totalFreq = 0;
	for (const term of new Set(queryTerms)) {
		const f = freq.get(term) ?? 0;
		if (f > 0) {
			distinct += 1;
			totalFreq += f;
		}
	}
	// Distinct coverage is the integer part; frequency is a sub-1 tiebreak.
	return distinct + Math.min(totalFreq, 9) / 10;
}

function clampPositive(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

/**
 * Cap a single snippet's length so one blank-line-free paragraph can't
 * become a giant context dump. Truncates on a word boundary when possible
 * and appends an ellipsis marker the model understands.
 */
function truncateSnippet(text: string): string {
	if (text.length <= MAX_SNIPPET_CHARS) return text;
	const slice = text.slice(0, MAX_SNIPPET_CHARS);
	const lastSpace = slice.lastIndexOf(" ");
	const cut = lastSpace > MAX_SNIPPET_CHARS * 0.8 ? slice.slice(0, lastSpace) : slice;
	return `${cut} … [truncated; read_memory for the full text]`;
}
