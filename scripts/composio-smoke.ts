/**
 * Composio live smoke test — drives the real `composio` tool end-to-end against
 * a REAL Composio PLATFORM API key. Scratch/dev file: safe to delete, never
 * committed.
 *
 * The key is read from the environment so it never lands on the command line in
 * a shared terminal (and never in chat). Run from the repo root so node_modules
 * and ~/.brigade resolve:
 *
 *   # full flow: verify+seal key, discover apps, connect, check status, search
 *   COMPOSIO_API_KEY=<your platform key> npx tsx scripts/composio-smoke.ts [appSlug] [searchQuery]
 *
 *   # after you click the OAuth link, poll the connection until it goes ACTIVE
 *   COMPOSIO_API_KEY=<your platform key> npx tsx scripts/composio-smoke.ts poll <connectionId>
 *
 *   # run any tool you found via search (read-only ones are safest to test)
 *   COMPOSIO_API_KEY=<your platform key> npx tsx scripts/composio-smoke.ts exec <TOOL_SLUG> '<json args>'
 *
 * A successful run also seals the key for your real crew (default agent), so
 * after this you can just talk to Brigade in the TUI.
 */
import { makeComposioTool } from "../src/agents/tools/composio-tool.js";

const tool = makeComposioTool(); // default agent

async function run(label: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const r = await tool.execute("smoke", args as never);
	const d = ((r as { details?: unknown }).details ?? {}) as Record<string, unknown>;
	console.log(`\n=== ${label} ===`);
	console.log(JSON.stringify(d, null, 2));
	return d;
}

const mode = process.argv[2];

// ---- poll mode: just check a connection's status ----
if (mode === "poll") {
	const cid = process.argv[3];
	if (!cid) {
		console.error("usage: npx tsx scripts/composio-smoke.ts poll <connectionId>");
		process.exit(1);
	}
	await run(`status ${cid}`, { action: "status", connectionId: cid });
	process.exit(0);
}

// ---- exec mode: run a specific tool slug ----
if (mode === "exec") {
	const slug = process.argv[3];
	const argsJson = process.argv[4] ?? "{}";
	if (!slug) {
		console.error("usage: npx tsx scripts/composio-smoke.ts exec <TOOL_SLUG> '<json args>'");
		process.exit(1);
	}
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(argsJson) as Record<string, unknown>;
	} catch {
		console.error(`Could not parse arguments JSON: ${argsJson}`);
		process.exit(1);
	}
	await run(`execute ${slug}`, { action: "execute", tool: slug, arguments: parsed });
	process.exit(0);
}

// ---- full flow ----
const key = process.env.COMPOSIO_API_KEY?.trim();
if (!key) {
	console.error(
		"Set COMPOSIO_API_KEY to your Composio API key (dashboard.composio.dev/settings), then re-run.",
	);
	process.exit(1);
}
const app = mode?.trim() || "gmail";
const query = process.argv[3]?.trim() || "send an email";

const k = await run("1. set-key (verify + seal)", { action: "set-key", key });
if (k.ok === false) process.exit(1);

await run(`2. apps (discover catalog, filter "${app}")`, { action: "apps", query: app });

const c = await run(`3. connect ${app}`, { action: "connect", app });
if (c.connectionId) {
	await run("4. status (pending until you click the link)", { action: "status", connectionId: c.connectionId });
	if (c.redirectUrl) {
		console.log(`\n>>> Open this URL to authorize ${app}:\n    ${c.redirectUrl}`);
		console.log(`>>> Then poll:  npx tsx scripts/composio-smoke.ts poll ${c.connectionId}`);
	}
}

await run(`5. search tools for "${query}" in ${app}`, { action: "search", query, app });

console.log("\nDone. (To run a tool once connected, use the 'exec' mode shown at the top of this file.)");
