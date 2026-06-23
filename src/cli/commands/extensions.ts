/**
 * `brigade extensions list / doctor / init` — operator + author CLI over the
 * extension engine.
 *
 *   • list   — every extension Brigade knows about (built-in + the ones you
 *              dropped in your extensions folder), with whether each one loaded.
 *   • doctor — the "why didn't my plugin load" surface: per-file, did it pass
 *              the safety check, load, and export a Brigade module.
 *   • init   — scaffold a runnable starter module (channel / tool / provider)
 *              into your extensions folder, plus a short README.
 *   • add    — install a third-party module (local path / npm package / git URL)
 *              into your extensions folder, with a compat check + security scan.
 *   • remove — delete an installed module from your extensions folder.
 *
 * The discovery + diagnosis logic lives in `agents/extensions/diagnose.ts`; the
 * install/remove machinery in `agents/extensions/install.ts`; this file is just
 * the CLI surface (argument parsing + human/JSON rendering + the interactive
 * scan acknowledgement). All operator-facing copy stays plain — no internal type
 * names, no raw stack traces, no HTTP codes.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import chalk from "chalk";

import { BUNDLED_MODULES } from "../../agents/extensions/modules/index.js";
import {
	diagnoseExtensions,
	type DiagnosedExtension,
	type ExtensionDiagnosis,
} from "../../agents/extensions/diagnose.js";
import { extensionsRootExists } from "../../agents/extensions/discovery.js";
import {
	InstallError,
	installExtension,
	removeExtension,
	type InstallResult,
} from "../../agents/extensions/install.js";
import type { ScanFinding } from "../../agents/extensions/install-scan.js";
import { summarizeScan } from "../../agents/extensions/install-scan.js";
import { resolveExtensionsDir } from "../../config/paths.js";

/* ─────────────────────────────── list ─────────────────────────────── */

export async function runExtensionsList(opts: { json?: boolean } = {}): Promise<number> {
	const extensionsDir = resolveExtensionsDir();
	const diagnosis = await diagnoseExtensions(BUNDLED_MODULES, extensionsDir);

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(jsonView(diagnosis), null, 2)}\n`);
		return 0;
	}

	const { extensions } = diagnosis;
	const lines: string[] = [];
	lines.push(chalk.bold("brigade extensions"));
	lines.push("");

	const idWidth = Math.max(4, ...extensions.map((e) => e.id.length));
	const originWidth = 8; // "built-in" / "yours"
	lines.push(
		`  ${"NAME".padEnd(idWidth)}  ${"SOURCE".padEnd(originWidth)}  STATUS`,
	);
	for (const e of extensions) {
		lines.push(
			`  ${e.id.padEnd(idWidth)}  ${originLabel(e.origin).padEnd(originWidth)}  ${statusCell(e)}`,
		);
		if (e.status === "skipped" && e.reason) {
			lines.push(`  ${" ".repeat(idWidth)}  ${" ".repeat(originWidth)}  ${chalk.dim(`→ ${e.reason}`)}`);
		}
	}
	lines.push("");

	const userCount = extensions.filter((e) => e.origin === "user").length;
	if (userCount === 0) {
		lines.push(
			chalk.dim(
				`No add-on extensions found. Drop one into ${extensionsDir} (or run \`brigade extensions init <id>\`).`,
			),
		);
	} else {
		const skipped = extensions.filter((e) => e.origin === "user" && e.status === "skipped").length;
		if (skipped > 0) {
			lines.push(
				chalk.yellow(
					`${skipped} of your extension${skipped === 1 ? "" : "s"} didn't load — run \`brigade extensions doctor\` to see why.`,
				),
			);
		} else {
			lines.push(chalk.green("All your extensions loaded."));
		}
	}
	lines.push("");
	process.stdout.write(lines.join("\n"));
	return 0;
}

/* ─────────────────────────────── doctor ─────────────────────────────── */

export async function runExtensionsDoctor(opts: { json?: boolean } = {}): Promise<number> {
	const extensionsDir = resolveExtensionsDir();
	const diagnosis = await diagnoseExtensions(BUNDLED_MODULES, extensionsDir);
	const userEntries = diagnosis.extensions.filter((e) => e.origin === "user");

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ extensionsDir, ok: userEntries.every((e) => e.status === "loaded"), extensions: userEntries.map(jsonEntry) }, null, 2)}\n`,
		);
		return 0;
	}

	const lines: string[] = [];
	lines.push(chalk.bold("brigade extensions doctor"));
	lines.push("");

	if (!extensionsRootExists(extensionsDir)) {
		lines.push(`  Your extensions folder doesn't exist yet:`);
		lines.push(`    ${chalk.dim(extensionsDir)}`);
		lines.push("");
		lines.push(chalk.dim("  Run `brigade extensions init <id>` to scaffold your first one."));
		lines.push("");
		process.stdout.write(lines.join("\n"));
		return 0;
	}

	if (userEntries.length === 0) {
		lines.push(`  No add-on extensions found in:`);
		lines.push(`    ${chalk.dim(extensionsDir)}`);
		lines.push("");
		lines.push(chalk.dim("  Run `brigade extensions init <id>` to scaffold your first one."));
		lines.push("");
		process.stdout.write(lines.join("\n"));
		return 0;
	}

	for (const e of userEntries) {
		const headGlyph = e.status === "loaded" ? chalk.green("✔") : chalk.red("✖");
		lines.push(`  ${headGlyph}  ${chalk.bold(e.id)}`);
		lines.push(`     ${chalk.dim(e.source)}`);
		const c = e.checks ?? { safe: false, imported: false, exportedModule: false };
		lines.push(`       ${stepGlyph(c.safe)} passes the safety check`);
		lines.push(`       ${stepGlyph(c.imported)} loads without errors`);
		lines.push(`       ${stepGlyph(c.exportedModule)} exports a Brigade module`);
		if (e.status === "skipped" && e.reason) {
			lines.push(`       ${chalk.yellow(`→ ${e.reason}`)}`);
		}
		lines.push("");
	}

	const failed = userEntries.filter((e) => e.status === "skipped").length;
	if (failed > 0) {
		lines.push(
			chalk.yellow(`${failed} extension${failed === 1 ? "" : "s"} need attention (see above).`),
		);
	} else {
		lines.push(chalk.green("All your extensions are healthy."));
	}
	lines.push("");
	process.stdout.write(lines.join("\n"));
	return 0;
}

/* ─────────────────────────────── init ─────────────────────────────── */

export type ExtensionKind = "channel" | "tool" | "provider";

export async function runExtensionsInit(
	args: { id: string; kind?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const id = (args.id ?? "").trim();
	const kind = normalizeKind(args.kind);
	if (kind === null) {
		return fail(
			`Unknown kind "${args.kind}". Choose one of: channel, tool, provider.`,
			opts.json,
		);
	}
	if (!isValidId(id)) {
		return fail(
			"Please give a simple name using lowercase letters, numbers and dashes (e.g. my-channel).",
			opts.json,
		);
	}

	const extensionsDir = resolveExtensionsDir();
	const targetDir = path.join(extensionsDir, id);
	if (existsSync(targetDir)) {
		return fail(
			`An extension named "${id}" already exists at ${targetDir}. Pick a different name or remove that folder first.`,
			opts.json,
		);
	}

	try {
		mkdirSync(targetDir, { recursive: true });
		const indexPath = path.join(targetDir, "index.ts");
		const readmePath = path.join(targetDir, "README.md");
		writeFileSync(indexPath, scaffoldIndex(id, kind), "utf8");
		writeFileSync(readmePath, scaffoldReadme(id, kind), "utf8");

		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify({ ok: true, id, kind, dir: targetDir, files: [indexPath, readmePath] }, null, 2)}\n`,
			);
			return 0;
		}
		const lines: string[] = [];
		lines.push(chalk.green(`Created a ${kind} extension "${id}".`));
		lines.push("");
		lines.push(`  Folder:  ${targetDir}`);
		lines.push(`  Files:   index.ts, README.md`);
		lines.push("");
		lines.push("Next steps:");
		lines.push(`  1. Edit index.ts to add your logic.`);
		lines.push(`  2. Run \`brigade extensions doctor\` to confirm it loads.`);
		lines.push("");
		process.stdout.write(lines.join("\n"));
		return 0;
	} catch (err) {
		return fail(
			`Couldn't create the extension: ${err instanceof Error ? err.message : String(err)}`,
			opts.json,
		);
	}
}

/* ─────────────────────────────── add ─────────────────────────────── */

export async function runExtensionsAdd(
	args: { source: string; force?: boolean; yes?: boolean },
	opts: { json?: boolean } = {},
): Promise<number> {
	const source = (args.source ?? "").trim();
	if (!source) {
		return fail("Give me something to install: a folder, a file, an npm package name, or a git URL.", opts.json);
	}

	const extensionsDir = resolveExtensionsDir();
	let result: InstallResult;
	try {
		result = await installExtension(source, { extensionsDir, force: args.force });
	} catch (err) {
		if (err instanceof InstallError) return fail(err.message, opts.json);
		return fail(
			`Couldn't install the extension: ${err instanceof Error ? err.message : String(err)}`,
			opts.json,
		);
	}

	const high = result.scan.counts.high;
	const total = result.scan.findings.length;

	// JSON path is non-interactive: report what was installed + the full scan; the
	// caller decides what to do with the findings. No prompt.
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(jsonInstallView(result), null, 2)}\n`);
		return 0;
	}

	// Human path — render the result, then (if the scan found anything) require an
	// acknowledgement before keeping the install. `--yes` auto-accepts.
	renderInstall(result);

	if (total > 0) {
		const accepted = await acknowledgeScan(result, args.yes === true);
		if (!accepted) {
			// Operator declined — undo the install so nothing risky lingers.
			try {
				removeExtension(result.id, extensionsDir);
			} catch {
				/* best-effort rollback */
			}
			process.stderr.write(
				chalk.yellow(`\nRemoved "${result.id}" — you didn't accept its access. Nothing was kept.\n`),
			);
			return 1;
		}
	}

	const lines: string[] = [];
	lines.push("");
	lines.push(chalk.green(`Installed "${result.id}".`));
	lines.push("");
	lines.push("Next steps:");
	lines.push(`  1. Run \`brigade extensions doctor\` to confirm it loads.`);
	lines.push(`  2. Restart the gateway (or reload extensions) to activate it.`);
	lines.push("");
	process.stdout.write(lines.join("\n"));
	return 0;
}

/** Render the install summary block (what / where / compat / scan). */
function renderInstall(result: InstallResult): void {
	const sourceLabel =
		result.sourceKind === "local" ? "local path" : result.sourceKind === "npm" ? "npm package" : "git repository";
	const lines: string[] = [];
	lines.push(chalk.bold(`Installing extension`));
	lines.push("");
	lines.push(`  From:    ${result.source}  ${chalk.dim(`(${sourceLabel})`)}`);
	lines.push(`  Name:    ${chalk.bold(result.id)}${result.replacedExisting ? chalk.dim("  (replaced existing)") : ""}`);
	lines.push(`  Folder:  ${result.dir}`);
	lines.push("");
	// Compat verdict (always compatible here — an incompatible one would've thrown).
	const v = result.compat;
	const compatBits: string[] = [`needs Brigade ${v.minBrigadeVersion ?? "(any)"}`];
	if (v.pluginApi) compatBits.push(`plugin API v${v.pluginApi}`);
	lines.push(
		`  ${chalk.green("✔")} Compatible with Brigade ${v.brigadeVersion}  ${chalk.dim(`(${compatBits.join(", ")})`)}`,
	);
	// Scan summary.
	const { findings, filesScanned, counts } = result.scan;
	if (findings.length === 0) {
		lines.push(`  ${chalk.green("✔")} Security scan: nothing notable in ${filesScanned} file${filesScanned === 1 ? "" : "s"}.`);
	} else {
		const glyph = counts.high > 0 ? chalk.yellow("!") : chalk.dim("•");
		lines.push(
			`  ${glyph} Security scan: ${summarizeScan(result.scan)} across ${filesScanned} file${filesScanned === 1 ? "" : "s"}.`,
		);
	}
	lines.push("");
	process.stdout.write(lines.join("\n"));
}

/**
 * Show the scan findings + ask the operator to accept them. Returns true to
 * proceed. `autoYes` (from `--yes`) accepts without prompting (non-interactive).
 * When there's no TTY and no `--yes`, we DECLINE — never silently keep a module
 * with flagged constructs the operator never saw.
 */
async function acknowledgeScan(result: InstallResult, autoYes: boolean): Promise<boolean> {
	const { findings } = result.scan;
	const lines: string[] = [];
	lines.push(chalk.yellow("Heads up — this extension uses some powerful capabilities:"));
	lines.push("");
	// Group by note for a compact list; show up to a few example locations each.
	const grouped = groupFindings(findings);
	for (const g of grouped) {
		const sevTag =
			g.severity === "high" ? chalk.yellow("[high]") : g.severity === "medium" ? chalk.dim("[medium]") : chalk.dim("[low]");
		lines.push(`  ${sevTag} ${g.note}`);
		for (const loc of g.locations.slice(0, 3)) {
			lines.push(chalk.dim(`        ${loc.file}:${loc.line}  ${loc.snippet}`));
		}
		if (g.locations.length > 3) {
			lines.push(chalk.dim(`        …and ${g.locations.length - 3} more`));
		}
	}
	lines.push("");
	lines.push(
		chalk.dim(
			"These are normal for many extensions (a chat channel needs the network, a tool may run commands). Only continue if you trust the source.",
		),
	);
	lines.push("");
	process.stdout.write(lines.join("\n"));

	if (autoYes) {
		process.stdout.write(chalk.dim("Accepted automatically (--yes).\n"));
		return true;
	}
	if (!process.stdin.isTTY) {
		process.stderr.write(
			chalk.yellow("Not a terminal — re-run with --yes to accept these capabilities non-interactively.\n"),
		);
		return false;
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question("Keep this extension? [y/N] ")).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

interface GroupedFinding {
	note: string;
	severity: ScanFinding["severity"];
	locations: Array<{ file: string; line: number; snippet: string }>;
}

/** Collapse findings sharing a note into one row with example locations. */
function groupFindings(findings: ReadonlyArray<ScanFinding>): GroupedFinding[] {
	const sevRank = { high: 0, medium: 1, low: 2 } as const;
	const byNote = new Map<string, GroupedFinding>();
	for (const f of findings) {
		const existing = byNote.get(f.note);
		if (existing) {
			existing.locations.push({ file: f.file, line: f.line, snippet: f.snippet });
		} else {
			byNote.set(f.note, {
				note: f.note,
				severity: f.severity,
				locations: [{ file: f.file, line: f.line, snippet: f.snippet }],
			});
		}
	}
	return [...byNote.values()].sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
}

function jsonInstallView(result: InstallResult): Record<string, unknown> {
	return {
		ok: true,
		id: result.id,
		dir: result.dir,
		source: result.source,
		sourceKind: result.sourceKind,
		replacedExisting: result.replacedExisting,
		compat: {
			compatible: result.compat.compatible,
			brigadeVersion: result.compat.brigadeVersion,
			...(result.compat.minBrigadeVersion ? { minBrigadeVersion: result.compat.minBrigadeVersion } : {}),
			...(result.compat.pluginApi ? { pluginApi: result.compat.pluginApi } : {}),
		},
		scan: {
			summary: summarizeScan(result.scan),
			filesScanned: result.scan.filesScanned,
			counts: result.scan.counts,
			findings: result.scan.findings,
		},
	};
}

/* ─────────────────────────────── remove ─────────────────────────────── */

export async function runExtensionsRemove(
	args: { id: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const id = (args.id ?? "").trim();
	if (!id) return fail("Tell me which extension to remove (its name).", opts.json);

	const extensionsDir = resolveExtensionsDir();
	try {
		const removed = removeExtension(id, extensionsDir);
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ ok: true, id: removed.id, dir: removed.dir }, null, 2)}\n`);
			return 0;
		}
		const lines: string[] = [];
		lines.push(chalk.green(`Removed "${removed.id}".`));
		lines.push(`  Folder deleted: ${removed.dir}`);
		lines.push("");
		process.stdout.write(lines.join("\n"));
		return 0;
	} catch (err) {
		if (err instanceof InstallError) return fail(err.message, opts.json);
		return fail(
			`Couldn't remove the extension: ${err instanceof Error ? err.message : String(err)}`,
			opts.json,
		);
	}
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

function originLabel(origin: DiagnosedExtension["origin"]): string {
	return origin === "bundled" ? "built-in" : "yours";
}

function statusCell(e: DiagnosedExtension): string {
	return e.status === "loaded" ? chalk.green("loaded") : chalk.yellow("not loaded");
}

function stepGlyph(ok: boolean): string {
	return ok ? chalk.green("✔") : chalk.red("✖");
}

function jsonEntry(e: DiagnosedExtension): Record<string, unknown> {
	return {
		id: e.id,
		origin: e.origin,
		source: e.source,
		status: e.status,
		...(e.reason ? { reason: e.reason } : {}),
		...(e.checks ? { checks: e.checks } : {}),
		// FIX 4 — only present when a live registry was available (gateway path);
		// the discovery-only CLI default omits it, keeping output back-compatible.
		...(e.live ? { live: e.live } : {}),
	};
}

function jsonView(d: ExtensionDiagnosis): Record<string, unknown> {
	return {
		extensionsDir: d.extensionsDir,
		extensions: d.extensions.map(jsonEntry),
	};
}

function fail(message: string, json?: boolean): number {
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
	} else {
		process.stderr.write(`${message}\n`);
	}
	return 1;
}

function normalizeKind(raw: string | undefined): ExtensionKind | null {
	const v = (raw ?? "channel").trim().toLowerCase();
	if (v === "channel" || v === "tool" || v === "provider") return v;
	return null;
}

/** A safe folder/extension id: lowercase letters, digits, dashes; must start with a letter. */
function isValidId(id: string): boolean {
	return /^[a-z][a-z0-9-]*$/.test(id) && !id.includes("--") && !id.endsWith("-");
}

/** Turn a kebab id into a CamelCase suffix for generated identifiers. */
function toCamel(id: string): string {
	return id
		.split("-")
		.filter(Boolean)
		.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
		.join("");
}

/* ─────────────────────────────── scaffolds ─────────────────────────────── */

function scaffoldIndex(id: string, kind: ExtensionKind): string {
	if (kind === "channel") return scaffoldChannelIndex(id);
	if (kind === "provider") return scaffoldProviderIndex(id);
	return scaffoldToolIndex(id);
}

function scaffoldChannelIndex(id: string): string {
	const Name = toCamel(id);
	return `/**
 * ${id} — a Brigade channel extension.
 *
 * A channel connects Brigade to a messaging surface: it listens for incoming
 * messages, hands each one to Brigade for a reply, and sends the reply back.
 * This starter implements the smallest working shape — fill in start/stop/send
 * with your transport (a chat SDK, a webhook, a socket, …).
 *
 * Confirm it loads:  brigade extensions doctor
 */

import { defineModule } from "brigade/channel-sdk";
import type { ChannelAdapter, ChannelStartContext } from "brigade/channel-sdk";

function create${Name}Adapter(): ChannelAdapter {
	return {
		id: "${id}",
		label: "${Name}",

		// Return true only when this channel has what it needs to run (a token,
		// a URL, …). Read from \`cfg\` / \`env\`. Returning false keeps it idle.
		isConfigured(_cfg, _env) {
			return false;
		},

		// Begin listening. Call \`ctx.onInbound(message)\` for every incoming
		// message; Brigade runs a turn and replies via \`sendText\` below.
		async start(_ctx: ChannelStartContext): Promise<void> {
			// TODO: connect to your transport and wire incoming messages to
			// ctx.onInbound({ channel: "${id}", conversationId, from, text }).
		},

		// Stop listening and tear down the connection.
		async stop(): Promise<void> {
			// TODO: close your transport.
		},

		// Deliver an outbound reply to a conversation.
		async sendText(_conversationId: string, _text: string): Promise<void> {
			// TODO: send the message through your transport.
		},
	};
}

export default defineModule({
	id: "${id}",
	register(b) {
		b.channel(create${Name}Adapter());
	},
});
`;
}

function scaffoldToolIndex(id: string): string {
	const Name = toCamel(id);
	return `/**
 * ${id} — a Brigade tool extension.
 *
 * A tool gives the agent a new action it can call during a turn. This starter
 * registers one tool with a single text input and a text result — replace the
 * parameters and the body with your own logic.
 *
 * Confirm it loads:  brigade extensions doctor
 */

import { defineModule } from "brigade/extension-sdk";

export default defineModule({
	id: "${id}",
	register(b) {
		b.tool({
			name: "${id.replace(/-/g, "_")}",
			label: "${Name}",
			description: "Describe what this tool does so the agent knows when to use it.",
			parameters: {
				type: "object",
				properties: {
					input: { type: "string", description: "The text to act on." },
				},
				required: ["input"],
			},
			// The body runs when the agent calls the tool. Return a short result.
			async execute(args: { input: string }) {
				const input = args?.input ?? "";
				return { content: \`You sent: \${input}\` };
			},
		} as never);
	},
});
`;
}

function scaffoldProviderIndex(id: string): string {
	const Name = toCamel(id);
	return `/**
 * ${id} — a Brigade provider extension.
 *
 * A provider plugs an external capability into Brigade. This starter registers
 * a simple web-search provider as an example; swap the body for the service you
 * want to integrate. Brigade only activates a provider once it reports itself as
 * configured (a key/URL is present).
 *
 * Confirm it loads:  brigade extensions doctor
 */

import { defineModule } from "brigade/extension-sdk";

export default defineModule({
	id: "${id}",
	register(b) {
		b.webSearch({
			id: "${id}",
			label: "${Name}",
			hint: "Describe this search source in one line.",
			requiresCredential: true,

			// Return true only when your credential is present.
			isConfigured(_cfg, _env) {
				return false;
			},

			// Build the search tool when the provider is active. Return null when
			// it isn't ready.
			createTool(_ctx) {
				return null;
			},
		});
	},
});
`;
}

function scaffoldReadme(id: string, kind: ExtensionKind): string {
	const sdk = kind === "channel" ? "brigade/channel-sdk" : "brigade/extension-sdk";
	return `# ${id}

A Brigade **${kind}** extension.

## How it loads

Brigade discovers everything under your extensions folder automatically. This
folder ships an \`index.ts\` that exports a module via \`defineModule\` from
\`${sdk}\`. You don't need to install or build anything — Brigade reads the
TypeScript directly on startup.

## Edit it

Open \`index.ts\` and fill in the parts marked \`TODO\`.

## Check it

\`\`\`
brigade extensions doctor
\`\`\`

That shows whether this extension passed its safety check, loaded, and exported
a valid module. \`brigade extensions list\` shows it alongside the built-in
extensions.
`;
}
