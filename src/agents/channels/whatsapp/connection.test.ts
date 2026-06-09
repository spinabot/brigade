/**
 * Unit tests for the pure helpers in `connection.ts`. The Baileys-bound code
 * (socket lifecycle, reconnect controller, message decoding) is covered by
 * higher-level integration paths (gateway + manager); here we lock the
 * deterministic helpers that gate the rest of the inbound pipeline.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { canonicalWhatsAppId, isWaCryptoError, resolveJidToE164, resolveSenderIdentity } from "./connection.js";

describe("canonicalWhatsAppId", () => {
	it("returns empty for null/undefined/empty inputs", () => {
		assert.equal(canonicalWhatsAppId(null), "");
		assert.equal(canonicalWhatsAppId(undefined), "");
		assert.equal(canonicalWhatsAppId(""), "");
	});

	it("extracts digits from a standard E.164 jid", () => {
		assert.equal(canonicalWhatsAppId("15551234567@s.whatsapp.net"), "15551234567");
	});

	it("strips the device-id `:N` participant suffix", () => {
		assert.equal(canonicalWhatsAppId("15551234567:1@s.whatsapp.net"), "15551234567");
		assert.equal(canonicalWhatsAppId("447700900123:42@s.whatsapp.net"), "447700900123");
	});

	it("handles a raw E.164 input the user typed", () => {
		assert.equal(canonicalWhatsAppId("+1 555 123-4567"), "15551234567");
		assert.equal(canonicalWhatsAppId("447700900123"), "447700900123");
	});

	it("preserves digits on an `@hosted` jid (Baileys hosted variant)", () => {
		assert.equal(canonicalWhatsAppId("15551234567@hosted"), "15551234567");
	});

	it("note: returns LID digits on LID-suffixed jids — caller MUST drop these via resolveJidToE164", () => {
		// canonicalWhatsAppId is naive — it strips suffix and keeps digits. LID
		// digits are NOT a phone number; the connection.ts upsert handler routes
		// through resolveJidToE164 which is LID-aware. We assert the naive
		// behavior here only to lock the contract: any future change to
		// canonicalWhatsAppId that hides LID digits would break callers that
		// rely on this for non-LID jids.
		assert.equal(canonicalWhatsAppId("260451430568126@lid"), "260451430568126");
	});
});

describe("resolveJidToE164", () => {
	// Build a fake WASocket exposing only the `signalRepository.lidMapping`
	// shape we depend on. Anything else in the type is `as never`-cast at the
	// caller; runtime never touches those members in this resolver.
	function makeSock(lidTable: Record<string, string | null>) {
		return {
			signalRepository: {
				lidMapping: {
					getPNForLID: async (lidJid: string) => lidTable[lidJid] ?? null,
				},
			},
		} as unknown as Parameters<typeof resolveJidToE164>[0];
	}

	it("returns null for empty / undefined input", async () => {
		assert.equal(await resolveJidToE164(null, null), null);
		assert.equal(await resolveJidToE164(null, undefined), null);
		assert.equal(await resolveJidToE164(null, ""), null);
	});

	it("returns the digits of a direct phone-jid without consulting lidMapping", async () => {
		let lookupCalls = 0;
		const sock = {
			signalRepository: {
				lidMapping: {
					getPNForLID: async () => {
						lookupCalls += 1;
						return null;
					},
				},
			},
		} as unknown as Parameters<typeof resolveJidToE164>[0];
		assert.equal(await resolveJidToE164(sock, "15551234567@s.whatsapp.net"), "15551234567");
		assert.equal(await resolveJidToE164(sock, "15551234567:1@s.whatsapp.net"), "15551234567");
		assert.equal(await resolveJidToE164(sock, "15551234567@hosted"), "15551234567");
		assert.equal(lookupCalls, 0, "direct phone jids must not hit the LID lookup");
	});

	it("returns null for jids that look like neither phone nor LID", async () => {
		const sock = makeSock({});
		assert.equal(await resolveJidToE164(sock, "status@broadcast"), null);
		assert.equal(await resolveJidToE164(sock, "newsletter@newsletter"), null);
		assert.equal(await resolveJidToE164(sock, "abc@s.whatsapp.net"), null);
	});

	it("resolves a LID jid through signalRepository.lidMapping.getPNForLID", async () => {
		const sock = makeSock({
			"260451430568126@lid": "447700900123@s.whatsapp.net",
		});
		assert.equal(await resolveJidToE164(sock, "260451430568126@lid"), "447700900123");
	});

	it("returns null when the LID has no on-record mapping (and we must NOT invent a fake id)", async () => {
		const sock = makeSock({});
		// The most important contract: when lidMapping.getPNForLID returns null
		// (unmapped), resolveJidToE164 must return null — NOT the LID digits.
		// Returning LID digits would key pairing requests / allow-lists on
		// garbage that never matches a real phone.
		assert.equal(await resolveJidToE164(sock, "260451430568126@lid"), null);
	});

	it("returns null when signalRepository is missing entirely (defensive)", async () => {
		// Brigade should not crash if Baileys ever changes the signalRepository
		// surface. A LID jid with no lookup capability simply degrades to a
		// drop (with the message logged in connection.ts), not a throw.
		const sockNoRepo = {} as unknown as Parameters<typeof resolveJidToE164>[0];
		assert.equal(await resolveJidToE164(sockNoRepo, "123@lid"), null);
	});

	it("swallows a thrown lookup (e.g. mapping not cached yet)", async () => {
		const sock = {
			signalRepository: {
				lidMapping: {
					getPNForLID: async () => {
						throw new Error("not cached");
					},
				},
			},
		} as unknown as Parameters<typeof resolveJidToE164>[0];
		assert.equal(await resolveJidToE164(sock, "123@lid"), null);
	});

	it("returns null when the resolved pnJid isn't a recognized phone shape", async () => {
		const sock = makeSock({
			"123@lid": "garbage-not-a-jid",
		});
		assert.equal(await resolveJidToE164(sock, "123@lid"), null);
	});

	it("handles `@hosted.lid` variant", async () => {
		const sock = makeSock({
			"260451430568126@hosted.lid": "447700900123@s.whatsapp.net",
		});
		assert.equal(await resolveJidToE164(sock, "260451430568126@hosted.lid"), "447700900123");
	});

	/* ── on-disk reverse-mapping fallback ── */

	it("falls back to on-disk lid-mapping-<lid>_reverse.json BEFORE consulting signalRepository", async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const authDir = mkdtempSync(join(tmpdir(), "brigade-lid-test-"));
		try {
			// Disk says LID 999111 → +447700900123. Socket lookup returns
			// nothing — disk path must win.
			writeFileSync(join(authDir, "lid-mapping-999111_reverse.json"), JSON.stringify("447700900123"));
			let socketCalls = 0;
			const sock = {
				signalRepository: {
					lidMapping: {
						getPNForLID: async () => {
							socketCalls += 1;
							return null;
						},
					},
				},
			} as unknown as Parameters<typeof resolveJidToE164>[0];
			assert.equal(await resolveJidToE164(sock, "999111@lid", authDir), "447700900123");
			assert.equal(socketCalls, 0, "disk match must short-circuit the runtime lookup");
		} finally {
			rmSync(authDir, { recursive: true, force: true });
		}
	});

	it("disk fallback gracefully degrades when authDir is omitted", async () => {
		const sock = makeSock({ "999@lid": "447700900123@s.whatsapp.net" });
		// No authDir passed → straight to runtime lookup.
		assert.equal(await resolveJidToE164(sock, "999@lid"), "447700900123");
	});

	it("disk fallback handles missing / unparseable mapping files silently", async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const authDir = mkdtempSync(join(tmpdir(), "brigade-lid-test-"));
		try {
			// Write a garbage mapping file. Disk read parses, finds nothing
			// usable, returns null — runtime lookup still gets a turn.
			writeFileSync(join(authDir, "lid-mapping-999_reverse.json"), "not valid json");
			const sock = makeSock({ "999@lid": "447700900123@s.whatsapp.net" });
			assert.equal(await resolveJidToE164(sock, "999@lid", authDir), "447700900123");
		} finally {
			rmSync(authDir, { recursive: true, force: true });
		}
	});

	it("disk fallback returns null when the file contents are nullish", async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const authDir = mkdtempSync(join(tmpdir(), "brigade-lid-test-"));
		try {
			writeFileSync(join(authDir, "lid-mapping-999_reverse.json"), JSON.stringify(null));
			const sock = makeSock({});
			// No socket fallback either → null (drop the inbound).
			assert.equal(await resolveJidToE164(sock, "999@lid", authDir), null);
		} finally {
			rmSync(authDir, { recursive: true, force: true });
		}
	});
});

describe("resolveSenderIdentity", () => {
	function makeSock(lidTable: Record<string, string | null>) {
		return {
			signalRepository: {
				lidMapping: {
					getPNForLID: async (lidJid: string) => lidTable[lidJid] ?? null,
				},
			},
		} as unknown as Parameters<typeof resolveSenderIdentity>[0];
	}

	it("returns null only for empty / unusable input", async () => {
		assert.equal(await resolveSenderIdentity(null, null), null);
		assert.equal(await resolveSenderIdentity(null, undefined), null);
		assert.equal(await resolveSenderIdentity(null, ""), null);
	});

	it("resolves a phone jid to E.164 as the primary id", async () => {
		const sock = makeSock({});
		assert.deepEqual(await resolveSenderIdentity(sock, "15551234567@s.whatsapp.net"), {
			id: "15551234567",
			e164: "15551234567",
		});
	});

	it("NEVER drops an unmapped LID — falls back to the canonical LID as the id", async () => {
		const sock = makeSock({}); // no mapping on record
		// The whole point: instead of returning null (drop), we keep the LID so
		// a group message from a privacy-aliased member still reaches the gate.
		assert.deepEqual(await resolveSenderIdentity(sock, "260451430568126@lid"), {
			id: "260451430568126@lid",
			lid: "260451430568126@lid",
		});
	});

	it("strips the device suffix from an unmapped LID fallback", async () => {
		const sock = makeSock({});
		assert.deepEqual(await resolveSenderIdentity(sock, "260451430568126:7@lid"), {
			id: "260451430568126@lid",
			lid: "260451430568126@lid",
		});
	});

	it("keeps BOTH e164 and lid when a LID maps to a phone (identity overlap)", async () => {
		const sock = makeSock({ "260451430568126@lid": "447700900123@s.whatsapp.net" });
		assert.deepEqual(await resolveSenderIdentity(sock, "260451430568126@lid"), {
			id: "447700900123",
			e164: "447700900123",
			lid: "260451430568126@lid",
		});
	});
});

describe("isWaCryptoError", () => {
	// Locks the haystack used by the process-level unhandled-rejection trap
	// that force-reconnects on a stuck Signal-protocol ratchet. Two-part
	// check: (a) one of the two crypto-error signatures, AND (b) at least one
	// stack-frame keyword identifying it as a Baileys/Signal call (so we
	// don't react to unrelated AES errors from other parts of the agent).

	it("returns false for null / undefined / non-string nonsense", () => {
		assert.equal(isWaCryptoError(null), false);
		assert.equal(isWaCryptoError(undefined), false);
		assert.equal(isWaCryptoError(""), false);
		assert.equal(isWaCryptoError({}), false);
		assert.equal(isWaCryptoError(42), false);
	});

	it("returns false for an unrelated error (no crypto signature)", () => {
		assert.equal(isWaCryptoError(new Error("connection closed")), false);
		assert.equal(isWaCryptoError(new Error("Bad request from server")), false);
		// Crypto signature WITHOUT a Baileys/Signal stack-frame hint — still
		// false, because we only want to react when we're confident it came
		// from the WhatsApp transport.
		assert.equal(isWaCryptoError(new Error("Unsupported state or unable to authenticate data")), false);
		assert.equal(isWaCryptoError(new Error("Bad MAC in some other library")), false);
	});

	it("returns true for the canonical 'Unsupported state' rejection from a Baileys frame", () => {
		const err = new Error(
			"Unsupported state or unable to authenticate data\n    at baileys/Signal/Session.js:99:11",
		);
		assert.equal(isWaCryptoError(err), true);
	});

	it("returns true for a 'bad mac' rejection from a noise-handler frame", () => {
		const err = new Error("Bad MAC\n    at noise-handler.js:42:9");
		assert.equal(isWaCryptoError(err), true);
	});

	it("returns true for 'aesdecryptgcm' stack-frame hint", () => {
		const err = new Error("unsupported state or unable to authenticate data\n    at aesDecryptGCM.js:11:1");
		assert.equal(isWaCryptoError(err), true);
	});

	it("returns true for a Baileys '@whiskeysockets' stack-frame hint", () => {
		const err = new Error("bad mac\n    at @whiskeysockets/baileys/lib/Signal/repository.js:42:9");
		assert.equal(isWaCryptoError(err), true);
	});

	it("returns false for bare 'signal' in unrelated stack-frames (no Baileys attribution)", () => {
		// Catches the false-positive class: a libsignal build used by a
		// different package (Matrix, a Pi extension, etc.) producing
		// "bad mac" + a "signal" stack frame. Without Baileys/noise-
		// handler/aesdecryptgcm/@whiskeysockets attribution it must NOT
		// force-reconnect the WhatsApp socket.
		const err = new Error("bad mac\n    at libsignal-other/SessionCipher.js:55:5");
		assert.equal(isWaCryptoError(err), false);
	});

	it("matches regardless of case (real WhatsApp rejections vary by Baileys release)", () => {
		const upper = new Error("UNSUPPORTED STATE OR UNABLE TO AUTHENTICATE DATA at Baileys/X");
		const mixed = new Error("Bad Mac at Noise-Handler");
		assert.equal(isWaCryptoError(upper), true);
		assert.equal(isWaCryptoError(mixed), true);
	});

	it("accepts a plain string as well (some rejections aren't Error instances)", () => {
		assert.equal(
			isWaCryptoError("Unsupported state or unable to authenticate data at baileys"),
			true,
		);
		assert.equal(isWaCryptoError("something else entirely"), false);
	});
});
