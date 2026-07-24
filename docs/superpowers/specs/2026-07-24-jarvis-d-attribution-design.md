# Jarvis sub-project D — Attribution engine — design

**Date:** 2026-07-24
**Status:** Design approved (brainstorming). Plan to follow.
**Type:** Sub-project spec (one `spec → plan → implementation` cycle under the [meta spec](2026-07-23-jarvis-second-brain-meta-spec.md)).

## Where D sits

Sub-project **D** of the [Jarvis second-brain meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — the engine that produces and maintains the **typed, confidence-weighted edges recall (C) traverses**. It depends on A (storage substrate, built and merged) and B (dossier & records — its contract is approved and it is being built in parallel; **D's implementation lands after B merges**, per the hard dependency `A → B → {C, D}`). C can start on layer-1/2 edges before D exists, so D is not on C's critical path, which is exactly why it is a safe parallel design slice.

This spec assumes the [Jarvis second-brain design](2026-07-22-jarvis-second-brain-design.md)'s "Attribution — hands-off, self-healing" section (the four signal layers, the hands-off posture, probation, self-correction), A's [design](2026-07-23-jarvis-a-wave-vault-design.md) and implemented `pkg/wavevault` interface, B's [design](2026-07-24-jarvis-b-dossier-design.md) and its typed `Dossier`/`Decision` model, and the meta spec's [cross-cutting invariants](2026-07-23-jarvis-second-brain-meta-spec.md#cross-cutting-invariants). It inherits as hard constraints: invariant 1 (**D calls no model** — layers 1–3 are all deterministic; the semantic layer 4 that would need a model is v2), invariant 3 (Markdown is canonical; D's inferred-edge store is a **rebuildable** derived layer, and the only non-derivable state — human corrections — is committed), invariant 6 (D never invents a material decision — it records deterministic signals and human corrections, nothing more), and invariant 7 (edges are precise, resolvable references so recall can cite and freshness-resolve them).

## Constraints inherited from the real codebase

D is designed against Wave's actual object model, not an idealized one. Four facts shape it:

1. **There is no `Task` object.** Wave's graph is `Channel → Run → worker-tabs` plus `RadarReport → RadarFinding` (`pkg/waveobj/wtype.go`); "task" is only free text (`Run.Goal`, dispatch-message text). **The task node D attributes to is the B dossier** (`tasks/active/<slug>.md`), and the attributed target is the **`Run`** (`waveobj.Run`, `wtype.go:249`). Every D edge therefore **crosses the vault ↔ SQLite boundary**: a dossier (canonical Markdown, addressed by vault id) ↔ a Run (WaveObj row, addressed by ORef).
2. **A run reference is a resolvable wikilink string, not a vault node.** Runs live in SQLite, not the vault, so a `[[run-<oid>]]` written into a dossier is a **dangling** link in A's graph — real in `Node.Links` and answerable by `Query{HasLink:…}`, but not an `A.Expand` node-to-node target (A's own test: "dangling `[[links]]` produce no edge"). D therefore treats a run reference as a **durable, git-committed pointer it resolves to a `run:<oid>` ORef and fetches from `wstore`** at read time — never a copy of the Run into Markdown (non-goal), and its live status/evidence resolve from the authoritative store at synthesis time (invariant 7). This is the load-bearing counterpart to B's "wikilinks-from-body-only" pitfall.
3. **`gitinfo.GetRangeChanges` returns no commit messages.** It yields only file name-status + numstat (`pkg/gitinfo/gitinfo.go:86`). The only existing extractor of commit **subjects + SHAs** is `parseGitLog` in `pkg/reporadar/collect_git.go:66`, and it is `--since`-windowed, not `base..end`-ranged. Layer 2 (ticket id in commit messages) needs subjects over a Run's exact `BaseCommit..EndCommit` range, so D adds **one small range-based helper to `gitinfo`** (§5) — its single edit to an existing package, mirroring B's additive `wavevault.Create`.
4. **A Run↔finding attribution loop already exists — reuse its shape, don't reinvent.** `RunRadarOrigin` on the Run (`wtype.go:315`) + the denormalized `RadarInvestigation` written back onto the finding, keyed on the durable `Fingerprint` via `RecordInvestigation` (`pkg/reporadar/investigation.go:50`), is already a typed, provenance-carrying, cross-scan-stable edge with outcome writeback. And `SealEvidence` already scopes changes to a Run's `BaseCommit..EndCommit` within `ProjectPath` (`pkg/jarvis/evidence.go:279`). D's dossier↔Run edges generalize this pattern; the range-scoping primitive is borrowed wholesale. The current `pkg/jarvisrecall` shim assembles a flat candidate list with **no edges** — D + C are what replace it with a real graph.

## Design decisions

Two forks, settled in brainstorming:

- **Canonical layer-1, D decorates (scope boundary).** The layer-1 dossier↔Run edge is a *certain fact captured at dispatch*, so **F writes it as a canonical `[[run-<oid>]]` reference in the dossier `refs` block via `B.SetRefs`** — it is not something D infers. **D owns only the inferred edges (layers 2–3), the edge model (provenance + confidence), the full lifecycle (probation / harden / self-correct / detach / accept / time-box / backfill), and the unified edge read C consumes.** Smallest D; reuses B; no duplicate edge representation.
- **Rebuildable edge cache + canonical override log + harden-to-reference (storage).** Inferred layer-2/3 edges live in a **rebuildable derived layer** (re-run the extractors over current Runs + git + vault); machine guesses never touch git. The only non-derivable state — human **detach/accept** — is a **small canonical committed log** replayed over the derived edges on every rebuild. A confirmed edge **hardens** into a canonical `refs` reference via `B.SetRefs`, becoming part of the task's committed story and durable across a cache rebuild. This maps invariant 3 exactly and parallels how A treats its index and C its learning store.

## What D delivers

1. **The typed edge model** — `AttributedEdge{ dossierID, runORef, layers[], provenance, confidence, state }`, with `state ∈ {informing, probation, confirmed, detached}`, confidence a `[0,1]` score with weak/medium/strong display buckets (§1).
2. **Deterministic signal extractors, layers 2–3** — ticket-identifier match (Goal / Channel name / commit subjects over the Run range) and structural correlation (same repo + overlapping window), plus the read of F's canonical layer-1 references (§2).
3. **The hands-off, self-healing lifecycle** — optimistic attach, probation before hardening (age re-derived from `Run.CreatedTs`), harden-to-`refs`, self-correction from stronger signals, human detach/accept via a committed override log, time-boxing, and batched `Backfill` (§3).
4. **The rebuildable edge store** — in-memory, built on demand from the extractors, with the override log replayed on top (§4).
5. **One additive helper on `gitinfo`** (§5) — `RangeLog`, giving commit subjects/SHAs over a `base..end` range.
6. **The unified edge read C consumes** — `EdgesFor(dossierID)`, merging canonical layer-1 references + inferred layer-2/3 edges into one confidence-ordered list (§7).

## What D deliberately does NOT do

- **No model calls** (invariant 1). Layers 1–3 are deterministic. **Layer 4** (semantic inference matching a Run's objective/diff to a dossier's acceptance criteria) is a model call and is **v2**, deferred with the embedding index.
- **No layer-1 authorship.** F writes the dispatch edge; D reads it. D never fabricates a task↔Run link that isn't backed by a deterministic signal or a human accept (invariant 6).
- **No new recall collection, no wire/RPC surface, no frontend, no `task generate`.** D is in-process Go consumed by C, like A and B. The **ambient attribution UI** (task tags on agent/Channel/Run rows, one-click detach, batched backfill accept) is presence-D surface work — G or a later ambient-presence slice; D ships only the mechanism (`Detach`/`Accept`/`Backfill` functions).
- **No copying of Run evidence into Markdown** (non-goal). An edge stores a reference (`run:<oid>`) resolved live, never a transcript or diff snapshot.
- **No second edge type in v1.** Only **dossier ↔ Run**. Commits and Channels are *confidence contributors* to that edge (commits live inside the Run's range; the Channel groups Runs), not their own edge types.

## Architecture

New pure-Go package **`pkg/jarvisattrib`**, a sibling to `pkg/wavevault`, `pkg/jarvisdossier`, and `pkg/jarvisrecall`. It imports `jarvisdossier` (B) for `LoadDossier` + `SetRefs`, `wstore` for Run/Channel reads, and `gitinfo` for the commit range; it depends on nothing above it. Proposed files:

| File | Responsibility |
|---|---|
| `edges.go` | The `AttributedEdge` model, confidence scoring + buckets, the `run-<oid>` ↔ `run:<oid>` reference convention. |
| `extract.go` | Layer-2 (identifier match) and layer-3 (structural correlation) extractors over `wstore` Runs + `gitinfo.RangeLog`; the read of F's canonical layer-1 references. |
| `store.go` | The in-memory rebuildable edge store: build-on-demand from the extractors, override-log read + replay, per-dossier invalidation. |
| `lifecycle.go` | Probation gate, harden-to-`refs`, self-correction, `Detach`/`Accept` (append to the override log), time-boxing, `Backfill`; the `EdgesFor` unified read. |
| `edges_test.go`, `lifecycle_test.go` | Go tests over a temp vault + real git + fixture Runs in a temp `wstore` (§9). |

**`gitinfo` — modified:** `pkg/gitinfo/gitinfo.go` gains `RangeLog` (§5).

## 1. Edge model

```go
type EdgeState string // "informing" | "probation" | "confirmed" | "detached"

type AttributedEdge struct {
    DossierID  string   // vault id of the tasks/active dossier
    RunORef    string   // "run:<oid>" — resolved from a reference / a wstore Run
    Layers     []int    // which signal layers fired: 1 (canonical), 2, 3
    Provenance string   // "dispatch" | "ticket-match" | "structural" | "human-accept"
    Confidence float64  // [0,1]; display buckets: weak <0.4, medium, strong ≥0.75 (PLACEHOLDER cutoffs)
    State      EdgeState
}
```

- **One attributed edge type: dossier ↔ Run.** The `Layers` slice records *which signals reinforce the same edge*; confidence is the **max** over the firing layers (a strong signal is not diluted by a weak one).
- **Layer weights (PLACEHOLDER tuning, recorded in `docs/deferred.md`):** layer 1 (canonical dispatch) = 1.0; layer 2 (exact ticket hit) ≈ 0.8; layer 3 (repo + window) ≈ 0.3. These are the design's "high / high-on-hit / weak prior."
- **The reference convention:** a canonical run reference is the wikilink `[[run-<oid>]]`; D resolves `run-<oid>` ⇄ the `run:<oid>` ORef. F, B, and D must agree on this form (constraint 2).

## 2. Signal extractors (deterministic, free)

- **Layer 1 — dispatch (read, not authored by D).** D reads the dossier's `refs` links (via `B.LoadDossier` → `Node.Links`), filters `run-*`, and emits each as a `confirmed`, confidence-1.0 edge. This layer also **anchors the dossier's repo** — the `ProjectPath` of its layer-1 Runs — which layer 3 needs. Note: once a reference is in `refs` — whether F wrote it at dispatch or D hardened it from a confirmed layer-2 hit — the two are indistinguishable bare `[[run-<oid>]]` wikilinks; D reads them all back as `confirmed` canonical edges and does **not** re-derive which layer originally produced a hardened reference (the distinction stops mattering after confirmation).
- **Layer 2 — identifier match.** For each candidate Run in scope, match the dossier's `ticket:` frontmatter key (from B) against `Run.Goal`, the parent `Channel.Name` (`wtype.go:342`), and **commit subjects** in the Run's `BaseCommit..EndCommit` range (via `gitinfo.RangeLog`, §5). An exact ticket-id hit → `Layers:[2]`, confidence ≈ 0.8. No `ticket:` on the dossier → layer 2 is silent (no false hits).
- **Layer 3 — structural correlation.** Other Runs in the **same `ProjectPath` as the dossier's already-anchored Runs**, whose `CreatedTs..CompletedTs` window overlaps the dossier's active window (`created` … `updated`-or-now while `status:active`). → `Layers:[3]`, confidence ≈ 0.3 (weak prior). **Fires only if the dossier has ≥1 anchor edge** (layer 1, or a confirmed layer 2) — with no repo anchor there is nothing to correlate, and no dossier `repo` field exists (nor is one added: this keeps B's schema untouched).

Candidate Runs come from `wstore.DBGetAllObjsByType[*waveobj.Run]` / `GetChannelRuns` (`pkg/wstore/wstore_channel.go`), the same source `jarvisrecall` already reads.

## 3. Lifecycle & self-healing (hands-off posture)

- **Optimistic attach.** Every extracted edge is live in `EdgesFor` immediately (state `informing`); it may *inform* C's traversal at its confidence weight from the moment it is seen.
- **Probation before hardening.** An inferred edge may inform traversal but may **not harden** (become a canonical reference / feed C's learning-store cache) until it has survived a probation window **without contradiction or detach**. The edge's age is **re-derived from `Run.CreatedTs`** — no persisted "first-seen" is needed (a rebuild recomputes it identically). Window ≈ 24h (PLACEHOLDER). An edge past probation and uncontradicted is `confirmed`.
- **Harden.** On confirmation (a deterministic layer-2 exact hit past probation, or a human `Accept`), D promotes the edge into the dossier's machine `refs` block via `B.SetRefs` (read current refs, union the `[[run-<oid>]]`, write with the `baseHash` guard). It is now a canonical, committed reference — durable across a cache rebuild, part of the task's `git log` story. Layer-3 weak edges **never auto-harden**; only a human `Accept` promotes them.
- **Self-correction (v1).** (a) A human `Detach` always wins (override log). (b) A **layer-2 contradiction** — the Run's commits/`Goal` carry a *different* ticket than the dossier's — retracts a competing layer-3 edge to that dossier on recompute. (c) Layer-4 semantic contradiction is v2. Because inferred edges are recomputed from current signals, retraction is automatic: the contradicted edge simply is not re-emitted.
- **Detach / Accept (human corrections).** `Detach(dossierID, runORef)` and `Accept(dossierID, runORef)` append a record to the **canonical override log** (§4). Detach forces state `detached` (suppressed from `EdgesFor` and never hardened); Accept forces `confirmed` and triggers a harden. These are the only non-derivable facts, so they are the only thing D commits.
- **Time-boxing (drift).** A layer-3 edge that is never reinforced (no layer-2 hit) and never accepted, whose Run completed more than N days ago (PLACEHOLDER), is dropped on recompute — old weak priors decay rather than accumulate. Deterministic, free.
- **Backfill.** `Backfill(dossierID) → []AttributedEdge` runs the extractors across all in-scope Runs and returns proposed edges for review; the batched **one-click accept UI** is deferred (G / ambient slice). In v1 backfill is the same extractor path `EdgesFor` uses, exposed for an explicit "attribute past work" call.

## 4. Storage & rebuild (Approach A)

- **Inferred edges: in-memory derived store.** Built on demand (boot / first `EdgesFor`) by running §2's extractors over current `wstore` Runs + `gitinfo` + the vault. Invalidated per-dossier when its dossier changes or a relevant Run changes. Rebuildable from scratch at any time (invariant 3) — it holds no authoritative state.
- **Override log: canonical, committed, replayed.** Human detach/accept append to `<vault>/attributions/overrides.jsonl` — a D-owned append-only file **outside A's four recall collections** (so A does not index it as recall content; D reads/appends it directly). Each line is one record: `{dossierID, runORef, action: "detach"|"accept", actor, ts}` (append-only; the latest record for a `(dossierID, runORef)` pair wins, so an accept can undo a prior detach and vice-versa). It sits in the vault git repo, so A's ownership-staged `Commit` captures it and it survives across machines via the user's git remote. On every store rebuild the log is **replayed** over the freshly-extracted edges: a `detach` forces `detached`, an `accept` forces `confirmed`+harden. A detached edge therefore stays detached across any rebuild.
- **Hardened references: canonical in the dossier.** Confirmed edges also exist as `[[run-<oid>]]` in the dossier `refs` block (via `B.SetRefs`) — the durable, human-visible form. `EdgesFor` reads these back as layer-1/confirmed regardless of cache warmth.
- **Zero standing cost.** No model, no background poll; the store defers work to the next read (mirrors C's learning-store posture).

## 5. The `gitinfo` addition — `RangeLog`

`gitinfo.GetRangeChanges` gives files but not commit messages (constraint 3), and `reporadar.parseGitLog` is `--since`-windowed. D needs subjects over an exact commit range, so:

```go
// RangeLog returns the commits in base..end (subject + sha + author time), for identifier matching.
func RangeLog(ctx context.Context, cwd, base, end string) ([]RangeCommit, error)

type RangeCommit struct {
    Hash    string
    Ts      int64  // author time, UnixMilli
    Subject string
}
```

It shells `git log --pretty=format:%H%x1f%ct%x1f%s <base>..<end>` and parses on the `\x1f` separator — the same technique as `parseGitLog`, range-based instead of time-based. Additive, no change to existing `gitinfo` behavior, exercised by D's tests. (Whether to later refactor `reporadar.parseGitLog` onto this shared helper is out of scope for D — measure first.)

## 6. B's contract D consumes

D is written against B's **approved** contract; D's implementation is gated on B merging (`A → B → D`). From B (`pkg/jarvisdossier`):

- `LoadDossier(r *wavevault.Retriever, id string) (*Dossier, error)` — D reads `ticket`, `status`, `created`/`updated` (the active window), and the `refs` links (canonical layer-1 run references).
- `SetRefs(v *wavevault.Vault, id string, refs []string, baseHash string) (*wavevault.WriteResult, error)` — D hardens a confirmed edge by unioning its `[[run-<oid>]]` into the dossier's machine `refs` block. D reads the current dossier hash first for the `baseHash` guard, and retries on `Conflict`.

If B's contract shifts during its build, this section is the reconcile point; nothing else in D touches B's internals.

## 7. Merged read — the D ⇄ C seam

```go
func EdgesFor(dossierID string) ([]AttributedEdge, error) // confidence-descending
```

The single edge source C's traversal uses for task↔Run attribution. It merges: (a) the dossier's canonical `[[run-*]]` references (layer 1 / hardened, confidence 1.0), and (b) D's inferred layer-2/3 edges from the store — override log applied, detached edges dropped, confidence-ordered. C weights fuzzy (weak/medium) edges lower during traversal and surfaces them as "weak" per grounding invariant 7; only `confirmed` edges are eligible to feed C's learning-store cache (the design's "only confirmed edges may harden" invariant). Freshness of each Run (status, evidence) resolves from `wstore` at synthesis time — D returns the reference, not a snapshot.

## 8. Seams D exposes / consumes

- **D ⇄ C (exposes):** `EdgesFor(dossierID)` — the unified, confidence-weighted dossier↔Run edge list; plus the `confirmed` flag gating cache eligibility.
- **D ⇄ B (consumes):** `LoadDossier` (ticket + window + refs), `SetRefs` (harden).
- **D ⇄ wstore / gitinfo (consumes):** Run/Channel reads (`DBGetAllObjsByType[*Run]`, `GetChannelRuns`, `Channel.Name`), and the new `gitinfo.RangeLog`.
- **D ⇄ vault (consumes):** the committed override log under `<vault>/attributions/`, captured by A's `Commit`.
- **Mutators (backend mechanism, UI deferred):** `Detach`, `Accept`, `Backfill`.

## 9. Testing

Go tests only (backend package, no jsdom), a temp vault + real `git` + fixture Runs written to a temp `wstore`, matching A's/B's/`gitinfo`'s pattern.

- **layer-2 ticket match** — a Run whose commit subject (in a real `base..end` range via `RangeLog`) contains the dossier's `ticket` produces a `Layers:[2]`, ~0.8 edge; a Run with no id match produces none.
- **layer-3 anchored correlation** — a second Run in the same `ProjectPath` within the window yields a weak `Layers:[3]` edge **only when** the dossier has an anchor (layer-1 ref or confirmed layer-2); with no anchor, layer 3 stays silent.
- **probation gate** — a fresh inferred edge is present in `EdgesFor` (state `informing`, informs traversal) but is **not** hardened into `refs` until the Run's age exceeds the window; a rebuild re-derives the same age from `Run.CreatedTs`.
- **harden** — a confirmed edge writes `[[run-<oid>]]` into the dossier `refs` block via `SetRefs`; `Query{HasLink:"run-<oid>"}` then finds the dossier (proves the reference is real in `Node.Links`), and human `## Notes` prose is unchanged (B's diff-validator).
- **detach survives rebuild** — `Detach` then a full store rebuild: the edge stays `detached` (override-log replay), never resurrected by the extractors.
- **self-correction** — a Run whose commits carry a *different* ticket retracts a competing layer-3 edge on recompute.
- **merged read ordering** — `EdgesFor` returns canonical + inferred merged, confidence-descending, detached dropped.
- **`gitinfo.RangeLog`** — subjects/SHAs parsed correctly over a `base..end` range in a temp repo; empty range → empty slice, not an error.

## File-touch map

**Go — new:** `pkg/jarvisattrib/{edges,extract,store,lifecycle}.go` (+ `{edges,lifecycle}_test.go`).

**Go — modified:** `pkg/gitinfo/gitinfo.go` — add `RangeLog` (§5), with a test in `pkg/gitinfo/gitinfo_test.go`.

**Docs:** `docs/deferred.md` — record the PLACEHOLDER tuning constants (layer confidence weights, probation window, layer-3 time-box, confidence display cutoffs) as tune-with-real-data-later. Meta-spec tracking-table D-row link added at D's feature-commit time (avoid mid-plan edits to that shared file, per the A/B/F-cycle precedent).

## Open risks

- **Depends on B's not-yet-merged contract.** D consumes `LoadDossier`/`SetRefs`. If B's build changes those signatures, §6 is the reconcile point. Mitigation: D's spec/plan proceed in parallel; D's *implementation* starts only after B merges, so the contract is real by then.
- **Dangling run references** (constraint 2): the whole model rests on `[[run-<oid>]]` being a resolvable pointer, not an `A.Expand` node. A test asserts `Query{HasLink}` finds it; if a future change expects `A.Expand` to traverse into a Run, it breaks silently. Runs are resolved via `wstore`, never copied into the vault.
- **Placeholder tuning** (confidence weights, probation window, time-box): fabricated defaults marked PLACEHOLDER and recorded in `docs/deferred.md`; they need calibration against a populated vault before proactive resurfacing (v2) can trust hardened edges. Harmless for v1 interactive recall (a weak edge is a dismissible weak-cited path).
- **Extractor scan is O(Runs × range)** — `EdgesFor` runs `RangeLog` per candidate Run. Fine at v1 scale (dozens–hundreds of Runs), same posture as A's index-less `Search`; the derived store caches results per dossier and invalidates narrowly. Persistence is the documented later lever if a populated instance profiles hot.
- **Override log outside the collections**: `<vault>/attributions/overrides.jsonl` is a new vault path A does not index. It is committed by A's repo-wide `Commit` staging, but D owns its read/append directly. If A's commit staging ever narrows to only the four collections, this file would stop being committed — a test asserting the file lands in a commit guards it.
