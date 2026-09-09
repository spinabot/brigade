import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error The opt-in live-probe helper is JavaScript outside src.
import { providerReportErrorCategory, validateProviderAnswerText, validateProviderReportMetadata } from "../../../scripts/lib/tideline-live-report-validation.mjs";

const routes = { models: ["example/model"], providers: ["Example Provider"] };
function response() {
  return {
    id: "gen-123-fixture",
    model: "example/model",
    provider: "Example Provider",
    choices: [{ finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0003, is_byok: false,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 15 },
      completion_tokens_details: { reasoning_tokens: 5 },
      cost_details: { upstream_inference_cost: 0.0002, upstream_inference_prompt_cost: 0.0001, upstream_inference_completions_cost: 0.0001 } },
  };
}

test("retains token, cache and cost accounting while discarding unknown provider data", () => {
  const clean = response();
  const data = { ...clean, debug: { request: "untrusted-fixture" }, usage: {
    ...clean.usage, arbitrary: { payload: "x".repeat(100_000) },
    prompt_tokens_details: { ...clean.usage.prompt_tokens_details, unexpected: "untrusted-fixture" },
    cost_details: { ...clean.usage.cost_details, debug: "untrusted-fixture" },
  } };
  const result = validateProviderReportMetadata(data, routes);
  assert.deepEqual(result, { generationId: clean.id, returnedModel: clean.model, provider: clean.provider, usage: clean.usage, finishReason: "stop" });
  assert.doesNotMatch(JSON.stringify(result), /arbitrary|unexpected|untrusted-fixture|debug/);
  data.usage.prompt_tokens_details.cached_tokens = 0;
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 60, "report must not share provider objects");
});

test("rejects malformed and oversized identity, routing and finish metadata without echoing values", () => {
  for (const data of [
    { ...response(), id: "../untrusted-fixture" },
    { ...response(), id: "gen-untrusted-fixture\n" },
    { ...response(), id: "x".repeat(129) },
    { ...response(), id: { nested: "untrusted-fixture" } },
    { ...response(), model: "untrusted-fixture" },
    { ...response(), provider: "untrusted-fixture".repeat(10_000) },
    { ...response(), choices: [{ finish_reason: { payload: "untrusted-fixture" } }] },
    { ...response(), choices: [{ finish_reason: "untrusted-fixture" }] },
  ]) {
    assert.throws(() => validateProviderReportMetadata(data, routes), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.doesNotMatch(error.message, /untrusted-fixture/);
      return true;
    });
  }
});

test("rejects nonnumeric, negative, fractional and excessive accounting", () => {
  for (const value of ["100", {}, [], null, Number.NaN, Infinity, -1, 1.5, 2_000_001]) {
    const data = { ...response(), usage: { ...response().usage, prompt_tokens: value } };
    assert.throws(() => validateProviderReportMetadata(data, routes), /usage.prompt_tokens/);
  }
  for (const value of ["0.01", null, -0.1, Number.NaN, Infinity, 101]) {
    const data = { ...response(), usage: { ...response().usage, cost: value } };
    assert.throws(() => validateProviderReportMetadata(data, routes), /usage.cost/);
  }
  assert.throws(() => validateProviderReportMetadata({ ...response(), usage: { ...response().usage, prompt_tokens_details: { cached_tokens: "60" } } }, routes), /cached_tokens/);
  assert.throws(() => validateProviderReportMetadata({ ...response(), usage: { ...response().usage, prompt_tokens_details: [] } }, routes), /prompt_tokens_details/);
  assert.throws(() => validateProviderReportMetadata({ ...response(), usage: null }, routes), /usage/);
});

test("preserves zero cost and absent optional accounting without inventing cache hits", () => {
  const data = { ...response(), usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 }, choices: [{ finish_reason: "length" }] };
  assert.deepEqual(validateProviderReportMetadata(data, routes).usage, data.usage);
  assert.equal(validateProviderReportMetadata(data, routes).finishReason, "length");
});

test("only bounded answer text can reach report serialization", () => {
  assert.equal(validateProviderAnswerText('{"answer":"UNKNOWN"}'), '{"answer":"UNKNOWN"}');
  assert.equal(validateProviderAnswerText(null), null);
  for (const value of [{ answer: "untrusted-fixture" }, ["untrusted-fixture"], 42, "x".repeat(16_385)]) {
    assert.throws(() => validateProviderAnswerText(value), /Invalid provider report field: answer/);
  }
});

test("report failures retain only known error categories, never external exception text", () => {
  assert.equal(providerReportErrorCategory(new TypeError("untrusted-fixture")), "TypeError");
  assert.equal(providerReportErrorCategory({ name: "untrusted-fixture", message: "untrusted-fixture" }), "UnknownError");
  assert.equal(providerReportErrorCategory(null), "UnknownError");
});

test("malformed provider metadata never reaches a saved live-probe report", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tideline-live-report-test-"));
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const canary = "untrusted-provider-report-canary";
  const childSource = `
    globalThis.fetch = async input => {
      if (String(input) === "https://openrouter.ai/api/v1/models") return Response.json({ data: [
        { id: "google/gemini-2.5-flash", pricing: { prompt: "0.0000001", completion: "0.000001" } }
      ] });
      if (String(input) !== "https://openrouter.ai/api/v1/chat/completions") throw new Error("Unexpected network access");
      return Response.json({ id: "gen-valid-fixture", model: "google/gemini-2.5-flash", provider: "Google AI Studio",
        usage: { prompt_tokens: 100, completion_tokens: 1, cost: { untrusted: ${JSON.stringify(canary)} } },
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }] });
    };
    process.argv = [process.execPath, "scripts/test-tideline-live-models.mjs", "--models=google/gemini-2.5-flash", "--credential-stdin"];
    await import("./scripts/test-tideline-live-models.mjs");
  `;
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
      cwd: repository,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
      input: "inert-test-credential\n", encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 1, child.stderr);
    const directories = fs.readdirSync(temporary).filter(name => name.startsWith("tideline-live-models-"));
    assert.equal(directories.length, 1);
    const text = fs.readFileSync(path.join(temporary, directories[0]!, "results.json"), "utf8");
    assert.doesNotMatch(text, new RegExp(canary));
    const report = JSON.parse(text);
    assert.equal(report.failed, true);
    assert.equal(report.requests[0].failed, true);
    assert.equal(report.requests[0].error, "TypeError");
    assert.equal(report.requests[0].usage, undefined);
    assert.equal(report.requests[0].generationId, undefined, "reject metadata before mutating the report entry");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
