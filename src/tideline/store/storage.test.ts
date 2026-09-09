import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	BrigadeMemoryPathError,
	FileMemoryStore,
	scoreChunk,
	splitIntoChunks,
	tokenize,
} from "./storage.js";

let workspace: string;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-memstore-"));
	fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(workspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function writeMemory(rel: string, content: string): void {
	const full = path.join(workspace, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf8");
}

describe("tokenize", () => {
	it("lowercases + splits on non-word chars + drops <2-char terms", () => {
		assert.deepEqual(tokenize("User Prefers Concise-Replies!"), ["user", "prefers", "concise", "replies"]);
		// "a" dropped (len 1); "I/O" splits on "/" into "i" + "o" (both len 1, dropped); "ok" kept.
		assert.deepEqual(tokenize("a I/O ok"), ["ok"]);
	});
	it("empty / non-string → []", () => {
		assert.deepEqual(tokenize(""), []);
		assert.deepEqual(tokenize(undefined as never), []);
	});
});

describe("splitIntoChunks", () => {
	it("splits on blank lines + tracks 1-based line numbers", () => {
		const text = "alpha line\nstill alpha\n\nbeta line\n\n\ngamma";
		const chunks = splitIntoChunks(text);
		assert.equal(chunks.length, 3);
		assert.deepEqual(chunks[0], { text: "alpha line\nstill alpha", startLine: 1, endLine: 2 });
		assert.deepEqual(chunks[1], { text: "beta line", startLine: 4, endLine: 4 });
		assert.equal(chunks[2]?.text, "gamma");
		assert.equal(chunks[2]?.startLine, 7);
	});
	it("single chunk, no trailing newline", () => {
		const chunks = splitIntoChunks("just one block");
		assert.equal(chunks.length, 1);
		assert.deepEqual(chunks[0], { text: "just one block", startLine: 1, endLine: 1 });
	});
});

describe("scoreChunk", () => {
	it("distinct-term coverage dominates over frequency", () => {
		// chunk A has both query terms once; chunk B repeats one term 5×.
		const both = scoreChunk("pytest auto", ["pytest", "auto"]);
		const repeat = scoreChunk("pytest pytest pytest pytest pytest", ["pytest", "auto"]);
		assert.ok(both > repeat, `both(${both}) should beat repeat(${repeat})`);
	});
	it("zero query terms → 0", () => {
		assert.equal(scoreChunk("anything", []), 0);
	});
	it("no overlap → 0", () => {
		assert.equal(scoreChunk("totally unrelated", ["pytest"]), 0);
	});
});

describe("FileMemoryStore.search", () => {
	it("finds matching chunks across MEMORY.md + memory/*.md, ranked by score", async () => {
		writeMemory("MEMORY.md", "User prefers concise replies.\n\nUser is on Windows.");
		writeMemory("memory/2026-05-21.md", "Project uses pytest with -n auto.\n\nUnrelated note about lunch.");
		const store = new FileMemoryStore(workspace);
		const results = await store.search("pytest auto");
		assert.equal(results.length, 1);
		assert.equal(results[0]?.relPath, "memory/2026-05-21.md");
		assert.match(results[0]?.snippet ?? "", /pytest/);
		assert.equal(results[0]!.score, 2.2, "both query terms present: distinct=2 + totalFreq=2/10");
	});

	it("returns [] for empty query", async () => {
		writeMemory("MEMORY.md", "anything");
		const store = new FileMemoryStore(workspace);
		assert.deepEqual(await store.search(""), []);
		assert.deepEqual(await store.search("   "), []);
	});

	it("respects maxResults", async () => {
		writeMemory("MEMORY.md", "cat\n\ncat\n\ncat\n\ncat");
		const store = new FileMemoryStore(workspace);
		const results = await store.search("cat", { maxResults: 2 });
		assert.equal(results.length, 2);
	});

	it("returns [] when no memory files exist", async () => {
		const store = new FileMemoryStore(workspace);
		assert.deepEqual(await store.search("anything"), []);
	});

	it("cites the correct line range for a deep chunk", async () => {
		writeMemory("MEMORY.md", "line1\n\nline3 needle here\n\nline5");
		const store = new FileMemoryStore(workspace);
		const results = await store.search("needle");
		assert.equal(results[0]?.startLine, 3);
		assert.equal(results[0]?.endLine, 3);
	});
});

describe("FileMemoryStore.read", () => {
	it("reads MEMORY.md fully when small", async () => {
		writeMemory("MEMORY.md", "fact one\nfact two");
		const store = new FileMemoryStore(workspace);
		const r = await store.read("MEMORY.md");
		assert.equal(r.text, "fact one\nfact two");
		assert.equal(r.truncated, false);
		assert.equal(r.from, 1);
		assert.equal(r.lines, 2);
	});

	it("reads a memory/ daily note", async () => {
		writeMemory("memory/2026-05-21.md", "today's note");
		const store = new FileMemoryStore(workspace);
		const r = await store.read("memory/2026-05-21.md");
		assert.equal(r.text, "today's note");
	});

	it("windows large files + reports nextFrom", async () => {
		const big = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
		writeMemory("MEMORY.md", big);
		const store = new FileMemoryStore(workspace);
		const r = await store.read("MEMORY.md", { from: 1, lines: 100 });
		assert.equal(r.lines, 100);
		assert.equal(r.truncated, true);
		assert.equal(r.nextFrom, 101);
		assert.match(r.text, /^line 1\n/);
	});

	it("caps lines at the hard maximum (1000)", async () => {
		const huge = Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n");
		writeMemory("MEMORY.md", huge);
		const store = new FileMemoryStore(workspace);
		const r = await store.read("MEMORY.md", { lines: 99999 });
		assert.equal(r.lines, 1000);
		assert.equal(r.truncated, true);
	});

	it("case-insensitive memory.md resolves to MEMORY.md", async () => {
		writeMemory("MEMORY.md", "x");
		const store = new FileMemoryStore(workspace);
		const r = await store.read("memory.md");
		assert.equal(r.relPath, "MEMORY.md");
	});

	it("throws BrigadeMemoryPathError for a non-memory path", async () => {
		const store = new FileMemoryStore(workspace);
		await assert.rejects(() => store.read("USER.md"), BrigadeMemoryPathError);
		await assert.rejects(() => store.read("../secrets.txt"), BrigadeMemoryPathError);
		await assert.rejects(() => store.read("/etc/passwd"), BrigadeMemoryPathError);
		await assert.rejects(() => store.read("memory/sub/nested.md"), BrigadeMemoryPathError);
		await assert.rejects(() => store.read("memory/note.txt"), BrigadeMemoryPathError);
	});

	it("throws BrigadeMemoryPathError for a missing (but valid-shaped) file", async () => {
		const store = new FileMemoryStore(workspace);
		await assert.rejects(() => store.read("memory/2099-01-01.md"), BrigadeMemoryPathError);
	});

	it("rejects empty path", async () => {
		const store = new FileMemoryStore(workspace);
		await assert.rejects(() => store.read("   "), BrigadeMemoryPathError);
	});
});

describe("FileMemoryStore.search — output caps (round-1 audit B1/B2)", () => {
	it("caps each snippet length + flags truncation", async () => {
		// One blank-line-free paragraph far over the per-snippet cap.
		const giant = `needle ${"x".repeat(5000)}`;
		writeMemory("MEMORY.md", giant);
		const store = new FileMemoryStore(workspace);
		const results = await store.search("needle");
		assert.equal(results.length, 1);
		assert.ok(results[0]!.snippet.length < 2000, "snippet should be capped");
		assert.match(results[0]!.snippet, /\[truncated; read_memory for the full text\]/);
	});

	it("enforces a total snippet-char budget across results", async () => {
		// Many large matching chunks; total must stay bounded.
		const chunks = Array.from({ length: 20 }, () => `needle ${"y".repeat(1400)}`).join("\n\n");
		writeMemory("MEMORY.md", chunks);
		const store = new FileMemoryStore(workspace);
		const results = await store.search("needle", { maxResults: 20 });
		const total = results.reduce((sum, r) => sum + r.snippet.length, 0);
		assert.ok(total <= 8000 + 1600, `total snippet chars ${total} should stay near the 8000 budget`);
	});

	it("reads oversized files head-only without crashing (B1 size cap)", async () => {
		// 3 MB file (over the 2 MB search cap) with the needle near the top.
		const head = "needle is here at the top\n\n";
		const filler = "z".repeat(3 * 1024 * 1024);
		writeMemory("memory/2026-05-22.md", head + filler);
		const store = new FileMemoryStore(workspace);
		const results = await store.search("needle");
		assert.equal(results.length, 1, "head content is still searchable");
		assert.match(results[0]!.snippet, /needle is here at the top/);
	});
});

describe("FileMemoryStore.read — trailing newline (round-1 audit B3)", () => {
	it("a 2-line file ending in newline reports 2 lines, not 3", async () => {
		writeMemory("MEMORY.md", "fact one\nfact two\n");
		const store = new FileMemoryStore(workspace);
		const r = await store.read("MEMORY.md");
		assert.equal(r.lines, 2);
		assert.equal(r.text, "fact one\nfact two");
		assert.equal(r.truncated, false);
	});

	it("a genuine blank last line is preserved (a\\n\\n → 2 lines: content + blank)", async () => {
		writeMemory("MEMORY.md", "fact one\n\n");
		const store = new FileMemoryStore(workspace);
		const r = await store.read("MEMORY.md");
		assert.equal(r.lines, 2);
	});

	it("no trailing newline → exact line count", async () => {
		writeMemory("MEMORY.md", "a\nb\nc");
		const store = new FileMemoryStore(workspace);
		const r = await store.read("MEMORY.md");
		assert.equal(r.lines, 3);
	});
});

describe("FileMemoryStore.status", () => {
	it("reports backend=file + file count + total bytes", async () => {
		writeMemory("MEMORY.md", "abc");
		writeMemory("memory/2026-05-21.md", "defgh");
		const store = new FileMemoryStore(workspace);
		const s = await store.status();
		assert.equal(s.backend, "file");
		assert.equal(s.fileCount, 2);
		assert.equal(s.totalBytes, 3 + 5);
		assert.equal(s.root, path.resolve(workspace));
	});

	it("reports zero when no memory files exist", async () => {
		const store = new FileMemoryStore(workspace);
		const s = await store.status();
		assert.equal(s.fileCount, 0);
		assert.equal(s.totalBytes, 0);
	});
});
