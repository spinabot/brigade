/**
 * Brigade gateway live console stream.
 *
 * When `brigade gateway --verbose` is set, the server writes a one-line
 * summary of every interesting event to stderr in real time so the operator
 * watching the gateway terminal can SEE what's happening — instead of
 * tailing the JSONL log file in another window.
 *
 * Format:
 *   - Subsystem prefix in brackets, color per subsystem    e.g. `[gateway]`
 *   - Directional arrow:                                   `←` req, `⇄` res, `→` event, `•` info
 *   - Optional status token after the verb:                `✓` success, `✗` error
 *   - Compact key=value tail, truncated per field          `tool=read path=src/cli.ts`
 *
 * The stream is a STRICT SUBSET of what's in the JSONL log. Noisy events
 * (`message_update` deltas — one per token) are dropped by default and only
 * emitted at `--log-level debug`. The JSONL file remains the source of truth.
 *
 * Output goes to STDERR so it doesn't pollute any future stdout protocol
 * the gateway might speak (e.g. JSON-RPC mode for ACP clients).
 */

import process from "node:process";

import chalk from "chalk";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RequestMethod } from "../protocol.js";

/* ─────────────────────────── public surface ─────────────────────────── */

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface ConsoleStreamOptions {
	/** Threshold below which lines are dropped. Default: "info". */
	level?: LogLevel;
	/** Override stderr (used by tests). Defaults to process.stderr.write. */
	write?: (line: string) => void;
	/** Disable color codes (used by tests + dumb terminals). */
	color?: boolean;
}

export interface ConsoleStream {
	/** Pi event from the agent loop. */
	pi(event: AgentSessionEvent): void;
	/** Inbound WebSocket request from a client. */
	wsRequest(method: RequestMethod, id: string, clientLabel?: string): void;
	/** Response sent back to a client (durationMs measured at the call site). */
	wsResponse(method: RequestMethod, id: string, ok: boolean, durationMs: number): void;
	/** Client connected. */
	clientConnected(label: string, totalClients: number): void;
	/** Client disconnected. */
	clientDisconnected(label: string, totalClients: number): void;
	/** Server-level info / warn / error. */
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	/** Banner printed once at boot. */
	banner(host: string, port: number, logPath: string): void;
}

/* ─────────────────────────── construction ─────────────────────────── */

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Subsystems get a stable, human-pleasing color. Hash-pick from a small palette. */
const SUBSYSTEM_COLORS: Record<string, (s: string) => string> = {
	gateway: chalk.cyan,
	agent: chalk.magenta,
	tool: chalk.yellow,
	auth: chalk.blue,
	"": chalk.dim,
};

/** Pi event types we drop unless the level is `debug`. The JSONL log keeps them. */
const NOISY_EVENT_TYPES = new Set<string>([
	"message_update", // one per text/thinking delta — floods the terminal
]);

export function createConsoleStream(opts: ConsoleStreamOptions = {}): ConsoleStream {
	const level = opts.level ?? "info";
	const useColor = opts.color ?? true;
	const write = opts.write ?? ((line: string) => void process.stderr.write(`${line}\n`));

	const c = (color: (s: string) => string, s: string): string => (useColor ? color(s) : s);
	const subTag = (sub: keyof typeof SUBSYSTEM_COLORS): string => {
		const colorFn = SUBSYSTEM_COLORS[sub] ?? SUBSYSTEM_COLORS[""]!;
		return c(colorFn, `[${sub}]`.padEnd(11));
	};

	const ts = (): string => c(chalk.dim, new Date().toISOString().slice(11, 23)); // HH:mm:ss.SSS

	const allow = (msgLevel: LogLevel): boolean => LEVEL_RANK[msgLevel] <= LEVEL_RANK[level];

	const arrow = (kind: "req" | "res" | "event" | "info"): string => {
		const sym = kind === "req" ? "←" : kind === "res" ? "⇄" : kind === "event" ? "→" : "•";
		const colorFn =
			kind === "req" ? chalk.green : kind === "res" ? chalk.yellow : kind === "event" ? chalk.cyan : chalk.dim;
		return c(colorFn, sym);
	};

	const status = (ok: boolean): string => c(ok ? chalk.green : chalk.red, ok ? "✓" : "✗");

	const trunc = (v: unknown, max = 60): string => {
		const s = typeof v === "string" ? v : JSON.stringify(v);
		if (!s) return "";
		return s.length > max ? `${s.slice(0, max - 1)}…` : s;
	};

	// Pull a short human-readable snippet out of a tool result for the `✗` log
	// line. Without it a failed tool logged only its name, so a prepare-stage
	// refusal (malformed/empty args, schema-validation throw) or a provider error
	// was undiagnosable from the gateway stream alone — exactly the `spawn_agents ✗`
	// with no cause that sent us spelunking.
	const toolResultText = (result: unknown): string | undefined => {
		if (result == null) return undefined;
		if (typeof result === "string") return result.trim() || undefined;
		const r = result as { content?: unknown; error?: unknown; message?: unknown };
		if (Array.isArray(r.content)) {
			const text = r.content
				.map((p) =>
					p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
						? (p as { text: string }).text
						: "",
				)
				.filter(Boolean)
				.join(" ")
				.trim();
			if (text) return text;
		}
		if (typeof r.error === "string" && r.error.trim()) return r.error;
		if (typeof r.message === "string" && r.message.trim()) return r.message;
		try {
			return JSON.stringify(result);
		} catch {
			return String(result);
		}
	};

	const fields = (kv: Record<string, unknown>): string =>
		Object.entries(kv)
			.filter(([, v]) => v !== undefined && v !== null && v !== "")
			.map(([k, v]) => `${c(chalk.dim, k)}=${trunc(v)}`)
			.join(" ");

	const line = (
		levelFor: LogLevel,
		sub: keyof typeof SUBSYSTEM_COLORS,
		body: string,
	): void => {
		if (!allow(levelFor)) return;
		write(`${ts()} ${subTag(sub)} ${body}`);
	};

	return {
		pi(event) {
			const t = event.type;
			if (NOISY_EVENT_TYPES.has(t) && !allow("debug")) return;

			// Pick subsystem + extract the most useful 2–3 fields per event type.
			// Catch-all at the bottom keeps the stream COMPLETE — every event
			// type produces a line, even if the body is just the type name.
			const ev = event as any;
			let sub: keyof typeof SUBSYSTEM_COLORS = "agent";
			let body = "";
			let levelFor: LogLevel = "info";

			switch (t) {
				case "agent_start":
					body = `${arrow("event")} agent_start`;
					break;
				case "agent_end": {
					const messages = Array.isArray(ev.messages) ? ev.messages : [];
					const last = messages[messages.length - 1];
					const stopReason = last?.stopReason;
					const isError = stopReason === "error" || stopReason === "aborted";
					body = `${arrow("event")} agent_end ${status(!isError)} ${fields({ stopReason, messages: messages.length })}`;
					if (isError) levelFor = "warn";
					break;
				}
				case "turn_start":
					body = `${arrow("event")} turn_start`;
					break;
				case "turn_end": {
					const usage = ev.message?.usage;
					// `usage.cost` is the Pi SDK's structured cost record —
					// `{ input, output, cacheRead, cacheWrite, total }` (not a number).
					// We surface only `total`. A real cost is ALWAYS >= 0; an UNPRICED
					// model (openrouter/auto, ollama, a custom endpoint) carries a -1
					// price sentinel in the catalog, so Pi computes `total` as -(in+out)
					// — a nonsense negative. So we show the dollar amount only when it's
					// finite AND non-negative, and "n/a" otherwise (unpriced/unknown),
					// never a garbage negative or `$NaN`.
					const cost = usage?.cost as { total?: unknown } | undefined;
					const total = typeof cost?.total === "number" ? cost.total : Number.NaN;
					body = `${arrow("event")} turn_end ${fields({
						in: usage?.input,
						out: usage?.output,
						cost: Number.isFinite(total) && total >= 0 ? `$${total.toFixed(4)}` : "n/a",
					})}`;
					break;
				}
				case "tool_execution_start":
					sub = "tool";
					body = `${arrow("event")} tool_start ${fields({
						tool: ev.toolName,
						args: ev.args ? trunc(ev.args, 80) : undefined,
					})}`;
					break;
				case "tool_execution_end": {
					sub = "tool";
					body = `${arrow("event")} tool_end ${status(!ev.isError)} ${fields({
						tool: ev.toolName,
					})}`;
					if (ev.isError) {
						levelFor = "warn";
						const snip = toolResultText(ev.result);
						if (snip) body += ` ${c(chalk.dim, "err")}=${trunc(snip, 160)}`;
					}
					break;
				}
				case "message_start":
				case "message_end":
					body = `${arrow("event")} ${t} ${fields({ role: ev.message?.role })}`;
					levelFor = "debug";
					break;
				case "message_update":
					// Already filtered above unless debug; show inner type only.
					body = `${arrow("event")} message_update ${fields({ inner: ev.assistantMessageEvent?.type })}`;
					levelFor = "debug";
					break;
				case "compaction_start":
					body = `${arrow("event")} compaction_start`;
					break;
				case "compaction_end":
					body = `${arrow("event")} compaction_end ${status(!ev.aborted)}`;
					if (ev.aborted) levelFor = "warn";
					break;
				case "auto_retry_start":
					body = `${arrow("event")} auto_retry_start ${fields({
						attempt: ev.attempt,
						max: ev.maxAttempts,
						delayMs: ev.delayMs,
					})}`;
					levelFor = "warn";
					break;
				case "auto_retry_end":
					body = `${arrow("event")} auto_retry_end ${status(ev.success !== false)} ${fields({ attempt: ev.attempt })}`;
					if (ev.success === false) levelFor = "warn";
					break;
				default:
					body = `${arrow("event")} ${t}`;
					levelFor = "debug";
			}
			line(levelFor, sub, body);
		},

		wsRequest(method, id, clientLabel) {
			line(
				"info",
				"gateway",
				`${arrow("req")} req ${method} ${fields({ id, from: clientLabel })}`,
			);
		},
		wsResponse(method, id, ok, durationMs) {
			line(
				ok ? "info" : "warn",
				"gateway",
				`${arrow("res")} res ${method} ${status(ok)} ${fields({ id, ms: durationMs })}`,
			);
		},
		clientConnected(label, totalClients) {
			line("info", "gateway", `${arrow("info")} client connected ${fields({ from: label, total: totalClients })}`);
		},
		clientDisconnected(label, totalClients) {
			line("info", "gateway", `${arrow("info")} client disconnected ${fields({ from: label, total: totalClients })}`);
		},
		info(message) {
			line("info", "gateway", `${arrow("info")} ${message}`);
		},
		warn(message) {
			line("warn", "gateway", `${arrow("info")} ${c(chalk.yellow, message)}`);
		},
		error(message) {
			line("error", "gateway", `${arrow("info")} ${c(chalk.red, message)}`);
		},
		banner(host, port, logPath) {
			line("info", "gateway", `${arrow("info")} listening on ws://${host}:${port}`);
			line("info", "gateway", `${arrow("info")} jsonl log: ${logPath}`);
			line(
				"info",
				"gateway",
				`${arrow("info")} log level: ${c(chalk.bold, level)} ${c(chalk.dim, "— Ctrl+C to stop")}`,
			);
		},
	};
}
