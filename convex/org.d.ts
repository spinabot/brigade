export declare const appendDeriveAudit: import("convex/server").RegisteredMutation<"public", {
    mode: "open" | "explicit" | "derived";
    ts: string;
    topOrder: string;
    ownerId: string;
    edgeCount: number;
    memberCount: number;
    extraAllowCount: number;
    extraDenyCount: number;
    warnings: number;
}, Promise<void>>;
export declare const listDeriveAudit: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"orgDeriveAudit">;
    _creationTime: number;
    mode: "open" | "explicit" | "derived";
    ts: string;
    topOrder: string;
    ownerId: string;
    edgeCount: number;
    memberCount: number;
    extraAllowCount: number;
    extraDenyCount: number;
    warnings: number;
}[]>>;
export declare const getChart: import("convex/server").RegisteredQuery<"public", {
    hash: string;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"orgChartCache">;
    _creationTime: number;
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
} | null>>;
export declare const putChart: import("convex/server").RegisteredMutation<"public", {
    transient?: boolean | undefined;
    width: number;
    height: number;
    themeId: string;
    themeName: string;
    hash: string;
    ownerId: string;
    pngBytes: ArrayBuffer;
}, Promise<void>>;
export declare const deleteChart: import("convex/server").RegisteredMutation<"public", {
    hash: string;
    ownerId: string;
}, Promise<void>>;
export declare const listCharts: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"orgChartCache">;
    _creationTime: number;
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
}[]>>;
//# sourceMappingURL=org.d.ts.map