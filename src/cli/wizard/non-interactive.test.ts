import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runNonInteractiveSetup,
  BRIGADE_DEFAULT_GATEWAY_PORT,
  resolveGatewayPortDefault,
} from "./non-interactive.js";
import { initAuthProfiles, readProfiles } from "../../auth/profiles.js";
import type { BrigadeConfig } from "../../config/io.js";

// Each test gets its own tempdir + sets BRIGADE_STATE_DIR so the wizard's
// upsertApiKeyProfile call can't leak into ~/.brigade.
function withTempStateDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-onboard-test-"));
  const prev = process.env.BRIGADE_STATE_DIR;
  process.env.BRIGADE_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
    else process.env.BRIGADE_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("runNonInteractiveSetup: openrouter happy path produces reference shape", () => {
  withTempStateDir((dir) => {
    initAuthProfiles("main");
    const result = runNonInteractiveSetup({
      config: { version: 1 },
      workspace: path.join(dir, "workspace"),
      agentId: "main",
      provider: "openrouter",
      apiKey: "sk-or-v1-test",
      model: "openai/gpt-5.4",
      gatewayPort: 18789,
      gatewayToken: "f".repeat(48),
    });

    // Top-level shape — same sections as the reference.
    assert.equal(result.profileId, "openrouter:default");
    assert.equal(result.wroteSecret, true);
    assert.equal(result.config.gateway?.mode, "local");
    assert.equal(result.config.gateway?.port, 18789);
    assert.equal(result.config.gateway?.bind, "loopback");
    assert.equal(result.config.gateway?.auth?.token, "f".repeat(48));
    assert.equal(result.config.gateway?.tailscale?.mode, "off");
    assert.equal(result.config.gateway?.nodes?.denyCommands?.length, 8);
    assert.equal(result.config.session?.dmScope, "per-channel-peer");
    assert.equal(result.config.tools?.profile, "coding");

    // Auth meta in main config (shape only — actual key is in auth-profiles.json).
    assert.deepEqual(result.config.auth?.profiles?.["openrouter:default"], {
      provider: "openrouter",
      mode: "api_key",
    });

    // Plugins enabled.
    assert.equal(result.config.plugins?.entries?.openrouter?.enabled, true);

    // Model selection.
    const defaults = result.config.agents?.defaults as
      | { model?: { primary: string }; models?: Record<string, { alias?: string }> }
      | undefined;
    assert.equal(defaults?.model?.primary, "openai/gpt-5.4");
    assert.equal(defaults?.models?.["openai/gpt-5.4"]?.alias, "GPT-5.4 (via OpenRouter)");

    // Secret on disk — NOT in main config; in auth-profiles.json at mode 0600.
    const profiles = readProfiles("main");
    assert.equal(profiles.profiles["openrouter:default"]?.key, "sk-or-v1-test");
    assert.equal(profiles.profiles["openrouter:default"]?.provider, "openrouter");
    assert.equal(profiles.profiles["openrouter:default"]?.type, "api_key");
  });
});

test("runNonInteractiveSetup: ref mode writes structured keyRef object and DROPS the literal key field entirely", () => {
  withTempStateDir(() => {
    initAuthProfiles("main");
    runNonInteractiveSetup({
      config: {},
      workspace: "/tmp/ws",
      agentId: "main",
      provider: "openai",
      apiKey: "sk-real-key-shouldnt-be-stored",
      model: "gpt-5.4",
      secretInputMode: "ref",
    });
    const profiles = readProfiles("main");
    const profile = profiles.profiles["openai:default"];
    // The literal key field MUST be absent — no "" sentinel, no whitespace,
    // no anything. Same shape the reference's persisted-store sanitiser
    // produces. Cross-implementation reads see "no literal key" identically.
    assert.equal(profile?.key, undefined);
    assert.ok(!("key" in (profile ?? {})), "ref-mode profile must omit `key` entirely");
    // Structured keyRef at the top level (NOT under metadata).
    assert.deepEqual(profile?.keyRef, {
      source: "env",
      provider: "env",
      id: "OPENAI_API_KEY",
    });
    // metadata is dropped when empty (sanitizer).
    assert.equal(profile?.metadata, undefined);
  });
});

test("runNonInteractiveSetup: anthropic (token authMode) writes type:\"token\" credential", () => {
  withTempStateDir(() => {
    initAuthProfiles("main");
    runNonInteractiveSetup({
      config: {},
      workspace: "/tmp/ws",
      agentId: "main",
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-opus-4-7",
    });
    const profiles = readProfiles("main");
    const profile = profiles.profiles["anthropic:default"];
    assert.equal(profile?.type, "token");
    assert.equal(profile?.token, "sk-ant-test");
    assert.equal(profile?.key, undefined);
  });
});

test("runNonInteractiveSetup: anthropic ref mode writes tokenRef (not keyRef)", () => {
  withTempStateDir(() => {
    initAuthProfiles("main");
    runNonInteractiveSetup({
      config: {},
      workspace: "/tmp/ws",
      agentId: "main",
      provider: "anthropic",
      apiKey: "sk-ant-real-shouldnt-store",
      model: "claude-opus-4-7",
      secretInputMode: "ref",
    });
    const profiles = readProfiles("main");
    const profile = profiles.profiles["anthropic:default"];
    assert.equal(profile?.type, "token");
    assert.equal(profile?.token, undefined);
    assert.deepEqual(profile?.tokenRef, {
      source: "env",
      provider: "env",
      id: "ANTHROPIC_API_KEY",
    });
  });
});

test("runNonInteractiveSetup: ollama (noAuth) registers metadata without an API key", () => {
  withTempStateDir(() => {
    initAuthProfiles("main");
    const result = runNonInteractiveSetup({
      config: { version: 1 },
      workspace: "/tmp/ws",
      agentId: "main",
      provider: "ollama",
      // no apiKey on purpose
      model: "llama3.1:8b",
    });
    assert.equal(result.wroteSecret, false);
    assert.equal(result.config.auth?.profiles?.["ollama:default"]?.provider, "ollama");
    assert.equal(result.config.plugins?.entries?.ollama?.enabled, true);
  });
});

test("resolveGatewayPortDefault: explicit > BRIGADE_GATEWAY_PORT env var > built-in 18789", () => {
  // Built-in default — empty env, no explicit.
  assert.equal(resolveGatewayPortDefault(undefined, {}), 18789);
  // Env var override.
  assert.equal(resolveGatewayPortDefault(undefined, { BRIGADE_GATEWAY_PORT: "9090" }), 9090);
  // Explicit beats env var.
  assert.equal(resolveGatewayPortDefault(7777, { BRIGADE_GATEWAY_PORT: "9090" }), 7777);
  // Out-of-range env var falls back to built-in.
  assert.equal(resolveGatewayPortDefault(undefined, { BRIGADE_GATEWAY_PORT: "0" }), 18789);
  assert.equal(resolveGatewayPortDefault(undefined, { BRIGADE_GATEWAY_PORT: "99999" }), 18789);
  // Non-numeric env var falls back to built-in.
  assert.equal(resolveGatewayPortDefault(undefined, { BRIGADE_GATEWAY_PORT: "hello" }), 18789);
  // Whitespace-only env var falls back to built-in.
  assert.equal(resolveGatewayPortDefault(undefined, { BRIGADE_GATEWAY_PORT: "   " }), 18789);
});

test("runNonInteractiveSetup: defaults gateway port to 18789 when unset", () => {
  withTempStateDir(() => {
    initAuthProfiles("main");
    const result = runNonInteractiveSetup({
      config: { version: 1 },
      workspace: "/tmp/ws",
      agentId: "main",
      provider: "ollama",
      model: "llama3.1:8b",
    });
    assert.equal(result.config.gateway?.port, BRIGADE_DEFAULT_GATEWAY_PORT);
    assert.equal(BRIGADE_DEFAULT_GATEWAY_PORT, 18789);
  });
});

test("runNonInteractiveSetup: rejects unknown provider", () => {
  withTempStateDir(() => {
    initAuthProfiles("main");
    assert.throws(
      () =>
        runNonInteractiveSetup({
          config: { version: 1 },
          workspace: "/tmp/ws",
          agentId: "main",
          provider: "fakeprov",
          apiKey: "x",
        }),
      /Unknown provider/,
    );
  });
});

test("runNonInteractiveSetup: rejects model not in provider's catalog", () => {
  withTempStateDir(() => {
    initAuthProfiles("main");
    assert.throws(
      () =>
        runNonInteractiveSetup({
          config: { version: 1 },
          workspace: "/tmp/ws",
          agentId: "main",
          provider: "openai",
          apiKey: "sk-test",
          model: "claude-opus-4-7",
        }),
      /not in provider/,
    );
  });
});

test("runNonInteractiveSetup: missing apiKey for auth-required provider throws", () => {
  withTempStateDir(() => {
    initAuthProfiles("main");
    assert.throws(
      () =>
        runNonInteractiveSetup({
          config: { version: 1 },
          workspace: "/tmp/ws",
          agentId: "main",
          provider: "anthropic",
          model: "claude-opus-4-7",
        }),
      /requires an API key/,
    );
  });
});

test("runNonInteractiveSetup: fallback model (same provider) lands in fallbacks[]", () => {
  withTempStateDir(() => {
    initAuthProfiles("main");
    const result = runNonInteractiveSetup({
      config: { version: 1 },
      workspace: "/tmp/ws",
      agentId: "main",
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: "openai/gpt-5.4",
      fallbackModel: "openai/gpt-5.4-mini",
    });
    const defaults = result.config.agents?.defaults as
      | { model?: { primary: string; fallbacks?: string[] } }
      | undefined;
    assert.equal(defaults?.model?.primary, "openai/gpt-5.4");
    assert.deepEqual(defaults?.model?.fallbacks, ["openai/gpt-5.4-mini"]);
  });
});

test("runNonInteractiveSetup: re-running preserves existing user-customised values", () => {
  withTempStateDir(() => {
    initAuthProfiles("main");
    const baseline: BrigadeConfig = {
      version: 1,
      session: { dmScope: "main" }, // user previously set this
      tools: { profile: "full" }, // user previously set this
    };
    const result = runNonInteractiveSetup({
      config: baseline,
      workspace: "/tmp/ws",
      agentId: "main",
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: "openrouter/auto",
    });
    // Customised values must survive — wizard never clobbers existing settings.
    assert.equal(result.config.session?.dmScope, "main");
    assert.equal(result.config.tools?.profile, "full");
  });
});
