export declare const generateUploadUrl: import("convex/server").RegisteredMutation<"public", {
    sha256: string;
    ownerId: string;
}, Promise<{
    uploadUrl: string;
    storageId: string | null;
    existed: boolean;
    ownerId: string;
}>>;
export declare const recordUpload: import("convex/server").RegisteredMutation<"public", {
    contentType?: string | undefined;
    sha256: string;
    size: number;
    ownerId: string;
    storageId: import("convex/values").GenericId<"_storage">;
}, Promise<{
    existed: boolean;
}>>;
export declare const getMeta: import("convex/server").RegisteredQuery<"public", {
    sha256: string;
}, Promise<{
    _id: import("convex/values").GenericId<"brigadeBlobs">;
    _creationTime: number;
    sha256: string;
    size: number;
    ownerId: string;
    storageId: import("convex/values").GenericId<"_storage">;
    mime: string;
    refcount: number;
    lastTouchedAt: number;
} | null>>;
export declare const getDownloadUrl: import("convex/server").RegisteredQuery<"public", {
    sha256: string;
}, Promise<string | null>>;
export declare const remove: import("convex/server").RegisteredMutation<"public", {
    sha256: string;
}, Promise<boolean>>;
//# sourceMappingURL=blobs.d.ts.map