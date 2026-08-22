import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createSessionsRenameTool } from "./rename.js";

test("sessions_rename: exposes no sessionKey parameter", () => {
  const tool = createSessionsRenameTool({ agentSessionKey: "agent:main:main" });
  const props = (tool.parameters as { properties?: Record<string, unknown>; additionalProperties?: boolean })
    .properties;
  // The bundle has NO owner gate, so a sessionKey argument would let an
  // untrusted channel peer rename someone else's thread. Scoping to the
  // caller's own session is the guard — it must not be re-introduced.
  assert.deepEqual(Object.keys(props ?? {}), ["name"]);
  assert.equal((tool.parameters as { additionalProperties?: boolean }).additionalProperties, false);
});

test("sessions_rename: fails closed with no caller session key", async () => {
  const tool = createSessionsRenameTool({});
  const res = await tool.execute({ name: "Anything" });
  const payload = res.details?.payload as { status?: string; ok?: boolean } | undefined;
  assert.ok(payload, "expected a structured payload");
  assert.equal(payload.status, "forbidden");
  assert.equal(payload.ok, false);
});

test("sessions_rename: malformed args are refused, never treated as a clear", async () => {
  const tool = createSessionsRenameTool({ agentSessionKey: "agent:main:main" });
  // Coercing non-strings to "" made every one of these a silent CLEAR that
  // reported success — a model with a typo'd argument key erased the operator's
  // thread name. Each must refuse instead.
  for (const args of [{}, undefined, "Release prep", { title: "Release prep" }, { name: 42 }, { name: null }, []]) {
    const res = await tool.execute(args);
    const payload = res.details?.payload as { ok?: boolean; cleared?: boolean } | undefined;
    assert.equal(payload?.ok, false, `accepted malformed args: ${JSON.stringify(args)}`);
    assert.notEqual(payload?.cleared, true, `silently cleared the name for: ${JSON.stringify(args)}`);
  }
});

test("sessions_rename: an explicit empty string is still an intentional clear", async () => {
  const tool = createSessionsRenameTool({ agentSessionKey: "agent:main:main" });
  const res = await tool.execute({ name: "" });
  const payload = res.details?.payload as { ok?: boolean; error?: string } | undefined;
  // Reaches the gateway (which is absent here, so it errors) rather than being
  // rejected as malformed — clearing must remain expressible.
  assert.ok(
    !/must be a string|no `name` given|expects an object/.test(payload?.error ?? ""),
    `an explicit "" must reach the gateway as a clear, not be refused: ${payload?.error}`,
  );
});
