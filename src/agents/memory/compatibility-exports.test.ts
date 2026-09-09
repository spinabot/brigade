import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

interface CompatibilityModule {
	legacy: string;
	canonical: string;
	overrides?: readonly string[];
}

// Explicit targets keep a mistaken re-export from defining its own expectation.
const compatibilityModules: readonly CompatibilityModule[] = [
	{ legacy: "contradiction", canonical: "lifecycle/contradiction" },
	{ legacy: "curator", canonical: "lifecycle/curator" },
	{ legacy: "decay", canonical: "lifecycle/decay", overrides: ["runDecayGc"] },
	{ legacy: "dream", canonical: "lifecycle/dream" },
	{ legacy: "embedder-providers", canonical: "embeddings/embedder-providers" },
	{ legacy: "embedder", canonical: "embeddings/embedder" },
	{ legacy: "eval/asr-bench", canonical: "eval/asr-bench", overrides: ["runDefaultAsrBench"] },
	{ legacy: "eval/capabilities", canonical: "eval/capabilities" },
	{ legacy: "eval/gold-export", canonical: "eval/gold-export" },
	{ legacy: "eval/gold-hard", canonical: "eval/gold-hard" },
	{ legacy: "eval/gold-rich", canonical: "eval/gold-rich" },
	{ legacy: "eval/gold-synthetic", canonical: "eval/gold-synthetic" },
	{ legacy: "eval/gold", canonical: "eval/gold" },
	{ legacy: "eval/harness", canonical: "eval/harness" },
	{ legacy: "eval/metrics", canonical: "eval/metrics" },
	{ legacy: "event-log", canonical: "store/event-log" },
	{ legacy: "governance", canonical: "governance/governance" },
	{ legacy: "graph-export", canonical: "graph/graph-export" },
	{ legacy: "graph-recall", canonical: "retrieval/graph-recall" },
	{ legacy: "graph", canonical: "graph/graph" },
	{ legacy: "hybrid", canonical: "retrieval/hybrid" },
	{ legacy: "json-scan", canonical: "extraction/json-scan" },
	{ legacy: "links", canonical: "graph/links" },
	{ legacy: "maintenance", canonical: "lifecycle/maintenance", overrides: ["runMemoryMaintenance"] },
	{ legacy: "memory-mcp-server", canonical: "transports/mcp/memory-mcp-server" },
	{ legacy: "memory-mcp", canonical: "transports/mcp/memory-mcp" },
	{ legacy: "query", canonical: "retrieval/query" },
	{ legacy: "records", canonical: "store/records", overrides: ["FactStore"] },
	{ legacy: "reembed", canonical: "embeddings/reembed", overrides: ["reembedPending"] },
	{ legacy: "relationship-extract", canonical: "extraction/relationship-extract" },
	{ legacy: "rerank", canonical: "retrieval/rerank" },
	{ legacy: "scoring", canonical: "retrieval/scoring" },
	{ legacy: "self-improve", canonical: "lifecycle/self-improve" },
	{ legacy: "self-review", canonical: "lifecycle/self-review" },
	{ legacy: "storage", canonical: "store/storage" },
	{ legacy: "tideline", canonical: "api/tideline", overrides: ["Tideline"] },
	{ legacy: "vault", canonical: "exports/vault" },
	{ legacy: "write-gate", canonical: "governance/write-gate" },
];

// These modules implement Brigade integration rather than compatibility aliases.
// Adding any other source requires an explicit compatibility or host classification.
const hostModules = new Set([
	"auto-recall", "behavior-review", "consolidate", "extract", "host-ports", "index", "plugin-runtime",
]);
const memoryRoot = fileURLToPath(new URL("./", import.meta.url));

function implementationModules(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) return implementationModules(absolute);
		if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
		return [path.relative(memoryRoot, absolute).split(path.sep).join("/").replace(/\.ts$/, "")];
	});
}

describe("retained memory compatibility exports", () => {
	let stateDir: string;
	let previousStateDir: string | undefined;
	before(() => {
		previousStateDir = process.env.BRIGADE_STATE_DIR;
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-compatibility-exports-"));
		process.env.BRIGADE_STATE_DIR = stateDir;
	});
	after(() => {
		if (previousStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = previousStateDir;
		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("classifies every compatibility source, including evaluation modules", () => {
		const sources = implementationModules(memoryRoot);
		for (const host of hostModules) assert.ok(sources.includes(host), `stale host exclusion: ${host}`);
		const expected = compatibilityModules.map(({ legacy }) => legacy);
		assert.equal(new Set(expected).size, expected.length, "each compatibility source has exactly one target");
		assert.deepEqual(sources.filter((source) => !hostModules.has(source)).sort(), [...expected].sort());
	});

	for (const { legacy, canonical, overrides = [] } of compatibilityModules) {
		it(`${legacy} preserves the exports of ${canonical}`, async () => {
			const [compatibility, engine]: Record<string, unknown>[] = await Promise.all([
				import(new URL(`./${legacy}.js`, import.meta.url).href),
				import(new URL(`../../tideline/${canonical}.js`, import.meta.url).href),
			]);
			assert.ok(compatibility);
			assert.ok(engine);
			assert.deepEqual(Object.keys(compatibility).sort(), Object.keys(engine).sort(), "named exports must remain complete");
			for (const override of overrides) {
				assert.equal(typeof compatibility[override], "function", `${legacy}.${override} remains a host binding`);
				assert.equal(typeof engine[override], "function");
				assert.notEqual(compatibility[override], engine[override], `${legacy}.${override} must not lose its host binding`);
			}
			for (const name of Object.keys(engine)) {
				if (!overrides.includes(name)) {
					assert.equal(compatibility[name], engine[name], `${legacy}.${name} must share canonical identity`);
				}
			}
		});
	}
});
