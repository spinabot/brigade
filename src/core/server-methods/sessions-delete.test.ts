import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { handleSessionsDelete } from "./sessions.js";
import { readSessionStore, upsertSessionEntry } from "../../sessions/session-store.js";
import { resolveSessionTranscriptPath } from "../../config/paths.js";

async function withTempState(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "brigade-del-"));
  const prev = process.env.BRIGADE_STATE_DIR;
  process.env.BRIGADE_STATE_DIR = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
    else process.env.BRIGADE_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedWithTranscript(agentId: string, key: string): string {
  const entry = upsertSessionEntry(agentId, key, {});
  const transcript = resolveSessionTranscriptPath(agentId, entry.sessionId);
  mkdirSync(path.dirname(transcript), { recursive: true });
  writeFileSync(transcript, '{"type":"session","id":"x"}\n');
  writeFileSync(`${transcript}.lock`, "{}");
  return transcript;
}

const noLive = (): boolean => false;

/** Stands in for the runtime context's store — the ONLY correct way to remove a
 *  transcript, since in convex mode it lives in a table, not on disk. */
function fsStore(): { messages: { deleteTranscript: (a: string, s: string) => Promise<void> } } {
  return {
    messages: {
      deleteTranscript: async (agentId: string, sessionId: string) => {
        const t = resolveSessionTranscriptPath(agentId, sessionId);
        rmSync(t, { force: true });
        rmSync(`${t}.lock`, { force: true });
      },
    },
  };
}

test("handleSessionsDelete: removes the entry AND the transcript", async () => {
  await withTempState(async () => {
    const transcript = seedWithTranscript("main", "agent:main:t-1111");
    assert.equal(existsSync(transcript), true);

    const res = await handleSessionsDelete({ sessionKey: "agent:main:t-1111" }, { isLive: noLive, store: fsStore() });
    assert.equal(res.ok, true);
    assert.equal(res.transcriptRemoved, true);
    assert.equal(readSessionStore("main").sessions["agent:main:t-1111"], undefined);
    // A half-delete — entry gone, megabytes of conversation still on disk — is
    // the wrong outcome for someone who asked for it to be gone.
    assert.equal(existsSync(transcript), false, "transcript survived the delete");
    assert.equal(existsSync(`${transcript}.lock`), false, "stale write-lock survived");
  });
});

test("handleSessionsDelete: refuses while a turn is running", async () => {
  await withTempState(async () => {
    const transcript = seedWithTranscript("main", "agent:main:t-2222");
    const res = await handleSessionsDelete(
      { sessionKey: "agent:main:t-2222" },
      { isLive: () => true },
    );
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /active|running/i);
    // Nothing may be destroyed on a refusal.
    assert.notEqual(readSessionStore("main").sessions["agent:main:t-2222"], undefined);
    assert.equal(existsSync(transcript), true);
  });
});

test("handleSessionsDelete: unknown session is a clean miss", async () => {
  await withTempState(async () => {
    const res = await handleSessionsDelete({ sessionKey: "agent:main:ghost" }, { isLive: noLive, store: fsStore() });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /no such session/i);
  });
});

test("handleSessionsDelete: refuses when the access guard denies", async () => {
  await withTempState(async () => {
    const transcript = seedWithTranscript("main", "agent:main:t-3333");
    await assert.rejects(
      () =>
        handleSessionsDelete(
          { sessionKey: "agent:main:t-3333" },
          { isLive: noLive, store: fsStore(), accessCheck: () => ({ allowed: false, reason: "denied" }) },
        ),
      /denied|forbidden/i,
    );
    assert.equal(existsSync(transcript), true, "guard refusal must not delete anything");
  });
});

test("handleSessionsDelete: deletes only the named thread", async () => {
  await withTempState(async () => {
    const keep = seedWithTranscript("main", "agent:main:t-keep");
    seedWithTranscript("main", "agent:main:t-drop");
    await handleSessionsDelete({ sessionKey: "agent:main:t-drop" }, { isLive: noLive, store: fsStore() });
    const store = readSessionStore("main").sessions;
    assert.notEqual(store["agent:main:t-keep"], undefined);
    assert.equal(store["agent:main:t-drop"], undefined);
    assert.equal(existsSync(keep), true);
  });
});

test("handleSessionsDelete: filesystem-mode delete with no store still removes the JSONL", async () => {
  await withTempState(async () => {
    const transcript = seedWithTranscript("main", "agent:main:t-4444");
    // No store wired (cold CLI). In filesystem mode the JSONL IS the transcript,
    // so it must actually go — and the report must match. Claiming "may still be
    // on disk" about a file we just deleted is the same lie as the reverse.
    const res = await handleSessionsDelete({ sessionKey: "agent:main:t-4444" }, { isLive: noLive });
    assert.equal(res.ok, true);
    assert.equal(existsSync(transcript), false, "transcript survived");
    assert.equal(res.transcriptRemoved, true);
    assert.equal(existsSync(`${transcript}.lock`), false, "orphaned write-lock survived");
  });
});

test("handleSessionsDelete: rejects a non-canonical key instead of hitting the default agent", async () => {
  await withTempState(async () => {
    const transcript = seedWithTranscript("main", "agent:main:t-5555");
    // `resolveAgentIdFromSessionKey` collapses ANY unparseable key to `main`, so
    // without the canonical-shape check `/delete legacy-main` on another agent's
    // thread would destroy main's identically-keyed entry instead.
    for (const bad of ["legacy-main", "constructor", "toString", "__proto__", ""]) {
      const res = await handleSessionsDelete({ sessionKey: bad }, { isLive: noLive, store: fsStore() });
      assert.equal(res.ok, false, `accepted a non-canonical key: ${bad}`);
    }
    // Nothing real may have been touched.
    assert.notEqual(readSessionStore("main").sessions["agent:main:t-5555"], undefined);
    assert.equal(existsSync(transcript), true);
    // …and no phantom entries were conjured onto the prototype chain.
    assert.deepEqual(
      Object.keys(readSessionStore("main").sessions).filter((k) => !k.startsWith("agent:")),
      [],
    );
  });
});

test("handleSessionsDelete: removes the write-lock sidecar the stores never own", async () => {
  await withTempState(async () => {
    const transcript = seedWithTranscript("main", "agent:main:t-6666");
    await handleSessionsDelete({ sessionKey: "agent:main:t-6666" }, { isLive: noLive, store: fsStore() });
    assert.equal(existsSync(`${transcript}.lock`), false, "orphaned write-lock survived");
  });
});
