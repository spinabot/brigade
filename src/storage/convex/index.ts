// src/storage/convex/index.ts
//
// ConvexBrigadeStore — all 16 sub-stores wired against the local backend's
// 29-table schema. Some methods inside individual adapters still throw
// `NotImplementedYet` for surfaces that need follow-up work (vector
// `findSimilar`, Convex File Storage `blobs.get/delete`, live-query
// subscriptions) — those are documented at their call sites.
//
// Identity scoping: `instanceId` = per-machine key; `ownerId` = per-operator
// key. In Phase 2 single-operator both resolve to `brigade-local`. Phase 3
// (the private `brigade-cloud` overlay) introduces tenant-level routing
// without touching the adapter contract.

import { ConvexAuthStore } from "./auth-store.js";
import { ConvexBlobStore } from "./blob-store.js";
import { ConvexChannelStore } from "./channel-store.js";
import { ConvexConfigStore } from "./config-store.js";
import { ConvexCronStore } from "./cron-store.js";
import { ConvexExecApprovalStore } from "./exec-approval-store.js";
import { ConvexExtensionStore } from "./extension-store.js";
import { ConvexInstanceStore } from "./instance-store.js";
import { ConvexLogStore } from "./log-store.js";
import { ConvexMemoryStore } from "./memory-store.js";
import { ConvexMessageStore } from "./message-store.js";
import { ConvexOrgStore } from "./org-store.js";
import { ConvexSessionStore } from "./session-store.js";
import { ConvexSkillStore } from "./skill-store.js";
import { ConvexSubagentStore } from "./subagent-store.js";
import { ConvexWorkspaceStore } from "./workspace-store.js";
import { getConvexClient, resolveInstanceId, resolveOwnerId } from "./client.js";

import { api } from "../../../convex/_generated/api.js";
import type {
	AuthStore,
	BlobStore,
	BrigadeStore,
	ChannelStore,
	ConfigStore,
	CronStore,
	ExecApprovalStore,
	ExtensionStore,
	InstanceStore,
	LogStore,
	MemoryStore,
	MessageStore,
	OrgStore,
	SessionStore,
	SkillStore,
	SubagentStore,
	WorkspaceStore,
} from "../store.js";

export interface ConvexBrigadeStoreOpts {
	url?: string;
	stateDir: string;
}

export class ConvexBrigadeStore implements BrigadeStore {
	readonly mode = "convex" as const;

	readonly config: ConfigStore;
	readonly workspace: WorkspaceStore;
	readonly memory: MemoryStore;
	readonly sessions: SessionStore;
	readonly messages: MessageStore;
	readonly logs: LogStore;
	readonly cron: CronStore;
	readonly channels: ChannelStore;
	readonly auth: AuthStore;
	readonly execApprovals: ExecApprovalStore;
	readonly skills: SkillStore;
	readonly extensions: ExtensionStore;
	readonly org: OrgStore;
	readonly subagents: SubagentStore;
	readonly instance: InstanceStore;
	readonly blobs: BlobStore;

	private readonly client: ReturnType<typeof getConvexClient>;
	private readonly instanceId: string;
	private readonly ownerId: string;

	constructor(opts: ConvexBrigadeStoreOpts) {
		this.client = getConvexClient({ ...(opts.url !== undefined ? { url: opts.url } : {}) });
		this.instanceId = resolveInstanceId(opts.stateDir);
		this.ownerId = resolveOwnerId(opts.stateDir);

		this.config = new ConvexConfigStore({ client: this.client, instanceId: this.instanceId });
		this.auth = new ConvexAuthStore({ client: this.client, ownerId: this.ownerId });
		this.workspace = new ConvexWorkspaceStore({ client: this.client });
		this.memory = new ConvexMemoryStore({ client: this.client, workspaceId: this.ownerId });
		this.sessions = new ConvexSessionStore({ client: this.client });
		this.messages = new ConvexMessageStore({ client: this.client });
		this.logs = new ConvexLogStore({
			client: this.client,
			ownerId: this.ownerId,
			instanceId: this.instanceId,
		});
		this.cron = new ConvexCronStore({ client: this.client, ownerId: this.ownerId });
		this.channels = new ConvexChannelStore({
			client: this.client,
			ownerId: this.ownerId,
			stateDir: opts.stateDir,
		});
		this.execApprovals = new ConvexExecApprovalStore({ client: this.client, ownerId: this.ownerId });
		this.skills = new ConvexSkillStore({ client: this.client, ownerId: this.ownerId });
		this.extensions = new ConvexExtensionStore({ client: this.client });
		this.org = new ConvexOrgStore({ client: this.client, ownerId: this.ownerId });
		this.subagents = new ConvexSubagentStore({ client: this.client, ownerId: this.ownerId });
		this.instance = new ConvexInstanceStore({
			client: this.client,
			instanceId: this.instanceId,
			stateDir: opts.stateDir,
		});
		this.blobs = new ConvexBlobStore({ client: this.client, ownerId: this.ownerId });
	}

	async init(): Promise<void> {
		// Fail AT BOOT when the backend is unreachable — before the gateway
		// lock or port are touched, with an actionable message. Without this
		// check a dead deployment "boots" fine and every store call then
		// fails cryptically mid-turn.
		const health = await this.healthcheck();
		if (!health.ok) {
			throw new Error(
				`convex backend unreachable — ${String(health.details.error ?? "no response")}. ` +
					`Start your deployment (npm run convex:dev for self-hosted) or check ` +
					`BRIGADE_CONVEX_URL / ~/.brigade/mode.sentinel. To work without it, switch ` +
					`back with: brigade store mode set filesystem`,
			);
		}
	}

	async close(): Promise<void> {
		// The reactive WebSocket client (when one was opened by a subscribe
		// path) holds the event loop open. Dispose it here so the gateway
		// can exit cleanly on shutdown.
		try {
			const { getReactiveConvexClient } = await import("./client.js");
			// Only close if it was actually instantiated — calling close on
			// an uninitialised client is fine but creates one we don't need.
			const reactive = (
				globalThis as unknown as { __brigadeConvexReactiveProbe?: unknown }
			).__brigadeConvexReactiveProbe;
			if (reactive !== undefined) {
				getReactiveConvexClient().close();
			}
		} catch {
			// Best-effort.
		}
	}

	async healthcheck(): Promise<{ ok: boolean; details: Record<string, unknown> }> {
		try {
			const result = (await this.client.query(api.health.ping, {})) as {
				ok: boolean;
				schemaVersion: number;
				hasConfig: boolean;
				now: number;
			};
			return {
				ok: true,
				details: {
					mode: "convex",
					instanceId: this.instanceId,
					ownerId: this.ownerId,
					schemaVersion: result.schemaVersion,
					hasConfig: result.hasConfig,
					backendNowMs: result.now,
				},
			};
		} catch (err) {
			return {
				ok: false,
				details: {
					mode: "convex",
					error: err instanceof Error ? err.message : String(err),
				},
			};
		}
	}
}
