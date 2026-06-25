/**
 * `brigade expose` ( = `brigade bloody benchmark` ) — publish the gateway to
 * the public internet through a secure tunnel.
 *
 * The gateway WebSocket is unauthenticated and loopback-only by design, so we
 * never expose it directly. Instead we stand up a token-checking auth-proxy in
 * front of it (`core/tunnel/auth-proxy.ts`) and tunnel THAT — the public URL
 * carries a bearer token that the proxy enforces before any byte reaches the
 * gateway. The gateway's localhost guard is untouched.
 *
 *   brigade expose                 — start a cloudflare quick tunnel (token auto-gen)
 *   brigade expose --provider bore — self-hostable OSS tunnel
 *   brigade expose --insecure      — NO token gate (loud warning; explicit opt-in)
 *   brigade expose status          — show the active tunnel
 *   brigade expose stop            — tear down the active tunnel
 *
 * This is a foreground, long-lived command: it holds the tunnel open until
 * Ctrl-C (or `brigade expose stop` from another terminal).
 */

import process from "node:process";
import { randomBytes } from "node:crypto";

import chalk from "chalk";

import { loadConfig } from "../../core/config.js";
import { mutateConfigAtomic } from "../../config/io.js";
import { isProcessAlive, probeGateway } from "../../core/gateway-probe.js";
import { startTunnel, type RunningTunnel } from "../../core/tunnel/manager.js";
import { DEFAULT_PROVIDER, listProviderNames } from "../../core/tunnel/registry.js";
import { clearTunnelState, readTunnelState } from "../../core/tunnel/state.js";
import { DEFAULT_PORT, EXIT_FAILURE, EXIT_OK } from "../../protocol.js";

export interface ExposeCommandOptions {
  provider?: string;
  token?: string;
  insecure?: boolean;
  /** `--open` — synonym for `--insecure` (no token gate). */
  open?: boolean;
  relay?: string;
  command?: string;
  port?: number;
  verbose?: boolean;
  json?: boolean;
}

const LOOPBACK_HOST = "127.0.0.1";

/** Resolve the gateway port: flag → config → env → default. */
function resolveGatewayPort(opts: ExposeCommandOptions, cfg: ReturnType<typeof loadConfig>): number {
  if (typeof opts.port === "number" && opts.port > 0) return opts.port;
  const cfgPort = cfg.gateway?.port;
  if (typeof cfgPort === "number" && cfgPort > 0) return cfgPort;
  const envPort = Number(process.env.BRIGADE_PORT);
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  return DEFAULT_PORT;
}

/**
 * Resolve the bearer token. `--insecure` → none. `--token` → that. Otherwise
 * reuse `cfg.gateway.tunnel.token`, generating + persisting one on first run
 * so the same URL+token survives restarts.
 */
async function resolveToken(opts: ExposeCommandOptions, cfg: ReturnType<typeof loadConfig>): Promise<string | undefined> {
  if (opts.insecure || opts.open) return undefined;
  if (opts.token && opts.token.trim()) return opts.token.trim();
  const existing = cfg.gateway?.tunnel?.token;
  if (typeof existing === "string" && existing.length > 0) return existing;
  const generated = randomBytes(24).toString("base64url");
  await mutateConfigAtomic((current) => {
    const next = { ...current };
    const gateway = { ...(next.gateway ?? {}) };
    const tunnel = { ...(gateway.tunnel ?? {}) };
    tunnel.token = generated;
    gateway.tunnel = tunnel;
    next.gateway = gateway;
    return next;
  });
  return generated;
}

export async function runExposeCommand(opts: ExposeCommandOptions): Promise<void> {
  const cfg = loadConfig();
  const gatewayPort = resolveGatewayPort(opts, cfg);
  const provider = (opts.provider ?? cfg.gateway?.tunnel?.provider ?? DEFAULT_PROVIDER).trim();
  const relay = opts.relay ?? cfg.gateway?.tunnel?.relay;
  const command = opts.command ?? cfg.gateway?.tunnel?.command;

  if (!listProviderNames().includes(provider)) {
    console.error(chalk.red(`Unknown tunnel provider "${provider}". Known: ${listProviderNames().join(", ")}.`));
    process.exit(EXIT_FAILURE);
  }

  // The gateway must be up — the tunnel forwards to it. Probe before we open
  // anything to the world.
  const probe = await probeGateway({ host: LOOPBACK_HOST, port: gatewayPort });
  if (!probe.reachable) {
    console.error(chalk.red(`No gateway reachable on ${LOOPBACK_HOST}:${gatewayPort}.`));
    console.error(chalk.dim("Start it first:  brigade gateway run"));
    process.exit(EXIT_FAILURE);
  }

  // Refuse to silently re-expose if another tunnel is already live.
  const existing = readTunnelState();
  if (existing && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
    console.error(chalk.yellow(`A tunnel is already running (pid ${existing.pid}): ${existing.url}`));
    console.error(chalk.dim("Stop it first:  brigade expose stop"));
    process.exit(EXIT_FAILURE);
  }

  const token = await resolveToken(opts, cfg);
  const onLog = opts.verbose ? (line: string): void => console.error(chalk.dim(`  ${line}`)) : undefined;

  console.error(chalk.cyan(`Opening ${provider} tunnel to the gateway on :${gatewayPort}…`));

  let tunnel: RunningTunnel;
  try {
    tunnel = await startTunnel({ provider, gatewayHost: LOOPBACK_HOST, gatewayPort, token, relay, command, onLog });
  } catch (err) {
    console.error(chalk.red(`Failed to open tunnel: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(EXIT_FAILURE);
  }

  printBanner(tunnel, provider);

  // Tear down on Ctrl-C / SIGTERM so we never leave an orphaned public URL.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(chalk.dim(`\nClosing tunnel (${signal})…`));
    await tunnel.stop().catch(() => {});
    process.exit(EXIT_OK);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // The build-program action holds the process open after we return.
}

function printBanner(tunnel: RunningTunnel, provider: string): void {
  const line = chalk.dim("─".repeat(68));
  console.error("");
  console.error(line);
  console.error(`  ${chalk.bold("🌍 Your Brigade gateway is now public")}  ${chalk.dim(`(via ${provider})`)}`);
  console.error("");
  // Always show the CLEAN URL — the access key is never printed. It's
  // generated + stored automatically; the operator never sees or types it.
  console.error(`  ${chalk.bold("Public URL →")}  ${chalk.green.bold(tunnel.url)}`);
  console.error("");
  if (tunnel.secured) {
    console.error(`  ${chalk.green("🔒 Secured automatically")} ${chalk.dim("— a private access key is saved to your config.")}`);
    console.error(`  ${chalk.dim("You never type it. Need the full link for another device? ")}${chalk.cyan("brigade expose status --show-link")}`);
  } else {
    console.error(`  ${chalk.red.bold("⚠ OPEN MODE: no key — ANYONE who finds this URL controls your crew.")}`);
    console.error(`  ${chalk.dim("Drop --open to secure it automatically instead.")}`);
  }
  console.error("");
  console.error(`  ${chalk.dim("Stop anytime: brigade expose stop  ·  or press Ctrl-C")}`);
  console.error(line);
  console.error("");
}

export async function runExposeStatusCommand(opts: { json?: boolean; showLink?: boolean }): Promise<number> {
  const state = readTunnelState();
  if (!state || !isProcessAlive(state.pid)) {
    if (state) await clearTunnelState().catch(() => {});
    if (opts.json) console.log(JSON.stringify({ running: false }));
    else console.log("No tunnel is running.");
    return EXIT_OK;
  }
  // `--json` is for tooling and intentionally includes the full link (key and
  // all). The human-readable view hides the key unless `--show-link`.
  if (opts.json) {
    console.log(JSON.stringify({ running: true, ...state }));
    return EXIT_OK;
  }
  const uptimeS = Math.round((Date.now() - state.startedAt) / 1000);
  console.log(chalk.bold("Tunnel running"));
  console.log(`  provider   ${state.provider}`);
  console.log(`  url        ${state.url}`);
  if (state.secured && opts.showLink) {
    console.log(`  full link  ${chalk.green(state.urlWithToken)}  ${chalk.dim("(includes access key — share carefully)")}`);
  }
  console.log(`  gateway    127.0.0.1:${state.gatewayPort}  (via auth-proxy :${state.proxyPort})`);
  console.log(`  secured    ${state.secured ? chalk.green("yes (key handled automatically)") : chalk.red("NO (open mode)")}`);
  if (state.secured && !opts.showLink) {
    console.log(`  ${chalk.dim("(run with --show-link to reveal the full access link for another device)")}`);
  }
  console.log(`  pid        ${state.pid}`);
  console.log(`  uptime     ${uptimeS}s`);
  return EXIT_OK;
}

export async function runExposeStopCommand(opts: { json?: boolean }): Promise<number> {
  const state = readTunnelState();
  if (!state) {
    if (opts.json) console.log(JSON.stringify({ stopped: false, reason: "no-tunnel" }));
    else console.log("No tunnel is running.");
    return EXIT_OK;
  }
  if (isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch (err) {
      if (!opts.json) console.error(chalk.red(`Failed to signal tunnel pid ${state.pid}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  await clearTunnelState().catch(() => {});
  if (opts.json) console.log(JSON.stringify({ stopped: true, pid: state.pid }));
  else console.log(chalk.green(`Tunnel stopped (pid ${state.pid}).`));
  return EXIT_OK;
}
