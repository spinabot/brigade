import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	createMonitorState,
	decideInbound,
	echoScope,
	detectIMessageMentions,
	detectReflectedContent,
	findCodeRegions,
	isInsideCode,
	normalizeHandle,
	normalizeIMessageMessage,
	parseIMessageNotification,
	stripLengthPrefixedText,
	SentMessageCache,
	type IMessagePayload,
} from "./monitor.js";

describe("parseIMessageNotification", () => {
	it("returns null for a malformed payload", () => {
		assert.equal(parseIMessageNotification(null), null);
		assert.equal(parseIMessageNotification({}), null);
		assert.equal(parseIMessageNotification({ message: 5 }), null);
	});

	it("shapes a valid payload + passes text through length-prefix strip", () => {
		const p = parseIMessageNotification({
			message: { sender: "+1555", text: "hi", chat_id: 7, is_from_me: false },
		});
		assert.ok(p);
		assert.equal(p?.sender, "+1555");
		assert.equal(p?.text, "hi");
		assert.equal(p?.chat_id, 7);
	});
});

describe("stripLengthPrefixedText", () => {
	it("returns plain text unchanged", () => {
		assert.equal(stripLengthPrefixedText("hello"), "hello");
	});

	it("unwraps a protobuf field-1 length-prefixed blob", () => {
		const inner = "hello world";
		const bytes = Buffer.from(inner, "utf8");
		const wrapped = Buffer.concat([Buffer.from([0x0a, bytes.length]), bytes]);
		assert.equal(stripLengthPrefixedText(wrapped.toString("utf8")), inner);
	});

	it("leaves a non-exact-length blob unchanged", () => {
		const inner = "hello";
		const bytes = Buffer.from(inner, "utf8");
		// Declared length is one short of the actual → not stripped.
		const wrapped = Buffer.concat([Buffer.from([0x0a, bytes.length - 1]), bytes]);
		assert.equal(stripLengthPrefixedText(wrapped.toString("utf8")), wrapped.toString("utf8"));
	});
});

describe("normalizeIMessageMessage", () => {
	it("builds a group conversation id from chat_id", () => {
		const n = normalizeIMessageMessage({ sender: "+1555", text: "hi", chat_id: 7, is_group: true });
		assert.equal(n.conversationId, "chat:7");
		assert.equal(n.isGroup, true);
		assert.equal(n.from, "+1555");
	});

	it("builds a DM conversation id from the sender", () => {
		const n = normalizeIMessageMessage({ sender: "+1555", text: "hi" });
		assert.equal(n.conversationId, "+1555");
		assert.equal(n.isGroup, false);
	});

	it("prefers guid as the messageId", () => {
		const n = normalizeIMessageMessage({ sender: "+1555", text: "hi", guid: "G-1", id: 3 });
		assert.equal(n.messageId, "G-1");
	});

	// Fix 2 — group requireMention: populate mentions[] when the bot's handle is named.
	it("populates mentions[] when a group message names the bot's selfHandle", () => {
		const n = normalizeIMessageMessage(
			{ sender: "+1999", text: "hey 15551234567 take a look", chat_id: 7, is_group: true },
			"15551234567",
		);
		assert.deepEqual(n.mentions, ["15551234567"]);
	});

	it("leaves mentions unset when a group message does NOT name the bot", () => {
		const n = normalizeIMessageMessage(
			{ sender: "+1999", text: "just chatting", chat_id: 7, is_group: true },
			"15551234567",
		);
		assert.equal(n.mentions, undefined);
	});

	it("never sets mentions for a DM even when the handle appears (DM unaffected)", () => {
		const n = normalizeIMessageMessage({ sender: "+1999", text: "ping 15551234567" }, "15551234567");
		assert.equal(n.isGroup, false);
		assert.equal(n.mentions, undefined);
	});

	it("decideInbound dispatches a group mention with mentions[] populated", () => {
		const state = createMonitorState();
		const d = decideInbound(state, "acct", { sender: "+1999", text: "yo 15551234567", chat_id: 9, is_group: true }, "15551234567");
		assert.equal(d.kind, "dispatch");
		if (d.kind === "dispatch") assert.deepEqual(d.message.mentions, ["15551234567"]);
	});
});

describe("detectReflectedContent", () => {
	it("flags a leaked thinking tag", () => {
		assert.equal(detectReflectedContent("<think>secret</think>").isReflection, true);
	});
	it("does not flag normal text", () => {
		assert.equal(detectReflectedContent("hello there").isReflection, false);
	});

	// Fix 1 — code-fence skip: a marker quoted INSIDE code is legit, not a reflection.
	it("does NOT flag a <final> tag inside a fenced code block", () => {
		const msg = "look at this snippet:\n```html\n<final>answer</final>\n```\nthoughts?";
		assert.equal(detectReflectedContent(msg).isReflection, false);
	});

	it("does NOT flag a #+#+ separator inside an inline code span", () => {
		assert.equal(detectReflectedContent("the delimiter `#+#+#` is internal").isReflection, false);
	});

	it("STILL flags a bare <final> reflection outside any code", () => {
		const out = detectReflectedContent("here is the <final>leaked answer</final> oops");
		assert.equal(out.isReflection, true);
		assert.ok(out.matchedLabels.includes("final-tag"));
	});

	it("flags when a marker appears both inside AND outside a fence (outside wins)", () => {
		const msg = "```\n<final>quoted</final>\n```\nand a real <final>leak</final>";
		assert.equal(detectReflectedContent(msg).isReflection, true);
	});
});

describe("findCodeRegions / isInsideCode", () => {
	it("locates a fenced block and reports a position inside it", () => {
		const text = "intro\n```\nsecret <final>\n```\ntail";
		const regions = findCodeRegions(text);
		assert.ok(regions.length >= 1);
		const finalIdx = text.indexOf("<final>");
		assert.equal(isInsideCode(finalIdx, regions), true);
		// The leading "intro" is outside code.
		assert.equal(isInsideCode(0, regions), false);
	});

	it("locates an inline code span", () => {
		const text = "use `<final>` here";
		const regions = findCodeRegions(text);
		const idx = text.indexOf("<final>");
		assert.equal(isInsideCode(idx, regions), true);
	});
});

describe("detectIMessageMentions", () => {
	it("matches a phone self-handle by digit-run (formatting-insensitive)", () => {
		assert.deepEqual(detectIMessageMentions("hey +1 (555) 123-4567 can you help", "15551234567"), ["15551234567"]);
	});
	it("matches an email self-handle case-insensitively", () => {
		assert.deepEqual(detectIMessageMentions("ping Bot@Example.com pls", "bot@example.com"), ["bot@example.com"]);
	});
	it("returns undefined when the handle is absent", () => {
		assert.equal(detectIMessageMentions("nobody here", "15551234567"), undefined);
	});
	it("returns undefined when no self-handle is configured", () => {
		assert.equal(detectIMessageMentions("anything", undefined), undefined);
	});
});

describe("SentMessageCache", () => {
	it("matches an inbound echo by text (within TTL)", () => {
		const cache = new SentMessageCache();
		cache.remember("acct:imessage:+1555", { text: "hello" });
		assert.equal(cache.has("acct:imessage:+1555", { text: "hello" }), true);
		assert.equal(cache.has("acct:imessage:+1555", { text: "different" }), false);
	});

	it("matches by message id", () => {
		const cache = new SentMessageCache();
		cache.remember("scope", { text: "x", messageId: "G-9" });
		assert.equal(cache.has("scope", { messageId: "G-9" }), true);
	});

	it("rejects junk ids (ok / unknown / empty)", () => {
		const cache = new SentMessageCache();
		cache.remember("scope", { text: "x", messageId: "ok" });
		assert.equal(cache.has("scope", { messageId: "ok" }), false);
	});
});

describe("decideInbound", () => {
	it("dispatches a normal inbound", () => {
		const state = createMonitorState();
		const payload: IMessagePayload = { sender: "+1555", text: "hi", is_from_me: false };
		const d = decideInbound(state, "acct", payload);
		assert.equal(d.kind, "dispatch");
	});

	it("drops a from-me message", () => {
		const state = createMonitorState();
		const d = decideInbound(state, "acct", { sender: "+1555", text: "hi", is_from_me: true });
		assert.equal(d.kind, "drop");
		if (d.kind === "drop") assert.equal(d.reason, "from me");
	});

	it("drops an empty body", () => {
		const state = createMonitorState();
		const d = decideInbound(state, "acct", { sender: "+1555", text: "   " });
		assert.equal(d.kind, "drop");
		if (d.kind === "drop") assert.equal(d.reason, "empty body");
	});

	it("drops the echo of a just-sent message", () => {
		const state = createMonitorState();
		// The connection would remember an outbound under the DM scope.
		state.sentMessageCache.remember("acct:imessage:+1555", { text: "the answer", messageId: "G-1" });
		const d = decideInbound(state, "acct", { sender: "+1555", text: "the answer", guid: "G-1" });
		assert.equal(d.kind, "drop");
		if (d.kind === "drop") assert.equal(d.reason, "echo");
	});

	it("drops reflected assistant content", () => {
		const state = createMonitorState();
		const d = decideInbound(state, "acct", { sender: "+1555", text: "look <final>answer</final>" });
		assert.equal(d.kind, "drop");
		if (d.kind === "drop") assert.equal(d.reason, "reflected assistant content");
	});

	it("rate-limits a conversation after repeated loop drops", () => {
		const state = createMonitorState();
		// Five echo drops feed the loop limiter.
		for (let i = 0; i < 5; i++) {
			state.sentMessageCache.remember("acct:imessage:+1555", { text: `m${i}`, messageId: `G${i}` });
			decideInbound(state, "acct", { sender: "+1555", text: `m${i}`, guid: `G${i}` });
		}
		// A fresh real message is now suppressed by the rate limiter.
		const d = decideInbound(state, "acct", { sender: "+1555", text: "a real new message" });
		assert.equal(d.kind, "drop");
		if (d.kind === "drop") assert.equal(d.reason, "loop rate-limited");
	});
});

/* ─────────────────────────────────────────────────────────────────────────
 * Messaging your own Apple ID is the most obvious way to try this channel,
 * and it was the one that silently did not work.
 *
 * In a self-thread EVERY row is `is_from_me=true` — the operator's replies
 * included — and the Messages DB frequently leaves `destination_caller_id`
 * empty. The "ambiguous self" branch then dropped unconditionally, so a reply
 * typed in Messages.app was discarded before it reached the agent. The
 * operator sees it delivered and read, and Brigade never answers.
 * ───────────────────────────────────────────────────────────────────────── */

describe("decideInbound — self-thread with no destination_caller_id", () => {
	const selfChatPayload = (text: string) => ({
		id: 1,
		guid: `guid-${text}`,
		sender: "me@example.com",
		chat_identifier: "me@example.com",
		// The case that broke it: the DB did not populate this.
		destination_caller_id: undefined,
		is_from_me: true,
		is_group: false,
		text,
		created_at: new Date().toISOString(),
	});

	it("dispatches the operator's own reply instead of dropping it", () => {
		const state = createMonitorState();
		const d = decideInbound(state, "default", selfChatPayload("hey are you there"));
		assert.equal(d.kind, "dispatch", `expected dispatch, got ${d.kind}: ${(d as { reason?: string }).reason}`);
	});

	it("still drops Brigade's OWN send, via the echo cache", () => {
		// The discriminator that makes the above safe: what Brigade sent is in
		// the sent cache; what the operator typed is not.
		const state = createMonitorState();
		const text = "Hey — Brigade here, iMessage channel is live.";
		const payload = selfChatPayload(text);
		state.sentMessageCache.remember(echoScope("default", payload), { text, messageId: "1" });
		const d = decideInbound(state, "default", payload);
		assert.equal(d.kind, "drop");
		assert.match((d as { reason: string }).reason, /echo/);
	});

	it("a configured selfHandle resolves the ambiguity outright", () => {
		// With the bot's own handle known, the thread is a DEFINITE self-chat
		// and no longer depends on the DB populating a field it often omits.
		const state = createMonitorState();
		const d = decideInbound(state, "default", selfChatPayload("ping"), "me@example.com");
		assert.equal(d.kind, "dispatch");
	});

	it("a normal inbound DM from someone else is unaffected", () => {
		const state = createMonitorState();
		const d = decideInbound(state, "default", {
			id: 2,
			guid: "guid-other",
			sender: "friend@example.com",
			chat_identifier: "friend@example.com",
			is_from_me: false,
			is_group: false,
			text: "hello",
			created_at: new Date().toISOString(),
		});
		assert.equal(d.kind, "dispatch");
	});

	it("an outbound message to SOMEONE ELSE is still dropped as from-me", () => {
		// The guard that must not be weakened: Brigade replying to a friend must
		// not be re-ingested as if the friend had said it.
		const state = createMonitorState();
		const d = decideInbound(state, "default", {
			id: 3,
			guid: "guid-out",
			sender: "me@example.com",
			chat_identifier: "friend@example.com",
			is_from_me: true,
			is_group: false,
			text: "sent by the agent",
			created_at: new Date().toISOString(),
		});
		assert.equal(d.kind, "drop");
		assert.match((d as { reason: string }).reason, /from me/);
	});
});

/* ─────────────────────────────────────────────────────────────────────────
 * The echo scope must agree across inbound and outbound, or Brigade
 * re-ingests its own message.
 *
 * Inbound takes the handle from the Messages DB; outbound from whatever the
 * caller addressed. The two spell the same person differently routinely —
 * casing on an Apple ID, punctuation on a phone number — and an unnormalised
 * key means the echo is never found. That is a live loop risk, not cosmetic:
 * the self-thread path now DISPATCHES anything the cache does not recognise.
 * ───────────────────────────────────────────────────────────────────────── */

describe("normalizeHandle / echoScope agreement", () => {
	it("an Apple ID matches regardless of casing", () => {
		assert.equal(normalizeHandle("Bhasvanth02@Gmail.com"), normalizeHandle("bhasvanth02@gmail.com"));
	});

	it("a phone number matches regardless of punctuation", () => {
		const canonical = normalizeHandle("+16464201739");
		assert.equal(normalizeHandle("+1 (646) 420-1739"), canonical);
		assert.equal(normalizeHandle("+1-646-420-1739"), canonical);
		assert.equal(normalizeHandle(" +1 646 420 1739 "), canonical);
	});

	it("the inbound scope matches an outbound scope built from the same handle", () => {
		// The exact pairing the echo suppression depends on.
		const inbound = echoScope("default", { sender: "Bhasvanth02@Gmail.com" });
		const outbound = `default:imessage:${normalizeHandle("bhasvanth02@gmail.com")}`;
		assert.equal(inbound, outbound);
	});

	it("different people never collide", () => {
		assert.notEqual(normalizeHandle("a@example.com"), normalizeHandle("b@example.com"));
		assert.notEqual(normalizeHandle("+16464201739"), normalizeHandle("+16464201730"));
	});

	it("an unrecognised address is passed through, not mangled", () => {
		assert.equal(normalizeHandle("  Some.Odd_Handle  "), "some.odd_handle");
		assert.equal(normalizeHandle(""), "");
		assert.equal(normalizeHandle(undefined), "");
	});

	it("a group chat still keys on chat_id, not the handle", () => {
		assert.equal(echoScope("default", { chat_id: 21, sender: "whoever" }), "default:chat_id:21");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// `chat_id` is the conversation's row id — every thread has one, DMs
// included — so treating it as proof of a group put ordinary DMs behind the
// group requireMention gate and the group allow-list.
// ─────────────────────────────────────────────────────────────────────────
describe("normalizeIMessageMessage — group classification", () => {
	it("a DM carrying a chat_id is still a DM", () => {
		const out = normalizeIMessageMessage({
			sender: "+15551234567",
			text: "hi",
			chat_id: 7,
			is_group: false,
		});
		assert.equal(out.isGroup, false);
		assert.equal(out.chatId, 7, "the chat id is still carried through");
	});

	it("an explicit is_group:true is a group", () => {
		assert.equal(
			normalizeIMessageMessage({ sender: "+1555", text: "hi", chat_id: 7, is_group: true }).isGroup,
			true,
		);
	});

	it("falls back to participant count when is_group is absent", () => {
		assert.equal(
			normalizeIMessageMessage({ sender: "+1555", text: "hi", participants: ["+1555", "+1666"] })
				.isGroup,
			true,
		);
		assert.equal(
			normalizeIMessageMessage({ sender: "+1555", text: "hi", participants: ["+1555"] }).isGroup,
			false,
		);
		assert.equal(normalizeIMessageMessage({ sender: "+1555", text: "hi", chat_id: 9 }).isGroup, false);
	});
});
