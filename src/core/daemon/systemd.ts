/**
 * Linux systemd-user adapter.
 *
 * Writes `~/.config/systemd/user/brigade-gateway.service` and runs
 * `systemctl --user daemon-reload && enable --now`. `Restart=on-failure`
 * makes the supervisor restart the daemon if it crashes; the unit auto-starts
 * at user login (lingering = a separate operator decision).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ServiceAdapter, ServiceContext, ServiceResult } from "./service.js";

const SERVICE_UNIT_NAME = "brigade-gateway.service";

function unitPath(): string {
	return path.join(os.homedir(), ".config", "systemd", "user", SERVICE_UNIT_NAME);
}

/** Build the unit file text. Pure / deterministic — used in tests. */
export function renderSystemdUnit(ctx: ServiceContext): string {
	const envLines = Object.entries(ctx.env)
		.map(([k, v]) => `Environment=${k}=${v}`)
		.join("\n");
	const execArgs = [ctx.nodePath, ctx.brigadeBin, "gateway", "run"]
		.map((s) => (s.includes(" ") ? `"${s.replace(/"/g, '\\"')}"` : s))
		.join(" ");
	return [
		"[Unit]",
		"Description=Brigade gateway (personal AI crew daemon)",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		`WorkingDirectory=${ctx.cwd}`,
		`ExecStart=${execArgs}`,
		"Restart=on-failure",
		"RestartSec=2",
		`StandardOutput=append:${ctx.stdoutPath}`,
		`StandardError=append:${ctx.stderrPath}`,
		envLines || "# no Environment= overrides",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

async function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
	return new Promise((resolve) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		p.stdout?.on("data", (d) => {
			out += d.toString();
		});
		p.stderr?.on("data", (d) => {
			err += d.toString();
		});
		p.on("error", (e) => resolve({ code: -1, stdout: out, stderr: `${err}\n${e.message}` }));
		p.on("close", (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
	});
}

export function systemdAdapter(): ServiceAdapter {
	return {
		platform: "linux",

		async install(ctx: ServiceContext): Promise<ServiceResult> {
			const file = unitPath();
			mkdirSync(path.dirname(file), { recursive: true });
			mkdirSync(path.dirname(ctx.stdoutPath), { recursive: true });
			writeFileSync(file, renderSystemdUnit(ctx));
			let r = await run("systemctl", ["--user", "daemon-reload"]);
			if (r.code !== 0) {
				return { ok: false, message: `systemctl daemon-reload failed: ${r.stderr.trim()}`, unitPath: file };
			}
			r = await run("systemctl", ["--user", "enable", "--now", SERVICE_UNIT_NAME]);
			if (r.code !== 0) {
				return { ok: false, message: `systemctl enable failed: ${r.stderr.trim()}`, unitPath: file };
			}
			return {
				ok: true,
				message:
					`Brigade gateway installed as a systemd user unit (${file}). ` +
					"For auto-start before login, also run: `loginctl enable-linger $USER`.",
				unitPath: file,
			};
		},

		async uninstall(): Promise<ServiceResult> {
			await run("systemctl", ["--user", "disable", "--now", SERVICE_UNIT_NAME]);
			const file = unitPath();
			if (existsSync(file)) {
				try {
					unlinkSync(file);
				} catch {
					/* ignore */
				}
			}
			await run("systemctl", ["--user", "daemon-reload"]);
			return { ok: true, message: "Brigade gateway uninstalled." };
		},

		async restart(): Promise<ServiceResult> {
			const r = await run("systemctl", ["--user", "restart", SERVICE_UNIT_NAME]);
			return { ok: r.code === 0, message: r.code === 0 ? "Brigade gateway restarted." : r.stderr.trim() };
		},

		async status(): Promise<{ installed: boolean; running: boolean; detail: string }> {
			const installed = existsSync(unitPath());
			if (!installed) return { installed: false, running: false, detail: "no systemd unit installed" };
			const r = await run("systemctl", ["--user", "is-active", SERVICE_UNIT_NAME]);
			const running = r.stdout.trim() === "active";
			return {
				installed: true,
				running,
				detail: running ? "systemctl is-active = active" : `systemctl is-active = ${r.stdout.trim() || "unknown"}`,
			};
		},
	};
}

export const _internal = { unitPath, readUnit: (): string | null => (existsSync(unitPath()) ? readFileSync(unitPath(), "utf8") : null) };
