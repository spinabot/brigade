/**
 * Cross-platform "who's holding this port?" helper.
 *
 * Mirror of openclaw's `src/infra/ports-inspect.ts` + `ports-format.ts`,
 * Brigade-shaped to the single use case we have today: when
 * `brigade gateway run` fails because port 7777 is already bound, OR
 * when `brigade gateway status` wants to surface the listener,
 * print one line that names the PID and (if we can extract it) the
 * command line of the holder.
 *
 * Implementation strategy — same as openclaw:
 *
 *   - Windows: parse `netstat -ano -p tcp` + enrich with `tasklist /FI`
 *   - macOS:   `lsof -nP -iTCP:<port> -sTCP:LISTEN -FpFcn`
 *   - Linux:   `ss -H -ltnp` (modern) → fallback to `lsof`
 *
 * All shell-outs are bounded by a 1500ms timeout so a hung tool can't
 * hang `brigade gateway status`. Failures degrade silently — the caller
 * gets `[]` and prints "(no listener info available on this platform)".
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

export interface PortListener {
  pid: number;
  /** Process binary name, e.g. "node.exe". */
  command?: string;
  /** Full command line if the platform tools surface it; undefined otherwise. */
  commandLine?: string;
  /** Bound address, e.g. "127.0.0.1:7777". */
  address?: string;
}

const SHELL_TIMEOUT_MS = 1500;

/**
 * Return the listeners on `port` for the current platform. Resolves with
 * `[]` if no listener is found OR the platform tool isn't available OR the
 * shell-out timed out. Never throws — diagnostic code path only.
 */
export function inspectPortListeners(port: number): PortListener[] {
  try {
    if (process.platform === "win32") return inspectWindows(port);
    if (process.platform === "darwin") return inspectDarwin(port);
    return inspectLinux(port);
  } catch {
    return [];
  }
}

/** Pretty-print a single listener. Matches openclaw's `ports-format.ts:126-132`. */
export function formatPortListener(l: PortListener): string {
  const cmd = l.commandLine || l.command || "unknown";
  const addr = l.address ? ` (${l.address})` : "";
  return `pid ${l.pid}: ${cmd}${addr}`;
}

/* ────────────────────────── platform impls ─────────────────────── */

function inspectWindows(port: number): PortListener[] {
  // `netstat -ano -p tcp` outputs columns:
  //   Proto  Local Address    Foreign Address  State       PID
  // We filter for LISTENING + the target port.
  const ns = runShell("netstat", ["-ano", "-p", "tcp"]);
  if (!ns) return [];
  const listeners: PortListener[] = [];
  const portStr = `:${port}`;
  for (const raw of ns.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !/listening/i.test(line) || !line.includes(portStr)) continue;
    const cols = line.split(/\s+/);
    // Format: ["TCP", "<local>", "<foreign>", "LISTENING", "<pid>"]
    if (cols.length < 5) continue;
    const local = cols[1];
    const pidStr = cols[cols.length - 1];
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    listeners.push({ pid, address: local, command: lookupWindowsImage(pid) });
  }
  return listeners;
}

function lookupWindowsImage(pid: number): string | undefined {
  // `tasklist /FI "PID eq <pid>" /FO CSV /NH` returns:
  //   "Image","PID","Session","Sess#","MemUsage"
  const out = runShell("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  if (!out) return undefined;
  const first = out.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!first) return undefined;
  // Strip wrapping quotes from the first CSV column.
  const m = first.match(/^"([^"]+)"/);
  return m?.[1];
}

function inspectDarwin(port: number): PortListener[] {
  // `lsof -nP -iTCP:<port> -sTCP:LISTEN -FpcfP` produces records:
  //   p<pid>\nc<command>\nf<fd>\nP<protocol>\n...
  const out = runShell("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpcfP"]);
  return parseLsofOutput(out);
}

function inspectLinux(port: number): PortListener[] {
  // Prefer `ss` (modern, ships with iproute2). Fall back to `lsof`.
  const ss = runShell("ss", ["-H", "-ltnp", `sport = :${port}`]);
  if (ss) {
    const listeners: PortListener[] = [];
    for (const raw of ss.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      // Format: LISTEN 0 4096 127.0.0.1:7777 0.0.0.0:* users:(("node",pid=12345,fd=20))
      const addrM = line.match(/(\S+:\d+)\s+\S+\s+users:\(/);
      const pidM = line.match(/pid=(\d+)/);
      const cmdM = line.match(/users:\(\("([^"]+)"/);
      if (pidM) {
        listeners.push({
          pid: Number(pidM[1]),
          address: addrM?.[1],
          command: cmdM?.[1],
        });
      }
    }
    return listeners;
  }
  // Fallback: lsof same flags as macOS.
  const lsof = runShell("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpcfP"]);
  return parseLsofOutput(lsof);
}

function parseLsofOutput(out: string | undefined): PortListener[] {
  if (!out) return [];
  const listeners: PortListener[] = [];
  let cur: Partial<PortListener> = {};
  const flush = (): void => {
    if (cur.pid) listeners.push(cur as PortListener);
    cur = {};
  };
  for (const raw of out.split(/\r?\n/)) {
    if (raw.length < 1) continue;
    const tag = raw[0];
    const rest = raw.slice(1);
    if (tag === "p") {
      flush();
      cur = { pid: Number(rest) };
    } else if (tag === "c") {
      cur.command = rest;
    } else if (tag === "n") {
      cur.address = rest;
    }
    // skip f, P, etc.
  }
  flush();
  return listeners.filter((l) => Number.isInteger(l.pid) && l.pid > 0);
}

function runShell(cmd: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: SHELL_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (result.status !== 0) return undefined;
    return typeof result.stdout === "string" ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}
