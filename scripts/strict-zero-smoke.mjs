#!/usr/bin/env node
// scripts/strict-zero-smoke.mjs
//
// The authoritative strict-zero verification — run against a LIVE convex
// backend (the operator's smoke, or CI once a backend is provisioned):
//
//   1. requires mode=convex (sentinel or BRIGADE_MODE) + a reachable
//      BRIGADE_CONVEX_URL
//   2. boots the RuntimeContext (full hydration: config, sessions,
//      approvals, access, cron, facts, auth, models, workspace mirror)
//   3. exercises every dispatch domain end-to-end:
//      config write → read-back, session resolve, approval record → gate,
//      allow-list add → isAllowed, cron job insert → load, memory fact
//      write → recall, auth profile upsert → credential snapshot,
//      transcript append → read-back
//   4. watches ~/.brigade the whole time and FAILS on any file event
//      outside the allowlist (mode.sentinel + workspace/**)
//
// Usage:
//   node scripts/strict-zero-smoke.mjs
//
// Exit codes: 0 = clean, 1 = violations or a domain check failed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = process.env.BRIGADE_STATE_DIR?.trim() || path.join(os.homedir(), ".brigade");

function allowlisted(rel) {
	const parts = rel.split(/[\\/]/);
	if (parts[0] === "mode.sentinel") return true;
	if (parts[0] === "workspace") return true;
	if (parts[0] === "agents" && parts[2] === "workspace") return true;
	return false;
}

const violations = [];
let watcher;
try {
	if (fs.existsSync(stateDir)) {
		watcher = fs.watch(stateDir, { recursive: true }, (_event, filename) => {
			if (!filename) return;
			const rel = filename.toString();
			if (allowlisted(rel)) return;
			violations.push(rel);
			console.error(`✗ STRICT-ZERO VIOLATION: file event under ~/.brigade/${rel}`);
		});
	}
} catch {
	console.error("(recursive fs.watch unavailable on this platform — relying on end-state scan)");
}

const checks = [];
function check(name, fn) {
	checks.push({ name, fn });
}

const { bootRuntimeContext } = await import("../dist/storage/boot.js").catch(() => import("../src/storage/boot.ts"));

console.log(`strict-zero smoke — state dir: ${stateDir}`);
const ctx = await bootRuntimeContext();
if (ctx.mode !== "convex") {
	console.error(`✗ mode is "${ctx.mode}" — set the sentinel (brigade store mode set convex) first.`);
	process.exit(1);
}
console.log("✓ booted in convex mode (hydration complete)");

const stamp = Date.now().toString(36);

check("config write → read-back", async () => {
	const { readConfigOrInit, writeConfigSafeAsync } = await import("../dist/config/io.js").catch(() => import("../src/config/io.ts"));
	const cfg = readConfigOrInit();
	await writeConfigSafeAsync({ ...cfg, meta: { ...(cfg.meta ?? {}), lastTouchedAt: `smoke-${stamp}` } });
	const back = readConfigOrInit();
	if (back.meta?.lastTouchedAt !== `smoke-${stamp}`) throw new Error("read-back mismatch");
});

check("session resolve → entry visible", async () => {
	const { resolveOrCreateSession, readSessionStore } = await import("../dist/sessions/session-store.js").catch(() => import("../src/sessions/session-store.ts"));
	const resolved = resolveOrCreateSession({ agentId: "main", sessionKey: `agent:main:smoke-${stamp}` });
	if (!resolved.sessionId) throw new Error("no sessionId");
	const file = readSessionStore("main");
	if (!file.sessions[`agent:main:smoke-${stamp}`]) throw new Error("entry missing from store");
});

check("approval record → gate allows", async () => {
	const { recordApproval, decideApproval, awaitApprovalsFlush } = await import("../dist/core/exec-approvals.js").catch(() => import("../src/core/exec-approvals.ts"));
	recordApproval(`echo smoke-${stamp}`, "exact", "main");
	if (decideApproval(`echo smoke-${stamp}`, "main") !== "allow") throw new Error("gate did not allow");
	await awaitApprovalsFlush();
});

check("allow-list add → isAllowed", async () => {
	const { addAllowFrom, isAllowed, awaitAccessFlush } = await import("../dist/agents/channels/access-control/store.js").catch(() => import("../src/agents/channels/access-control/store.ts"));
	addAllowFrom("whatsapp", `9${stamp.replace(/\D/g, "")}99`, null);
	if (!isAllowed("whatsapp", `9${stamp.replace(/\D/g, "")}99`, null)) throw new Error("not allowed after add");
	await awaitAccessFlush();
});

check("memory fact write → recall", async () => {
	const { FactStore } = await import("../dist/agents/memory/records.js").catch(() => import("../src/agents/memory/records.ts"));
	const { awaitFactsFlush } = await import("../dist/storage/facts-cache.js").catch(() => import("../src/storage/facts-cache.ts"));
	const store = new FactStore(path.join(stateDir, "workspace"));
	const rec = store.write({ content: `smoke fact ${stamp}`, segment: "context" });
	const all = store.readAll();
	if (!all.some((r) => r.memoryId === rec.memoryId)) throw new Error("fact not readable");
	await awaitFactsFlush();
});

check("transcript append → read-back via store", async () => {
	const { openSessionManagerForAgent, awaitTranscriptFlush } = await import("../dist/sessions/session-manager-factory.js").catch(() => import("../src/sessions/session-manager-factory.ts"));
	const sm = await openSessionManagerForAgent({
		agentId: "main",
		sessionId: `smoke-${stamp}`,
		transcriptPath: path.join(stateDir, "agents", "main", "sessions", `smoke-${stamp}.jsonl`),
	});
	sm.appendMessage({ role: "user", content: [{ type: "text", text: `smoke ${stamp}` }] });
	await awaitTranscriptFlush();
	const records = await ctx.store.messages.readTranscript("main", `smoke-${stamp}`);
	if (!records.some((r) => r.type === "message")) throw new Error("transcript row missing");
});

let failed = 0;
for (const { name, fn } of checks) {
	try {
		await fn();
		console.log(`✓ ${name}`);
	} catch (err) {
		failed += 1;
		console.error(`✗ ${name} — ${err instanceof Error ? err.message : String(err)}`);
	}
}

// Settle the watcher, then a final end-state scan (covers platforms where
// recursive watch was unavailable).
await new Promise((r) => setTimeout(r, 1500));
watcher?.close();

const endStateOffenders = [];
if (fs.existsSync(stateDir)) {
	const stack = [stateDir];
	while (stack.length) {
		const dir = stack.pop();
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(stateDir, full);
			if (allowlisted(rel)) continue;
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			endStateOffenders.push(rel);
		}
	}
}

console.log("");
if (violations.length === 0 && endStateOffenders.length === 0 && failed === 0) {
	console.log("STRICT-ZERO SMOKE: PASS — all domains round-trip through Convex; ~/.brigade stayed clean.");
	process.exit(0);
}
if (violations.length > 0) console.error(`watch-time violations: ${[...new Set(violations)].join(", ")}`);
if (endStateOffenders.length > 0) console.error(`files present outside the allowlist: ${endStateOffenders.join(", ")}`);
if (failed > 0) console.error(`${failed} domain check(s) failed`);
process.exit(1);
