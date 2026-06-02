/**
 * Process-wide channel-manager singleton accessor.
 *
 * The gateway boots exactly ONE `ChannelManager` instance at startup
 * (`server.ts` → `startChannels`) which owns every started adapter. Agent
 * tools that need to reach those adapters mid-turn — chiefly `send_message`,
 * but also future `react`, `poll`, `edit` actions — call
 * `getActiveChannelManager()` to find them.
 *
 * Following the same pattern as `cron/active-service.ts` (singleton mounted
 * at boot, accessor returns `null` when no gateway is running). Tools that
 * find a null accessor refuse politely so unit tests + standalone CLI
 * invocations get a clear error instead of a confusing exception.
 *
 * P1#9 (Wave H) — pinned via `resolveGlobalSingleton` so dual-loaded
 * Brigade modules (test harness + runtime in one process; hot-reload in
 * dev) share ONE slot. Without the pin, an agent tool importing a
 * different copy of this module than the boot path would silently see
 * `null` even after the gateway started.
 */

import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { ChannelManager } from "./manager.js";

type ActiveChannelManagerState = { activeManager: ChannelManager | null };

const ACTIVE_CHANNEL_MANAGER_KEY = Symbol.for("brigade.channels.activeManager");

function getState(): ActiveChannelManagerState {
	return resolveGlobalSingleton<ActiveChannelManagerState>(ACTIVE_CHANNEL_MANAGER_KEY, () => ({
		activeManager: null,
	}));
}

/**
 * Mount the gateway's channel manager so process-wide tools can reach it.
 * Called by `server.ts` immediately after `startChannels` resolves so a
 * cron job firing during boot (rare but possible) can still dispatch.
 * Tests pass `null` in afterEach to clear leakage between cases.
 */
export function setActiveChannelManager(manager: ChannelManager | null): void {
	getState().activeManager = manager;
}

/** Read the active channel manager. Returns `null` when none is mounted. */
export function getActiveChannelManager(): ChannelManager | null {
	return getState().activeManager;
}
