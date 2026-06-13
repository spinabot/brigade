export declare const listFacts: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    lifecycle?: "active" | "archived" | "pruned" | undefined;
    workspaceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"memoryFacts">;
    _creationTime: number;
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
}[]>>;
export declare const writeFact: import("convex/server").RegisteredMutation<"public", {
    metadata?: any;
    sourceTurn?: string | undefined;
    supersedes?: string[] | undefined;
    createdByKind?: "owner" | "channel" | undefined;
    createdByChannelId?: string | undefined;
    createdByConversationId?: string | undefined;
    createdBySessionKey?: string | undefined;
    createdByAccountId?: string | undefined;
    embedding?: number[] | undefined;
    content: ArrayBuffer;
    memoryId: string;
    segment: "project" | "identity" | "preference" | "correction" | "relationship" | "knowledge" | "context";
    tier: "short" | "long" | "permanent";
    importance: number;
    decayRate: number;
    workspaceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"memoryFacts">;
    _creationTime: number;
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
}>>>;
/** Authoritative single-record upsert — every field caller-supplied
 *  (accessCount, lifecycle, timestamps included). The FactStore dispatch
 *  realises its whole-file diffs through this. */
export declare const upsertFactRecord: import("convex/server").RegisteredMutation<"public", {
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
}, Promise<void>>;
export declare const deleteFactRecord: import("convex/server").RegisteredMutation<"public", {
    memoryId: string;
    workspaceId: string;
}, Promise<void>>;
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
export declare const searchContent: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    query: string;
    workspaceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"memoryFacts">;
    _creationTime: number;
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
}[]>>;
export declare const findSimilar: import("convex/server").RegisteredQuery<"public", {
    k?: number | undefined;
    workspaceId: string;
    embedding: number[];
}, Promise<{
    score: number;
    _id: import("convex/values").GenericId<"memoryFacts">;
    _creationTime: number;
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
}[]>>;
//# sourceMappingURL=memory.d.ts.map