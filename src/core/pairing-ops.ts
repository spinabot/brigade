/**
 * Channel pairing operations behind the `pairing.*` gateway RPCs — the
 * `brigade pairing <list|approve|revoke>` surface, reachable from a remote
 * client.
 *
 * OPERATOR-SCOPED channel access control (approve/deny strangers who DM the
 * bot). Per-channel, never a per-session target, so no per-session guard. The
 * RPCs REQUIRE an explicit `channel` (no CLI-style auto-pick) — a client knows
 * the channel from `system.capabilities`. Reuses the SAME access-control
 * primitives the CLI calls, including the owner-bootstrap + in-channel notify
 * on approve.
 */

import {
	approvePairingCode,
	readChannelOwner,
	readPendingPairings,
	revokePairingCode,
	setChannelOwner,
} from "../agents/channels/access-control/index.js";
import { BUNDLED_MODULES, loadModules } from "../agents/extensions/index.js";
import type { ChannelAdapter } from "../agents/extensions/types.js";
import { DEFAULT_AGENT_ID, resolveAgentWorkspaceDir } from "../config/paths.js";
import { loadConfig } from "./config.js";

/** Best-effort adapter lookup — only `approve` needs it (owner-bootstrap + notify). */
async function resolveAdapter(channel: string): Promise<ChannelAdapter | undefined> {
	try {
		const config = loadConfig();
		const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
		const registry = await loadModules({
			modules: BUNDLED_MODULES,
			meta: { agentId: DEFAULT_AGENT_ID, workspaceDir, cwd: workspaceDir, config: config as never },
		});
		return registry.channels.find((c) => c.id === channel);
	} catch {
		return undefined;
	}
}

export type PairingListResult = {
	channel: string;
	pending: ReturnType<typeof readPendingPairings>;
};
export function handlePairingList(params: unknown): PairingListResult {
	const p = (params ?? {}) as { channel?: string };
	const channel = (p.channel ?? "").trim();
	if (!channel) throw new Error("pairing.list: missing 'channel'");
	return { channel, pending: readPendingPairings(channel) };
}

export interface PairingApproveResult {
	ok: boolean;
	channel: string;
	sender?: string;
	owner?: boolean;
	reason?: string;
}
export async function handlePairingApprove(params: unknown): Promise<PairingApproveResult> {
	const p = (params ?? {}) as { channel?: string; code?: string };
	const channel = (p.channel ?? "").trim();
	const code = (p.code ?? "").trim();
	if (!channel || !code) return { ok: false, channel, reason: "missing 'channel' or 'code'" };
	const approved = approvePairingCode(channel, code);
	if (!approved) return { ok: false, channel, reason: "unknown or expired pairing code" };

	// Owner bootstrap (bot-separate channels like Telegram): the first approved
	// sender becomes the recorded owner so they can run admin commands. Reaching
	// this RPC already proves operator access. Never overwrites an existing owner.
	let becameOwner = false;
	const adapter = await resolveAdapter(channel);
	if (adapter?.pairing?.botIsSeparateFromOperator && !readChannelOwner(channel)) {
		becameOwner = setChannelOwner(channel, approved.senderId);
	}
	// Best-effort in-channel "you're approved" reply when the adapter wires it.
	const notify = adapter?.pairing?.notifyApproval;
	if (notify) {
		try {
			await notify({ senderId: approved.senderId, senderName: approved.senderName });
		} catch {
			/* non-fatal — the approval already landed in the allow-list */
		}
	}
	return { ok: true, channel, sender: approved.senderId, owner: becameOwner };
}

export interface PairingRevokeResult {
	ok: boolean;
	channel: string;
	reason?: string;
}
export function handlePairingRevoke(params: unknown): PairingRevokeResult {
	const p = (params ?? {}) as { channel?: string; code?: string };
	const channel = (p.channel ?? "").trim();
	const code = (p.code ?? "").trim();
	if (!channel || !code) return { ok: false, channel, reason: "missing 'channel' or 'code'" };
	return revokePairingCode(channel, code)
		? { ok: true, channel }
		: { ok: false, channel, reason: "no matching pending code" };
}
