import { strict as assert } from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";

import { stickerToAttachment } from "./inbound-extras.js";
import { buildDiscordAttachment, downloadDiscordAttachment, isAllowedDiscordAttachmentUrl, withDiscordRetry } from "./media.js";

describe("withDiscordRetry", () => {
	it("returns the first successful result without retrying", async () => {
		let calls = 0;
		const out = await withDiscordRetry(async () => {
			calls += 1;
			return "ok";
		});
		assert.equal(out, "ok");
		assert.equal(calls, 1);
	});

	it("retries a transient failure and then succeeds", async () => {
		let calls = 0;
		const out = await withDiscordRetry(async () => {
			calls += 1;
			if (calls < 3) throw new Error("transient");
			return "ok";
		});
		assert.equal(out, "ok");
		assert.equal(calls, 3);
	});

	it("throws the last error after exhausting attempts (default 3)", async () => {
		let calls = 0;
		await assert.rejects(
			withDiscordRetry(async () => {
				calls += 1;
				throw new Error(`fail-${calls}`);
			}),
			/fail-3/,
		);
		assert.equal(calls, 3);
	});
});

describe("downloadDiscordAttachment", () => {
	it("returns null (no fetch) for an attachment with no url", async () => {
		let fetched = false;
		const out = await downloadDiscordAttachment({
			attachment: { id: "a1" },
			fetchImpl: (async () => {
				fetched = true;
				return new Response("", { status: 200 });
			}) as typeof fetch,
		});
		assert.equal(out, null);
		assert.equal(fetched, false);
	});

	it("refuses a non-Discord host and NEVER fetches it (SSRF guard)", async () => {
		let fetched = false;
		const out = await downloadDiscordAttachment({
			// A spoofed message pointing the download at cloud-metadata.
			attachment: { id: "a1", url: "http://169.254.169.254/latest/meta-data/" },
			fetchImpl: (async () => {
				fetched = true;
				return new Response("secrets", { status: 200 });
			}) as unknown as typeof fetch,
		});
		assert.equal(out, null);
		assert.equal(fetched, false, "Brigade must never fetch a non-Discord host");
	});

	it("short-circuits an oversized attachment before fetching", async () => {
		let fetched = false;
		const out = await downloadDiscordAttachment({
			attachment: { id: "a1", url: "https://cdn.discordapp.com/a1", size: 999_999_999_999 },
			fetchImpl: (async () => {
				fetched = true;
				return new Response("", { status: 200 });
			}) as unknown as typeof fetch,
		});
		assert.equal(out, null);
		assert.equal(fetched, false);
	});

	it("passes redirect:manual so a cross-origin redirect can't be followed", async () => {
		let seenRedirect: string | undefined;
		await downloadDiscordAttachment({
			attachment: { id: "a1", url: "https://cdn.discordapp.com/a1" },
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				seenRedirect = init?.redirect;
				return new Response("bytes", { status: 200 });
			}) as unknown as typeof fetch,
		});
		assert.equal(seenRedirect, "manual");
	});

	it("downloads a sticker built from the sticker CDN (Fix 1a — passes the SSRF allowlist)", async () => {
		// media.discordapp.net is already an allowed Discord CDN host, so a sticker
		// attachment built by stickerToAttachment downloads through the same path.
		const sticker = stickerToAttachment({ id: "777", name: "wave", format: 1 });
		assert.ok(sticker);
		let fetchedUrl: string | undefined;
		const out = await downloadDiscordAttachment({
			attachment: sticker!,
			fetchImpl: (async (url: string) => {
				fetchedUrl = url;
				return new Response("PNGBYTES", { status: 200 });
			}) as unknown as typeof fetch,
		});
		assert.equal(fetchedUrl, "https://media.discordapp.net/stickers/777.png");
		assert.ok(out, "the sticker download should produce a saved media descriptor");
		assert.equal(out?.kind, "image");
	});

	it("saves an octet-stream CSV document with a .csv extension (from the filename)", async () => {
		// A document whose contentType is the generic application/octet-stream but
		// whose name is data.csv — the saved file must be .csv so analyze_media
		// detects it as text (Discord derives the ext from the filename first).
		const out = await downloadDiscordAttachment({
			attachment: {
				id: "doc1",
				url: "https://cdn.discordapp.com/attachments/1/2/data.csv",
				name: "data.csv",
				contentType: "application/octet-stream",
			},
			fetchImpl: (async () => new Response("a,b\n1,2\n", { status: 200 })) as unknown as typeof fetch,
		});
		assert.ok(out, "document download resolved");
		assert.equal(path.extname(out!.path).toLowerCase(), ".csv");
		assert.equal(out!.fileName, "data.csv");
	});
});

describe("isAllowedDiscordAttachmentUrl", () => {
	it("allows https Discord CDN hosts and their subdomains", () => {
		assert.equal(isAllowedDiscordAttachmentUrl("https://cdn.discordapp.com/attachments/1/2/x.png"), true);
		assert.equal(isAllowedDiscordAttachmentUrl("https://media.discordapp.net/x"), true);
		assert.equal(isAllowedDiscordAttachmentUrl("https://images-ext-1.media.discordapp.net/y"), true);
	});

	it("rejects non-https, non-Discord hosts, look-alikes, and junk", () => {
		assert.equal(isAllowedDiscordAttachmentUrl("http://cdn.discordapp.com/x"), false); // not https
		assert.equal(isAllowedDiscordAttachmentUrl("http://169.254.169.254/"), false); // metadata
		assert.equal(isAllowedDiscordAttachmentUrl("https://evil.com/x"), false);
		assert.equal(isAllowedDiscordAttachmentUrl("https://cdn.discordapp.com.evil.com/x"), false); // suffix look-alike
		assert.equal(isAllowedDiscordAttachmentUrl("not a url"), false);
	});
});

describe("buildDiscordAttachment", () => {
	it("derives a name from the path when none is given", () => {
		const out = buildDiscordAttachment({ kind: "document", path: "/tmp/report.pdf" });
		assert.equal(out.name, "report.pdf");
		assert.equal(out.path, "/tmp/report.pdf");
	});

	it("keeps an explicit filename + caption", () => {
		const out = buildDiscordAttachment({ kind: "image", path: "/tmp/x.png", fileName: "pic.png", caption: "hi" });
		assert.equal(out.name, "pic.png");
		assert.equal(out.caption, "hi");
	});

	it("throws when the outbound media-path guard refuses the path", () => {
		// A secret basename the guard rejects on every platform (id_rsa is in the
		// guard's SENSITIVE_BASENAMES set, so this holds on win32 + POSIX alike).
		assert.throws(() => buildDiscordAttachment({ kind: "document", path: "/home/me/.ssh/id_rsa" }), /Discord:/);
	});

	it("appends a kind-inferred extension when the name is extensionless (Fix 5b)", () => {
		// Extensionless path + image kind → Discord type-detects via the .png suffix.
		assert.equal(buildDiscordAttachment({ kind: "image", path: "/tmp/photo" }).name, "photo.png");
		assert.equal(buildDiscordAttachment({ kind: "video", path: "/tmp/clip" }).name, "clip.mp4");
		assert.equal(buildDiscordAttachment({ kind: "audio", path: "/tmp/song" }).name, "song.mp3");
		assert.equal(buildDiscordAttachment({ kind: "voice", path: "/tmp/note" }).name, "note.ogg");
	});

	it("does NOT double-extend a name that already has an extension (Fix 5b)", () => {
		assert.equal(buildDiscordAttachment({ kind: "image", path: "/tmp/photo.jpeg" }).name, "photo.jpeg");
		assert.equal(buildDiscordAttachment({ kind: "image", path: "/tmp/x", fileName: "given.png" }).name, "given.png");
	});

	it("leaves a document extensionless when the kind has no sensible default (Fix 5b)", () => {
		assert.equal(buildDiscordAttachment({ kind: "document", path: "/tmp/README" }).name, "README");
	});
});
