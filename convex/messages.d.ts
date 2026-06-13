export declare const appendRecord: import("convex/server").RegisteredMutation<"public", {
    customType?: string | undefined;
    type: string;
    agentId: string;
    payload: ArrayBuffer;
    sessionId: string;
}, Promise<{
    seq: number;
}>>;
/** Ordered batch append — the convex-mode SessionManager write-behind queue
 *  flushes whole batches in one transaction so a mid-batch crash can't leave
 *  a torn parent-id chain. */
export declare const appendRecordsBatch: import("convex/server").RegisteredMutation<"public", {
    agentId: string;
    sessionId: string;
    records: {
        customType?: string | undefined;
        type: string;
        payload: ArrayBuffer;
    }[];
}, Promise<{
    lastSeq: number;
}>>;
/** Wholesale transcript replace — realises Pi's `_rewriteFile` (v1→v3
 *  migration, branch extraction) as one transaction. */
export declare const replaceTranscript: import("convex/server").RegisteredMutation<"public", {
    agentId: string;
    sessionId: string;
    records: {
        customType?: string | undefined;
        type: string;
        payload: ArrayBuffer;
    }[];
}, Promise<{
    count: number;
}>>;
export declare const readTranscript: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    afterSeq?: number | undefined;
    agentId: string;
    sessionId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionTranscriptRecords">;
    _creationTime: number;
    customType?: string | undefined;
    chunkIndex?: number | undefined;
    chunkCount?: number | undefined;
    type: string;
    agentId: string;
    payload: ArrayBuffer;
    sessionId: string;
    createdAt: number;
    seq: number;
}[]>>;
/** Newest-first tail of (type, customType) only — for the bootstrap-delivery
 *  check, which must honour compaction-invalidation (a compaction newer than
 *  the marker means the bootstrap context was compacted out → re-deliver).
 *  Returns just the two fields the walk needs, not the sealed payloads. */
export declare const readMarkerTail: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    agentId: string;
    sessionId: string;
}, Promise<{
    type: string;
    customType?: string;
}[]>>;
export declare const deleteTranscript: import("convex/server").RegisteredMutation<"public", {
    agentId: string;
    sessionId: string;
}, Promise<number>>;
export declare const inboxEnqueue: import("convex/server").RegisteredMutation<"public", {
    ts?: number | undefined;
    deliveryContext?: any;
    contextKey?: string | undefined;
    text: ArrayBuffer;
    sessionKey: string;
    trusted: boolean;
}, Promise<{
    seq: number;
}>>;
export declare const inboxPeek: import("convex/server").RegisteredQuery<"public", {
    sessionKey: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionInboxEvents">;
    _creationTime: number;
    deliveryContext?: any;
    contextKey?: string | undefined;
    text: ArrayBuffer;
    sessionKey: string;
    ts: number;
    trusted: boolean;
    seq: number;
}[]>>;
export declare const inboxDrain: import("convex/server").RegisteredMutation<"public", {
    sessionKey: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionInboxEvents">;
    _creationTime: number;
    deliveryContext?: any;
    contextKey?: string | undefined;
    text: ArrayBuffer;
    sessionKey: string;
    ts: number;
    trusted: boolean;
    seq: number;
}[]>>;
export declare const inboxConsumePrefix: import("convex/server").RegisteredMutation<"public", {
    sessionKey: string;
    prefixLength: number;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionInboxEvents">;
    _creationTime: number;
    deliveryContext?: any;
    contextKey?: string | undefined;
    text: ArrayBuffer;
    sessionKey: string;
    ts: number;
    trusted: boolean;
    seq: number;
}[]>>;
export declare const inboxHasEvents: import("convex/server").RegisteredQuery<"public", {
    sessionKey: string;
}, Promise<boolean>>;
//# sourceMappingURL=messages.d.ts.map