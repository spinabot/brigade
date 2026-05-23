/**
 * Cross-platform service-supervisor abstraction.
 *
 * A "B2B daemon" is a service: it must come up at boot and restart on crash.
 * Brigade ships one supervisor adapter per platform — launchd on macOS,
 * systemd-user on Linux, Task Scheduler on Windows — and dispatches the CLI
 * (`brigade gateway install / uninstall / restart`) through this seam.
 *
 * Each adapter is pure-ish: it writes a unit file, shells out to the OS
 * service manager, and reports a simple result. No long-running state lives
 * here; the OS owns the supervision.
 */

import os from "node:os";
import path from "node:path";

/** Stable identifier the OS sees for the Brigade service. */
export const SERVICE_LABEL = "com.brigade.gateway";

export interface ServiceContext {
	/** Absolute path to the node executable that will run the daemon. */
	nodePath: string;
	/** Absolute path to brigade's entry script (the .mjs `bin` file). */
	brigadeBin: string;
	/** Working directory for the daemon process; defaults to the user's home. */
	cwd: string;
	/** Extra env vars to inject — `BRIGADE_STATE_DIR`, log levels, etc. */
	env: Record<string, string>;
	/** Where the supervisor should write the daemon's stdout. */
	stdoutPath: string;
	/** Where the supervisor should write stderr. */
	stderrPath: string;
}

export interface ServiceResult {
	ok: boolean;
	/** Human-readable summary; safe to print as-is. */
	message: string;
	/** Where the unit file was written (install only). */
	unitPath?: string;
}

export interface ServiceAdapter {
	/** Platform label for log lines. */
	readonly platform: "darwin" | "linux" | "win32";
	/** Write the unit, register it, and start it. */
	install(ctx: ServiceContext): Promise<ServiceResult>;
	/** Stop + deregister + remove the unit file. Idempotent. */
	uninstall(): Promise<ServiceResult>;
	/** Restart the running daemon (stop + start). */
	restart(): Promise<ServiceResult>;
	/** Quick check of registration + run state. */
	status(): Promise<{ installed: boolean; running: boolean; detail: string }>;
}

/** Build the current platform's adapter, or throw with a clear message. */
export async function resolveServiceAdapter(): Promise<ServiceAdapter> {
	switch (os.platform()) {
		case "darwin": {
			const { launchdAdapter } = await import("./launchd.js");
			return launchdAdapter();
		}
		case "linux": {
			const { systemdAdapter } = await import("./systemd.js");
			return systemdAdapter();
		}
		case "win32": {
			const { schtasksAdapter } = await import("./schtasks.js");
			return schtasksAdapter();
		}
		default:
			throw new Error(
				`brigade gateway install is not supported on ${os.platform()}. ` +
					"Use a process supervisor (pm2, supervisord, runit, …) to launch `brigade gateway run` instead.",
			);
	}
}

/** Build a `ServiceContext` from the running brigade process. */
export function buildServiceContext(overrides: Partial<ServiceContext> = {}): ServiceContext {
	const home = os.homedir();
	const stateDir = process.env.BRIGADE_STATE_DIR?.trim() || path.join(home, ".brigade");
	const logsDir = path.join(stateDir, "logs");
	return {
		nodePath: overrides.nodePath ?? process.execPath,
		brigadeBin: overrides.brigadeBin ?? path.resolve(process.argv[1] ?? "brigade.mjs"),
		cwd: overrides.cwd ?? home,
		env: {
			...(process.env.BRIGADE_STATE_DIR ? { BRIGADE_STATE_DIR: process.env.BRIGADE_STATE_DIR } : {}),
			...(overrides.env ?? {}),
		},
		stdoutPath: overrides.stdoutPath ?? path.join(logsDir, "daemon.stdout.log"),
		stderrPath: overrides.stderrPath ?? path.join(logsDir, "daemon.stderr.log"),
	};
}
