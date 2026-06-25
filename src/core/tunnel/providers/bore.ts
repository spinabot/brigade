/**
 * bore provider — the OSS `bore` client (https://github.com/ekzhang/bore, MIT).
 *
 * A tiny TCP tunnel. WebSocket + HTTP pass through transparently because bore
 * forwards raw TCP. The public relay `bore.pub` is anonymous; for a private
 * relay the operator runs `bore server` on their own box and passes
 * `--relay <host>` (or `cfg.gateway.tunnel.relay`) + sets `BORE_SECRET`.
 *
 * Trade-off vs cloudflare: bore gives `host:port` with NO TLS and no
 * subdomain — the public URL is `http://<relay>:<port>` (ws over the same).
 * That's the cost of a fully self-hostable, dependency-light OSS path.
 *
 * The `bore` binary is NOT auto-downloaded (it's a Rust release, and this is
 * the "advanced / self-host" path). Resolve order: `$BRIGADE_BORE_BIN` → PATH.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";

import type { TunnelAvailability, TunnelHandle, TunnelProvider, TunnelStartOptions } from "../types.js";

const DEFAULT_RELAY = "bore.pub";
// bore prints e.g. `listening at bore.pub:41734`.
const BORE_PORT_RE = /listening at\s+([^\s:]+):(\d+)/i;
const URL_WAIT_MS = 20_000;

function resolveBoreBin(): string | undefined {
  const envBin = process.env.BRIGADE_BORE_BIN?.trim();
  if (envBin && fs.existsSync(envBin)) return envBin;
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(probe, ["bore"], { encoding: "utf8" });
    if (res.status === 0) {
      const first = res.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (first) return process.platform === "win32" ? first : "bore";
    }
  } catch {
    // probe tool missing
  }
  return undefined;
}

export const boreProvider: TunnelProvider = {
  name: "bore",
  label: "bore (OSS TCP tunnel; self-hostable relay)",

  async isAvailable(): Promise<TunnelAvailability> {
    if (resolveBoreBin()) return { ok: true };
    return {
      ok: false,
      reason:
        "the `bore` binary was not found. Install it (https://github.com/ekzhang/bore — `cargo install bore-cli` " +
        "or download a release) and ensure it's on PATH, or set BRIGADE_BORE_BIN.",
    };
  },

  async start(opts: TunnelStartOptions): Promise<TunnelHandle> {
    const bin = resolveBoreBin();
    if (!bin) throw new Error("bore binary not found (set BRIGADE_BORE_BIN or install bore)");
    const relay = opts.relay?.trim() || DEFAULT_RELAY;
    const args = ["local", String(opts.localPort), "--to", relay];

    const child: ChildProcess = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* ignore */ }
        reject(new Error(`bore did not report a public port within ${URL_WAIT_MS / 1000}s`));
      }, URL_WAIT_MS);

      const scan = (chunk: Buffer): void => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) opts.onLog?.(line.trim());
        }
        const m = text.match(BORE_PORT_RE);
        if (m && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(`http://${m[1]}:${m[2]}`);
        }
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`bore exited (code ${code ?? "?"}) before reporting a port`));
      });
    });

    let stopped = false;
    return {
      provider: "bore",
      url,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        try { child.kill(); } catch { /* ignore */ }
      },
    };
  },
};
