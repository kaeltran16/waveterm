# Jarvis sub-project S2 — Semantic consumers (L3 + L4) — design

**Date:** 2026-07-24
**Status:** Design approved (brainstorming). Plan to follow.
**Type:** Sub-project spec (one `spec → plan → implementation` cycle under the [v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md)).

## Where S2 sits

Sub-project **S2** of the [Jarvis second-brain v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md) — the **semantic consumers**: the two thin extensions that light up S1's embedding index. It is the second step of the semantic lane (`S1 → S2 → S3`); S1 (the embedding foundation, `pkg/jarvisembed`) is built and merged, so S2's bottleneck is cleared.

S2 delivers, in one cycle, two additive extensions of shipped v1 engines — **not new subsystems**:

- **L3 (recall)** extends `pkg/jarvisrecall`: a semantic candidate source merged into the deterministic seed set, degrading to L1/L2 when embeddings are off.
- **L4 (attribution)** extends `pkg/jarvisattrib`: a new low-confidence, probation-gated *semantic* edge producer, fired only for under-attributed dossiers, reusing D's probation / self-correction / accept / detach machinery wholesale.

It assumes the [S1 design](2026-07-24-jarvis-s1-embedding-foundation-design.md) (the `Embedder`/`Query` seam, the `ErrEmbeddingsDisabled` degradation contract), the [v1 design](2026-07-22-jarvis-second-brain-design.md) (layer-3 recall, the attribution engine), and the v2 meta spec's [cross-cutting invariants](2026-07-24-jarvis-second-brain-v2-meta-spec.md#cross-cutting-invariants). It inherits as hard constraints: **the model synthesizes, never searches** (v1); **the collection/scope boundary is enforced by the retriever's tool set, not a prompt** (v1 invariant 4); **semantic is opt-in and strictly additive** (v2 invariant 10); **graceful degradation is mandatory — a missing/failing provider degrades, never errors the feature** (v2 invariant 11); **embedding runs only at explicit boundaries, never on a background poll** (v1 invariant 1).

## Constraints inherited from the real codebase

S2 is designed against what S1, C (recall), and D (attribution) actually ship. The load-bearing facts:

1. **S1's query seam is `(*Index).Query(ctx, v *wavevault.Vault, queryText string, k int, scope wavevault.Scope) ([]ScoredChunk, error)`** — it reconciles lazily, embeds `queryText`, runs a scope-filtered cosine KNN over the vault chunk index, and returns `ScoredChunk{NodeID, Collection, SectionHeading, SectionIdx, Snippet, Score}`. Unavailable → `ErrEmbeddingsDisabled`, no network, no DB work.
2. **The S1 index holds only vault Markdown** (tasks/decisions/memory sections). **Runs are not indexed** — a `waveobj.Run` lives in `wstore`, not the vault. This is the single fact that shapes L4: semantic run↔dossier matching must embed run text through a path S1 does not yet expose.
3. **S1 keeps its embedder private.** `Embed` exists on the `Embedder` interface but is not reachable from another package; S1's spec lists `Embed(texts) → vectors` as an exposed seam it did not need to wire (no consumer). S2 is the first consumer, so it wires it.
4. **Recall's seed selection is `selectSeeds(r *wavevault.Retriever, q string) ([]string, error)`** (`pkg/jarvisrecall/retrieve.go`): L1 = structured ticket `r.Query(Filter{FrontmatterEquals})`, L2 = full-text `r.Search(kw)` per keyword; hits merge into a pool ranked structured-first then by recency, capped at `seedTopK`. The result feeds `r.Expand(...)`. This is the exact, and only, insertion point for L3.
5. **Attribution's core is pure.** `assembleEdges(d *jarvisdossier.Dossier, runs []*waveobj.Run, lk edgeLookups, now int64) []AttributedEdge` performs no I/O — all I/O (channel names, commit subjects) is injected via the `edgeLookups` struct. `EdgesFor(ctx, v, dossierID)` is the I/O-aware caller that builds lookups (`gatherLookups`) and applies the human override log (`applyOverrides`). Keeping `assembleEdges` pure is a design invariant of D; S2 must not leak ctx/network into it.
6. **The attribution layers and buckets are fixed constants.** `weightLayer1 = 1.0`, `weightLayer2 = 0.8`, `weightLayer3 = 0.3`; `bucketWeakMax = 0.4` (a confidence `< 0.4` renders as `"weak"`). `Harden` auto-promotes only layer-2 edges past probation; layer-3 requires an explicit human `Accept`. `Detach`/`Accept`/`Backfill` operate generically on any `(dossierID, runORef)` edge via the override log.
7. **A dossier carries its own semantic fingerprint.** `jarvisdossier.Dossier` has `Objective string` + `Acceptance []string` (machine-owned frontmatter), plus `Ticket`, `Refs`, `Created`/`Updated`, `Status`. It has **no** repo/anchor field independent of its run refs — so for an orphan dossier (no refs), the deterministic anchor-repo pre-filter used by `extractLayer3` is empty, and window overlap is the available cheap pre-filter.

## Design decisions

Settled in brainstorming:

- **Both L3 and L4 in one cycle.** Two plan phases, one spec — as the meta spec frames S2. L3 is the demoable win; L4 is the harder producer. Neither is a new package.
- **L3 is a candidate source, not a new engine.** Semantic hits enter the *same* seed pool as full-text (L2) hits, deduped by node id, and **share the `seedTopK` budget** (deterministic structured hits already sort first, so they are not crowded out). The model still only synthesizes.
- **L4 is lazy + gated + cached, dossier-centric.** It fires inside `EdgesFor` only when the deterministic (L1–3) edge set for a dossier is **empty** ("runs only when L1–3 are silent", at the dossier level). A deterministic pre-filter (window overlap + a recent-run cap) shrinks candidate runs before any embedding. Run and dossier fingerprints are embedded through a **persistent, content-hash-keyed cache** so a run embeds once, not per read. The decision is a direct `cosine(dossierVec, runVec) ≥ threshold` — no per-run index KNN.
- **L4 reuses D's lifecycle wholesale.** A semantic edge is `informing`, `weak`, `provenance=semantic`; it never auto-hardens (`Harden` is untouched); it is subject to the same contradicting-ticket self-correction, and to `Accept`/`Detach`/`Backfill` with zero new machinery.
- **jarvisembed grows a keyed embedding cache.** S1's index becomes the home for *all* derived embeddings, including non-vault (run) vectors, in a separate table from the vault chunk index. Still rebuildable, model-tagged, never committed. This is a deliberate, flagged extension of S1's "vault-only" chunk index.
- **Graceful degradation everywhere.** L3 unavailable → seeds identical to today. L4 unavailable → `EdgesFor` identical to today. A provider error mid-call → log + skip, never fail recall or attribution.

## What S2 delivers

1. **L3 semantic recall** — a semantic pass in `selectSeeds`, merged with L1/L2, degrading cleanly (§1).
2. **L4 semantic attribution** — the gated, cached, self-correcting semantic edge producer in `EdgesFor` (§2).
3. **jarvisembed consumer seams** — a public `Embed`, a keyed `EmbedCached` cache (`attrib_vectors` table), and a `Cosine` helper (§3).
4. **The degradation wiring** for both consumers, realizing v2 invariant 11 on top of S1's `ErrEmbeddingsDisabled` signal (§4).

## What S2 deliberately does NOT do

- **No proactive resurfacing.** Event-triggered recall is S3. S2 is question-triggered (L3) and read-triggered (L4) only.
- **No reranking / hybrid score-fusion.** L3 is a plain candidate merge; L4 is a single cosine threshold. Score-fusion tuning is deferred (meta spec S2 out-of-scope).
- **No auto-hardening of a semantic edge.** Semantic edges stay `informing` until a human `Accept` (like layer-3). `Harden` is not modified.
- **No RPC / WaveObj / migration / frontend / `task generate`.** S2 is in-process Go over existing packages. U3 (graph) renders the new low-confidence edges distinctly; that is a separate UX sub-project.
- **No new authoritative store.** The `attrib_vectors` cache is a rebuildable derived artifact; deleting `index.db` and re-reading reproduces every edge (the vault + wstore remain the sources of truth).
- **No indexing of runs as first-class vault content.** Run vectors are a keyed cache, not vault chunks; they are not traversable, not scoped as a collection.

## Architecture

Three packages touched; no new package.

- **`pkg/jarvisrecall` — modified.** L3 pass in `retrieve.go`'s `selectSeeds`; `recall.go`/`retrieve.go` thread `ctx` + `*wavevault.Vault` to the query. New `retrieve_semantic_test.go`.
- **`pkg/jarvisattrib` — modified + one new file.** New `semantic.go` (gate, pre-filter, fingerprints, cosine decision, edge proposal); `edges.go` gains `weightLayer4`/`provSemantic` and layer-4 handling in `confidenceFor`/`provenanceFor`; `lifecycle.go`'s `EdgesFor` runs the semantic pass after the deterministic assembly and re-applies overrides. New `semantic_test.go`.
- **`pkg/jarvisembed` — modified.** `embed.go`/`index.go` expose `Embed`, add `EmbedCached` + the `attrib_vectors` table, and a `Cosine` helper. Extend `index_test.go`.

### 1. L3 — semantic recall

**Insertion point.** `selectSeeds` today returns deterministic seed node ids from L1 (ticket) + L2 (full-text). S2 adds an L3 pass:

1. `ix, _ := jarvisembed.OpenIndex(ctx)`; if `!ix.Available()` → skip L3 (seeds unchanged).
2. `chunks, err := ix.Query(ctx, v, q, kSem, scope)`; on `ErrEmbeddingsDisabled` or any error → skip L3 (log, seeds unchanged).
3. For each `chunk`, `add(chunk.NodeID, structured=false, ts=…)` into the existing pool — semantic hits are treated exactly like full-text (L2) hits: non-structured, deduped by node id, competing by recency for the shared `seedTopK` budget.

**Signature change.** `selectSeeds(r, q)` → `selectSeeds(ctx, v, r, q)` (it needs the vault handle and ctx for `Query`). `assembleSlice`/`retrieve`/`Converse` already hold `ctx` and open the vault (`v`), so the thread-through is mechanical.

**Scope.** Recall's interactive path uses `wavevault.AllScope()` today (`scopeToVault`); the same scope passes to `ix.Query`, so the semantic candidate set respects the identical collection boundary (invariant 4 — the physical scope filter is inside `Query`).

**Degradation.** Flag off / no key / provider error → L3 contributes nothing and `selectSeeds` returns the deterministic result byte-for-byte. Tested by asserting the mock embedder is never called and the seed set is identical.

**PLACEHOLDER tunables:** `kSem` (semantic candidates requested), and whether semantic gets a reserved sub-budget if it ever crowds deterministic hits (decided: shared budget for v1 of S2; revisit only with evidence). Recorded in `docs/deferred.md`.

### 2. L4 — semantic attribution

**Where it fires.** In `EdgesFor`, after the deterministic edges are assembled and overrides applied:

```
det := applyOverrides(assembleEdges(d, runs, lk, now), ov)   // unchanged, pure
if len(det) == 0 && semanticAvailable {                       // dossier-level "L1–3 silent" gate
    sem := proposeSemanticEdges(ctx, ix, d, runs, now)        // gated, pre-filtered, cached
    return applyOverrides(mergeEdges(det, sem), ov), nil      // overrides re-applied so Detach suppresses semantic too
}
return det, nil
```

`assembleEdges` stays pure and untouched; the semantic pass lives entirely in the I/O-aware `EdgesFor` (new `semantic.go`, wired from `lifecycle.go`). `Harden` does **not** call the semantic pass — no embedding cost on the write path.

**Candidate narrowing (pre-filter, zero embeddings).** From all runs, keep those where `windowsOverlap(d, run, now)` holds, then cap to the most-recent `N` (PLACEHOLDER). For an orphan dossier the anchor-repo filter is empty (no refs), so window overlap + recency is the bound. This is the "never compares against every run" guarantee — deterministic, before any network call.

**The semantic decision.**
- Dossier fingerprint: `strings.Join(append([]string{d.Objective}, d.Acceptance...), "\n")` → `ix.EmbedCached(ctx, "dossier:"+d.ID, d.Hash, text)`.
- Run fingerprint: `run.Goal` + the run's commit subjects (reuse `lk.commits(run)`) → `ix.EmbedCached(ctx, "run:"+run.OID, runContentHash, text)`, where `runContentHash` is a hash of the fingerprint text (a Run has no vault `ContentHash`; hashing the embedded text is the invalidation key).
- `jarvisembed.Cosine(dossierVec, runVec) ≥ cosThreshold` (PLACEHOLDER) → propose the edge.

**Self-correction reused.** Before proposing, apply `extractLayer3`'s contradicting-ticket rule: any ticket-shaped token in the run's commit subjects that is not the dossier's ticket vetoes the edge. (Extract the existing check into a shared helper so both L3 and L4 use one implementation.)

**The proposed edge.** `AttributedEdge{DossierID, RunORef:"run:"+run.OID, Layers:[]int{4}, Provenance:provSemantic, Confidence:weightLayer4, State:StateInforming}`. New constants: `weightLayer4 = 0.2` (below `bucketWeakMax`, so `Bucket` returns `"weak"`); `provSemantic = "semantic"`. `confidenceFor`/`provenanceFor` gain a layer-4 case for consistency if a merge ever unions it (in practice layer 4 only appears when 1–3 are absent).

**Machinery reused with zero change:** `applyOverrides` (runs after the merge → `Detach` durably suppresses a semantic edge; `Accept` promotes it to a canonical ref via `hardenEdge`); `Backfill` (returns it as an `informing` proposal); `Harden` (skips it — not layer 2). The human review/accept/detach flow is inherited whole.

**Degradation.** `proposeSemanticEdges` opens the index; `!ix.Available()` or `ErrEmbeddingsDisabled` → returns nil → `EdgesFor` returns the deterministic set, identical to today. A provider error mid-pass → log + return whatever was proposed so far (never fail `EdgesFor`).

**PLACEHOLDER tunables:** candidate cap `N`, cosine `cosThreshold`, `weightLayer4`. Recorded in `docs/deferred.md`; calibrated against a populated, embedded vault.

### 3. jarvisembed additions

1. **`(*Index).Embed(ctx, texts []string) ([][]float32, error)`** — exposes the internal embedder. `!Available()` → `ErrEmbeddingsDisabled`.
2. **Keyed embedding cache.** One new table in the existing `index.db`:
   `attrib_vectors(key text primary key, content_hash text, model text, vec blob)`.
   `(*Index).EmbedCached(ctx, key, contentHash, text string) ([]float32, error)`: if a row for `key` exists with the same `content_hash` **and** current model → decode and return; else `Embed([text])`, store (`key`, `contentHash`, model, encoded vec), return. Model change wipes this table via S1's existing model-tag rebuild path (extended to cover it).
3. **`Cosine(a, b []float32) float32`** — a plain cosine similarity; jarvisembed owns vector math. Vector BLOB encode/decode reuses S1's existing `encodeVec`; a decode counterpart is added if S1 doesn't already have one.

This centralizes all embedding, vector storage, and model-change invalidation in jarvisembed; jarvisattrib stays model-free (it calls `EmbedCached` + `Cosine` + a threshold).

### 4. Degradation contract

Both consumers build on S1's `Available()` / `ErrEmbeddingsDisabled`:

- L3: `!Available()` or error → no semantic seeds; recall identical to v1.
- L4: `!Available()` or error → no semantic edges; attribution identical to v1.
- Neither consumer ever surfaces an embedding failure as a user-facing error. This realizes v2 invariant 11; S1 owns the signal, S2 owns the fallback.

## Seams S2 exposes / consumes

- **S2 ⇄ S1 (consumes):** `jarvisembed.OpenIndex`, `(*Index).Query`, and the new `Embed`/`EmbedCached`/`Cosine` + `attrib_vectors`. `Available()`/`ErrEmbeddingsDisabled` are the degradation contract.
- **L3 ⇄ v1 C (extends):** `selectSeeds` — semantic is an additive candidate source inside the unchanged `recall(query, scope)` contract; `Converse`/`retrieve`/`assembleSlice`/`Expand` are otherwise unchanged.
- **L4 ⇄ v1 D (extends):** `EdgesFor` gains a semantic pass; `assembleEdges` (pure core), the edge store (dossier refs), `applyOverrides`, `Harden`, `Accept`, `Detach`, `Backfill` are unchanged. `EdgesFor`'s read contract (used by U1 Spaces and `wshserver_jarvis.go`) is unchanged in shape — it just returns richer edges when a dossier was previously unattributed and embeddings are on.
- **S2 ⇄ S3 (future):** S3's proactive pre-filter reuses `Query`/`EmbedCached`; no S2 change anticipated.

## File-touch map

**Go — new:** `pkg/jarvisattrib/semantic.go` + `semantic_test.go`; `pkg/jarvisrecall/retrieve_semantic_test.go`.

**Go — modified:**
- `pkg/jarvisrecall/retrieve.go` (L3 in `selectSeeds`, signature widen), `recall.go` (thread `ctx`/`v`).
- `pkg/jarvisattrib/lifecycle.go` (`EdgesFor` semantic pass + override re-apply), `edges.go` (`weightLayer4`, `provSemantic`, layer-4 cases), `extract.go` (extract the contradicting-ticket check into a shared helper).
- `pkg/jarvisembed/index.go` + `embed.go` (`Embed`, `EmbedCached`, `attrib_vectors`, model-change wipe extension, `Cosine`).

**No** RPC / `task generate` / WaveObj / migration / frontend.

**Docs:** `docs/deferred.md` — S2 PLACEHOLDER tunables (`kSem`, candidate cap `N`, `cosThreshold`, `weightLayer4`) + any S2 deferral. The v2 meta-spec S2 tracking-table links (spec + plan) land at **S2 feature-commit time**, not now (the A–F/S1 precedent: avoid mid-plan edits to the shared meta-spec file).

## Testing

Go tests only (backend, no jsdom), over a temp `index.db` (`OpenIndexAtForTest`) + a fixture vault (`OpenVaultAtForTest`) + a mock `Embedder` (`SetEmbedderForTest`, deterministic canned vectors keyed off text). Matches S1/C/D.

**L3:**
- *semantic surfaces a paraphrase* — a query with no keyword/ticket overlap with the target node still selects it as a seed, via a canned vector placed near it.
- *degrade = identity* — flag off (nil embedder): seed set byte-for-byte equal to the deterministic result; mock embedder never called.
- *merge* — semantic and full-text hits dedupe by node id; a structured (ticket) hit still ranks ahead of a semantic hit.

**L4:**
- *proposes for an orphan* — a dossier with no refs + a window-overlapping run whose canned fingerprint is near the dossier's → one edge, `informing`/`weak`/`provenance=semantic`.
- *gate* — a dossier with an L1 ref (deterministic edges non-empty) → the semantic pass never runs (assert mock embedder not called).
- *self-correction* — a candidate run whose commits carry a different concrete ticket → no semantic edge.
- *pre-filter* — a run outside the dossier's window is never embedded (assert embed-call count / cache misses bounded to overlapping runs).
- *cache* — a second `EdgesFor` for the same dossier re-embeds zero runs (assert embed-call count is zero on the second pass).
- *degrade = identity* — flag off → `EdgesFor` equals the deterministic result; mock embedder never called.
- *override interplay* — `Detach` on a semantic edge suppresses it on the next `EdgesFor`; `Accept` promotes it to a canonical ref (then it appears as a confirmed layer-1 edge and the semantic pass no longer fires for that dossier).

**jarvisembed:**
- *EmbedCached hit/miss* — first call embeds and stores; second call with the same `content_hash` returns without embedding; a changed `content_hash` re-embeds.
- *model change wipes the cache* — reconciling/opening after a model change clears `attrib_vectors` (no stale-space vectors).
- *Cosine* — known vectors produce the expected ordering.

**BYOK smoke (opt-in, documented, not CI):** with a real OpenAI-compatible endpoint + key, run a recall that only a paraphrase could answer (L3) and attribute an orphan dossier to a semantically-matching run (L4), end-to-end.

## Open risks

- **L4 relevance quality (the real product risk).** A cosine threshold over short objective/goal text can propose noisy edges. Mitigations: dossier-level gating (only truly unattributed dossiers), window pre-filter, low confidence + `informing` state (never auto-hardened), self-correction, and one-click `Detach`. The threshold is a PLACEHOLDER to calibrate on a populated vault; if noise persists, S3's higher relevance bar and/or a model check is the escalation — out of S2 scope.
- **Read-path latency on the first attribution of an orphan dossier.** The first `EdgesFor` for an orphan pays embed latency for the overlapping runs; the cache makes every subsequent read cheap. Bounded by the candidate cap `N`. Provider-down during that pass → degrade to the deterministic result, not an error.
- **Run fingerprint invalidation.** A Run has no vault `ContentHash`; the cache keys on a hash of the embedded text (`run.Goal` + commit subjects). If a run's commit range changes after completion this re-embeds — acceptable and rare.
- **Non-vault vectors in `index.db`.** `attrib_vectors` puts run vectors in the S1 index DB — a deliberate extension of "vault-only." It is a separate table, never joined into the vault chunk KNN, and is wiped on model change like everything else. Flagged so a future reader doesn't mistake it for the chunk index.
- **Standing cost is still opt-in only.** L3/L4 embed only when the user enabled the flag and configured a provider; off by default → zero S2 cost, v1 behavior exactly.
