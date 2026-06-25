/**
 * `brigade update` (alias `upgrade`) — bring Brigade to the latest code and
 * restart the running gateway so the new code is actually live.
 *
 * TWO install shapes, auto-detected:
 *   - NPM GLOBAL (`@spinabot/brigade` installed via `npm i -g`): `npm i -g
 *     <pkg>@latest`, then restart the gateway.
 *   - SOURCE CHECKOUT (a dev clone with `.git` + `src/`, e.g. F:\Brigade): we do
 *     NOT npm-install (that would create a second, conflicting global copy).
 *     Instead we perform the real source workflow END TO END:
 *        git pull --ff-only   (only when the tree is clean + behind upstream;
 *                              a dirty tree is left untouched and built as-is)
 *        npm install          (deps may have changed)
 *        npm run build        (recompile src → dist — Brigade runs from dist)
 *        brigade gateway restart
 *     i.e. the steps we used to just print, now executed.
 *
 * Flags: `--check` (report only, change nothing) · `--no-restart` (do the update
 * but leave the gateway for a manual restart).
 *
 * The subprocess runner is injectable (`opts.run`) so the whole flow is unit-
 * testable without spawning git/npm/node.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";

const FALLBACK_PKG = "@spinabot/brigade";

interface PackageInfo {
	name: string;
	version: string;
	root: string;
}

/** Result of one spawned command. */
interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Spawn a command. `capture` pipes stdout/stderr; otherwise it streams to the
 *  operator's terminal. `shell:true` lets bare `npm`/`git` resolve to `.cmd` on
 *  Windows; an explicit interpreter path (node) is spawned without a shell. */
export type CommandRunner = (
	cmd: string,
	args: string[],
	opts: { cwd?: string; capture?: boolean; shell?: boolean },
) => RunResult;

const defaultRunner: CommandRunner = (cmd, args, opts) => {
	const res = spawnSync(cmd, args, {
		cwd: opts.cwd,
		shell: opts.shell ?? true,
		encoding: "utf8",
		stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	return {
		code: res.status ?? 1,
		stdout: (res.stdout ?? "").trim(),
		stderr: (res.stderr ?? "").trim(),
	};
};

/** Walk up from this module to the package.json that owns it. */
function resolvePackageInfo(): PackageInfo {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
				if (parsed.name) return { name: parsed.name, version: parsed.version ?? "0.0.0", root: dir };
			} catch {
				/* keep walking */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return { name: FALLBACK_PKG, version: "0.0.0", root: dir };
}

/** A package dir with `.git` + `src/` is a dev checkout, not a global install. */
function isSourceCheckout(root: string): boolean {
	return existsSync(join(root, ".git")) && existsSync(join(root, "src"));
}

const out = (s: string): void => void process.stdout.write(s);
const err = (s: string): void => void process.stderr.write(s);
const step = (s: string): void => out(`${chalk.cyan("→")} ${s}\n`);

/** Run a captured step with concise `→ label … ✓ / ✗` output; on failure, dump
 *  the captured stdout/stderr so the error is still visible. Keeps the upgrade
 *  quiet (no npm audit/funding noise) while staying honest about failures. */
function runStep(run: CommandRunner, label: string, cmd: string, args: string[], cwd?: string): RunResult {
	out(`${chalk.cyan("→")} ${label} … `);
	const r = run(cmd, args, { cwd, capture: true });
	out(r.code === 0 ? `${chalk.green("✓")}\n` : `${chalk.red("✗")}\n`);
	if (r.code !== 0) {
		if (r.stdout) err(`${r.stdout}\n`);
		if (r.stderr) err(`${r.stderr}\n`);
	}
	return r;
}

export interface UpdateOptions {
	check?: boolean;
	/** Skip the final `gateway restart`. */
	noRestart?: boolean;
	/** TEST SEAM — inject the subprocess runner. */
	run?: CommandRunner;
	/** TEST SEAM — override the resolved package root/info. */
	pkg?: PackageInfo;
}

/** Restart the running gateway so the freshly-built/installed code goes live.
 *  This only succeeds when Brigade is installed as an OS service — it returns
 *  false when there's nothing to restart (e.g. the gateway runs in the
 *  foreground). Output is captured so the caller can report the outcome itself. */
function restartGateway(run: CommandRunner, source: boolean, root: string): boolean {
	const r = source
		? run(process.execPath, [join(root, "brigade.mjs"), "gateway", "restart"], { cwd: root, shell: false, capture: true })
		: run("brigade", ["gateway", "restart"], { shell: true, capture: true });
	return r.code === 0;
}

/** Attempt the gateway restart and report HONESTLY — never claim a restart that
 *  didn't happen. A failed restart is a warning, NOT an update failure: the new
 *  code is already built/installed, it just needs the gateway bounced. */
function restartAndReport(run: CommandRunner, source: boolean, root: string, opts: UpdateOptions): number {
	if (opts.noRestart) {
		out(`${chalk.green("✓ Brigade updated.")} Restart your gateway to load the new code ${chalk.dim("(--no-restart).")}\n`);
		return 0;
	}
	out(`${chalk.cyan("→")} restarting gateway … `);
	if (restartGateway(run, source, root)) {
		out(`${chalk.green("✓")}\n${chalk.green("✓ Brigade updated + gateway restarted — running the latest code.")}\n`);
		return 0;
	}
	out(`${chalk.yellow("⚠ nothing to restart")}\n`);
	out(
		`${chalk.green("✓ Brigade updated.")} To load the new code, ${chalk.bold("restart your gateway")} — ` +
			`if you run it in the foreground, stop it and start it again. ` +
			`${chalk.dim("(brigade gateway restart only applies when Brigade is installed as an OS service.)")}\n`,
	);
	return 0;
}

/** SOURCE-checkout update: git pull (when safe) → npm install → build → restart. */
function updateSourceCheckout(pkg: PackageInfo, opts: UpdateOptions, run: CommandRunner): number {
	const root = pkg.root;
	out(`${chalk.dim("source checkout:")} ${root}   ${chalk.dim("current:")} ${pkg.version}\n`);

	// Does the branch track an upstream? (rev-parse errors when it doesn't.)
	const hasUpstream =
		run("git", ["-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { capture: true }).code === 0;
	if (hasUpstream) run("git", ["-C", root, "fetch", "--quiet"], { capture: true });

	const dirty = run("git", ["-C", root, "status", "--porcelain"], { capture: true }).stdout.length > 0;
	const behind = hasUpstream
		? Number.parseInt(run("git", ["-C", root, "rev-list", "--count", "HEAD..@{u}"], { capture: true }).stdout || "0", 10)
		: 0;

	if (opts.check) {
		if (!hasUpstream) out(`${chalk.dim("no upstream tracking branch — can't check remote.")}\n`);
		else if (behind > 0)
			out(`${chalk.yellow(`↑ ${behind} commit(s) behind upstream.`)} Run ${chalk.bold("brigade update")} to pull, rebuild + restart.\n`);
		else out(`${chalk.green("✓ Up to date with upstream.")} (Run ${chalk.bold("brigade update")} to rebuild + restart anyway.)\n`);
		return 0;
	}

	// 1) git pull — only fast-forward, only when clean. Never clobber local work.
	if (!hasUpstream) {
		out(`${chalk.dim("• no upstream — skipping git pull; rebuilding the working tree as-is.")}\n`);
	} else if (dirty) {
		out(
			`${chalk.yellow("• uncommitted changes present — skipping git pull")} (your work is left untouched); ` +
				`rebuilding the working tree as-is.\n`,
		);
	} else if (behind > 0) {
		step(`git pull --ff-only  (${behind} commit(s) behind)`);
		const pull = run("git", ["-C", root, "pull", "--ff-only"], {});
		if (pull.code !== 0) {
			err(
				`${chalk.red("✗ git pull failed")} (the branch may have diverged from upstream). ` +
					`Resolve it manually, then re-run.\n`,
			);
			return pull.code;
		}
	} else {
		out(`${chalk.dim("• already up to date with upstream — rebuilding to apply any local commits.")}\n`);
	}

	// 2) npm install — deps may have changed. Captured so the upgrade stays quiet
	//    (no npm audit/funding/postinstall noise); output is shown only on failure.
	if (runStep(run, "installing dependencies", "npm", ["install"], root).code !== 0) {
		err(`${chalk.red("✗ npm install failed.")} Fix the error above, then re-run ${chalk.bold("brigade update")}.\n`);
		return 1;
	}

	// 3) npm run build — recompile src → dist (Brigade runs dist, not src).
	if (runStep(run, "building", "npm", ["run", "build"], root).code !== 0) {
		err(
			`${chalk.red("✗ Build failed — NOT restarting the gateway")} (it keeps running the previous good build). ` +
				`Fix the error above, then re-run ${chalk.bold("brigade update")}.\n`,
		);
		return 1;
	}

	// 4) restart so the new dist is live (honest about the foreground case).
	return restartAndReport(run, true, root, opts);
}

/** NPM-GLOBAL update: npm i -g <pkg>@latest → restart. */
function updateNpmGlobal(pkg: PackageInfo, opts: UpdateOptions, run: CommandRunner): number {
	if (run("npm", ["--version"], { capture: true }).code !== 0) {
		err(
			`${chalk.red("✗ npm wasn't found on your PATH.")} Install Node.js (which bundles npm), then re-run, ` +
				`or update manually: ${chalk.bold(`npm i -g ${pkg.name}@latest`)}\n`,
		);
		return 1;
	}

	const view = run("npm", ["view", pkg.name, "version"], { capture: true });
	const latest = view.code === 0 ? view.stdout.split("\n").pop()?.trim() : undefined;
	out(`${chalk.dim("current:")} ${pkg.version}${latest ? `   ${chalk.dim("latest:")} ${latest}` : ""}\n`);

	if (latest && latest === pkg.version) {
		out(`${chalk.green("✓ Already on the latest version.")}\n`);
		return 0;
	}
	if (opts.check) {
		if (latest) out(`${chalk.yellow(`↑ ${pkg.version} → ${latest} available.`)} Run ${chalk.bold("brigade update")} to upgrade.\n`);
		else {
			err("Couldn't reach the npm registry to check the latest version.\n");
			return 1;
		}
		return 0;
	}

	if (runStep(run, `installing ${pkg.name}@latest`, "npm", ["i", "-g", `${pkg.name}@latest`]).code !== 0) {
		err(
			`${chalk.red("✗ Upgrade failed.")} If it's a permissions error, retry with elevated rights ` +
				`(sudo / an Administrator shell), or run: ${chalk.bold(`npm i -g ${pkg.name}@latest`)}\n`,
		);
		return 1;
	}

	return restartAndReport(run, false, pkg.root, opts);
}

export async function runUpdateCommand(opts: UpdateOptions = {}): Promise<number> {
	const pkg = opts.pkg ?? resolvePackageInfo();
	const run = opts.run ?? defaultRunner;
	return isSourceCheckout(pkg.root) ? updateSourceCheckout(pkg, opts, run) : updateNpmGlobal(pkg, opts, run);
}
