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
 *   brigade expose --show-qr       — also print a scannable QR to pair the app
 *   brigade expose status          — show the active tunnel
 *   brigade expose stop            — tear down the active tunnel
 *
 * This is a foreground, long-lived command: it holds the tunnel open until
 * Ctrl-C (or `brigade expose stop` from another terminal).
 */

import process from "node:process";
import { randomBytes } from "node:crypto";

import chalk from "chalk";
import qrcodeTerminal from "qrcode-terminal";

import { loadConfig } from "../../core/config.js";
import { mutateConfigAtomic } from "../../config/io.js";
import { isProcessAlive, probeGateway } from "../../core/gateway-probe.js";
import { resolveClientToken, resolveGatewayTokens } from "../../core/gateway-auth.js";
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
  /** `--show-qr` — render a scannable QR of the public link right after the
   *  tunnel comes up, so the Brigade app pairs in one command. This is the only
   *  place a QR is rendered; there is no `status` variant. */
  showQr?: boolean;
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
  const probe = await probeGateway({ host: LOOPBACK_HOST, port: gatewayPort, token: resolveClientToken(cfg.gateway?.auth) });
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

  // Token model: when the GATEWAY itself enforces auth (gateway.auth.tokens),
  // the proxy forwards the client's token straight through, so a public client
  // must present a GATEWAY token. We therefore gate the tunnel with exactly that
  // list — one token works through both proxy and gateway, and ALL of them are
  // valid (multi-token over the tunnel too). --open can't loosen this: the
  // gateway would reject an unauthed client regardless. Otherwise the gateway is
  // open, so we use the tunnel's own auto-token (or none under --open/--insecure).
  const gatewayTokens = resolveGatewayTokens(cfg.gateway?.auth);
  let tokens: string[];
  if (gatewayTokens.length > 0) {
    tokens = gatewayTokens;
    if (opts.open || opts.insecure) {
      console.error(chalk.yellow("Note: the gateway requires a token, so the tunnel stays secured (--open ignored)."));
    }
  } else {
    const exposeToken = await resolveToken(opts, cfg);
    tokens = exposeToken ? [exposeToken] : [];
  }
  const onLog = opts.verbose ? (line: string): void => console.error(chalk.dim(`  ${line}`)) : undefined;

  console.error(chalk.cyan(`Opening ${provider} tunnel to the gateway on :${gatewayPort}…`));

  let tunnel: RunningTunnel;
  try {
    tunnel = await startTunnel({ provider, gatewayHost: LOOPBACK_HOST, gatewayPort, tokens, relay, command, onLog });
  } catch (err) {
    console.error(chalk.red(`Failed to open tunnel: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(EXIT_FAILURE);
  }

  printBanner(tunnel, provider, opts.showQr === true);

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

function printBanner(tunnel: RunningTunnel, provider: string, showQr: boolean): void {
  const line = chalk.dim("─".repeat(68));
  console.error("");
  console.error(line);
  console.error(`  ${chalk.bold("🌍 Your Brigade gateway is now public")}  ${chalk.dim(`(via ${provider})`)}`);
  console.error("");
  // Always show the CLEAN URL — the access key is never printed. It's
  // generated + stored automatically; the operator never sees or types it.
  console.error(`  ${chalk.bold("Public URL →")}  ${chalk.green.bold(tunnel.url)}`);
  console.error("");
  // `--show-qr` renders the scannable link right under the URL it encodes, so
  // the app pairs in ONE command. `urlWithToken` IS the clean url when the
  // tunnel is open (manager.ts only appends `?token=` when secured), so one
  // field covers both modes.
  if (showQr) {
    printQr(tunnel.urlWithToken, tunnel.secured);
    console.error("");
  }
  if (tunnel.secured) {
    console.error(`  ${chalk.green("🔒 Secured automatically")} ${chalk.dim("— a private access key is saved to your config.")}`);
    console.error(`  ${chalk.dim("You never type it. Need the full link for another device? ")}${chalk.cyan("brigade expose status --show-link")}`);
  } else {
    console.error(`  ${chalk.red.bold("⚠ OPEN MODE: no key — ANYONE who finds this URL controls your crew.")}`);
    console.error(`  ${chalk.dim("Drop --open to secure it automatically instead.")}`);
  }
  // Keep pairing discoverable for anyone who didn't pass the flag.
  if (!showQr) {
    console.error(`  ${chalk.dim("📱 Pairing the Brigade app? Re-run with")} ${chalk.cyan("--show-qr")} ${chalk.dim("for a scannable code.")}`);
  }
  console.error("");
  console.error(`  ${chalk.dim("Stop anytime: brigade expose stop  ·  or press Ctrl-C")}`);
  console.error(line);
  console.error("");
}

/**
 * Render `link` as a scannable QR on stderr, inline in the expose banner
 * (stdout stays clean for piping). The caller owns the surrounding blank
 * lines. `qrcode-terminal` is synchronous despite the callback shape, so the
 * rows land in order between the lines printed either side of this call.
 *
 * Two things this does that a bare `generate()` doesn't, both of which decide
 * whether a phone actually locks onto the code:
 *
 *  1. **Forces the polarity.** In `small` mode the library draws a LIGHT module
 *     as a block glyph (`█`) and a DARK module as a space — i.e. the code is
 *     carried by the foreground colour. Left to the terminal's own palette that
 *     renders correctly on a dark theme and *inverted* on a light one, where
 *     many scanners simply give up. Pinning bright-white-on-black makes it
 *     scan the same in either theme.
 *  2. **Widens the quiet zone.** The library emits a 1-module border; the spec
 *     wants 4. We pad with light modules — spaces would read as DARK and eat
 *     the margin rather than extend it.
 */
function printQr(link: string, secured: boolean): void {
  const LIGHT = "█"; // a light module — and therefore the quiet-zone fill
  console.error(`  ${chalk.bold("📱 Scan to connect")} ${chalk.dim("(open the Brigade app and scan this):")}`);
  qrcodeTerminal.generate(link, { small: true }, (qr: string) => {
    const rows = qr.replace(/\n+$/, "").split("\n");
    // Drop the library's own 1-module border rows (all `▄` on top / all `▀` on
    // the bottom). Half of each of those cells is the terminal background —
    // dark — so keeping them would lay a dark stripe *inside* the light margin
    // below, i.e. a ring around the code. Our own full-block rows replace them.
    if (rows.length > 1 && /^▄+$/.test(rows[0] ?? "")) rows.shift();
    if (rows.length > 1 && /^▀+$/.test(rows[rows.length - 1] ?? "")) rows.pop();
    const width = Math.max(...rows.map((r) => r.length));
    const side = LIGHT.repeat(3);
    const margin = LIGHT.repeat(width + 6);
    // One printed row is TWO modules tall (half-block encoding), so two margin
    // rows top and bottom clear the 4-module quiet zone the spec asks for.
    const framed = [margin, margin, ...rows.map((r) => `${side}${r.padEnd(width, LIGHT)}${side}`), margin, margin];
    for (const row of framed) console.error(`  ${chalk.bgBlack.whiteBright(row)}`);
  });
  console.error(`  ${chalk.dim(secured ? "Encodes the full link incl. the access key — keep it on-screen only." : "Open mode — no key in the link.")}`);
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
