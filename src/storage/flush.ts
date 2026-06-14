// src/storage/flush.ts
//
// Drain every write-behind chain. In convex mode the storage adapters batch
// mutations onto per-domain promise chains (config, approvals, channel access,
// cron, auth profiles + state, memory facts + cursors, transcripts, event +
// subsystem logs, media + inbox mirrors). The long-lived gateway drains them
// in its shutdown sequence; a SHORT-LIVED CLI command that mutates then calls
// `process.exit()` would otherwise terminate the process before the enqueued
// write reaches the backend — a silent lost write.
//
// `flushAllPendingWrites()` awaits all of them so a mutating CLI command can
// drain before it exits. Every chain resolves immediately in filesystem mode
// (sync writes are already durable), and awaiting an already-settled chain is
// free — so calling this is safe regardless of mode or which chains a given
// command actually touched.
//
// Each await is individually guarded: one failed flush must not prevent the
// others from draining (mirrors the gateway shutdown posture).

/** Await every storage write-behind chain. Safe in both modes; no-op when no
 *  writes are pending. Call before `process.exit()` in any mutating CLI path. */
export async function flushAllPendingWrites(): Promise<void> {
	try {
		const { awaitConfigFlush } = await import("../config/io.js");
		await awaitConfigFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitSessionFlush } = await import("./session-cache.js");
		await awaitSessionFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitApprovalsFlush } = await import("../core/exec-approvals.js");
		await awaitApprovalsFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitAccessFlush } = await import(
			"../agents/channels/access-control/store.js"
		);
		await awaitAccessFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitCronFlush } = await import("./cron-cache.js");
		await awaitCronFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitFactsFlush } = await import("./facts-cache.js");
		await awaitFactsFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitCursorFlush } = await import("../agents/memory/extract.js");
		await awaitCursorFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitAuthFlush } = await import("../auth/profiles.js");
		await awaitAuthFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitProfileStateFlush } = await import("../auth/profile-cooldown.js");
		await awaitProfileStateFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitTranscriptFlush } = await import(
			"../sessions/session-manager-factory.js"
		);
		await awaitTranscriptFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitEventLogFlush } = await import("../core/event-logger.js");
		await awaitEventLogFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitSubsystemLogFlush } = await import(
			"../logging/subsystem-logger.js"
		);
		await awaitSubsystemLogFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitMediaMirrorFlush } = await import(
			"../agents/channels/whatsapp/media.js"
		);
		await awaitMediaMirrorFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitInboxMirrorFlush } = await import("../agents/session-inbox.js");
		await awaitInboxMirrorFlush();
	} catch {
		/* best-effort */
	}
	try {
		const { awaitWorkspaceMirrorFlush } = await import("./workspace-live-mirror.js");
		await awaitWorkspaceMirrorFlush();
	} catch {
		/* best-effort */
	}
}
