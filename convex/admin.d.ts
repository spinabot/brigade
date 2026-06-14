declare const RESETTABLE_TABLES: readonly ["brigadeConfig", "brigadeConfigAudit", "brigadeConfigBackups", "configHealth", "personaFiles", "workspaceState", "memoryFacts", "memoryExtractCursors", "memoryConsolidateState", "sessions", "sessionTranscriptRecords", "sessionInboxEvents", "sessionEvents", "subsystemLog", "cronJobs", "cronRuns", "cronServiceState", "channelAccess", "whatsappAuthFile", "channelMediaBlob", "authProfiles", "profileState", "authFiles", "systemMeta", "whatsappAuthCreds", "whatsappAuthKeys", "execApprovals", "skills", "extensions", "orgDeriveAudit", "orgChartCache", "subagentRuns", "gatewayCoord", "brigadeBlobs"];
export type ResettableTable = (typeof RESETTABLE_TABLES)[number];
/** The list the reset client iterates — exported via query so the CLI and
 *  the server can never drift on which tables exist. */
export declare const listResettableTables: import("convex/server").RegisteredQuery<"public", {}, Promise<("extensions" | "sessions" | "skills" | "brigadeConfig" | "brigadeConfigAudit" | "brigadeConfigBackups" | "configHealth" | "personaFiles" | "workspaceState" | "memoryFacts" | "memoryExtractCursors" | "memoryConsolidateState" | "sessionTranscriptRecords" | "sessionInboxEvents" | "sessionEvents" | "subsystemLog" | "cronJobs" | "cronRuns" | "cronServiceState" | "channelAccess" | "whatsappAuthFile" | "channelMediaBlob" | "authProfiles" | "profileState" | "authFiles" | "systemMeta" | "whatsappAuthCreds" | "whatsappAuthKeys" | "execApprovals" | "orgDeriveAudit" | "orgChartCache" | "subagentRuns" | "gatewayCoord" | "brigadeBlobs")[]>>;
/** Headline summary for "found an existing Brigade in this backend". */
export declare const instanceSummary: import("convex/server").RegisteredQuery<"public", {}, Promise<{
    hasData: boolean;
    createdAtMs: number | null;
    counts: {
        memories: number;
        sessions: number;
        cronJobs: number;
        personas: number;
    };
    whatsappLinked: boolean;
    storedKeyFingerprint: string | null;
}>>;
/** Delete a bounded batch of rows from one table (reaping File-Storage spills
 *  first). Returns `{ deleted, done }` where `done` is true ONLY when the table
 *  is fully drained — the client loops while `!done`.
 *
 *  Convex caps a single function execution at 16 MiB of reads. A fixed row
 *  count blows that on large-row tables (transcript chunks ~768 KiB, media /
 *  auth / blobs near the 1 MiB doc limit) — 200 such rows is ~150 MiB and
 *  crashes with "Too many bytes read". So we read in small inner `.take()`
 *  batches (deleted rows drop out of the next `.take()`, so no cursor needed),
 *  sum the bytes, and stop once another batch could approach the cap. Small-row
 *  tables still clear ~MAX_ROWS per call; large-row tables clear a safe handful.
 *  A byte-capped batch is "short" but NOT drained, so `done` — not the batch
 *  size — is the loop signal. */
export declare const resetPage: import("convex/server").RegisteredMutation<"public", {
    limit?: number | undefined;
    table: "extensions" | "sessions" | "skills" | "brigadeConfig" | "brigadeConfigAudit" | "brigadeConfigBackups" | "configHealth" | "personaFiles" | "workspaceState" | "memoryFacts" | "memoryExtractCursors" | "memoryConsolidateState" | "sessionTranscriptRecords" | "sessionInboxEvents" | "sessionEvents" | "subsystemLog" | "cronJobs" | "cronRuns" | "cronServiceState" | "channelAccess" | "whatsappAuthFile" | "channelMediaBlob" | "authProfiles" | "profileState" | "authFiles" | "systemMeta" | "whatsappAuthCreds" | "whatsappAuthKeys" | "execApprovals" | "orgDeriveAudit" | "orgChartCache" | "subagentRuns" | "gatewayCoord" | "brigadeBlobs";
}, Promise<{
    deleted: number;
    done: boolean;
}>>;
export {};
//# sourceMappingURL=admin.d.ts.map