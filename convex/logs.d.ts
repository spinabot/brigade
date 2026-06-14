export declare const appendSessionEvent: import("convex/server").RegisteredMutation<"public", {
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
}, Promise<void>>;
export declare const readSessionEventTail: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    day?: string | undefined;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionEvents">;
    _creationTime: number;
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
}[]>>;
export declare const findLastError: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionEvents">;
    _creationTime: number;
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
} | null>>;
export declare const appendSubsystemRecord: import("convex/server").RegisteredMutation<"public", {
    fields?: any;
    message: string;
    time: string;
    level: "error" | "trace" | "debug" | "info" | "warn" | "fatal";
    subsystem: string;
    day: string;
    ownerId: string;
}, Promise<void>>;
export declare const readSubsystemRecords: import("convex/server").RegisteredQuery<"public", {
    level?: "error" | "trace" | "debug" | "info" | "warn" | "fatal" | undefined;
    subsystem?: string | undefined;
    limit?: number | undefined;
    day?: string | undefined;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"subsystemLog">;
    _creationTime: number;
    fields?: any;
    message: string;
    time: string;
    level: string;
    subsystem: string;
    day: string;
    ownerId: string;
}[]>>;
export declare const pruneSubsystemLogs: import("convex/server").RegisteredMutation<"public", {
    ownerId: string;
    olderThanMs: number;
}, Promise<{
    removed: number;
}>>;
export declare const appendConfigAudit: import("convex/server").RegisteredMutation<"public", {
    pid?: number | undefined;
    sha256: string;
    ts: string;
    bytes: number;
    instanceId: string;
}, Promise<{
    pid?: number | undefined;
    prevHash?: string | undefined;
    instanceId: string;
    ts: string;
    sha256: string;
    bytes: number;
    seq: number;
    lineHash: string;
}>>;
export declare const listConfigAudit: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    instanceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"brigadeConfigAudit">;
    _creationTime: number;
    pid?: number | undefined;
    prevHash?: string | undefined;
    sha256: string;
    ts: string;
    bytes: number;
    instanceId: string;
    lineHash: string;
    seq: number;
}[]>>;
export declare const writeConfigHealth: import("convex/server").RegisteredMutation<"public", {
    sha256: string;
    mtimeMs: number;
    ts: string;
    pid: number;
    bytes: number;
    ownerId: string;
    configPath: string;
}, Promise<void>>;
export declare const readConfigHealth: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"configHealth">;
    _creationTime: number;
    sha256: string;
    mtimeMs: number;
    ts: string;
    pid: number;
    bytes: number;
    ownerId: string;
    configPath: string;
} | null>>;
//# sourceMappingURL=logs.d.ts.map