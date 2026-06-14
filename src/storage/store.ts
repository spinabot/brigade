// src/storage/store.ts
//
// BrigadeStore — the unified storage interface, frozen at boot.
//
// Brigade Phase 2 introduces a dual-mode storage layer. Today's filesystem
// behaviour is wrapped behind `LocalBrigadeStore`; a future `ConvexBrigadeStore`
// wraps Convex queries + mutations against the schema in `convex/schema.ts`.
// Mode resolution lives in `runtime-context.ts` and freezes once at boot.
//
// PR1 scope (this file): the interface only. All sub-stores are typed
// domain-shaped (never fs-shaped). Concrete payload types are deliberately
// loose (`unknown`) where they would cascade imports across the codebase;
// subsequent PRs (one per domain) tighten each sub-store's payload types
// alongside the LocalXStore that wraps the existing file code.
//
// Source-of-truth design doc:
//   C:\Users\SmartSystems\.brigade-design-docs\toggle-migration-plan.md
//   Part A (locked 2026-06-09 after 18-agent audit).

import type { BrigadeConfig } from "../config/types.js";

// =============================================================================
// Cross-cutting types
// =============================================================================

/** Brand for end-to-end encrypted payloads. The adapter handles encrypt-on-
 *  write / decrypt-on-read transparently; callers see plaintext `T`. */
export type Encrypted<T> = T & { readonly __encrypted: unique symbol };

/** Opaque optimistic-concurrency token. Local = `sha256(mtime+size)`. Convex
 *  = `_version`. Threaded through reads + write opts; mismatch throws
 *  `ConflictError`. */
export type RevToken = string & { readonly __rev: unique symbol };

/** Idempotent unsubscribe handle returned by every `subscribe*()` method. */
export type Unsub = () => void;

/** Result envelope for every mutating method. */
export interface WriteResult {
	rev: RevToken;
	writtenAt: number;
}

/** Origin scope used for subscriptions + dedup / recall partitioning. Mirrors
 *  today's `MemoryRecordOrigin` shape — kind = "owner" | "channel", plus
 *  channel coordinates when channel-scoped. */
export interface Scope {
	ownerId?: string;
	channelId?: string;
	conversationId?: string;
	sessionKey?: string;
	agentId?: string;
}

/** Thrown when `expectedRev` was supplied to a write and did not match
 *  storage at commit time. Adapter-agnostic. */
export class ConflictError extends Error {
	constructor(
		public readonly expected: RevToken,
		public readonly actual: RevToken,
	) {
		super(`rev conflict: expected ${expected}, got ${actual}`);
		this.name = "ConflictError";
	}
}

/** Thrown by PR1 stubs for sub-stores that aren't wired yet. Each later PR
 *  removes one of these by implementing the matching sub-store. Callers MUST
 *  NOT catch this — it's a programming error, not a runtime condition. */
export class NotImplementedYet extends Error {
	constructor(api: string) {
		super(`${api} is not wired yet (BrigadeStore Phase 2 PR pending)`);
		this.name = "NotImplementedYet";
	}
}

// =============================================================================
// The interface — 16 typed sub-APIs, never fs-shaped
// =============================================================================

export interface BrigadeStore {
	readonly mode: "filesystem" | "convex";

	/** 1. `brigade.json` super-config + paths + backup rotation. */
	readonly config: ConfigStore;
	/** 2. Agent workspace personas + MEMORY.md + HEARTBEAT.md. */
	readonly workspace: WorkspaceStore;
	/** 3. Memory facts (vector + lexical) + markdown notes + extract / consolidate cursors. */
	readonly memory: MemoryStore;
	/** 4. `sessions.json` per-agent index. */
	readonly sessions: SessionStore;
	/** 5. Per-session transcript records + bootstrap markers + write-lock + inbox. */
	readonly messages: MessageStore;
	/** 6. Event log + subsystem log + config-audit hash chain. */
	readonly logs: LogStore;
	/** 7. Cron jobs + per-run log + service tick state. */
	readonly cron: CronStore;
	/** 8. Channel access-control + WhatsApp auth dir + inbound media. */
	readonly channels: ChannelStore;
	/** 9. Auth profiles + profile-state cooldown. */
	readonly auth: AuthStore;
	/** 10. `exec-approvals.json` with mtime-cache invariant. */
	readonly execApprovals: ExecApprovalStore;
	/** 11. Skill discovery (6 sources) + manage_skill CRUD. */
	readonly skills: SkillStore;
	/** 12. Extension bundle discovery + manifest registry. */
	readonly extensions: ExtensionStore;
	/** 13. Org-derive audit + chart PNG cache. */
	readonly org: OrgStore;
	/** 14. Sub-agent run records (in-memory in filesystem mode). */
	readonly subagents: SubagentStore;
	/** 15. Gateway pid + heartbeat + lock + daemon installer. */
	readonly instance: InstanceStore;
	/** 16. Content-addressed byte blobs (charts, media, bundles). */
	readonly blobs: BlobStore;

	// Adapter lifecycle ---------------------------------------------------------
	init(): Promise<void>;
	close(): Promise<void>;
	healthcheck(): Promise<{ ok: boolean; details: Record<string, unknown> }>;
}

// =============================================================================
// 1. CONFIG  (REPORT 9)
// =============================================================================
export interface ConfigStore {
	read(): Promise<{ value: BrigadeConfig; rev: RevToken }>;
	write(cfg: BrigadeConfig, opts?: { expectedRev?: RevToken }): Promise<WriteResult>;
	/** Serialized read-modify-write — replaces today's `mutateConfigAtomic`. */
	mutate(fn: (current: BrigadeConfig) => BrigadeConfig | Promise<BrigadeConfig>): Promise<BrigadeConfig>;
	subscribe(cb: (cfg: BrigadeConfig, rev: RevToken) => void): Unsub;
	listBackups(): Promise<Array<{ slot: number; sha256: string; mtimeMs: number; bytes: number }>>;
	restoreBackup(slot: number): Promise<BrigadeConfig>;
}

// =============================================================================
// 2. WORKSPACE  (REPORT 7)
// =============================================================================
export type PersonaName =
	| "AGENTS.md"
	| "SOUL.md"
	| "IDENTITY.md"
	| "USER.md"
	| "TOOLS.md"
	| "BOOTSTRAP.md"
	| "MEMORY.md"
	| "HEARTBEAT.md";

export interface ContextFile {
	name: PersonaName;
	path: string;
	content: string;
	updatedAt: number;
}

export interface WorkspaceState {
	version: number;
	bootstrapSeededAt?: string;
	setupCompletedAt?: string;
}

export interface BootstrapResult {
	created: PersonaName[];
	alreadyPresent: PersonaName[];
}

export interface WorkspaceStore {
	listPersona(agentId: string, opts?: { subagentMode?: boolean }): Promise<ContextFile[]>;
	getHeartbeat(agentId: string): Promise<ContextFile | undefined>;
	writePersona(
		agentId: string,
		name: PersonaName,
		content: string,
		opts?: { createOnly?: boolean },
	): Promise<WriteResult & { created: boolean }>;
	/** Remove a persona row from the mirror. Returns true if a row existed.
	 *  Used to propagate a consumed BOOTSTRAP.md deletion so restore-on-missing
	 *  doesn't resurrect it on the next boot. */
	deletePersona(agentId: string, name: PersonaName): Promise<boolean>;
	readState(agentId: string): Promise<WorkspaceState>;
	markBootstrapSeeded(agentId: string): Promise<void>;
	markSetupCompleted(agentId: string): Promise<void>;
	isBrandNewWorkspace(agentId: string): Promise<boolean>;
	ensureScaffold(agentId: string): Promise<BootstrapResult>;
	subscribePersona(agentId: string, cb: (files: ContextFile[]) => void): Unsub;
}

// =============================================================================
// 3. MEMORY  (REPORT 1)
// =============================================================================
export interface ListFilter {
	lifecycle?: "active" | "archived" | "pruned";
	segment?: string;
	tier?: "short" | "long" | "permanent";
	origin?: RecordOriginFilter;
	limit?: number;
}

export interface RecordOriginFilter {
	kind?: "owner" | "channel";
	channelId?: string;
	conversationId?: string;
	sessionKey?: string;
}

export type MemoryLifecycle = "active" | "archived" | "pruned";

/** Loose payload — typed fully in PR11. */
export type MemoryRecord = Record<string, unknown> & { memoryId: string };

/** Loose payload — typed fully in PR11. */
export type NewFact = Record<string, unknown>;

/** Loose payload — typed fully in PR11. */
export type MemoryDelta = Record<string, unknown>;

export interface MemoryStore {
	listFacts(filter: ListFilter): Promise<MemoryRecord[]>;
	writeFact(fact: NewFact): Promise<MemoryRecord>;
	searchFacts(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter },
	): Promise<Array<MemoryRecord & { score: number }>>;
	markFactsAccessed(memoryIds: string[]): Promise<void>;
	setFactsLifecycle(memoryIds: string[], lifecycle: MemoryLifecycle): Promise<void>;
	countActiveFacts(): Promise<number>;
	/** Vector recall — same surface as searchFacts but via embedding similarity. */
	findSimilar(text: string, scope: Scope, k?: number): Promise<Array<MemoryRecord & { score: number }>>;

	searchNotes(query: string, opts: unknown): Promise<unknown[]>;
	readNote(relPath: string, opts: unknown): Promise<unknown>;
	notesStatus(): Promise<unknown>;

	getExtractCursor(sessionId: string): Promise<number>;
	setExtractCursor(sessionId: string, processedCount: number): Promise<void>;
	getConsolidateLastRunAt(): Promise<number | undefined>;
	markConsolidateRunAt(at: number): Promise<void>;

	decay(now?: number): Promise<{ archived: number; pruned: number }>;
	subscribe(scope: Scope, cb: (delta: MemoryDelta) => void): Unsub;

	/** Raw per-record surface for the FactStore dispatch (whole-file diffs
	 *  realised as authoritative row ops) + boot hydration. `workspaceId`
	 *  is explicit because facts are per-workspace ("main" for the shared
	 *  top-level workspace, agent id for per-agent workspaces). */
	listAllFactRecordsRaw(workspaceId: string): Promise<MemoryRecord[]>;
	upsertFactRecordRaw(workspaceId: string, record: MemoryRecord): Promise<void>;
	deleteFactRecordRaw(workspaceId: string, memoryId: string): Promise<void>;
}

// =============================================================================
// 4. SESSIONS + 5. MESSAGES  (REPORT 2)
// =============================================================================

/** Loose — typed fully in PR14. */
export type SessionEntry = Record<string, unknown> & { sessionId: string };
/** Loose — typed fully in PR14. */
export type ResolvedSession = { entry: SessionEntry; created: boolean };
/** Loose — typed fully in PR14. */
export type SubagentSessionMetadata = Record<string, unknown>;

export interface SessionStore {
	resolveOrCreate(args: {
		agentId: string;
		sessionKey: string;
		overrides?: Partial<SessionEntry>;
		freshnessMs?: number;
	}): Promise<ResolvedSession>;
	getEntry(agentId: string, sessionKey: string): Promise<SessionEntry | undefined>;
	upsertEntry(agentId: string, sessionKey: string, patch: Partial<SessionEntry>): Promise<SessionEntry>;
	updateEntry(agentId: string, sessionKey: string, patch: Partial<SessionEntry>): Promise<SessionEntry | null>;
	deleteEntry(agentId: string, sessionKey: string): Promise<boolean>;
	listEntries(
		agentId: string,
		filter?: { isolatedCronRunOlderThanMs?: number; subagentOnly?: boolean },
	): Promise<Array<{ sessionKey: string; entry: SessionEntry }>>;
	readSubagentMetadata(agentId: string, sessionKey: string): Promise<SubagentSessionMetadata | undefined>;
	listSubagentEntries(
		agentId: string,
	): Promise<Array<{ sessionKey: string; entry: SessionEntry; subagent: SubagentSessionMetadata }>>;
	subscribe(agentId: string, cb: (entries: SessionEntry[]) => void): Unsub;
}

/**
 * One JSONL row in a Pi session transcript. Shape matches Pi SDK's
 * `SessionEntryBase` (no `seq` — that was a phantom field invented at PR1
 * before we'd read the SDK source). Each row is one of: user/assistant
 * message envelope, tool call/result, custom marker (e.g. bootstrap-delivered),
 * or migration/branch metadata.
 *
 * `parentId === null` only on the root entry. `id` is unique within the file
 * — Pi's `SessionManager` mints it via `generateId(this.byId)` so direct
 * appends from outside the SDK must NOT fabricate ids (collisions break
 * `byId` + `parentId` would dangle).
 */
export interface PiTranscriptRecord {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	[field: string]: unknown;
}
/** Loose — typed fully in PR14. */
export type RepairReport = Record<string, unknown>;
/** Loose — typed fully in PR14. */
export type SystemEvent = Record<string, unknown>;

export interface MessageStore {
	appendRecord(agentId: string, sessionId: string, record: PiTranscriptRecord): Promise<void>;
	/** Ordered batch — one transaction, no torn parent-id chains. Powers the
	 *  convex-mode SessionManager write-behind flush. */
	appendRecordsBatch(
		agentId: string,
		sessionId: string,
		records: PiTranscriptRecord[],
	): Promise<void>;
	/** Wholesale replace — realises Pi's `_rewriteFile` (migration, branch
	 *  extraction) transactionally. */
	replaceTranscript(
		agentId: string,
		sessionId: string,
		records: PiTranscriptRecord[],
	): Promise<void>;
	readTranscript(
		agentId: string,
		sessionId: string,
		opts?: { limit?: number; tailBytes?: number },
	): Promise<PiTranscriptRecord[]>;
	hasBootstrapDelivered(agentId: string, sessionId: string): Promise<boolean>;
	markBootstrapDelivered(agentId: string, sessionId: string): Promise<void>;
	deleteTranscript(agentId: string, sessionId: string): Promise<void>;
	repairIfNeeded(agentId: string, sessionId: string): Promise<RepairReport>;
	/** Local: PID-tagged `.lock` sidecar. Convex: no-op (mutations linearise). */
	withWriteLock<T>(
		agentId: string,
		sessionId: string,
		fn: () => Promise<T>,
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<T>;
	subscribe(sessionId: string, cb: (msg: PiTranscriptRecord) => void): Unsub;

	// Inbox (system-events JSONL)
	inboxEnqueue(sessionKey: string, event: SystemEvent): Promise<boolean>;
	inboxDrain(sessionKey: string): Promise<SystemEvent[]>;
	inboxConsumePrefix(sessionKey: string, prefix: readonly SystemEvent[]): Promise<SystemEvent[]>;
	inboxPeek(sessionKey: string): Promise<SystemEvent[]>;
	inboxHasEvents(sessionKey: string): Promise<boolean>;
}

// =============================================================================
// 6. LOGS  (REPORT 10)
// =============================================================================

/** Loose — typed fully in PR4. */
export type SessionEventRecord = Record<string, unknown> & { ts: string; type: string };
export type SubsystemLogRecord = Record<string, unknown> & { time: string; subsystem: string };
export type SubsystemLogFilter = Record<string, unknown>;
export type LogFilter = Record<string, unknown>;
export type LastErrorSnapshot = Record<string, unknown>;
export type ConfigAuditInput = Record<string, unknown>;
export type ConfigAuditRecord = Record<string, unknown> & { lineHash: string; seq: number };
export type ConfigHealthRecord = Record<string, unknown> & { ts: string; sha256: string };

export interface LogStore {
	appendSessionEvent(record: SessionEventRecord): Promise<void>;
	readSessionEventTail(opts: { day?: string; maxBytes?: number }): Promise<SessionEventRecord[]>;
	findLastSessionError(opts?: { lookbackBytes?: number }): Promise<LastErrorSnapshot | undefined>;
	appendSubsystemRecord(record: SubsystemLogRecord): Promise<void>;
	readSubsystemRecords(filter: SubsystemLogFilter): Promise<SubsystemLogRecord[]>;
	pruneSubsystemLogs(olderThanMs: number): Promise<{ removed: number }>;
	appendConfigAudit(entry: ConfigAuditInput): Promise<ConfigAuditRecord>;
	verifyConfigAuditChain(): Promise<{ ok: boolean; brokenAt?: number }>;
	writeConfigHealth(snapshot: ConfigHealthRecord): Promise<void>;
	readConfigHealth(): Promise<ConfigHealthRecord | undefined>;
	subscribe(filter: LogFilter, cb: (e: SubsystemLogRecord) => void): Unsub;
}

// =============================================================================
// 7. CRON  (REPORT 3)
// =============================================================================

export type CronJob = Record<string, unknown> & { jobId: string };
export type CronJobState = Record<string, unknown>;
export type CronRunLogEntry = Record<string, unknown> & { ts: number; status: string };
export type ReadCronRunLogOpts = { limit?: number; sinceTs?: number };

export interface CronStore {
	listJobs(filter?: { enabled?: boolean; query?: string; ownerOnly?: boolean }): Promise<CronJob[]>;
	getJob(jobId: string): Promise<CronJob | null>;
	insertJob(job: CronJob): Promise<void>;
	updateJob(jobId: string, mutate: (job: CronJob) => CronJob): Promise<CronJob>;
	deleteJob(jobId: string): Promise<boolean>;
	/** Reservation atomicity — returns false if already running. */
	markJobRunning(jobId: string, runningAtMs: number): Promise<boolean>;
	recordJobOutcome(
		jobId: string,
		patch: { state: Partial<CronJobState>; deleteAfterApply: boolean },
	): Promise<CronJob | null>;
	appendRunLog(entry: CronRunLogEntry): Promise<void>;
	listRunLog(jobId: string, opts: ReadCronRunLogOpts): Promise<CronRunLogEntry[]>;
	listIsolatedCronSessions(
		agentId: string,
	): Promise<Array<{ sessionKey: string; sessionId: string; lastUsedAt: string }>>;
	deleteIsolatedCronSession(agentId: string, sessionKey: string): Promise<void>;
	withMutation<T>(work: () => Promise<T>): Promise<T>;
	subscribe(cb: (jobs: CronJob[]) => void): Unsub;
}

// =============================================================================
// 8. CHANNELS  (REPORT 4)
// =============================================================================

export type PairingRequest = Record<string, unknown> & { code: string };
export type WhatsAppAuthHandle = Record<string, unknown>;

export interface ChannelStore {
	listAllowedSenders(args: {
		channelId: string;
		accountId?: string | null;
		group?: boolean;
	}): Promise<string[]>;
	addAllowedSender(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		group?: boolean;
	}): Promise<boolean>;
	removeAllowedSender(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		group?: boolean;
	}): Promise<boolean>;
	listPendingPairings(args: { channelId: string; accountId?: string | null }): Promise<PairingRequest[]>;
	upsertPairingRequest(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		senderName?: string;
	}): Promise<{ code: string; isNew: boolean }>;
	approvePairing(args: {
		channelId: string;
		accountId?: string | null;
		code: string;
	}): Promise<PairingRequest | null>;
	revokePairing(args: { channelId: string; accountId?: string | null; code: string }): Promise<boolean>;

	/** Every access row for the owner, decrypted — boot hydration of the
	 *  in-process access cache (one query, no config-shape guessing). */
	listAllAccessRows(): Promise<
		Array<{
			channelId: string;
			accountId: string;
			kind: "allow-from" | "group-allow-from" | "pairing";
			senderId: string;
			senderName?: string;
			code?: string;
			createdAt: string;
			lastSeenAt: string;
		}>
	>;
	/** Replace one (channel, account, kind) row set transactionally — the
	 *  convex realisation of the filesystem's whole-file atomic write.
	 *  Caller-supplied codes/timestamps are authoritative (pairing codes are
	 *  generated by the access-control policy layer, not the store). */
	reconcileAccessRows(args: {
		channelId: string;
		accountId?: string | null;
		kind: "allow-from" | "group-allow-from" | "pairing";
		rows: Array<{
			senderId: string;
			senderName?: string;
			code?: string;
			createdAt: string;
			lastSeenAt: string;
		}>;
	}): Promise<void>;

	openWhatsAppAuthDir(args: { accountId: string }): Promise<WhatsAppAuthHandle>;

	/** Convex-mode Baileys auth surface. Values are BufferJSON strings —
	 *  the adapter seals/opens them; the useConvexAuthState module owns the
	 *  Baileys types. `valueJson: null` deletes the key. Local mode never
	 *  calls these (useMultiFileAuthState owns the dir). */
	loadWhatsAppAuth(accountId: string): Promise<{
		creds: string | null;
		keys: Array<{ keyType: string; keyId: string; valueJson: string }>;
	}>;
	writeWhatsAppCreds(accountId: string, credsJson: string): Promise<void>;
	writeWhatsAppKeys(
		accountId: string,
		entries: Array<{ keyType: string; keyId: string; valueJson: string | null }>,
	): Promise<void>;
	clearWhatsAppAuth(accountId: string): Promise<void>;
	readLidReverseMapping(args: { accountId: string; lidDigits: string }): Promise<string | null>;

	putInboundMedia(args: {
		channelId: string;
		accountId?: string;
		messageId: string;
		index: number;
		mimeType: string;
		bytes: Buffer;
	}): Promise<{ ref: string; size: number }>;
	eraseAccount(channelId: string, accountId: string): Promise<void>;
}

// =============================================================================
// 9. AUTH  (REPORT 8)
// =============================================================================

export type AuthProfile = Record<string, unknown> & { profileId: string };
export type ProfileStateSnapshot = Record<string, unknown>;
export type RetryReason = string;

export interface AuthStore {
	init(agentId: string): Promise<void>;
	listProfiles(agentId: string): Promise<AuthProfile[]>;
	getProfile(agentId: string, profileId: string): Promise<AuthProfile | null>;
	upsertProfile(agentId: string, profile: Encrypted<AuthProfile>): Promise<string>;
	deleteProfile(agentId: string, profileId: string): Promise<void>;
	/** Sync-capable snapshot for Pi `AuthStorage.inMemory` boot path. */
	buildCredentialMap(
		agentId: string,
		opts?: { provider?: string; modelId?: string; cooldownState?: ProfileStateSnapshot },
	): Promise<{
		credentials: Record<string, { type: "api_key"; key: string }>;
		selectedProfileId?: string;
	}>;
	/** Pre-cached snapshot for sync callers (REPORT 8 risk #1). */
	getCachedCredentialSnapshot(
		agentId: string,
	): { credentials: Record<string, { type: "api_key"; key: string }> } | undefined;
	loadProfileState(agentId: string): Promise<ProfileStateSnapshot>;
	recordSuccess(args: { agentId: string; profileId: string; provider: string }): Promise<ProfileStateSnapshot>;
	recordFailure(args: {
		agentId: string;
		profileId: string;
		reason: RetryReason;
		modelId?: string;
	}): Promise<ProfileStateSnapshot>;
	setExplicitOrder(agentId: string, provider: string, order: string[]): Promise<void>;
	withProfileLock<T>(agentId: string, fn: () => Promise<T>): Promise<T>;

	/** Whole-file auth state blobs — auth-state.json / profile-state.json
	 *  round-trip VERBATIM (sealed at rest). Blob-per-file because the
	 *  failover `order` array and `lastGood` map can't be represented by
	 *  per-row flattening without semantic drift. */
	readAuthFileBlob(
		agentId: string,
		kind: "auth-state" | "profile-state" | "models",
	): Promise<Record<string, unknown> | undefined>;
	writeAuthFileBlob(
		agentId: string,
		kind: "auth-state" | "profile-state" | "models",
		payload: Record<string, unknown>,
	): Promise<void>;
}

// =============================================================================
// 10. EXEC APPROVALS  (REPORT 8)
// =============================================================================

export type ApprovalsSnapshot = Record<string, unknown>;

export interface ExecApprovalStore {
	/** Sync — returns from in-memory cache mirrored via `watch()` (REPORT 8 risk #3). */
	decideSync(command: string, agentId: string): "allow" | "deny" | "prompt";
	recordApproval(args: { agentId: string; value: string; kind: "exact" | "pattern" }): Promise<void>;
	removeApproval(
		agentId: string,
		value: string,
	): Promise<{ removedCommands: number; removedPatterns: number }>;
	readSummary(agentId: string): Promise<{ commandCount: number; patternCount: number; error?: string }>;
	/** Full allowlist contents in insertion order — boot hydration + listing
	 *  surfaces. Local: the exec-approvals.json arrays verbatim. Convex: rows
	 *  ordered by createdAt so re-reads are deterministic. */
	list(agentId: string): Promise<{ commands: string[]; patterns: string[] }>;
	/** Local: chokidar mtime watch. Convex: live-query subscription. */
	watch(agentId: string, onChange: (snap: ApprovalsSnapshot) => void): () => void;
}

// =============================================================================
// 11. SKILLS  (REPORT 6)
// =============================================================================

export type SkillRecord = Record<string, unknown> & { name: string };
export type SkillBody = Record<string, unknown> & { body: string };
export type SkillStatusReport = Record<string, unknown>;

export interface SkillStore {
	list(args: {
		workspaceDir: string;
		managedDir?: string;
		bundledDir?: string;
		personalDir?: string;
		projectDir?: string;
		extraPaths?: string[];
		/** Convex-mode scoping: restrict to one agent's skills of one source
		 *  (e.g. the per-agent workspace skills the mirror sync owns). Ignored
		 *  by the filesystem store, which scopes implicitly via `workspaceDir`. */
		agentId?: string;
		source?: "bundled" | "config" | "managed" | "personal" | "project" | "workspace";
	}): Promise<{ records: SkillRecord[]; diagnostics: unknown[] }>;
	read(ref: string): Promise<SkillBody | undefined>;
	write(args: {
		scope: "managed" | "workspace";
		agentId?: string;
		name: string;
		content: string;
	}): Promise<{ ref: string; created: boolean }>;
	remove(args: {
		scope: "managed" | "workspace";
		agentId?: string;
		name: string;
	}): Promise<{ removed: boolean }>;
	status(args: { workspaceDir: string; config: BrigadeConfig; agentId?: string }): Promise<SkillStatusReport>;
}

// =============================================================================
// 12. EXTENSIONS  (REPORT 11)
// =============================================================================

export type BrigadeModuleManifest = Record<string, unknown>;

export interface ExtensionStore {
	listSources(): Promise<
		ReadonlyArray<{ source: string; kind: "file" | "dir-index"; safetyReason: string | null }>
	>;
	rootExists(): Promise<boolean>;
	invalidateDiscoveryCache(): void;
	/** Convex-only — operator uploads a bundle. Local rejects. */
	registerSource?(args: {
		id: string;
		bytes: Uint8Array;
		manifest?: BrigadeModuleManifest;
	}): Promise<{ source: string }>;
	unregisterSource?(args: { id: string }): Promise<void>;
}

// =============================================================================
// 13. ORG  (REPORT 5)
// =============================================================================

export type OrgDeriveAuditEntry = Record<string, unknown> & { ts: string };

export interface OrgStore {
	appendDeriveAudit(entry: OrgDeriveAuditEntry): Promise<void>;
	listDeriveAudit(filter?: { since?: string; limit?: number }): Promise<OrgDeriveAuditEntry[]>;
	getChartImage(hash: string): Promise<
		| {
				bytes: Uint8Array;
				width: number;
				height: number;
				mimeType: "image/png";
				mtimeMs: number;
		  }
		| undefined
	>;
	putChartImage(
		hash: string,
		bytes: Uint8Array,
		meta: { width: number; height: number; themeId: string; themeName: string; mimeType: "image/png" },
	): Promise<{ locator: string }>;
	deleteChartImage(hash: string): Promise<void>;
	listChartImages(): Promise<Array<{ hash: string; mtimeMs: number; bytes: number }>>;
	markChartTransient(locator: string): void;
	consumeChartTransient(locator: string): boolean;
	gcChartImages(opts?: { maxAgeMs?: number; maxFiles?: number }): Promise<void>;
}

// =============================================================================
// 14. SUBAGENTS  (REPORT 12)
// =============================================================================

export type SubagentRunRecord = Record<string, unknown> & { runId: string };
export type SubagentRunOutcome = Record<string, unknown> & { status: string };
export type SubagentLifecycleEndedReason = string;

export interface SubagentStore {
	put(record: SubagentRunRecord): Promise<void>;
	get(runId: string): Promise<SubagentRunRecord | undefined>;
	getByChildSessionKey(childSessionKey: string): Promise<SubagentRunRecord | undefined>;
	listByRequester(requesterSessionKey: string): Promise<SubagentRunRecord[]>;
	listActiveByController(controllerSessionKey: string): Promise<SubagentRunRecord[]>;
	countActiveByRequester(requesterSessionKey: string): Promise<number>;
	spawnedKeysFor(parentSessionKey: string): Promise<Set<string>>;
	markCompleted(args: {
		runId: string;
		outcome: SubagentRunOutcome;
		reason: SubagentLifecycleEndedReason;
		endedAt: number;
		error?: string;
		endedHookEmittedAt?: number;
	}): Promise<SubagentRunRecord | undefined>;
	delete(runId: string): Promise<boolean>;
}

// =============================================================================
// 15. INSTANCE  (REPORT 13)
// =============================================================================

export type GatewayLockHandle = { release(): Promise<void>; port: number };
export type SuperviseDecision = Record<string, unknown> & { ok: boolean };

export interface InstanceStore {
	writePid(pid: number): Promise<void>;
	readPid(): Promise<number | undefined>;
	clearPid(): Promise<void>;
	writeHeartbeat(beat: { ts: number; pid: number; uptimeMs: number }): Promise<void>;
	readHeartbeat(): Promise<{ ts: number; pid: number; uptimeMs: number } | undefined>;
	clearHeartbeat(): Promise<void>;
	acquireLock(args: {
		port: number;
		timeoutMs?: number;
		pollIntervalMs?: number;
		staleMs?: number;
	}): Promise<GatewayLockHandle>;
	checkHealth(opts?: { maxStaleMs?: number; nowMs?: number }): Promise<SuperviseDecision>;
}

// =============================================================================
// 16. BLOBS  (cross-cut; used by ChannelStore for media + OrgStore for charts)
// =============================================================================

export interface BlobStore {
	put(bytes: Uint8Array, opts?: { contentType?: string }): Promise<{ sha256: string; url: string }>;
	get(sha256: string): Promise<Uint8Array | null>;
	delete(sha256: string): Promise<void>;
}
