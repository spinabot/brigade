# brigade-tideline

A model-agnostic **long-term memory engine** for agents — the framework that backs Brigade's memory, packaged behind one facade.

- **Hybrid recall** — BM25-primary with a model-free HRR vector *recovery* lane (no embedding model required to run; a learned embedder is an optional upgrade, not a dependency).
- **Bi-temporal decay + trust modulation** — recency/usage decay and source-trust weighting fold into one effective score.
- **Provenance write-gate** — an untrusted source (tool output, retrieved document, distilled extraction) can't author or supersede the operator's identity/preferences/corrections; poisoning writes are rejected.
- **Per-origin isolation** — owner facts and per-channel/peer facts are scoped so one principal's memory never leaks into another's recall.
- **Typed link graph** — `supersedes` / `transition` / `corrects` / `relates` / `derived_from` / `supports` / `contradicts` edges, with a graph-recall walk.
- **Reflect / consolidate / relate** — a nightly pass confirms repeated beliefs, merges duplicates, persists `relates` association edges, and evicts decayed noise.
- **Evaluation harness** (`brigade-tideline/eval`) — deterministic gold sets, recall@k / MRR / nDCG@k with bootstrap CIs, baseline + competitor capabilities for head-to-head, and a privacy-safe export→approve pipeline for measuring on your own data.

## Install

```
npm install brigade-tideline
```

## Quick start

```ts
import { Tideline } from "brigade-tideline";

const memory = Tideline.open("/path/to/workspace");

// Write (the write-gate + dedup apply).
memory.add({ content: "I keep a strict vegetarian diet.", segment: "preference" });

// Recall (hybrid BM25 + vector), ranked.
const hits = memory.recall("what do I eat");

// A budgeted, origin-scoped block ready to drop into a prompt.
const block = memory.context("dietary restrictions", { maxChars: 800 });
```

### Adapter SPI

`Tideline.open(dir, opts)` takes **four optional adapters** (`clock`, `threatScan`, `embedder`, `llm`); the **`StorageAdapter`** is injected via `Tideline.over(store, opts)` instead (the bundled `FactStore` is `open`'s default backend):

| Adapter | Injected via | Purpose | v1 default |
|---|---|---|---|
| `StorageAdapter` | `.over(store)` | persistence backend | bundled `FactStore` (filesystem JSONL) |
| `ClockAdapter` | `.open`/`.over` opt | injectable time | system clock |
| `ThreatScanAdapter` | `.open`/`.over` opt | recall-time content-safety scan | no-op (markup-escape only) |
| `EmbedderAdapter` | `.open`/`.over` opt | learned-embedder seam — **v1: RESERVED**, recorded but not yet called (recall always uses the bundled HRR lane) | none (model-free HRR) |
| `LlmAdapter` | `.open`/`.over` opt | reflection/synthesis LLM — **v1: RESERVED**, unused | none |

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

This directory is the **in-repo extraction layer**: it freezes the package boundary, the public API, and this manifest, re-exported on top of the implementation in `../agents/memory/*` without modifying it.

**The host coupling is decoupled.** The core (`records.ts` / `FactStore`) used to reach into four Brigade subsystems via scattered `../../` imports; those are now routed through a **single seam module** — `agents/memory/host-ports.ts` — and *every other* re-exported module is already host-import-free. So the entire core reaches outside its own directory through exactly **one file**. Brigade's `host-ports.ts` forwards to the real subsystems (pure indirection — no behavior change, the full suite is unchanged); the four seams it bridges are: the subsystem **logger**, the Convex write-through **cache**, the runtime storage-**mode** probe, and the write-time content **threat-scan** (+ its error).

**Standalone publish = a one-file *seam* swap + a vendor/emit build step (the latter not yet scripted).** The runtime decoupling is a single file: this package ships `host-ports.standalone.ts` — a complete, type-matched, filesystem-only binding (no-op logger, no Convex cache, runtime-mode = filesystem so the convex branches never fire, and a stubbed write-scan). What is NOT yet written is the build script that performs the steps below; until it exists, this is an **in-repo extraction layer**, not a `npm install`-able package. The build (to implement):

1. compiles + **vendors** the core (`records` + its host-clean siblings) into the package,
2. **swaps** `host-ports.ts` → `host-ports.standalone.ts` (drop-in: identical export names + signatures),
3. emits this manifest + README beside the compiled output and rewrites the vendored specifiers,
4. *(optional, for exact write-scan parity)* vendors the pure `security/injection-patterns.ts` and re-exports its `scanForThreats` / `MemoryThreatError` from the standalone binding in place of the stubs.

In standalone, the provenance **write-gate** and the recall-time **`ThreatScanAdapter`** remain fully active; only the belt-and-suspenders write-time content scan is stubbed until step 4. None of this changes recall behavior.

## License

MIT.
