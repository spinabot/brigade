/** Pre-hydrate the whole keystore in one query — Baileys reads keys inside
 *  the Signal decrypt path, so the adapter serves them from an in-process
 *  cache filled here at connect time. Oversized values come back as a
 *  download URL instead of inline bytes. */
export declare const loadAll: import("convex/server").RegisteredQuery<"public", {
    accountId: string;
    ownerId: string;
}, Promise<{
    creds: ArrayBuffer | null;
    keys: ({
        keyType: string;
        keyId: string;
        url: string | null;
        payload?: undefined;
    } | {
        keyType: string;
        keyId: string;
        payload: ArrayBuffer | undefined;
        url?: undefined;
    })[];
}>>;
export declare const writeCreds: import("convex/server").RegisteredMutation<"public", {
    accountId: string;
    payload: ArrayBuffer;
    ownerId: string;
}, Promise<{
    updated: boolean;
}>>;
/** Batched key upserts + deletes in one transaction — mirrors Baileys'
 *  transaction batching (addTransactionCapability flushes whole
 *  SignalDataSets). An entry with neither payload nor storageId is a
 *  DELETE (Baileys sets null to remove keys). */
export declare const writeKeys: import("convex/server").RegisteredMutation<"public", {
    entries: {
        payload?: ArrayBuffer | undefined;
        storageId?: import("convex/values").GenericId<"_storage"> | undefined;
        keyType: string;
        keyId: string;
    }[];
    accountId: string;
    ownerId: string;
}, Promise<{
    count: number;
}>>;
/** Wipe an account's auth state entirely (logout / unlink). */
export declare const clearAccount: import("convex/server").RegisteredMutation<"public", {
    accountId: string;
    ownerId: string;
}, Promise<{
    removedKeys: number;
}>>;
//# sourceMappingURL=whatsappAuth.d.ts.map