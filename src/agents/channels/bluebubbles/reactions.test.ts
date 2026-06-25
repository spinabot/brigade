import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { decodeTapbackType, isTapbackAssociatedType, normalizeBlueBubblesReaction } from "./reactions.js";
import { resolveEffectId } from "./effects.js";

describe("normalizeBlueBubblesReaction", () => {
	it("maps a bare type", () => {
		assert.equal(normalizeBlueBubblesReaction("love"), "love");
	});
	it("maps an emoji glyph to a type", () => {
		assert.equal(normalizeBlueBubblesReaction("😂"), "laugh");
		assert.equal(normalizeBlueBubblesReaction("👍"), "like");
	});
	it("maps a text alias", () => {
		assert.equal(normalizeBlueBubblesReaction("haha"), "laugh");
		assert.equal(normalizeBlueBubblesReaction("thumbs up"), "like");
	});
	it("handles a leading-minus removal", () => {
		assert.equal(normalizeBlueBubblesReaction("-love"), "-love");
	});
	it("handles a 'removed X' removal", () => {
		assert.equal(normalizeBlueBubblesReaction("removed like"), "-like");
	});
	it("returns null for an unknown reaction", () => {
		assert.equal(normalizeBlueBubblesReaction("shrug"), null);
	});

	it("resolves the broadened emoji set (Fix 7)", () => {
		assert.equal(normalizeBlueBubblesReaction("🔥"), "love");
		assert.equal(normalizeBlueBubblesReaction("😍"), "love");
		assert.equal(normalizeBlueBubblesReaction("💕"), "love");
		assert.equal(normalizeBlueBubblesReaction("♥️"), "love");
		assert.equal(normalizeBlueBubblesReaction("♥"), "love");
		assert.equal(normalizeBlueBubblesReaction("👌"), "like");
		assert.equal(normalizeBlueBubblesReaction("🙅"), "dislike");
		assert.equal(normalizeBlueBubblesReaction("😆"), "laugh");
		assert.equal(normalizeBlueBubblesReaction("😁"), "laugh");
		assert.equal(normalizeBlueBubblesReaction("😹"), "laugh");
		assert.equal(normalizeBlueBubblesReaction("❕"), "emphasize");
	});

	it("resolves the broadened colloquial aliases (Fix 7)", () => {
		assert.equal(normalizeBlueBubblesReaction("fire"), "love");
		assert.equal(normalizeBlueBubblesReaction("wow"), "emphasize");
		assert.equal(normalizeBlueBubblesReaction("lmao"), "laugh");
		assert.equal(normalizeBlueBubblesReaction("rofl"), "laugh");
		assert.equal(normalizeBlueBubblesReaction("xd"), "laugh");
		assert.equal(normalizeBlueBubblesReaction("ok"), "like");
		assert.equal(normalizeBlueBubblesReaction("boo"), "dislike");
		assert.equal(normalizeBlueBubblesReaction("no"), "dislike");
		assert.equal(normalizeBlueBubblesReaction("smile"), "laugh");
		assert.equal(normalizeBlueBubblesReaction("joy"), "laugh");
		assert.equal(normalizeBlueBubblesReaction("heart_eyes"), "love");
		assert.equal(normalizeBlueBubblesReaction("important"), "emphasize");
		assert.equal(normalizeBlueBubblesReaction("bang"), "emphasize");
		assert.equal(normalizeBlueBubblesReaction("ask"), "question");
	});

	it("still removes with the broadened aliases (e.g. -fire)", () => {
		assert.equal(normalizeBlueBubblesReaction("-fire"), "-love");
		assert.equal(normalizeBlueBubblesReaction("removed wow"), "-emphasize");
	});
});

describe("decodeTapbackType", () => {
	it("decodes the full add range 2000-2005 in canonical order", () => {
		const order = ["love", "like", "dislike", "laugh", "emphasize", "question"];
		for (let i = 0; i < 6; i++) {
			const decoded = decodeTapbackType(2000 + i);
			assert.equal(decoded?.type, order[i]);
			assert.equal(decoded?.action, "added");
		}
	});
	it("decodes the full remove range 3000-3005", () => {
		for (let i = 0; i < 6; i++) {
			const decoded = decodeTapbackType(3000 + i);
			assert.equal(decoded?.action, "removed");
		}
	});
	it("returns null for a non-tapback type", () => {
		assert.equal(decodeTapbackType(0), null);
		assert.equal(decodeTapbackType(undefined), null);
	});
});

describe("isTapbackAssociatedType", () => {
	it("is true across 2000-3999", () => {
		assert.equal(isTapbackAssociatedType(2000), true);
		assert.equal(isTapbackAssociatedType(3005), true);
		assert.equal(isTapbackAssociatedType(3999), true);
	});
	it("is false outside the range", () => {
		assert.equal(isTapbackAssociatedType(0), false);
		assert.equal(isTapbackAssociatedType(4000), false);
		assert.equal(isTapbackAssociatedType(undefined), false);
	});
});

describe("resolveEffectId", () => {
	it("maps friendly names to Apple ids", () => {
		assert.equal(resolveEffectId("confetti"), "com.apple.messages.effect.CKConfettiEffect");
		assert.equal(resolveEffectId("slam"), "com.apple.MobileSMS.expressivesend.impact");
	});
	it("maps space/underscore variants", () => {
		assert.equal(resolveEffectId("invisible ink"), "com.apple.MobileSMS.expressivesend.invisibleink");
		assert.equal(resolveEffectId("invisible_ink"), "com.apple.MobileSMS.expressivesend.invisibleink");
	});
	it("passes an already-qualified Apple id through", () => {
		assert.equal(resolveEffectId("com.apple.messages.effect.CKLasersEffect"), "com.apple.messages.effect.CKLasersEffect");
	});
	it("returns undefined for an unknown name", () => {
		assert.equal(resolveEffectId("nope"), undefined);
	});
});
