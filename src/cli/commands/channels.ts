/**
 * `brigade channels …` — manage messaging channels (WhatsApp, …).
 *
 * Adapter-agnostic by design: every subcommand resolves the channel adapter
 * through the extension registry, so anything that registers via
 * `b.channel(...)` works automatically — WhatsApp today, more later.
 *
 * Discipline: the link/unlink commands TALK TO THE BAILEYS SOCKET DIRECTLY (no
 * gateway round-trip), so the gateway must be stopped before either — two
 * concurrent Baileys sockets to the same WhatsApp number conflict on WhatsApp's
 * side. The commands check and refuse with a clear message if a gateway PID is
 * alive.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import { BUNDLED_MODULES, loadModules } from "../../agents/extensions/index.js";
import type { ChannelAdapter, ChannelStartContext } from "../../agents/extensions/index.js";
import type { ChannelSetupCredentialKey } from "../../agents/extensions/types.js";
import { addAllowFrom, formatAllowFrom, readAllowFrom, removeAllowFrom } from "../../agents/channels/access-control/index.js";
import { DEFAULT_AGENT_ID, resolveAgentWorkspaceDir, resolveChannelStateDir } from "../../config/paths.js";
import { loadConfig, saveConfig } from "../../core/config.js";
import { isProcessAlive, readPid } from "../../core/gateway-probe.js";
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";
import { WHATSAPP_DEFAULT_ACCOUNT_ID } from "../../agents/channels/whatsapp/account-config.js";
import {
	resolveTelegramBotToken,
	TELEGRAM_CHANNEL_ID,
} from "../../agents/channels/telegram/account-config.js";
import { probeTelegram, type TelegramProbeResult } from "../../agents/channels/telegram/probe.js";

/* ─────────────────────────── helpers ─────────────────────────── */

interface RegistryChannel {
	adapter: ChannelAdapter;
}

/** Load every registered channel adapter (bundled + user-discovered). */
async function loadChannels(): Promise<{ channels: RegistryChannel[]; config: unknown }> {
	const config = loadConfig();
	const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
	const registry = await loadModules({
		modules: BUNDLED_MODULES,
		meta: { agentId: DEFAULT_AGENT_ID, workspaceDir, cwd: workspaceDir, config: config as never },
	});
	return { channels: registry.channels.map((adapter) => ({ adapter })), config };
}

async function gatewayIsRunning(): Promise<boolean> {
	const pid = await readPid();
	return pid != null && isProcessAlive(pid);
}

/** Pick the named channel, or auto-select if there's exactly one. */
function selectChannel(channels: RegistryChannel[], wanted: string | undefined): RegistryChannel | undefined {
	if (wanted) return channels.find((c) => c.adapter.id === wanted);
	if (channels.length === 1) return channels[0];
	return undefined;
}

/** Snapshot of one channel's on-disk + config state (no network). */
interface ChannelSnapshot {
	id: string;
	label: string;
	enabled: boolean; // channels.<id>.enabled in brigade.json
	configured: boolean; // adapter.isConfigured(cfg, env) — usually mirrors `enabled` but adapters can override
	linked: boolean; // auth artifacts present on disk
	stateDir: string; // ~/.brigade/channels/<id>
}

function snapshotChannel(adapter: ChannelAdapter, config: unknown): ChannelSnapshot {
	const cfg = config as { channels?: Record<string, { enabled?: boolean }> };
	const enabled = cfg.channels?.[adapter.id]?.enabled === true;
	let configured = false;
	try {
		configured = adapter.isConfigured(config as never);
	} catch {
		/* adapter shouldn't throw here, but be safe */
	}
	const stateDir = resolveChannelStateDir(adapter.id);
	const linked = hasLinkArtifacts(stateDir);
	return { id: adapter.id, label: adapter.label, enabled, configured, linked, stateDir };
}

/**
 * Read the operator's account id from the channel's auth-store, when one exists.
 *
 * Returns:
 *   - `{ state: "linked", accountHint }` — fully linked; the link command
 *     should print "already linked" and exit.
 *   - `{ state: "partial" }` — creds artifacts exist BUT we can't read an
 *     account id (interrupted first-link, missing `me.id`, or stale
 *     allow-list-only state). The link command should refuse with a clear
 *     "previous link is incomplete; run `wa:unlink` then retry" message
 *     unless `--force` is set, in which case we wipe + start fresh.
 *   - `undefined` — no link artifacts; proceed with a clean QR-and-link.
 *
 * Today this is a WhatsApp-specific peek (the only channel implemented), but
 * the shape is generic — other channels can grow their own state-file parsers
 * as they land.
 */
type ExistingLinkState = { state: "linked"; accountHint: string } | { state: "partial" } | undefined;
function describeExistingLink(channelId: string): ExistingLinkState {
	const stateDir = resolveChannelStateDir(channelId);
	if (!hasLinkArtifacts(stateDir)) return undefined;
	if (channelId === "whatsapp") {
		// Baileys creds at <stateDir>/auth/creds.json. The presence of an
		// auth dir + a creds.json with `me.id` set means a full link
		// completed at some point. If creds.json is missing OR `me.id` is
		// absent (interrupted between QR-scan and 515-restart), report
		// partial so the operator gets actionable guidance.
		const credsPath = path.join(stateDir, "auth", "creds.json");
		if (!existsSync(credsPath)) return { state: "partial" };
		try {
			const creds = JSON.parse(readFileSync(credsPath, "utf8")) as {
				me?: { id?: string };
			};
			const jid = creds?.me?.id;
			if (typeof jid === "string" && jid.length > 0) {
				const beforeAt = jid.split("@")[0] ?? jid;
				const beforeColon = beforeAt.split(":")[0] ?? beforeAt;
				const digits = beforeColon.replace(/\D/g, "");
				if (digits.length >= 7) return { state: "linked", accountHint: digits };
			}
			// creds.json present but no usable id — partial.
			return { state: "partial" };
		} catch {
			// Corrupted creds.json — treat as partial; recovery path is unlink.
			return { state: "partial" };
		}
	}
	// Unknown channel with artifacts on disk — we know it's linked, just no
	// account hint to surface.
	return { state: "linked", accountHint: "" };
}

/** "Looks linked" = the channel's state dir has at least one non-empty file. */
function hasLinkArtifacts(stateDir: string): boolean {
	if (!existsSync(stateDir)) return false;
	const stack = [stateDir];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const p = path.join(dir, name);
			try {
				const st = statSync(p);
				if (st.isFile() && st.size > 0) return true;
				if (st.isDirectory()) stack.push(p);
			} catch {
				/* ignore */
			}
		}
	}
	return false;
}

/** Set `channels.<id>.enabled` in brigade.json (read–modify–write). */
function setChannelEnabled(channelId: string, enabled: boolean): void {
	const cfg = loadConfig() as Record<string, unknown>;
	const channels = (cfg.channels as Record<string, Record<string, unknown>> | undefined) ?? {};
	const entry = channels[channelId] ?? {};
	channels[channelId] = { ...entry, enabled };
	cfg.channels = channels;
	saveConfig(cfg as never);
}

function reportUnknownChannel(channels: RegistryChannel[], wanted: string | undefined): number {
	if (channels.length === 0) {
		process.stderr.write("No channels are bundled or installed.\n");
		return 2;
	}
	if (!wanted) {
		const ids = channels.map((c) => c.adapter.id).join(", ");
		process.stderr.write(`More than one channel is available — pick one with --channel <id> (have: ${ids}).\n`);
		return 2;
	}
	const ids = channels.map((c) => c.adapter.id).join(", ");
	process.stderr.write(`Unknown channel "${wanted}" (have: ${ids}).\n`);
	return 2;
}

/* ─────────────────────────── list ─────────────────────────── */

export async function runChannelsList(opts: { json?: boolean } = {}): Promise<number> {
	const { channels, config } = await loadChannels();
	const rows = channels.map((c) => snapshotChannel(c.adapter, config));
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ channels: rows }, null, 2)}\n`);
		return 0;
	}
	if (rows.length === 0) {
		process.stdout.write("No channels available. Run `brigade channels add --help` to see how to install one.\n");
		return 0;
	}
	const header = `${"ID".padEnd(14)} ${"LABEL".padEnd(16)} ENABLED  LINKED`;
	process.stdout.write(`${header}\n`);
	for (const r of rows) {
		const line = `${r.id.padEnd(14)} ${r.label.padEnd(16)} ${(r.enabled ? "yes" : "no ").padEnd(7)}  ${r.linked ? "yes" : "no"}`;
		process.stdout.write(`${line}\n`);
	}
	return 0;
}

/* ─────────────────────────── status ─────────────────────────── */

export async function runChannelsStatus(
	args: { channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const { channels, config } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const snap = snapshotChannel(chosen.adapter, config);
	const gateway = await gatewayIsRunning();
	// Telegram is token-based + stateless on disk, so "linked" can't be read from
	// files — probe `getMe` for real reachability + bot identity. The probe runs
	// only when a token is configured (otherwise it's a guaranteed failure that
	// adds noise). Best-effort: a probe error never fails the status command.
	let telegramProbe: TelegramProbeResult | undefined;
	if (chosen.adapter.id === TELEGRAM_CHANNEL_ID) {
		const token = resolveTelegramBotToken(config as never, null);
		if (token) telegramProbe = await probeTelegram({ token });
	}
	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ...snap, gateway, ...(telegramProbe ? { probe: telegramProbe } : {}) }, null, 2)}\n`,
		);
		return 0;
	}
	// Human-readable status. The raw `stateDir` lives only on the `--json` path
	// for machine consumers; the operator-visible block stays free of on-disk
	// paths so it reads cleanly in a screenshot or copy-paste.
	process.stdout.write(`${snap.label} (${snap.id})\n`);
	process.stdout.write(`  enabled  : ${snap.enabled ? "yes" : "no"}\n`);
	process.stdout.write(`  configured: ${snap.configured ? "yes" : "no"}\n`);
	// For Telegram, the probe is the authoritative "is it actually working" signal.
	if (telegramProbe) {
		if (telegramProbe.ok) {
			const who = telegramProbe.bot?.username ? `@${telegramProbe.bot.username}` : `id ${telegramProbe.bot?.id ?? "?"}`;
			process.stdout.write(`  reachable: yes (${who}, ${telegramProbe.elapsedMs}ms)\n`);
			process.stdout.write(`  can join groups: ${telegramProbe.bot?.canJoinGroups ? "yes" : "no"}\n`);
		} else {
			process.stdout.write(`  reachable: no (${telegramProbe.error ?? "unknown error"})\n`);
		}
	} else {
		process.stdout.write(`  linked   : ${snap.linked ? "yes" : "no"}\n`);
	}
	process.stdout.write(`  gateway  : ${gateway ? "running" : "stopped"}\n`);
	return 0;
}

/* ─────────────────────────── link ─────────────────────────── */

export async function runChannelsLink(
	args: { channel?: string; timeoutMs?: number; force?: boolean },
	opts: { json?: boolean } = {},
): Promise<number> {
	if (await gatewayIsRunning()) {
		const msg =
			"The Brigade gateway is running. Stop it first (brigade gateway stop) so it doesn't share the channel socket.";
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}

	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const adapter = chosen.adapter;
	const timeoutMs = args.timeoutMs ?? 180_000;

	// Inspect on-disk artifacts BEFORE printing a QR. Three branches:
	//   1) Fully linked → print the "already linked" card + exit.
	//   2) Partial / interrupted previous link → refuse with a clear recovery
	//      path UNLESS --force is set, in which case wipe + proceed.
	//   3) No artifacts → clean link flow.
	const existingLinkInfo = describeExistingLink(adapter.id);
	if (existingLinkInfo?.state === "linked" && !args.force) {
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify({ ok: true, alreadyLinked: true, account: existingLinkInfo.accountHint }, null, 2)}\n`,
			);
		} else {
			process.stdout.write(
				[
					"",
					`ℹ️   ${adapter.label} is already linked`,
					"   ━━━━━━━━━━━━━━━━━━━━━━",
					existingLinkInfo.accountHint
						? `   Connected as: ${formatAccountForDisplay(adapter.id, existingLinkInfo.accountHint)}`
						: "",
					`   Run \`brigade channels unlink --channel ${adapter.id}\` first if you want a fresh QR,`,
					"   or pass `--force` to overwrite the existing link.",
					"",
				]
					.filter(Boolean)
					.join("\n") + "\n",
			);
		}
		return 0;
	}
	if (existingLinkInfo?.state === "partial" && !args.force) {
		const msg = [
			"",
			`⚠️   ${adapter.label} has an incomplete previous link on disk`,
			"   ━━━━━━━━━━━━━━━━━━━━━━",
			"   It looks like a previous link was interrupted before it finished.",
			"   Pick one:",
			`     • \`brigade channels unlink --channel ${adapter.id}\`  — clear it, then re-run \`brigade channels link\``,
			`     • re-run with \`--force\`                                — Brigade will clear the stale state for you`,
			"",
		].join("\n") + "\n";
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, reason: "incomplete previous link" }, null, 2)}\n`);
		} else {
			process.stderr.write(msg);
		}
		return 1;
	}
	if (args.force) {
		// Operator opted into a fresh link — clear prior auth so the adapter
		// opens on a clean slate. Failure to clear is non-fatal (the link still
		// tries); surface a warning so it isn't silent.
		const rctx = tryGetRuntimeContext();
		if (rctx?.mode === "convex") {
			// No state dir in convex mode — creds + keys live in the
			// whatsappAuthCreds/Keys tables. The disk-based existingLinkInfo
			// probe can't see them, so clear unconditionally on --force
			// (clearing an absent account is a harmless no-op).
			if (adapter.id === "whatsapp") {
				try {
					await rctx.store.channels.clearWhatsAppAuth(WHATSAPP_DEFAULT_ACCOUNT_ID);
					process.stdout.write(`(forced: cleared previous ${adapter.label} auth before linking)\n`);
				} catch (err) {
					process.stderr.write(
						`(warning: --force could not clear previous auth: ${err instanceof Error ? err.message : String(err)})\n`,
					);
				}
			}
		} else if (existingLinkInfo) {
			const dir = resolveChannelStateDir(adapter.id);
			try {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
				process.stdout.write(`(forced: cleared previous ${adapter.label} state before linking)\n`);
			} catch (err) {
				process.stderr.write(
					`(warning: --force could not clear previous state: ${err instanceof Error ? err.message : String(err)})\n`,
				);
			}
		}
	}

	const abort = new AbortController();
	let connected = false;
	let loggedOut = false;
	let resolveDone: () => void = () => {};
	let rejectDone: (e: Error) => void = () => {};
	const done = new Promise<void>((res, rej) => {
		resolveDone = res;
		rejectDone = rej;
	});

	const onSigint = () => {
		process.stderr.write("\nLink cancelled.\n");
		abort.abort();
		void adapter.stop().catch(() => {});
		process.exit(130);
	};
	process.on("SIGINT", onSigint);

	const timer = setTimeout(() => {
		rejectDone(new Error(`Link timed out after ${Math.round(timeoutMs / 1000)}s.`));
	}, timeoutMs);
	// Deliberately NOT `.unref()` — this timer is the one thing anchoring the
	// Node event loop during the brief window between the post-pair 515 close
	// and the rebuilt socket reaching `open`. Unref'ing both this AND the
	// adapter's reconnect timer (the previous bug) leaves a gap where the loop
	// has nothing to wait on, Node exits early, the success card never prints,
	// and the operator sees "Detected unsettled top-level await" instead.
	// The `process.exit(…)` in the `finally` cleans up if this timer outlives
	// the success path, so anchoring here is safe.

	// Track which logs we render to the user. Adapters emit verbose protocol-
	// level logs (the gateway needs them); the link CLI should stay quiet and
	// let the polished status lines below do the talking. We silently swallow
	// adapter logs and surface them only on failure for diagnostics.
	const swallowedLogs: string[] = [];

	const ctx: ChannelStartContext = {
		signal: abort.signal,
		// One-shot pair: tell the adapter not to chase transient reconnects (the
		// 515 hop that's part of a real pair is still honored). The CLI's outer
		// timeout owns the "user took too long" case.
		linkMode: true,
		log: (msg) => {
			// Buffer for failure diagnostics; do NOT print to the user — the
			// link UX is shaped by the polished lines below.
			swallowedLogs.push(`[${adapter.id}] ${msg}`);
		},
		onLinkProgress: (status) => {
			// Single polished status line during multi-step handshakes (e.g.
			// WhatsApp's post-pair 515 restart). The adapter only emits these
			// in linkMode so the CLI gets the friendly cadence without
			// touching the gateway's structured logs.
			process.stdout.write(`${status}\n`);
		},
		onPairing: (info) => {
			// The adapter has already rendered the QR via qrcode-terminal AND
			// printed the "Scan this QR in WhatsApp → Settings → Linked
			// Devices:" prompt above the code. No second prompt needed here —
			// duplicating it just clutters the screen.
			if (info.kind === "code") {
				process.stdout.write(`\nPairing code: ${info.value}\n`);
			}
		},
		onConnected: () => {
			connected = true;
			resolveDone();
		},
		onLoggedOut: () => {
			loggedOut = true;
			rejectDone(new Error("The channel rejected the link (creds invalid). Try `brigade channels unlink` and retry."));
		},
		// No inbound during link — return resolved if anything arrives.
		onInbound: async () => {},
	};

	let outcome: { ok: boolean; reason?: string };
	let linkedAccount: string | undefined;
	try {
		process.stdout.write(`Linking ${adapter.label}…\n`);
		await adapter.start(ctx);
		await done;
		// Grab the linked account id (digits-only E.164 for WhatsApp; channel-
		// native otherwise) BEFORE we stop the adapter — selfId may be cleared
		// during teardown.
		linkedAccount = adapter.selfId?.();
		outcome = { ok: true };
		// Enable the channel in config so the gateway picks it up on next boot.
		try {
			setChannelEnabled(adapter.id, true);
		} catch (err) {
			process.stderr.write(
				`(warning: linked, but Brigade could not enable the channel in your config: ${err instanceof Error ? err.message : String(err)})\n`,
			);
		}
	} catch (err) {
		outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", onSigint);
		abort.abort();
		try {
			await adapter.stop();
		} catch {
			/* best-effort */
		}
	}

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ...outcome, connected, loggedOut, account: linkedAccount }, null, 2)}\n`,
		);
	} else if (outcome.ok) {
		// Polished success card — matches the welcome-card style so an operator
		// finishing the link gets the same on-brand cadence as a friend going
		// through pairing.
		const accountLine = linkedAccount
			? `   Connected as: ${formatAccountForDisplay(adapter.id, linkedAccount)}\n`
			: "";
		process.stdout.write(
			[
				"",
				`✅  ${adapter.label} linked successfully`,
				"   ━━━━━━━━━━━━━━━━━━━━━━",
				accountLine.trimEnd(),
				"   Run `brigade gateway` to start receiving messages.",
				"",
			]
				.filter(Boolean)
				.join("\n") + "\n",
		);
	} else {
		process.stderr.write(`\nLink failed: ${outcome.reason}\n`);
		// On failure, replay buffered adapter logs so the operator has the
		// protocol-level detail they need to diagnose.
		if (swallowedLogs.length > 0) {
			process.stderr.write("\n--- adapter log ---\n");
			for (const line of swallowedLogs) process.stderr.write(`${line}\n`);
		}
	}
	// Drain write-behind chains (account config entry + channel access) before
	// the one-shot exit so a successful link in convex mode isn't lost. The
	// WhatsApp auth creds ride the adapter's own flush, awaited in its stop().
	try {
		const { flushAllPendingWrites } = await import("../../storage/flush.js");
		await flushAllPendingWrites();
	} catch {
		/* best-effort — never block exit on a drain failure */
	}
	// Baileys keeps internal keepalive timers + unsettled promise chains alive
	// after `adapter.stop()`; without an explicit exit, Node sees a pending
	// top-level await on the entry shim and emits an "unsettled top-level
	// await" warning while it exits anyway. Exiting cleanly here avoids the
	// warning. The link command is a one-shot exit.
	process.exit(outcome.ok ? 0 : 1);
}

/**
 * Render a channel-native account id for the success card.
 * WhatsApp gives us digits-only E.164 — show it as `+15551234567` so it reads
 * like a phone number. Other channels get their id verbatim.
 */
function formatAccountForDisplay(channelId: string, accountId: string): string {
	if (channelId === "whatsapp" && /^\d{7,15}$/.test(accountId)) {
		return `+${accountId}`;
	}
	return accountId;
}

/* ─────────────────────────── unlink ─────────────────────────── */

export async function runChannelsUnlink(
	args: { channel?: string; yes?: boolean },
	opts: { json?: boolean } = {},
): Promise<number> {
	if (await gatewayIsRunning()) {
		const msg = "The Brigade gateway is running. Stop it first (brigade gateway stop) before unlinking.";
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}
	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const id = chosen.adapter.id;
	const dir = resolveChannelStateDir(id);

	if (!args.yes && process.stdin.isTTY) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		try {
			const answer = (await rl.question(`Unlink ${id} and erase its saved credentials? [y/N] `)).trim().toLowerCase();
			if (answer !== "y" && answer !== "yes") {
				process.stderr.write("Cancelled.\n");
				return 1;
			}
		} finally {
			rl.close();
		}
	}

	try {
		// Convex mode — credentials live in the whatsappAuthCreds/Keys tables,
		// not on disk, so the dir wipe below is a no-op; clear the backend rows
		// explicitly. The dir wipe still runs (harmless when absent) so a
		// mixed-history install with leftover files is also cleaned.
		const rctx = tryGetRuntimeContext();
		if (rctx?.mode === "convex" && id === "whatsapp") {
			await rctx.store.channels.clearWhatsAppAuth(WHATSAPP_DEFAULT_ACCOUNT_ID);
		}
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		// Operator-visible: no on-disk path, just the failure reason. The full
		// path lives in the operator log (resolved via `resolveChannelStateDir`)
		// for diagnostics.
		else process.stderr.write(`Failed to remove the channel's saved credentials: ${msg}\n`);
		return 1;
	}
	try {
		setChannelEnabled(id, false);
	} catch {
		/* config update is best-effort — the on-disk wipe is the source of truth */
	}
	if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
	else process.stdout.write(`${chosen.adapter.label} unlinked. Re-run \`brigade channels link\` to scan a new code.\n`);
	return 0;
}

/* ─────────────────────────── enable / disable ─────────────────────────── */

async function setEnableFlag(channel: string | undefined, enabled: boolean, json: boolean | undefined): Promise<number> {
	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, channel);
	if (!chosen) return reportUnknownChannel(channels, channel);
	try {
		setChannelEnabled(chosen.adapter.id, enabled);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`Failed to update Brigade config: ${msg}\n`);
		return 1;
	}
	const verb = enabled ? "enabled" : "disabled";
	if (json) process.stdout.write(`${JSON.stringify({ ok: true, channel: chosen.adapter.id, enabled })}\n`);
	else process.stdout.write(`${chosen.adapter.label} ${verb}.\n`);
	return 0;
}

export const runChannelsEnable = (args: { channel?: string }, opts: { json?: boolean } = {}) =>
	setEnableFlag(args.channel, true, opts.json);
export const runChannelsDisable = (args: { channel?: string }, opts: { json?: boolean } = {}) =>
	setEnableFlag(args.channel, false, opts.json);

/* ─────────────────────────── add (setup wizard) ─────────────────────────── */

/**
 * Prompt function shape — abstracts `readline/promises` so tests can drive the
 * wizard without touching real stdin. Returns the operator's typed value
 * (already trimmed of trailing newline by readline) or `null` if the operator
 * cancelled (Ctrl+D / EOF).
 */
type CredentialPrompter = (key: ChannelSetupCredentialKey) => Promise<string | null>;

/**
 * Test injection hook — overrides the channel registry + prompter so tests can
 * drive the wizard against a fake adapter without spinning up the bundled
 * modules. Production callers leave this `undefined`; tests set it in
 * `beforeEach` and clear it in `afterEach`.
 */
interface ChannelsAddTestHooks {
	channels?: ChannelAdapter[];
	prompter?: CredentialPrompter;
}
let testHooks: ChannelsAddTestHooks | undefined;

/** @internal — tests only. */
export function __setChannelsAddTestHooksForTests(hooks: ChannelsAddTestHooks | undefined): void {
	testHooks = hooks;
}

/** Default readline-backed prompter. Hides input for `secret: true` keys. */
async function defaultCredentialPrompter(key: ChannelSetupCredentialKey): Promise<string | null> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	try {
		const labelParts = [key.prompt];
		if (key.docsUrl) labelParts.push(`(${key.docsUrl})`);
		const label = `${labelParts.join(" ")}: `;
		if (key.secret) {
			return await promptHidden(rl, label);
		}
		const answer = await rl.question(label);
		return answer;
	} catch {
		return null;
	} finally {
		rl.close();
	}
}

/**
 * Hide raw-mode input for secret prompts. Falls back to a plain prompt if the
 * stream isn't a TTY (CI / non-interactive); the wizard's `--non-interactive`
 * gate is the right path for those flows, so this fallback only kicks in when
 * an operator pipes input by accident.
 */
async function promptHidden(rl: readline.Interface, label: string): Promise<string> {
	const stdin = process.stdin;
	const isTTY = stdin.isTTY === true && typeof stdin.setRawMode === "function";
	if (!isTTY) {
		// No TTY — surface a "(input hidden where supported)" hint and read plain.
		return await rl.question(`${label}`);
	}
	return await new Promise<string>((resolve) => {
		process.stderr.write(label);
		let buf = "";
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") {
					stdin.setRawMode?.(false);
					stdin.pause();
					stdin.removeListener("data", onData);
					process.stderr.write("\n");
					resolve(buf);
					return;
				}
				if (ch === "") {
					// Ctrl+C — restore the terminal and re-emit so SIGINT semantics work.
					stdin.setRawMode?.(false);
					stdin.pause();
					stdin.removeListener("data", onData);
					process.stderr.write("\n");
					process.kill(process.pid, "SIGINT");
					return;
				}
				if (ch === "" || ch === "\b") {
					// Backspace.
					if (buf.length > 0) buf = buf.slice(0, -1);
					continue;
				}
				buf += ch;
			}
		};
		stdin.on("data", onData);
	});
}

/**
 * Walk the operator through a channel's setup wizard:
 *   1. Resolve the channel adapter (must declare a `setup` block — QR/OAuth
 *      channels like WhatsApp don't, and get a friendly redirect to
 *      `brigade channels link`).
 *   2. Prompt for every declared credential key (env-var pre-fill where set,
 *      hidden input for `secret: true`, re-prompt on validator rejection).
 *   3. Build the `channels.<id>` config block (via `buildAccountConfig` when
 *      the adapter provides one, otherwise the values verbatim) and merge it
 *      into brigade.json with `enabled: true`.
 *   4. Print a polished success card matching `channels link`.
 *
 * `--non-interactive` skips prompting entirely — every credential MUST come
 * from its declared `envVar`, otherwise the wizard errors out cleanly. That's
 * the path for CI / config-as-code setups.
 */
export async function runChannelsAdd(
	args: { channel?: string; nonInteractive?: boolean },
	opts: { json?: boolean } = {},
): Promise<number> {
	const channels = testHooks?.channels
		? testHooks.channels.map((adapter) => ({ adapter }))
		: (await loadChannels()).channels;
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const adapter = chosen.adapter;

	if (!adapter.setup) {
		const msg = `This channel uses pairing/QR — run \`brigade channels link --channel ${adapter.id}\` instead.`;
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, reason: msg, channel: adapter.id })}\n`);
		} else {
			process.stderr.write(`${msg}\n`);
		}
		return 2;
	}

	const setup = adapter.setup;
	const prompter = testHooks?.prompter ?? defaultCredentialPrompter;
	const values: Record<string, string> = {};
	const nonInteractive = args.nonInteractive === true;

	// Header — only the human path gets the card-style intro.
	if (!opts.json) {
		process.stdout.write(`\nConfiguring ${adapter.label} (${adapter.id})…\n`);
	}

	for (const key of setup.credentialKeys) {
		// 1) Env-var pre-fill — when set, use it without re-prompting (works
		//    in both interactive and non-interactive modes; CI relies on this).
		const envValue = key.envVar ? process.env[key.envVar] : undefined;
		if (envValue !== undefined && envValue.length > 0) {
			const trimmed = envValue.trim();
			const validation = setup.validateInput?.(key.key, trimmed) ?? null;
			if (validation) {
				const msg = `Value from $${key.envVar} for "${key.key}" was rejected: ${validation}`;
				if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
				else process.stderr.write(`${msg}\n`);
				return 2;
			}
			values[key.key] = trimmed;
			if (!opts.json) process.stdout.write(`  • ${key.key}: using $${key.envVar}\n`);
			continue;
		}

		// 2) Non-interactive + no env-var → bail with a clear message.
		if (nonInteractive) {
			const envHint = key.envVar ? ` (set $${key.envVar})` : "";
			const msg = `Missing credential "${key.key}" in non-interactive mode${envHint}.`;
			if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg, key: key.key })}\n`);
			else process.stderr.write(`${msg}\n`);
			return 2;
		}

		// 3) Interactive prompt with validator retry. Three attempts then we
		//    give up — protects an operator who's typing the wrong value over
		//    and over from an infinite loop in non-TTY-ish environments.
		const MAX_ATTEMPTS = 3;
		let accepted: string | undefined;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const raw = await prompter(key);
			if (raw === null) {
				if (opts.json) {
					process.stdout.write(`${JSON.stringify({ ok: false, reason: "cancelled" })}\n`);
				} else {
					process.stderr.write("Cancelled.\n");
				}
				return 1;
			}
			const value = raw.trim();
			if (!value) {
				process.stderr.write(`  ${key.key} cannot be empty. Try again.\n`);
				continue;
			}
			const validation = setup.validateInput?.(key.key, value) ?? null;
			if (validation) {
				process.stderr.write(`  ${validation}\n`);
				continue;
			}
			accepted = value;
			break;
		}
		if (accepted === undefined) {
			const msg = `Gave up after ${MAX_ATTEMPTS} attempts on "${key.key}".`;
			if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
			else process.stderr.write(`${msg}\n`);
			return 1;
		}
		values[key.key] = accepted;
	}

	// 4) Assemble the channels.<id> config block. `buildAccountConfig` lets
	//    an adapter restructure raw inputs (e.g. nest under `slack.bot.*`)
	//    before they hit brigade.json. When omitted, values land verbatim.
	let block: Record<string, unknown>;
	try {
		block = setup.buildAccountConfig ? setup.buildAccountConfig(values) : { ...values };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`Failed to assemble channel config: ${msg}\n`);
		return 1;
	}

	// 5) Merge into brigade.json under channels.<id>, mark enabled.
	try {
		const cfg = loadConfig() as Record<string, unknown>;
		const cfgChannels = (cfg.channels as Record<string, Record<string, unknown>> | undefined) ?? {};
		const existing = (cfgChannels[adapter.id] ?? {}) as Record<string, unknown>;
		cfgChannels[adapter.id] = { ...existing, ...block, enabled: true };
		cfg.channels = cfgChannels;
		saveConfig(cfg as never);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`Failed to write Brigade config: ${msg}\n`);
		return 1;
	}

	// 6) Polished success card — same cadence as `channels link`.
	const credentialCount = Object.keys(values).length;
	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, channel: adapter.id, credentialCount, fields: Object.keys(values) }, null, 2)}\n`,
		);
	} else {
		process.stdout.write(
			[
				"",
				`✅  ${adapter.label} configured`,
				"   ━━━━━━━━━━━━━━━━━━━━",
				`   Saved ${credentialCount} credential${credentialCount === 1 ? "" : "s"} to your Brigade config.`,
				"   Run `brigade gateway` to start receiving messages.",
				"",
			].join("\n") + "\n",
		);
	}
	return 0;
}

/* ─────────────────────────── allow list / add / remove ─────────────────────────── */

export async function runChannelsAllowList(
	args: { channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const allow = readAllowFrom(chosen.adapter.id);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ channel: chosen.adapter.id, allowFrom: allow }, null, 2)}\n`);
		return 0;
	}
	// Shared display formatter — identical rendering to the in-chat
	// `/allowlist list` command (both call `formatAllowFrom`).
	const rendered = formatAllowFrom(allow, {
		channelLabel: chosen.adapter.label,
		emptyText: `No senders are on ${chosen.adapter.id}'s allow-from list yet.`,
	});
	process.stdout.write(`${rendered}\n`);
	return 0;
}

export async function runChannelsAllowAdd(
	args: { id: string; channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	// Per-channel normalization — the adapter may strip an `@` prefix or
	// `<@U…>` mention syntax before the entry is persisted. Channels without
	// `pairing.normalizeAllowEntry` see identity.
	const normalized = chosen.adapter.pairing?.normalizeAllowEntry?.(args.id) ?? args.id;
	const added = addAllowFrom(chosen.adapter.id, normalized);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, channel: chosen.adapter.id, added, id: normalized })}\n`);
	} else if (added) {
		process.stdout.write(`Added "${normalized}" to ${chosen.adapter.label}'s allow-from list.\n`);
	} else {
		process.stdout.write(`"${normalized}" was already on ${chosen.adapter.label}'s allow-from list.\n`);
	}
	return 0;
}

export async function runChannelsAllowRemove(
	args: { id: string; channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const removed = removeAllowFrom(chosen.adapter.id, args.id);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: removed, channel: chosen.adapter.id, id: args.id })}\n`);
	} else if (removed) {
		process.stdout.write(`Removed "${args.id}" from ${chosen.adapter.label}'s allow-from list.\n`);
	} else {
		process.stderr.write(`"${args.id}" was not on ${chosen.adapter.label}'s allow-from list.\n`);
	}
	return removed ? 0 : 1; // exit code reflects the action, regardless of output mode
}
