import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	formatIMessageChatTarget,
	inferIMessageTargetChatType,
	isAllowedIMessageSender,
	normalizeIMessageAclEntry,
	normalizeE164,
	normalizeIMessageHandle,
	parseIMessageAllowTarget,
	parseIMessageTarget,
} from "./targets.js";

describe("parseIMessageTarget", () => {
	it("parses a bare phone handle to service auto", () => {
		const t = parseIMessageTarget("+15551234567");
		assert.equal(t.kind, "handle");
		if (t.kind === "handle") {
			assert.equal(t.to, "+15551234567");
			assert.equal(t.service, "auto");
		}
	});

	it("parses a service-prefixed handle keeping the service", () => {
		const t = parseIMessageTarget("sms:+15551234567");
		assert.equal(t.kind, "handle");
		if (t.kind === "handle") {
			assert.equal(t.to, "+15551234567");
			assert.equal(t.service, "sms");
		}
	});

	it("parses chat_id to a numeric target", () => {
		const t = parseIMessageTarget("chat_id:42");
		assert.equal(t.kind, "chat_id");
		if (t.kind === "chat_id") assert.equal(t.chatId, 42);
	});

	it("parses chat_guid + chat_identifier preserving case", () => {
		const g = parseIMessageTarget("chat_guid:ABC-123");
		assert.equal(g.kind, "chat_guid");
		if (g.kind === "chat_guid") assert.equal(g.chatGuid, "ABC-123");
		const i = parseIMessageTarget("chat_identifier:iMessage;-;+1555");
		assert.equal(i.kind, "chat_identifier");
		if (i.kind === "chat_identifier") assert.equal(i.chatIdentifier, "iMessage;-;+1555");
	});

	it("parses a service-prefixed chat target", () => {
		const t = parseIMessageTarget("imessage:chat_id:7");
		assert.equal(t.kind, "chat_id");
		if (t.kind === "chat_id") assert.equal(t.chatId, 7);
	});

	it("throws on an empty target", () => {
		assert.throws(() => parseIMessageTarget(""), /target is required/);
	});

	it("throws on a malformed chat_id (strict)", () => {
		assert.throws(() => parseIMessageTarget("chat_id:notanumber"), /Invalid chat_id/);
	});
});

describe("normalizeIMessageHandle", () => {
	it("lowercases an email handle", () => {
		assert.equal(normalizeIMessageHandle("User@Example.COM"), "user@example.com");
	});

	it("E.164-normalizes a phone", () => {
		assert.equal(normalizeIMessageHandle("(555) 123-4567"), "+5551234567");
		assert.equal(normalizeIMessageHandle("+1 555 123 4567"), "+15551234567");
	});

	it("strips a service prefix before normalizing", () => {
		assert.equal(normalizeIMessageHandle("imessage:User@Example.com"), "user@example.com");
	});

	it("keeps a chat prefix (prefix lowercased, value verbatim)", () => {
		assert.equal(normalizeIMessageHandle("CHAT_GUID:ABC-1"), "chat_guid:ABC-1");
	});
});

describe("normalizeE164", () => {
	it("prepends + when missing", () => {
		assert.equal(normalizeE164("5551234567"), "+5551234567");
	});
	it("strips a scheme prefix", () => {
		assert.equal(normalizeE164("tel:+15551234567"), "+15551234567");
	});
});

describe("parseIMessageAllowTarget (lenient)", () => {
	it("skips a malformed chat_id rather than throwing → normalized handle", () => {
		const t = parseIMessageAllowTarget("chat_id:nope");
		assert.equal(t.kind, "handle");
	});
	it("parses a valid chat_id", () => {
		const t = parseIMessageAllowTarget("chat_id:9");
		assert.equal(t.kind, "chat_id");
		if (t.kind === "chat_id") assert.equal(t.chatId, 9);
	});
});

describe("isAllowedIMessageSender", () => {
	it("matches a normalized handle entry", () => {
		assert.equal(
			isAllowedIMessageSender({ allowFrom: ["+15551234567"], sender: "+1 (555) 123-4567" }),
			true,
		);
	});
	it("matches a chat_id entry by id", () => {
		assert.equal(isAllowedIMessageSender({ allowFrom: ["chat_id:42"], sender: "x", chatId: 42 }), true);
	});
	it("honours the wildcard", () => {
		assert.equal(isAllowedIMessageSender({ allowFrom: ["*"], sender: "anyone" }), true);
	});
	it("returns false on an empty list", () => {
		assert.equal(isAllowedIMessageSender({ allowFrom: [], sender: "x" }), false);
	});
});

describe("formatIMessageChatTarget + inferIMessageTargetChatType", () => {
	it("formats a numeric chat id", () => {
		assert.equal(formatIMessageChatTarget(5), "chat_id:5");
		assert.equal(formatIMessageChatTarget(undefined), "");
	});
	it("infers dm vs group", () => {
		assert.equal(inferIMessageTargetChatType("+15551234567"), "dm");
		assert.equal(inferIMessageTargetChatType("chat_id:5"), "group");
	});
});

/* ─────────────────────────────────────────────────────────────────────────
 * A name must never become a phone number.
 *
 * `normalizeE164` stripped every non-digit and prepended `+`, so it never
 * decided whether the input WAS a phone number — it manufactured one.
 * `"Line 2"` became `"+2"`, and a private conversation went to whoever
 * answers at that number. Sending to the wrong recipient is the worst outcome
 * this channel has, and it took one plausible typo.
 * ───────────────────────────────────────────────────────────────────────── */

describe("normalizeE164 — refuses to invent a number", () => {
	it("a contact-ish name with a stray digit is NOT a phone number", () => {
		assert.equal(normalizeE164("Line 2"), "");
		assert.equal(normalizeE164("Room 101"), "");
		assert.equal(normalizeE164("Mum"), "");
	});

	it("a NAME containing a full-length digit run is still refused", () => {
		// The case only the letter check catches: the digit-count guard is
		// satisfied, so without it this becomes a real, dialable number
		// belonging to a stranger. "call 5551234567 for support" in a contact
		// field is the shape that reaches here.
		assert.equal(normalizeE164("Room 5551234567"), "");
		assert.equal(normalizeE164("call 5551234567"), "");
		assert.equal(normalizeE164("Support x16464201739"), "");
	});

	it("a digit fragment is refused rather than prefixed", () => {
		// A fragment with a `+` in front is a real number belonging to someone.
		assert.equal(normalizeE164("2"), "");
		assert.equal(normalizeE164("12345"), "");
	});

	it("an over-long digit run is refused", () => {
		// E.164 caps at 15 digits; longer is an id, an order number, anything.
		assert.equal(normalizeE164("12345678901234567890"), "");
	});

	it("genuine numbers still normalise", () => {
		assert.equal(normalizeE164("+1 (646) 420-1739"), "+16464201739");
		assert.equal(normalizeE164("+16464201739"), "+16464201739");
		assert.equal(normalizeE164("555-123-4567"), "+5551234567");
	});

	it("an email is not a phone number", () => {
		assert.equal(normalizeE164("me@example.com"), "");
	});

	it("a handle that is not a phone falls through intact", () => {
		// The caller treats "" as "try the other handle shapes", so a name must
		// survive normalisation rather than being mangled into a number.
		assert.equal(normalizeIMessageHandle("Line 2"), "Line2");
		assert.equal(normalizeIMessageHandle("me@Example.com"), "me@example.com");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// The allow-list spelling gap.
//
// `evaluateAccess` matches by exact string equality — correct, and only safe
// when both sides are spelled the same way. iMessage delivers whatever the
// chat database stores while the operator types what the wizard showed them,
// so the two sides disagreed and listed senders were refused. These pin the
// canonicalisation that closes the gap without loosening the comparison.
// ─────────────────────────────────────────────────────────────────────────
describe("iMessage allow-list canonicalisation", () => {
	const norm = normalizeIMessageAclEntry;

	it("a punctuated phone and the stored form canonicalise to one string", () => {
		assert.equal(norm("+1 (555) 123-4567"), normalizeIMessageHandle("+15551234567"));
	});

	it("email case does not decide access", () => {
		assert.equal(norm("User@Example.com"), normalizeIMessageHandle("user@example.com"));
	});

	it("every chat_id spelling the parser accepts lands on one form", () => {
		assert.equal(norm("chat_id:42"), "chat_id:42");
		assert.equal(norm("chatid: 42"), "chat_id:42");
		assert.equal(norm("chat:42"), "chat_id:42");
	});

	it("does NOT collapse two different identities onto one entry", () => {
		// The whole reason matching stays exact. If canonicalisation ever mapped
		// distinct people to the same string it would widen the allow-list
		// silently, which is worse than the bug it fixes.
		assert.notEqual(norm("+15551234567"), norm("+15559999999"));
		assert.notEqual(norm("a@example.com"), norm("b@example.com"));
		assert.notEqual(norm("chat_id:42"), norm("chat_id:43"));
	});
});
