import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetFactsCacheForTests } from "../../storage/facts-cache.js";
import { __resetRuntimeContextForTests, createRuntimeContext, setRuntimeContext } from "../../storage/runtime-context.js";
import type { BrigadeStore } from "../../storage/store.js";
import { FactStore } from "./records.js";

/**
 * Convex AUDIT LOG (additive build) — in convex mode, `FactStore.emit` routes
 * provenance events to the OPTIONAL `appendMemoryEvent` store hook (fs mode keeps
 * using events.jsonl). Proven here against a fake convex store; the real convex
 * table + functions are the deploy-validated production impl.
 */

// A fake convex BrigadeStore that captures audit events via the optional hooks.
function makeEventStore() {
	const events: Array<Record<string, unknown>> = [];
	const store = {
		mode: "convex",
		init: async () => {},
		memory: {
			upsertFactRecordRaw: async () => {},
			deleteFactRecordRaw: async () => {},
			appendMemoryEvent: async (_workspaceId: string, event: Record<string, unknown>) => {
				events.push(event);
			},
			listMemoryEvents: async (_workspaceId: string) => events.slice(),
		},
	} as unknown as BrigadeStore;
	return { store, events };
}

let dir: string;
beforeEach(() => {
	__resetRuntimeContextForTests();
	__resetFactsCacheForTests();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-events-cx-"));
});
afterEach(() => {
	__resetRuntimeContextForTests();
	__resetFactsCacheForTests();
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("convex audit log — emit() routes to the appendMemoryEvent hook", () => {
	it("a write emits a 'created' event to the convex trail; readEventsAsync reads it back", async () => {
		const { store: cxStore, events } = makeEventStore();
		setRuntimeContext(await createRuntimeContext({ store: cxStore, stateDir: dir }));
		const store = new FactStore(path.join(dir, "cxws"));
		store.write({ content: "I live in Lisbon", segment: "identity" });
		// emit() is fire-and-forget (an audit-log write must never fail a memory write) —
		// let the microtask queue drain.
		await new Promise((r) => setTimeout(r, 0));

		assert.equal(events.length, 1, "exactly one provenance event reached the convex audit trail (one write = one 'created')");
		assert.equal((events[0] as { kind?: string }).kind, "created", "the write emitted a 'created' event");
		assert.equal((events[0] as { segment?: string }).segment, "identity", "the event carries the correct segment from the written fact");

		// readEventsAsync reads the convex trail in convex mode...
		const read = await store.readEventsAsync();
		assert.equal(read.length, 1, "readEventsAsync returns exactly one event from the convex trail");
		assert.equal((read[0] as { kind?: string }).kind, "created", "readEventsAsync returns the 'created' event");
		// ...while the SYNC readEvents stays fs-only (empty in convex mode).
		assert.equal(store.readEvents().length, 0, "sync readEvents is empty in convex mode (use readEventsAsync)");
	});

	it("convex mode WITHOUT the hook degrades to no audit trail (graceful, no crash)", async () => {
		const store0 = {
			mode: "convex",
			init: async () => {},
			memory: { upsertFactRecordRaw: async () => {}, deleteFactRecordRaw: async () => {} },
		} as unknown as BrigadeStore;
		setRuntimeContext(await createRuntimeContext({ store: store0, stateDir: dir }));
		const store = new FactStore(path.join(dir, "cxws2"));
		store.write({ content: "no event hook present", segment: "knowledge" }); // must not throw
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(await store.readEventsAsync(), [], "no hook ⇒ empty audit trail (additive degrade)");
	});
});
