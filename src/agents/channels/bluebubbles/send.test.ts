import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	bubbleSplit,
	editBlueBubblesMessage,
	reactBlueBubbles,
	sendBlueBubblesAttachment,
	sendBlueBubblesText,
	unsendBlueBubblesMessage,
} from "./send.js";
import { buildBlueBubblesApiUrl } from "./types.js";

/** One recorded request the fake fetch saw. */
interface RecordedRequest {
	url: string;
	method: string;
	body: unknown;
	isForm: boolean;
}

/**
 * Build a fake fetch that records each request and returns a canned JSON `data`
 * body. Captures the URL + parsed body so tests can assert on the wire shape.
 */
function recordingFetch(data: unknown, recorder: RecordedRequest[], opts: { status?: number } = {}): typeof fetch {
	return (async (url: string, init: RequestInit) => {
		const body = init.body;
		let parsed: unknown = null;
		let isForm = false;
		if (typeof body === "string") {
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = body;
			}
		} else if (body instanceof FormData) {
			isForm = true;
			const obj: Record<string, unknown> = {};
			for (const [k, v] of (body as FormData).entries()) obj[k] = v;
			parsed = obj;
		}
		recorder.push({ url, method: (init.method ?? "GET").toUpperCase(), body: parsed, isForm });
		const status = opts.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => JSON.stringify({ status: 200, data }),
			headers: new Map<string, string>() as unknown as Headers,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

const SERVER = "http://192.168.1.5:1234";
// Assemble the password from parts so no token-shaped literal lands in the repo.
const PASSWORD = ["bb", "secret", "pw"].join("-");

describe("buildBlueBubblesApiUrl", () => {
	it("puts the password in the query string (urlencoded), not a header", () => {
		const url = buildBlueBubblesApiUrl({ serverUrl: SERVER, path: "message/text", password: "a b&c" });
		assert.match(url, /^http:\/\/192\.168\.1\.5:1234\/api\/v1\/message\/text\?/);
		// Space → %20 (or +), & → %26 — proves URL-encoding happened.
		assert.match(url, /password=a(%20|\+)b%26c/);
	});

	it("strips a trailing slash + a leading slash on the path", () => {
		const url = buildBlueBubblesApiUrl({ serverUrl: "http://192.168.0.2:1234/", path: "/server/info", password: "p" });
		assert.match(url, /^http:\/\/192\.168\.0\.2:1234\/api\/v1\/server\/info\?password=p$/);
	});
});

describe("bubbleSplit", () => {
	it("splits on blank lines into separate bubbles", () => {
		assert.deepEqual(bubbleSplit("one\n\ntwo\n\nthree"), ["one", "two", "three"]);
	});
	it("keeps a single paragraph as one bubble", () => {
		assert.deepEqual(bubbleSplit("just one\nline here"), ["just one\nline here"]);
	});
	it("returns [] for whitespace-only text", () => {
		assert.deepEqual(bubbleSplit("   \n\n  "), []);
	});
});

describe("sendBlueBubblesText", () => {
	it("POSTs chatGuid + tempGuid + message and returns the message guid", async () => {
		const rec: RecordedRequest[] = [];
		const res = await sendBlueBubblesText("iMessage;-;+1555", "hello", {
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: recordingFetch({ guid: "MSG-1" }, rec),
		});
		assert.equal(res.messageId, "MSG-1");
		assert.equal(rec.length, 1);
		assert.match(rec[0]!.url, /message\/text/);
		const body = rec[0]!.body as Record<string, unknown>;
		assert.equal(body.chatGuid, "iMessage;-;+1555");
		assert.equal(body.message, "hello");
		assert.ok(typeof body.tempGuid === "string" && body.tempGuid.length > 0);
		// No private-api method when not enabled.
		assert.equal(body.method, undefined);
	});

	it("adds reply-thread + effect params only when Private API is enabled", async () => {
		const rec: RecordedRequest[] = [];
		await sendBlueBubblesText("G", "hi", {
			serverUrl: SERVER,
			password: PASSWORD,
			privateApiEnabled: true,
			replyToMessageGuid: "TARGET",
			replyToPartIndex: 1,
			effect: "confetti",
			fetchImpl: recordingFetch({ guid: "X" }, rec),
		});
		const body = rec[0]!.body as Record<string, unknown>;
		assert.equal(body.method, "private-api");
		assert.equal(body.selectedMessageGuid, "TARGET");
		assert.equal(body.partIndex, 1);
		assert.equal(body.effectId, "com.apple.messages.effect.CKConfettiEffect");
	});
});

describe("sendBlueBubblesAttachment", () => {
	it("uploads multipart with the expected field names", async () => {
		const rec: RecordedRequest[] = [];
		const res = await sendBlueBubblesAttachment("G", {
			serverUrl: SERVER,
			password: PASSWORD,
			privateApiEnabled: true,
			filePath: "/tmp/pic.png",
			contentType: "image/png",
			bytes: new Uint8Array([1, 2, 3]),
			fetchImpl: recordingFetch({ guid: "ATT-1" }, rec),
		});
		assert.equal(res.messageId, "ATT-1");
		assert.equal(rec[0]!.isForm, true);
		const body = rec[0]!.body as Record<string, unknown>;
		assert.equal(body.chatGuid, "G");
		assert.equal(body.name, "pic.png");
		assert.equal(body.method, "private-api");
		assert.ok(typeof body.tempGuid === "string");
		assert.ok(body.attachment, "carries the file part");
	});
});

describe("reactBlueBubbles", () => {
	it("POSTs a normalised reaction type to message/react", async () => {
		const rec: RecordedRequest[] = [];
		await reactBlueBubbles(
			{ serverUrl: SERVER, password: PASSWORD, privateApiEnabled: true, fetchImpl: recordingFetch({}, rec) },
			{ chatGuid: "G", messageGuid: "M", reaction: "👍" },
		);
		const body = rec[0]!.body as Record<string, unknown>;
		assert.match(rec[0]!.url, /message\/react/);
		assert.equal(body.reaction, "like");
		assert.equal(body.selectedMessageGuid, "M");
	});

	it("normalises a removal (-love)", async () => {
		const rec: RecordedRequest[] = [];
		await reactBlueBubbles(
			{ serverUrl: SERVER, password: PASSWORD, privateApiEnabled: true, fetchImpl: recordingFetch({}, rec) },
			{ chatGuid: "G", messageGuid: "M", reaction: "-love" },
		);
		assert.equal((rec[0]!.body as Record<string, unknown>).reaction, "-love");
	});

	it("refuses when Private API is disabled", async () => {
		await assert.rejects(
			() =>
				reactBlueBubbles(
					{ serverUrl: SERVER, password: PASSWORD, privateApiEnabled: false },
					{ chatGuid: "G", messageGuid: "M", reaction: "love" },
				),
			/Private API/,
		);
	});

	it("rejects an unknown reaction", async () => {
		await assert.rejects(
			() =>
				reactBlueBubbles(
					{ serverUrl: SERVER, password: PASSWORD, privateApiEnabled: true, fetchImpl: recordingFetch({}, []) },
					{ chatGuid: "G", messageGuid: "M", reaction: "shrug" },
				),
			/Unknown iMessage reaction/,
		);
	});
});

describe("editBlueBubblesMessage / unsendBlueBubblesMessage", () => {
	it("edits via message/{guid}/edit with the edited body", async () => {
		const rec: RecordedRequest[] = [];
		await editBlueBubblesMessage(
			{ serverUrl: SERVER, password: PASSWORD, privateApiEnabled: true, fetchImpl: recordingFetch({}, rec) },
			{ messageGuid: "M-1", editedMessage: "fixed" },
		);
		assert.match(rec[0]!.url, /message\/M-1\/edit/);
		assert.equal((rec[0]!.body as Record<string, unknown>).editedMessage, "fixed");
	});

	it("unsends via message/{guid}/unsend", async () => {
		const rec: RecordedRequest[] = [];
		await unsendBlueBubblesMessage(
			{ serverUrl: SERVER, password: PASSWORD, privateApiEnabled: true, fetchImpl: recordingFetch({}, rec) },
			{ messageGuid: "M-2" },
		);
		assert.match(rec[0]!.url, /message\/M-2\/unsend/);
	});

	it("edit refuses when Private API is disabled", async () => {
		await assert.rejects(
			() =>
				editBlueBubblesMessage(
					{ serverUrl: SERVER, password: PASSWORD, privateApiEnabled: false },
					{ messageGuid: "M", editedMessage: "x" },
				),
			/Private API/,
		);
	});
});
