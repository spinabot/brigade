/**
 * `brigade logs [--follow] [--limit N]` — tail the gateway's JSONL event log.
 *
 * The gateway writes one JSON object per line to `~/.brigade/logs/<YYYY-MM-DD>.log`
 * (see `event-logger.ts`). This command prints the last N lines and optionally
 * follows for new lines, with a friendly one-line summary per event.
 */

import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { createInterface } from "node:readline";

import { getTodayLogPath } from "../../core/event-logger.js";

interface LogLine {
	timestamp?: string;
	level?: string;
	event?: string;
	[k: string]: unknown;
}

function formatLine(raw: string): string {
	let line: LogLine;
	try {
		line = JSON.parse(raw) as LogLine;
	} catch {
		return raw; // not JSON — print verbatim
	}
	const ts = typeof line.timestamp === "string" ? line.timestamp.slice(11, 19) : "        ";
	const lvl = (line.level ?? "info").toUpperCase().padEnd(5);
	const what = typeof line.event === "string" ? line.event : "event";
	// Drop the noisy fields from the JSON dump so the line stays readable.
	const { timestamp: _t, level: _l, event: _e, ...rest } = line;
	void _t;
	void _l;
	void _e;
	const detail = Object.keys(rest).length > 0 ? `  ${JSON.stringify(rest)}` : "";
	return `${ts} ${lvl} ${what}${detail}`;
}

async function readLastLines(filePath: string, limit: number): Promise<string[]> {
	const lines: string[] = [];
	await new Promise<void>((resolve, reject) => {
		const rl = createInterface({ input: createReadStream(filePath) });
		rl.on("line", (l) => {
			lines.push(l);
			if (lines.length > limit) lines.shift();
		});
		rl.on("close", () => resolve());
		rl.on("error", reject);
	});
	return lines;
}

export async function runLogsCommand(
	args: { follow?: boolean; limit?: number },
	opts: { json?: boolean } = {},
): Promise<number> {
	const limit = Math.max(1, args.limit ?? 50);
	const filePath = getTodayLogPath();
	if (!existsSync(filePath)) {
		process.stderr.write(`No log file at ${filePath} yet — has the gateway run today?\n`);
		return 0;
	}
	const tail = await readLastLines(filePath, limit);
	for (const line of tail) process.stdout.write(`${opts.json ? line : formatLine(line)}\n`);

	if (!args.follow) return 0;

	// Follow mode: watch the file + print any new tail lines until Ctrl+C.
	let lastSize = statSync(filePath).size;
	const watcher = watch(filePath, { persistent: true }, () => {
		// Coalesce rapid filesystem events: read the new bytes and split on
		// newlines (a partial last line is held until the next change event).
		try {
			const st = statSync(filePath);
			if (st.size <= lastSize) {
				lastSize = st.size;
				return;
			}
			const stream = createReadStream(filePath, { start: lastSize, end: st.size });
			let buf = "";
			stream.on("data", (chunk) => {
				buf += chunk.toString();
			});
			stream.on("end", () => {
				const pieces = buf.split(/\r?\n/);
				const last = pieces.pop() ?? "";
				for (const p of pieces) if (p) process.stdout.write(`${opts.json ? p : formatLine(p)}\n`);
				lastSize = st.size - Buffer.byteLength(last); // hold the incomplete line for next read
			});
		} catch {
			/* file rotated / temp-missing — ignore */
		}
	});
	// Keep the process alive until the operator hits Ctrl+C.
	return await new Promise<number>((resolve) => {
		process.on("SIGINT", () => {
			watcher.close();
			resolve(0);
		});
	});
}
