import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { handleSessionsRename } from "./sessions.js";
import { readSessionStore, upsertSessionEntry } from "../../sessions/session-store.js";

function withTempState(fn: (dir: string) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(path.join(tmpdir(), "brigade-rename-h-"));
  const prev = process.env.BRIGADE_STATE_DIR;
  process.env.BRIGADE_STATE_DIR = dir;
  const restore = (): void => {
    if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
    else process.env.BRIGADE_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const out = fn(dir);
    return out instanceof Promise ? out.finally(restore) : (restore(), undefined);
  } catch (err) {
    restore();
    throw err;
  }
}

test("handleSessionsRename: renames the session named by the key", async () => {
  await withTempState(async () => {
    upsertSessionEntry("main", "agent:main:main", {});
    const res = await handleSessionsRename({ sessionKey: "agent:main:main", name: "  Release   prep " });
    assert.equal(res.ok, true);
    assert.equal(res.name, "Release prep");
    assert.equal(readSessionStore("main").sessions["agent:main:main"]?.name, "Release prep");
  });
});

test("handleSessionsRename: unknown session is a clean miss, never a create", async () => {
  await withTempState(async () => {
    const res = await handleSessionsRename({ sessionKey: "agent:main:ghost", name: "Nope" });
    assert.equal(res.ok, false);
    assert.equal(readSessionStore("main").sessions["agent:main:ghost"], undefined);
  });
});

test("handleSessionsRename: refuses when the access guard denies", async () => {
  await withTempState(async () => {
    upsertSessionEntry("main", "agent:main:main", {});
    await assert.rejects(
      () =>
        handleSessionsRename(
          { sessionKey: "agent:main:main", name: "Nope" },
          { accessCheck: () => ({ allowed: false, reason: "denied" }) },
        ),
      /denied|forbidden/i,
    );
    assert.equal(readSessionStore("main").sessions["agent:main:main"]?.name, undefined);
  });
});

test("handleSessionsRename: a caller-supplied agentId cannot redirect the write", async () => {
  await withTempState(async (dir) => {
    upsertSessionEntry("main", "agent:main:main", {});
    // The access guard is handed only `sessionKey`. If the handler honoured an
    // `agentId` param it would write to a store the guard never authorised —
    // and `resolveAgentDir` path-joins the id unvalidated, so `../../outside`
    // escapes the state dir entirely. The agent MUST come from the key.
    await handleSessionsRename({
      sessionKey: "agent:main:main",
      name: "Owned",
      // @ts-expect-error — deliberately passing a param the type no longer has
      agentId: "../../outside",
    });
    assert.equal(readSessionStore("main").sessions["agent:main:main"]?.name, "Owned");
    assert.equal(existsSync(path.join(dir, "..", "outside")), false, "escaped the state dir");
  });
});

test("handleSessionsRename: the /new → send → named sequence", async () => {
  await withTempState(async () => {
    const key = "agent:main:t-abc12345"; // what `/new` mints, client-side only

    // 1. Typed before the thread exists: a clean miss, and nothing conjured.
    //    This is what makes the TUI hold the name instead of dead-ending.
    const early = await handleSessionsRename({ sessionKey: key, name: "Release prep" });
    assert.equal(early.ok, false);
    assert.equal(readSessionStore("main").sessions[key], undefined);

    // 2. The first turn writes the entry (this is what the agent loop does).
    upsertSessionEntry("main", key, { provider: "claude-cli" });

    // 3. The queued name now lands — this is the `agent_end` flush.
    const late = await handleSessionsRename({ sessionKey: key, name: "Release prep" });
    assert.equal(late.ok, true);
    assert.equal(late.name, "Release prep");
    assert.equal(readSessionStore("main").sessions[key]?.name, "Release prep");
    // The turn's own fields must be untouched by the rename.
    assert.equal(readSessionStore("main").sessions[key]?.provider, "claude-cli");
  });
});

test("handleSessionsRename: a queued name must not land on a different thread", async () => {
  await withTempState(async () => {
    upsertSessionEntry("main", "agent:main:t-aaaa1111", {});
    upsertSessionEntry("main", "agent:main:t-bbbb2222", {});
    // The TUI re-checks the bound key before flushing; this asserts the server
    // half — a rename is scoped to the key it names and touches nothing else.
    await handleSessionsRename({ sessionKey: "agent:main:t-aaaa1111", name: "First" });
    const store = readSessionStore("main").sessions;
    assert.equal(store["agent:main:t-aaaa1111"]?.name, "First");
    assert.equal(store["agent:main:t-bbbb2222"]?.name, undefined);
  });
});
