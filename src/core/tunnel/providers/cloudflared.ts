/**
 * Cloudflare provider — anonymous TryCloudflare quick tunnel.
 *
 * The default `brigade expose` backend. No account, no signup: cloudflared
 * dials Cloudflare's edge and we get a random `https://<x>.trycloudflare.com`
 * URL that terminates TLS at the edge and proxies straight to our local
 * auth-proxy. WebSockets work by default (the gateway is WS-first).
 *
 * The `cloudflared` binary (Apache-2.0) is NOT a hard npm dependency — that
 * would add a ~30 MB download to every Brigade install. Instead we resolve it
 * lazily at expose time:
 *   1. `$BRIGADE_CLOUDFLARED_BIN`
 *   2. `cloudflared` on PATH (system install)
 *   3. a Brigade-managed copy in the OS cache dir
 *   4. download the official release into the cache dir (once)
 *
 * Caveat (documented in the research): TryCloudflare quick tunnels don't
 * support SSE and cap in-flight requests; that's fine for a personal WS
 * gateway. For a stable URL the operator can point a self-host provider at
 * their own relay instead.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as path from "node:path";

import { resolveOsCacheDir } from "../../../config/paths.js";
import type { TunnelAvailability, TunnelHandle, TunnelProvider, TunnelStartOptions } from "../types.js";

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const URL_WAIT_MS = 30_000;

function cloudflaredAssetName(): string {
  const arch =
    process.arch === "x64"
      ? "amd64"
      : process.arch === "arm64"
        ? "arm64"
        : process.arch === "ia32"
          ? "386"
          : process.arch === "arm"
            ? "arm"
            : "amd64";
  if (process.platform === "win32") return `cloudflared-windows-${arch === "arm64" ? "amd64" : arch}.exe`;
  if (process.platform === "darwin") return `cloudflared-darwin-${arch}.tgz`;
  return `cloudflared-linux-${arch}`;
}

function managedBinPath(): string {
  const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return path.join(resolveOsCacheDir(), "cloudflared", name);
}

/** First binary that exists across env → PATH → managed copy. */
function findExistingBinary(): string | undefined {
  const envBin = process.env.BRIGADE_CLOUDFLARED_BIN?.trim();
  if (envBin && fs.existsSync(envBin)) return envBin;

  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(probe, ["cloudflared"], { encoding: "utf8" });
    if (res.status === 0) {
      const first = res.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return first;
    }
  } catch {
    // probe tool missing — fall through to managed copy
  }

  const managed = managedBinPath();
  if (fs.existsSync(managed)) return managed;
  return undefined;
}

/** Download the official cloudflared release into the cache dir. */
async function downloadBinary(onLog?: (line: string) => void): Promise<string> {
  const asset = cloudflaredAssetName();
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  const dest = managedBinPath();
  await fsAsync.mkdir(path.dirname(dest), { recursive: true });
  onLog?.(`downloading cloudflared (${asset})…`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`cloudflared download failed (HTTP ${res.status}) from ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  if (asset.endsWith(".tgz")) {
    // macOS ships a gzipped tarball containing the `cloudflared` binary.
    const tmpTgz = `${dest}.tgz`;
    await fsAsync.writeFile(tmpTgz, buf);
    const tar = await import("tar");
    await tar.x({ file: tmpTgz, cwd: path.dirname(dest) });
    await fsAsync.rm(tmpTgz, { force: true });
    // The tarball extracts a file literally named `cloudflared`.
    const extracted = path.join(path.dirname(dest), "cloudflared");
    if (extracted !== dest && fs.existsSync(extracted)) {
      await fsAsync.rename(extracted, dest);
    }
  } else {
    await fsAsync.writeFile(dest, buf);
  }
  if (process.platform !== "win32") await fsAsync.chmod(dest, 0o755);
  onLog?.(`cloudflared ready at ${dest}`);
  return dest;
}

async function resolveBinary(onLog?: (line: string) => void): Promise<string> {
  return findExistingBinary() ?? (await downloadBinary(onLog));
}

export const cloudflareProvider: TunnelProvider = {
  name: "cloudflare",
  label: "Cloudflare (anonymous TryCloudflare quick tunnel)",

  async isAvailable(): Promise<TunnelAvailability> {
    // Always available — the binary is auto-downloaded on first use. We only
    // surface a soft note when there's no pre-existing copy.
    return { ok: true };
  },

  async start(opts: TunnelStartOptions): Promise<TunnelHandle> {
    const bin = await resolveBinary(opts.onLog);
    const target = `http://${opts.localHost}:${opts.localPort}`;
    const args = ["tunnel", "--no-autoupdate", "--url", target];

    const child: ChildProcess = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* ignore */ }
        reject(new Error(`cloudflared did not produce a public URL within ${URL_WAIT_MS / 1000}s`));
      }, URL_WAIT_MS);

      const scan = (chunk: Buffer): void => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) opts.onLog?.(line.trim());
        }
        const m = text.match(QUICK_URL_RE);
        if (m && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      // cloudflared logs the URL to stderr; scan both to be safe.
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
        reject(new Error(`cloudflared exited (code ${code ?? "?"}) before publishing a URL`));
      });
    });

    let stopped = false;
    return {
      provider: "cloudflare",
      url,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        try { child.kill(); } catch { /* ignore */ }
      },
    };
  },
};
