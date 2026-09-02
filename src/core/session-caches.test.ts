/**
 * The bug this replaced: one set of module-level variables held context usage,
 * message count and thinking capability for the WHOLE gateway, written by every
 * turn of every session and read into a snapshot that is otherwise per-binding.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { SessionCaches } from "./session-caches.js";

describe("SessionCaches", () => {
	it("keeps one session's context usage out of another's snapshot", () => {
		// THE HEADLINE FAILURE. Operator's thread sits at 4%; a WhatsApp thread
		// runs at 91%. The operator's footer used to turn amber and `/context`
		// drew a near-full bar, for a thread that needed neither.
		const c = new SessionCaches();
		c.set("main", "agent:main:main", {
			contextPercent: 4,
			contextTokens: 8_000,
			contextWindow: 200_000,
		});
		c.set("main", "agent:main:whatsapp:direct:+15551234", {
			contextPercent: 91,
			contextTokens: 182_000,
			contextWindow: 200_000,
		});
		assert.equal(c.get("main", "agent:main:main")?.contextPercent, 4);
		assert.equal(c.get("main", "agent:main:whatsapp:direct:+15551234")?.contextPercent, 91);
	});

	it("keeps contextWindow per session, so a pinned model is not misreported", () => {
		// The window used to be copied from whichever model last streamed, so a
		// session pinned to a 1M-window model displayed /200k.
		const c = new SessionCaches();
		c.set("main", "big", { contextWindow: 1_000_000 });
		c.set("main", "small", { contextWindow: 200_000 });
		assert.equal(c.get("main", "big")?.contextWindow, 1_000_000);
		assert.equal(c.get("main", "small")?.contextWindow, 200_000);
	});

	it("separates identically-named sessions on different agents", () => {
		const c = new SessionCaches();
		c.set("main", "agent:main:main", { messageCount: 12 });
		c.set("ops", "agent:main:main", { messageCount: 3 });
		assert.equal(c.get("main", "agent:main:main")?.messageCount, 12);
		assert.equal(c.get("ops", "agent:main:main")?.messageCount, 3);
	});

	it("reports nothing for a session it has never seen", () => {
		// Honest absence. The caller renders null rather than borrowing another
		// session's numbers, which is the whole point.
		assert.equal(new SessionCaches().get("main", "never"), undefined);
	});

	it("merges rather than clobbering — one field at a time is the real usage", () => {
		// `refreshCachesFromSession` writes context, then thinking caps, in
		// separate try blocks, so a write must not erase the previous one.
		const c = new SessionCaches();
		c.set("main", "s", { contextPercent: 50 });
		c.set("main", "s", { supportsThinking: true });
		c.set("main", "s", { thinkingLevels: ["low", "high"] });
		const e = c.get("main", "s");
		assert.equal(e?.contextPercent, 50, "the earlier write survived");
		assert.equal(e?.supportsThinking, true);
		assert.deepEqual(e?.thinkingLevels, ["low", "high"]);
	});

	it("stores an explicit null, because null means something different from absent", () => {
		// Pi returns null right after a compaction by design. A stale percentage
		// is worse than none, so null must overwrite a previous number.
		const c = new SessionCaches();
		c.set("main", "s", { contextPercent: 88 });
		c.set("main", "s", { contextPercent: null });
		assert.equal(c.get("main", "s")?.contextPercent, null);
	});

	it("evicts the least recently used, and a READ counts as use", () => {
		// The thread an operator has open all day is read on every state
		// broadcast and written rarely. Evicting it for being quiet is backwards.
		const c = new SessionCaches(2);
		c.set("main", "a", { messageCount: 1 });
		c.set("main", "b", { messageCount: 1 });
		c.get("main", "a"); // touch `a` so `b` becomes the oldest
		c.set("main", "c", { messageCount: 1 });
		assert.equal(c.size(), 2);
		assert.ok(c.get("main", "a"), "the recently-read entry survived");
		assert.equal(c.get("main", "b"), undefined, "the untouched one was evicted");
	});

	it("forgets a session on request", () => {
		const c = new SessionCaches();
		c.set("main", "s", { messageCount: 5 });
		c.forget("main", "s");
		assert.equal(c.get("main", "s"), undefined);
	});
});
