import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

// The bundled skill script is plain ESM that ships without a build step, so it
// is loaded dynamically (untyped) rather than imported through tsc.
const scriptPath = path.resolve(process.cwd(), "skills/atlas-cloud-media/scripts/generate.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gen: any = await import(pathToFileURL(scriptPath).href);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atlas-media-test-"));
}

function bodyResponse(chunks: Uint8Array[], headers: Record<string, string>, url: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const response = new Response(stream, { status: 200, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("atlas-cloud-media buildPayload", () => {
  it("applies defaults and protects model/prompt", () => {
    const payload = gen.buildPayload(
      "image",
      "qwen-image-3.0/text-to-image",
      "studio portrait",
      '{"size":"1536*1024","model":"bad","prompt":"bad"}',
    );
    assert.deepEqual(payload, {
      model: "qwen-image-3.0/text-to-image",
      prompt: "studio portrait",
      size: "1536*1024",
    });
  });

  it("rejects non-object and invalid params JSON", () => {
    assert.throws(() => gen.buildPayload("video", "m", "p", "[1]"), /JSON object/);
    assert.throws(() => gen.buildPayload("video", "m", "p", "{nope"), /not valid JSON/);
  });
});

describe("atlas-cloud-media outputUrl", () => {
  it("rejects non-https and credentialed URLs", () => {
    for (const value of ["http://cdn.example/o.png", "https://user@cdn.example/o.png"]) {
      assert.throws(() => gen.outputUrl({ outputs: [value] }), /unsafe/);
    }
  });
  it("accepts https", () => {
    assert.equal(gen.outputUrl({ outputs: ["https://cdn.example/o.mp4"] }), "https://cdn.example/o.mp4");
  });
});

describe("atlas-cloud-media parseCli", () => {
  it("requires a prompt unless resuming", () => {
    assert.throws(() => gen.parseCli(["image"]), /--prompt is required/);
    assert.equal(gen.parseCli(["video", "--resume", "abc"]).values.resume, "abc");
  });
  it("uses a 12 minute default ceiling and per-kind default models", () => {
    const { values } = gen.parseCli(["video", "--prompt", "x"]);
    assert.equal(values.timeout, 720);
    assert.equal(values.model, "bytedance/seedance-2.0-fast/text-to-video");
  });
});

describe("atlas-cloud-media waitForPrediction", () => {
  it("returns once completed", async () => {
    let polls = 0;
    const result = await gen.waitForPrediction(
      { id: "p1", status: "processing" },
      async () => ({ data: { id: "p1", status: ++polls < 2 ? "processing" : "completed" } }),
      { timeoutSeconds: 10, pollSeconds: 0, sleep: async () => {} },
    );
    assert.equal(result.status, "completed");
    assert.equal(polls, 2);
  });

  it("reports the prediction id on timeout", async () => {
    await assert.rejects(
      gen.waitForPrediction(
        { id: "pred-123", status: "processing" },
        async () => ({ id: "pred-123", status: "processing" }),
        { timeoutSeconds: 0.05, pollSeconds: 0.01, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) },
      ),
      (error: Error & { predictionId?: string }) =>
        /pred-123/.test(error.message) && error.predictionId === "pred-123",
    );
  });

  it("reports the prediction id on failure", async () => {
    await assert.rejects(
      gen.waitForPrediction({ id: "p9", status: "failed", error: "boom" }, async () => ({}), {
        timeoutSeconds: 1,
        pollSeconds: 0,
        sleep: async () => {},
      }),
      /boom.*p9/,
    );
  });
});

describe("atlas-cloud-media download", () => {
  const url = "https://cdn.example/out.png";

  it("saves a complete download and sends no credentials", async () => {
    const dir = tmpDir();
    const dest = path.join(dir, "ok.png");
    let seenHeaders: Record<string, string> = {};
    await gen.download(url, dest, async (_u: string, init: { headers: Record<string, string> }) => {
      seenHeaders = init.headers;
      return bodyResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], { "content-length": "5" }, url);
    });
    assert.deepEqual([...fs.readFileSync(dest)], [1, 2, 3, 4, 5]);
    assert.equal(Object.keys(seenHeaders).some((k) => k.toLowerCase() === "authorization"), false);
    assert.deepEqual(fs.readdirSync(dir), ["ok.png"]);
  });

  it("rejects a truncated download and leaves no file", async () => {
    const dir = tmpDir();
    const dest = path.join(dir, "short.png");
    await assert.rejects(
      gen.download(url, dest, async () => bodyResponse([new Uint8Array([1, 2, 3])], { "content-length": "10" }, url)),
      /truncated: received 3 of 10/,
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("rejects declared and actual oversize bodies", async () => {
    const dir = tmpDir();
    await assert.rejects(
      gen.download(url, path.join(dir, "a"), async () =>
        bodyResponse([], { "content-length": String(gen.MAX_DOWNLOAD_BYTES + 1) }, url),
      ),
      /64 MiB/,
    );
    const big = new Uint8Array(gen.MAX_DOWNLOAD_BYTES / 2 + 1);
    await assert.rejects(
      gen.download(url, path.join(dir, "b"), async () => bodyResponse([big, big], {}, url)),
      /64 MiB/,
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("rejects redirects to non-https URLs", async () => {
    const dir = tmpDir();
    await assert.rejects(
      gen.download(url, path.join(dir, "r"), async () =>
        bodyResponse([new Uint8Array([1])], {}, "http://cdn.example/out.png"),
      ),
      /unsafe URL/,
    );
  });
});
