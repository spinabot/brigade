/**
 * custom provider — run any tunnel command and scrape its public URL.
 *
 * The "bring your own OSS tunnel" escape hatch: frp, sish, chisel, zrok,
 * localhost.run / ssh -R, pinggy, … anything that prints a public URL to
 * stdout/stderr. The operator supplies a command template via `--command`
 * (or `cfg.gateway.tunnel.command`); `{port}` is replaced with the local
 * auth-proxy port.
 *
 * Examples:
 *   --command "ssh -R 80:localhost:{port} nokey@localhost.run"
 *   --command "sish-client ... -R {port}"
 *   --command "frpc http --local-port {port} --server-addr my.relay --sd brigade"
 *
 * We parse the first `http(s)://…` URL the command emits. If a custom tool
 * uses a different scheme/format, set `--relay` to override the printed URL
 * outright (we then skip URL detection and just keep the process alive).
 */

import { spawn, type ChildProcess } from "node:child_process";

import type { TunnelAvailability, TunnelHandle, TunnelProvider, TunnelStartOptions } from "../types.js";

const ANY_URL_RE = /\bhttps?:\/\/[^\s'"]+/i;
const URL_WAIT_MS = 30_000;

/** Split a command string into argv, honouring simple double-quotes. */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? "");
  return out;
}

export const customProvider: TunnelProvider = {
  name: "custom",
  label: "custom (user-supplied tunnel command)",

  async isAvailable(opts?: TunnelStartOptions): Promise<TunnelAvailability> {
    if (opts?.command && opts.command.trim()) return { ok: true };
    return {
      ok: false,
      reason: "the custom provider needs a command — pass --command \"…{port}…\" or set cfg.gateway.tunnel.command.",
    };
  },

  async start(opts: TunnelStartOptions): Promise<TunnelHandle> {
    const template = opts.command?.trim();
    if (!template) throw new Error("custom provider requires --command");
    const rendered = template.replaceAll("{port}", String(opts.localPort));
    const argv = tokenize(rendered);
    if (argv.length === 0) throw new Error("custom provider command is empty");

    const child: ChildProcess = spawn(argv[0] as string, argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    // If the operator pre-declares the public URL via --relay, trust it and
    // skip detection (covers tools that don't print a parseable URL).
    const forced = opts.relay?.trim();

    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const done = (u: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(u);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* ignore */ }
        reject(new Error(`custom tunnel did not emit a URL within ${URL_WAIT_MS / 1000}s (use --relay to set it explicitly)`));
      }, URL_WAIT_MS);

      const scan = (chunk: Buffer): void => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) opts.onLog?.(line.trim());
        }
        if (!forced) {
          const m = text.match(ANY_URL_RE);
          if (m) done(m[0]);
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
        reject(new Error(`custom tunnel exited (code ${code ?? "?"}) before emitting a URL`));
      });

      // Forced URL: resolve as soon as the process is spawned (give it a tick).
      if (forced) setTimeout(() => done(forced), 250);
    });

    let stopped = false;
    return {
      provider: "custom",
      url,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        try { child.kill(); } catch { /* ignore */ }
      },
    };
  },
};
