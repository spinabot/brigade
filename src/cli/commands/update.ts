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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** Newest file mtime (ms) under `dir`, recursively, filtered by extension.
 *  Bounded by a file budget so a pathological tree can't stall the command;
 *  skips `node_modules`/`.git`. Returns 0 when the dir is missing/empty. */
function newestMtimeMs(dir: string, exts: string[]): number {
	let max = 0;
	let budget = 50000;
	const stack = [dir];
	while (stack.length > 0 && budget-- > 0) {
		const d = stack.pop() as string;
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			continue;
		}
		for (const name of names) {
			const p = join(d, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (name === "node_modules" || name === ".git") continue;
				stack.push(p);
			} else if (st.isFile() && exts.some((x) => name.endsWith(x))) {
				if (st.mtimeMs > max) max = st.mtimeMs;
			}
		}
	}
	return max;
}

/** Is the compiled `dist/` already current with the working tree? True only when
 *  `dist/` exists AND its newest artifact is at least as new as the newest source
 *  input (src/*.ts + package.json/lock). Lets `update` skip a redundant
 *  reinstall+recompile when nothing actually changed since the last build. A
 *  missing dist, or any newer source file, returns false → rebuild. */
function buildIsCurrent(root: string): boolean {
	const dist = join(root, "dist");
	if (!existsSync(dist)) return false;
	const distMax = newestMtimeMs(dist, [".js", ".cjs", ".mjs"]);
	if (distMax === 0) return false;
	let srcMax = newestMtimeMs(join(root, "src"), [".ts", ".tsx", ".js", ".json"]);
	for (const f of ["package.json", "package-lock.json"]) {
		try {
			const m = statSync(join(root, f)).mtimeMs;
			if (m > srcMax) srcMax = m;
		} catch {
			/* file may not exist */
		}
	}
	return distMax >= srcMax;
}

/** Best-effort: the version PUBLISHED to npm (the released package). Returns
 *  undefined when npm/the registry is unreachable. For a SOURCE checkout this is
 *  only informational — that checkout tracks git (origin), not npm — but it lets
 *  a dev see how their tree compares to the latest release. */
function npmPublishedVersion(run: CommandRunner, name: string): string | undefined {
	const view = run("npm", ["view", name, "version"], { capture: true });
	if (view.code !== 0) return undefined;
	return view.stdout.split("\n").pop()?.trim() || undefined;
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
	/** Rebuild + restart even when the build is already current (source checkout)
	 *  or already on the latest published version (npm global). */
	force?: boolean;
	/** Force the npm published-release path (fetch latest from the registry +
	 *  install globally) even from a source checkout. */
	npm?: boolean;
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
	out(`${chalk.yellow("⚠ no background service to restart")}\n`);
	out(
		`${chalk.green("✓ Brigade updated.")} To load the new code, ${chalk.bold("restart your gateway")} — ` +
			`if you run it in the foreground, stop it and start it again.\n`,
	);
	out(
		`  ${chalk.dim("Tip:")} ${chalk.bold("brigade gateway install")} ${chalk.dim("registers Brigade as a background service")} — ` +
			`${chalk.dim("then")} ${chalk.bold("brigade update")} ${chalk.dim("restarts it for you automatically.")}\n`,
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
		else if (behind > 0) {
			const blocked = dirty
				? ` ${chalk.dim("(commit or stash your local changes first — a dirty tree blocks the pull).")}`
				: "";
			out(`${chalk.yellow(`↑ ${behind} commit(s) behind upstream.`)} Run ${chalk.bold("brigade update")} to pull, rebuild + restart.${blocked}\n`);
		} else out(`${chalk.green("✓ Up to date with upstream.")} (Run ${chalk.bold("brigade update --force")} to rebuild + restart anyway.)\n`);
		// Informational: how this checkout compares to the RELEASED (npm) version.
		// The source of truth for a dev clone is git (origin) — `update` never
		// installs from npm here (that would create a second, conflicting global
		// copy) — but showing the published version explains version differences.
		const published = npmPublishedVersion(run, pkg.name);
		if (published) {
			out(
				`  ${chalk.dim(`published on npm: ${published}`)}` +
					`${published !== pkg.version ? ` ${chalk.dim("(your checkout tracks git, not npm — pull from origin to advance it)")}` : ""}\n`,
			);
		}
		return 0;
	}

	// 1) git pull — only fast-forward, only when clean. Never clobber local work.
	let pulled = false;
	if (!hasUpstream) {
		out(`${chalk.dim("• no upstream — skipping git pull; using the working tree as-is.")}\n`);
	} else if (dirty) {
		// A dirty tree blocks the pull. If the remote is ALSO ahead, say so
		// explicitly — otherwise the operator sees an unchanged version number
		// and can't tell a newer release is waiting behind their local edits.
		const behindNote =
			behind > 0
				? ` ${chalk.yellow(`A newer version is on the remote — you're ${behind} commit(s) behind.`)} ${chalk.dim("Commit or stash, then re-run to pull it.")}`
				: "";
		out(
			`${chalk.yellow("• uncommitted changes present — skipping git pull")} (your work is left untouched); ` +
				`rebuilding the working tree as-is.${behindNote}\n`,
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
		pulled = true;
	} else {
		out(`${chalk.dim("• already up to date with upstream.")}\n`);
	}

	// 1b) Skip the reinstall+recompile when nothing actually changed — a pull, a
	//     newer source file (local edit), or a missing dist all force a rebuild;
	//     otherwise the built dist already matches the tree and there's nothing to
	//     do. Answers "it's already the latest — why build again?". `--force`
	//     overrides. The gateway isn't restarted either (it's already on this dist).
	if (!opts.force && !pulled && buildIsCurrent(root)) {
		out(
			`${chalk.green("✓ Already up to date")} ${chalk.dim("— the build matches your working tree; nothing to rebuild.")} ` +
				`${chalk.dim("Use")} ${chalk.bold("brigade update --force")} ${chalk.dim("to rebuild + restart anyway.")}\n`,
		);
		return 0;
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

	if (latest && latest === pkg.version && !opts.force) {
		out(`${chalk.green("✓ Already on the latest version.")} ${chalk.dim("(Use")} ${chalk.bold("brigade update --force")} ${chalk.dim("to reinstall + restart anyway.)")}\n`);
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
	// `--npm` forces the published-release path: fetch the latest from the npm
	// registry and install it GLOBALLY (`npm i -g <pkg>@latest`), even from a
	// source checkout. Note it updates the GLOBAL install, not this source tree —
	// which `brigade` runs afterwards depends on your PATH.
	if (opts.npm) {
		if (isSourceCheckout(pkg.root)) {
			out(
				`${chalk.dim("• --npm: installing the latest PUBLISHED build globally")} ` +
					`${chalk.dim("(this updates your global")} ${chalk.bold("brigade")}${chalk.dim(", not the source checkout at")} ${pkg.root}${chalk.dim(").")}\n`,
			);
		}
		return updateNpmGlobal(pkg, opts, run);
	}
	return isSourceCheckout(pkg.root) ? updateSourceCheckout(pkg, opts, run) : updateNpmGlobal(pkg, opts, run);
}
