// src/storage/local/index.ts
//
// LocalBrigadeStore — adapter that targets the on-disk `~/.brigade/` layout.
//
// PR1 status: this is a STUB. Every sub-store throws `NotImplementedYet` until
// its dedicated PR lands and wires it to the existing file code. The interface
// shape is settled, so subsystems written against `ctx.store.X.Y(...)` can
// already compile against `LocalBrigadeStore`; they just can't be CALLED yet
// outside their wrapped subsystem's PR.
//
// Each later PR (one per domain) replaces one `throwingProxy<TStore>(...)`
// below with a concrete `LocalXStore` class that calls the existing function
// exports byte-for-byte. The on-disk semantics never change in filesystem
// mode — all 2,154 existing tests must keep passing.

import { NotImplementedYet } from "../store.js";
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
import { LocalAuthStore } from "./auth-store.js";
import { LocalBlobStore } from "./blob-store.js";
import { LocalChannelStore } from "./channel-store.js";
import { LocalConfigStore } from "./config-store.js";
import { LocalCronStore } from "./cron-store.js";
import { LocalExecApprovalStore } from "./exec-approval-store.js";
import { LocalExtensionStore } from "./extension-store.js";
import { LocalInstanceStore } from "./instance-store.js";
import { LocalLogStore } from "./log-store.js";
import { LocalMemoryStore } from "./memory-store.js";
import { LocalMessageStore } from "./message-store.js";
import { LocalOrgStore } from "./org-store.js";
import { LocalSessionStore } from "./session-store.js";
import { LocalSkillStore } from "./skill-store.js";
import { LocalSubagentStore } from "./subagent-store.js";
import { LocalWorkspaceStore } from "./workspace-store.js";

// =============================================================================
// Stub proxy — every method on this proxy throws `NotImplementedYet(name.method)`.
// Replaced per-domain as each PR lands.
// =============================================================================

function throwingProxy<T extends object>(domain: string): T {
	return new Proxy({} as T, {
		get(_target, prop) {
			const method = String(prop);
			// Allow the JS runtime's interrogation properties to return undefined
			// quietly (then, Symbol.toPrimitive, util.inspect, etc.) so that
			// debuggers, await chains, and console.log don't blow up.
			if (typeof prop === "symbol") return undefined;
			if (method === "then" || method === "constructor") return undefined;
			return () => {
				throw new NotImplementedYet(`${domain}.${method}`);
			};
		},
	});
}

// =============================================================================
// LocalBrigadeStore
// =============================================================================

export interface LocalBrigadeStoreOpts {
	stateDir: string;
}

export class LocalBrigadeStore implements BrigadeStore {
	readonly mode = "filesystem" as const;

	readonly config: ConfigStore;
	readonly auth: AuthStore;
	readonly execApprovals: ExecApprovalStore;
	readonly workspace: WorkspaceStore;
	readonly org: OrgStore;
	readonly subagents: SubagentStore;
	readonly memory: MemoryStore;
	readonly skills: SkillStore;
	readonly instance: InstanceStore;
	readonly logs: LogStore;
	readonly cron: CronStore;
	readonly channels: ChannelStore;
	readonly extensions: ExtensionStore;
	readonly blobs: BlobStore;
	readonly sessions: SessionStore;
	readonly messages: MessageStore;
	// (workspace is initialised in the constructor — see below)
	// (memory is initialised in the constructor — see below)
	// (sessions is initialised in the constructor — see below)
	// (messages is initialised in the constructor — see below)
	// (logs is initialised in the constructor — see below)
	// (cron is initialised in the constructor — see below)
	// (channels is initialised in the constructor — see below)
	// (auth is initialised in the constructor — see below)
	// (execApprovals is initialised in the constructor — see below)
	// (skills is initialised in the constructor — see below)
	// (extensions is initialised in the constructor — see below)
	// (org is initialised in the constructor — see below)
	// (subagents is initialised in the constructor — see below)
	// (instance is initialised in the constructor — see below)
	// (blobs is initialised in the constructor — see below)

	constructor(private readonly opts: LocalBrigadeStoreOpts) {
		// Real adapters — each wraps existing on-disk code byte-for-byte
		// (filesystem mode behaviour unchanged; all 2,154 tests pass).
		//   PR2  — config
		//   PR3  — auth
		//   PR5  — execApprovals
		//   PR6  — workspace
		//   PR8  — org (partial — chart cache + audit log)
		//   PR10 — subagents (in-memory)
		this.config = new LocalConfigStore(opts.stateDir);
		this.auth = new LocalAuthStore(opts.stateDir);
		this.execApprovals = new LocalExecApprovalStore(opts.stateDir);
		this.workspace = new LocalWorkspaceStore(opts.stateDir);
		this.org = new LocalOrgStore(opts.stateDir);
		this.subagents = new LocalSubagentStore();
		// PR7 — skills (6-source discovery + managed/workspace CRUD)
		this.skills = new LocalSkillStore(opts.stateDir);
		// PR11 — memory facts + notes + cursors + consolidate state
		this.memory = new LocalMemoryStore(opts.stateDir);
		// PR15 — gateway pid/heartbeat/lock + supervisor health
		this.instance = new LocalInstanceStore(opts.stateDir);
		// PR4 — event log + subsystem log + config-audit chain + config-health
		this.logs = new LocalLogStore(opts.stateDir);
		// PR9 — extensions discovery (read-only in filesystem mode)
		this.extensions = new LocalExtensionStore(opts.stateDir);
		// PR12 — cron jobs + per-job run-log (atomicity via withCronStoreLock)
		this.cron = new LocalCronStore(opts.stateDir);
		// PR13 — channels: allow-from + pairing + WhatsApp auth dir + media
		this.channels = new LocalChannelStore(opts.stateDir);
		// Cross-cut — content-addressed byte store under <stateDir>/blobs/
		this.blobs = new LocalBlobStore(opts.stateDir);
		// PR14 — sessions index + per-session transcript JSONL + inbox
		this.sessions = new LocalSessionStore(opts.stateDir);
		this.messages = new LocalMessageStore(opts.stateDir);
	}

	get stateDir(): string {
		return this.opts.stateDir;
	}

	async init(): Promise<void> {
		// Per-sub-store `init` is called as each PR wires it; nothing to do yet.
	}

	async close(): Promise<void> {
		// Same as above.
	}

	async healthcheck(): Promise<{ ok: boolean; details: Record<string, unknown> }> {
		return {
			ok: true,
			details: {
				mode: this.mode,
				stateDir: this.stateDir,
				note: "LocalBrigadeStore PR1 stub — sub-stores throw NotImplementedYet until their PR lands.",
			},
		};
	}
}
