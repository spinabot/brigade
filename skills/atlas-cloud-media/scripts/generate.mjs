#!/usr/bin/env node
// Generate Atlas Cloud image or video media with bounded polling.
// Plain ESM on purpose: skills ship as-is (no build step) and Node >= 22.12 is
// guaranteed by Brigade itself. Uses only Node built-ins and global fetch.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const API_BASE = "https://api.atlascloud.ai/api/v1";
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TIMEOUT_SECONDS = 720; // 12 minutes, covers slow video jobs
export const DEFAULT_POLL_SECONDS = 2;
const USER_AGENT = "Brigade-AtlasCloudMedia/1.0";
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export const DEFAULT_MODELS = {
  image: "qwen-image-3.0/text-to-image",
  video: "bytedance/seedance-2.0-fast/text-to-video",
};
const DEFAULT_PARAMS = {
  image: { size: "1024*1024" },
  video: { duration: 4, resolution: "720p" },
};
const FAILED_STATUSES = new Set(["failed", "timeout", "cancelled", "canceled"]);

export class MediaError extends Error {
  /** @param {string} message @param {{ predictionId?: string }} [options] */
  constructor(message, options = {}) {
    super(message);
    this.name = "MediaError";
    this.predictionId = options.predictionId;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} url @param {string} apiKey @param {unknown} [payload] */
async function requestJson(url, apiKey, payload) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  const init = { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    init.method = "POST";
    init.body = JSON.stringify(payload);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new MediaError(`Atlas Cloud request failed: ${describe(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 2048);
    throw new MediaError(`Atlas Cloud HTTP ${response.status}: ${detail}`);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new MediaError("Atlas Cloud returned an invalid JSON response");
  }
  if (!isRecord(result)) throw new MediaError("Atlas Cloud returned an invalid JSON response");
  return result;
}

/** @param {Record<string, unknown>} response */
export function predictionData(response) {
  const data = response.data ?? response;
  if (!isRecord(data)) throw new MediaError("Atlas Cloud returned invalid prediction data");
  return data;
}

function assertSafeUrl(value, message) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new MediaError(message);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new MediaError(message);
  }
}

/** Return the first output URL, rejecting anything that is not plain HTTPS. */
export function outputUrl(prediction) {
  const outputs = prediction.outputs;
  const value = Array.isArray(outputs) ? outputs[0] : undefined;
  if (typeof value !== "string") {
    throw new MediaError("Atlas Cloud prediction completed without an output URL");
  }
  assertSafeUrl(value, "Atlas Cloud returned an unsafe output URL");
  return value;
}

/** Build the request body; `model` and `prompt` can never be overridden by params. */
export function buildPayload(kind, model, prompt, paramsJson) {
  const params = { ...DEFAULT_PARAMS[kind] };
  if (paramsJson) {
    let value;
    try {
      value = JSON.parse(paramsJson);
    } catch (error) {
      throw new MediaError(`--params-json is not valid JSON: ${describe(error)}`);
    }
    if (!isRecord(value)) throw new MediaError("--params-json must contain a JSON object");
    Object.assign(params, value);
  }
  delete params.model;
  delete params.prompt;
  return { model, prompt, ...params };
}

/**
 * Download `url` to `destination` without credentials. Fails (and leaves no
 * file behind) if the response is unsafe, too large, or shorter/longer than the
 * server declared.
 */
export async function download(url, destination, fetchImpl = fetch) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.part`,
  );
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "image/*,video/*,application/octet-stream", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MediaError(`Media download failed: ${describe(error)}`);
  }
  try {
    if (response.url) assertSafeUrl(response.url, "Media download redirected to an unsafe URL");
    if (!response.ok || !response.body) {
      throw new MediaError(`Media download failed: HTTP ${response.status}`);
    }
    const declaredHeader = response.headers.get("content-length");
    const declared = declaredHeader && /^\d+$/.test(declaredHeader) ? Number(declaredHeader) : null;
    if (declared !== null && declared > MAX_DOWNLOAD_BYTES) {
      throw new MediaError("Generated media exceeds the 64 MiB download limit");
    }
    // Content-Length counts encoded bytes; only compare it to decoded bytes when
    // no content-encoding was applied.
    const encoding = (response.headers.get("content-encoding") ?? "identity").toLowerCase();
    const comparable = declared !== null && encoding === "identity";

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    let total = 0;
    const output = fs.createWriteStream(temporary);
    try {
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
          throw new MediaError("Generated media exceeds the 64 MiB download limit");
        }
        if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
      }
    } catch (error) {
      output.destroy();
      if (error instanceof MediaError) throw error;
      throw new MediaError(`Media download failed: ${describe(error)}`);
    }
    await new Promise((resolve, reject) => {
      output.once("error", reject);
      output.end(resolve);
    });
    if (total === 0) throw new MediaError("Media download returned an empty body");
    if (comparable && total !== declared) {
      throw new MediaError(`Media download was truncated: received ${total} of ${declared} bytes`);
    }
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function defaultOutput(kind, url) {
  const ext = path.extname(new URL(url).pathname) || (kind === "image" ? ".png" : ".mp4");
  return path.join(process.cwd(), `atlas-${kind}${ext}`);
}

/**
 * Poll a prediction until it completes, fails, or `timeoutSeconds` elapses.
 * On timeout the error carries the prediction id so a paid job can be resumed.
 */
export async function waitForPrediction(initial, poll, { timeoutSeconds, pollSeconds, sleep }) {
  const id = initial.id;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let prediction = initial;
  for (;;) {
    const status = String(prediction.status ?? "").toLowerCase();
    if (status === "completed" || status === "succeeded") return prediction;
    if (FAILED_STATUSES.has(status)) {
      throw new MediaError(
        `Atlas Cloud generation failed: ${prediction.error || status} (prediction id: ${id})`,
        { predictionId: id },
      );
    }
    if (Date.now() + pollSeconds * 1000 > deadline) {
      throw new MediaError(
        `Atlas Cloud generation is still running after ${timeoutSeconds}s. ` +
          `Prediction id: ${id}. Re-run with --resume ${id} to keep waiting and download it.`,
        { predictionId: id },
      );
    }
    await sleep(pollSeconds * 1000);
    prediction = predictionData(await poll(id));
  }
}

function expandHome(value) {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

async function generate(values, kind) {
  const apiKey = (process.env.ATLASCLOUD_API_KEY ?? "").trim();
  if (!apiKey) throw new MediaError("ATLASCLOUD_API_KEY is not set");

  let submitted;
  if (values.resume) {
    submitted = { id: values.resume, status: "processing" };
  } else {
    const endpoint = kind === "image" ? "generateImage" : "generateVideo";
    const payload = buildPayload(kind, values.model, values.prompt, values["params-json"]);
    submitted = predictionData(await requestJson(`${API_BASE}/model/${endpoint}`, apiKey, payload));
    if (typeof submitted.id !== "string" || !submitted.id) {
      throw new MediaError("Atlas Cloud did not return a prediction id");
    }
  }

  const prediction = await waitForPrediction(
    submitted,
    (id) => requestJson(`${API_BASE}/model/prediction/${encodeURIComponent(id)}`, apiKey),
    {
      timeoutSeconds: values.timeout,
      pollSeconds: values["poll-seconds"],
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  );

  const url = outputUrl(prediction);
  const destination = path.resolve(values.out ? expandHome(values.out) : defaultOutput(kind, url));
  try {
    await download(url, destination);
  } catch (error) {
    if (error instanceof MediaError) {
      throw new MediaError(`${error.message} (prediction id: ${submitted.id})`, {
        predictionId: submitted.id,
      });
    }
    throw error;
  }
  return destination;
}

const USAGE = `Usage: generate.mjs <image|video> --prompt <text> [--model <id>] [--out <file>]
                    [--params-json <json>] [--timeout <seconds>] [--poll-seconds <n>]
       generate.mjs <image|video> --resume <prediction-id> [--out <file>] [--timeout <seconds>]`;

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      prompt: { type: "string" },
      model: { type: "string" },
      out: { type: "string" },
      "params-json": { type: "string" },
      resume: { type: "string" },
      timeout: { type: "string", default: String(DEFAULT_TIMEOUT_SECONDS) },
      "poll-seconds": { type: "string", default: String(DEFAULT_POLL_SECONDS) },
    },
  });
  const kind = positionals[0];
  if (positionals.length !== 1 || (kind !== "image" && kind !== "video")) {
    throw new MediaError("expected exactly one of: image, video");
  }
  if (!values.resume && !values.prompt) throw new MediaError("--prompt is required");
  const timeout = Number(values.timeout);
  const pollSeconds = Number(values["poll-seconds"]);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new MediaError("--timeout must be positive");
  if (!Number.isFinite(pollSeconds) || pollSeconds < 0) {
    throw new MediaError("--poll-seconds must not be negative");
  }
  return {
    kind,
    values: {
      ...values,
      model: values.model || DEFAULT_MODELS[kind],
      timeout,
      "poll-seconds": pollSeconds,
    },
  };
}

async function main() {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${describe(error)}\n${USAGE}`);
    return 2;
  }
  try {
    console.log(await generate(parsed.values, parsed.kind));
    return 0;
  } catch (error) {
    console.error(`error: ${describe(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await main();
}
