# Jarvis sub-project C — Recall engine — design

**Date:** 2026-07-24
**Status:** Design approved (brainstorming). Plan to follow.
**Type:** Sub-project spec (one `spec → plan → implementation` cycle under the [meta spec](2026-07-23-jarvis-second-brain-meta-spec.md)).

## Where C sits

Sub-project **C** of the [Jarvis second-brain meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — the recall engine that **finds the slice (deterministic, free) so the model can answer from it (bounded)**. It depends on A (Wave Vault foundation, built and merged) and B (dossier & records, built and merged). Per the meta spec's contract-first build order `G → F → A/B → C → D → E`, C is the piece that replaces F's Plan-2 recall **shim** (`pkg/jarvisrecall`, which recalls over live SQLite objects) with real recall over the vault graph, behind the same `JarvisConverseChunk` protocol.

This spec assumes the [Jarvis second-brain design](2026-07-22-jarvis-second-brain-design.md)'s "Recall — agentic graph traversal" and "Learning store" sections, A's [design](2026-07-23-jarvis-a-wave-vault-design.md) and its implemented `pkg/wavevault` `Retriever`, B's [design](2026-07-24-jarvis-b-dossier-design.md) and its typed `Dossier`/`Decision` model, and the meta spec's [cross-cutting invariants](2026-07-23-jarvis-second-brain-meta-spec.md#cross-cutting-invariants). It inherits as hard constraints: invariant 1 (**retrieval is deterministic and free — only synthesis costs tokens**; the model synthesizes, it does not search), invariant 3 (Markdown is canonical; any cache is a rebuildable derived layer), invariant 4 (collection/scope boundary enforced by the retriever's tool set, not a prompt), and invariant 7 (grounding first-class; every claim cites a node; `weak`/`not-found` are rewarded terminals; freshness resolves from the authoritative store at synthesis time).

## Constraints inherited from the real codebase

C is designed against what A/B/F actually ship, not the idealized meta-spec picture. Four facts shape it:

1. **A's `Retriever` already provides every retrieval primitive the meta spec lists.** `pkg/wavevault/read.go`: `Query(Filter)` = structured frontmatter `WHERE` (layer 1), `Search(query)` = full-text substring with snippet (layer 2), `Expand(seeds, {Depth,Fanout})` = bounded breadth-first wikilink walk returning a `Subgraph{Nodes,Edges}` (the traversal primitive), `Read(id)` = a node + body, and every `Node` carries a `ContentHash`. `AllScope()`/`WorkerScope()` are the physical collection boundary (invariant 4). **C is orchestration over A, not new primitives.**
2. **Nothing populates the vault at runtime.** `CreateDossier`/`AppendDecision`/`SetRefs` are referenced only by B's own tests — no dispatch hook, no runtime path writes to the vault. The shim exists precisely because the vault is empty: it recalls over live SQLite objects. Swapping F onto pure-vault recall therefore requires C's cycle to **also wire a minimal writer** (§4), or recall is dead. Recall itself stays a **pure reader**.
3. **A Run reference is a dangling wikilink, resolved live — never copied.** Runs live in SQLite, not the vault. A `[[run-<oid>]]` in a dossier is a real entry in `Node.Links` but is skipped by `Expand` ("dangling links are skipped"). C therefore extracts `run-*` links from the traversed subgraph and resolves each to a `run:<oid>` ORef fetched from `wstore` at synthesis time (invariant 7 freshness) — the same durable-pointer convention D's design rests on. This is the load-bearing distinction from the rejected hybrid model (below).
4. **F is already built and calls `jarvisrecall.Converse`.** F (`wshserver_jarvis.go`) owns the `JarvisConvo` WaveObj, multi-turn context, persistence, and scope resolution; it delegates retrieval+synthesis to `jarvisrecall.Converse(ctx, scope, priorTurns, prompt, emit)`. F deferred **model tiering** — one capable model via `consult.Run`. C swaps the *internals* of `Converse` (SQLite scan → vault traversal) and keeps its signature, so F is barely touched.

## Design decisions

Settled in brainstorming:

- **Pure-vault recall (the graph is vault-only; leaf values resolve live), and F swaps onto it this cycle.** The graph C traverses is the vault (`memory/` · `tasks/` · `decisions/`). Runs/Radar are **not** first-class retrieval sources (that was the shim's hybrid model). A Run enters a recall only when a vault node references it (`[[run-<oid>]]`) or the user explicitly attaches it, and then its live status/evidence resolve from `wstore`. SQLite stays authoritative for Runs; the vault is the second-brain layer over them. This is the meta spec's design (invariant 7) made literal.
- **C's cycle also wires a thin `dispatch → dossier` writer, so the swap is live and useful.** Because nothing populates the vault (constraint 2), C's cycle includes a minimal capture writer (`pkg/jarviscapture`) that creates a real dossier at Run dispatch, referencing the Run. New work is recallable immediately; recall stays a pure reader. Historical backfill is an optional, decoupled one-shot — **not** built, **not** the feeding mechanism.
- **Deterministic seed selection + a single synthesis (no model-in-the-loop traversal in v1).** The north-star is a cheap model that picks seeds and may request re-expansions; but F deferred tiering (only a capable model exists). Running the agentic loop on the capable model is against the cost model over a sparse v1 vault, so v1 uses **deterministic** seed selection (regex/keyword query analysis → ranked layer-1/2 hits → top-k seeds → one `Expand` → one synthesis). The agentic re-expansion loop is deferred with tiering (§Deferred).
- **The cache-tier learning store is deferred.** Retrieval is deterministic and free; the only cost is one synthesis per question. A materialized cache pays off only with repeated identical questions over a populated vault — no evidence of that yet, and it adds a keyed store + content-hash invalidation. YAGNI for the first C cycle (§Deferred).

## What C delivers

1. **A pure-vault recall pipeline** — deterministic query analysis → layer-1 `Query` + layer-2 `Search` → seed ranking → bounded `Expand` → run-ref resolution from `wstore` → one grounded synthesis (§1). Split so the deterministic part is a pure, fixture-testable function separate from the mockable model call.
2. **Grounding, freshness, and terminals** — one grounding card per assembled source (vault node or resolved Run); vault nodes are `fresh`, resolved Runs carry live status, unresolvable run-refs are surfaced as `unavailable` (not hidden); `answered`/`weak`/`notfound` terminals (§2).
3. **Per-caller scope enforcement** — interactive callers get `AllScope`; a worker retriever gets `WorkerScope` and physically cannot read `tasks/` (§3). The worker path is exposed but has no wired consumer in v1.
4. **A thin `dispatch → dossier` capture writer** — `pkg/jarviscapture.CaptureRunDispatch`, hooked into `CreateRunCommand`, non-fatal (§4).
5. **The F swap** — `jarvisrecall.Converse` retrieval rewritten to the vault pipeline behind the unchanged `JarvisConverseChunk` protocol; F's Go/FE code untouched (§5).

## What C deliberately does NOT do

- **No model-in-the-loop traversal** (agentic seed-picking / re-expansion) — deterministic seeds + one synthesis in v1; the agentic loop is deferred with model tiering (§Deferred, `docs/deferred.md`).
- **No cache-tier learning store** — deferred (§Deferred, `docs/deferred.md`).
- **No semantic / embedding retrieval** (layer 3) — v2 per the meta spec.
- **No historical backfill** — seeding the vault from existing SQLite objects is an optional, decoupled one-shot, not built and not the feeding mechanism. Manufacturing canonical Markdown from transient objects would brush the "no copying Run evidence into Markdown" non-goal.
- **No hybrid SQLite retrieval** — Runs/Radar are not first-class sources; they enter only via vault references or explicit attachment, resolved live (the shim's SQLite-scan retrieval is removed).
- **No knowledge-slow promotion** — human-gated promotion into `memory/**` lives at the memory boundary, not in recall (meta spec).
- **No new WaveObj type, no migration, no wire/RPC surface change, no `task generate`** — C is in-process Go consumed by F, like A and B. The vault is files; capture writes files.

## Architecture

Two packages, both consumed by F's `wshserver`:

- **`pkg/jarvisrecall` (rewrite)** — C's read engine. Retrieval internals move from "scan `wstore` Runs/Radar + `memvault`" to "traverse the vault via A's `Retriever` + resolve referenced Runs from `wstore`." The reusable shell stays: `Converse` (stream orchestration), `buildCards`, `buildPrompt`, `selectTerminal`/`countCitations`, `synthesize` (+ `SetSynthesizeForTest`), `priorContext`. Stays a **pure reader** of the vault. Proposed files:

| File | Responsibility |
|---|---|
| `recall.go` | `Converse` shell (unchanged signature) + the new vault-backed `assembleSlice` orchestration; run-ref resolution from `wstore`. |
| `retrieve.go` (new) | The deterministic pipeline: query analysis, layer-1 `Query` + layer-2 `Search`, seed ranking, `Expand`. Pure over an `*wavevault.Retriever` — no model, no RPC. |
| `cards.go` | Candidate → grounding-card mapping, prompt assembly, terminal selection (adapted to the vault-node candidate shape). |
| `retrieve_test.go`, `cards_test.go`, `converse_test.go` | Go tests over a fixture vault + fixture Runs in a temp `wstore` (§6). |

- **`pkg/jarviscapture` (new, tiny)** — the thin dispatch writer, deliberately separate so recall stays read-only. `CaptureRunDispatch(ctx, run *waveobj.Run) error`: open the vault (`wavevault.OpenVault`), `jarvisdossier.CreateDossier` from the Run's facts, `SetRefs` the `[[run-<oid>]]`, `Commit`. Files: `capture.go`, `capture_test.go`.

**`wshserver` — modified:** `pkg/wshrpc/wshserver/wshserver_runs.go` gains one non-fatal call in `CreateRunCommand`, right after `AppendRun` (mirroring the adjacent `RecordInvestigation` hook).

## 1. Recall pipeline (deterministic seeds, single synthesis)

The deterministic slice-assembly (`assembleSlice`) is pure over an `*wavevault.Retriever` and a resolved scope; the model runs once, after:

1. **Query analysis (deterministic, no model).** From the natural-language question, regex-extract candidate ticket ids (`[A-Z][A-Z0-9]+-\d+`) and lowercase keyword tokens. Richer intent classification is the deferred cheap-model step.
2. **Layer 1 — `Retriever.Query(Filter{FrontmatterEquals:{"ticket": id}})`** for each extracted ticket id. Exact structured hits.
3. **Layer 2 — `Retriever.Search(query)`** full-text over node bodies. Keyword/phrase hits with snippets.
4. **Seed ranking (deterministic).** Merge layer-1 + layer-2 hits, dedup by node id, rank by (structured match first, then recency via `Node.UpdatedTs`), take **top-k** seeds (PLACEHOLDER `k = 6`).
5. **`Retriever.Expand(seeds, {Depth, Fanout})`** → `Subgraph` (PLACEHOLDER `Depth = 2`, `Fanout = 8`). The walked edges are the citation material.
6. **Run-ref resolution (freshness).** Collect `run-*` from the visited nodes' `Links` (dangling in the vault); resolve each `run:<oid>` via `wstore.DBMustGet[*waveobj.Run]`. A resolved Run becomes a live-freshness source; an unresolvable ref (deleted Run) becomes an `unavailable` source, surfaced not hidden (invariant 7).
7. **Assemble + synthesize.** Build the grounded slice = vault nodes (dossiers/decisions/memory, body as snippet) + resolved Runs, capped at `maxCandidates` (12). Run **one** synthesis (`consult.Run`, the one capable model) over the numbered slice + prior-turn context (F supplies `priorTurns`); stream prose.

Steps 1–6 (`assembleSlice`) are unit-tested against fixture vaults with the model absent; step 7's model call is mocked via `SetSynthesizeForTest`.

## 2. Grounding, freshness, terminals

- **Cards.** One `waveobj.JarvisConvoGroundingCard` per assembled source. `SourceType ∈ {dossier, decision, memory, run}` (a plain string — G renders it without change). `NavTarget`: a resolved Run → `run:<oid>` (navigable to the agent surface); a vault node → `vault:<id>` (G already tolerates non-ORef nav targets, the same handling as the shim's `memory:<id>`; a deep-link to a Tasks surface is v2).
- **Freshness.** Vault nodes are `fresh` (they are the canonical source). Resolved Runs carry their live status. An unresolvable run-ref is `unavailable`.
- **Terminals** (reused, invariant 7). Zero cards → `notfound` (decided without a model call). Cards but no in-range `[n]` citation in the prose → `weak`. At least one citation → `answered`.

## 3. Scope enforcement

Scope maps F's `ScopeArgs{Mode, ProjectPath, AttachedORefs}` to an A `Scope`, honoring the physical collection boundary:

- **Interactive** (F's only v1 caller): `AllScope()` (memory + tasks + decisions). `Mode == "project"` filters the **resolved Runs** by `ProjectPath` (the vault graph is searched broadly; project scoping applies at the live-Run leaf, since dossiers carry no `repo` field — matching B's untouched schema). `Mode == "object"` / attached: resolve the `AttachedORefs` (run/radar via `wstore`, vault id via `Retriever.Read`) and **pin** them into the slice, exempt from the recency truncation (retaining F's attached-fix behavior).
- **Worker**: `WorkerScope()` (memory + decisions — a retriever built from it **physically cannot read `tasks/`**). Exposed via the scope parameter; **no worker-prompt-assembly consumer is wired in v1** (no consumer → not built), but the boundary is testable now.

## 4. The dispatch → dossier capture writer

`pkg/jarviscapture.CaptureRunDispatch(ctx, run *waveobj.Run) error`:

1. `v, err := wavevault.OpenVault(ctx)` (creates/locates the vault).
2. `id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Objective: run.Goal, Ticket: extractTicket(run.Goal), Confidence: "med"})`.
3. `jarvisdossier.SetRefs(v, id, []string{"run-" + run.OID}, hash)` — the canonical layer-1 reference (D reads these back as confirmed edges).
4. `v.Commit(ctx, ...)` — machine-authored, so it commits as `Jarvis`.

Wired into `CreateRunCommand` immediately after `wstore.AppendRun` (line ~218), non-fatal and logged on failure, exactly like the adjacent `reporadar.RecordInvestigation` hook. The Run→facts mapping and commit orchestration live in `jarviscapture`, **not** in B (B's `DossierFacts` stay decoupled from `waveobj.Run`).

**v1 simplification:** one dossier per Run (`Objective = Run.Goal`). The many-Runs-to-one-task grouping (a dossier that spans multiple Runs) needs a task identity Wave does not have; it is D/E territory and deferred. Dossier volume/grouping is a tuning concern recorded with the placeholders.

## 5. The F swap

F's contract and code are untouched; the swap is contained to `jarvisrecall` internals:

- `jarvisrecall.Converse(ctx, scope, priorTurns, prompt, emit)` keeps its signature and its stream shape (`step` → `grounding` → `text` → `terminal`). Its `retrieve()` is replaced by `assembleSlice` over an `*wavevault.Retriever`.
- The `candidate` struct gains vault-node sources; `buildCards`/`buildPrompt` adapt to it. `synthesize`, `priorContext`, `selectTerminal`, `countCitations` are unchanged.
- The shim's SQLite-scan retrieval (`retrieveScoped` over `wstore` Runs/Radar + `memvault`) is removed; `resolveAttached` is retained (attachments still resolve live objects).

Result: G renders exactly as today; the difference is *where the grounding comes from*.

## 6. Testing

Go tests only (backend packages, no jsdom), over a fixture vault (`wavevault.OpenVaultAtForTest` — temp dir + real git) + fixture Runs written to a temp `wstore`, matching A's/B's pattern. Synthesis is mocked (`SetSynthesizeForTest`).

- **layer-1 ticket query** — a dossier with `ticket: ABC-123` is seeded when the question contains `ABC-123`; a question with no id relies on layer 2 only.
- **layer-2 keyword search** — a question keyword present in a decision body surfaces that decision as a seed.
- **seed ranking** — structured (ticket) hits rank above keyword hits; ties break by recency; the slice is capped at top-k.
- **Expand assembly** — seeds expand to their linked decisions within `Depth`/`Fanout`; the traversal path is the citation set.
- **run-ref resolution** — a dossier referencing `[[run-<oid>]]` produces a `run` source resolved from the temp `wstore` with live status; a reference to a **deleted** Run produces an `unavailable` source, surfaced not dropped.
- **terminals** — zero seeds → `notfound` with no model call; a mocked answer with no `[n]` → `weak`; with a valid `[n]` → `answered`.
- **scope boundary** — a `WorkerScope` retriever returns **no** `tasks/` nodes even when a matching dossier exists (invariant 4, enforced by A, asserted here); `project` scope filters resolved Runs by `ProjectPath`.
- **jarviscapture** — `CaptureRunDispatch` creates a dossier whose `refs` contains `[[run-<oid>]]` (`Query{HasLink:"run-<oid>"}` finds it) and the change lands in a commit; human `## Notes` prose is untouched (B's diff-validator).
- **CDP** (`scripts/cdp/scenarios.mjs`, new `jarvis-vault-recall`): inject a seeded vault, ask Jarvis, get a grounded answer citing a dossier/decision; dispatch a Run → a dossier appears. No jsdom (standing decision — wiring verified live).

## Seams C exposes / consumes

- **C ⇄ F (exposes):** `jarvisrecall.Converse(...)` — the unchanged retrieval+synthesis entry F drives; realizes the meta spec's `recall(query, scope) → {segments, citedNodes, terminal, freshness}` + working-step stream.
- **C ⇄ A/B (consumes):** `Vault.Retriever(scope)` → `Query`/`Search`/`Expand`/`Read`; `wavevault.AllScope`/`WorkerScope`; `wavevault.OpenVault`/`Create`/`Commit`; `jarvisdossier.CreateDossier`/`SetRefs`.
- **C ⇄ wstore (consumes):** `DBMustGet[*waveobj.Run]` for live run-ref resolution and attachment pinning.
- **C ⇄ wshserver (exposes):** `jarviscapture.CaptureRunDispatch(ctx, run)` — the non-fatal dispatch hook.
- **C ⇄ D (future):** when D lands, its `EdgesFor(dossierID)` supplies confidence-weighted edges C can weight during traversal; v1 walks all resolved `[[links]]` uniformly (A's `Expand`), which is the meta spec's "C can start with layer-1/2 edges before D exists."

## File-touch map

**Go — rewrite:** `pkg/jarvisrecall/{recall,cards}.go` (+ new `retrieve.go`); retrieval → vault; remove the SQLite-scan path. Tests: `retrieve_test.go` (new), `cards_test.go`/`converse_test.go` (updated).

**Go — new:** `pkg/jarviscapture/{capture.go,capture_test.go}`.

**Go — modified:** `pkg/wshrpc/wshserver/wshserver_runs.go` — one non-fatal `CaptureRunDispatch` call in `CreateRunCommand`.

**CDP:** `scripts/cdp/scenarios.mjs` (+ an inject helper for a seeded vault).

**Docs:** `docs/deferred.md` — the C deferrals (agentic traversal loop, learning store, historical backfill) + PLACEHOLDER tuning (seed-k, Expand depth/fanout, maxCandidates, one-dossier-per-Run grouping). Meta-spec tracking-table C-row link added at C's feature-commit time (avoid mid-plan edits to that shared file, per the A/B/D/F precedent).

## Open risks

- **Dark swap until capture accretes data.** Immediately after the swap the vault holds only dossiers created by new dispatches; questions about pre-existing work return `notfound` until an optional backfill runs. Accepted in brainstorming (the architecture stays honest; new work is recallable). Mitigation: the CDP scenario seeds a vault so the path is provable; the capture hook means the vault grows from first dispatch.
- **One-dossier-per-Run volume.** Every dispatched Run writes a dossier + a commit. At v1 scale (dozens/day) this is acceptable; task-grouping is the documented later lever, not a v1 concern.
- **Dangling run references** (constraint 3): the model rests on `[[run-<oid>]]` being a resolvable pointer, not an `Expand` node. A test asserts resolution via `wstore`; if a future change expects `Expand` to traverse into a Run it breaks silently. Runs are resolved from `wstore`, never copied into the vault.
- **Placeholder tuning** (seed-k, Expand depth/fanout, maxCandidates): fabricated defaults marked PLACEHOLDER in `docs/deferred.md`; harmless for v1 interactive recall (a weak or over-broad slice is a dismissible weak-cited path), to be calibrated against a populated vault.
- **`Search` is substring, index-less** (A's `Retriever.Search`): O(nodes × body) per query. Fine at v1 vault scale (same posture as A's index-less scan); an index is the documented later lever if a populated instance profiles hot.
