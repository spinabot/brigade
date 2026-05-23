/**
 * `brigade pairing …` — approve/revoke pending pairing codes.
 *
 * When `channels.<id>.dmPolicy` is `pairing` (the default), a stranger DMing
 * the bot gets an 8-char code in the reply and asks the operator to approve
 * it. The operator runs `brigade pairing approve <CODE>` here, which moves
 * the sender from "pending" to the channel's allow-from list — subsequent DMs
 * from that sender reach the agent.
 *
 * Channel resolution mirrors `brigade channels …` (auto-pick when only one
 * channel is available).
 */

import { BUNDLED_MODULES, loadModules } from "../../agents/extensions/index.js";
import { approvePairingCode, readPendingPairings, revokePairingCode } from "../../agents/channels/access-control/index.js";
import { DEFAULT_AGENT_ID, resolveAgentWorkspaceDir } from "../../config/paths.js";
import { loadConfig } from "../../core/config.js";

/** Resolve the channel id; either auto-picked (single channel) or named. */
async function resolveChannelId(wanted: string | undefined): Promise<{ id: string } | { error: number }> {
	const config = loadConfig();
	const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
	const registry = await loadModules({
		modules: BUNDLED_MODULES,
		meta: { agentId: DEFAULT_AGENT_ID, workspaceDir, cwd: workspaceDir, config: config as never },
	});
	const ids = registry.channels.map((c) => c.id);
	if (ids.length === 0) {
		process.stderr.write("No channels are bundled or installed.\n");
		return { error: 2 };
	}
	if (wanted) {
		if (!ids.includes(wanted)) {
			process.stderr.write(`Unknown channel "${wanted}" (have: ${ids.join(", ")}).\n`);
			return { error: 2 };
		}
		return { id: wanted };
	}
	if (ids.length === 1) return { id: ids[0] as string };
	process.stderr.write(`More than one channel is available — pick one with --channel <id> (have: ${ids.join(", ")}).\n`);
	return { error: 2 };
}

/* ─────────────────────────── pairing list ─────────────────────────── */

export async function runPairingList(
	args: { channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const resolved = await resolveChannelId(args.channel);
	if ("error" in resolved) return resolved.error;
	const pending = readPendingPairings(resolved.id);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ channel: resolved.id, pending }, null, 2)}\n`);
		return 0;
	}
	if (pending.length === 0) {
		process.stdout.write(`No pending pairing codes for ${resolved.id}.\n`);
		return 0;
	}
	const header = `${"CODE".padEnd(10)} ${"SENDER".padEnd(28)} ${"NAME".padEnd(20)} CREATED`;
	process.stdout.write(`${header}\n`);
	for (const r of pending) {
		const line = `${r.code.padEnd(10)} ${r.senderId.padEnd(28)} ${(r.senderName ?? "—").padEnd(20)} ${r.createdAt}`;
		process.stdout.write(`${line}\n`);
	}
	return 0;
}

/* ─────────────────────────── pairing approve ─────────────────────────── */

export async function runPairingApprove(
	args: { code: string; channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const resolved = await resolveChannelId(args.channel);
	if ("error" in resolved) return resolved.error;
	const approved = approvePairingCode(resolved.id, args.code);
	if (!approved) {
		const msg = `Unknown or expired pairing code for ${resolved.id}.`;
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, channel: resolved.id, sender: approved.senderId }, null, 2)}\n`);
	} else {
		const who = approved.senderName ? `${approved.senderName} (${approved.senderId})` : approved.senderId;
		process.stdout.write(`Approved ${who} on ${resolved.id}. They can now DM the agent.\n`);
	}
	return 0;
}

/* ─────────────────────────── pairing revoke ─────────────────────────── */

export async function runPairingRevoke(
	args: { code: string; channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const resolved = await resolveChannelId(args.channel);
	if ("error" in resolved) return resolved.error;
	const dropped = revokePairingCode(resolved.id, args.code);
	if (!dropped) {
		const msg = `No matching pending code on ${resolved.id}.`;
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}
	if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, channel: resolved.id })}\n`);
	else process.stdout.write(`Pending code revoked on ${resolved.id}.\n`);
	return 0;
}
