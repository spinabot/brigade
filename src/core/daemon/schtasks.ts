/**
 * Windows Task Scheduler adapter.
 *
 * Brigade is registered as a per-user scheduled task that:
 *   - runs at logon,
 *   - restarts on failure (3 attempts, 1-minute interval),
 *   - executes `node brigade.mjs gateway run` with the operator's env.
 *
 * Implemented by writing an XML task definition + `schtasks /Create /XML` so
 * we get the restart-on-failure semantics that the simpler `/SC ONLOGON`
 * shortcut doesn't expose. Uninstall is `schtasks /Delete /TN BrigadeGateway`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ServiceAdapter, ServiceContext, ServiceResult } from "./service.js";

const TASK_NAME = "BrigadeGateway";

function xmlPath(): string {
	// Stash the task XML alongside Brigade state so an uninstall can re-read it.
	const stateDir = process.env.BRIGADE_STATE_DIR?.trim() || path.join(os.homedir(), ".brigade");
	return path.join(stateDir, "daemon", "brigade-gateway-task.xml");
}

/** Escape one value for embedding inside an XML attribute / element body. */
function xml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Build the Task Scheduler XML for `ctx`. Pure / deterministic — used in tests. */
export function renderSchtasksXml(ctx: ServiceContext): string {
	const envBlock = Object.entries(ctx.env)
		.map(([k, v]) => `        <Environment Variable="${xml(k)}" Value="${xml(v)}"/>`)
		.join("\n");
	const args = [`"${ctx.brigadeBin}"`, "gateway", "run"].join(" ");
	return [
		'<?xml version="1.0" encoding="UTF-16"?>',
		'<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
		"  <RegistrationInfo>",
		"    <Description>Brigade gateway (personal AI crew daemon)</Description>",
		"  </RegistrationInfo>",
		"  <Triggers>",
		"    <LogonTrigger>",
		"      <Enabled>true</Enabled>",
		"    </LogonTrigger>",
		"  </Triggers>",
		"  <Settings>",
		"    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
		"    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
		"    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
		"    <AllowHardTerminate>true</AllowHardTerminate>",
		"    <StartWhenAvailable>true</StartWhenAvailable>",
		"    <RestartOnFailure>",
		"      <Interval>PT1M</Interval>",
		"      <Count>3</Count>",
		"    </RestartOnFailure>",
		"  </Settings>",
		"  <Actions>",
		"    <Exec>",
		`      <Command>${xml(ctx.nodePath)}</Command>`,
		`      <Arguments>${xml(args)}</Arguments>`,
		`      <WorkingDirectory>${xml(ctx.cwd)}</WorkingDirectory>`,
		envBlock ? "      <EnvironmentVariables>" : "",
		envBlock,
		envBlock ? "      </EnvironmentVariables>" : "",
		"    </Exec>",
		"  </Actions>",
		"</Task>",
		"",
	]
		.filter((line) => line !== "")
		.join("\n");
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

export function schtasksAdapter(): ServiceAdapter {
	return {
		platform: "win32",

		async install(ctx: ServiceContext): Promise<ServiceResult> {
			const file = xmlPath();
			mkdirSync(path.dirname(file), { recursive: true });
			mkdirSync(path.dirname(ctx.stdoutPath), { recursive: true });
			// Task Scheduler XML is UTF-16 with BOM.
			writeFileSync(file, "﻿" + renderSchtasksXml(ctx), { encoding: "utf16le" });
			// Replace any existing task atomically (`/F` = force overwrite).
			const r = await run("schtasks", ["/Create", "/TN", TASK_NAME, "/XML", file, "/F"]);
			if (r.code !== 0) {
				return { ok: false, message: `schtasks /Create failed: ${r.stderr.trim() || r.stdout.trim()}`, unitPath: file };
			}
			// Run it once immediately so the operator doesn't have to log out + back in.
			await run("schtasks", ["/Run", "/TN", TASK_NAME]);
			return { ok: true, message: `Brigade gateway installed as a Scheduled Task (${TASK_NAME}).`, unitPath: file };
		},

		async uninstall(): Promise<ServiceResult> {
			await run("schtasks", ["/End", "/TN", TASK_NAME]);
			const r = await run("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
			const file = xmlPath();
			if (existsSync(file)) {
				try {
					unlinkSync(file);
				} catch {
					/* ignore */
				}
			}
			return {
				ok: r.code === 0,
				message: r.code === 0 ? "Brigade gateway uninstalled." : r.stderr.trim() || "no task to remove",
			};
		},

		async restart(): Promise<ServiceResult> {
			await run("schtasks", ["/End", "/TN", TASK_NAME]);
			const r = await run("schtasks", ["/Run", "/TN", TASK_NAME]);
			return { ok: r.code === 0, message: r.code === 0 ? "Brigade gateway restarted." : r.stderr.trim() };
		},

		async status(): Promise<{ installed: boolean; running: boolean; detail: string }> {
			const r = await run("schtasks", ["/Query", "/TN", TASK_NAME, "/FO", "CSV", "/NH"]);
			if (r.code !== 0) return { installed: false, running: false, detail: "no scheduled task installed" };
			const line = r.stdout.split(/\r?\n/).find((l) => l.includes(TASK_NAME)) ?? "";
			// CSV: "TaskName","Next Run Time","Status"
			const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ""));
			const status = cols[2] ?? "unknown";
			return { installed: true, running: status === "Running", detail: `Task Scheduler status: ${status}` };
		},
	};
}

export const _internal = { xmlPath, readXml: (): string | null => (existsSync(xmlPath()) ? readFileSync(xmlPath(), "utf16le") : null) };
