/**
 * macOS launchd adapter.
 *
 * Writes `~/Library/LaunchAgents/com.brigade.gateway.plist` (a user agent, no
 * sudo needed) and loads it via `launchctl bootstrap gui/$UID`. `KeepAlive`
 * makes the OS restart the daemon if it crashes; `RunAtLoad` brings it up at
 * login. Uninstall is `launchctl bootout` + unlink.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SERVICE_LABEL, type ServiceAdapter, type ServiceContext, type ServiceResult } from "./service.js";

function plistPath(): string {
	return path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

/** Escape a string for XML CDATA-style appearance inside a plist <string>. */
function xml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build the plist XML text for `ctx`. Pure / deterministic — used in tests. */
export function renderLaunchdPlist(ctx: ServiceContext): string {
	const envLines = Object.entries(ctx.env)
		.map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`)
		.join("\n");
	const programArgs = [ctx.nodePath, ctx.brigadeBin, "gateway", "run"];
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		`  <key>Label</key><string>${SERVICE_LABEL}</string>`,
		"  <key>ProgramArguments</key>",
		"  <array>",
		...programArgs.map((a) => `    <string>${xml(a)}</string>`),
		"  </array>",
		"  <key>RunAtLoad</key><true/>",
		"  <key>KeepAlive</key><true/>",
		`  <key>WorkingDirectory</key><string>${xml(ctx.cwd)}</string>`,
		`  <key>StandardOutPath</key><string>${xml(ctx.stdoutPath)}</string>`,
		`  <key>StandardErrorPath</key><string>${xml(ctx.stderrPath)}</string>`,
		"  <key>ProcessType</key><string>Background</string>",
		Object.keys(ctx.env).length > 0
			? "  <key>EnvironmentVariables</key>\n  <dict>\n" + envLines + "\n  </dict>"
			: "  <!-- no env overrides -->",
		"</dict>",
		"</plist>",
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

export function launchdAdapter(): ServiceAdapter {
	const uid = process.getuid?.() ?? -1;
	const domain = `gui/${uid}`;

	return {
		platform: "darwin",

		async install(ctx: ServiceContext): Promise<ServiceResult> {
			const file = plistPath();
			mkdirSync(path.dirname(file), { recursive: true });
			mkdirSync(path.dirname(ctx.stdoutPath), { recursive: true });
			writeFileSync(file, renderLaunchdPlist(ctx));
			// Bootstrap (idempotent: if already loaded, error is harmless after we bootout below)
			await run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
			const r = await run("launchctl", ["bootstrap", domain, file]);
			if (r.code !== 0) {
				return { ok: false, message: `launchctl bootstrap failed: ${r.stderr.trim() || r.stdout.trim()}`, unitPath: file };
			}
			return { ok: true, message: `Brigade gateway installed as a launchd user agent (${file}).`, unitPath: file };
		},

		async uninstall(): Promise<ServiceResult> {
			const file = plistPath();
			await run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
			if (existsSync(file)) {
				try {
					unlinkSync(file);
				} catch {
					/* ignore */
				}
			}
			return { ok: true, message: `Brigade gateway uninstalled${existsSync(file) ? " (plist remained)" : ""}.` };
		},

		async restart(): Promise<ServiceResult> {
			await run("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`]);
			return { ok: true, message: "Brigade gateway restarted." };
		},

		async status(): Promise<{ installed: boolean; running: boolean; detail: string }> {
			const installed = existsSync(plistPath());
			if (!installed) return { installed: false, running: false, detail: "no launchd plist installed" };
			const r = await run("launchctl", ["print", `${domain}/${SERVICE_LABEL}`]);
			const running = r.code === 0 && /state\s*=\s*running/i.test(r.stdout);
			return {
				installed: true,
				running,
				detail: running ? "launchd reports running" : "registered, not currently running",
			};
		},
	};
}

// Re-exported for tests that want to inspect a plist without installing.
export const _internal = { plistPath, readPlist: (): string | null => (existsSync(plistPath()) ? readFileSync(plistPath(), "utf8") : null) };
