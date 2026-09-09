# 🌊 Tideline — Brigade's long-term memory engine

Tideline is the long-term memory framework that backs Brigade. It is a
**model-agnostic memory engine** — it works with zero embedding model, learns from
one if you give it, and builds independently as `brigade-tideline` from the same
implementation used by Brigade.

Where a transcript is what an agent *just said*, Tideline is what an agent *knows*:
durable facts about you and your work, written under a trust gate, recalled by
meaning, decayed when stale, and reconciled over time.

> TL;DR — JSONL-backed facts with origin scoping, a provenance write gate,
> hybrid keyword+vector recall that needs no model to run, bi-temporal decay folded
> into one score, a typed link graph, and a nightly reflect/consolidate pass. One
> `Tideline` facade; a small adapter SPI underneath.

---

## Source ownership

`src/tideline/` owns the reusable memory implementation and its core tests.
`src/agents/memory/` owns Brigade's extraction sessions, behavioral review,
auto-recall, extension binding and optional storage integration. Old module paths
are compatibility re-exports (or thin host adapters), not a second engine.

The engine is grouped into `api`, `store`, `ports`, `retrieval`, `graph`,
`embeddings`, `extraction`, `lifecycle`, `governance`, `exports`, `transports/mcp`
and `eval`. Unit tests sit with their modules; cross-cutting boundary and
end-to-end tests live in `tests`. The [source map](../src/tideline/README.md#source-layout)
describes each group's responsibility. The three public package entries and
Brigade's compatibility imports stay stable across this internal reorganization.

The current primitives are records and origins, source trust/write gates,
retrieval scores, typed links, lifecycle/retention, event history, injectable
embeddings and evaluation cases. The optional `FactStoreHostPorts` inject a
backend and logger per store; no Convex service is required by Tideline.

The legacy synchronous `StorageAdapter` and JSONL default are not a distributed
database abstraction. No new benchmark, compression or billing improvement is
claimed by moving the code.

### Asynchronous backend readiness and durability

Filesystem calls remain synchronous. When using Brigade's optional asynchronous
backend, await `store.ready()` (or `memory.ready()`) before the first operation,
then await `store.flush()` (or `memory.flush()`) before reporting a mutation as
durable. Both methods are no-ops for the default filesystem implementation.

```ts
await memory.ready();
memory.add({ content: "The staging window starts Friday.", segment: "project" });
await memory.flush();
```

A cold synchronous read now reports pending hydration instead of pretending the
store is empty. Failed hydration is explicit; a later `ready()` retries a bounded
fetch cycle. Failed writes remain pending and make `flush()` reject; a later flush
retries them without replaying a superseded update or delete. Retry state is
process-local, not a crash-durable write-ahead log. Fact flushing does not make
best-effort event appends atomic with facts or establish distributed cache coherence.

Brigade tools, extraction, auto-recall and scheduled maintenance use these
barriers. MCP stdio uses the asynchronous request handler and drains pending
requests before exit. Custom asynchronous MCP transports must use `handleAsync`,
not the compatibility synchronous `handle` method.

---

## Why it exists

Most "agent memory" is a vector store with a similarity search bolted on. That
breaks in three ways Tideline is built to survive:

1. **Poisoning.** A web page or a tool result should never be able to rewrite "the
   operator is vegetarian." Tideline's **write-gate** refuses untrusted sources from
   authoring or superseding protected facts.
2. **Privacy bleed.** In a multi-channel crew, a WhatsApp peer's facts must never
   surface in the operator's recall. Tideline scopes every record by **origin**.
3. **Staleness & contradiction.** Beliefs change. Tideline **decays** unused facts,
   detects **contradictions**, and **consolidates** repeated beliefs instead of
   piling up duplicates.

And it does all of this **without requiring an embedding model** — recall runs on a
BM25-primary lane with a model-free vector *recovery* lane, so it works offline and
air-gapped out of the box. A learned embedder is an optional upgrade, never a
dependency.

---

## The record model

Every memory is a structured record, not a raw chunk:

| Field | Meaning |
|---|---|
| `content` | the fact, in natural language |
| `segment` | `identity` · `preference` · `correction` · `relationship` · `project` · `knowledge` · `context` |
| `tier` | `short` · `long` · `permanent` (permanent never decays) |
| `importance` | 0–1, modulates decay and ranking |
| `origin` | `owner`, or `channel + conversationId + sessionKey` |
| `lifecycle` | `active` → `archived` → `pruned` |
| `links` | typed edges to other records (see the graph below) |

Segment defaults (`SEGMENT_DEFAULTS`) seed sensible tier/importance per segment —
`identity` and `correction` are protected and long-lived; `context` is short.

---

## End to end: the three flows

### 1. Write — gated and deduped

```
add(fact) ──▶ content scan + write-gate ──▶ same-origin dedup ──▶ FactStore (JSONL)
              │
              └─ rejects an UNTRUSTED source (tool_output, retrieved_document,
                 extraction, compaction) trying to author/supersede a PROTECTED
                 segment (identity/preference/correction) → throws WriteGateError
```

The **write-gate** (`evaluateWriteGate`) classifies the *source* (trusted:
`user_instruction`, `owner_message`; untrusted: everything else) and the *target
segment*. Untrusted writes into protected segments are blocked; untrusted writes
elsewhere are **confined** (kept, but not allowed to overwrite trusted beliefs).
Dedup is **same-origin only** — it never merges across principals.

### 2. Recall — hybrid, ranked, origin-scoped, budgeted

```
origin + lifecycle filter ─▶ authorized candidates ─▶ BM25-primary + vector recovery
                                                              │
                                   optional graph recall ◀─────┘
                                              │
                                  ranked hits ─▶ context() budget block
```

- **Hybrid lane** (`recallHybrid`) runs BM25 as the primary signal and a **model-free
  HRR** vector lane as recovery. HRR captures lexical/morphological overlap, not
  learned synonymy. Bundled bag-of-words embedders remove question scaffolding
  from recall queries to avoid function-word-only matches; learned embedders keep
  complete queries. Stored document vectors are unchanged. A learned embedder can
  upgrade the vector lane.
- **Graph recall** (`recallWithGraph`) expands hits along typed links, so recalling
  one fact pulls in what it `supports` / `relates` to / `supersedes`.
- **`effectiveScore`** folds bi-temporal **decay** (recency + usage) and
  **source-trust** weighting into a single ranking number.
- Store retrieval filters candidates by the **current call's origin before
  ranking**. Low-level scorers and graph functions require their caller to supply
  authorized candidates. `context()` produces a character-budgeted block, not a
  provider-token or billing measurement.

### 3. Maintain — decay, dream, reconcile

- **Decay GC** (`runDecayGc`) archives then prunes neglected facts; `permanent` is
  immune, confirmed facts resist eviction.
- **Dream** (`runDream`) is the nightly reflect/consolidate/relate pass: it confirms
  repeated beliefs, merges duplicates, writes `relates` association edges, and evicts
  decayed noise.
- **Contradiction detection** (`findContradictions`) surfaces facts that disagree so
  a correction can supersede the stale one.

---

## The typed link graph

Facts aren't an undifferentiated bag — they're a graph with **typed edges**:

`supersedes` · `transition` · `corrects` · `relates` · `derived_from` · `supports` ·
`contradicts`

This is what lets memory *evolve*: a correction `supersedes` the old belief, a
project fact `supports` a preference, an entity rename is a `transition`. The graph
powers graph-recall, contradiction handling, and the **Memory Graph dashboard
export** (`exportMemoryGraph` → nodes, typed edges, topic clusters via deterministic
community detection, and headline stats).

---

## The facade & adapter SPI

Everything above is reached through one object:

```ts
import { Tideline } from "brigade-tideline";

const memory = Tideline.open("/path/to/workspace");

memory.add({ content: "I keep a strict vegetarian diet.", segment: "preference" });
const hits  = memory.recall("vegetarian diet");
const block = memory.context("vegetarian diet", { maxChars: 800 });
```

Facade verbs: **`add`**, **`recall`** / `search`, **`explain`** (why a fact ranked),
**`context`** (budgeted prompt block), **`feedback`** (reinforce/penalize), and the
governance verbs **`purge`** / **`inspect`** / **`export`**.

Tideline takes a small **adapter SPI** so you can host it your way:

| Adapter | Injected via | Purpose | v1 default |
|---|---|---|---|
| `StorageAdapter` | `Tideline.over(store)` | persistence backend | bundled `FactStore` (JSONL) |
| `ClockAdapter` | `open`/`over` opt | injectable time | system clock |
| `ThreatScanAdapter` | `open`/`over` opt | recall-time content-safety scan | no-op (escape only) |
| `EmbedderAdapter` | `open`/`over` opt | learned-embedder seam — **v1: RESERVED** | model-free HRR |
| `LlmAdapter` | `open`/`over` opt | reflection/synthesis LLM — **v1: RESERVED** | none |

```ts
import { Tideline, FactStore } from "brigade-tideline";

const memory = Tideline.over(new FactStore(dir), {
  threatScan: { scan: (content) => myInjectionScanner(content) },
});
```

The power-user surface (`brigade-tideline/advanced`) exposes the passes directly —
`runDream`, `runDecayGc`, `effectiveScore`, the link graph (`buildGraph` /
`neighbors` / `spread`), governance (`purge` / `applyRetention` / `inspect` /
`exportMemory`), the write-gate (`evaluateWriteGate`), the transparency
`MemoryEventLog`, and the human-gated self-improving loop.

---

## Governance, transparency & self-improvement

- **Governance** — `purge` (cascade delete with link cleanup), `applyRetention`
  (policy-driven eviction), `inspect` (provenance of a single fact), `exportMemory`.
  Brigade surfaces these owner-only through the `manage_memory` tool (including
  crypto-shred).
- **Transparency** — `MemoryEventLog` provides best-effort, append-only history
  for supported memory transitions. It helps explain recorded changes, but is
  not a complete or atomic audit trail: event writes can fail independently of facts.
- **Self-improving loop** — a *human-gated* cycle: `proposeFromTelemetry` →
  `gateOnEval` (must beat the eval bar) → `approve` → `applyProposal` →
  `revertProposal`. No change to recall behavior ships without passing evaluation and
  a human approval.

---

## Measuring it (the eval harness)

`brigade-tideline/eval` is a deterministic evaluation harness — gold sets,
**recall@k / MRR / nDCG@k** with bootstrap confidence intervals, and baseline +
competitor capabilities for head-to-head comparison.

```ts
import { FactStore } from "brigade-tideline";
import { seedGold, RICH_GOLD, runRecallEval, hybridRecallCapability } from "brigade-tideline/eval";

const store  = new FactStore(tmpDir);
const cases  = seedGold(store, RICH_GOLD);
const result = await runRecallEval(hybridRecallCapability(store), cases, { k: 3 });
console.log(result.recallAtK, result.mrr, result.ndcgAtK);
```

You can also measure on **your own data** without it leaving the machine: export a
gold scaffold from your real facts, rewrite each auto-query into a realistic
paraphrase, mark it `approved`, and run. `loadGoldSpec` **refuses** an un-approved
scaffold — the human rewrite is what makes it an honest measurement, not a
self-matching inflation.

Run Brigade's bundled benchmarks with `npm run bench`.

---

## How Brigade uses Tideline

- **Tools:** `write_memory` (gated add), `recall_memory` / `read_memory` (hybrid
  search across facts + `MEMORY.md` / `memory/*.md`), `manage_memory` (owner-only
  governance: dream, shred, inspect, export, retention).
- **Auto-recall:** before each turn Brigade injects an origin-matched, budgeted
  context block — and **fails closed** for unknown non-owner peers, so operator
  memory never leaks into a stranger's session.
- **Backend:** the default is a filesystem `FactStore` (synchronous JSONL
  read/modify/write, intended for legacy single-operator use). Brigade's optional
  Convex integration supplies per-instance host ports; it is not imported by the
  standalone engine.

---

## Packaging status

Run `npm run build:tideline` to create `dist/packages/tideline/`, then
`node scripts/test-tideline-package.mjs` to check it in an isolated temporary
consumer. `npm run test:tideline-package` performs both operations.

The build checks runtime and type-only dependency closures, emits strict
declarations and shares ESM chunks across the three public entries. There is no
host-module replacement or disabled write scanner. The only allowed shared source
helpers outside Tideline are threat patterns, prompt sanitization and atomic
rename; they do not import the Brigade runtime.

Building is not publishing. The checks cover package behavior and independence;
enterprise storage guarantees require separate conformance and failure tests.
The standalone output is separate from Brigade's normal `dist/tideline/` compile
output, so either build can run without replacing the other's engine files.

---

## See also

- Package manifest & quick reference: [`src/tideline/README.md`](../src/tideline/README.md)
- Public API surface: [`src/tideline/index.ts`](../src/tideline/index.ts) ·
  advanced: [`src/tideline/advanced.ts`](../src/tideline/advanced.ts)
- Engine implementation: [`src/tideline/`](../src/tideline/)
- Brigade integration and compatibility: [`src/agents/memory/`](../src/agents/memory/)
- Memory in the product: [README → Features → Memory](../README.md#-memory)

_License: MIT._
