export declare const listFacts: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    lifecycle?: "active" | "archived" | "pruned" | undefined;
    workspaceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"memoryFacts">;
    _creationTime: number;
    metadata?: any;
    status?: "asserted" | "provisional" | "confirmed" | "disputed" | "retracted" | undefined;
    sourceType?: "user_instruction" | "owner_message" | "channel_message" | "tool_output" | "retrieved_document" | "compaction" | "extraction" | "dream" | undefined;
    sourceTurn?: string | undefined;
    supersedes?: string[] | undefined;
    links?: {
        kind: "supersedes" | "transition" | "corrects" | "relates" | "derived_from" | "supports" | "contradicts";
        target: string;
    }[] | undefined;
    validFrom?: number | undefined;
    validTo?: number | undefined;
    confidence?: number | undefined;
    sourcePointers?: string[] | undefined;
    embedding?: number[] | undefined;
    modality?: "text" | "image" | "video" | "audio" | "document" | undefined;
    mediaPointer?: string | undefined;
    subjectKey?: string | undefined;
    createdByKind?: "owner" | "channel" | undefined;
    createdByChannelId?: string | undefined;
    createdByConversationId?: string | undefined;
    createdBySessionKey?: string | undefined;
    createdByAccountId?: string | undefined;
    createdAt: number;
    memoryId: string;
    content: ArrayBuffer;
    segment: "project" | "context" | "identity" | "preference" | "correction" | "relationship" | "knowledge";
    tier: "short" | "long" | "permanent";
    importance: number;
    decayRate: number;
    accessCount: number;
    lastAccessedAt: number;
    lifecycle: "active" | "archived" | "pruned";
    workspaceId: string;
}[]>>;
export declare const writeFact: import("convex/server").RegisteredMutation<"public", {
    metadata?: any;
    status?: "asserted" | "provisional" | "confirmed" | "disputed" | "retracted" | undefined;
    sourceType?: "user_instruction" | "owner_message" | "channel_message" | "tool_output" | "retrieved_document" | "compaction" | "extraction" | "dream" | undefined;
    sourceTurn?: string | undefined;
    supersedes?: string[] | undefined;
    links?: {
        kind: "supersedes" | "transition" | "corrects" | "relates" | "derived_from" | "supports" | "contradicts";
        target: string;
    }[] | undefined;
    validFrom?: number | undefined;
    validTo?: number | undefined;
    confidence?: number | undefined;
    sourcePointers?: string[] | undefined;
    embedding?: number[] | undefined;
    modality?: "text" | "image" | "video" | "audio" | "document" | undefined;
    mediaPointer?: string | undefined;
    subjectKey?: string | undefined;
    createdByKind?: "owner" | "channel" | undefined;
    createdByChannelId?: string | undefined;
    createdByConversationId?: string | undefined;
    createdBySessionKey?: string | undefined;
    createdByAccountId?: string | undefined;
    memoryId: string;
    content: ArrayBuffer;
    segment: "project" | "context" | "identity" | "preference" | "correction" | "relationship" | "knowledge";
    tier: "short" | "long" | "permanent";
    importance: number;
    decayRate: number;
    workspaceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"memoryFacts">;
    _creationTime: number;
    metadata?: any;
    status?: "asserted" | "provisional" | "confirmed" | "disputed" | "retracted" | undefined;
    sourceType?: "user_instruction" | "owner_message" | "channel_message" | "tool_output" | "retrieved_document" | "compaction" | "extraction" | "dream" | undefined;
    sourceTurn?: string | undefined;
    supersedes?: string[] | undefined;
    links?: {
        kind: "supersedes" | "transition" | "corrects" | "relates" | "derived_from" | "supports" | "contradicts";
        target: string;
    }[] | undefined;
    validFrom?: number | undefined;
    validTo?: number | undefined;
    confidence?: number | undefined;
    sourcePointers?: string[] | undefined;
    embedding?: number[] | undefined;
    modality?: "text" | "image" | "video" | "audio" | "document" | undefined;
    mediaPointer?: string | undefined;
    subjectKey?: string | undefined;
    createdByKind?: "owner" | "channel" | undefined;
    createdByChannelId?: string | undefined;
    createdByConversationId?: string | undefined;
    createdBySessionKey?: string | undefined;
    createdByAccountId?: string | undefined;
    createdAt: number;
    memoryId: string;
    content: ArrayBuffer;
    segment: "project" | "context" | "identity" | "preference" | "correction" | "relationship" | "knowledge";
    tier: "short" | "long" | "permanent";
    importance: number;
    decayRate: number;
    accessCount: number;
    lastAccessedAt: number;
    lifecycle: "active" | "archived" | "pruned";
    workspaceId: string;
} | null>>;
/** Every fact row for a workspace across all lifecycles — boot hydration of
 *  the in-process facts cache. */
export declare const listAllFacts: import("convex/server").RegisteredQuery<"public", {
    cursor?: string | null | undefined;
    numItems?: number | undefined;
    workspaceId: string;
}, Promise<import("convex/server").PaginationResult<{
    _id: import("convex/values").GenericId<"memoryFacts">;
    _creationTime: number;
    metadata?: any;
    status?: "asserted" | "provisional" | "confirmed" | "disputed" | "retracted" | undefined;
    sourceType?: "user_instruction" | "owner_message" | "channel_message" | "tool_output" | "retrieved_document" | "compaction" | "extraction" | "dream" | undefined;
    sourceTurn?: string | undefined;
    supersedes?: string[] | undefined;
    links?: {
        kind: "supersedes" | "transition" | "corrects" | "relates" | "derived_from" | "supports" | "contradicts";
        target: string;
    }[] | undefined;
    validFrom?: number | undefined;
    validTo?: number | undefined;
    confidence?: number | undefined;
    sourcePointers?: string[] | undefined;
    embedding?: number[] | undefined;
    modality?: "text" | "image" | "video" | "audio" | "document" | undefined;
    mediaPointer?: string | undefined;
    subjectKey?: string | undefined;
    createdByKind?: "owner" | "channel" | undefined;
    createdByChannelId?: string | undefined;
    createdByConversationId?: string | undefined;
    createdBySessionKey?: string | undefined;
    createdByAccountId?: string | undefined;
    createdAt: number;
    memoryId: string;
    content: ArrayBuffer;
    segment: "project" | "context" | "identity" | "preference" | "correction" | "relationship" | "knowledge";
    tier: "short" | "long" | "permanent";
    importance: number;
    decayRate: number;
    accessCount: number;
    lastAccessedAt: number;
    lifecycle: "active" | "archived" | "pruned";
    workspaceId: string;
}>>>;
/** Authoritative single-record upsert — every field caller-supplied
 *  (accessCount, lifecycle, timestamps included). The FactStore dispatch
 *  realises its whole-file diffs through this. */
export declare const upsertFactRecord: import("convex/server").RegisteredMutation<"public", {
    metadata?: any;
    status?: "asserted" | "provisional" | "confirmed" | "disputed" | "retracted" | undefined;
    sourceType?: "user_instruction" | "owner_message" | "channel_message" | "tool_output" | "retrieved_document" | "compaction" | "extraction" | "dream" | undefined;
    sourceTurn?: string | undefined;
    supersedes?: string[] | undefined;
    links?: {
        kind: "supersedes" | "transition" | "corrects" | "relates" | "derived_from" | "supports" | "contradicts";
        target: string;
    }[] | undefined;
    validFrom?: number | undefined;
    validTo?: number | undefined;
    confidence?: number | undefined;
    sourcePointers?: string[] | undefined;
    embedding?: number[] | undefined;
    modality?: "text" | "image" | "video" | "audio" | "document" | undefined;
    mediaPointer?: string | undefined;
    subjectKey?: string | undefined;
    createdByKind?: "owner" | "channel" | undefined;
    createdByChannelId?: string | undefined;
    createdByConversationId?: string | undefined;
    createdBySessionKey?: string | undefined;
    createdByAccountId?: string | undefined;
    createdAt: number;
    memoryId: string;
    content: ArrayBuffer;
    segment: "project" | "context" | "identity" | "preference" | "correction" | "relationship" | "knowledge";
    tier: "short" | "long" | "permanent";
    importance: number;
    decayRate: number;
    accessCount: number;
    lastAccessedAt: number;
    lifecycle: "active" | "archived" | "pruned";
    workspaceId: string;
}, Promise<void>>;
export declare const deleteFactRecord: import("convex/server").RegisteredMutation<"public", {
    memoryId: string;
    workspaceId: string;
}, Promise<void>>;
export declare const appendMemoryEvent: import("convex/server").RegisteredMutation<"public", {
    at: number;
    kind: string;
    data: string;
    workspaceId: string;
}, Promise<void>>;
/** The audit trail, oldest-first. Bounded to the most-recent `limit` (default 1000,
 *  max 5000) to stay under Convex's 16 MiB per-execution read cap. */
export declare const listMemoryEvents: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    workspaceId: string;
}, Promise<string[]>>;
export declare const markAccessed: import("convex/server").RegisteredMutation<"public", {
    workspaceId: string;
    memoryIds: string[];
}, Promise<void>>;
export declare const decay: import("convex/server").RegisteredMutation<"public", {
    shortIdleMs?: number | undefined;
    archivedIdleMs?: number | undefined;
    longIdleMs?: number | undefined;
    now: number;
    workspaceId: string;
}, Promise<{
    archived: number;
    pruned: number;
}>>;
export declare const setLifecycle: import("convex/server").RegisteredMutation<"public", {
    lifecycle: "active" | "archived" | "pruned";
    workspaceId: string;
    memoryIds: string[];
}, Promise<void>>;
export declare const countActiveFacts: import("convex/server").RegisteredQuery<"public", {
    cursor?: string | null | undefined;
    workspaceId: string;
}, Promise<{
    count: number;
    isDone: boolean;
    continueCursor: string;
}>>;
export declare const getExtractCursor: import("convex/server").RegisteredQuery<"public", {
    sessionId: string;
    workspaceId: string;
}, Promise<number>>;
export declare const setExtractCursor: import("convex/server").RegisteredMutation<"public", {
    sessionId: string;
    workspaceId: string;
    processedCount: number;
}, Promise<void>>;
export declare const getConsolidateLastRunAt: import("convex/server").RegisteredQuery<"public", {
    workspaceId: string;
}, Promise<number | undefined>>;
export declare const markConsolidateRunAt: import("convex/server").RegisteredMutation<"public", {
    workspaceId: string;
    lastRunAt: number;
}, Promise<void>>;
export declare const vectorProbe: import("convex/server").RegisteredAction<"public", {
    k?: number | undefined;
    embedding: number[];
    workspaceId: string;
}, Promise<{
    id: import("convex/values").GenericId<"memoryFacts">;
    score: number;
}[]>>;
export declare const searchContent: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    query: string;
    workspaceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"memoryFacts">;
    _creationTime: number;
    metadata?: any;
    status?: "asserted" | "provisional" | "confirmed" | "disputed" | "retracted" | undefined;
    sourceType?: "user_instruction" | "owner_message" | "channel_message" | "tool_output" | "retrieved_document" | "compaction" | "extraction" | "dream" | undefined;
    sourceTurn?: string | undefined;
    supersedes?: string[] | undefined;
    links?: {
        kind: "supersedes" | "transition" | "corrects" | "relates" | "derived_from" | "supports" | "contradicts";
        target: string;
    }[] | undefined;
    validFrom?: number | undefined;
    validTo?: number | undefined;
    confidence?: number | undefined;
    sourcePointers?: string[] | undefined;
    embedding?: number[] | undefined;
    modality?: "text" | "image" | "video" | "audio" | "document" | undefined;
    mediaPointer?: string | undefined;
    subjectKey?: string | undefined;
    createdByKind?: "owner" | "channel" | undefined;
    createdByChannelId?: string | undefined;
    createdByConversationId?: string | undefined;
    createdBySessionKey?: string | undefined;
    createdByAccountId?: string | undefined;
    createdAt: number;
    memoryId: string;
    content: ArrayBuffer;
    segment: "project" | "context" | "identity" | "preference" | "correction" | "relationship" | "knowledge";
    tier: "short" | "long" | "permanent";
    importance: number;
    decayRate: number;
    accessCount: number;
    lastAccessedAt: number;
    lifecycle: "active" | "archived" | "pruned";
    workspaceId: string;
}[]>>;
export declare const findSimilar: import("convex/server").RegisteredQuery<"public", {
    k?: number | undefined;
    embedding: number[];
    workspaceId: string;
}, Promise<{
    score: number;
    _id: import("convex/values").GenericId<"memoryFacts">;
    _creationTime: number;
    metadata?: any;
    status?: "asserted" | "provisional" | "confirmed" | "disputed" | "retracted" | undefined;
    sourceType?: "user_instruction" | "owner_message" | "channel_message" | "tool_output" | "retrieved_document" | "compaction" | "extraction" | "dream" | undefined;
    sourceTurn?: string | undefined;
    supersedes?: string[] | undefined;
    links?: {
        kind: "supersedes" | "transition" | "corrects" | "relates" | "derived_from" | "supports" | "contradicts";
        target: string;
    }[] | undefined;
    validFrom?: number | undefined;
    validTo?: number | undefined;
    confidence?: number | undefined;
    sourcePointers?: string[] | undefined;
    embedding?: number[] | undefined;
    modality?: "text" | "image" | "video" | "audio" | "document" | undefined;
    mediaPointer?: string | undefined;
    subjectKey?: string | undefined;
    createdByKind?: "owner" | "channel" | undefined;
    createdByChannelId?: string | undefined;
    createdByConversationId?: string | undefined;
    createdBySessionKey?: string | undefined;
    createdByAccountId?: string | undefined;
    createdAt: number;
    memoryId: string;
    content: ArrayBuffer;
    segment: "project" | "context" | "identity" | "preference" | "correction" | "relationship" | "knowledge";
    tier: "short" | "long" | "permanent";
    importance: number;
    decayRate: number;
    accessCount: number;
    lastAccessedAt: number;
    lifecycle: "active" | "archived" | "pruned";
    workspaceId: string;
}[]>>;
//# sourceMappingURL=memory.d.ts.map