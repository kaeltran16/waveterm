# Jarvis sub-project B — Dossier & structured records — design

**Date:** 2026-07-24
**Status:** Design approved (brainstorming). Plan to follow.
**Type:** Sub-project spec (one `spec → plan → implementation` cycle under the [meta spec](2026-07-23-jarvis-second-brain-meta-spec.md)).

## Where B sits

Sub-project **B** of the [Jarvis second-brain meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — the *shape* of a task dossier and its machine-maintained records, layered on the storage substrate [sub-project A](2026-07-23-jarvis-a-wave-vault-design.md) delivered. A is the generic *mechanism* (region-aware splice, ownership-staged commits, deterministic read/expand); B is the *policy* — which regions a dossier owns, what a decision record looks like, and the typed operations C/E/F call. The meta spec's hard dependency is `A → B → {C, D}`; A is built and merged, so B is unblocked and is the next slice in the contract-first order.

This spec assumes A's [design](2026-07-23-jarvis-a-wave-vault-design.md) and its **implemented** interface (`pkg/wavevault`), the [Jarvis second-brain design](2026-07-22-jarvis-second-brain-design.md) (the write-ownership contract and its "Structured records" section), and the meta spec's [cross-cutting invariants](2026-07-23-jarvis-second-brain-meta-spec.md#cross-cutting-invariants). It inherits as hard constraints: invariant 1 (**B calls no model** — it records deterministic facts and renders Markdown; the model that seeds a decision's rationale draft or writes the state summary is E/F, not B), invariant 5 (region-aware, diff-validated write-ownership — B supplies the `RegionSpec`, A enforces it), invariant 6 (human owns material decisions and completion — B's code creates entry scaffolds from deterministic facts only), and invariant 7 (grounding — decisions are precise traversal nodes so recall can cite them).

## Constraints inherited from A's implemented interface

B is designed against A's real code, not the proposed signatures in A's spec. Three facts from `pkg/wavevault` shape B:

1. **A has no file-creation primitive.** `Write` requires the file to exist (`resolvePath` + `os.ReadFile` error otherwise) and `setBlock` errors if the block markers are absent — its comment states *"B scaffolds blocks."* So **B owns creating the initial file** for every node (dossier and decision), laying down frontmatter + empty machine-block markers + any human placeholder. A then splices into what B laid down. This requires one small addition to A (§2).
2. **Machine frontmatter values are single-line.** `setFrontmatterKey` writes `key: value` on one physical line. Any list-like machine field must be **flow-style YAML** (`["a", "b"]`), never a multi-line block list, or the splice and the human-projection diff break.
3. **Wikilinks are extracted from the body only.** `parseNode` scans post-frontmatter text for `[[links]]`; `Node.Links` (which drives `Expand`, edges, and the `HasLink` filter) **never sees frontmatter links**. Therefore every reference that must be a *traversable edge* lives in a **machine-owned body block**, not a frontmatter key. This is load-bearing: Option 1 (below) depends on decisions being reachable by traversal from the dossier.

## Design decision — records as separate files (Option 1)

Decisions are **separate files in `decisions/`**, one per decision, referenced from the dossier by `[[wikilink]]`. Blockers are a **machine-owned block inside the dossier**. Rationale:

- **It is the only shape that maps onto A for free.** A gives per-file field ownership: machine owns declared frontmatter keys + declared body blocks; everything else (prose, non-reserved keys) is human. A decision file *is* that mapping — machine frontmatter (`id`/`status`/…) + a machine `links` block + human rationale prose. Embedding a decision inside a dossier block fails: A's block model makes the *whole* block machine-owned (`humanProjection` strips it wholesale), so the human rationale would be unprotected and A would overwrite it.
- **It gives the design its stated goals** (second-brain design, "Structured records"): each decision is a **precise traversal node** (task → decision → Run edges recall walks), an **entry-granular content-hash unit** (C's cache invalidation rehashes one decision, not the whole dossier), and **append-only is trivial** — a new decision is a new file, never a rewrite.
- **Blockers differ deliberately.** Blockers are worker-reported, fully machine-owned, ephemeral task state with no cross-task recall value. Making each a graph node is churn; a single machine-owned block in the dossier fits them, and it is safe *because* there is no human prose inside it. A has no `blockers/` collection anyway (only `memory/ tasks/ decisions/ attachments/`).

The one cost — assembling "this task's decisions" is a `Query`/`Expand` over `decisions/` rather than reading one file — is exactly what A's read API is for and is the access pattern recall uses regardless.

## What B delivers

1. **The dossier schema + `DossierSpec()`** — reserved machine frontmatter keys, a machine `state` block, a machine `refs` block (traversable reference wikilinks), and a machine `blockers` block; everything else human-owned. `DossierSpec()` returns the `wavevault.RegionSpec` A enforces.
2. **The decision-record schema + `DecisionSpec()`** — machine frontmatter (`id`/`created`/`actor`/`provenance`/`status`) + a machine `links` block (traversable) + human rationale body.
3. **Typed models with parse + render** — `Dossier` and `Decision` structs projected from `wavevault.Node` (tolerant: unknown/missing keys are fine, no migrations), and a renderer that serializes the typed model to the scaffolded Markdown A can splice.
4. **Record operations layered on A** — create (scaffold via A's new `Create`), typed load, machine-region updates (`SetState`/`SetStatus`/`SetBlockers`/`SetRefs`), decision append, and decision status-mutate (`SupersedeDecision`).
5. **One additive method on A** (§2) so machine-authored scaffolds commit as `Jarvis`.

## What B deliberately does NOT do

- **No model calls** (invariant 1). B records facts and renders Markdown. The state-summary *content* and a decision's rationale *draft* are written by E/F calling B's setters — B only owns the regions and the rendering.
- **No attribution edge typing / confidence** — a decision's `links` are plain wikilinks here; typed edges with provenance + confidence are **D**. B stores the deterministic `actor`/`provenance` a fact carries, not D's edge model.
- **No dossier/Tasks editor UI** — the renderer B owns is the *serialize* side; rendering machine regions read-only in a surface and the append-entry log UI are the future Tasks surface (v1/v2 boundary).
- **No migrations** — tolerant parsing absorbs schema drift (old entries missing newer fields parse fine), matching the design's "tolerant parsing (no migrations)."
- **No copying of external records** — a decision *references* a Run/ticket by wikilink; it never copies transcript or evidence into Markdown (non-goal).
- **No new collections / no wire or RPC surface / no frontend / no `task generate`** — B is in-process Go consumed by C/E/F, like A.

## Architecture

New pure-Go package **`pkg/jarvisdossier`**, a sibling to `pkg/wavevault` (following the `pkg/jarvisrecall` naming already in the tree). It imports `wavevault` and depends on nothing above it. Proposed files:

| File | Responsibility |
|---|---|
| `dossier.go` | `Dossier` typed model; `DossierSpec()`; scaffold/render; `CreateDossier`, `LoadDossier`; machine setters (`SetState`, `SetStatus`, `SetBlockers`, `SetRefs`). |
| `decision.go` | `Decision` typed model; `DecisionSpec()`; `AppendDecision`, `SupersedeDecision`; decision filename/bounded-slug. |
| `parse.go` | Tolerant projection helpers from `wavevault.Node.Frontmatter` (+ body blocks) into the typed models; shared block-extraction. |
| `dossier_test.go`, `decision_test.go` | Go tests over a temp vault + real git (§7). |

**A — modified:** `pkg/wavevault/write.go` gains `Create` (§2).

## 1. Dossier schema (`tasks/active/<bounded-slug>.md`)

A scaffolded dossier B creates:

```markdown
---
status: active
ticket: PROJ-142
objective: add OAuth PKCE flow
acceptance: ["tokens rotate", "no long-lived refresh"]
confidence: high
created: 1753324800000
updated: 1753324800000
---
<!-- jarvis:begin state -->
<!-- jarvis:end state -->
<!-- jarvis:begin refs -->
<!-- jarvis:end refs -->
<!-- jarvis:begin blockers -->
<!-- jarvis:end blockers -->

## Notes

```

- **Machine frontmatter keys** (single-line values): `status` (active | paused | completed | archived), `ticket`, `objective` (one-line snapshot; long narrative goes in the `state` block), `acceptance` (flow list), `confidence` (low | med | high), `created`/`updated` (UnixMilli).
- **Machine blocks:** `state` (the narrative summary E/F write at lifecycle boundaries), `refs` (traversable `[[decision]]`/`[[run]]` wikilinks — in the **body** so A's parser makes them edges), `blockers` (worker-reported active blockers).
- **Human-owned:** the `## Notes` prose and any non-reserved frontmatter key (the user's own tags/properties).

```go
func DossierSpec() wavevault.RegionSpec {
    return wavevault.RegionSpec{
        MachineKeys: []string{"status", "ticket", "objective", "acceptance", "confidence", "created", "updated"},
        Blocks:      []string{"state", "refs", "blockers"},
    }
}
```

## 2. The A addition — `Create`

A minimal, additive method on `wavevault.Vault` (no change to existing behavior), because A intentionally has no create path and a file B writes directly would land in A's *user* commit rather than the `Jarvis` commit:

```go
// Create writes a new file into a collection and records it as machine-authored so Commit attributes
// it to Jarvis. Errors if the file already exists (create is not overwrite; use Write to edit).
func (v *Vault) Create(collection, filename, content string) (*WriteResult, error)
```

It joins `v.Root/collection/filename`, writes `content`, and records the path+hash in `v.machineFiles` (the same ledger `Write` populates and `Commit` reads). This is the single edit to the merged A package; it is exercised by B's tests.

## 3. Decision-record schema (`decisions/<date>-<bounded-slug>.md`)

```markdown
---
id: dec-8f3a21c0
created: 1753324800000
actor: worker-3
provenance: worker-report
status: active
---
<!-- jarvis:begin links -->
[[PROJ-142]] [[run-abc123]]
<!-- jarvis:end links -->

We dropped long-lived refresh tokens because the mobile client can re-auth silently...
```

- **Machine frontmatter:** `id` (B-generated `dec-<8hex>`), `created` (UnixMilli), `actor` (worker id / `human` / `jarvis`), `provenance` (how the fact was captured, e.g. `worker-report` | `human-submit`), `status` (active | superseded | reverted — **the one field Jarvis mutates on an existing entry**).
- **Machine `links` block:** the traversable `[[task]]`/`[[run]]`/`[[commit]]` wikilinks (in the body so they become edges). Kept machine-owned and separate from the human rationale.
- **Human body:** the rationale prose. The model *seeds a draft* (E/F), a human edit locks it; A's diff-validator guarantees a later machine `status` mutation cannot touch it.

```go
func DecisionSpec() wavevault.RegionSpec {
    return wavevault.RegionSpec{
        MachineKeys: []string{"id", "created", "actor", "provenance", "status"},
        Blocks:      []string{"links"},
    }
}
```

**Append-only:** `AppendDecision` always creates a new file; existing decision files are never rewritten except their `status` machine key. Filenames use a **bounded slug** (Windows MAX_PATH — reuse memvault's bounded-slug discipline) of `<date>-<summary>`; `id` is the stable identity for links.

## 4. B's Go API

The lean set matching the design's "read / append / status-mutate," each machine write going through `A.Write(id, spec, edits, baseHash)` or `A.Create`:

```go
// dossier
func CreateDossier(v *wavevault.Vault, facts DossierFacts) (id, hash string, err error)
func LoadDossier(r *wavevault.Retriever, id string) (*Dossier, error)
func SetState(v *wavevault.Vault, id, summary, baseHash string) (*wavevault.WriteResult, error)
func SetStatus(v *wavevault.Vault, id, status, baseHash string) (*wavevault.WriteResult, error)
func SetBlockers(v *wavevault.Vault, id string, blockers []string, baseHash string) (*wavevault.WriteResult, error)
func SetRefs(v *wavevault.Vault, id string, refs []string, baseHash string) (*wavevault.WriteResult, error)

// decisions
func AppendDecision(v *wavevault.Vault, facts DecisionFacts) (decID string, err error)      // creates file + links it into the dossier refs
func SupersedeDecision(v *wavevault.Vault, decID, status, baseHash string) (*wavevault.WriteResult, error)
```

- `DossierFacts` / `DecisionFacts` are the deterministic inputs code captures at a boundary (objective, ticket, acceptance, actor, provenance, seed rationale, links) — never model output.
- **`updated` and `confidence`:** every machine setter also refreshes the dossier `updated` timestamp in the same splice (one extra `RegionEdit`), so freshness never goes stale behind a machine write. `confidence` is set once at `CreateDossier` (default `med`) and has **no dedicated setter in v1** — the key namespace is reserved now so D can populate it later (attribution confidence is a D/v2 concern); claiming it also keeps a human from accidentally owning it.
- `AppendDecision` is two writes: `Create` the decision file (Jarvis-authored), then `SetRefs` to add its `[[id]]` to the dossier's `refs` block (read the dossier's current hash first for the `baseHash` guard). If the second write conflicts, the decision file still exists and the link is retried — no lost record.
- `LoadDossier` returns a typed `Dossier` (parsed frontmatter + extracted blocks + human body); **tolerant** — missing keys default, unknown keys are ignored, no error. Assembling a task's decisions is `r.Query(Filter{HasLink: taskID})` over a `decisions`-scoped retriever, or `r.Expand([]string{taskID}, …)` following the `refs` edges.

## 5. Ownership mapping (why this is safe)

| Region | Owner | Mechanism |
|---|---|---|
| Dossier machine keys, `state`/`refs`/`blockers` blocks | machine | `DossierSpec()` → A rejects any edit outside it; `humanProjection` proves human prose unchanged |
| Dossier `## Notes`, non-reserved keys | human | untouched by every B write |
| Decision `id`/`created`/`actor`/`provenance` | machine | set once at `Create` |
| Decision `status` | machine | the sole mutate-in-place, via `SupersedeDecision` |
| Decision `links` block | machine | traversable edges, no human prose |
| Decision rationale body | human | seeded draft, human edit locks; diff-validator guards it across a `status` mutation |

## 6. Seams B exposes / consumes

- **B ⇄ A (consumes):** `RegionSpec` (via `DossierSpec()`/`DecisionSpec()`), the new `Create`, `Write`, and a scoped `Retriever`. B adds no new A read paths — it reuses `Query`/`Search`/`Expand`/`Read`.
- **B ⇄ C (exposes):** the typed `Dossier`/`Decision` models and `LoadDossier`; C's recall reads dossiers/decisions as grounded, citable nodes and traverses `refs`/`links` edges.
- **B ⇄ E/F (exposes):** `CreateDossier` (F, on task dispatch), `SetState` (E, at a lifecycle boundary), `SetStatus`/`SetBlockers` (E/F), `AppendDecision`/`SupersedeDecision` (F, on a submitted decision or worker-reported blocker resolution). B provides the mechanism; *when* to call and *what content* to write is the consumer's (and the model's) concern.

## 7. Testing

Go tests only (backend package, no jsdom), a temp vault + real `git`, matching A's and `gitinfo`'s pattern.

- **scaffold / round-trip** — `CreateDossier` produces a file A can parse with all three block markers present; `LoadDossier` round-trips the typed model; machine list values (`acceptance`, blockers) serialize single-line so a later `A.Write` splices cleanly.
- **create attribution** — a `CreateDossier` file and an `AppendDecision` file both land in a **`Jarvis`-authored** commit (asserts the A `Create` ledger wiring), while a subsequent human body edit + `Commit` lands under the vault identity.
- **decision append + link** — `AppendDecision` writes a `decisions/` file and adds its `[[id]]` to the dossier `refs` block; a `Retriever` then reaches the decision from the task via `Expand`/`HasLink` (proves the body-block link is a real edge — guards the frontmatter-links pitfall of §"Constraints").
- **status mutate preserves rationale** — `SupersedeDecision` changes only `status`; a human-edited rationale body **survives** (diff-validator returns no error, prose byte-identical).
- **tolerant parse** — a decision file missing `provenance` (an "old" entry) loads without error, field defaulted.
- **blockers** — `SetBlockers` replaces the `blockers` block; empty list clears it; human `## Notes` prose is unchanged across the write.

## File-touch map

**Go — new:** `pkg/jarvisdossier/{dossier,decision,parse}.go` (+ `{dossier,decision}_test.go`).

**Go — modified:** `pkg/wavevault/write.go` — add `Create` (§2), with a test in `pkg/wavevault/write_test.go`.

**Docs:** the meta-spec tracking-table B-row link is added at B's feature-commit time (avoid mid-plan edits to that shared file, per the A/F-cycle precedent). No `docs/deferred.md` entry anticipated.

## Open risks

- **Single-line frontmatter values** (A constraint 2): `objective` must stay a one-line snapshot; anything narrative belongs in the `state` block. The renderer must guarantee flow-style for `acceptance`, and tests assert it — a multi-line value would silently break A's splice/diff-validate.
- **`refs`/`links` in the body, not frontmatter** (A constraint 3): traversability depends on it. A test asserts the edge is real; if a future change moves references to frontmatter, traversal breaks silently.
- **`Create` attribution ledger is in-memory** (mirrors A's existing `machineFiles`): if `wavesrv` crashes after `Create` but before `Commit`, the file is committed under the user identity on the next scan (A's `add -A` fallback). Acceptable — same durability posture A already documents; the record is never lost, only mis-attributed on a crash.
- **Decision-log assembly is an O(vault) scan** (A has no persistent index in v1): fine at v1 scale (dozens–hundreds of small files), same posture as A's `Search`; the in-memory retriever graph absorbs it, and persistence is the documented later lever if a populated vault profiles hot.
- **Bounded slug** (Windows MAX_PATH — a known memvault failure mode): every B-generated filename (dossier and decision) must use the bounded-slug discipline; `id` (not the filename) is the stable link target.
