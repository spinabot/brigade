import { strict as assert } from "node:assert";
import * as http from "node:http";
import { describe, it, before, after } from "node:test";

import { startAuthProxy, type AuthProxyHandle } from "./auth-proxy.js";
import { DEFAULT_PROVIDER, getProvider, listProviderNames } from "./registry.js";

/**
 * The tunnel seam. Two things are pinned here:
 *   1. the provider registry resolves known names + rejects unknowns, and
 *   2. the auth-proxy's TOKEN GATE — the entire security story of `expose`.
 *      An open gateway behind a token-checking proxy is only as safe as the
 *      gate, so we prove 401-on-missing/wrong-token and pass-through-on-correct.
 */

describe("tunnel registry", () => {
  it("knows the built-in providers and defaults to cloudflare", () => {
    const names = listProviderNames();
    assert.ok(names.includes("cloudflare"));
    assert.ok(names.includes("bore"));
    assert.ok(names.includes("custom"));
    assert.equal(DEFAULT_PROVIDER, "cloudflare");
  });

  it("resolves a known provider", () => {
    assert.equal(getProvider("cloudflare").name, "cloudflare");
  });

  it("throws on an unknown provider", () => {
    assert.throws(() => getProvider("nope"), /unknown tunnel provider "nope"/);
  });
});

describe("auth-proxy token gate", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let proxy: AuthProxyHandle;
  const TOKEN = "s3cr3t-token";

  before(async () => {
    // Stand-in "gateway": replies 200 with a marker body to anything that
    // reaches it, so a 200 proves the proxy forwarded.
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("reached-gateway");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address();
    upstreamPort = typeof addr === "object" && addr ? addr.port : 0;
    proxy = await startAuthProxy({ gatewayHost: "127.0.0.1", gatewayPort: upstreamPort, token: TOKEN });
  });

  after(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const get = (pathAndQuery: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxy.port, path: pathAndQuery, method: "GET", headers },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });

  it("rejects requests with no token", async () => {
    const res = await get("/");
    assert.equal(res.status, 401);
  });

  it("rejects requests with the wrong token", async () => {
    const res = await get("/?token=wrong");
    assert.equal(res.status, 401);
  });

  it("forwards requests with the correct token in the query", async () => {
    const res = await get(`/?token=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(res.body, "reached-gateway");
  });

  it("forwards requests with a correct Bearer header", async () => {
    const res = await get("/", { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200);
  });

  it("forwards requests with a correct x-brigade-token header", async () => {
    const res = await get("/", { "x-brigade-token": TOKEN });
    assert.equal(res.status, 200);
  });
});

describe("auth-proxy insecure mode", () => {
  it("passes everything through when no token is set", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address();
    const upstreamPort = typeof addr === "object" && addr ? addr.port : 0;
    const proxy = await startAuthProxy({ gatewayHost: "127.0.0.1", gatewayPort: upstreamPort });
    assert.equal(proxy.secured, false);

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxy.port, path: "/", method: "GET" }, (res) =>
        resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 200);

    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});
