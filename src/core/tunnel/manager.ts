/**
 * Tunnel manager — wires the auth-proxy + a provider into one running tunnel
 * and records its state.
 *
 * Flow:
 *   1. start the token-checking auth-proxy in front of the gateway
 *   2. start the chosen provider, pointing it at the auth-proxy's local port
 *   3. compose the public URL (with `?token=` when secured) + persist state
 *
 * `stop()` tears down provider then proxy and clears the state file. The
 * gateway is never touched — it keeps running localhost-only.
 */

import { startAuthProxy, type AuthProxyHandle } from "./auth-proxy.js";
import { getProvider } from "./registry.js";
import { clearTunnelState, writeTunnelState } from "./state.js";
import type { TunnelHandle } from "./types.js";

export interface StartTunnelOptions {
  /** Provider name (resolved through the registry). */
  provider: string;
  /** Gateway host/port the auth-proxy forwards to. */
  gatewayHost: string;
  gatewayPort: number;
  /** Bearer token gating the public URL. `undefined` → insecure pass-through. */
  token?: string;
  /** Self-hosted relay (`bore` / `custom`). */
  relay?: string;
  /** `custom` provider command template. */
  command?: string;
  /** Log sink for proxy + provider diagnostics. */
  onLog?: (line: string) => void;
}

export interface RunningTunnel {
  provider: string;
  /** Public URL without the token. */
  url: string;
  /** Public URL with `?token=` appended when secured (else identical to `url`). */
  urlWithToken: string;
  /** Local auth-proxy port. */
  proxyPort: number;
  /** Whether the token gate is active. */
  secured: boolean;
  /** Tear everything down. Idempotent. */
  stop(): Promise<void>;
}

/** Append the token as a query param without clobbering an existing query. */
function withToken(url: string, token: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

export async function startTunnel(opts: StartTunnelOptions): Promise<RunningTunnel> {
  const provider = getProvider(opts.provider);

  // Fail fast on a provider that can't run (missing binary, missing command)
  // BEFORE we open the proxy.
  const avail = await provider.isAvailable({
    localHost: opts.gatewayHost,
    localPort: opts.gatewayPort,
    relay: opts.relay,
    command: opts.command,
    onLog: opts.onLog,
  });
  if (!avail.ok) {
    throw new Error(`tunnel provider "${opts.provider}" is unavailable: ${avail.reason ?? "unknown reason"}`);
  }

  let proxy: AuthProxyHandle | undefined;
  let handle: TunnelHandle | undefined;
  try {
    proxy = await startAuthProxy({
      gatewayHost: opts.gatewayHost,
      gatewayPort: opts.gatewayPort,
      token: opts.token,
      onLog: opts.onLog,
    });

    handle = await provider.start({
      localHost: "127.0.0.1",
      localPort: proxy.port,
      relay: opts.relay,
      command: opts.command,
      onLog: opts.onLog,
    });

    const secured = proxy.secured;
    const url = handle.url;
    const urlWithToken = secured && opts.token ? withToken(url, opts.token) : url;

    await writeTunnelState({
      url,
      urlWithToken,
      provider: opts.provider,
      pid: process.pid,
      proxyPort: proxy.port,
      gatewayPort: opts.gatewayPort,
      secured,
      startedAt: Date.now(),
    });

    const proxyRef = proxy;
    const handleRef = handle;
    let stopped = false;
    return {
      provider: opts.provider,
      url,
      urlWithToken,
      proxyPort: proxy.port,
      secured,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        try { await handleRef.stop(); } catch { /* ignore */ }
        try { await proxyRef.stop(); } catch { /* ignore */ }
        await clearTunnelState().catch(() => {});
      },
    };
  } catch (err) {
    // Roll back partial startup so we never leak a proxy/provider process.
    try { await handle?.stop(); } catch { /* ignore */ }
    try { await proxy?.stop(); } catch { /* ignore */ }
    throw err;
  }
}
