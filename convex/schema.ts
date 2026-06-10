// convex/schema.ts
//
// Brigade Phase 2 — single-operator Convex schema.
//
// Every Brigade subsystem gets its proper-shape table (nodebase + Convex
// agent-component pattern: one row per record), NOT a `files` table holding
// JSONL blobs. Indexes + search + vector per domain. Encrypted-payload
// columns use v.bytes() at the schema layer; libsodium seal/open happens at
// the BrigadeStore adapter boundary so primitive code never sees ciphertext.
//
// Source-of-truth design doc:
//   C:\Users\SmartSystems\.brigade-design-docs\toggle-migration-plan.md
//   (Part B — 24 tables, locked 2026-06-09 after 18-agent audit)
//
// ownerId is present on every per-operator row. In Phase 2 (single operator)
// it's always the same value; Phase 3 multi-tenant turns it into the RLS key.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const Enc = v.bytes;

export default defineSchema({
  // ===========================================================================
  // 1. CONFIG  (REPORT 9)
  // ===========================================================================
  brigadeConfig: defineTable({
    instanceId: v.string(),
    schemaVersion: v.literal(2),
    agents:   v.optional(v.any()),
    gateway:  v.optional(v.any()),
    session:  v.optional(v.any()),
    tools:    v.optional(v.any()),
    auth:     v.optional(v.any()),
    plugins:  v.optional(v.any()),
    skills:   v.optional(v.any()),
    channels: v.optional(v.any()),
    bindings: v.optional(v.any()),
    org:      v.optional(v.any()),
    wizard:   v.optional(v.any()),
    meta:     v.optional(v.any()),
    defaults: v.optional(v.any()),
    // Catch-all for any top-level key not named above — preserves the disk
    // path's unknown-key round-trip guarantee (io.ts orderTopLevelKeys).
    extra:    v.optional(v.any()),
    encryptedGatewayAuthToken:    v.optional(Enc()),
    encryptedGatewayAuthPassword: v.optional(Enc()),
    contentSha256: v.string(),
    bytes: v.number(),
    updatedAtMs: v.number(),
    updatedByPid: v.optional(v.number()),
  }).index("by_instance", ["instanceId"]),

  brigadeConfigAudit: defineTable({
    instanceId: v.string(),
    ts: v.string(),
    sha256: v.string(),
    prevHash: v.optional(v.string()),
    lineHash: v.string(),
    seq: v.number(),
    bytes: v.number(),
    pid: v.optional(v.number()),
  }).index("by_instance_seq", ["instanceId", "seq"]),

  brigadeConfigBackups: defineTable({
    instanceId: v.string(),
    slot: v.number(),
    contentSha256: v.string(),
    payload: v.string(),
    bytes: v.number(),
    capturedAtMs: v.number(),
  }).index("by_instance_slot", ["instanceId", "slot"]),

  configHealth: defineTable({
    ownerId: v.string(),
    ts: v.string(),
    configPath: v.string(),
    bytes: v.number(),
    sha256: v.string(),
    mtimeMs: v.number(),
    pid: v.number(),
  }).index("by_owner", ["ownerId"]),

  // ===========================================================================
  // 2. WORKSPACE  (REPORT 7)
  // ===========================================================================
  personaFiles: defineTable({
    agentId: v.string(),
    name: v.union(
      v.literal("AGENTS.md"),
      v.literal("SOUL.md"),
      v.literal("IDENTITY.md"),
      v.literal("USER.md"),
      v.literal("TOOLS.md"),
      v.literal("BOOTSTRAP.md"),
      v.literal("MEMORY.md"),
      v.literal("HEARTBEAT.md"),
    ),
    content: Enc(),
    updatedAt: v.number(),
  })
    .index("by_agent_name", ["agentId", "name"])
    .index("by_agent", ["agentId"]),

  workspaceState: defineTable({
    agentId: v.string(),
    version: v.number(),
    bootstrapSeededAt: v.optional(v.string()),
    setupCompletedAt: v.optional(v.string()),
  }).index("by_agent", ["agentId"]),

  // ===========================================================================
  // 3. MEMORY  (REPORT 1)
  // ===========================================================================
  memoryFacts: defineTable({
    workspaceId: v.string(),
    memoryId: v.string(),
    content: Enc(),
    segment: v.union(
      v.literal("identity"),
      v.literal("preference"),
      v.literal("correction"),
      v.literal("relationship"),
      v.literal("project"),
      v.literal("knowledge"),
      v.literal("context"),
    ),
    tier: v.union(v.literal("short"), v.literal("long"), v.literal("permanent")),
    importance: v.number(),
    decayRate: v.number(),
    accessCount: v.number(),
    lastAccessedAt: v.number(),
    createdAt: v.number(),
    sourceTurn: v.optional(v.string()),
    supersedes: v.optional(v.array(v.string())),
    lifecycle: v.union(v.literal("active"), v.literal("archived"), v.literal("pruned")),
    createdByKind: v.optional(v.union(v.literal("owner"), v.literal("channel"))),
    createdByChannelId: v.optional(v.string()),
    createdByConversationId: v.optional(v.string()),
    createdBySessionKey: v.optional(v.string()),
    createdByAccountId: v.optional(v.string()),
    metadata: v.optional(v.any()),
    embedding: v.optional(v.array(v.number())),
  })
    .index("by_workspace_lifecycle_createdAt", ["workspaceId", "lifecycle", "createdAt"])
    .index("by_workspace_memoryId", ["workspaceId", "memoryId"])
    .index("by_workspace_segment_lifecycle", ["workspaceId", "segment", "lifecycle"])
    .index("by_workspace_origin", [
      "workspaceId",
      "createdByKind",
      "createdByChannelId",
      "createdByConversationId",
      "createdBySessionKey",
    ])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: [
        "workspaceId",
        "lifecycle",
        "createdByKind",
        "createdByChannelId",
        "createdByConversationId",
        "createdBySessionKey",
      ],
    })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["workspaceId", "lifecycle"],
    }),

  memoryExtractCursors: defineTable({
    workspaceId: v.string(),
    sessionId: v.string(),
    processedCount: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_session", ["workspaceId", "sessionId"]),

  memoryConsolidateState: defineTable({
    workspaceId: v.string(),
    lastRunAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  // ===========================================================================
  // 4 & 5. SESSIONS + MESSAGES  (REPORT 2)
  // ===========================================================================
  sessions: defineTable({
    agentId: v.string(),
    sessionKey: v.string(),
    sessionId: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.number(),
    provider: v.optional(v.string()),
    modelId: v.optional(v.string()),
    authProfile: v.optional(v.string()),
    thinkingLevel: v.optional(v.string()),
    subagent: v.optional(
      v.object({
        spawnDepth: v.number(),
        spawnedBy: v.string(),
        parentRunId: v.optional(v.string()),
        label: v.optional(v.string()),
        cleanup: v.optional(v.union(v.literal("delete"), v.literal("keep"))),
        spawnedAt: v.string(),
        spawnedWorkspaceDir: v.optional(v.string()),
      }),
    ),
    extra: v.optional(Enc()),
  })
    .index("by_agent_key", ["agentId", "sessionKey"])
    .index("by_agent_sessionId", ["agentId", "sessionId"])
    .index("by_agent_lastUsed", ["agentId", "lastUsedAt"])
    .index("by_spawnedBy", ["subagent.spawnedBy"]),

  sessionTranscriptRecords: defineTable({
    agentId: v.string(),
    sessionId: v.string(),
    seq: v.number(),
    type: v.string(),
    customType: v.optional(v.string()),
    payload: Enc(),
    createdAt: v.number(),
  })
    .index("by_session_seq", ["agentId", "sessionId", "seq"])
    .index("by_session_type", ["agentId", "sessionId", "type"]),

  sessionInboxEvents: defineTable({
    sessionKey: v.string(),
    seq: v.number(),
    text: Enc(),
    ts: v.number(),
    contextKey: v.optional(v.string()),
    deliveryContext: v.optional(v.any()),
    trusted: v.boolean(),
  })
    .index("by_session_seq", ["sessionKey", "seq"])
    .index("by_session_ts", ["sessionKey", "ts"]),

  // ===========================================================================
  // 6. LOGS  (REPORT 10)
  // ===========================================================================
  sessionEvents: defineTable({
    ts: v.string(),
    day: v.string(),
    ownerId: v.string(),
    agentId: v.string(),
    sessionKey: v.string(),
    type: v.string(),
    inner: v.optional(v.string()),
    delta: v.optional(v.string()),
    toolCallId: v.optional(v.string()),
    toolName: v.optional(v.string()),
    args: v.optional(Enc()),
    result: v.optional(Enc()),
    isError: v.optional(v.boolean()),
    role: v.optional(v.string()),
    content: v.optional(Enc()),
    stopReason: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    attempt: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
    delayMs: v.optional(v.number()),
    aborted: v.optional(v.boolean()),
    willRetry: v.optional(v.boolean()),
    messageCount: v.optional(v.number()),
    // auto_retry_end carries these — kept so a failed-then-recovered turn is
    // fully reconstructable from the convex log (disk parity).
    success: v.optional(v.boolean()),
    finalError: v.optional(v.string()),
  })
    .index("by_owner_day", ["ownerId", "day"])
    .index("by_owner_session", ["ownerId", "sessionKey", "ts"])
    .index("by_owner_error", ["ownerId", "isError", "ts"]),

  subsystemLog: defineTable({
    time: v.string(),
    day: v.string(),
    ownerId: v.string(),
    level: v.string(),
    subsystem: v.string(),
    message: v.string(),
    fields: v.optional(v.any()),
  })
    .index("by_owner_day", ["ownerId", "day"])
    .index("by_owner_subsystem_time", ["ownerId", "subsystem", "time"])
    .index("by_owner_level_time", ["ownerId", "level", "time"]),

  // ===========================================================================
  // 7. CRON  (REPORT 3)
  // ===========================================================================
  cronJobs: defineTable({
    jobId: v.string(),
    ownerUserId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    enabled: v.boolean(),
    agentId: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    scheduleKind: v.union(v.literal("cron"), v.literal("every"), v.literal("at")),
    scheduleExpr: v.optional(v.string()),
    scheduleTz: v.optional(v.string()),
    scheduleStaggerMs: v.optional(v.number()),
    scheduleEveryMs: v.optional(v.number()),
    scheduleAnchorMs: v.optional(v.number()),
    scheduleAt: v.optional(v.number()),
    sessionTarget: v.string(),
    wakeMode: v.optional(v.string()),
    payload: Enc(),
    delivery: v.optional(Enc()),
    failureAlert: v.optional(v.any()),
    deleteAfterRun: v.optional(v.boolean()),
    createdByKind: v.union(v.literal("owner"), v.literal("channel"), v.literal("legacy")),
    createdByChannelId: v.optional(v.string()),
    createdByConversationId: v.optional(v.string()),
    createdByAccountId: v.optional(v.string()),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
    stateNextRunAtMs: v.optional(v.number()),
    stateLastRunAtMs: v.optional(v.number()),
    stateRunningAtMs: v.optional(v.number()),
    stateLastStatus: v.optional(v.string()),
    stateLastError: v.optional(v.string()),
    stateScheduleErrorCount: v.optional(v.number()),
    stateConsecutiveErrorCount: v.optional(v.number()),
    stateLastFailureAlertAtMs: v.optional(v.number()),
    stateLastDelivered: v.optional(v.boolean()),
    stateLastDeliveryStatus: v.optional(v.string()),
    stateLastDeliveryError: v.optional(v.string()),
  })
    .index("by_owner_enabled_next", ["ownerUserId", "enabled", "stateNextRunAtMs"])
    .index("by_owner_job", ["ownerUserId", "jobId"])
    .index("by_owner_channel_conv", ["ownerUserId", "createdByChannelId", "createdByConversationId"])
    .searchIndex("search_name_desc", {
      searchField: "name",
      filterFields: ["ownerUserId"],
    }),

  cronRuns: defineTable({
    ownerUserId: v.string(),
    jobId: v.string(),
    ts: v.number(),
    status: v.union(v.literal("ok"), v.literal("error"), v.literal("skipped")),
    error: v.optional(v.string()),
    summary: v.optional(Enc()),
    delivered: v.optional(v.boolean()),
    deliveryStatus: v.optional(v.string()),
    deliveryError: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    runAtMs: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    nextRunAtMs: v.optional(v.number()),
    model: v.optional(v.string()),
    provider: v.optional(v.string()),
    usageInput: v.optional(v.number()),
    usageOutput: v.optional(v.number()),
    usageCacheRead: v.optional(v.number()),
    usageCacheWrite: v.optional(v.number()),
    usageTotalTokens: v.optional(v.number()),
    usageCostUsd: v.optional(v.number()),
  })
    .index("by_owner_job_ts", ["ownerUserId", "jobId", "ts"])
    .index("by_owner_job_status_ts", ["ownerUserId", "jobId", "status", "ts"]),

  cronServiceState: defineTable({
    ownerUserId: v.string(),
    lastReapAtMs: v.optional(v.number()),
    lastTickArmedAt: v.optional(v.number()),
    lastTickExpectedDelayMs: v.optional(v.number()),
  }).index("by_owner", ["ownerUserId"]),

  // ===========================================================================
  // 8. CHANNELS  (REPORT 4)
  // ===========================================================================
  channelAccess: defineTable({
    ownerId: v.string(),
    channelId: v.string(),
    accountId: v.string(),
    kind: v.union(
      v.literal("allow-from"),
      v.literal("group-allow-from"),
      v.literal("pairing"),
    ),
    senderId: Enc(),
    senderName: v.optional(v.string()),
    code: v.optional(Enc()),
    createdAt: v.optional(v.number()),
    lastSeenAt: v.optional(v.number()),
  })
    .index("by_owner_channel_account_kind", ["ownerId", "channelId", "accountId", "kind"])
    .index("by_pairing_code", ["ownerId", "channelId", "accountId", "code"]),

  whatsappAuthFile: defineTable({
    ownerId: v.string(),
    accountId: v.string(),
    fileKey: v.string(),
    contentB64: Enc(),
    contentVersion: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_account_file", ["ownerId", "accountId", "fileKey"])
    .index("by_owner_account", ["ownerId", "accountId"]),

  channelMediaBlob: defineTable({
    ownerId: v.string(),
    channelId: v.string(),
    accountId: v.string(),
    messageId: v.string(),
    index: v.number(),
    mimeType: v.string(),
    fileName: v.optional(v.string()),
    storageId: v.id("_storage"),
    bytes: v.number(),
    createdAt: v.number(),
  }).index("by_owner_channel_account_msg", ["ownerId", "channelId", "accountId", "messageId"]),

  // ===========================================================================
  // 9. AUTH  (REPORT 8)
  // ===========================================================================
  authProfiles: defineTable({
    ownerId: v.string(),
    agentId: v.string(),
    profileId: v.string(),
    provider: v.string(),
    alias: v.optional(v.string()),
    type: v.union(
      v.literal("api_key"),
      v.literal("oauth"),
      v.literal("token"),
    ),
    keyEnc: v.optional(Enc()),
    keyRef: v.optional(
      v.object({ source: v.string(), provider: v.string(), id: v.string() }),
    ),
    tokenEnc: v.optional(Enc()),
    tokenRef: v.optional(
      v.object({ source: v.string(), provider: v.string(), id: v.string() }),
    ),
    accessEnc: v.optional(Enc()),
    refreshEnc: v.optional(Enc()),
    expires: v.optional(v.number()),
    metadata: v.optional(v.any()),
    updatedAt: v.number(),
  })
    .index("by_owner_agent", ["ownerId", "agentId"])
    .index("by_owner_agent_provider", ["ownerId", "agentId", "provider"])
    .index("by_owner_agent_profileId", ["ownerId", "agentId", "profileId"]),

  profileState: defineTable({
    ownerId: v.string(),
    agentId: v.string(),
    profileId: v.string(),
    provider: v.string(),
    lastUsed: v.optional(v.number()),
    cooldownUntil: v.optional(v.number()),
    cooldownReason: v.optional(v.string()),
    cooldownModel: v.optional(v.string()),
    disabledUntil: v.optional(v.number()),
    disabledReason: v.optional(v.string()),
    errorCount: v.optional(v.number()),
    failureCounts: v.optional(v.any()),
    lastFailureAt: v.optional(v.number()),
    isLastGood: v.boolean(),
    explicitOrder: v.optional(v.number()),
  })
    .index("by_owner_agent_provider", ["ownerId", "agentId", "provider"])
    .index("by_owner_agent_profileId", ["ownerId", "agentId", "profileId"])
    .index("by_cooldown_until", ["ownerId", "agentId", "cooldownUntil"]),

  // Whole-file auth state blobs — auth-state.json / profile-state.json
  // round-trip VERBATIM as sealed payloads. Blob-per-file (not per-row
  // flattening) is deliberate: the failover `order` field is a per-provider
  // ARRAY (`{provider: [profileId…]}`) that a per-row `explicitOrder` rank
  // cannot represent without semantic drift, and `lastGood` reconstruction
  // from per-row flags proved fragile (two winners on a race). The
  // per-row `profileState` table above stays for queryable cooldown views;
  // the blob is the source of truth the runtime round-trips.
  authFiles: defineTable({
    ownerId: v.string(),
    agentId: v.string(),
    // "models" is the per-USER models.json (custom provider catalog —
    // Ollama etc.); stored under agentId "main" since the file is global.
    kind: v.union(
      v.literal("auth-state"),
      v.literal("profile-state"),
      v.literal("models"),
    ),
    payload: v.bytes(),
    updatedAt: v.number(),
  }).index("by_owner_agent_kind", ["ownerId", "agentId", "kind"]),

  // WhatsApp Baileys auth — replaces the ~900-file multi-file auth dir in
  // convex mode. creds.json rides as ONE sealed BufferJSON blob (small,
  // atomic updates); every signal key (pre-key / session / sender-key /
  // app-state-sync-key / …) is a row keyed (keyType, keyId). Oversized
  // values (LTHashState app-state-sync-version grows with contacts and can
  // exceed the mutation arg cap) spill to Convex File Storage via
  // `storageId`. keyType is a plain string — Baileys adds types across
  // versions and a locked union would reject them.
  // Small system-level key/value facts (encryption-key fingerprint, schema
  // markers). Generic so future singletons don't need their own tables.
  systemMeta: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  whatsappAuthCreds: defineTable({
    ownerId: v.string(),
    accountId: v.string(),
    payload: v.bytes(),
    updatedAt: v.number(),
  }).index("by_owner_account", ["ownerId", "accountId"]),

  whatsappAuthKeys: defineTable({
    ownerId: v.string(),
    accountId: v.string(),
    keyType: v.string(),
    keyId: v.string(),
    payload: v.optional(v.bytes()),
    storageId: v.optional(v.id("_storage")),
    updatedAt: v.number(),
  })
    .index("by_owner_account_type_id", ["ownerId", "accountId", "keyType", "keyId"])
    .index("by_owner_account", ["ownerId", "accountId"]),

  // ===========================================================================
  // 10. EXEC APPROVALS  (REPORT 8)
  // ===========================================================================
  execApprovals: defineTable({
    ownerId: v.string(),
    agentId: v.string(),
    kind: v.union(v.literal("exact"), v.literal("pattern")),
    value: v.string(),
    valueNormalised: v.string(),
    createdAt: v.number(),
  })
    .index("by_owner_agent_kind", ["ownerId", "agentId", "kind"])
    .index("by_owner_agent_value", ["ownerId", "agentId", "valueNormalised"]),

  // ===========================================================================
  // 11. SKILLS  (REPORT 6)
  // ===========================================================================
  skills: defineTable({
    ownerId: v.string(),
    source: v.union(
      v.literal("bundled"),
      v.literal("config"),
      v.literal("managed"),
      v.literal("personal"),
      v.literal("project"),
      v.literal("workspace"),
    ),
    agentId: v.union(v.string(), v.null()),
    name: v.string(),
    description: v.string(),
    frontmatter: v.string(),
    body: v.string(),
    eligibility: v.object({
      os: v.array(v.string()),
      requiresBins: v.array(v.string()),
      requiresAnyBins: v.array(v.string()),
      requiresEnv: v.array(v.string()),
      requiresConfig: v.array(v.string()),
    }),
    disableModelInvocation: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_name", ["ownerId", "name"])
    .index("by_owner_scope_name", ["ownerId", "source", "agentId", "name"])
    .index("by_owner_source", ["ownerId", "source"]),

  // ===========================================================================
  // 12. EXTENSIONS  (REPORT 11)
  // ===========================================================================
  extensions: defineTable({
    moduleId: v.string(),
    origin: v.union(v.literal("bundled"), v.literal("user")),
    bundleBytes: v.optional(Enc()),
    sourceLabel: v.string(),
    manifest: v.optional(v.any()),
    enabled: v.boolean(),
    config: v.optional(Enc()),
    bundleSha: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_moduleId", ["moduleId"])
    .index("by_origin_enabled", ["origin", "enabled"]),

  // ===========================================================================
  // 13. ORG  (REPORT 5)
  // ===========================================================================
  orgDeriveAudit: defineTable({
    ts: v.string(),
    topOrder: v.string(),
    mode: v.union(
      v.literal("derived"),
      v.literal("explicit"),
      v.literal("open"),
    ),
    edgeCount: v.number(),
    memberCount: v.number(),
    extraAllowCount: v.number(),
    extraDenyCount: v.number(),
    warnings: v.number(),
    ownerId: v.string(),
  })
    .index("by_owner_ts", ["ownerId", "ts"])
    .index("by_owner_topOrder", ["ownerId", "topOrder"]),

  orgChartCache: defineTable({
    hash: v.string(),
    pngBytes: v.bytes(),
    width: v.number(),
    height: v.number(),
    themeId: v.string(),
    themeName: v.string(),
    mimeType: v.literal("image/png"),
    mtimeMs: v.number(),
    transient: v.boolean(),
    ownerId: v.string(),
  })
    .index("by_owner_hash", ["ownerId", "hash"])
    .index("by_owner_mtime", ["ownerId", "mtimeMs"]),

  // ===========================================================================
  // 14. SUBAGENTS  (REPORT 12)
  // ===========================================================================
  subagentRuns: defineTable({
    runId: v.string(),
    childSessionKey: v.string(),
    requesterSessionKey: v.string(),
    controllerSessionKey: v.optional(v.string()),
    requesterDisplayKey: v.string(),
    requesterOrigin: v.optional(Enc()),
    task: Enc(),
    cleanup: v.union(v.literal("delete"), v.literal("keep")),
    label: v.optional(v.string()),
    model: v.optional(v.string()),
    workspaceDir: v.optional(v.string()),
    runTimeoutSeconds: v.optional(v.number()),
    spawnMode: v.optional(v.union(v.literal("run"), v.literal("session"))),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    sessionStartedAt: v.optional(v.number()),
    accumulatedRuntimeMs: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    outcome: v.optional(
      v.object({
        status: v.union(
          v.literal("ok"),
          v.literal("error"),
          v.literal("timeout"),
          v.literal("abort"),
        ),
        text: v.optional(Enc()),
        error: v.optional(v.string()),
        reason: v.optional(v.string()),
      }),
    ),
    archiveAtMs: v.optional(v.number()),
    cleanupCompletedAt: v.optional(v.number()),
    cleanupHandled: v.optional(v.boolean()),
    suppressAnnounceReason: v.optional(
      v.union(v.literal("steer-restart"), v.literal("killed")),
    ),
    expectsCompletionMessage: v.optional(v.boolean()),
    announceRetryCount: v.optional(v.number()),
    lastAnnounceRetryAt: v.optional(v.number()),
    endedReason: v.optional(v.string()),
    wakeOnDescendantSettle: v.optional(v.boolean()),
    frozenResultText: v.optional(Enc()),
    frozenResultCapturedAt: v.optional(v.number()),
    fallbackFrozenResultText: v.optional(Enc()),
    fallbackFrozenResultCapturedAt: v.optional(v.number()),
    endedHookEmittedAt: v.optional(v.number()),
    completionAnnouncedAt: v.optional(v.number()),
    attachmentsDir: v.optional(v.string()),
    attachmentsRootDir: v.optional(v.string()),
    retainAttachmentsOnKeep: v.optional(v.boolean()),
    ownerId: v.string(),
  })
    .index("by_runId", ["ownerId", "runId"])
    .index("by_childSessionKey_active", ["ownerId", "childSessionKey", "endedAt"])
    .index("by_requester_createdAt", ["ownerId", "requesterSessionKey", "createdAt"])
    .index("by_controller_active", ["ownerId", "controllerSessionKey", "endedAt"])
    .index("by_requester_active", ["ownerId", "requesterSessionKey", "endedAt"]),

  // ===========================================================================
  // 15. INSTANCE / GATEWAY  (REPORT 13)
  // ===========================================================================
  gatewayCoord: defineTable({
    instanceId: v.string(),
    pid: v.optional(v.number()),
    pidAliveAt: v.optional(v.number()),
    heartbeatTs: v.optional(v.number()),
    heartbeatPid: v.optional(v.number()),
    heartbeatUptimeMs: v.optional(v.number()),
    lockPid: v.optional(v.number()),
    lockPort: v.optional(v.number()),
    lockCreatedAt: v.optional(v.string()),
    lockLeaseUntil: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_instance", ["instanceId"]),

  // ===========================================================================
  // 16. BLOBS  (cross-cut — content-addressed bytes via Convex File Storage)
  // ===========================================================================
  brigadeBlobs: defineTable({
    ownerId: v.string(),
    sha256: v.string(),
    storageId: v.id("_storage"),
    mime: v.string(),
    size: v.number(),
    refcount: v.number(),
    lastTouchedAt: v.number(),
  })
    .index("by_sha256", ["sha256"])
    .index("by_owner_storage", ["ownerId", "storageId"]),
});
