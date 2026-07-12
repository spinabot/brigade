/**
 * The load-bearing property here is the DISAMBIGUATION RULE: a token becomes an
 * attachment only if it names a file that exists on disk. Everything else about
 * drag-drop parsing is forgiving, but this rule is what stops us rewriting an
 * operator's ordinary prose ("email me @ work", "check /etc/hosts") into
 * something they didn't type. Most of these tests exist to hold that line.
 *
 * The two escaped-path cases are not hypothetical: both regexes below shipped
 * broken on Windows the first time and these caught it.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import {
	extractAttachmentPaths,
	inferAttachmentKind,
	inferMimeType,
	isAttachableExtension,
	stageAttachment,
} from "./attachments.js";

let dir: string;
let png: string;
let pdf: string;
let spaced: string;

before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-att-test-"));
	png = path.join(dir, "shot.png");
	pdf = path.join(dir, "spec.pdf");
	spaced = path.join(dir, "my report.pdf");
	fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
	fs.writeFileSync(pdf, "%PDF-1.4 hello");
	fs.writeFileSync(spaced, "%PDF-1.4 spaced");
});

after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("inferAttachmentKind", () => {
	it("routes images to the one kind that rides the turn inline", () => {
		assert.equal(inferAttachmentKind("/a/b.png"), "image");
		assert.equal(inferAttachmentKind("/a/b.JPEG"), "image");
		assert.equal(inferAttachmentKind("/a/b.webp"), "image");
	});

	it("classifies video and audio", () => {
		assert.equal(inferAttachmentKind("/a/b.mp4"), "video");
		assert.equal(inferAttachmentKind("/a/b.mov"), "video");
		assert.equal(inferAttachmentKind("/a/b.mp3"), "audio");
		assert.equal(inferAttachmentKind("/a/b.wav"), "audio");
	});

	it("falls back to document for anything unknown — the kind that always has a tool path in", () => {
		assert.equal(inferAttachmentKind("/a/b.pdf"), "document");
		assert.equal(inferAttachmentKind("/a/b.xyz"), "document");
		assert.equal(inferAttachmentKind("/a/README"), "document");
	});
});

describe("inferMimeType", () => {
	it("maps known extensions", () => {
		assert.equal(inferMimeType("/a/b.png"), "image/png");
		assert.equal(inferMimeType("/a/b.jpg"), "image/jpeg");
		assert.equal(inferMimeType("/a/b.pdf"), "application/pdf");
	});

	it("degrades to octet-stream rather than guessing", () => {
		assert.equal(inferMimeType("/a/b.zzz"), "application/octet-stream");
	});
});

describe("stageAttachment", () => {
	it("stages a real file with its size and kind", () => {
		const a = stageAttachment(png);
		assert.ok(a);
		assert.equal(a.kind, "image");
		assert.equal(a.fileName, "shot.png");
		assert.equal(a.mimeType, "image/png");
		assert.equal(a.bytes, 7);
	});

	it("refuses a directory", () => {
		assert.equal(stageAttachment(dir), null);
	});

	it("refuses a path that does not exist", () => {
		assert.equal(stageAttachment(path.join(dir, "nope.png")), null);
	});

	it("refuses an empty file — nothing to look at", () => {
		const empty = path.join(dir, "empty.png");
		fs.writeFileSync(empty, "");
		assert.equal(stageAttachment(empty), null);
	});
});

/**
 * `extractAttachmentPaths` runs on EVERY line the operator submits, so anything
 * it normalises, it normalises for the entire product. The first version of it
 * ended with `.replace(/[ \t]{2,}/g, " ").trim()` and therefore silently
 * destroyed the indentation of every pasted code block, YAML document, diff and
 * stack trace — on turns with no attachments at all. These tests exist so that
 * can never come back.
 */
describe("extractAttachmentPaths — prose must survive byte-for-byte", () => {
	it("returns a plain message completely unchanged", () => {
		const line = "can you explain how the gateway resumes a session?";
		assert.equal(extractAttachmentPaths(line).text, line);
	});

	it("preserves the indentation of pasted code — the regression that started this", () => {
		const code = "fix this:\ndef f(x):\n    if x:\n        return 1";
		const r = extractAttachmentPaths(code);
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, code, "indentation must not be collapsed");
	});

	it("preserves deliberate column alignment", () => {
		const line = "align these:  a=1   b=2";
		assert.equal(extractAttachmentPaths(line).text, line);
	});

	it("preserves runs of spaces inside quotes", () => {
		const line = 'say "hello  world" twice';
		assert.equal(extractAttachmentPaths(line).text, line);
	});

	it("preserves a YAML block's structure", () => {
		const yaml = "apply this:\nserver:\n  host: 0.0.0.0\n  port: 7777";
		assert.equal(extractAttachmentPaths(yaml).text, yaml);
	});
});

describe("isAttachableExtension — the prose gate only", () => {
	it("accepts media and documents a person actually encloses", () => {
		for (const f of ["a.png", "a.mp4", "a.mp3", "a.pdf", "a.docx", "a.xlsx", "a.epub"]) {
			assert.equal(isAttachableExtension(f), true, f);
		}
	});

	it("rejects source, config, data and log files — in a sentence those are CITED, not attached", () => {
		for (const f of ["a.ts", "a.js", "a.json", "a.yaml", "a.log", "a.txt", "a.md"]) {
			assert.equal(isAttachableExtension(f), false, f);
		}
	});

	it("rejects an extensionless path — /etc/hosts, /usr/bin/python", () => {
		assert.equal(isAttachableExtension("/etc/hosts"), false);
	});
});

describe("inferAttachmentKind — only provider-safe images may be inlined", () => {
	it("inlines exactly the four formats every vision provider accepts", () => {
		for (const f of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp"]) {
			assert.equal(inferAttachmentKind(f), "image", f);
		}
	});

	it("does NOT mark svg/tiff/heic/bmp/avif as `image` — inlining those 400s the whole turn", () => {
		// Anthropic accepts jpeg/png/gif/webp; OpenAI png/jpeg/webp/gif. An inline
		// `image/svg+xml` block is a hard API error that kills the turn, rather than
		// the graceful "a tool reads it instead" the design promises. So they are
		// classified as `document` and reach the model via analyze_media.
		for (const f of ["a.svg", "a.tiff", "a.heic", "a.bmp", "a.avif"]) {
			assert.equal(inferAttachmentKind(f), "document", f);
		}
	});

	it("classifies the full video and audio surface analyze_media can read", () => {
		for (const f of ["a.mp4", "a.mkv", "a.avi", "a.mpeg", "a.mov", "a.webm"]) {
			assert.equal(inferAttachmentKind(f), "video", f);
		}
		for (const f of ["a.mp3", "a.wav", "a.flac", "a.opus", "a.oga", "a.m4a"]) {
			assert.equal(inferAttachmentKind(f), "audio", f);
		}
	});
});

describe("extractAttachmentPaths — the disambiguation rule", () => {
	it("leaves prose with a bare @ completely untouched", () => {
		const r = extractAttachmentPaths("email me @ work about it");
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, "email me @ work about it");
	});

	it("does NOT attach a path in prose that isn't a real file", () => {
		const r = extractAttachmentPaths("check /nope/ghost.png and /var/log/absent.pdf for me");
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, "check /nope/ghost.png and /var/log/absent.pdf for me");
	});

	it("does NOT attach an EXTENSIONLESS file mentioned in prose, even though it exists", () => {
		// The one that matters on POSIX: /etc/hosts is a real file on every Linux and
		// macOS box. An existence-only rule silently attaches it and rewrites the
		// sentence to "check hosts for me". The extension gate is what stops that, so
		// prove it against a file we KNOW exists on this machine, whatever the OS.
		const extensionless = path.join(dir, "hosts");
		fs.writeFileSync(extensionless, "127.0.0.1 localhost");
		const r = extractAttachmentPaths(`check ${extensionless} for me`);
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, `check ${extensionless} for me`);
	});

	it("does NOT attach a source file mentioned in prose — a mention is not an attachment", () => {
		const ts = path.join(dir, "index.js");
		fs.writeFileSync(ts, "console.log(1)");
		const r = extractAttachmentPaths(`the bug is in ${ts} somewhere`);
		assert.equal(r.staged.length, 0);
	});

	it("does NOT attach a quoted RELATIVE filename — it would resolve against cwd", () => {
		// `edit "package.json"` sits in the repo root, so a cwd-relative resolve finds
		// a real file. Quoted prose must not become an attachment.
		const r = extractAttachmentPaths('edit "package.json" for me');
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, 'edit "package.json" for me');
	});

	it("DOES attach an extensionless file on a pure drop — that's unambiguous intent", () => {
		const extensionless = path.join(dir, "binary-blob");
		fs.writeFileSync(extensionless, "\x00\x01\x02");
		const r = extractAttachmentPaths(extensionless);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.kind, "document");
	});

	it("DOES attach a source file via an explicit @token — explicit intent lifts the gate", () => {
		const ts = path.join(dir, "app.ts");
		fs.writeFileSync(ts, "export const x = 1");
		const r = extractAttachmentPaths(`review @${ts} please`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, ts);
		assert.equal(r.text, "review app.ts please");
	});

	it("leaves a non-existent @token exactly as typed", () => {
		const r = extractAttachmentPaths("look at @src/ghost.ts please");
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, "look at @src/ghost.ts please");
	});

	it("captures an @token that IS a real file, replacing it with the basename", () => {
		const r = extractAttachmentPaths(`look at @${png} and tell me`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, png);
		assert.equal(r.staged[0]?.kind, "image");
		// Basename, not deletion — deleting would strand the referent ("look at  and tell me").
		assert.equal(r.text, "look at shot.png and tell me");
	});

	it("captures a bare dropped absolute path", () => {
		const r = extractAttachmentPaths(`${pdf} summarize this`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, pdf);
		assert.equal(r.text, "spec.pdf summarize this");
	});

	it("captures a quoted path with spaces — what a terminal pastes on drag-drop", () => {
		const r = extractAttachmentPaths(`"${spaced}" what's in it`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, spaced);
		assert.equal(r.staged[0]?.fileName, "my report.pdf");
	});

	it("captures a backslash-escaped path — what macOS/iTerm pastes on drag-drop", () => {
		// Regression: the alternation used to try `[^\s"']` first, which ate the lone
		// backslash and truncated the path at `…/my\`.
		const escaped = spaced.replace(/ /g, "\\ ");
		const r = extractAttachmentPaths(`${escaped} read it`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, spaced);
	});

	it("captures a file:// URI — what GNOME/Wayland pastes on drag-drop", () => {
		// Windows absolute paths become file:///C:/… — the leading slash is stripped.
		const uri =
			process.platform === "win32" ? `file:///${png.replace(/\\/g, "/")}` : `file://${png}`;
		const r = extractAttachmentPaths(`${uri} describe`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, png);
	});

	it("captures several files at once and dedupes a repeat", () => {
		const r = extractAttachmentPaths(`@${png} and @${pdf} and @${png} again`);
		assert.equal(r.staged.length, 2);
		assert.deepEqual(
			r.staged.map((s) => s.path).sort(),
			[png, pdf].sort(),
		);
	});

	it("handles a pure drop with no words — a valid turn on its own", () => {
		const r = extractAttachmentPaths(png);
		assert.equal(r.staged.length, 1);
		assert.equal(r.text, "shot.png");
	});
});

/**
 * Trailing punctuation belongs to the SENTENCE, not the filename. Before this was
 * handled, the token matcher swallowed it, the stat failed, and the file silently
 * did not attach — with no chip and no error. The `@` form is the cruellest: the
 * path came out of a file picker, so the operator has every reason to think it
 * worked.
 */
describe("extractAttachmentPaths — punctuation must not silently kill an attachment", () => {
	it("attaches despite a trailing full stop, and keeps the stop", () => {
		const r = extractAttachmentPaths(`look at ${png}.`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.text, "look at shot.png.");
	});

	it("attaches despite a trailing question mark", () => {
		const r = extractAttachmentPaths(`did you read ${pdf}?`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.text, "did you read spec.pdf?");
	});

	it("attaches despite a trailing comma on an @token", () => {
		const r = extractAttachmentPaths(`see @${png}, then tell me`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.text, "see shot.png, then tell me");
	});

	it("attaches inside parentheses", () => {
		const r = extractAttachmentPaths(`(see ${png})`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.text, "(see shot.png)");
	});
});

/**
 * The drop-time rewrite. A terminal answers a dropped file by pasting its PATH as
 * text, so without this the operator drops `plant-cell.png` and just watches
 * `C:\Users\me\Downloads\plant-cell.png` sit in the input box — nothing staged, no
 * bar, no pill, no reason to believe it worked. `{ pill: true }` is what the editor
 * uses to swap the path for an attachment chip the instant it lands.
 */
describe("extractAttachmentPaths — pill mode (drag-and-drop)", () => {
	it("turns a dropped path into a pill, not a bare word", () => {
		const r = extractAttachmentPaths(png, { pill: true });
		assert.equal(r.staged.length, 1);
		assert.equal(r.text, "[shot.png]");
	});

	it("pills a dropped path sitting inside a half-typed sentence", () => {
		const r = extractAttachmentPaths(`what is in ${png}`, { pill: true });
		assert.equal(r.staged.length, 1);
		assert.equal(r.text, "what is in [shot.png]");
	});

	it("pills a quoted dropped path (spaces in the name)", () => {
		const r = extractAttachmentPaths(`"${spaced}"`, { pill: true });
		assert.equal(r.staged.length, 1);
		assert.equal(r.text, "[my report.pdf]");
	});

	it("leaves the line ALONE when the drop wasn't a real file", () => {
		const line = "just some words";
		assert.equal(extractAttachmentPaths(line, { pill: true }).text, line);
	});

	it("defaults to plain basenames when pill mode is off", () => {
		assert.equal(extractAttachmentPaths(png).text, "shot.png");
	});
});

/**
 * Real filenames are hostile. `ChatGPT Image Jul 11, 2026, 11_45_54 AM (1).png`
 * has spaces, commas and parentheses — and a terminal pastes it UNQUOTED. Every
 * token pattern stops at the first space, so the candidate became
 * `…\Downloads\ChatGPT`, which is not a file, and the whole thing fell through as
 * prose: no pill, no attachment, no explanation. The whole-line check exists for
 * exactly this.
 */
describe("extractAttachmentPaths — filenames with spaces, commas and parens", () => {
	it("attaches an UNQUOTED path full of spaces and punctuation", () => {
		const nasty = path.join(dir, "ChatGPT Image Jul 11, 2026, 11_45_54 AM (1).png");
		fs.writeFileSync(nasty, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
		const r = extractAttachmentPaths(nasty, { pill: true });
		assert.equal(r.staged.length, 1, "an unquoted spacey path must still attach");
		assert.equal(r.staged[0]?.path, nasty);
		assert.equal(r.text, "[ChatGPT Image Jul 11, 2026, 11_45_54 AM (1).png]");
	});

	it("attaches it when quoted too", () => {
		const nasty = path.join(dir, "ChatGPT Image Jul 11, 2026, 11_45_54 AM (1).png");
		const r = extractAttachmentPaths(`"${nasty}"`, { pill: true });
		assert.equal(r.staged.length, 1);
	});

	it("still refuses a whole-line RELATIVE word — cwd resolution must not sneak back in", () => {
		const r = extractAttachmentPaths("package.json");
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, "package.json");
	});

	it("a multi-line paste is never treated as one whole-line path", () => {
		const code = "def f(x):\n    return x";
		assert.equal(extractAttachmentPaths(code).text, code);
	});
});

describe("extractAttachmentPaths — cwd-relative traps", () => {
	it("does NOT attach a bare quoted word that happens to name a file in cwd", () => {
		// `"package.json"` as the whole line: the residue is empty, so it reads as a
		// pure drop — and path.resolve would cheerfully find the repo's own
		// package.json and attach it. A one-word quoted reply is a message.
		const r = extractAttachmentPaths('"package.json"');
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, '"package.json"');
	});

	it("does NOT let an EMAIL feed the @ matcher", () => {
		// `bob@corp.com` offered `corp.com` as a candidate, resolved against cwd. Any
		// @word colliding with a file in cwd would be silently attached and the `@`
		// stripped out of the operator's text.
		const line = "ping bob@corp.com and sue@x.org about it";
		const r = extractAttachmentPaths(line);
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, line);
	});

	it("DOES honour an explicit @token for a cwd-relative file — that's the picker working", () => {
		const rel = path.relative(process.cwd(), png).split(path.sep).join("/");
		const r = extractAttachmentPaths(`review @${rel}`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, png);
	});
});

/**
 * `live` mode runs on every keystroke, so it must be cheap and must never rewrite
 * text the operator is still typing. The full parse runs once at submit; this is
 * only the instant-feedback path for a dropped absolute path.
 */
describe("extractAttachmentPaths — live mode (per-keystroke)", () => {
	it("stages a whole-line absolute dropped path", () => {
		const r = extractAttachmentPaths(png, { pill: true, live: true });
		assert.equal(r.staged.length, 1);
		assert.equal(r.text, "[shot.png]");
	});

	it("does NOTHING to a long paste — no per-keystroke reparse of a log", () => {
		const bigLog = ("2026-01-01 ERROR /var/log/x failed at /srv/app\n").repeat(5000);
		const start = Date.now();
		const r = extractAttachmentPaths(bigLog, { live: true });
		const ms = Date.now() - start;
		assert.equal(r.staged.length, 0, "a huge paste must not be scanned for paths");
		assert.equal(r.text, bigLog, "and must be returned untouched");
		assert.ok(ms < 20, `live parse of a big paste must be instant, was ${ms}ms`);
	});

	it("does NOT resolve a typed @mention against the cwd while typing", () => {
		// The module's own stated worst case. `@package.json` names a real cwd file,
		// but a typed mention must never be silently attached mid-keystroke.
		const r = extractAttachmentPaths("ping @package.json about it", { live: true });
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, "ping @package.json about it");
	});

	it("does NOT stage a relative word on the live path", () => {
		const r = extractAttachmentPaths("package.json", { live: true });
		assert.equal(r.staged.length, 0);
	});
});
