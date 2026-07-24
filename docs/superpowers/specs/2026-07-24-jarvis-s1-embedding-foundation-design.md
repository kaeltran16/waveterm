# Jarvis sub-project S1 — Embedding foundation — design

**Date:** 2026-07-24
**Status:** Design approved (brainstorming). Plan to follow.
**Type:** Sub-project spec (one `spec → plan → implementation` cycle under the [v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md)).

## Where S1 sits

Sub-project **S1** of the [Jarvis second-brain v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md) — the **embedding foundation**: the one new standing-cost substrate, entirely opt-in, that the rest of the semantic lane (S2 recall/attribution, S3 proactive) hangs off. It is the semantic lane's only bottleneck (`S1 → S2 → S3`); the UX lane (U1/U2/U3) is independent of it.

It depends only on v1 **A** (Wave Vault foundation, built and merged — `pkg/wavevault`). It has **no consumer this cycle** — unlike C, which swapped F onto the vault to stay live, S1 is pure foundation with no user-visible surface. It is verified in isolation (Go tests + a build spike + an opt-in BYOK smoke), and S2 is the first consumer.

This spec assumes the [v1 design](2026-07-22-jarvis-second-brain-design.md)'s "Recall — agentic graph traversal" (its layer-3 / learning-store paragraphs) and the v2 meta spec's [cross-cutting invariants](2026-07-24-jarvis-second-brain-v2-meta-spec.md#cross-cutting-invariants). It inherits as hard constraints: v1 invariant 1 (**embedding runs only at explicit boundaries, never on a background poll**), v1 invariant 3 (Markdown is canonical; the index is a rebuildable derived layer, never committed), v1 invariant 4 (collection/scope boundary enforced by the retriever's tool set, not a prompt), and v2 invariants 10–13 (semantic is opt-in and strictly additive; graceful degradation is mandatory; BYOK and Wave ships no credentials; the index is a rebuildable, model-tagged derived artifact).

## Constraints inherited from the real codebase

S1 is designed against what A actually ships, not the idealized picture. Six facts shape it:

1. **`Node.ContentHash` already exists** (`pkg/wavevault/parse.go`: sha256-hex of the raw file bytes, set by `parseNode`). This is S1's per-node invalidation key — no new hashing needed.
2. **There is no persisted derived layer today.** A's `Retriever` is a per-operation in-memory re-scan ("no process-wide cache, no invalidation machinery — matches memvault's re-scan model"), and C's cycle deliberately **deferred** the cache-tier learning store. **S1 introduces Wave's first persisted, rebuildable derived-layer artifact.** (This corrects a wording bug in the v2 meta spec, which said the index sits "alongside v1's learning-store cache" — there is no such cache; fixed in this cycle.)
3. **There is no vault daemon.** Every consumer does `OpenVault → …op… → Commit` per logical operation (capture, continuity, attribution each open the vault themselves). There is no long-lived `Vault` singleton holding state. S1 mirrors this: `OpenIndex(ctx)` per operation, no daemon.
4. **The SQLite driver is `mattn/go-sqlite3` (CGO)** (`go.mod`; used by `wstore`/`filestore` via `jmoiron/sqlx`). A C extension like sqlite-vec **can** be statically linked here (it could not with a pure-Go driver). Wave's CGO build links through the **zig** toolchain — the one feasibility risk (§Open risks / build spike).
5. **`secretstore` is a simple file-backed KV** (`SetSecret(name,value)` / `GetSecret(name) → (value, ok, err)` / `DeleteSecret`). The BYOK key lives here, not in `wconfig` — a deliberate improvement on the legacy `ai:apitoken`-in-config pattern (v2 invariant 12).
6. **`wconfig` config keys are generated.** `metaconsts.go` is "DO NOT EDIT" — keys come from the `SettingsType` source struct + `task generate`, namespaced `foo:bar` (e.g. `ai:baseurl`). S1's keys go under a `jarvis:` namespace and are added the generated way.

A's `Retriever` supplies everything S1 needs to enumerate and read vault content: `Query(Filter{})` returns all in-scope `Node`s (each carrying `ContentHash`, `Collection`, `UpdatedTs`), and `Read(id)` returns a node + verbatim body. **S1 reconciles over a `Retriever`; it adds no new primitive to A.**

## Design decisions

Settled in brainstorming:

- **Opt-in + BYOK, provider-agnostic.** The whole capability is off by default (v2 == v1, zero standing cost). When enabled, the user supplies an OpenAI-compatible endpoint (`base URL + model` in `wconfig`, key in `secretstore`). One `Embedder` implementation covers OpenRouter (confirmed to expose `POST /api/v1/embeddings`, July 2026), OpenAI/Voyage/Cohere/Gemini directly, and **local** (a local OpenAI-compatible server — Ollama/LM Studio/llama.cpp). "Local vs cloud" is just *which base URL*; nothing to bundle.
- **Hybrid timing — one `Reconcile` method, two call sites.** Reconciliation is lazy by default (called at query time; re-embeds only nodes whose `ContentHash` changed since indexed) and the *same* method is the optional warm hook a caller may invoke at a commit boundary to pre-embed. Lazy is the correctness floor; warm is an optimization added only if query latency bites (YAGNI).
- **sqlite-vec store, separate DB, with a cosine-BLOB fallback.** Vectors live in a **dedicated** SQLite DB outside the vault, using sqlite-vec via `asg017/sqlite-vec-go-bindings/cgo` + `sqlite_vec.Auto()` (static link, no DLL to ship). If the zig build spike fails, the fallback behind the **same `Query` seam** is vectors-as-BLOB in the same dedicated DB + a Go cosine scan (no ANN, identical interface).
- **Section-level chunks.** One vector per Markdown `##` section, carrying the node's frontmatter as metadata, so a query resolves to a specific section and grounding citations are precise (invariant 7). Invalidation stays per-node (any edit re-embeds that file's sections).
- **Graceful degradation is a typed contract, not an error.** Flag off / no key / provider failure → `OpenIndex`/`Query` return a typed *unavailable* signal and attempt **no network** when disabled. S2 treats unavailable as "fall back to L1/L2." (v2 invariant 11.)

## What S1 delivers

1. **The `Embedder` seam** — a provider interface + one OpenAI-compatible HTTP implementation reading `base URL`/`model` from `wconfig` and the key from `secretstore`; `SetEmbedderForTest` for mocking (§1).
2. **The sqlite-vec index** — a dedicated derived-layer SQLite DB (vec0 table + chunk metadata), model-tagged, outside the vault, rebuildable; `OpenIndex(ctx)` mirroring `OpenVault` (§2).
3. **Hybrid reconciliation** — `Reconcile(ctx, r *wavevault.Retriever)`: content-hash diff → section-split changed/new nodes → embed (only changes hit the network) → upsert; deleted nodes pruned; model change → rebuild (§3).
4. **Scope-enforced query** — `Query(ctx, queryText, k, scope)`: embed the query, sqlite-vec cosine KNN, filtered by the scope's collections so a worker retriever physically cannot see `tasks/` (§4).
5. **The graceful-degradation contract** — typed *unavailable*; disabled → no network; the contract S2 builds its fallback on (§5).
6. **Config, flag, and key** — `jarvis:embedenabled`/`jarvis:embedbaseurl`/`jarvis:embedmodel` in `wconfig`; `jarvis:embedapikey` in `secretstore` (§6).

## What S1 deliberately does NOT do

- **No consumer wiring.** L3 recall and L4 attribution are S2; S1 ships and is tested in isolation. No recall/attribution code is touched.
- **No RPC / WaveObj / migration / frontend / `task generate` for wire types.** S1 is in-process Go plus additive `wconfig` keys (which do run `task generate` for the settings struct — the one codegen touch, and only for config, not wire/RPC). No `SurfaceKey`, no nav, no settings UI (surfacing the config/key in the settings surface is deferred to S2 or a small settings add).
- **No proactive, no semantic attribution, no query-side reranking.** S3 / S2 respectively.
- **No multimodal/image embeddings, no bundled local embedding model.** v3 (local = local-server base URL).
- **No background poll or watcher.** Reconciliation is only ever triggered by a query (lazy) or an explicit warm call (invariant 1).
- **No second authoritative store.** The index is a rebuildable cache; deleting it and re-reconciling reproduces it exactly (invariant 3).

## Architecture

One new package, no consumer:

- **`pkg/jarvisembed` (new)** — the whole foundation. Proposed files:

| File | Responsibility |
|---|---|
| `embed.go` | The `Embedder` interface + `openAICompatEmbedder` (HTTP POST `{baseURL}/embeddings`); config/key resolution (`wconfig` + `secretstore`); `Available()`; `SetEmbedderForTest`. |
| `index.go` | `OpenIndex`/`OpenIndexAtForTest`; sqlite-vec DB open + schema + `sqlite_vec.Auto()`; `ScoredChunk`; `Query`; the typed *unavailable* signal. |
| `reconcile.go` | `Reconcile(ctx, r)` — content-hash diff, section split, batched embed, upsert/prune, model-change rebuild. |
| `chunk.go` | Section splitting (`##`-heading segmentation) + frontmatter-as-metadata assembly of the text sent to `Embed`. |
| `embed_test.go`, `index_test.go`, `reconcile_test.go`, `chunk_test.go`, `maintest_test.go` | Go tests over a temp index DB + fixture vault + mock `Embedder` (§7). |

- **`wconfig` — modified:** three additive fields on the settings source struct (§6), then `task generate`.
- **No other package is modified.**

## 1. The `Embedder` seam

```go
type Embedder interface {
    Embed(ctx context.Context, texts []string) ([][]float32, error)
    Model() string   // stored as the index's model tag
    Dims() int       // vector dimensionality
}
```

- **`openAICompatEmbedder`** — POST `{baseURL}/embeddings` with `{"model": <model>, "input": [texts…]}`, `Authorization: Bearer <key>`; parse `data[].embedding`. ~40 lines of `net/http` with a bounded timeout and batched input; **no new dependency**. `Model()` returns the configured model; `Dims()` is learned from the first embedding (or a configured override) and pinned into the index's model tag.
- **Config resolution** — `base URL`/`model` from `wconfig`, key from `secretstore.GetSecret("jarvis:embedapikey")`. Missing key or `enabled=false` → `Available()` reports false.
- **`SetEmbedderForTest(e Embedder) (restore func)`** — the mock seam, mirroring C's `SetSynthesizeForTest`. Tests inject an embedder returning deterministic canned vectors (e.g. keyed off text) so KNN ordering is assertable without a network.

## 2. The index (sqlite-vec, dedicated derived DB)

- **Location.** `<WAVETERM_DATA_HOME>/jarvis/index.db` — **outside the vault** (the vault is its own git repo; the index is never committed). Its own `sql.DB`; not `wstore`.
- **Extension.** `sqlite_vec.Auto()` (from `github.com/asg017/sqlite-vec-go-bindings/cgo`) registers vec functions as an auto-extension before the DB is opened; static-linked into `wavesrv`, no runtime DLL. (Auto-extension applies process-wide — harmless: other Wave connections simply gain unused `vec_*` functions.)
- **Schema.**
  - `vec_chunks` — a `vec0` virtual table: `embedding float[<dims>]` (dims fixed at creation from the model).
  - `chunks(rowid, node_id, collection, section_idx, section_heading, section_text, content_hash)` — metadata + the section text needed to return a grounding snippet without a vault re-read (acceptable duplication: the index is a rebuildable cache, not authoritative). `rowid` joins to `vec_chunks`.
  - `meta(model, dims)` — the single model tag; a mismatch on open/reconcile triggers a full rebuild.
- **`OpenIndex(ctx) (*Index, error)`** — resolves config; if unavailable, returns the typed *unavailable* handle (no DB work, no network). Otherwise opens/creates the DB, ensures schema for the configured model's dims.

## 3. Reconcile (hybrid timing, one method)

`(*Index).Reconcile(ctx context.Context, r *wavevault.Retriever) (ReconcileStats, error)`:

1. If the configured model ≠ `meta.model` → wipe `vec_chunks`/`chunks`, recreate the vec table at the new dims (rebuild).
2. `nodes, _ := r.Query(wavevault.Filter{})` — all in-scope nodes (each with `ContentHash`).
3. For each node whose `ContentHash` differs from the stored per-node hash (or is new): `r.Read(id)` → body → `chunk.Split` into `##` sections → `Embed` the sections (batched) → replace all of that node's rows (delete old, insert new) with the new `content_hash`.
4. Prune: any indexed `node_id` no longer present in scope → delete its rows.
5. **Only changed/new nodes call `Embed`** — an unchanged vault is a zero-network reconcile.

Lazy call site: `Query` calls `Reconcile` first (bounded to the query's scope). Warm call site: a future caller may invoke `Reconcile` at a commit boundary — same method, no new machinery. (No warm call is wired in S1; the seam is exposed and tested.)

## 4. Scope-enforced query

`(*Index).Query(ctx, queryText string, k int, scope wavevault.Scope) ([]ScoredChunk, error)`:

1. Reconcile against `v.Retriever(scope)` (lazy freshness).
2. `Embed([queryText])` → query vector.
3. sqlite-vec cosine KNN over `vec_chunks`, **`WHERE collection IN (scope.Collections)`**, `LIMIT k`.
4. Return `[]ScoredChunk{NodeID, Collection, SectionHeading, SectionIdx, Snippet, Score}`.

The scope filter is the physical boundary (invariant 4): a `WorkerScope` query (memory + decisions) can never return a `tasks/` chunk even if one is indexed — mirroring how A's `WorkerScope` retriever can't read `tasks/`. `ScoredChunk` is shaped so S2 maps it into a recall `candidate` the way `nodeCandidate` maps a vault node today.

## 5. Graceful-degradation contract

- `Available() bool` — false when `enabled=false`, no `base URL`/`model`, or no key.
- When unavailable, `OpenIndex` returns a handle whose `Query` yields a typed *unavailable* result (`ErrEmbeddingsDisabled` sentinel or an `Available()==false` handle — settled in the plan) and **performs no network and no DB work**.
- A provider/network failure *during* an enabled `Embed` surfaces as an error the consumer treats as degraded-this-call (fall back), not a crash.
- S1 owns only the *signal*; S2 owns the fallback behavior. S1's tests assert: disabled → unavailable + zero embed calls; enabled-but-provider-erroring → error surfaced, index not corrupted.

## 6. Config & secrets

- **`wconfig`** (source struct → `task generate`): `jarvis:embedenabled` (bool), `jarvis:embedbaseurl` (string), `jarvis:embedmodel` (string). Additive; defaults keep the feature off.
- **`secretstore`**: `jarvis:embedapikey` via `SetSecret`/`GetSecret`. (No key in `wconfig`.)
- Surfacing these in the settings UI is out of S1 scope; for the BYOK smoke, config is set via the settings file and the key via `secretstore` (dev/test path). A polished settings control is S2 / a small settings addition.

## 7. Testing

Go tests only (backend package, no jsdom), over a temp index DB (`OpenIndexAtForTest`) + a fixture vault (`wavevault.OpenVaultAtForTest` — temp dir + real git) + a mock `Embedder` (`SetEmbedderForTest`, deterministic canned vectors). Matches A–E's pattern.

- **reconcile embeds only changed nodes** — first reconcile embeds N nodes; an unchanged reconcile calls `Embed` zero times; editing one node re-embeds only that node's sections (assert embed-call count via the mock).
- **section splitting** — a multi-`##` dossier yields one chunk per section with the right `section_heading`/`section_idx`; a heading-less body yields one chunk.
- **KNN ordering** — canned vectors make a known section the nearest; `Query` returns it top with a higher score than a distractor.
- **scope filtering** — a `WorkerScope` query returns no `tasks/` chunk even when a matching dossier is indexed; `AllScope` returns it.
- **model change → rebuild** — reconciling after changing the configured model wipes and re-embeds at the new dims; a query still works.
- **disabled → unavailable, zero network** — with the flag off (or no key), `OpenIndex`/`Query` report unavailable and the mock embedder is never called; no DB file work.
- **prune** — removing a node from the vault and reconciling deletes its chunks.
- **provider error** — an embedder returning an error surfaces it and leaves the index uncorrupted (previous rows intact).
- **build spike (gate, not a unit test):** confirm sqlite-vec compiles + statically links under `task build:backend` (zig CGO) for the Windows target and `Auto()` + a trivial KNN round-trips at runtime. If it fails → the cosine-BLOB fallback (§Design decisions) behind the same seam.
- **BYOK smoke (opt-in, documented, not CI):** with a real OpenAI-compatible endpoint + key, reconcile a small fixture vault and run a query end-to-end.

## Seams S1 exposes / consumes

- **S1 ⇄ S2 (exposes):** `jarvisembed.OpenIndex(ctx) → *Index`; `(*Index).Query(ctx, queryText, k, scope) → []ScoredChunk`; `(*Index).Reconcile(ctx, r)`; `Available()`; the typed *unavailable* signal. Realizes the meta spec's `Embed`/`Query`/`Invalidate` seam (`Reconcile` subsumes `Invalidate` — invalidation is content-hash diff inside reconcile).
- **S1 ⇄ A (consumes):** `wavevault.OpenVault`/`OpenVaultAtForTest`, `(*Vault).Retriever(scope)` → `Query(Filter{})`/`Read`, `wavevault.AllScope`/`WorkerScope`, `Node.ContentHash`/`Collection`.
- **S1 ⇄ wconfig (consumes):** the three `jarvis:embed*` settings.
- **S1 ⇄ secretstore (consumes):** `GetSecret("jarvis:embedapikey")`.
- **S1 ⇄ S3 (future):** S3's proactive pre-filter reuses `Query` as the relevance gate; no S1 change needed.

## File-touch map

**Go — new:** `pkg/jarvisembed/{embed,index,reconcile,chunk}.go` + `{embed,index,reconcile,chunk,maintest}_test.go`.

**Go — modified:** `pkg/wconfig` settings source struct (three additive `jarvis:embed*` fields) → `task generate` (regenerates `metaconsts.go` + the TS settings types).

**Dependency:** add `github.com/asg017/sqlite-vec-go-bindings/cgo` to `go.mod` (+ `go mod tidy`).

**Docs:** `docs/deferred.md` — S1 deferrals (warm-at-commit wiring unless latency bites; settings UI for embed config/key; multimodal/reranking/local-model) + PLACEHOLDER tuning (query `k`, embed batch size, section-split rules). The v2 meta-spec S1 tracking-table link + the "learning-store cache" wording fix land at S1's feature-commit time (avoid mid-plan edits to that shared file, per the A/B/C/D/F precedent).

## Open risks

- **sqlite-vec under zig CGO (the one real risk).** sqlite-vec's C must compile + statically link through Wave's zig `build:backend` for Windows. Plan step 0 is the build spike; the cosine-BLOB fallback (same seam) de-risks a failure so S1 ships regardless. First build is slow (C compile), then cached.
- **Auto-extension is process-wide.** `sqlite_vec.Auto()` adds `vec_*` functions to every new mattn connection, not just the index DB. Harmless (unused elsewhere), but noted so a future reader doesn't mistake it for coupling.
- **Standing cost is real once enabled.** Every reconcile of changed content, and every query, calls the user's endpoint (their key, their bill). Bounded by content-hash diff (only changes re-embed) and off by default; the invariant is preserved for the default install, not for an opted-in user — by design.
- **First-query latency after edits (lazy).** The first query following a batch of edits pays embed latency for the changed nodes. Bounded to the delta; the warm hook is the documented lever if it bites. Provider-down during that reconcile → degrade to unavailable, not an error.
- **Placeholder tuning** (query `k`, batch size, section-split granularity): fabricated defaults marked PLACEHOLDER in `docs/deferred.md`, to be calibrated against a populated, embedded vault.
- **Dims/model drift.** A user swapping models changes the vector space; `meta.model` mismatch forces a full rebuild (re-embeds everything = a cost spike). Acceptable and rare; surfaced in logs, not silent.
