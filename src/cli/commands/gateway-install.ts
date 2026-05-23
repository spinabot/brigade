/**
 * `brigade gateway install / uninstall / restart` — register Brigade as an OS
 * service so the gateway survives reboots and crashes.
 *
 * Platform mapping:
 *   - macOS  → launchd LaunchAgent
 *   - Linux  → systemd user unit
 *   - Windows→ Task Scheduler (XML-defined, restart-on-failure)
 *
 * The supervisor IS the restart loop; Brigade doesn't try to babysit itself.
 */

import { buildServiceContext, resolveServiceAdapter } from "../../core/daemon/service.js";

export async function runGatewayInstall(opts: { json?: boolean } = {}): Promise<number> {
	try {
		const adapter = await resolveServiceAdapter();
		const ctx = buildServiceContext();
		const result = await adapter.install(ctx);
		if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(`${result.message}\n`);
		return result.ok ? 0 : 1;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}
}

export async function runGatewayUninstall(opts: { json?: boolean } = {}): Promise<number> {
	try {
		const adapter = await resolveServiceAdapter();
		const result = await adapter.uninstall();
		if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(`${result.message}\n`);
		return result.ok ? 0 : 1;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}
}

export async function runGatewayRestart(opts: { json?: boolean } = {}): Promise<number> {
	try {
		const adapter = await resolveServiceAdapter();
		const result = await adapter.restart();
		if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(`${result.message}\n`);
		return result.ok ? 0 : 1;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}
}
