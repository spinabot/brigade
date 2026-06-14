export declare const getEntry: import("convex/server").RegisteredQuery<"public", {
    agentId: string;
    sessionKey: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessions">;
    _creationTime: number;
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
} | null>>;
export declare const listEntries: import("convex/server").RegisteredQuery<"public", {
    subagentOnly?: boolean | undefined;
    agentId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessions">;
    _creationTime: number;
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
}[]>>;
export declare const upsertEntry: import("convex/server").RegisteredMutation<"public", {
    modelId?: string | undefined;
    provider?: string | undefined;
    createdAt?: number | undefined;
    lastUsedAt?: number | undefined;
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
}, Promise<{
    _id: import("convex/values").GenericId<"sessions">;
    _creationTime: number;
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
} | null>>;
export declare const deleteEntry: import("convex/server").RegisteredMutation<"public", {
    agentId: string;
    sessionKey: string;
}, Promise<boolean>>;
//# sourceMappingURL=sessions.d.ts.map