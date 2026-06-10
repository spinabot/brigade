// convex/logs.ts — sessionEvents + subsystemLog + brigadeConfigAudit + configHealth
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const Level = v.union(
	v.literal("trace"),
	v.literal("debug"),
	v.literal("info"),
	v.literal("warn"),
	v.literal("error"),
	v.literal("fatal"),
);

// ============================================================================
// sessionEvents (Pi session events)
// ============================================================================

export const appendSessionEvent = mutation({
	args: {
		ts: v.string(),
		day: v.string(),
		ownerId: v.string(),
		agentId: v.string(),
		sessionKey: v.string(),
		type: v.string(),
		inner: v.optional(v.string()),
		delta: v.optional(v.string()),
		toolCallId: v.optional(v.string()),
		toolName: v.optional(v.string()),
		args: v.optional(v.bytes()),
		result: v.optional(v.bytes()),
		isError: v.optional(v.boolean()),
		role: v.optional(v.string()),
		content: v.optional(v.bytes()),
		stopReason: v.optional(v.string()),
		errorMessage: v.optional(v.string()),
		attempt: v.optional(v.number()),
		maxAttempts: v.optional(v.number()),
		delayMs: v.optional(v.number()),
		aborted: v.optional(v.boolean()),
		willRetry: v.optional(v.boolean()),
		messageCount: v.optional(v.number()),
		success: v.optional(v.boolean()),
		finalError: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert("sessionEvents", args);
	},
});

export const readSessionEventTail = query({
	args: { ownerId: v.string(), day: v.optional(v.string()), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const day = args.day ?? new Date().toISOString().slice(0, 10);
		const limit = args.limit && args.limit > 0 ? args.limit : 200;
		return ctx.db
			.query("sessionEvents")
			.withIndex("by_owner_day", (q) => q.eq("ownerId", args.ownerId).eq("day", day))
			.order("desc")
			.take(limit);
	},
});

export const findLastError = query({
	args: { ownerId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		// Mirror the disk `getLastLoggedError` scan: the most recent error is not
		// always a tool error (isError) — it can be an auto_retry_start with an
		// errorMessage or an aborted compaction_end. Scan today's events
		// newest-first and return the first error-shaped row. Falls back to the
		// isError index for older days when today has none.
		const day = new Date().toISOString().slice(0, 10);
		const scan = args.limit && args.limit > 0 ? args.limit : 400;
		const recent = await ctx.db
			.query("sessionEvents")
			.withIndex("by_owner_day", (q) => q.eq("ownerId", args.ownerId).eq("day", day))
			.order("desc")
			.take(scan);
		for (const row of recent) {
			if (row.type === "tool_execution_end" && row.isError === true) return row;
			if (row.type === "auto_retry_start" && typeof row.errorMessage === "string") return row;
			if (row.type === "compaction_end" && row.aborted === true && typeof row.errorMessage === "string") {
				return row;
			}
		}
		// Nothing today — fall back to the newest tool error across all days.
		return ctx.db
			.query("sessionEvents")
			.withIndex("by_owner_error", (q) => q.eq("ownerId", args.ownerId).eq("isError", true))
			.order("desc")
			.first();
	},
});

// ============================================================================
// subsystemLog
// ============================================================================

export const appendSubsystemRecord = mutation({
	args: {
		time: v.string(),
		day: v.string(),
		ownerId: v.string(),
		level: Level,
		subsystem: v.string(),
		message: v.string(),
		fields: v.optional(v.any()),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert("subsystemLog", args);
	},
});

export const readSubsystemRecords = query({
	args: {
		ownerId: v.string(),
		day: v.optional(v.string()),
		level: v.optional(Level),
		subsystem: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit && args.limit > 0 ? args.limit : 200;
		const day = args.day ?? new Date().toISOString().slice(0, 10);
		let rows = await ctx.db
			.query("subsystemLog")
			.withIndex("by_owner_day", (q) => q.eq("ownerId", args.ownerId).eq("day", day))
			.order("desc")
			.take(limit * 4);
		if (args.level) rows = rows.filter((r) => r.level === args.level);
		if (args.subsystem) rows = rows.filter((r) => r.subsystem === args.subsystem);
		return rows.slice(0, limit);
	},
});

export const pruneSubsystemLogs = mutation({
	args: { ownerId: v.string(), olderThanMs: v.number() },
	handler: async (ctx, args) => {
		const cutoff = new Date(Date.now() - args.olderThanMs).toISOString();
		const rows = await ctx.db
			.query("subsystemLog")
			.withIndex("by_owner_day", (q) => q.eq("ownerId", args.ownerId))
			.collect();
		let removed = 0;
		for (const r of rows) {
			if (r.time < cutoff) {
				await ctx.db.delete(r._id);
				removed += 1;
			}
		}
		return { removed };
	},
});

// ============================================================================
// brigadeConfigAudit (hash-chained)
// ============================================================================

export const appendConfigAudit = mutation({
	args: {
		instanceId: v.string(),
		ts: v.string(),
		sha256: v.string(),
		bytes: v.number(),
		pid: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const tail = await ctx.db
			.query("brigadeConfigAudit")
			.withIndex("by_instance_seq", (q) => q.eq("instanceId", args.instanceId))
			.order("desc")
			.first();
		const seq = (tail?.seq ?? 0) + 1;
		const prevHash = tail?.lineHash;
		const lineHashInput = `${args.instanceId}|${args.ts}|${args.sha256}|${args.bytes}|${seq}|${prevHash ?? ""}`;
		const enc = new TextEncoder().encode(lineHashInput);
		const buf = await crypto.subtle.digest("SHA-256", enc);
		const lineHash = Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const payload = {
			instanceId: args.instanceId,
			ts: args.ts,
			sha256: args.sha256,
			bytes: args.bytes,
			seq,
			lineHash,
			...(prevHash !== undefined ? { prevHash } : {}),
			...(args.pid !== undefined ? { pid: args.pid } : {}),
		};
		await ctx.db.insert("brigadeConfigAudit", payload);
		return payload;
	},
});

export const listConfigAudit = query({
	args: { instanceId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = args.limit && args.limit > 0 ? args.limit : 100;
		return ctx.db
			.query("brigadeConfigAudit")
			.withIndex("by_instance_seq", (q) => q.eq("instanceId", args.instanceId))
			.order("asc")
			.take(limit);
	},
});

// ============================================================================
// configHealth
// ============================================================================

export const writeConfigHealth = mutation({
	args: {
		ownerId: v.string(),
		ts: v.string(),
		configPath: v.string(),
		bytes: v.number(),
		sha256: v.string(),
		mtimeMs: v.number(),
		pid: v.number(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("configHealth")
			.withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
			.first();
		if (existing) await ctx.db.replace(existing._id, args);
		else await ctx.db.insert("configHealth", args);
	},
});

export const readConfigHealth = query({
	args: { ownerId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("configHealth")
			.withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
			.first();
	},
});
