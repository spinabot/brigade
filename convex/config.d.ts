export declare const read: import("convex/server").RegisteredQuery<"public", {
    instanceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"brigadeConfig">;
    _creationTime: number;
    auth?: any;
    channels?: any;
    session?: any;
    defaults?: any;
    agents?: any;
    gateway?: any;
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
} | null>>;
export declare const write: import("convex/server").RegisteredMutation<"public", {
    auth?: any;
    channels?: any;
    session?: any;
    defaults?: any;
    agents?: any;
    gateway?: any;
    skills?: any;
    org?: any;
    tools?: any;
    plugins?: any;
    bindings?: any;
    wizard?: any;
    meta?: any;
    extra?: any;
    expectedSha256?: string | undefined;
    bytes: number;
    instanceId: string;
    contentSha256: string;
}, Promise<{
    rev: string;
    updated: boolean;
}>>;
export declare const listBackups: import("convex/server").RegisteredQuery<"public", {
    instanceId: string;
}, Promise<{
    slot: number;
    sha256: string;
    mtimeMs: number;
    bytes: number;
}[]>>;
export declare const getBackup: import("convex/server").RegisteredQuery<"public", {
    instanceId: string;
    slot: number;
}, Promise<{
    payload: string;
    sha256: string;
} | null>>;
//# sourceMappingURL=config.d.ts.map