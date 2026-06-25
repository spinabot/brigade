import { strict as assert } from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";

import { downloadSlackFile, isAllowedSlackFileUrl, withSlackRetry } from "./media.js";

describe("withSlackRetry", () => {
	it("returns the first successful result without retrying", async () => {
		let calls = 0;
		const out = await withSlackRetry(async () => {
			calls += 1;
			return "ok";
		});
		assert.equal(out, "ok");
		assert.equal(calls, 1);
	});

	it("retries a transient failure and then succeeds", async () => {
		let calls = 0;
		const out = await withSlackRetry(async () => {
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
			withSlackRetry(async () => {
				calls += 1;
				throw new Error(`fail-${calls}`);
			}),
			/fail-3/,
		);
		assert.equal(calls, 3);
	});

	it("honors a custom attempt count", async () => {
		let calls = 0;
		await assert.rejects(
			withSlackRetry(async () => {
				calls += 1;
				throw new Error("nope");
			}, 1),
		);
		assert.equal(calls, 1);
	});
});

describe("downloadSlackFile", () => {
	it("returns null (no fetch) for a file with no private url", async () => {
		let fetched = false;
		const out = await downloadSlackFile({
			file: { id: "F1" },
			token: "xoxb-x",
			fetchImpl: (async () => {
				fetched = true;
				return new Response("", { status: 200 });
			}) as typeof fetch,
		});
		assert.equal(out, null);
		assert.equal(fetched, false);
	});

	it("sends an Authorization: Bearer header when fetching the private url", async () => {
		let seenAuth: string | undefined;
		await downloadSlackFile({
			file: { id: "F1", url_private: "https://files.slack.com/F1", size: 999_999_999_999 },
			token: "xoxb-secret",
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
				return new Response("", { status: 200 });
			}) as unknown as typeof fetch,
		});
		// The oversized `size` short-circuits before fetch, so assert the guard works.
		assert.equal(seenAuth, undefined);
	});

	it("refuses a non-Slack host and NEVER fetches with the token (SSRF / exfil guard)", async () => {
		let fetched = false;
		const out = await downloadSlackFile({
			// A spoofed event pointing the download at cloud-metadata.
			file: { id: "F1", url_private: "http://169.254.169.254/latest/meta-data/" },
			token: "xoxb-secret",
			fetchImpl: (async () => {
				fetched = true;
				return new Response("secrets", { status: 200 });
			}) as unknown as typeof fetch,
		});
		assert.equal(out, null);
		assert.equal(fetched, false, "the bot token must never be sent to a non-Slack host");
	});

	it("passes redirect:manual so a cross-origin redirect can't leak the token", async () => {
		let seenRedirect: string | undefined;
		await downloadSlackFile({
			file: { id: "F1", url_private: "https://files.slack.com/F1" },
			token: "xoxb-secret",
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				seenRedirect = init?.redirect;
				return new Response("bytes", { status: 200 });
			}) as unknown as typeof fetch,
		});
		assert.equal(seenRedirect, "manual");
	});

	it("saves a CSV document with a .csv extension (filetype, then filename)", async () => {
		// Slack gives a friendly `filetype` ("csv"); even when it's absent the
		// `name` extension drives the saved file so analyze_media can detect it.
		const out = await downloadSlackFile({
			file: {
				id: "FCSV",
				url_private: "https://files.slack.com/FCSV",
				name: "data.csv",
				mimetype: "application/octet-stream",
				// no `filetype` set → must fall back to the name's extension
			},
			token: "xoxb-secret",
			fetchImpl: (async () => new Response("a,b\n1,2\n", { status: 200 })) as unknown as typeof fetch,
		});
		assert.ok(out, "document download resolved");
		assert.equal(path.extname(out!.path).toLowerCase(), ".csv");
		assert.equal(out!.fileName, "data.csv");
	});
});

describe("isAllowedSlackFileUrl", () => {
	it("allows https Slack file-CDN hosts and their subdomains", () => {
		assert.equal(isAllowedSlackFileUrl("https://files.slack.com/F1"), true);
		assert.equal(isAllowedSlackFileUrl("https://slack.com/x"), true);
		assert.equal(isAllowedSlackFileUrl("https://a.b.slack-edge.com/x"), true);
		assert.equal(isAllowedSlackFileUrl("https://x.slack-files.com/y"), true);
	});

	it("rejects non-https, non-Slack hosts, look-alikes, and junk", () => {
		assert.equal(isAllowedSlackFileUrl("http://files.slack.com/F1"), false); // not https
		assert.equal(isAllowedSlackFileUrl("http://169.254.169.254/"), false); // metadata
		assert.equal(isAllowedSlackFileUrl("https://evil.com/F1"), false);
		assert.equal(isAllowedSlackFileUrl("https://slack.com.evil.com/F1"), false); // suffix look-alike
		assert.equal(isAllowedSlackFileUrl("not a url"), false);
	});
});
