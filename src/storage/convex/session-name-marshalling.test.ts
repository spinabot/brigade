import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { __sessionMarshalling } from "./session-store.js";
import type { SessionEntry } from "../../sessions/session-store.js";

// Hermetic: a real operator key file must not leak in — point the lookup nowhere.
process.env.BRIGADE_ENCRYPTION_KEY_FILE = path.join(tmpdir(), "brigade-no-such-key-file");

// Regression guard for a rename silently vanishing in convex mode.
//
// `name` has NO dedicated column on the sessions table, so it must ride the
// sealed `extra` blob. Listing it in KNOWN_FIELDS excludes it from `extra`
// without adding a column — the rename then looks like it worked (served from
// the in-process cache) and is gone after the next gateway restart. This test
// fails the moment someone "tidies up" by allowlisting it.
const { entryToMutationArgs, rowToEntry } = __sessionMarshalling;

describe("convex session marshalling — display name", () => {
  const base = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
    sessionId: "sid-1",
    createdAt: new Date(1_700_000_000_000).toISOString(),
    lastUsedAt: new Date(1_700_000_500_000).toISOString(),
    ...overrides,
  });

  it("survives a column round-trip via the extra blob", () => {
    const entry = base({ name: "Release prep" });
    const args = entryToMutationArgs(entry) as Record<string, unknown>;
    // Must NOT be promoted to a top-level column — none exists to receive it.
    assert.equal(args.name, undefined, "name must not be emitted as a column");
    assert.notEqual(args.extra, undefined, "name must be sealed into `extra`");
    const restored = rowToEntry(args as never);
    assert.equal(restored?.name, "Release prep");
  });

  it("an unnamed session round-trips without inventing a name", () => {
    const args = entryToMutationArgs(base()) as Record<string, unknown>;
    const restored = rowToEntry(args as never);
    assert.equal(restored?.name, undefined);
  });

  it("keeps the name alongside the fields that DO have columns", () => {
    const entry = base({ name: "Named", provider: "claude-cli", modelId: "claude-opus-5" });
    const restored = rowToEntry(entryToMutationArgs(entry) as never);
    assert.equal(restored?.name, "Named");
    assert.equal(restored?.provider, "claude-cli");
    assert.equal(restored?.modelId, "claude-opus-5");
  });
});
