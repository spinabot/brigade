import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveChannelAllowFromPath, resolveChannelPairingPath } from "../../../config/paths.js";
import { evaluateAccess } from "./policy.js";
import {
	PAIRING_MAX_PENDING,
	PAIRING_TTL_MS,
	addAllowFrom,
	approvePairingCode,
	isAllowed,
	readAllowFrom,
	readPendingPairings,
	removeAllowFrom,
	revokePairingCode,
	upsertPairingRequest,
} from "./store.js";

// Redirect ~/.brigade to a tempdir so the real ~/.brigade is never touched.
let tmpRoot: string;
let prevStateDir: string | undefined;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "brigade-acl-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = tmpRoot;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(tmpRoot, { recursive: true, force: true });
});

/* ──────────────────────────── policy ──────────────────────────── */

describe("evaluateAccess", () => {
	it("self always allowed in DMs regardless of DM policy", () => {
		for (const policy of ["pairing", "allowlist", "open", "disabled"] as const) {
			const r = evaluateAccess({ policy, senderId: "self@x", selfId: "self@x", allowFrom: [] });
			assert.equal(r.kind, "allow", `policy=${policy} should allow self in a DM`);
		}
	});

	/* ── self-in-GROUP: default-deny — the operator is NOT auto-allowed ── */

	it("self in a non-allowlisted GROUP is BLOCKED (operator typing in a group must not summon Brigade)", () => {
		// The operator (self) is NOT implicitly allow-listed in groups. A group
		// the operator hasn't opted in — via groupAllowJids (full-trust) or by
		// appearing on the group allow-from list — stays silent, even to the
		// operator's own messages. Reason is `not-allowlisted`: the GROUP isn't in.
		const r = evaluateAccess({
			policy: "pairing",
			groupPolicy: "allowlist",
			senderId: "+15551234567",
			selfId: "+15551234567",
			isGroup: true,
			mentioned: false,
			allowFrom: [],
			groupAllowFrom: [],
		});
		assert.equal(r.kind, "block");
		assert.match(String(r.reason), /^group:not-allowlisted$/);
	});

	it("self in a non-allowlisted GROUP is BLOCKED even WITH a self-tag (tagging your own number is not a backdoor)", () => {
		// A self-tag is just a mention of the operator's own number — which IS the
		// bot's id. It must NOT let the operator summon Brigade in a group they
		// haven't allowlisted. Same `not-allowlisted` block as an untagged message.
		const r = evaluateAccess({
			policy: "pairing",
			groupPolicy: "allowlist",
			senderId: "+15551234567",
			selfId: "+15551234567",
			isGroup: true,
			mentioned: true,
			allowFrom: [],
			groupAllowFrom: [],
		});
		assert.equal(r.kind, "block");
		assert.match(String(r.reason), /^group:not-allowlisted$/);
	});

	it("self is NOT implicitly allow-listed in a group — another sender being listed doesn't help the operator", () => {
		// The operator's own number is NOT auto-qualified in groups. With the
		// group off groupAllowJids and someone ELSE on groupAllowFrom, the operator
		// gets the same `not-allowlisted` block as anyone uninvited.
		const r = evaluateAccess({
			policy: "pairing",
			groupPolicy: "allowlist",
			senderId: "+15551234567",
			selfId: "+15551234567",
			isGroup: true,
			mentioned: true,
			allowFrom: [],
			groupAllowFrom: ["+19998887777"], // someone else, not the operator
		});
		assert.equal(r.kind, "block");
		assert.match(String(r.reason), /^group:not-allowlisted$/);
	});

	/* ── the operator's two opt-in paths still work ── */

	it("self in a JID-allowlisted group is allowed untagged (the operator's group opt-in)", () => {
		const r = evaluateAccess({
			policy: "pairing",
			groupPolicy: "allowlist",
			senderId: "+15551234567",
			selfId: "+15551234567",
			isGroup: true,
			mentioned: false,
			allowFrom: [],
			groupAllowFrom: [],
			groupId: "120363000000000000@g.us",
			groupAllowJids: ["120363000000000000@g.us"],
		});
		assert.equal(r.kind, "allow");
		assert.match(String(r.reason), /^group:jid-allowlisted$/);
	});

	it("self ON the group allow-from list + mention is allowed (the explicit-sender opt-in)", () => {
		const r = evaluateAccess({
			policy: "pairing",
			groupPolicy: "allowlist",
			senderId: "+15551234567",
			selfId: "+15551234567",
			isGroup: true,
			mentioned: true,
			allowFrom: [],
			groupAllowFrom: ["+15551234567"], // operator explicitly listed
		});
		assert.equal(r.kind, "allow");
		assert.match(String(r.reason), /^group:self\+mention$/);
	});

	it("self in a `open` group still requires a mention (matches general open-group rule)", () => {
		const r = evaluateAccess({
			policy: "open",
			groupPolicy: "open",
			senderId: "+15551234567",
			selfId: "+15551234567",
			isGroup: true,
			mentioned: false,
			allowFrom: [],
		});
		assert.equal(r.kind, "block");
		assert.match(String(r.reason), /^group:open-without-mention$/);
	});

	it("`open` policy allows any sender", () => {
		assert.equal(evaluateAccess({ policy: "open", senderId: "x", allowFrom: [] }).kind, "allow");
	});

	it("`disabled` policy blocks every DM (no challenge, no reply)", () => {
		assert.equal(evaluateAccess({ policy: "disabled", senderId: "x", allowFrom: ["x"] }).kind, "block");
	});

	it("`allowlist` allows listed senders, blocks the rest", () => {
		assert.equal(evaluateAccess({ policy: "allowlist", senderId: "x", allowFrom: ["x"] }).kind, "allow");
		assert.equal(evaluateAccess({ policy: "allowlist", senderId: "y", allowFrom: ["x"] }).kind, "block");
	});

	it("`pairing` allows listed senders and challenges everyone else", () => {
		assert.equal(evaluateAccess({ policy: "pairing", senderId: "x", allowFrom: ["x"] }).kind, "allow");
		assert.equal(evaluateAccess({ policy: "pairing", senderId: "y", allowFrom: ["x"] }).kind, "challenge");
	});

	/* ── wildcard `*` support (mirrors upstream isSenderAllowed) ── */

	it("`*` wildcard in allowFrom matches every sender in `allowlist` mode", () => {
		assert.equal(evaluateAccess({ policy: "allowlist", senderId: "anyone", allowFrom: ["*"] }).kind, "allow");
		assert.equal(evaluateAccess({ policy: "allowlist", senderId: "+15551234567", allowFrom: ["*"] }).kind, "allow");
	});

	it("`*` wildcard in `pairing` mode short-circuits the challenge (no codes for anyone)", () => {
		const r = evaluateAccess({ policy: "pairing", senderId: "+15551234567", allowFrom: ["*"] });
		assert.equal(r.kind, "allow", "wildcard means no pairing challenge needed");
		assert.match(String(r.reason), /^allow-from$/);
	});

	it("`*` wildcard works alongside explicit entries (no special ordering required)", () => {
		assert.equal(
			evaluateAccess({ policy: "allowlist", senderId: "newcomer", allowFrom: ["alice", "*"] }).kind,
			"allow",
		);
	});

	it("a literal '*' sender id is NOT auto-allowed unless the list itself contains `*`", () => {
		// Defence-in-depth: the wildcard semantics are LIST-side, not sender-
		// side. A peer with a literal id of "*" still has to be explicitly
		// listed (and wouldn't be — provider ids never look like this).
		assert.equal(
			evaluateAccess({ policy: "allowlist", senderId: "*", allowFrom: ["alice"] }).kind,
			"block",
		);
	});

	it("`*` wildcard in groupAllowFrom matches every group sender (still mention-gated)", () => {
		const withMention = evaluateAccess({
			policy: "pairing",
			groupPolicy: "allowlist",
			senderId: "stranger",
			isGroup: true,
			mentioned: true,
			allowFrom: [],
			groupAllowFrom: ["*"],
		});
		assert.equal(withMention.kind, "allow");
		const noMention = evaluateAccess({
			policy: "pairing",
			groupPolicy: "allowlist",
			senderId: "stranger",
			isGroup: true,
			mentioned: false,
			allowFrom: [],
			groupAllowFrom: ["*"],
		});
		assert.equal(noMention.kind, "block", "wildcard doesn't bypass the mention requirement");
		assert.match(String(noMention.reason), /^group:allow-from-without-mention$/);
	});

	it("a JID-allowlisted group is FULLY TRUSTED — responds untagged, any sender", () => {
		const r = evaluateAccess({
			policy: "pairing",
			groupPolicy: "allowlist",
			senderId: "stranger",
			isGroup: true,
			mentioned: false, // no mention…
			allowFrom: [],
			groupAllowFrom: [], // …and not on the sender list…
			groupId: "120363000000000000@g.us",
			groupAllowJids: ["120363000000000000@g.us"], // …but the GROUP is opted in
		});
		assert.equal(r.kind, "allow");
		assert.match(String(r.reason), /^group:jid-allowlisted$/);
	});

	it("a group NOT on the JID allow-list is unaffected (still mention+sender gated)", () => {
		const r = evaluateAccess({
			policy: "pairing",
			groupPolicy: "allowlist",
			senderId: "stranger",
			isGroup: true,
			mentioned: false,
			allowFrom: [],
			groupAllowFrom: [],
			groupId: "999@g.us",
			groupAllowJids: ["120363000000000000@g.us"], // a DIFFERENT group
		});
		assert.equal(r.kind, "block");
		assert.match(String(r.reason), /^group:not-allowlisted$/);
	});

	it("`*` in groupAllowJids trusts every group (untagged)", () => {
		const r = evaluateAccess({
			policy: "allowlist",
			groupPolicy: "allowlist",
			senderId: "stranger",
			isGroup: true,
			mentioned: false,
			allowFrom: [],
			groupAllowFrom: [],
			groupId: "any@g.us",
			groupAllowJids: ["*"],
		});
		assert.equal(r.kind, "allow");
		assert.match(String(r.reason), /^group:jid-allowlisted$/);
	});

	it("`disabled` group policy still wins over a JID allow-list", () => {
		const r = evaluateAccess({
			policy: "open",
			groupPolicy: "disabled",
			senderId: "stranger",
			isGroup: true,
			mentioned: false,
			allowFrom: [],
			groupAllowFrom: [],
			groupId: "g@g.us",
			groupAllowJids: ["g@g.us"],
		});
		assert.equal(r.kind, "block");
		assert.match(String(r.reason), /^group:disabled$/);
	});

	it("`addressed` (reply-to-bot / follow-up window) admits an allow-listed sender untagged", () => {
		const r = evaluateAccess({
			policy: "allowlist",
			groupPolicy: "allowlist",
			senderId: "+15551230000",
			isGroup: true,
			mentioned: false, // not tagged this message…
			addressed: true, // …but addressed (reply-to-bot / within window)
			allowFrom: [],
			groupAllowFrom: ["+15551230000"],
		});
		assert.equal(r.kind, "allow");
		assert.match(String(r.reason), /^group:allow-from\+mention$/);
	});

	it("`addressed:false` keeps the group silent (still requires addressing)", () => {
		const r = evaluateAccess({
			policy: "allowlist",
			groupPolicy: "allowlist",
			senderId: "+15551230000",
			isGroup: true,
			mentioned: false,
			addressed: false,
			allowFrom: [],
			groupAllowFrom: ["+15551230000"],
		});
		assert.equal(r.kind, "block");
		assert.match(String(r.reason), /^group:allow-from-without-mention$/);
	});

	it("`addressed` in an `open` group admits untagged", () => {
		const r = evaluateAccess({
			policy: "open",
			groupPolicy: "open",
			senderId: "stranger",
			isGroup: true,
			mentioned: false,
			addressed: true,
			allowFrom: [],
			groupAllowFrom: [],
		});
		assert.equal(r.kind, "allow");
		assert.match(String(r.reason), /^group:open\+mention$/);
	});
});

/* ──────────────────────────── store: allow-from ──────────────────────────── */

describe("allow-from store", () => {
	it("starts empty + add/remove/list round-trip", () => {
		assert.deepEqual(readAllowFrom("wa"), []);
		assert.equal(addAllowFrom("wa", "alice"), true);
		assert.equal(addAllowFrom("wa", "alice"), false); // idempotent
		assert.equal(addAllowFrom("wa", "bob"), true);
		assert.deepEqual(readAllowFrom("wa").sort(), ["alice", "bob"]);
		assert.equal(isAllowed("wa", "alice"), true);
		assert.equal(isAllowed("wa", "carol"), false);
		assert.equal(removeAllowFrom("wa", "alice"), true);
		assert.equal(removeAllowFrom("wa", "alice"), false);
		assert.deepEqual(readAllowFrom("wa"), ["bob"]);
	});

	it("writes a stable, valid JSON file", () => {
		addAllowFrom("wa", "alice");
		const raw = readFileSync(resolveChannelAllowFromPath("wa"), "utf8");
		const parsed = JSON.parse(raw) as { version: number; allowFrom: string[] };
		assert.equal(parsed.version, 1);
		assert.deepEqual(parsed.allowFrom, ["alice"]);
	});

	it("survives a corrupt allow-from.json without crashing", () => {
		const p = resolveChannelAllowFromPath("wa");
		mkdirSync(path.dirname(p), { recursive: true });
		writeFileSync(p, "this is not json");
		assert.deepEqual(readAllowFrom("wa"), []); // logged + defaults to empty
	});
});

/* ──────────────────────────── store: pairing codes ──────────────────────────── */

describe("pairing store", () => {
	it("issues a fresh 8-char code; re-emits the same code for the same sender", () => {
		const first = upsertPairingRequest({ channelId: "wa", senderId: "alice" });
		assert.match(first.code, /^[A-Z2-9]{8}$/);
		assert.equal(first.isNew, true);
		const again = upsertPairingRequest({ channelId: "wa", senderId: "alice" });
		assert.equal(again.code, first.code);
		assert.equal(again.isNew, false); // refresh, not a new code
	});

	it("issues distinct codes to distinct senders", () => {
		const a = upsertPairingRequest({ channelId: "wa", senderId: "alice" }).code;
		const b = upsertPairingRequest({ channelId: "wa", senderId: "bob" }).code;
		assert.notEqual(a, b);
	});

	it(`evicts oldest when more than ${PAIRING_MAX_PENDING} are pending`, () => {
		const ids = ["s1", "s2", "s3", "s4"]; // 4 > max
		for (const id of ids) upsertPairingRequest({ channelId: "wa", senderId: id });
		const pending = readPendingPairings("wa");
		assert.equal(pending.length, PAIRING_MAX_PENDING);
		// The OLDEST sender (s1) should be evicted.
		assert.ok(!pending.some((p) => p.senderId === "s1"));
	});

	it("prunes expired requests on read (TTL constant exposed for tests)", () => {
		// Sanity: the TTL is a positive finite number we can reason about.
		assert.ok(PAIRING_TTL_MS > 0 && Number.isFinite(PAIRING_TTL_MS));
		const { code } = upsertPairingRequest({ channelId: "wa", senderId: "alice" });
		// Hand-edit the file to backdate the request beyond TTL.
		const filePath = resolveChannelPairingPath("wa");
		const data = JSON.parse(readFileSync(filePath, "utf8")) as { requests: { createdAt: string; lastSeenAt: string }[] };
		const longAgo = new Date(Date.now() - PAIRING_TTL_MS - 1000).toISOString();
		for (const r of data.requests) {
			r.createdAt = longAgo;
			r.lastSeenAt = longAgo;
		}
		writeFileSync(filePath, JSON.stringify(data));
		assert.deepEqual(readPendingPairings("wa"), []); // expired → swept
		assert.equal(approvePairingCode("wa", code), null); // no longer approvable
	});

	it("approve moves the sender from pending → allow-from (case-insensitive code)", () => {
		const { code } = upsertPairingRequest({ channelId: "wa", senderId: "alice", senderName: "Alice" });
		// Operator types the code case-insensitively, maybe with dashes.
		const approved = approvePairingCode("wa", code.toLowerCase().replace(/(.{4})/, "$1-"));
		assert.ok(approved);
		assert.equal(approved?.senderId, "alice");
		assert.deepEqual(readAllowFrom("wa"), ["alice"]);
		assert.deepEqual(readPendingPairings("wa"), []);
		// A second approval of the same code must fail (already redeemed).
		assert.equal(approvePairingCode("wa", code), null);
	});

	it("revoke drops a pending code without granting access", () => {
		const { code } = upsertPairingRequest({ channelId: "wa", senderId: "alice" });
		assert.equal(revokePairingCode("wa", code), true);
		assert.deepEqual(readPendingPairings("wa"), []);
		assert.deepEqual(readAllowFrom("wa"), []);
		assert.equal(revokePairingCode("wa", code), false); // gone
	});
});
