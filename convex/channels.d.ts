export declare const listAccess: import("convex/server").RegisteredQuery<"public", {
    accountId: string;
    kind: "allow-from" | "group-allow-from" | "pairing";
    channelId: string;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"channelAccess">;
    _creationTime: number;
    code?: ArrayBuffer | undefined;
    senderName?: string | undefined;
    createdAt?: number | undefined;
    lastSeenAt?: number | undefined;
    accountId: string;
    kind: "allow-from" | "group-allow-from" | "pairing";
    channelId: string;
    ownerId: string;
    senderId: ArrayBuffer;
}[]>>;
/** Every access row for the owner — single-operator scale keeps this tiny.
 *  Boot hydration uses it to fill the in-process access cache in one query
 *  instead of guessing the channel/account layout from config. */
export declare const listAllAccess: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"channelAccess">;
    _creationTime: number;
    code?: ArrayBuffer | undefined;
    senderName?: string | undefined;
    createdAt?: number | undefined;
    lastSeenAt?: number | undefined;
    accountId: string;
    kind: "allow-from" | "group-allow-from" | "pairing";
    channelId: string;
    ownerId: string;
    senderId: ArrayBuffer;
}[]>>;
/** Replace the row set for one (channel, account, kind) in a single
 *  transaction — the convex-mode realisation of the filesystem's
 *  whole-file atomic write. Caller-supplied codes/timestamps are
 *  authoritative so locally-generated pairing codes survive verbatim. */
export declare const reconcileAccess: import("convex/server").RegisteredMutation<"public", {
    accountId: string;
    kind: "allow-from" | "group-allow-from" | "pairing";
    channelId: string;
    ownerId: string;
    rows: {
        code?: ArrayBuffer | undefined;
        senderName?: string | undefined;
        createdAt: number;
        senderId: ArrayBuffer;
        lastSeenAt: number;
    }[];
}, Promise<{
    count: number;
}>>;
export declare const upsertAccess: import("convex/server").RegisteredMutation<"public", {
    code?: ArrayBuffer | undefined;
    senderName?: string | undefined;
    accountId: string;
    kind: "allow-from" | "group-allow-from" | "pairing";
    channelId: string;
    ownerId: string;
    senderId: ArrayBuffer;
}, Promise<{
    changed: boolean;
}>>;
export declare const removeAccess: import("convex/server").RegisteredMutation<"public", {
    accountId: string;
    kind: "allow-from" | "group-allow-from" | "pairing";
    channelId: string;
    ownerId: string;
    senderId: ArrayBuffer;
}, Promise<boolean>>;
export declare const eraseAccount: import("convex/server").RegisteredMutation<"public", {
    accountId: string;
    channelId: string;
    ownerId: string;
}, Promise<void>>;
export declare const upsertPairingRequest: import("convex/server").RegisteredMutation<"public", {
    senderName?: string | undefined;
    accountId: string;
    channelId: string;
    ownerId: string;
    senderId: ArrayBuffer;
}, Promise<{
    code: string;
    isNew: boolean;
}>>;
export declare const approvePairing: import("convex/server").RegisteredMutation<"public", {
    code: string;
    accountId: string;
    channelId: string;
    ownerId: string;
}, Promise<{
    code: string;
    senderId: string;
    senderName: string | null;
} | null>>;
export declare const revokePairing: import("convex/server").RegisteredMutation<"public", {
    code: string;
    accountId: string;
    channelId: string;
    ownerId: string;
}, Promise<boolean>>;
export declare const generateMediaUploadUrl: import("convex/server").RegisteredMutation<"public", {}, Promise<string>>;
export declare const recordMediaBlob: import("convex/server").RegisteredMutation<"public", {
    fileName?: string | undefined;
    accountId: string;
    channelId: string;
    mimeType: string;
    bytes: number;
    index: number;
    ownerId: string;
    messageId: string;
    storageId: import("convex/values").GenericId<"_storage">;
}, Promise<{
    ok: boolean;
}>>;
export declare const getMediaBlobUrl: import("convex/server").RegisteredQuery<"public", {
    accountId: string;
    channelId: string;
    index: number;
    ownerId: string;
    messageId: string;
}, Promise<{
    url: string;
    mimeType: string;
    bytes: number;
} | null>>;
export declare const writeAuthFile: import("convex/server").RegisteredMutation<"public", {
    accountId: string;
    ownerId: string;
    fileKey: string;
    contentB64: ArrayBuffer;
}, Promise<void>>;
export declare const readAuthFile: import("convex/server").RegisteredQuery<"public", {
    accountId: string;
    ownerId: string;
    fileKey: string;
}, Promise<{
    _id: import("convex/values").GenericId<"whatsappAuthFile">;
    _creationTime: number;
    accountId: string;
    ownerId: string;
    updatedAt: number;
    fileKey: string;
    contentB64: ArrayBuffer;
    contentVersion: number;
} | null>>;
//# sourceMappingURL=channels.d.ts.map