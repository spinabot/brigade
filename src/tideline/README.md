# brigade-tideline

A model-agnostic **long-term memory engine** for agents — the framework that backs Brigade's memory, packaged behind one facade.

- **Hybrid recall** — BM25-primary with a model-free HRR vector *recovery* lane (no embedding model required to run; a learned embedder is an optional upgrade, not a dependency).
- **Bi-temporal decay + trust modulation** — recency/usage decay and source-trust weighting fold into one effective score.
- **Provenance write-gate** — an untrusted source (tool output, retrieved document, distilled extraction) can't author or supersede the operator's identity/preferences/corrections; poisoning writes are rejected.
- **Per-origin isolation** — owner facts and per-channel/peer facts are scoped so one principal's memory never leaks into another's recall.
- **Typed link graph** — `supersedes` / `transition` / `corrects` / `relates` / `derived_from` / `supports` / `contradicts` edges, with a graph-recall walk.
- **Reflect / consolidate / relate** — a nightly pass confirms repeated beliefs, merges duplicates, persists `relates` association edges, and evicts decayed noise.
- **Evaluation harness** (`brigade-tideline/eval`) — deterministic gold sets, recall@k / MRR / nDCG@k with bootstrap CIs, baseline + competitor capabilities for head-to-head, and a privacy-safe export→approve pipeline for measuring on your own data.

## Build locally

```
npm run build:tideline
npm run test:tideline-package
```

## Quick start

```ts
import { Tideline } from "brigade-tideline";

const memory = Tideline.open("/path/to/workspace");

// Write (the write-gate + dedup apply).
memory.add({ content: "I keep a strict vegetarian diet.", segment: "preference" });

// Recall using lexical overlap; model-free vectors do not learn synonymy.
const hits = memory.recall("vegetarian diet");

// A budgeted, origin-scoped block ready to drop into a prompt.
const block = memory.context("vegetarian diet", { maxChars: 800 });
```

### Adapter SPI

`Tideline.open(dir, opts)` accepts `TidelineAdapters`; the synchronous
`StorageAdapter` can instead be supplied through `Tideline.over(store, opts)`.
Optional per-instance `hostPorts` supply the legacy store's backend and logger.
Without them, the engine uses local JSONL and no Brigade runtime:

For an asynchronous snapshot backend, await `memory.ready()` before reads or
writes and `memory.flush()` before acknowledging persistence. Both forward to
optional adapter methods and are no-ops for filesystem storage. Brigade's backend
reports pending/failed hydration explicitly and rejects failed flushes; later
readiness/flush calls retry retained work. Pending retries are process-local,
not crash-durable, and fact flushing does not include best-effort audit events.
MCP stdio uses `handleAsync` to enforce these barriers; the synchronous `handle`
method remains for already-ready synchronous consumers.

| Adapter | Injected via | Purpose | v1 default |
|---|---|---|---|
| `StorageAdapter` | `.over(store)` | persistence backend | bundled `FactStore` (filesystem JSONL) |
| `ClockAdapter` | `.open`/`.over` opt | injectable time | system clock |
| `ThreatScanAdapter` | `.open`/`.over` opt | recall-time content-safety scan | no-op (markup-escape only) |
| `EmbedderAdapter` | `.open`/`.over` opt | learned-embedder seam — **v1: RESERVED**, recorded but not yet called (recall always uses the bundled HRR lane) | none (model-free HRR) |
| `LlmAdapter` | `.open`/`.over` opt | reflection/synthesis LLM — **v1: RESERVED**, unused | none |
| `FactStoreHostPorts` | `.open` opt / `new FactStore(dir, { hostPorts })` | optional backend and logger | local filesystem, no-op logger |

```ts
import { Tideline, FactStore } from "brigade-tideline";

const memory = Tideline.over(new FactStore(dir), {
  threatScan: { scan: (content) => myInjectionScanner(content) },
});
```

### Evaluation

```ts
import { FactStore } from "brigade-tideline";
import { seedGold, RICH_GOLD, runRecallEval, hybridRecallCapability } from "brigade-tideline/eval";

const store = new FactStore(tmpDir);
const cases = seedGold(store, RICH_GOLD);
const result = await runRecallEval(hybridRecallCapability(store), cases, { k: 3 });
console.log(result.recallAtK, result.mrr, result.ndcgAtK);
```

Measure on **your own data** (privacy-safe — real facts never leave the machine):

```ts
import { FactStore } from "brigade-tideline";
import { exportGoldScaffold, writeLocalGoldSpec, loadGoldSpec, seedGold } from "brigade-tideline/eval";

writeLocalGoldSpec("gold.local.json", exportGoldScaffold(new FactStore(realDir)));
// → review gold.local.json: rewrite each auto-query into a realistic paraphrase,
//   set its taxonomy category, then set "approved": true.
const cases = seedGold(new FactStore(tmp), loadGoldSpec("gold.local.json"));
```

`loadGoldSpec` **refuses** an un-approved scaffold (its auto-queries self-match their own facts and would inflate recall) — the human-approval rewrite is what makes it a real measurement.

### Advanced (`brigade-tideline/advanced`)

The power-user surface the facade is built from: the lifecycle passes (`runDream`, `runDecayGc`, `effectiveScore`), the typed link graph (`buildGraph` / `neighbors` / `spread` / `synonymyEdges` / `resolveEntities`), governance (`purge` / `applyRetention` / `inspect` / `exportMemory`), the provenance write-gate (`evaluateWriteGate` + the trust/segment helpers), the transparency event log (`MemoryEventLog`), and the human-gated self-improving loop (`proposeFromTelemetry` → `gateOnEval` → `approve` → `applyProposal` → `revertProposal`). `WriteGateError` (thrown by `Tideline.add`) is on the **main** entry too, so callers can catch it without reaching into `/advanced`.

## Packaging status

### Source layout

```text
src/tideline/
  index.ts / advanced.ts / eval.ts   Stable public package entries
  api/                              Tideline facade and adapter API
  store/                            Records, JSONL storage and event history
  ports/                            Optional backend and logging contracts
  retrieval/                        Querying, scoring, hybrid and graph recall
  graph/                            Typed links, graph operations and projections
  embeddings/                       Embedders, providers and re-embedding
  extraction/                       Parsing, relationship extraction and LLM callback
  lifecycle/                        Decay, curation, reflection and maintenance
  governance/                       Write gates, retention, inspection and purge
  exports/                          Filesystem vault projection
  transports/mcp/                   MCP tools, JSON-RPC server and stdio transport
  eval/                             Evaluation harness, metrics and fixtures
  tests/                            Public API, isolation, boundary and end-to-end tests
```

Unit tests live beside their implementation. Cross-cutting tests live in
`tests/`; Brigade host integration tests stay in `src/agents/memory/` and the
actual CLI test stays in `src/cli/commands/`.

Internal modules import their specific dependencies, not the public entry
barrels. Core modules do not import MCP transport, evaluation or test code.
Transport and evaluation depend on the engine, and Brigade supplies host ports
from outside it. Boundary tests enforce these rules for runtime and type-only
imports. These are ownership boundaries, not separate services or an assertion
that the legacy dependency graph is acyclic.

### Build and compatibility

This directory owns the canonical reusable engine and core tests. Brigade's
runtime integration imports it; old paths in `src/agents/memory/` are compatibility
exports or thin host adapters, not another engine. Agent sessions, scheduling,
auto-recall and extension registration stay in Brigade.

`npm run build:tideline` builds `dist/packages/tideline/` with three public entries
(`.`, `/advanced`, `/eval`), strict declarations and shared ESM chunks. This is
separate from Brigade's normal `dist/tideline/` compiler output. The build rejects
runtime and type-only dependencies outside the engine, except three reviewed
shared helpers: threat scanning, prompt sanitization and atomic rename.

There is no mandatory Convex package, host-module swap, or disabled write scanner.
Brigade supplies its optional cache-backed storage through `FactStoreHostPorts`.
`npm run test:tideline-package` checks an isolated consumer, cross-entry module
identity, origin isolation, scanner parity, persistence, existing evaluation
fixtures and declaration resolution. Building locally does not publish a package.

## Scope of this refactor

The existing primitives are facts/origins, source trust and write gates, ranked
retrieval, typed links, lifecycle/retention, event history, embeddings and evals.
Moving ownership preserves their behavior; it does not improve benchmarks by
itself. Character-budgeted context is not a token or billing savings measurement.

The bundled store still uses synchronous JSONL read/modify/write. Replaceable
legacy ports do not provide distributed transactions, tenant authority, complete
influence capture, immediate withdrawal barriers or certified enterprise storage
adapters. The standalone memory package and Brigade workspace use the same
implementation and retain these same legacy limitations.

## License

MIT.
