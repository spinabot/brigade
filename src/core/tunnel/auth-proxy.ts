/**
 * Token-checking reverse proxy that fronts the gateway for `brigade expose`.
 *
 * WHY THIS EXISTS — the gateway WebSocket is UNAUTHENTICATED: every connection
 * is granted full `operator.admin` scope (see `core/server.ts` connection
 * handler). The only thing protecting it today is the hard localhost-bind
 * guard in `startServer`. Tunnelling the raw gateway to the internet would
 * therefore publish full agent control to anyone who learns the URL.
 *
 * Rather than bolt auth onto the security-sensitive gateway connection path
 * (and force every local client to start sending a token), `expose` keeps the
 * gateway exactly as-is and publishes THIS proxy instead. The proxy:
 *   1. binds to 127.0.0.1 on an ephemeral port,
 *   2. requires a bearer token on every HTTP request AND every WS upgrade,
 *   3. forwards authed traffic to 127.0.0.1:<gatewayPort>.
 *
 * The tunnel client connects to this proxy; the gateway never sees an
 * unauthenticated remote. This is precisely the "front the gateway with a
 * reverse-proxy that adds your own auth" path the gateway's own guard
 * recommends.
 *
 * Token may arrive three ways (so browsers, CLIs, and WS clients all work):
 *   - `Authorization: Bearer <token>`
 *   - `x-brigade-token: <token>` header
 *   - `?token=<token>` query string  (the form the printed public URL uses)
 *
 * When started WITHOUT a token (`brigade expose --insecure`) the proxy is a
 * plain pass-through — every byte reaches the gateway. That mode is gated
 * behind an explicit flag + a loud warning in the CLI.
 */

import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { extractToken, matchesAnyToken } from "../gateway-auth.js";

export interface AuthProxyOptions {
  /** Gateway host to forward to (loopback). */
  gatewayHost: string;
  /** Gateway port to forward to. */
  gatewayPort: number;
  /** Valid tokens — a client presenting ANY one is allowed through. Empty/omit
   *  → pass-through (insecure). Supersedes the former single `token`. */
  tokens?: readonly string[];
  /** Sink for proxy diagnostics. */
  onLog?: (line: string) => void;
}

export interface AuthProxyHandle {
  /** Loopback port the proxy is listening on. */
  port: number;
  /** Whether a token gate is active. */
  secured: boolean;
  /** Stop accepting connections and close the listener. Idempotent. */
  stop(): Promise<void>;
}

// Token extraction + constant-time matching live in `core/gateway-auth.ts` so
// the expose proxy and the gateway's own connection gate share ONE
// implementation and can never drift.

/**
 * Start the auth-proxy. Resolves once it is listening; the returned handle
 * carries the chosen port. The proxy lives until `stop()` (or the process
 * exits).
 */
export async function startAuthProxy(opts: AuthProxyOptions): Promise<AuthProxyHandle> {
  const { gatewayHost, gatewayPort, tokens, onLog } = opts;
  const tokenList = tokens ?? [];
  const secured = tokenList.length > 0;
  const sockets = new Set<Duplex>();

  const authorize = (reqUrl: string | undefined, headers: http.IncomingHttpHeaders): boolean => {
    if (!secured) return true;
    return matchesAnyToken(tokenList, extractToken(reqUrl, headers));
  };

  const server = http.createServer((req, res) => {
    // Plain HTTP request path. The gateway is WS-first, but a few HTTP routes
    // exist (plugin httpRoutes, health). Gate then forward verbatim.
    if (!authorize(req.url, req.headers)) {
      res.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" });
      res.end("401 Unauthorized — append ?token=<token> or send Authorization: Bearer <token>\n");
      return;
    }
    const upstream = http.request(
      {
        host: gatewayHost,
        port: gatewayPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      onLog?.(`http upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("502 Bad Gateway\n");
    });
    req.pipe(upstream);
  });

  // WebSocket (and any other Upgrade) path — the primary traffic. We can't use
  // the parsed `req` to forward, so reconstruct the raw HTTP upgrade request
  // from `req.rawHeaders` and pipe both directions at the socket level.
  server.on("upgrade", (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));

    if (!authorize(req.url, req.headers)) {
      clientSocket.write(
        "HTTP/1.1 401 Unauthorized\r\n" +
          "Connection: close\r\n" +
          "WWW-Authenticate: Bearer\r\n" +
          "Content-Length: 0\r\n\r\n",
      );
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(gatewayPort, gatewayHost, () => {
      // Replay the upgrade request line + headers, then any buffered head.
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    const teardown = (): void => {
      try { clientSocket.destroy(); } catch { /* ignore */ }
      try { upstream.destroy(); } catch { /* ignore */ }
    };
    upstream.on("error", (err) => {
      onLog?.(`ws upstream error: ${err.message}`);
      teardown();
    });
    clientSocket.on("error", teardown);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    // Port 0 → OS assigns an ephemeral port. Bound to loopback only.
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) throw new Error("auth-proxy failed to acquire a local port");
  onLog?.(`auth-proxy listening on 127.0.0.1:${port} → ${gatewayHost}:${gatewayPort} (${secured ? "token-gated" : "OPEN/insecure"})`);

  let stopped = false;
  return {
    port,
    secured,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const s of sockets) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
