/**
 * Tunnel provider contract — the seam behind `brigade expose`.
 *
 * A provider's only job is to take a LOCAL port (where Brigade's
 * token-checking auth-proxy is listening) and publish it on the internet,
 * returning the public URL. Providers never touch the gateway directly: the
 * auth-proxy already sits between the public URL and the (unauthenticated,
 * loopback-only) gateway, so a provider just forwards bytes.
 *
 * Built-in providers live in `./providers/`:
 *   - `cloudflare` — anonymous TryCloudflare quick tunnel (auto-managed binary)
 *   - `bore`       — the OSS `bore` client (self-hostable relay)
 *   - `custom`     — a user-supplied command template (`{port}` placeholder)
 *
 * Authoring a new provider = implement `TunnelProvider` and register it in
 * `./registry.ts`. Everything else (auth-proxy, token gate, state file,
 * lifecycle, CLI) is provider-agnostic.
 */

/** Options handed to a provider's `start()`. */
export interface TunnelStartOptions {
  /** Loopback host the auth-proxy is bound to (always `127.0.0.1`). */
  localHost: string;
  /** Port the auth-proxy is listening on — the tunnel points HERE, never at
   *  the raw gateway port. */
  localPort: number;
  /** Self-hosted relay address (`bore` / `custom`). Provider-defined default
   *  when omitted. */
  relay?: string;
  /** `custom` provider command template; `{port}` → `localPort`. */
  command?: string;
  /** Sink for provider log lines (binary stdout/stderr, status). */
  onLog?: (line: string) => void;
}

/** A running tunnel. `stop()` must be idempotent. */
export interface TunnelHandle {
  /** Provider name that produced this handle. */
  provider: string;
  /** Public URL (scheme included), e.g. `https://lively-fox-42.trycloudflare.com`
   *  or `http://bore.pub:41734`. Does NOT include the auth token. */
  url: string;
  /** Tear down the tunnel process/connection. Safe to call more than once. */
  stop(): Promise<void>;
}

/** A tunnel backend. */
export interface TunnelProvider {
  /** Stable id used in config + the `--provider` flag. */
  name: string;
  /** Human label for status output. */
  label: string;
  /** Whether this provider can run right now on this machine (binary present,
   *  command supplied, …). Cheap; called before `start()`. */
  isAvailable(opts?: TunnelStartOptions): Promise<TunnelAvailability>;
  /** Establish the tunnel. Rejects if the public URL can't be obtained. */
  start(opts: TunnelStartOptions): Promise<TunnelHandle>;
}

export interface TunnelAvailability {
  ok: boolean;
  /** Operator-facing reason when `ok === false` (how to fix it). */
  reason?: string;
}
