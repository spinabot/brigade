import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { summarizeToolResult, formatToolArgs, looksLikeUnifiedDiff, classifyDiffLine, summarizeDiffStats, parseTodoArgs, todoMarker, summarizeTodos, isShellLikeTool, tailLines, describeOutputSize} from "./tool-result.js";

describe("summarizeToolResult — success mode", () => {
	it("collapses whitespace to a single line", () => {
		const r = summarizeToolResult("line1\nline2\nline3");
		assert.equal(r.hasContent, true);
		assert.equal(r.multiline, false);
		assert.equal(r.preview, "line1 line2 line3");
	});

	it("previews only the FIRST PARAGRAPH — a blank line means prose, not output", () => {
		// Collapsing the whole result turned a 5,814-char `spawn_agent` reply into a
		// one-line mash that cut through the middle of a sentence two paragraphs down.
		const r = summarizeToolResult("Verdict: ship it.\n\nHere is the long reasoning that follows, at length…");
		assert.equal(r.preview, "Verdict: ship it.");
		assert.equal(r.multiline, false);
	});

	it("output-shaped results (no blank line) still collapse whole", () => {
		const r = summarizeToolResult("total 12\ndrwxr-xr-x  a\n-rw-r--r--  b");
		assert.equal(r.preview, "total 12 drwxr-xr-x a -rw-r--r-- b");
	});

	it("a result that OPENS with a blank line still previews its content", () => {
		const r = summarizeToolResult("\n\nActual content here.");
		assert.equal(r.preview, "Actual content here.");
		assert.equal(r.hasContent, true);
	});

	it("truncates at 120 chars with ellipsis", () => {
		const r = summarizeToolResult("x".repeat(200));
		assert.equal(r.preview.length, 120);
		assert.match(r.preview, /…$/);
	});

	it("returns empty when result is null/empty", () => {
		assert.equal(summarizeToolResult(null).hasContent, false);
		assert.equal(summarizeToolResult("   ").hasContent, false);
	});

	it("extracts text from {content: string} (Brigade AgentTool shape)", () => {
		const r = summarizeToolResult({ content: "hello", details: { x: 1 } });
		assert.equal(r.preview, "hello");
	});

	it("extracts text from MCP-style array blocks", () => {
		const r = summarizeToolResult([
			{ type: "text", text: "alpha" },
			{ type: "text", text: "beta" },
		]);
		assert.equal(r.preview, "alpha beta");
	});
});

describe("summarizeToolResult — error mode (preserveNewlines)", () => {
	it("preserves newlines so multi-line block reasons stay readable", () => {
		const blockReason =
			'Tool "bash" was blocked: command "ls" is not on the exec-approvals allowlist. ' +
			"The operator must run\n" +
			'  brigade exec allow "ls"\n' +
			'(or `brigade exec allow-pattern <regex>` for a family of commands) before this command can execute.';
		const r = summarizeToolResult(blockReason, { preserveNewlines: true });
		assert.equal(r.hasContent, true);
		assert.equal(r.multiline, true);
		// The full "brigade exec allow" line MUST be in the output — that's the
		// whole point of error-mode preservation.
		assert.match(r.preview, /brigade exec allow "ls"/);
		// Newlines preserved
		assert.ok(r.preview.includes("\n"));
	});

	it("uses an 800-char budget in error mode (not 120)", () => {
		const longError = "x".repeat(500);
		const r = summarizeToolResult(longError, { preserveNewlines: true });
		assert.equal(r.preview.length, 500);
		assert.equal(r.multiline, false);
	});

	it("truncates at 800 chars when error reason is even longer", () => {
		const longError = "x".repeat(2000);
		const r = summarizeToolResult(longError, { preserveNewlines: true });
		assert.equal(r.preview.length, 800);
		assert.match(r.preview, /…$/);
	});

	it("collapses to single-line when error has no newlines", () => {
		const r = summarizeToolResult("short error", { preserveNewlines: true });
		assert.equal(r.multiline, false);
		assert.equal(r.preview, "short error");
	});

	it("trims outer whitespace but keeps indentation on non-first lines", () => {
		// `replace(/^\s+|\s+$/g, "")` strips leading whitespace through to
		// the first non-whitespace char and trailing whitespace from the
		// last non-whitespace char — that's what we want for block reasons
		// (the call-to-action's indentation on subsequent lines stays).
		const r = summarizeToolResult("\n  intro line\n  brigade exec allow X\n", {
			preserveNewlines: true,
		});
		assert.equal(r.preview, "intro line\n  brigade exec allow X");
		assert.equal(r.multiline, true);
	});
});

describe("summarizeToolResult — AgentToolResult envelope (Pi shape)", () => {
	it("peels the {content: [{type:'text',text:'...'}]} envelope and shows just the inner text", () => {
		// Regression: the TUI used to dump the raw JSON envelope verbatim:
		//   ✓ bash · {"content":[{"type":"text","text":"DIR\tagents..."}],"details":{}}
		// because the object branch fell through to `JSON.stringify(result)`.
		const result = {
			content: [{ type: "text", text: "DIR\tagents\t156\t8\t1.4 MB" }],
			details: {},
		};
		const r = summarizeToolResult(result);
		assert.equal(r.preview, "DIR agents 156 8 1.4 MB");
		assert.equal(r.hasContent, true);
		assert.equal(r.multiline, false);
		assert.ok(!r.preview.includes('"content"'));
		assert.ok(!r.preview.includes('"text"'));
	});

	it("concatenates multiple text blocks in the envelope", () => {
		const result = {
			content: [
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			],
			details: {},
		};
		const r = summarizeToolResult(result);
		assert.equal(r.preview, "first second");
	});

	it("represents image blocks as `[image <mime>]` placeholders", () => {
		const result = {
			content: [
				{ type: "text", text: "the image is:" },
				{ type: "image", mimeType: "image/png", data: "base64..." },
			],
		};
		const r = summarizeToolResult(result);
		assert.equal(r.preview, "the image is: [image image/png]");
	});

	it("preserves newlines in envelope text when in error mode", () => {
		const result = {
			content: [{ type: "text", text: "line one\nline two" }],
		};
		const r = summarizeToolResult(result, { preserveNewlines: true });
		assert.equal(r.preview, "line one\nline two");
		assert.equal(r.multiline, true);
	});
});

describe("summarizeToolResult — opts.maxLength override", () => {
	it("respects an explicit maxLength in success mode", () => {
		const r = summarizeToolResult("a".repeat(50), { maxLength: 10 });
		assert.equal(r.preview.length, 10);
	});

	it("respects an explicit maxLength in error mode", () => {
		const r = summarizeToolResult("a".repeat(50), { preserveNewlines: true, maxLength: 10 });
		assert.equal(r.preview.length, 10);
	});
});

describe("formatToolArgs", () => {
	it("shows the command for a shell call", () => {
		// `⚡ bash` told the operator nothing about what was about to run.
		assert.equal(formatToolArgs({ command: "npm test -- --watch" }), "npm test -- --watch");
	});

	it("shows the path for file tools, under any of the common key spellings", () => {
		assert.equal(formatToolArgs({ path: "src/core/server.ts" }), "src/core/server.ts");
		assert.equal(formatToolArgs({ file_path: "src/a.ts" }), "src/a.ts");
		assert.equal(formatToolArgs({ filePath: "src/b.ts" }), "src/b.ts");
	});

	it("prefers the most specific key when several are present", () => {
		// A shell call that also carries a cwd should show the command.
		assert.equal(formatToolArgs({ path: "/tmp", command: "ls -la" }), "ls -la");
	});

	it("collapses whitespace to a single line", () => {
		// A multi-line heredoc must not blow up the chip.
		assert.equal(formatToolArgs({ command: "line one\n\n   line two" }), "line one line two");
	});

	it("hard-truncates so a huge argument cannot flood the row", () => {
		const out = formatToolArgs({ command: "x".repeat(500) })!;
		assert.ok(out.length <= 72, `got ${out.length}`);
		assert.ok(out.endsWith("…"));
	});

	it("falls back to the first scalar for an unknown tool shape", () => {
		assert.equal(formatToolArgs({ somethingCustom: "value" }), "somethingCustom=value");
	});

	it("returns undefined when there is nothing worth showing", () => {
		// The caller then renders the bare tool name rather than empty brackets.
		assert.equal(formatToolArgs(undefined), undefined);
		assert.equal(formatToolArgs(null), undefined);
		assert.equal(formatToolArgs({}), undefined);
		assert.equal(formatToolArgs({ command: "   " }), undefined);
		assert.equal(formatToolArgs({ nested: { deep: 1 } }), undefined, "objects are not flattened into the chip");
	});

	it("handles a bare string argument", () => {
		assert.equal(formatToolArgs("just text"), "just text");
	});

	it("does not drop a falsy-but-real scalar", () => {
		assert.equal(formatToolArgs({ count: 0 }), "count=0");
		assert.equal(formatToolArgs({ enabled: false }), "enabled=false");
	});
});

describe("unified diff detection", () => {
	const DIFF = [
		"--- a/src/core/server.ts",
		"+++ b/src/core/server.ts",
		"@@ -1640,7 +1640,6 @@",
		" 				whimsicalIdx = 0;",
		"-				editor.disableSubmit = true;",
		"+				// submit stays enabled",
		"+				const x = 1;",
		" 				updateHeader();",
	].join("\n");

	it("recognises a real unified diff", () => {
		assert.equal(looksLikeUnifiedDiff(DIFF), true);
		assert.equal(looksLikeUnifiedDiff("@@ -1,2 +1,3 @@\n context"), true, "a hunk header alone is enough");
	});

	it("does NOT fire on a markdown bullet list", () => {
		// Every prose list starts lines with `-`. Keying off that alone would
		// colourise half the tool output in the transcript as deletions.
		assert.equal(looksLikeUnifiedDiff("- first item\n- second item\n- third"), false);
		assert.equal(looksLikeUnifiedDiff("+1 for that idea\n- not this one"), false);
		assert.equal(looksLikeUnifiedDiff(""), false);
		assert.equal(looksLikeUnifiedDiff("short"), false);
	});

	it("classifies file headers as meta, not as add/remove lines", () => {
		// `---` and `+++` start with `-`/`+`; checked in the wrong order every
		// diff would report two phantom changed lines.
		assert.equal(classifyDiffLine("--- a/file.ts"), "meta");
		assert.equal(classifyDiffLine("+++ b/file.ts"), "meta");
		assert.equal(classifyDiffLine("diff --git a/x b/x"), "meta");
		assert.equal(classifyDiffLine("index abc..def 100644"), "meta");
		assert.equal(classifyDiffLine("@@ -1,7 +1,6 @@"), "hunk");
		assert.equal(classifyDiffLine("-  removed"), "remove");
		assert.equal(classifyDiffLine("+  added"), "add");
		assert.equal(classifyDiffLine("  unchanged"), "context");
	});

	it("counts only real changes in the stats", () => {
		const { added, removed } = summarizeDiffStats(DIFF);
		assert.equal(added, 2, "the +++ header must not count as an addition");
		assert.equal(removed, 1, "the --- header must not count as a removal");
	});
});

describe("plan / todo parsing", () => {
	it("parses the vendor TodoWrite shape", () => {
		const items = parseTodoArgs({
			todos: [
				{ content: "Read the audit", status: "completed" },
				{ content: "Fix the leak", status: "in_progress" },
				{ content: "Ship it", status: "pending" },
			],
		})!;
		assert.equal(items.length, 3);
		assert.deepEqual(items.map((i) => i.status), ["completed", "in_progress", "pending"]);
		assert.equal(summarizeTodos(items), "1/3 done");
	});

	it("tolerates other backends' spellings", () => {
		// The tool is not Brigade's — on claude-cli it comes from the vendor binary
		// and other backends name it differently. A single hardcoded schema would
		// silently fall back to raw JSON for every provider but one.
		assert.equal(parseTodoArgs({ items: [{ text: "a", state: "done" }] })![0]!.status, "completed");
		assert.equal(parseTodoArgs({ plan: [{ title: "b", status: "not-started" }] })![0]!.status, "pending");
		assert.equal(parseTodoArgs({ tasks: ["plain string"] })![0]!.text, "plain string");
	});

	it("returns undefined for anything that is not a plan", () => {
		// So the caller falls back to the normal tool chip rather than rendering
		// an empty checklist.
		assert.equal(parseTodoArgs({ command: "ls" }), undefined);
		assert.equal(parseTodoArgs({ todos: [] }), undefined);
		assert.equal(parseTodoArgs(undefined), undefined);
		assert.equal(parseTodoArgs({ todos: [{ status: "done" }] }), undefined, "an item with no text is skipped");
	});

	it("maps every status to a distinct marker", () => {
		const marks = (["completed", "in_progress", "cancelled", "pending", "unknown"] as const).map(todoMarker);
		assert.equal(new Set(marks).size, 4, "pending and unknown share the neutral marker");
		assert.equal(todoMarker("completed"), "✓");
		assert.equal(todoMarker("in_progress"), "▸");
	});

	it("an unrecognised status is neutral, not silently 'done'", () => {
		// Reporting an unknown state as complete would overstate progress.
		assert.equal(parseTodoArgs({ todos: [{ content: "x", status: "weird" }] })![0]!.status, "unknown");
		assert.equal(summarizeTodos(parseTodoArgs({ todos: [{ content: "x", status: "weird" }] })!), "0/1 done");
	});
});

describe("live command output", () => {
	it("recognises shell-like tools and only those", () => {
		for (const n of ["bash", "Bash", "shell", "exec", "run_command", "terminal"]) {
			assert.equal(isShellLikeTool(n), true, n);
		}
		for (const n of ["read", "edit", "web_search", "TodoWrite", "spawn_agent"]) {
			assert.equal(isShellLikeTool(n), false, n);
		}
	});

	it("takes the TAIL — on a build, what just happened is the interesting part", () => {
		const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const out = tailLines(text, 5);
		assert.deepEqual(out, ["line 95", "line 96", "line 97", "line 98", "line 99"]);
	});

	it("clips a pathological line instead of letting it wrap the viewport", () => {
		// One minified bundle or base64 blob would otherwise push everything else
		// off the screen.
		const out = tailLines("x".repeat(5000), 5, 80);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.length, 80);
		assert.ok(out[0]!.endsWith("…"));
	});

	it("drops trailing blank lines from the stream", () => {
		assert.deepEqual(tailLines("a\nb\n\n\n", 5), ["a", "b"]);
		assert.deepEqual(tailLines("", 5), []);
	});

	it("expands tabs so the clip arithmetic holds", () => {
		assert.equal(tailLines("a\tb", 5)[0], "a  b");
	});

	it("reports the scale the tail is a window onto", () => {
		assert.equal(describeOutputSize("a\nb\nc"), "3 lines");
		assert.equal(describeOutputSize("x"), "1 line");
		assert.equal(describeOutputSize(Array.from({ length: 4200 }, () => "x").join("\n")), "4.2k lines");
	});
});
