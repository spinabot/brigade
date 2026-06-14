export declare const list: import("convex/server").RegisteredQuery<"public", {
    agentId: string;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"execApprovals">;
    _creationTime: number;
    agentId: string;
    value: string;
    kind: "exact" | "pattern";
    createdAt: number;
    ownerId: string;
    valueNormalised: string;
}[]>>;
export declare const insert: import("convex/server").RegisteredMutation<"public", {
    agentId: string;
    value: string;
    kind: "exact" | "pattern";
    ownerId: string;
    valueNormalised: string;
}, Promise<{
    inserted: boolean;
}>>;
export declare const remove: import("convex/server").RegisteredMutation<"public", {
    agentId: string;
    ownerId: string;
    valueNormalised: string;
}, Promise<{
    removedCommands: number;
    removedPatterns: number;
}>>;
//# sourceMappingURL=execApprovals.d.ts.map