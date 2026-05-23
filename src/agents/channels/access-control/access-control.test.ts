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
	it("self always allowed regardless of policy", () => {
		for (const policy of ["pairing", "allowlist", "open", "disabled"] as const) {
			const r = evaluateAccess({ policy, senderId: "self@x", selfId: "self@x", allowFrom: [] });
			assert.equal(r.kind, "allow");
		}
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
