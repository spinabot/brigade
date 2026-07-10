// `brigade video` — manage the optional motion-graphics render engine.
//
// It exists because the alternative was worse. Before this, the only way to enable
// `render_video` was to get `@hyperframes/producer` into Brigade's own node_modules,
// which a `npm i -g` operator cannot do from their shell — and our error message told
// them (and the agent reading it) to run `npm i @hyperframes/producer`. npm walked up
// from `~/.brigade`, found no package.json, and installed into the operator's HOME.
// The package landed on disk somewhere Brigade would never resolve, and `render_video`
// stayed dormant while an agent spent ten minutes driving the engine by hand.

import { spawnSync } from "node:child_process";

import chalk from "chalk";

import { installRenderEngine, type InstallRunner } from "../../agents/tools/render-video/install.js";
import { renderVideoDoctor } from "../../agents/tools/render-video/availability.js";

const out = (s: string): void => void process.stdout.write(s);
const err = (s: string): void => void process.stderr.write(s);

/** Real npm. Captured (not inherited) so a failure prints npm's tail, not a wall. */
const defaultRunner: InstallRunner = (command, args, opts) => {
	const res = spawnSync(command, args, {
		cwd: opts.cwd,
		encoding: "utf8",
		shell: process.platform === "win32", // npm is npm.cmd on Windows
	});
	return {
		code: res.status ?? 1,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
	};
};

export interface VideoInstallOptions {
	force?: boolean;
	json?: boolean;
	/** Injected by tests. */
	run?: InstallRunner;
}

export async function runVideoInstallCommand(opts: VideoInstallOptions = {}): Promise<number> {
	const run = opts.run ?? defaultRunner;
	if (!opts.json) out(`${chalk.cyan("→")} installing the render engine into Brigade's engines directory…\n`);

	const result = installRenderEngine({ run, ...(opts.force ? { force: true } : {}) });

	if (opts.json) {
		out(`${JSON.stringify(result, null, 2)}\n`);
		return result.ok ? 0 : 1;
	}

	if (!result.ok) {
		err(`${chalk.red("✗")} ${result.message}\n`);
		return 1;
	}

	out(`${chalk.green("✓")} ${result.message}\n`);

	// Installing the engine is necessary, not sufficient: the renderer also needs
	// FFmpeg and a Chrome. Say so now rather than at render time, three minutes into
	// the operator's first video.
	const doctor = renderVideoDoctor();
	if (!doctor.ffmpeg.ok) {
		out(`${chalk.yellow("!")} ${doctor.ffmpeg.detail}\n`);
	}
	if (!doctor.chrome.ok) {
		out(`${chalk.dim(`· ${doctor.chrome.detail}`)}\n`);
	}
	if (doctor.ffmpeg.ok) {
		out(`${chalk.dim("The render_video tool is now available to your crew.")}\n`);
	}
	return 0;
}

export async function runVideoStatusCommand(opts: { json?: boolean } = {}): Promise<number> {
	const doctor = renderVideoDoctor();
	if (opts.json) {
		out(`${JSON.stringify(doctor, null, 2)}\n`);
		return doctor.ready ? 0 : 1;
	}
	const mark = (ok: boolean): string => (ok ? chalk.green("✓") : chalk.red("✗"));
	out(`${mark(doctor.node.ok)} node      ${chalk.dim(doctor.node.detail)}\n`);
	out(`${mark(doctor.hyperframes.ok)} engine    ${chalk.dim(doctor.hyperframes.detail)}\n`);
	out(`${mark(doctor.ffmpeg.ok)} ffmpeg    ${chalk.dim(doctor.ffmpeg.detail)}\n`);
	out(`${doctor.chrome.ok ? chalk.green("✓") : chalk.yellow("!")} chrome    ${chalk.dim(doctor.chrome.detail)}\n`);
	out(
		doctor.ready
			? `\n${chalk.green("✓ render_video is available.")}\n`
			: `\n${chalk.yellow("render_video is dormant.")} Run ${chalk.bold("brigade video install")}.\n`,
	);
	return doctor.ready ? 0 : 1;
}
