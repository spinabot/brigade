/**
 * Tests for `send_media` — the channel-attachment companion to
 * `send_message`. Stubs the active channel manager + adapter so the
 * test never spawns a real WhatsApp / Slack connection.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	getActiveChannelManager,
	setActiveChannelManager,
} from "../channels/active-manager.js";
import { makeSendMediaTool } from "./send-media-tool.js";

/* ─── helpers ───────────────────────────────────────── */

interface StubAdapter {
	sendMedia?: (
		to: string,
		media: {
			kind: string;
			path: string;
			caption?: string;
			fileName?: string;
			mimeType?: string;
		},
	) => Promise<void>;
	sendText?: (to: string, text: string) => Promise<void>;
	health?: () => { ok: boolean; kind?: string; reason?: string };
}

interface StubManager {
	started: string[];
	adapter(channel: string, accountId?: string): StubAdapter | undefined;
}

function mountStub(manager: StubManager): void {
	setActiveChannelManager(manager as never);
}

function clearStub(): void {
	setActiveChannelManager(null);
}

/** Capture every sendMedia call so assertions can inspect the payload. */
interface Capture {
	calls: Array<{
		to: string;
		media: {
			kind: string;
			path: string;
			caption?: string;
			fileName?: string;
			mimeType?: string;
		};
	}>;
}

/**
 * Pi's AgentToolResult treats `isError` as OPTIONAL — `failedTextResult`
 * doesn't set it; the failure signal is the prefix in the content text
 * (every Brigade tool that fails emits `<toolName>: <reason>...`). This
 * helper checks for that signal so refusal tests are robust to the
 * isError flag being absent.
 */
function assertFailed(result: {
	content?: unknown[];
	isError?: boolean;
}): void {
	const text = JSON.stringify(result);
	assert.ok(
		result.isError === true || /send_media:/.test(text),
		`expected a refusal result, got ${text.slice(0, 200)}`,
	);
}

function captureAdapter(opts: { mediaSupport: boolean; healthy?: boolean } = {
	mediaSupport: true,
}): { adapter: StubAdapter; capture: Capture } {
	const capture: Capture = { calls: [] };
	const adapter: StubAdapter = {
		health: () =>
			opts.healthy === false
				? { ok: false, kind: "logged-out", reason: "session expired" }
				: { ok: true },
	};
	if (opts.mediaSupport) {
		adapter.sendMedia = async (to, media) => {
			capture.calls.push({ to, media: { ...media } });
		};
	}
	adapter.sendText = async () => {};
	return { adapter, capture };
}

/* ─── tests ─────────────────────────────────────────── */

describe("send_media tool", () => {
	let tmpDir: string;
	let imagePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "brigade-send-media-"));
		imagePath = path.join(tmpDir, "chart.png");
		writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
	});
	afterEach(() => {
		clearStub();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("(1) refuses when no channel manager is mounted", async () => {
		const tool = makeSendMediaTool();
		const result = (await tool.execute("call-1", {
			path: imagePath,
			channel: "whatsapp",
			to: "+12345",
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		const text = JSON.stringify(result);
		assert.match(text, /no channel manager mounted/);
	});

	it("(2) refuses when the file does not exist", async () => {
		mountStub({
			started: ["whatsapp"],
			adapter: () => captureAdapter().adapter,
		});
		const tool = makeSendMediaTool();
		const ghost = path.join(tmpDir, "does-not-exist.png");
		const result = (await tool.execute("call-1", {
			path: ghost,
			channel: "whatsapp",
			to: "+12345",
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		const text = JSON.stringify(result);
		assert.match(text, /file not found/i);
	});

	it("(3) refuses when channel is not started", async () => {
		mountStub({
			started: ["slack"],
			adapter: () => undefined,
		});
		const tool = makeSendMediaTool();
		const result = (await tool.execute("call-1", {
			path: imagePath,
			channel: "whatsapp",
			to: "+12345",
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		assert.match(JSON.stringify(result), /not a started adapter/);
	});

	it("(4) refuses when the adapter has no sendMedia capability", async () => {
		const adapter = captureAdapter({ mediaSupport: false }).adapter;
		mountStub({
			started: ["text-only"],
			adapter: () => adapter,
		});
		const tool = makeSendMediaTool();
		const result = (await tool.execute("call-1", {
			path: imagePath,
			channel: "text-only",
			to: "+12345",
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		assert.match(JSON.stringify(result), /does not support media/);
	});

	it("(5) refuses when adapter health is bad", async () => {
		const { adapter } = captureAdapter({
			mediaSupport: true,
			healthy: false,
		});
		mountStub({
			started: ["whatsapp"],
			adapter: () => adapter,
		});
		const tool = makeSendMediaTool();
		const result = (await tool.execute("call-1", {
			path: imagePath,
			channel: "whatsapp",
			to: "+12345",
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		assert.match(JSON.stringify(result), /currently unavailable/);
	});

	it("(6) dispatches successfully and infers kind:'image' from .png", async () => {
		const { adapter, capture } = captureAdapter();
		mountStub({
			started: ["whatsapp"],
			adapter: () => adapter,
		});
		const tool = makeSendMediaTool();
		const result = (await tool.execute("call-1", {
			path: imagePath,
			channel: "whatsapp",
			to: "+12345",
			caption: "Here's the org chart.",
		} as never)) as { isError?: boolean };
		assert.notEqual(result.isError, true);
		assert.equal(capture.calls.length, 1);
		assert.equal(capture.calls[0]!.to, "+12345");
		assert.equal(capture.calls[0]!.media.kind, "image");
		assert.equal(capture.calls[0]!.media.path, imagePath);
		assert.equal(capture.calls[0]!.media.caption, "Here's the org chart.");
		assert.equal(capture.calls[0]!.media.mimeType, "image/png");
	});

	it("(7) infers kind:'document' from .pdf and surfaces fileName", async () => {
		const pdfPath = path.join(tmpDir, "report.pdf");
		writeFileSync(pdfPath, Buffer.from("%PDF-"));
		const { adapter, capture } = captureAdapter();
		mountStub({
			started: ["whatsapp"],
			adapter: () => adapter,
		});
		const tool = makeSendMediaTool();
		await tool.execute("call-1", {
			path: pdfPath,
			channel: "whatsapp",
			to: "+12345",
		} as never);
		assert.equal(capture.calls.length, 1);
		assert.equal(capture.calls[0]!.media.kind, "document");
		assert.equal(capture.calls[0]!.media.fileName, "report.pdf");
		assert.equal(capture.calls[0]!.media.mimeType, "application/pdf");
	});

	it("(8) refuses cleanly when kind cannot be inferred", async () => {
		const oddPath = path.join(tmpDir, "mystery.xyz");
		writeFileSync(oddPath, Buffer.from("data"));
		const { adapter } = captureAdapter();
		mountStub({
			started: ["whatsapp"],
			adapter: () => adapter,
		});
		const tool = makeSendMediaTool();
		const result = (await tool.execute("call-1", {
			path: oddPath,
			channel: "whatsapp",
			to: "+12345",
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		assert.match(JSON.stringify(result), /could not infer media kind/);
	});

	it("(9) auto-fills channel + to from channelContext", async () => {
		const { adapter, capture } = captureAdapter();
		mountStub({
			started: ["whatsapp"],
			adapter: () => adapter,
		});
		const tool = makeSendMediaTool({
			channelContext: {
				channelId: "whatsapp",
				conversationId: "+19999",
				accountId: "default",
			} as never,
		});
		await tool.execute("call-1", {
			path: imagePath,
		} as never);
		assert.equal(capture.calls.length, 1);
		assert.equal(capture.calls[0]!.to, "+19999");
	});

	it("(10) requires channel+to when no channelContext is available", async () => {
		mountStub({
			started: ["whatsapp"],
			adapter: () => captureAdapter().adapter,
		});
		const tool = makeSendMediaTool();
		const result = (await tool.execute("call-1", {
			path: imagePath,
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		assert.match(JSON.stringify(result), /both required/);
	});

	it("(11) is NOT blanket-ownerOnly — uses a narrower per-call gate so approved non-owner peers can receive media REPLIES to their own chat (the blanket flag would refuse every call from anyone other than the workspace owner; the narrow gate refuses only cross-conversation overrides)", () => {
		const tool = makeSendMediaTool();
		assert.notEqual(
			tool.ownerOnly,
			true,
			"send_media must NOT set ownerOnly:true — the session-wiring blanket wrap would refuse every approved-peer reply",
		);
	});

	it("(12) explicit kind overrides extension inference", async () => {
		const stickerPath = path.join(tmpDir, "sticker.webp");
		writeFileSync(stickerPath, Buffer.from("RIFF"));
		const { adapter, capture } = captureAdapter();
		mountStub({
			started: ["whatsapp"],
			adapter: () => adapter,
		});
		const tool = makeSendMediaTool();
		await tool.execute("call-1", {
			path: stickerPath,
			channel: "whatsapp",
			to: "+12345",
			kind: "sticker",
		} as never);
		assert.equal(capture.calls.length, 1);
		assert.equal(capture.calls[0]!.media.kind, "sticker");
	});

	it("(13) dispatch error returns a clean failure result", async () => {
		const { adapter, capture } = captureAdapter();
		adapter.sendMedia = async () => {
			throw new Error("network down");
		};
		mountStub({
			started: ["whatsapp"],
			adapter: () => adapter,
		});
		const tool = makeSendMediaTool();
		const result = (await tool.execute("call-1", {
			path: imagePath,
			channel: "whatsapp",
			to: "+12345",
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		assert.match(JSON.stringify(result), /network down/);
		assert.equal(capture.calls.length, 0);
	});

	it("(14) recovers when LLM submits a forward-slash path on Windows (or any native path with the other separator)", async () => {
		// The org tool now emits imagePath in posix form so LLMs can't
		// mangle backslashes. Verify send_media resolves it via the
		// variant-recovery shim regardless of native separator.
		const { adapter, capture } = captureAdapter();
		mountStub({
			started: ["whatsapp"],
			adapter: () => adapter,
		});
		const posixPath = imagePath.split(path.sep).join("/");
		const tool = makeSendMediaTool();
		const result = (await tool.execute("call-fwdslash", {
			path: posixPath,
			channel: "whatsapp",
			to: "+12345",
		} as never)) as { content: unknown[]; isError?: boolean };
		assert.notEqual(
			(result as { isError?: boolean }).isError,
			true,
			`forward-slash variant should resolve, got: ${JSON.stringify(result).slice(0, 200)}`,
		);
		assert.equal(capture.calls.length, 1);
	});

	it("(15) error message lists all variants tried so the LLM can self-correct", async () => {
		mountStub({
			started: ["whatsapp"],
			adapter: () => captureAdapter().adapter,
		});
		const tool = makeSendMediaTool();
		const ghost = path.join(tmpDir, "absolutely-nowhere.png");
		const result = (await tool.execute("call-1", {
			path: ghost,
			channel: "whatsapp",
			to: "+12345",
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		const text = JSON.stringify(result);
		// The error should mention what was tried + nudge toward
		// imagePath verbatim usage.
		assert.match(text, /Tried these path variants/);
		assert.match(text, /imagePath/i);
	});

	it("(16) non-owner reply-to-same-chat is ALLOWED (the friend-asks-org-chart use case)", async () => {
		const { adapter, capture } = captureAdapter();
		mountStub({
			started: ["whatsapp"],
			adapter: () => adapter,
		});
		// Approved-non-owner peer texts the bot. The bot's channel
		// context is THIS friend's conversation. send_media auto-fills
		// `to` from the context — it should NOT refuse just because
		// senderIsOwner is false.
		const tool = makeSendMediaTool({
			channelContext: {
				channelId: "whatsapp",
				conversationId: "+919999",
			} as never,
			senderIsOwner: false,
		});
		const result = (await tool.execute("call-1", {
			path: imagePath,
		} as never)) as { content: unknown[]; isError?: boolean };
		assert.notEqual(
			(result as { isError?: boolean }).isError,
			true,
			`reply-to-same-chat should succeed; got: ${JSON.stringify(result).slice(0, 300)}`,
		);
		assert.equal(capture.calls.length, 1);
		assert.equal(capture.calls[0]!.to, "+919999");
	});

	it("(17) non-owner cross-conversation send is REFUSED (don't let friends DM strangers)", async () => {
		mountStub({
			started: ["whatsapp"],
			adapter: () => captureAdapter().adapter,
		});
		const tool = makeSendMediaTool({
			channelContext: {
				channelId: "whatsapp",
				conversationId: "+919999",
			} as never,
			senderIsOwner: false,
		});
		// Friend tries to send media to a DIFFERENT number → must refuse.
		const result = (await tool.execute("call-1", {
			path: imagePath,
			channel: "whatsapp",
			to: "+12345678",
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		assert.match(JSON.stringify(result), /workspace-owner privilege/i);
	});

	it("(18) owner can send cross-conversation (default behaviour, full access)", async () => {
		const { adapter, capture } = captureAdapter();
		mountStub({
			started: ["whatsapp"],
			adapter: () => adapter,
		});
		const tool = makeSendMediaTool({
			channelContext: {
				channelId: "whatsapp",
				conversationId: "+919999",
			} as never,
			senderIsOwner: true, // owner-routed turn
		});
		// Owner sends to a totally different number — must succeed.
		const result = (await tool.execute("call-1", {
			path: imagePath,
			channel: "whatsapp",
			to: "+12345678",
		} as never)) as { content: unknown[]; isError?: boolean };
		assert.notEqual((result as { isError?: boolean }).isError, true);
		assert.equal(capture.calls.length, 1);
		assert.equal(capture.calls[0]!.to, "+12345678");
	});

	it("(19) non-owner without channelContext + explicit channel/to is REFUSED", async () => {
		mountStub({
			started: ["whatsapp"],
			adapter: () => captureAdapter().adapter,
		});
		// No channelContext, non-owner, explicit channel/to → refused.
		const tool = makeSendMediaTool({ senderIsOwner: false });
		const result = (await tool.execute("call-1", {
			path: imagePath,
			channel: "whatsapp",
			to: "+12345678",
		} as never)) as { content: unknown[]; isError?: boolean };
		assertFailed(result);
		assert.match(JSON.stringify(result), /workspace-owner privilege/i);
	});
});

// Sanity: getActiveChannelManager returns null between tests.
describe("send_media test harness sanity", () => {
	it("manager is null after clearStub", () => {
		clearStub();
		assert.equal(getActiveChannelManager(), null);
	});
});
