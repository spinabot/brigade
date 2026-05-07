import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyAuthProfileMeta,
  applyConfigMeta,
  applyGatewayCredentials,
  applyModelSelection,
  applyOnboardDefaults,
  applyPluginEnable,
  applyWizardMetadata,
  BRIGADE_DEFAULT_DANGEROUS_NODE_COMMANDS,
  buildProfileId,
  normalizeGatewayTokenInput,
  randomToken,
} from "./helpers.js";
import type { BrigadeConfig } from "../../config/io.js";
import { restoreEnvVarRefsRecursive } from "../../config/io.js";

const FROZEN_NOW = new Date("2026-05-07T12:00:00.000Z");

function emptyConfig(): BrigadeConfig {
  return { version: 1 };
}

test("randomToken returns 48 hex characters (24 bytes)", () => {
  const a = randomToken();
  const b = randomToken();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.match(b, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
});

test("BRIGADE_DEFAULT_DANGEROUS_NODE_COMMANDS = 8 entries in fixed order", () => {
  assert.equal(BRIGADE_DEFAULT_DANGEROUS_NODE_COMMANDS.length, 8);
  assert.deepEqual([...BRIGADE_DEFAULT_DANGEROUS_NODE_COMMANDS], [
    "camera.snap",
    "camera.clip",
    "screen.record",
    "contacts.add",
    "calendar.add",
    "reminders.add",
    "sms.send",
    "sms.search",
  ]);
});

test("buildProfileId defaults alias to 'default'", () => {
  assert.equal(buildProfileId("openrouter"), "openrouter:default");
  assert.equal(buildProfileId("openai", "work"), "openai:work");
});

test("applyWizardMetadata stamps lastRunAt/Version/Command/Mode", () => {
  const cfg = applyWizardMetadata(emptyConfig(), {
    command: "onboard",
    mode: "local",
    now: FROZEN_NOW,
  });
  assert.equal(cfg.wizard?.lastRunAt, "2026-05-07T12:00:00.000Z");
  assert.equal(cfg.wizard?.lastRunVersion, "0.1.0");
  assert.equal(cfg.wizard?.lastRunCommand, "onboard");
  assert.equal(cfg.wizard?.lastRunMode, "local");
});

test("applyWizardMetadata preserves other top-level keys", () => {
  const before: BrigadeConfig = { version: 1, gateway: { port: 18789 } };
  const after = applyWizardMetadata(before, { command: "configure", mode: "remote" });
  assert.equal(after.gateway?.port, 18789);
  assert.equal(after.wizard?.lastRunCommand, "configure");
  assert.equal(after.wizard?.lastRunMode, "remote");
});

test("applyWizardMetadata respects explicit commit override", () => {
  const cfg = applyWizardMetadata(emptyConfig(), {
    command: "onboard",
    mode: "local",
    now: FROZEN_NOW,
    commit: "abc1234",
  });
  assert.equal(cfg.wizard?.lastRunCommit, "abc1234");
});

test("applyConfigMeta stamps lastTouchedAt/Version", () => {
  const cfg = applyConfigMeta(emptyConfig(), { now: FROZEN_NOW });
  assert.equal(cfg.meta?.lastTouchedAt, "2026-05-07T12:00:00.000Z");
  assert.equal(cfg.meta?.lastTouchedVersion, "0.1.0");
});

test("applyOnboardDefaults sets workspace + session.dmScope + tools.profile + gateway block", () => {
  const cfg = applyOnboardDefaults(emptyConfig(), { workspace: "/tmp/ws" });
  assert.equal((cfg.agents?.defaults as { workspace?: string } | undefined)?.workspace, "/tmp/ws");
  assert.equal(cfg.session?.dmScope, "per-channel-peer");
  assert.equal(cfg.tools?.profile, "coding");
  assert.equal(cfg.gateway?.mode, "local");
  assert.equal(cfg.gateway?.bind, "loopback");
  assert.equal(cfg.gateway?.tailscale?.mode, "off");
  assert.equal(cfg.gateway?.tailscale?.resetOnExit, false);
  assert.equal(cfg.gateway?.controlUi?.allowInsecureAuth, true);
  assert.deepEqual(cfg.gateway?.nodes?.denyCommands, [...BRIGADE_DEFAULT_DANGEROUS_NODE_COMMANDS]);
});

test("applyOnboardDefaults preserves existing values (idempotent)", () => {
  const before: BrigadeConfig = {
    version: 1,
    session: { dmScope: "main" },
    tools: { profile: "messaging" },
    gateway: { port: 9999, bind: "lan" },
  };
  const after = applyOnboardDefaults(before, { workspace: "/tmp/ws" });
  assert.equal(after.session?.dmScope, "main");
  assert.equal(after.tools?.profile, "messaging");
  assert.equal(after.gateway?.bind, "lan");
  assert.equal(after.gateway?.port, 9999);
});

test("applyGatewayCredentials writes port + token when token absent", () => {
  const cfg = applyGatewayCredentials(emptyConfig(), { port: 18789 });
  assert.equal(cfg.gateway?.port, 18789);
  assert.equal(cfg.gateway?.auth?.mode, "token");
  assert.match(cfg.gateway?.auth?.token ?? "", /^[0-9a-f]{48}$/);
});

test("applyGatewayCredentials honours explicit token", () => {
  const cfg = applyGatewayCredentials(emptyConfig(), {
    port: 18789,
    token: "deadbeef".repeat(6),
  });
  assert.equal(cfg.gateway?.auth?.token, "deadbeef".repeat(6));
});

test("applyGatewayCredentials does NOT overwrite an existing SecretRef-style token", () => {
  const before: BrigadeConfig = {
    version: 1,
    gateway: { auth: { mode: "token", token: "${BRIGADE_GATEWAY_TOKEN}" } },
  };
  const after = applyGatewayCredentials(before, {
    port: 18789,
    existingTokenIsSecretRef: true,
  });
  assert.equal(after.gateway?.auth?.token, "${BRIGADE_GATEWAY_TOKEN}");
});

test("applyAuthProfileMeta writes provider + mode keyed by profileId", () => {
  const cfg = applyAuthProfileMeta(emptyConfig(), {
    profileId: "openrouter:default",
    provider: "openrouter",
    mode: "api_key",
  });
  assert.deepEqual(cfg.auth?.profiles?.["openrouter:default"], {
    provider: "openrouter",
    mode: "api_key",
  });
});

test("applyAuthProfileMeta merges multiple profiles without clobbering", () => {
  let cfg = emptyConfig();
  cfg = applyAuthProfileMeta(cfg, {
    profileId: "openrouter:default",
    provider: "openrouter",
    mode: "api_key",
  });
  cfg = applyAuthProfileMeta(cfg, {
    profileId: "openai:default",
    provider: "openai",
    mode: "api_key",
  });
  assert.equal(Object.keys(cfg.auth?.profiles ?? {}).length, 2);
  assert.ok(cfg.auth?.profiles?.["openrouter:default"]);
  assert.ok(cfg.auth?.profiles?.["openai:default"]);
});

test("applyAuthProfileMeta carries email/displayName when provided", () => {
  const cfg = applyAuthProfileMeta(emptyConfig(), {
    profileId: "anthropic:default",
    provider: "anthropic",
    mode: "token",
    email: "user@example.com",
    displayName: "Work account",
  });
  assert.equal(cfg.auth?.profiles?.["anthropic:default"]?.email, "user@example.com");
  assert.equal(cfg.auth?.profiles?.["anthropic:default"]?.displayName, "Work account");
});

test("applyPluginEnable flips entries[provider].enabled = true", () => {
  let cfg = applyPluginEnable(emptyConfig(), "openrouter");
  assert.equal(cfg.plugins?.entries?.openrouter?.enabled, true);
  cfg = applyPluginEnable(cfg, "openai");
  assert.equal(cfg.plugins?.entries?.openai?.enabled, true);
  // re-enabling is a no-op in shape:
  cfg = applyPluginEnable(cfg, "openrouter");
  assert.equal(cfg.plugins?.entries?.openrouter?.enabled, true);
});

test("applyModelSelection writes primary, fallbacks, and aliases", () => {
  const cfg = applyModelSelection(emptyConfig(), {
    primary: "openai/gpt-5.4",
    fallbacks: ["openrouter/auto"],
    aliases: {
      "openai/gpt-5.4": "GPT",
      "openrouter/auto": "OpenRouter",
    },
  });
  const defaults = cfg.agents?.defaults as
    | { model?: { primary: string; fallbacks?: string[] }; models?: Record<string, { alias?: string }> }
    | undefined;
  assert.equal(defaults?.model?.primary, "openai/gpt-5.4");
  assert.deepEqual(defaults?.model?.fallbacks, ["openrouter/auto"]);
  assert.equal(defaults?.models?.["openai/gpt-5.4"]?.alias, "GPT");
  assert.equal(defaults?.models?.["openrouter/auto"]?.alias, "OpenRouter");
});

test("applyModelSelection omits fallbacks key when array is empty/undefined", () => {
  const cfg = applyModelSelection(emptyConfig(), { primary: "claude-opus-4-7" });
  const defaults = cfg.agents?.defaults as { model?: { fallbacks?: string[] } } | undefined;
  assert.equal(defaults?.model?.fallbacks, undefined);
});

test("normalizeGatewayTokenInput rejects literal 'undefined' / 'null' / empty / whitespace", () => {
  assert.equal(normalizeGatewayTokenInput("undefined"), undefined);
  assert.equal(normalizeGatewayTokenInput("null"), undefined);
  assert.equal(normalizeGatewayTokenInput(""), undefined);
  assert.equal(normalizeGatewayTokenInput("   "), undefined);
  assert.equal(normalizeGatewayTokenInput(undefined), undefined);
  assert.equal(normalizeGatewayTokenInput(null), undefined);
  assert.equal(normalizeGatewayTokenInput(123 as unknown), undefined);
  assert.equal(normalizeGatewayTokenInput("real-token"), "real-token");
  assert.equal(normalizeGatewayTokenInput("  spaced  "), "spaced");
});

test("applyOnboardDefaults: first onboard + loopback seeds controlUi.allowInsecureAuth=true", () => {
  const cfg = applyOnboardDefaults(emptyConfig(), { workspace: "/tmp/ws" });
  assert.equal(cfg.gateway?.controlUi?.allowInsecureAuth, true);
});

test("applyOnboardDefaults: re-onboard against existing config does NOT seed controlUi.allowInsecureAuth", () => {
  // hasExistingConfig=true mirrors the reference's quickstartGateway.hasExisting
  // gate. User had a customised controlUi block (or no block at all but
  // intentionally) — we must not flip insecure auth back on.
  const cfg = applyOnboardDefaults(emptyConfig(), {
    workspace: "/tmp/ws",
    hasExistingConfig: true,
  });
  assert.equal(cfg.gateway?.controlUi?.allowInsecureAuth, undefined);
});

test("applyOnboardDefaults: re-onboard preserves existing nodes block (denyCommands NOT reseeded)", () => {
  const before: BrigadeConfig = {
    gateway: { nodes: { allowCommands: ["sms.send"] } },
  };
  const cfg = applyOnboardDefaults(before, {
    workspace: "/tmp/ws",
    hasExistingConfig: true,
  });
  assert.deepEqual(cfg.gateway?.nodes?.allowCommands, ["sms.send"]);
  assert.equal(cfg.gateway?.nodes?.denyCommands, undefined);
});

test("applyOnboardDefaults: first onboard with empty nodes:{} block DOES seed denyCommands (per-field guard)", () => {
  // Edge case: user has manually typed `nodes: {}` into their config before
  // running onboard for the first time. Reference checks the three
  // individual fields (denyCommands / allowCommands / browser) — none
  // are set, so the block IS seeded. The earlier "whole-block missing"
  // guard would have skipped this, leaving an empty `nodes: {}` on disk.
  const before: BrigadeConfig = { gateway: { nodes: {} } };
  const cfg = applyOnboardDefaults(before, {
    workspace: "/tmp/ws",
    hasExistingConfig: false,
  });
  assert.deepEqual(
    cfg.gateway?.nodes?.denyCommands,
    [...BRIGADE_DEFAULT_DANGEROUS_NODE_COMMANDS],
  );
});

test("applyOnboardDefaults: first onboard with allowCommands set does NOT reseed denyCommands", () => {
  // Mirror of the reference's three-field gate — if any of denyCommands /
  // allowCommands / browser is already set, the block is treated as
  // customised even on first onboard.
  const before: BrigadeConfig = {
    gateway: { nodes: { allowCommands: ["sms.send"] } },
  };
  const cfg = applyOnboardDefaults(before, {
    workspace: "/tmp/ws",
    hasExistingConfig: false,
  });
  assert.equal(cfg.gateway?.nodes?.denyCommands, undefined);
  assert.deepEqual(cfg.gateway?.nodes?.allowCommands, ["sms.send"]);
});

test("applyOnboardDefaults: gateway block renders in canonical reference key order", () => {
  const cfg = applyOnboardDefaults(emptyConfig(), { workspace: "/tmp/ws" });
  // Object.keys returns insertion order in V8 — assert it matches reference layout.
  assert.deepEqual(Object.keys(cfg.gateway ?? {}), [
    "mode",
    "bind",
    "tailscale",
    "controlUi",
    "nodes",
  ]);
});

test("applyGatewayCredentials: composed gateway has canonical reference key order", () => {
  const cfg = applyGatewayCredentials(emptyConfig(), { port: 18789, token: "x".repeat(48) });
  // Sequence: mode → auth → port → bind? → tailscale? → controlUi? → nodes?
  // Empty cfg has no bind/tailscale/etc., so first three are: mode, auth, port.
  assert.deepEqual(Object.keys(cfg.gateway ?? {}), ["mode", "auth", "port"]);
});

test("restoreEnvVarRefsRecursive: ${VAR} survives even when wizard spreads to a new object", () => {
  // Simulates the real bug: readConfigOrInit parses a config containing
  // `${MY_TOKEN}`, resolves it to the env value. The wizard spreads the
  // config many times. Eventually writeConfigSafe sees a different object
  // identity than what was parsed. The recursive walker still restores
  // the ref because it compares by structural position, not identity.
  const env = { MY_TOKEN: "secret-resolved-value" };
  const parsed = { gateway: { auth: { token: "${MY_TOKEN}" } } };
  // After resolution + many wizard spreads, the runtime config looks like:
  const runtime = { gateway: { auth: { token: "secret-resolved-value", mode: "token" } } };
  const restored = restoreEnvVarRefsRecursive(runtime, parsed, env) as typeof runtime;
  assert.equal(restored.gateway?.auth?.token, "${MY_TOKEN}");
  // Other fields (added by wizard) flow through verbatim.
  assert.equal(restored.gateway?.auth?.mode, "token");
});

test("restoreEnvVarRefsRecursive: literal value that DIFFERS from env does NOT get clobbered", () => {
  // If the wizard explicitly overwrote the token with something else, we
  // must NOT restore the original ${VAR} — that would silently revert
  // the user's intentional change.
  const env = { MY_TOKEN: "old-secret" };
  const parsed = { gateway: { auth: { token: "${MY_TOKEN}" } } };
  const runtime = { gateway: { auth: { token: "new-explicit-token" } } };
  const restored = restoreEnvVarRefsRecursive(runtime, parsed, env) as typeof runtime;
  assert.equal(restored.gateway?.auth?.token, "new-explicit-token");
});

test("restoreEnvVarRefsRecursive: new fields not in parsed flow through (no false-positive restoration)", () => {
  const env = { ANY_VAR: "anything" };
  const parsed = {};
  const runtime = { brand: { new: "field" } };
  const restored = restoreEnvVarRefsRecursive(runtime, parsed, env) as typeof runtime;
  assert.equal(restored.brand?.new, "field");
});

test("end-to-end: apply onboard → gateway → auth → plugin → model → wizard → meta produces reference shape", () => {
  let cfg = emptyConfig();
  cfg = applyOnboardDefaults(cfg, { workspace: "/home/u/.brigade/workspace" });
  cfg = applyGatewayCredentials(cfg, { port: 18789, token: "a".repeat(48) });
  cfg = applyAuthProfileMeta(cfg, {
    profileId: "openrouter:default",
    provider: "openrouter",
    mode: "api_key",
  });
  cfg = applyAuthProfileMeta(cfg, {
    profileId: "openai:default",
    provider: "openai",
    mode: "api_key",
  });
  cfg = applyPluginEnable(cfg, "openrouter");
  cfg = applyPluginEnable(cfg, "openai");
  cfg = applyModelSelection(cfg, {
    primary: "openai/gpt-5.4",
    fallbacks: ["openrouter/auto"],
    aliases: { "openai/gpt-5.4": "GPT", "openrouter/auto": "OpenRouter" },
  });
  cfg = applyWizardMetadata(cfg, { command: "onboard", mode: "local", now: FROZEN_NOW });
  cfg = applyConfigMeta(cfg, { now: FROZEN_NOW });

  // Compare key invariants against the user's reference openclaw.json shape.
  assert.equal(cfg.gateway?.mode, "local");
  assert.equal(cfg.gateway?.bind, "loopback");
  assert.equal(cfg.gateway?.port, 18789);
  assert.equal(cfg.gateway?.tailscale?.mode, "off");
  assert.equal(cfg.gateway?.controlUi?.allowInsecureAuth, true);
  assert.equal(cfg.gateway?.nodes?.denyCommands?.length, 8);
  assert.equal(cfg.session?.dmScope, "per-channel-peer");
  assert.equal(cfg.tools?.profile, "coding");
  assert.equal(Object.keys(cfg.auth?.profiles ?? {}).length, 2);
  assert.equal(cfg.plugins?.entries?.openrouter?.enabled, true);
  assert.equal(cfg.plugins?.entries?.openai?.enabled, true);
  const defaults = cfg.agents?.defaults as
    | { model?: { primary: string; fallbacks?: string[] } }
    | undefined;
  assert.equal(defaults?.model?.primary, "openai/gpt-5.4");
  assert.deepEqual(defaults?.model?.fallbacks, ["openrouter/auto"]);
  assert.equal(cfg.wizard?.lastRunCommand, "onboard");
  assert.equal(cfg.wizard?.lastRunMode, "local");
  assert.ok(cfg.meta?.lastTouchedAt);
  assert.ok(cfg.meta?.lastTouchedVersion);
});
