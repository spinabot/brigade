declare const _default: import("convex/server").SchemaDefinition<{
    brigadeConfig: import("convex/server").TableDefinition<import("convex/values").VObject<{
        auth?: any;
        channels?: any;
        session?: any;
        defaults?: any;
        gateway?: any;
        agents?: any;
        skills?: any;
        org?: any;
        tools?: any;
        plugins?: any;
        bindings?: any;
        wizard?: any;
        meta?: any;
        extra?: any;
        encryptedGatewayAuthToken?: ArrayBuffer | undefined;
        encryptedGatewayAuthPassword?: ArrayBuffer | undefined;
        updatedByPid?: number | undefined;
        updatedAtMs: number;
        bytes: number;
        instanceId: string;
        schemaVersion: 2;
        contentSha256: string;
    }, {
        instanceId: import("convex/values").VString<string, "required">;
        schemaVersion: import("convex/values").VLiteral<2, "required">;
        agents: import("convex/values").VAny<any, "optional", string>;
        gateway: import("convex/values").VAny<any, "optional", string>;
        session: import("convex/values").VAny<any, "optional", string>;
        tools: import("convex/values").VAny<any, "optional", string>;
        auth: import("convex/values").VAny<any, "optional", string>;
        plugins: import("convex/values").VAny<any, "optional", string>;
        skills: import("convex/values").VAny<any, "optional", string>;
        channels: import("convex/values").VAny<any, "optional", string>;
        bindings: import("convex/values").VAny<any, "optional", string>;
        org: import("convex/values").VAny<any, "optional", string>;
        wizard: import("convex/values").VAny<any, "optional", string>;
        meta: import("convex/values").VAny<any, "optional", string>;
        defaults: import("convex/values").VAny<any, "optional", string>;
        extra: import("convex/values").VAny<any, "optional", string>;
        encryptedGatewayAuthToken: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        encryptedGatewayAuthPassword: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        contentSha256: import("convex/values").VString<string, "required">;
        bytes: import("convex/values").VFloat64<number, "required">;
        updatedAtMs: import("convex/values").VFloat64<number, "required">;
        updatedByPid: import("convex/values").VFloat64<number | undefined, "optional">;
    }, "required", "auth" | "channels" | "session" | "defaults" | "updatedAtMs" | "gateway" | "agents" | "bytes" | "skills" | "org" | "instanceId" | "schemaVersion" | "tools" | "plugins" | "bindings" | "wizard" | "meta" | "extra" | "encryptedGatewayAuthToken" | "encryptedGatewayAuthPassword" | "contentSha256" | "updatedByPid" | `auth.${string}` | `channels.${string}` | `session.${string}` | `defaults.${string}` | `gateway.${string}` | `agents.${string}` | `skills.${string}` | `org.${string}` | `tools.${string}` | `plugins.${string}` | `bindings.${string}` | `wizard.${string}` | `meta.${string}` | `extra.${string}`>, {
        by_instance: ["instanceId", "_creationTime"];
    }, {}, {}>;
    brigadeConfigAudit: import("convex/server").TableDefinition<import("convex/values").VObject<{
        pid?: number | undefined;
        prevHash?: string | undefined;
        sha256: string;
        ts: string;
        bytes: number;
        instanceId: string;
        lineHash: string;
        seq: number;
    }, {
        instanceId: import("convex/values").VString<string, "required">;
        ts: import("convex/values").VString<string, "required">;
        sha256: import("convex/values").VString<string, "required">;
        prevHash: import("convex/values").VString<string | undefined, "optional">;
        lineHash: import("convex/values").VString<string, "required">;
        seq: import("convex/values").VFloat64<number, "required">;
        bytes: import("convex/values").VFloat64<number, "required">;
        pid: import("convex/values").VFloat64<number | undefined, "optional">;
    }, "required", "sha256" | "ts" | "pid" | "bytes" | "instanceId" | "prevHash" | "lineHash" | "seq">, {
        by_instance_seq: ["instanceId", "seq", "_creationTime"];
    }, {}, {}>;
    brigadeConfigBackups: import("convex/server").TableDefinition<import("convex/values").VObject<{
        payload: string;
        bytes: number;
        instanceId: string;
        contentSha256: string;
        slot: number;
        capturedAtMs: number;
    }, {
        instanceId: import("convex/values").VString<string, "required">;
        slot: import("convex/values").VFloat64<number, "required">;
        contentSha256: import("convex/values").VString<string, "required">;
        payload: import("convex/values").VString<string, "required">;
        bytes: import("convex/values").VFloat64<number, "required">;
        capturedAtMs: import("convex/values").VFloat64<number, "required">;
    }, "required", "payload" | "bytes" | "instanceId" | "contentSha256" | "slot" | "capturedAtMs">, {
        by_instance_slot: ["instanceId", "slot", "_creationTime"];
    }, {}, {}>;
    configHealth: import("convex/server").TableDefinition<import("convex/values").VObject<{
        sha256: string;
        mtimeMs: number;
        ts: string;
        pid: number;
        bytes: number;
        ownerId: string;
        configPath: string;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        ts: import("convex/values").VString<string, "required">;
        configPath: import("convex/values").VString<string, "required">;
        bytes: import("convex/values").VFloat64<number, "required">;
        sha256: import("convex/values").VString<string, "required">;
        mtimeMs: import("convex/values").VFloat64<number, "required">;
        pid: import("convex/values").VFloat64<number, "required">;
    }, "required", "sha256" | "mtimeMs" | "ts" | "pid" | "bytes" | "ownerId" | "configPath">, {
        by_owner: ["ownerId", "_creationTime"];
    }, {}, {}>;
    personaFiles: import("convex/server").TableDefinition<import("convex/values").VObject<{
        agentId: string;
        name: "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "TOOLS.md" | "BOOTSTRAP.md" | "MEMORY.md" | "HEARTBEAT.md";
        content: ArrayBuffer;
        updatedAt: number;
    }, {
        agentId: import("convex/values").VString<string, "required">;
        name: import("convex/values").VUnion<"AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "TOOLS.md" | "BOOTSTRAP.md" | "MEMORY.md" | "HEARTBEAT.md", [import("convex/values").VLiteral<"AGENTS.md", "required">, import("convex/values").VLiteral<"SOUL.md", "required">, import("convex/values").VLiteral<"IDENTITY.md", "required">, import("convex/values").VLiteral<"USER.md", "required">, import("convex/values").VLiteral<"TOOLS.md", "required">, import("convex/values").VLiteral<"BOOTSTRAP.md", "required">, import("convex/values").VLiteral<"MEMORY.md", "required">, import("convex/values").VLiteral<"HEARTBEAT.md", "required">], "required", never>;
        content: import("convex/values").VBytes<ArrayBuffer, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "agentId" | "name" | "content" | "updatedAt">, {
        by_agent_name: ["agentId", "name", "_creationTime"];
        by_agent: ["agentId", "_creationTime"];
    }, {}, {}>;
    workspaceState: import("convex/server").TableDefinition<import("convex/values").VObject<{
        bootstrapSeededAt?: string | undefined;
        setupCompletedAt?: string | undefined;
        version: number;
        agentId: string;
    }, {
        agentId: import("convex/values").VString<string, "required">;
        version: import("convex/values").VFloat64<number, "required">;
        bootstrapSeededAt: import("convex/values").VString<string | undefined, "optional">;
        setupCompletedAt: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "version" | "agentId" | "bootstrapSeededAt" | "setupCompletedAt">, {
        by_agent: ["agentId", "_creationTime"];
    }, {}, {}>;
    memoryFacts: import("convex/server").TableDefinition<import("convex/values").VObject<{
        metadata?: any;
        sourceTurn?: string | undefined;
        supersedes?: string[] | undefined;
        createdByKind?: "owner" | "channel" | undefined;
        createdByChannelId?: string | undefined;
        createdByConversationId?: string | undefined;
        createdBySessionKey?: string | undefined;
        createdByAccountId?: string | undefined;
        embedding?: number[] | undefined;
        createdAt: number;
        content: ArrayBuffer;
        memoryId: string;
        segment: "project" | "identity" | "preference" | "correction" | "relationship" | "knowledge" | "context";
        tier: "short" | "long" | "permanent";
        importance: number;
        decayRate: number;
        accessCount: number;
        lastAccessedAt: number;
        lifecycle: "active" | "archived" | "pruned";
        workspaceId: string;
    }, {
        workspaceId: import("convex/values").VString<string, "required">;
        memoryId: import("convex/values").VString<string, "required">;
        content: import("convex/values").VBytes<ArrayBuffer, "required">;
        segment: import("convex/values").VUnion<"project" | "identity" | "preference" | "correction" | "relationship" | "knowledge" | "context", [import("convex/values").VLiteral<"identity", "required">, import("convex/values").VLiteral<"preference", "required">, import("convex/values").VLiteral<"correction", "required">, import("convex/values").VLiteral<"relationship", "required">, import("convex/values").VLiteral<"project", "required">, import("convex/values").VLiteral<"knowledge", "required">, import("convex/values").VLiteral<"context", "required">], "required", never>;
        tier: import("convex/values").VUnion<"short" | "long" | "permanent", [import("convex/values").VLiteral<"short", "required">, import("convex/values").VLiteral<"long", "required">, import("convex/values").VLiteral<"permanent", "required">], "required", never>;
        importance: import("convex/values").VFloat64<number, "required">;
        decayRate: import("convex/values").VFloat64<number, "required">;
        accessCount: import("convex/values").VFloat64<number, "required">;
        lastAccessedAt: import("convex/values").VFloat64<number, "required">;
        createdAt: import("convex/values").VFloat64<number, "required">;
        sourceTurn: import("convex/values").VString<string | undefined, "optional">;
        supersedes: import("convex/values").VArray<string[] | undefined, import("convex/values").VString<string, "required">, "optional">;
        lifecycle: import("convex/values").VUnion<"active" | "archived" | "pruned", [import("convex/values").VLiteral<"active", "required">, import("convex/values").VLiteral<"archived", "required">, import("convex/values").VLiteral<"pruned", "required">], "required", never>;
        createdByKind: import("convex/values").VUnion<"owner" | "channel" | undefined, [import("convex/values").VLiteral<"owner", "required">, import("convex/values").VLiteral<"channel", "required">], "optional", never>;
        createdByChannelId: import("convex/values").VString<string | undefined, "optional">;
        createdByConversationId: import("convex/values").VString<string | undefined, "optional">;
        createdBySessionKey: import("convex/values").VString<string | undefined, "optional">;
        createdByAccountId: import("convex/values").VString<string | undefined, "optional">;
        metadata: import("convex/values").VAny<any, "optional", string>;
        embedding: import("convex/values").VArray<number[] | undefined, import("convex/values").VFloat64<number, "required">, "optional">;
    }, "required", "metadata" | "createdAt" | "content" | "memoryId" | "segment" | "tier" | "importance" | "decayRate" | "accessCount" | "lastAccessedAt" | "sourceTurn" | "supersedes" | "lifecycle" | "workspaceId" | "createdByKind" | "createdByChannelId" | "createdByConversationId" | "createdBySessionKey" | "createdByAccountId" | "embedding" | `metadata.${string}`>, {
        by_workspace_lifecycle_createdAt: ["workspaceId", "lifecycle", "createdAt", "_creationTime"];
        by_workspace_memoryId: ["workspaceId", "memoryId", "_creationTime"];
        by_workspace_segment_lifecycle: ["workspaceId", "segment", "lifecycle", "_creationTime"];
        by_workspace_origin: ["workspaceId", "createdByKind", "createdByChannelId", "createdByConversationId", "createdBySessionKey", "_creationTime"];
    }, {
        search_content: {
            searchField: "content";
            filterFields: "lifecycle" | "workspaceId" | "createdByKind" | "createdByChannelId" | "createdByConversationId" | "createdBySessionKey";
        };
    }, {
        by_embedding: {
            vectorField: "embedding";
            dimensions: number;
            filterFields: "lifecycle" | "workspaceId";
        };
    }>;
    memoryExtractCursors: import("convex/server").TableDefinition<import("convex/values").VObject<{
        sessionId: string;
        updatedAt: number;
        workspaceId: string;
        processedCount: number;
    }, {
        workspaceId: import("convex/values").VString<string, "required">;
        sessionId: import("convex/values").VString<string, "required">;
        processedCount: import("convex/values").VFloat64<number, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "sessionId" | "updatedAt" | "workspaceId" | "processedCount">, {
        by_workspace_session: ["workspaceId", "sessionId", "_creationTime"];
    }, {}, {}>;
    memoryConsolidateState: import("convex/server").TableDefinition<import("convex/values").VObject<{
        workspaceId: string;
        lastRunAt: number;
    }, {
        workspaceId: import("convex/values").VString<string, "required">;
        lastRunAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "workspaceId" | "lastRunAt">, {
        by_workspace: ["workspaceId", "_creationTime"];
    }, {}, {}>;
    sessions: import("convex/server").TableDefinition<import("convex/values").VObject<{
        modelId?: string | undefined;
        provider?: string | undefined;
        authProfile?: string | undefined;
        thinkingLevel?: string | undefined;
        subagent?: {
            parentRunId?: string | undefined;
            spawnedWorkspaceDir?: string | undefined;
            label?: string | undefined;
            cleanup?: "delete" | "keep" | undefined;
            spawnDepth: number;
            spawnedBy: string;
            spawnedAt: string;
        } | undefined;
        extra?: ArrayBuffer | undefined;
        agentId: string;
        sessionKey: string;
        sessionId: string;
        createdAt: number;
        lastUsedAt: number;
    }, {
        agentId: import("convex/values").VString<string, "required">;
        sessionKey: import("convex/values").VString<string, "required">;
        sessionId: import("convex/values").VString<string, "required">;
        createdAt: import("convex/values").VFloat64<number, "required">;
        lastUsedAt: import("convex/values").VFloat64<number, "required">;
        provider: import("convex/values").VString<string | undefined, "optional">;
        modelId: import("convex/values").VString<string | undefined, "optional">;
        authProfile: import("convex/values").VString<string | undefined, "optional">;
        thinkingLevel: import("convex/values").VString<string | undefined, "optional">;
        subagent: import("convex/values").VObject<{
            parentRunId?: string | undefined;
            spawnedWorkspaceDir?: string | undefined;
            label?: string | undefined;
            cleanup?: "delete" | "keep" | undefined;
            spawnDepth: number;
            spawnedBy: string;
            spawnedAt: string;
        } | undefined, {
            spawnDepth: import("convex/values").VFloat64<number, "required">;
            spawnedBy: import("convex/values").VString<string, "required">;
            parentRunId: import("convex/values").VString<string | undefined, "optional">;
            label: import("convex/values").VString<string | undefined, "optional">;
            cleanup: import("convex/values").VUnion<"delete" | "keep" | undefined, [import("convex/values").VLiteral<"delete", "required">, import("convex/values").VLiteral<"keep", "required">], "optional", never>;
            spawnedAt: import("convex/values").VString<string, "required">;
            spawnedWorkspaceDir: import("convex/values").VString<string | undefined, "optional">;
        }, "optional", "parentRunId" | "spawnedWorkspaceDir" | "spawnDepth" | "spawnedBy" | "label" | "cleanup" | "spawnedAt">;
        extra: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
    }, "required", "modelId" | "agentId" | "provider" | "sessionKey" | "sessionId" | "createdAt" | "lastUsedAt" | "authProfile" | "thinkingLevel" | "subagent" | "extra" | "subagent.parentRunId" | "subagent.spawnedWorkspaceDir" | "subagent.spawnDepth" | "subagent.spawnedBy" | "subagent.label" | "subagent.cleanup" | "subagent.spawnedAt">, {
        by_agent_key: ["agentId", "sessionKey", "_creationTime"];
        by_agent_sessionId: ["agentId", "sessionId", "_creationTime"];
        by_agent_lastUsed: ["agentId", "lastUsedAt", "_creationTime"];
        by_spawnedBy: ["subagent.spawnedBy", "_creationTime"];
    }, {}, {}>;
    sessionTranscriptRecords: import("convex/server").TableDefinition<import("convex/values").VObject<{
        customType?: string | undefined;
        chunkIndex?: number | undefined;
        chunkCount?: number | undefined;
        type: string;
        agentId: string;
        payload: ArrayBuffer;
        sessionId: string;
        createdAt: number;
        seq: number;
    }, {
        agentId: import("convex/values").VString<string, "required">;
        sessionId: import("convex/values").VString<string, "required">;
        seq: import("convex/values").VFloat64<number, "required">;
        type: import("convex/values").VString<string, "required">;
        customType: import("convex/values").VString<string | undefined, "optional">;
        payload: import("convex/values").VBytes<ArrayBuffer, "required">;
        /** 0-based position of this slice within a chunked record; unset (→ 0)
         *  for a normal single-row record. */
        chunkIndex: import("convex/values").VFloat64<number | undefined, "optional">;
        /** Total slices for a chunked record (>1); unset (→ 1) when not chunked.
         *  All `chunkCount` rows are written in ONE mutation (atomic), so a
         *  group can never be torn across a crash. */
        chunkCount: import("convex/values").VFloat64<number | undefined, "optional">;
        createdAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "type" | "agentId" | "payload" | "sessionId" | "createdAt" | "seq" | "customType" | "chunkIndex" | "chunkCount">, {
        by_session_seq: ["agentId", "sessionId", "seq", "_creationTime"];
        by_session_type: ["agentId", "sessionId", "type", "_creationTime"];
    }, {}, {}>;
    sessionInboxEvents: import("convex/server").TableDefinition<import("convex/values").VObject<{
        deliveryContext?: any;
        contextKey?: string | undefined;
        text: ArrayBuffer;
        sessionKey: string;
        ts: number;
        trusted: boolean;
        seq: number;
    }, {
        sessionKey: import("convex/values").VString<string, "required">;
        seq: import("convex/values").VFloat64<number, "required">;
        text: import("convex/values").VBytes<ArrayBuffer, "required">;
        ts: import("convex/values").VFloat64<number, "required">;
        contextKey: import("convex/values").VString<string | undefined, "optional">;
        deliveryContext: import("convex/values").VAny<any, "optional", string>;
        trusted: import("convex/values").VBoolean<boolean, "required">;
    }, "required", "text" | "sessionKey" | "ts" | "deliveryContext" | "contextKey" | "trusted" | "seq" | `deliveryContext.${string}`>, {
        by_session_seq: ["sessionKey", "seq", "_creationTime"];
        by_session_ts: ["sessionKey", "ts", "_creationTime"];
    }, {}, {}>;
    sessionEvents: import("convex/server").TableDefinition<import("convex/values").VObject<{
        toolName?: string | undefined;
        args?: ArrayBuffer | undefined;
        aborted?: boolean | undefined;
        inner?: string | undefined;
        delta?: string | undefined;
        role?: string | undefined;
        content?: ArrayBuffer | undefined;
        stopReason?: string | undefined;
        errorMessage?: string | undefined;
        toolCallId?: string | undefined;
        isError?: boolean | undefined;
        result?: ArrayBuffer | undefined;
        attempt?: number | undefined;
        maxAttempts?: number | undefined;
        delayMs?: number | undefined;
        success?: boolean | undefined;
        finalError?: string | undefined;
        willRetry?: boolean | undefined;
        messageCount?: number | undefined;
        type: string;
        agentId: string;
        sessionKey: string;
        ts: string;
        day: string;
        ownerId: string;
    }, {
        ts: import("convex/values").VString<string, "required">;
        day: import("convex/values").VString<string, "required">;
        ownerId: import("convex/values").VString<string, "required">;
        agentId: import("convex/values").VString<string, "required">;
        sessionKey: import("convex/values").VString<string, "required">;
        type: import("convex/values").VString<string, "required">;
        inner: import("convex/values").VString<string | undefined, "optional">;
        delta: import("convex/values").VString<string | undefined, "optional">;
        toolCallId: import("convex/values").VString<string | undefined, "optional">;
        toolName: import("convex/values").VString<string | undefined, "optional">;
        args: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        result: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        isError: import("convex/values").VBoolean<boolean | undefined, "optional">;
        role: import("convex/values").VString<string | undefined, "optional">;
        content: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        stopReason: import("convex/values").VString<string | undefined, "optional">;
        errorMessage: import("convex/values").VString<string | undefined, "optional">;
        attempt: import("convex/values").VFloat64<number | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number | undefined, "optional">;
        delayMs: import("convex/values").VFloat64<number | undefined, "optional">;
        aborted: import("convex/values").VBoolean<boolean | undefined, "optional">;
        willRetry: import("convex/values").VBoolean<boolean | undefined, "optional">;
        messageCount: import("convex/values").VFloat64<number | undefined, "optional">;
        success: import("convex/values").VBoolean<boolean | undefined, "optional">;
        finalError: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "type" | "agentId" | "sessionKey" | "toolName" | "ts" | "args" | "aborted" | "inner" | "delta" | "role" | "content" | "stopReason" | "errorMessage" | "toolCallId" | "isError" | "result" | "attempt" | "maxAttempts" | "delayMs" | "success" | "finalError" | "willRetry" | "messageCount" | "day" | "ownerId">, {
        by_owner_day: ["ownerId", "day", "_creationTime"];
        by_owner_session: ["ownerId", "sessionKey", "ts", "_creationTime"];
        by_owner_error: ["ownerId", "isError", "ts", "_creationTime"];
    }, {}, {}>;
    subsystemLog: import("convex/server").TableDefinition<import("convex/values").VObject<{
        fields?: any;
        message: string;
        time: string;
        level: string;
        subsystem: string;
        day: string;
        ownerId: string;
    }, {
        time: import("convex/values").VString<string, "required">;
        day: import("convex/values").VString<string, "required">;
        ownerId: import("convex/values").VString<string, "required">;
        level: import("convex/values").VString<string, "required">;
        subsystem: import("convex/values").VString<string, "required">;
        message: import("convex/values").VString<string, "required">;
        fields: import("convex/values").VAny<any, "optional", string>;
    }, "required", "message" | "time" | "level" | "subsystem" | "fields" | "day" | "ownerId" | `fields.${string}`>, {
        by_owner_day: ["ownerId", "day", "_creationTime"];
        by_owner_subsystem_time: ["ownerId", "subsystem", "time", "_creationTime"];
        by_owner_level_time: ["ownerId", "level", "time", "_creationTime"];
    }, {}, {}>;
    cronJobs: import("convex/server").TableDefinition<import("convex/values").VObject<{
        agentId?: string | undefined;
        description?: string | undefined;
        sessionKey?: string | undefined;
        wakeMode?: string | undefined;
        delivery?: ArrayBuffer | undefined;
        failureAlert?: any;
        deleteAfterRun?: boolean | undefined;
        createdByChannelId?: string | undefined;
        createdByConversationId?: string | undefined;
        createdByAccountId?: string | undefined;
        scheduleExpr?: string | undefined;
        scheduleTz?: string | undefined;
        scheduleStaggerMs?: number | undefined;
        scheduleEveryMs?: number | undefined;
        scheduleAnchorMs?: number | undefined;
        scheduleAt?: number | undefined;
        stateNextRunAtMs?: number | undefined;
        stateLastRunAtMs?: number | undefined;
        stateRunningAtMs?: number | undefined;
        stateLastStatus?: string | undefined;
        stateLastError?: string | undefined;
        stateScheduleErrorCount?: number | undefined;
        stateConsecutiveErrorCount?: number | undefined;
        stateLastFailureAlertAtMs?: number | undefined;
        stateLastDelivered?: boolean | undefined;
        stateLastDeliveryStatus?: string | undefined;
        stateLastDeliveryError?: string | undefined;
        name: string;
        enabled: boolean;
        sessionTarget: string;
        payload: ArrayBuffer;
        jobId: string;
        updatedAtMs: number;
        createdByKind: "owner" | "channel" | "legacy";
        ownerUserId: string;
        scheduleKind: "at" | "every" | "cron";
        createdAtMs: number;
    }, {
        jobId: import("convex/values").VString<string, "required">;
        ownerUserId: import("convex/values").VString<string, "required">;
        name: import("convex/values").VString<string, "required">;
        description: import("convex/values").VString<string | undefined, "optional">;
        enabled: import("convex/values").VBoolean<boolean, "required">;
        agentId: import("convex/values").VString<string | undefined, "optional">;
        sessionKey: import("convex/values").VString<string | undefined, "optional">;
        scheduleKind: import("convex/values").VUnion<"at" | "every" | "cron", [import("convex/values").VLiteral<"cron", "required">, import("convex/values").VLiteral<"every", "required">, import("convex/values").VLiteral<"at", "required">], "required", never>;
        scheduleExpr: import("convex/values").VString<string | undefined, "optional">;
        scheduleTz: import("convex/values").VString<string | undefined, "optional">;
        scheduleStaggerMs: import("convex/values").VFloat64<number | undefined, "optional">;
        scheduleEveryMs: import("convex/values").VFloat64<number | undefined, "optional">;
        scheduleAnchorMs: import("convex/values").VFloat64<number | undefined, "optional">;
        scheduleAt: import("convex/values").VFloat64<number | undefined, "optional">;
        sessionTarget: import("convex/values").VString<string, "required">;
        wakeMode: import("convex/values").VString<string | undefined, "optional">;
        payload: import("convex/values").VBytes<ArrayBuffer, "required">;
        delivery: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        failureAlert: import("convex/values").VAny<any, "optional", string>;
        deleteAfterRun: import("convex/values").VBoolean<boolean | undefined, "optional">;
        createdByKind: import("convex/values").VUnion<"owner" | "channel" | "legacy", [import("convex/values").VLiteral<"owner", "required">, import("convex/values").VLiteral<"channel", "required">, import("convex/values").VLiteral<"legacy", "required">], "required", never>;
        createdByChannelId: import("convex/values").VString<string | undefined, "optional">;
        createdByConversationId: import("convex/values").VString<string | undefined, "optional">;
        createdByAccountId: import("convex/values").VString<string | undefined, "optional">;
        createdAtMs: import("convex/values").VFloat64<number, "required">;
        updatedAtMs: import("convex/values").VFloat64<number, "required">;
        stateNextRunAtMs: import("convex/values").VFloat64<number | undefined, "optional">;
        stateLastRunAtMs: import("convex/values").VFloat64<number | undefined, "optional">;
        stateRunningAtMs: import("convex/values").VFloat64<number | undefined, "optional">;
        stateLastStatus: import("convex/values").VString<string | undefined, "optional">;
        stateLastError: import("convex/values").VString<string | undefined, "optional">;
        stateScheduleErrorCount: import("convex/values").VFloat64<number | undefined, "optional">;
        stateConsecutiveErrorCount: import("convex/values").VFloat64<number | undefined, "optional">;
        stateLastFailureAlertAtMs: import("convex/values").VFloat64<number | undefined, "optional">;
        stateLastDelivered: import("convex/values").VBoolean<boolean | undefined, "optional">;
        stateLastDeliveryStatus: import("convex/values").VString<string | undefined, "optional">;
        stateLastDeliveryError: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "agentId" | "name" | "enabled" | "description" | "sessionKey" | "sessionTarget" | "wakeMode" | "payload" | "delivery" | "failureAlert" | "deleteAfterRun" | "jobId" | "updatedAtMs" | "createdByKind" | "createdByChannelId" | "createdByConversationId" | "createdByAccountId" | "ownerUserId" | "scheduleKind" | "scheduleExpr" | "scheduleTz" | "scheduleStaggerMs" | "scheduleEveryMs" | "scheduleAnchorMs" | "scheduleAt" | "createdAtMs" | "stateNextRunAtMs" | "stateLastRunAtMs" | "stateRunningAtMs" | "stateLastStatus" | "stateLastError" | "stateScheduleErrorCount" | "stateConsecutiveErrorCount" | "stateLastFailureAlertAtMs" | "stateLastDelivered" | "stateLastDeliveryStatus" | "stateLastDeliveryError" | `failureAlert.${string}`>, {
        by_owner_enabled_next: ["ownerUserId", "enabled", "stateNextRunAtMs", "_creationTime"];
        by_owner_job: ["ownerUserId", "jobId", "_creationTime"];
        by_owner_channel_conv: ["ownerUserId", "createdByChannelId", "createdByConversationId", "_creationTime"];
    }, {
        search_name_desc: {
            searchField: "name";
            filterFields: "ownerUserId";
        };
    }, {}>;
    cronRuns: import("convex/server").TableDefinition<import("convex/values").VObject<{
        error?: string | undefined;
        provider?: string | undefined;
        delivered?: boolean | undefined;
        sessionKey?: string | undefined;
        nextRunAtMs?: number | undefined;
        model?: string | undefined;
        sessionId?: string | undefined;
        runAtMs?: number | undefined;
        summary?: ArrayBuffer | undefined;
        durationMs?: number | undefined;
        deliveryStatus?: string | undefined;
        deliveryError?: string | undefined;
        usageInput?: number | undefined;
        usageOutput?: number | undefined;
        usageCacheRead?: number | undefined;
        usageCacheWrite?: number | undefined;
        usageTotalTokens?: number | undefined;
        usageCostUsd?: number | undefined;
        jobId: string;
        status: "error" | "ok" | "skipped";
        ts: number;
        ownerUserId: string;
    }, {
        ownerUserId: import("convex/values").VString<string, "required">;
        jobId: import("convex/values").VString<string, "required">;
        ts: import("convex/values").VFloat64<number, "required">;
        status: import("convex/values").VUnion<"error" | "ok" | "skipped", [import("convex/values").VLiteral<"ok", "required">, import("convex/values").VLiteral<"error", "required">, import("convex/values").VLiteral<"skipped", "required">], "required", never>;
        error: import("convex/values").VString<string | undefined, "optional">;
        summary: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        delivered: import("convex/values").VBoolean<boolean | undefined, "optional">;
        deliveryStatus: import("convex/values").VString<string | undefined, "optional">;
        deliveryError: import("convex/values").VString<string | undefined, "optional">;
        sessionId: import("convex/values").VString<string | undefined, "optional">;
        sessionKey: import("convex/values").VString<string | undefined, "optional">;
        runAtMs: import("convex/values").VFloat64<number | undefined, "optional">;
        durationMs: import("convex/values").VFloat64<number | undefined, "optional">;
        nextRunAtMs: import("convex/values").VFloat64<number | undefined, "optional">;
        model: import("convex/values").VString<string | undefined, "optional">;
        provider: import("convex/values").VString<string | undefined, "optional">;
        usageInput: import("convex/values").VFloat64<number | undefined, "optional">;
        usageOutput: import("convex/values").VFloat64<number | undefined, "optional">;
        usageCacheRead: import("convex/values").VFloat64<number | undefined, "optional">;
        usageCacheWrite: import("convex/values").VFloat64<number | undefined, "optional">;
        usageTotalTokens: import("convex/values").VFloat64<number | undefined, "optional">;
        usageCostUsd: import("convex/values").VFloat64<number | undefined, "optional">;
    }, "required", "error" | "provider" | "delivered" | "sessionKey" | "jobId" | "nextRunAtMs" | "model" | "sessionId" | "runAtMs" | "status" | "summary" | "durationMs" | "ts" | "ownerUserId" | "deliveryStatus" | "deliveryError" | "usageInput" | "usageOutput" | "usageCacheRead" | "usageCacheWrite" | "usageTotalTokens" | "usageCostUsd">, {
        by_owner_job_ts: ["ownerUserId", "jobId", "ts", "_creationTime"];
        by_owner_job_status_ts: ["ownerUserId", "jobId", "status", "ts", "_creationTime"];
    }, {}, {}>;
    cronServiceState: import("convex/server").TableDefinition<import("convex/values").VObject<{
        lastReapAtMs?: number | undefined;
        lastTickArmedAt?: number | undefined;
        lastTickExpectedDelayMs?: number | undefined;
        ownerUserId: string;
    }, {
        ownerUserId: import("convex/values").VString<string, "required">;
        lastReapAtMs: import("convex/values").VFloat64<number | undefined, "optional">;
        lastTickArmedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        lastTickExpectedDelayMs: import("convex/values").VFloat64<number | undefined, "optional">;
    }, "required", "ownerUserId" | "lastReapAtMs" | "lastTickArmedAt" | "lastTickExpectedDelayMs">, {
        by_owner: ["ownerUserId", "_creationTime"];
    }, {}, {}>;
    channelAccess: import("convex/server").TableDefinition<import("convex/values").VObject<{
        code?: ArrayBuffer | undefined;
        senderName?: string | undefined;
        createdAt?: number | undefined;
        lastSeenAt?: number | undefined;
        accountId: string;
        kind: "allow-from" | "group-allow-from" | "pairing";
        channelId: string;
        ownerId: string;
        senderId: ArrayBuffer;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        channelId: import("convex/values").VString<string, "required">;
        accountId: import("convex/values").VString<string, "required">;
        kind: import("convex/values").VUnion<"allow-from" | "group-allow-from" | "pairing", [import("convex/values").VLiteral<"allow-from", "required">, import("convex/values").VLiteral<"group-allow-from", "required">, import("convex/values").VLiteral<"pairing", "required">], "required", never>;
        senderId: import("convex/values").VBytes<ArrayBuffer, "required">;
        senderName: import("convex/values").VString<string | undefined, "optional">;
        code: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        createdAt: import("convex/values").VFloat64<number | undefined, "optional">;
        lastSeenAt: import("convex/values").VFloat64<number | undefined, "optional">;
    }, "required", "code" | "senderName" | "accountId" | "kind" | "createdAt" | "channelId" | "ownerId" | "senderId" | "lastSeenAt">, {
        by_owner_channel_account_kind: ["ownerId", "channelId", "accountId", "kind", "_creationTime"];
        by_pairing_code: ["ownerId", "channelId", "accountId", "code", "_creationTime"];
    }, {}, {}>;
    whatsappAuthFile: import("convex/server").TableDefinition<import("convex/values").VObject<{
        accountId: string;
        ownerId: string;
        updatedAt: number;
        fileKey: string;
        contentB64: ArrayBuffer;
        contentVersion: number;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        accountId: import("convex/values").VString<string, "required">;
        fileKey: import("convex/values").VString<string, "required">;
        contentB64: import("convex/values").VBytes<ArrayBuffer, "required">;
        contentVersion: import("convex/values").VFloat64<number, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "accountId" | "ownerId" | "updatedAt" | "fileKey" | "contentB64" | "contentVersion">, {
        by_owner_account_file: ["ownerId", "accountId", "fileKey", "_creationTime"];
        by_owner_account: ["ownerId", "accountId", "_creationTime"];
    }, {}, {}>;
    channelMediaBlob: import("convex/server").TableDefinition<import("convex/values").VObject<{
        fileName?: string | undefined;
        accountId: string;
        createdAt: number;
        channelId: string;
        mimeType: string;
        bytes: number;
        index: number;
        ownerId: string;
        messageId: string;
        storageId: import("convex/values").GenericId<"_storage">;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        channelId: import("convex/values").VString<string, "required">;
        accountId: import("convex/values").VString<string, "required">;
        messageId: import("convex/values").VString<string, "required">;
        index: import("convex/values").VFloat64<number, "required">;
        mimeType: import("convex/values").VString<string, "required">;
        fileName: import("convex/values").VString<string | undefined, "optional">;
        storageId: import("convex/values").VId<import("convex/values").GenericId<"_storage">, "required">;
        bytes: import("convex/values").VFloat64<number, "required">;
        createdAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "accountId" | "createdAt" | "channelId" | "mimeType" | "bytes" | "index" | "ownerId" | "messageId" | "fileName" | "storageId">, {
        by_owner_channel_account_msg: ["ownerId", "channelId", "accountId", "messageId", "_creationTime"];
    }, {}, {}>;
    authProfiles: import("convex/server").TableDefinition<import("convex/values").VObject<{
        alias?: string | undefined;
        expires?: number | undefined;
        metadata?: any;
        keyEnc?: ArrayBuffer | undefined;
        keyRef?: {
            id: string;
            source: string;
            provider: string;
        } | undefined;
        tokenEnc?: ArrayBuffer | undefined;
        tokenRef?: {
            id: string;
            source: string;
            provider: string;
        } | undefined;
        accessEnc?: ArrayBuffer | undefined;
        refreshEnc?: ArrayBuffer | undefined;
        type: "api_key" | "oauth" | "token";
        profileId: string;
        agentId: string;
        provider: string;
        ownerId: string;
        updatedAt: number;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        agentId: import("convex/values").VString<string, "required">;
        profileId: import("convex/values").VString<string, "required">;
        provider: import("convex/values").VString<string, "required">;
        alias: import("convex/values").VString<string | undefined, "optional">;
        type: import("convex/values").VUnion<"api_key" | "oauth" | "token", [import("convex/values").VLiteral<"api_key", "required">, import("convex/values").VLiteral<"oauth", "required">, import("convex/values").VLiteral<"token", "required">], "required", never>;
        keyEnc: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        keyRef: import("convex/values").VObject<{
            id: string;
            source: string;
            provider: string;
        } | undefined, {
            source: import("convex/values").VString<string, "required">;
            provider: import("convex/values").VString<string, "required">;
            id: import("convex/values").VString<string, "required">;
        }, "optional", "id" | "source" | "provider">;
        tokenEnc: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        tokenRef: import("convex/values").VObject<{
            id: string;
            source: string;
            provider: string;
        } | undefined, {
            source: import("convex/values").VString<string, "required">;
            provider: import("convex/values").VString<string, "required">;
            id: import("convex/values").VString<string, "required">;
        }, "optional", "id" | "source" | "provider">;
        accessEnc: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        refreshEnc: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        expires: import("convex/values").VFloat64<number | undefined, "optional">;
        metadata: import("convex/values").VAny<any, "optional", string>;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "type" | "alias" | "expires" | "profileId" | "agentId" | "provider" | "metadata" | "ownerId" | "updatedAt" | `metadata.${string}` | "keyEnc" | "keyRef" | "tokenEnc" | "tokenRef" | "accessEnc" | "refreshEnc" | "keyRef.id" | "keyRef.source" | "keyRef.provider" | "tokenRef.id" | "tokenRef.source" | "tokenRef.provider">, {
        by_owner_agent: ["ownerId", "agentId", "_creationTime"];
        by_owner_agent_provider: ["ownerId", "agentId", "provider", "_creationTime"];
        by_owner_agent_profileId: ["ownerId", "agentId", "profileId", "_creationTime"];
    }, {}, {}>;
    profileState: import("convex/server").TableDefinition<import("convex/values").VObject<{
        disabledUntil?: number | undefined;
        cooldownUntil?: number | undefined;
        cooldownModel?: string | undefined;
        errorCount?: number | undefined;
        lastUsed?: number | undefined;
        cooldownReason?: string | undefined;
        disabledReason?: string | undefined;
        failureCounts?: any;
        lastFailureAt?: number | undefined;
        explicitOrder?: number | undefined;
        profileId: string;
        agentId: string;
        provider: string;
        ownerId: string;
        isLastGood: boolean;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        agentId: import("convex/values").VString<string, "required">;
        profileId: import("convex/values").VString<string, "required">;
        provider: import("convex/values").VString<string, "required">;
        lastUsed: import("convex/values").VFloat64<number | undefined, "optional">;
        cooldownUntil: import("convex/values").VFloat64<number | undefined, "optional">;
        cooldownReason: import("convex/values").VString<string | undefined, "optional">;
        cooldownModel: import("convex/values").VString<string | undefined, "optional">;
        disabledUntil: import("convex/values").VFloat64<number | undefined, "optional">;
        disabledReason: import("convex/values").VString<string | undefined, "optional">;
        errorCount: import("convex/values").VFloat64<number | undefined, "optional">;
        failureCounts: import("convex/values").VAny<any, "optional", string>;
        lastFailureAt: import("convex/values").VFloat64<number | undefined, "optional">;
        isLastGood: import("convex/values").VBoolean<boolean, "required">;
        explicitOrder: import("convex/values").VFloat64<number | undefined, "optional">;
    }, "required", "disabledUntil" | "cooldownUntil" | "cooldownModel" | "profileId" | "errorCount" | "agentId" | "provider" | "ownerId" | "lastUsed" | "cooldownReason" | "disabledReason" | "failureCounts" | "lastFailureAt" | "isLastGood" | "explicitOrder" | `failureCounts.${string}`>, {
        by_owner_agent_provider: ["ownerId", "agentId", "provider", "_creationTime"];
        by_owner_agent_profileId: ["ownerId", "agentId", "profileId", "_creationTime"];
        by_cooldown_until: ["ownerId", "agentId", "cooldownUntil", "_creationTime"];
    }, {}, {}>;
    authFiles: import("convex/server").TableDefinition<import("convex/values").VObject<{
        agentId: string;
        payload: ArrayBuffer;
        kind: "auth-state" | "profile-state" | "models";
        ownerId: string;
        updatedAt: number;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        agentId: import("convex/values").VString<string, "required">;
        kind: import("convex/values").VUnion<"auth-state" | "profile-state" | "models", [import("convex/values").VLiteral<"auth-state", "required">, import("convex/values").VLiteral<"profile-state", "required">, import("convex/values").VLiteral<"models", "required">], "required", never>;
        payload: import("convex/values").VBytes<ArrayBuffer, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "agentId" | "payload" | "kind" | "ownerId" | "updatedAt">, {
        by_owner_agent_kind: ["ownerId", "agentId", "kind", "_creationTime"];
    }, {}, {}>;
    systemMeta: import("convex/server").TableDefinition<import("convex/values").VObject<{
        key: string;
        value: string;
        updatedAt: number;
    }, {
        key: import("convex/values").VString<string, "required">;
        value: import("convex/values").VString<string, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "key" | "value" | "updatedAt">, {
        by_key: ["key", "_creationTime"];
    }, {}, {}>;
    whatsappAuthCreds: import("convex/server").TableDefinition<import("convex/values").VObject<{
        accountId: string;
        payload: ArrayBuffer;
        ownerId: string;
        updatedAt: number;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        accountId: import("convex/values").VString<string, "required">;
        payload: import("convex/values").VBytes<ArrayBuffer, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "accountId" | "payload" | "ownerId" | "updatedAt">, {
        by_owner_account: ["ownerId", "accountId", "_creationTime"];
    }, {}, {}>;
    whatsappAuthKeys: import("convex/server").TableDefinition<import("convex/values").VObject<{
        payload?: ArrayBuffer | undefined;
        storageId?: import("convex/values").GenericId<"_storage"> | undefined;
        accountId: string;
        ownerId: string;
        updatedAt: number;
        keyType: string;
        keyId: string;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        accountId: import("convex/values").VString<string, "required">;
        keyType: import("convex/values").VString<string, "required">;
        keyId: import("convex/values").VString<string, "required">;
        payload: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        storageId: import("convex/values").VId<import("convex/values").GenericId<"_storage"> | undefined, "optional">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "accountId" | "payload" | "ownerId" | "updatedAt" | "storageId" | "keyType" | "keyId">, {
        by_owner_account_type_id: ["ownerId", "accountId", "keyType", "keyId", "_creationTime"];
        by_owner_account: ["ownerId", "accountId", "_creationTime"];
    }, {}, {}>;
    execApprovals: import("convex/server").TableDefinition<import("convex/values").VObject<{
        agentId: string;
        value: string;
        kind: "exact" | "pattern";
        createdAt: number;
        ownerId: string;
        valueNormalised: string;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        agentId: import("convex/values").VString<string, "required">;
        kind: import("convex/values").VUnion<"exact" | "pattern", [import("convex/values").VLiteral<"exact", "required">, import("convex/values").VLiteral<"pattern", "required">], "required", never>;
        value: import("convex/values").VString<string, "required">;
        valueNormalised: import("convex/values").VString<string, "required">;
        createdAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "agentId" | "value" | "kind" | "createdAt" | "ownerId" | "valueNormalised">, {
        by_owner_agent_kind: ["ownerId", "agentId", "kind", "_creationTime"];
        by_owner_agent_value: ["ownerId", "agentId", "valueNormalised", "_creationTime"];
    }, {}, {}>;
    skills: import("convex/server").TableDefinition<import("convex/values").VObject<{
        agentId: string | null;
        name: string;
        source: "bundled" | "config" | "managed" | "personal" | "project" | "workspace";
        description: string;
        createdAt: number;
        ownerId: string;
        updatedAt: number;
        frontmatter: string;
        body: string;
        eligibility: {
            os: string[];
            requiresBins: string[];
            requiresAnyBins: string[];
            requiresEnv: string[];
            requiresConfig: string[];
        };
        disableModelInvocation: boolean;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        source: import("convex/values").VUnion<"bundled" | "config" | "managed" | "personal" | "project" | "workspace", [import("convex/values").VLiteral<"bundled", "required">, import("convex/values").VLiteral<"config", "required">, import("convex/values").VLiteral<"managed", "required">, import("convex/values").VLiteral<"personal", "required">, import("convex/values").VLiteral<"project", "required">, import("convex/values").VLiteral<"workspace", "required">], "required", never>;
        agentId: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        name: import("convex/values").VString<string, "required">;
        description: import("convex/values").VString<string, "required">;
        frontmatter: import("convex/values").VString<string, "required">;
        body: import("convex/values").VString<string, "required">;
        eligibility: import("convex/values").VObject<{
            os: string[];
            requiresBins: string[];
            requiresAnyBins: string[];
            requiresEnv: string[];
            requiresConfig: string[];
        }, {
            os: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
            requiresBins: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
            requiresAnyBins: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
            requiresEnv: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
            requiresConfig: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
        }, "required", "os" | "requiresBins" | "requiresAnyBins" | "requiresEnv" | "requiresConfig">;
        disableModelInvocation: import("convex/values").VBoolean<boolean, "required">;
        createdAt: import("convex/values").VFloat64<number, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "agentId" | "name" | "source" | "description" | "createdAt" | "ownerId" | "updatedAt" | "frontmatter" | "body" | "eligibility" | "disableModelInvocation" | "eligibility.os" | "eligibility.requiresBins" | "eligibility.requiresAnyBins" | "eligibility.requiresEnv" | "eligibility.requiresConfig">, {
        by_owner_name: ["ownerId", "name", "_creationTime"];
        by_owner_scope_name: ["ownerId", "source", "agentId", "name", "_creationTime"];
        by_owner_source: ["ownerId", "source", "_creationTime"];
    }, {}, {}>;
    extensions: import("convex/server").TableDefinition<import("convex/values").VObject<{
        config?: ArrayBuffer | undefined;
        bundleBytes?: ArrayBuffer | undefined;
        manifest?: any;
        bundleSha?: string | undefined;
        enabled: boolean;
        createdBy: string;
        createdAt: number;
        origin: "bundled" | "user";
        updatedAt: number;
        moduleId: string;
        sourceLabel: string;
    }, {
        moduleId: import("convex/values").VString<string, "required">;
        origin: import("convex/values").VUnion<"bundled" | "user", [import("convex/values").VLiteral<"bundled", "required">, import("convex/values").VLiteral<"user", "required">], "required", never>;
        bundleBytes: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        sourceLabel: import("convex/values").VString<string, "required">;
        manifest: import("convex/values").VAny<any, "optional", string>;
        enabled: import("convex/values").VBoolean<boolean, "required">;
        config: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        bundleSha: import("convex/values").VString<string | undefined, "optional">;
        createdAt: import("convex/values").VFloat64<number, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
        createdBy: import("convex/values").VString<string, "required">;
    }, "required", "config" | "enabled" | "createdBy" | "createdAt" | "origin" | "updatedAt" | "moduleId" | "bundleBytes" | "sourceLabel" | "manifest" | "bundleSha" | `manifest.${string}`>, {
        by_moduleId: ["moduleId", "_creationTime"];
        by_origin_enabled: ["origin", "enabled", "_creationTime"];
    }, {}, {}>;
    orgDeriveAudit: import("convex/server").TableDefinition<import("convex/values").VObject<{
        mode: "open" | "explicit" | "derived";
        ts: string;
        topOrder: string;
        ownerId: string;
        edgeCount: number;
        memberCount: number;
        extraAllowCount: number;
        extraDenyCount: number;
        warnings: number;
    }, {
        ts: import("convex/values").VString<string, "required">;
        topOrder: import("convex/values").VString<string, "required">;
        mode: import("convex/values").VUnion<"open" | "explicit" | "derived", [import("convex/values").VLiteral<"derived", "required">, import("convex/values").VLiteral<"explicit", "required">, import("convex/values").VLiteral<"open", "required">], "required", never>;
        edgeCount: import("convex/values").VFloat64<number, "required">;
        memberCount: import("convex/values").VFloat64<number, "required">;
        extraAllowCount: import("convex/values").VFloat64<number, "required">;
        extraDenyCount: import("convex/values").VFloat64<number, "required">;
        warnings: import("convex/values").VFloat64<number, "required">;
        ownerId: import("convex/values").VString<string, "required">;
    }, "required", "mode" | "ts" | "topOrder" | "ownerId" | "edgeCount" | "memberCount" | "extraAllowCount" | "extraDenyCount" | "warnings">, {
        by_owner_ts: ["ownerId", "ts", "_creationTime"];
        by_owner_topOrder: ["ownerId", "topOrder", "_creationTime"];
    }, {}, {}>;
    orgChartCache: import("convex/server").TableDefinition<import("convex/values").VObject<{
        transient: boolean;
        mtimeMs: number;
        width: number;
        height: number;
        themeId: string;
        themeName: string;
        mimeType: "image/png";
        hash: string;
        ownerId: string;
        pngBytes: ArrayBuffer;
    }, {
        hash: import("convex/values").VString<string, "required">;
        pngBytes: import("convex/values").VBytes<ArrayBuffer, "required">;
        width: import("convex/values").VFloat64<number, "required">;
        height: import("convex/values").VFloat64<number, "required">;
        themeId: import("convex/values").VString<string, "required">;
        themeName: import("convex/values").VString<string, "required">;
        mimeType: import("convex/values").VLiteral<"image/png", "required">;
        mtimeMs: import("convex/values").VFloat64<number, "required">;
        transient: import("convex/values").VBoolean<boolean, "required">;
        ownerId: import("convex/values").VString<string, "required">;
    }, "required", "transient" | "mtimeMs" | "width" | "height" | "themeId" | "themeName" | "mimeType" | "hash" | "ownerId" | "pngBytes">, {
        by_owner_hash: ["ownerId", "hash", "_creationTime"];
        by_owner_mtime: ["ownerId", "mtimeMs", "_creationTime"];
    }, {}, {}>;
    subagentRuns: import("convex/server").TableDefinition<import("convex/values").VObject<{
        model?: string | undefined;
        workspaceDir?: string | undefined;
        label?: string | undefined;
        controllerSessionKey?: string | undefined;
        requesterOrigin?: ArrayBuffer | undefined;
        runTimeoutSeconds?: number | undefined;
        spawnMode?: "session" | "run" | undefined;
        startedAt?: number | undefined;
        sessionStartedAt?: number | undefined;
        accumulatedRuntimeMs?: number | undefined;
        endedAt?: number | undefined;
        outcome?: {
            text?: ArrayBuffer | undefined;
            error?: string | undefined;
            reason?: string | undefined;
            status: "error" | "timeout" | "ok" | "abort";
        } | undefined;
        archiveAtMs?: number | undefined;
        cleanupCompletedAt?: number | undefined;
        cleanupHandled?: boolean | undefined;
        suppressAnnounceReason?: "steer-restart" | "killed" | undefined;
        expectsCompletionMessage?: boolean | undefined;
        announceRetryCount?: number | undefined;
        lastAnnounceRetryAt?: number | undefined;
        endedReason?: string | undefined;
        wakeOnDescendantSettle?: boolean | undefined;
        frozenResultText?: ArrayBuffer | undefined;
        frozenResultCapturedAt?: number | undefined;
        fallbackFrozenResultText?: ArrayBuffer | undefined;
        fallbackFrozenResultCapturedAt?: number | undefined;
        endedHookEmittedAt?: number | undefined;
        completionAnnouncedAt?: number | undefined;
        attachmentsDir?: string | undefined;
        attachmentsRootDir?: string | undefined;
        retainAttachmentsOnKeep?: boolean | undefined;
        createdAt: number;
        ownerId: string;
        cleanup: "delete" | "keep";
        runId: string;
        childSessionKey: string;
        requesterSessionKey: string;
        requesterDisplayKey: string;
        task: ArrayBuffer;
    }, {
        runId: import("convex/values").VString<string, "required">;
        childSessionKey: import("convex/values").VString<string, "required">;
        requesterSessionKey: import("convex/values").VString<string, "required">;
        controllerSessionKey: import("convex/values").VString<string | undefined, "optional">;
        requesterDisplayKey: import("convex/values").VString<string, "required">;
        requesterOrigin: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        task: import("convex/values").VBytes<ArrayBuffer, "required">;
        cleanup: import("convex/values").VUnion<"delete" | "keep", [import("convex/values").VLiteral<"delete", "required">, import("convex/values").VLiteral<"keep", "required">], "required", never>;
        label: import("convex/values").VString<string | undefined, "optional">;
        model: import("convex/values").VString<string | undefined, "optional">;
        workspaceDir: import("convex/values").VString<string | undefined, "optional">;
        runTimeoutSeconds: import("convex/values").VFloat64<number | undefined, "optional">;
        spawnMode: import("convex/values").VUnion<"session" | "run" | undefined, [import("convex/values").VLiteral<"run", "required">, import("convex/values").VLiteral<"session", "required">], "optional", never>;
        createdAt: import("convex/values").VFloat64<number, "required">;
        startedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        sessionStartedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        accumulatedRuntimeMs: import("convex/values").VFloat64<number | undefined, "optional">;
        endedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        outcome: import("convex/values").VObject<{
            text?: ArrayBuffer | undefined;
            error?: string | undefined;
            reason?: string | undefined;
            status: "error" | "timeout" | "ok" | "abort";
        } | undefined, {
            status: import("convex/values").VUnion<"error" | "timeout" | "ok" | "abort", [import("convex/values").VLiteral<"ok", "required">, import("convex/values").VLiteral<"error", "required">, import("convex/values").VLiteral<"timeout", "required">, import("convex/values").VLiteral<"abort", "required">], "required", never>;
            text: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
            error: import("convex/values").VString<string | undefined, "optional">;
            reason: import("convex/values").VString<string | undefined, "optional">;
        }, "optional", "text" | "error" | "reason" | "status">;
        archiveAtMs: import("convex/values").VFloat64<number | undefined, "optional">;
        cleanupCompletedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        cleanupHandled: import("convex/values").VBoolean<boolean | undefined, "optional">;
        suppressAnnounceReason: import("convex/values").VUnion<"steer-restart" | "killed" | undefined, [import("convex/values").VLiteral<"steer-restart", "required">, import("convex/values").VLiteral<"killed", "required">], "optional", never>;
        expectsCompletionMessage: import("convex/values").VBoolean<boolean | undefined, "optional">;
        announceRetryCount: import("convex/values").VFloat64<number | undefined, "optional">;
        lastAnnounceRetryAt: import("convex/values").VFloat64<number | undefined, "optional">;
        endedReason: import("convex/values").VString<string | undefined, "optional">;
        wakeOnDescendantSettle: import("convex/values").VBoolean<boolean | undefined, "optional">;
        frozenResultText: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        frozenResultCapturedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        fallbackFrozenResultText: import("convex/values").VBytes<ArrayBuffer | undefined, "optional">;
        fallbackFrozenResultCapturedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        endedHookEmittedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        completionAnnouncedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        attachmentsDir: import("convex/values").VString<string | undefined, "optional">;
        attachmentsRootDir: import("convex/values").VString<string | undefined, "optional">;
        retainAttachmentsOnKeep: import("convex/values").VBoolean<boolean | undefined, "optional">;
        ownerId: import("convex/values").VString<string, "required">;
    }, "required", "model" | "createdAt" | "workspaceDir" | "ownerId" | "label" | "cleanup" | "runId" | "childSessionKey" | "requesterSessionKey" | "controllerSessionKey" | "requesterDisplayKey" | "requesterOrigin" | "task" | "runTimeoutSeconds" | "spawnMode" | "startedAt" | "sessionStartedAt" | "accumulatedRuntimeMs" | "endedAt" | "outcome" | "archiveAtMs" | "cleanupCompletedAt" | "cleanupHandled" | "suppressAnnounceReason" | "expectsCompletionMessage" | "announceRetryCount" | "lastAnnounceRetryAt" | "endedReason" | "wakeOnDescendantSettle" | "frozenResultText" | "frozenResultCapturedAt" | "fallbackFrozenResultText" | "fallbackFrozenResultCapturedAt" | "endedHookEmittedAt" | "completionAnnouncedAt" | "attachmentsDir" | "attachmentsRootDir" | "retainAttachmentsOnKeep" | "outcome.text" | "outcome.error" | "outcome.reason" | "outcome.status">, {
        by_runId: ["ownerId", "runId", "_creationTime"];
        by_childSessionKey_active: ["ownerId", "childSessionKey", "endedAt", "_creationTime"];
        by_requester_createdAt: ["ownerId", "requesterSessionKey", "createdAt", "_creationTime"];
        by_controller_active: ["ownerId", "controllerSessionKey", "endedAt", "_creationTime"];
        by_requester_active: ["ownerId", "requesterSessionKey", "endedAt", "_creationTime"];
    }, {}, {}>;
    gatewayCoord: import("convex/server").TableDefinition<import("convex/values").VObject<{
        pid?: number | undefined;
        pidAliveAt?: number | undefined;
        heartbeatTs?: number | undefined;
        heartbeatPid?: number | undefined;
        heartbeatUptimeMs?: number | undefined;
        lockPid?: number | undefined;
        lockPort?: number | undefined;
        lockCreatedAt?: string | undefined;
        lockLeaseUntil?: number | undefined;
        instanceId: string;
        updatedAt: number;
    }, {
        instanceId: import("convex/values").VString<string, "required">;
        pid: import("convex/values").VFloat64<number | undefined, "optional">;
        pidAliveAt: import("convex/values").VFloat64<number | undefined, "optional">;
        heartbeatTs: import("convex/values").VFloat64<number | undefined, "optional">;
        heartbeatPid: import("convex/values").VFloat64<number | undefined, "optional">;
        heartbeatUptimeMs: import("convex/values").VFloat64<number | undefined, "optional">;
        lockPid: import("convex/values").VFloat64<number | undefined, "optional">;
        lockPort: import("convex/values").VFloat64<number | undefined, "optional">;
        lockCreatedAt: import("convex/values").VString<string | undefined, "optional">;
        lockLeaseUntil: import("convex/values").VFloat64<number | undefined, "optional">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "pid" | "instanceId" | "updatedAt" | "pidAliveAt" | "heartbeatTs" | "heartbeatPid" | "heartbeatUptimeMs" | "lockPid" | "lockPort" | "lockCreatedAt" | "lockLeaseUntil">, {
        by_instance: ["instanceId", "_creationTime"];
    }, {}, {}>;
    brigadeBlobs: import("convex/server").TableDefinition<import("convex/values").VObject<{
        sha256: string;
        size: number;
        ownerId: string;
        storageId: import("convex/values").GenericId<"_storage">;
        mime: string;
        refcount: number;
        lastTouchedAt: number;
    }, {
        ownerId: import("convex/values").VString<string, "required">;
        sha256: import("convex/values").VString<string, "required">;
        storageId: import("convex/values").VId<import("convex/values").GenericId<"_storage">, "required">;
        mime: import("convex/values").VString<string, "required">;
        size: import("convex/values").VFloat64<number, "required">;
        refcount: import("convex/values").VFloat64<number, "required">;
        lastTouchedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "sha256" | "size" | "ownerId" | "storageId" | "mime" | "refcount" | "lastTouchedAt">, {
        by_sha256: ["sha256", "_creationTime"];
        by_owner_storage: ["ownerId", "storageId", "_creationTime"];
    }, {}, {}>;
}, true>;
export default _default;
//# sourceMappingURL=schema.d.ts.map