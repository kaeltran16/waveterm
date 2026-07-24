# Jarvis second brain — v2 meta spec

**Date:** 2026-07-24
**Status:** Decomposition agreed. Sub-project specs to follow; built one at a time (or in parallel worktrees) from this file.
**Type:** Meta spec — umbrella / decomposition index for v2. It settles the one new cross-cutting decision v2 introduces (the embedding foundation) and sequences the rest; it is not an implementation plan.

**Scope.** This file sequences the build of **v2** of the Jarvis second brain into independent sub-projects. v1 (recall + continuity over the Wave Vault, deterministic attribution, presence D) is **complete** — all seven sub-projects A–G are built (see the [v1 meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) tracking table). v2 adds the one standing cost v1 deliberately deferred — an embedding index — and everything it unlocks.

It does *not* re-decide product/architecture already settled in:

- [v1 meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — the invariants, seams, and v1/v2 boundary that named this work.
- [Jarvis second brain — design](2026-07-22-jarvis-second-brain-design.md) — the four load-bearing v1 decisions, the cost model, and the v1/v2 sequencing (its "v2 — proactive + semantic" paragraph is what this file decomposes).
- [Wave Vault direction brief](../briefs/2026-07-22-jarvis-second-brain-wave-vault-brief.md) and [UI design brief](../briefs/2026-07-23-jarvis-second-brain-ui-design-brief.md).

Read those first; everything here assumes them.

Unlike v1, v2 has **no separate design doc**: its only heavy new architectural decision is the embedding foundation, settled inline below. The remaining pieces were already sketched in the v1 design's Sequencing/cost sections; each sub-project's own spec refines its internals.

## What this document is

The parent index for building v2. **Each sub-project below gets its own `spec → plan → implementation` cycle** under `docs/superpowers/`. This file owns only what is cross-cutting and must not drift per sub-project:

- the **one new architectural decision** (opt-in, BYOK embedding foundation);
- the **invariants** v2 adds on top of the inherited v1 set;
- the **decomposition** (S1–S3 semantic, U1–U3 UX) and each piece's responsibility boundary;
- the **seams** that let the pieces be built and tested independently;
- the **two-lane parallel DAG** and the v2/v3 boundary;
- a **living tracking table**.

When we "build 1 by 1" (or in parallel), we run one sub-project's full cycle, update the tracking table, and return here to pick the next.

## v2 in one paragraph

v2 lights up the **semantic** and **proactive** behavior v1 deferred, plus three UX surfaces the vault now makes possible. It rests on one new, **opt-in** substrate — a **BYOK embedding index** (Bring Your Own Key; OpenAI-compatible; local = a local-server base URL). With embeddings off (the default) v2 is **strictly additive**: v1 behaves exactly as before, zero standing cost. With them on, semantic recall (layer 3), semantic attribution (layer 4), and proactive resurfacing come alive; the three UX surfaces (Presence C "Spaces", the Tasks dossier editor, the Graph view) never touch embeddings and run in a parallel lane against already-built v1 subsystems.

## Foundation decision: embeddings are opt-in + BYOK

The one new architectural decision, made here because v2 has no separate design doc.

v1's determinism boundary held that *only a model call costs tokens*; embeddings were the single standing cost, so they were deferred. v2 introduces them **without breaking that invariant for the default install**, by making the whole semantic capability opt-in and user-provisioned:

- **Opt-in feature flag.** Off by default → v2 == v1, zero standing cost, determinism boundary literally intact. v2 is strictly additive.
- **BYOK, provider-agnostic.** Wave ships **no** embedding credentials. The user supplies an OpenAI-compatible endpoint — `base URL + model` in `wconfig`, the API key in `secretstore`. One `Embedder` implementation covers OpenRouter (confirmed to expose `POST /api/v1/embeddings`, July 2026), OpenAI/Voyage/Cohere/Gemini directly, **and "local"** — a local OpenAI-compatible server (Ollama, LM Studio, llama.cpp). "Local vs cloud" collapses into *which base URL*; no runtime to bundle.
- **The standing cost, and the privacy tradeoff, become the user's explicit choice** (their key, their bill, their data leaving the machine — only if they turn it on and point it at a cloud provider).

This turns the deferred-cost tension into a clean opt-in, and makes graceful degradation a first-class invariant (below).

## Cross-cutting invariants

v2 **inherits all nine v1 invariants** (determinism/cost boundary; model tiers; Markdown canonical; collection boundary in code; write-ownership; human owns material decisions; grounding first-class; presence D; Wave cockpit design language). It adds these:

10. **Semantic is opt-in; v2 is strictly additive.** With the embedding flag off (default), no v1 behavior changes and no standing cost is incurred. The standing cost exists only for a user who enables the flag and configures a provider.
11. **Graceful degradation is mandatory.** Every semantic consumer defines its no-embeddings fallback = its v1 behavior: L3 recall → L1/L2 (frontmatter + full-text); L4 attribution → deterministic edges L1–3; proactive → off. A missing, misconfigured, or failing provider **degrades**, it never errors the feature.
12. **BYOK, provider-agnostic; Wave ships no credentials.** OpenAI-compatible embeddings only (`base URL + model` in `wconfig`, key in `secretstore`). Local is a local-server base URL, not a bundled model.
13. **The index is a rebuildable, model-tagged derived artifact.** It is Wave's first persisted derived-layer artifact, **never committed to the vault** (extends v1 invariant 3). It is embedded only at explicit boundaries (commit/lifecycle), never on a background poll (extends v1 invariant 1). Changing the provider or model changes the vector space → the index is invalidated and rebuilt; content-hash invalidation reuses v1's mechanism.

## Subsystem decomposition

| # | Sub-project | One line | Depends on | Lane |
|---|---|---|---|---|
| **S1** | Embedding foundation | `Embedder` seam + vector index + flag/config + graceful-degradation contract | v1 A | semantic |
| **S2** | Semantic consumers | L3 recall + L4 attribution, lit up on the index | S1 (v1 C, D) | semantic |
| **S3** | Proactive resurfacing | Event-triggered recall + noise gate + ambient cards | S1 (soft: S2) | semantic |
| **U1** | Presence C ("Spaces") | Task-focus mode; grow D → C | v1 G | UX |
| **U2** | Tasks surface | Dossier editor: machine regions read-only, append-entry | v1 A/B | UX |
| **U3** | Graph surface | Wikilink + typed-edge graph view | v1 A/D | UX |

The UX lane (U1–U3) has **no embedding dependency** — it consumes only already-built v1 subsystems and can start immediately, in parallel with the semantic lane and with each other.

### S1 — Embedding foundation
**Purpose.** The one new standing-cost substrate, entirely opt-in; the bottleneck the semantic lane serializes on.
**Responsibilities.** The `Embedder` provider abstraction (OpenAI-compatible: base URL + key + model); the rebuildable, model-tagged **vector index** in the derived layer; section-level chunking with frontmatter as metadata; content-hash invalidation reusing v1's mechanism; the feature flag + config (`wconfig`) + key storage (`secretstore`); indexing driven only at explicit boundaries (commit/lifecycle), never a background poll; the graceful-degradation contract every consumer implements.
**Interface (exposes).** `Embed(texts) → vectors`; a vector-query seam `Query(vector, k, filter) → scoredChunks` and `Invalidate(changedNodes)`.
**Out of scope (v3).** Multimodal/image embeddings; reranking models; a bundled local embedding model (local = local-server base URL).

### S2 — Semantic consumers (L3 + L4)
**Purpose.** Light up the two thin extensions that consume S1's index: semantic recall and semantic attribution. One sub-project, two plan phases — both are additive extensions of existing v1 engines, not new subsystems.
**Responsibilities.**
- *L3 (recall, `pkg/jarvisrecall`):* a vector candidate source merged with L1/L2 before traversal; the model still synthesizes, never searches; degrades to L1/L2 with the flag off.
- *L4 (attribution, `pkg/jarvisattrib`):* a new *producer* of proposed edges (provenance=semantic, low confidence, probation-gated) matching a Run's objective/diff to a task's acceptance criteria, with the index as candidate pre-filter so it never compares against every task; runs only when L1–3 are silent. Reuses v1 D's probation / self-correction / one-click-detach machinery wholesale.
**Interface (exposes).** Nothing new: the `recall(query, scope)` contract and the `EdgesFor` read are unchanged; L3 enriches the candidate set, L4 writes into the existing edge store.
**Out of scope.** Hybrid-search score-fusion tuning beyond a simple merge; auto-hardening a semantic edge without probation (invariant preserved).

### S3 — Proactive resurfacing
**Purpose.** The headline v2 feature and the one noise risk: recall triggered by an event instead of a question.
**Responsibilities.** A new *entry point* into the same recall tools — deterministic event → embedding pre-filter → capable model only if it clears a relevance threshold → an ambient card in Presence D; the relevance/noise gate (raised because transient wrong edges exist before self-heal); off entirely with the flag off.
**Interface (exposes).** A proactive-suggestion stream the ambient layer (v1 Presence D) renders.
**Interface (consumes).** S1 (hard); S2 (soft — relevance weighting); v1 F/C/E and the ambient card surface (v1 G).
**Out of scope (v3).** Auto-promoting a surfaced insight into `memory/**` (stays human-gated).

### U1 — Presence C ("Spaces")
**Purpose.** Grow presence D → C: the active task becomes the lens; surfaces scope to it, switched like desktops.
**Responsibilities.** A strict superset of D (same ambient cards + `Ctrl+P`, plus scoping), so no rework of D — add "focus on a task," don't rebuild. *No embedding dependency.*
**Interface (consumes).** v1 G surfaces + nav/cockpit.
**Out of scope.** Anything that would make a task focus the *only* mode (D stays the global default).

### U2 — Tasks surface
**Purpose.** The dossier editor the v1 write-ownership design anticipated.
**Responsibilities.** Realizes the two-tier enforcement's *inside-Wave* tier over v1's region-aware write path: machine regions render read-only / visually distinct; the decisions log offers "append entry," not "edit entry." *No embedding dependency.*
**Interface (consumes).** v1 A's region-aware write path + B's typed dossier/records.
**Out of scope.** The *outside-Wave* guard (already v1 A's diff-validated write path).

### U3 — Graph surface
**Purpose.** The wikilink + typed-edge graph view.
**Responsibilities.** Renders deterministic edges (v1 D's `EdgesFor`) + vault wikilink expansion from day one; gets richer once S3's L4 edges land but never requires them; low-confidence/probation edges render distinctly (parallels the ambient-tag treatment). *No embedding dependency.*
**Interface (consumes).** v1 D `EdgesFor` + A wikilink neighborhood expansion.
**Out of scope.** Editing the graph (edges are produced by attribution, corrected by detach — not hand-drawn here).

## Seams

The typed interfaces that make each piece independently buildable and testable.

- **S1 → semantic consumers — `Embedder` + vector-query.** `Embed(texts) → vectors`, `Query(vector, k, filter) → scoredChunks`, `Invalidate(nodes)`. Model-tagged, rebuildable from the vault. Consumers may be built against a stub embedder (canned vectors) before a real provider is wired — the v1 contract-first shim trick.
- **S2 ⇄ v1 C.** L3 is a candidate source *inside* the unchanged `recall(query, scope)` contract — additive, degrades to L1/L2.
- **S2 ⇄ v1 D.** L4 is a new edge *producer* into the existing store; `EdgesFor` read and probation machinery unchanged.
- **S3 ⇄ v1 F/C/E + ambient surface.** Same recall tools, different entry point; exposes a suggestion stream to the ambient layer.
- **U1/U2/U3 ⇄ v1 A/B/D/G.** Consume existing vault read/write, dossier, edges, and nav — no new backend seam. U2 specifically drives A's region-aware write path.

## Build order

The dependency DAG is the hard constraint; the sequence within it is advisory.

```
SEMANTIC LANE (serializes on S1):
  S1 ──> S2 ──> S3          (S3: hard-dep S1; soft-dep S2)

UX LANE (independent — start any time, parallel to the semantic lane and to each other):
  U1        U2        U3    (U3 richer after S2's L4, not blocked by it)
```

**Hard dependencies:** `S1 → {S2, S3}`. Everything else is free to parallelize.

**Recommended sequence — substrate-first (semantic lane).** **S1 first** — it is the only bottleneck, and substrate-first fits here because the consumers are extensions of existing engines and S1 is compact (a seam + index + config). Then **S2**, then **S3**. The **UX lane runs alongside** whenever there is capacity; each of U1/U2/U3 is independently demoable.

- **First demoable semantic win:** S2's L3 ("ask in different words, still finds it").
- **First demoable UX win:** U3 (graph) or U2 (Tasks editor) — both demoable after one cycle, no embeddings needed.
- **Parallel-safe in practice:** each concurrently-built sub-project needs its own git worktree (the shared working tree would otherwise collide); the DAG is what makes that safe. See [[shared-tree-concurrent-edits]].

## Integration & naming notes

- **Extend, don't fork.** L3/L4 extend existing packages (`pkg/jarvisrecall`, `pkg/jarvisattrib`) rather than spawn new ones. Genuinely new backend subsystems get new packages (embedding foundation → e.g. `pkg/jarvisembed`; proactive → e.g. `pkg/jarvisproactive`). New UX surfaces are frontend under `frontend/app/view/jarvis/`.
- **Config & secrets.** Flag + base URL + model → `wconfig` (JSON schema regenerated). BYOK key → `secretstore`, never plain config. Do **not** build on `aiusechat` (slated for removal ~Phase 6; see [[wave-ai-on-chopping-block]]).
- **Backend spine.** Any new cross-process behavior is a wshrpc command in `pkg/wshrpc`; regenerate TS/Go bindings with `task generate` after any type change (Go is source of truth).
- **Nav.** U1/U2/U3 extend the real nav rail (`frontend/app/view/agents/navrail.tsx`) — add `SurfaceKey` values + `ITEMS`/`ICON` entries; do not adopt the mockup's reduced rail.
- **Tokens & fonts.** `@theme` tokens in `tailwindsetup.css`, existing cockpit fonts, dark mode only (v1 invariant 9; light mode is permanently off the table — see [[cockpit-light-mode-wontfix]]).

## v2 / v3 boundary

Explicitly deferred out of v2:

- Multimodal / image embeddings (the vault is text; OpenRouter supports it but YAGNI).
- Reranking models and advanced hybrid-search score fusion (start with a simple candidate merge).
- A bundled local embedding model (covered by a local-server base URL).
- Auto-promotion of proactive insights into `memory/**` (stays human-gated at the memory boundary).
- Cross-machine sync (still the user's own git remote; Wave implements none — carried from v1).

## Tracking table

Living index — link each artifact as it is produced.

| # | Sub-project | Spec | Plan | Built |
|---|---|---|---|---|
| S1 | Embedding foundation | [spec](2026-07-24-jarvis-s1-embedding-foundation-design.md) | [plan](../plans/2026-07-24-jarvis-s1-embedding-foundation.md) | Built — opt-in BYOK embedding foundation (pkg/jarvisembed): OpenAI-compatible Embedder seam + dedicated sqlite-vec derived-layer index (static-linked via `sqlite_vec.Auto()`, outside the vault) + hybrid lazy/warm Reconcile (content-hash diff, only-changed re-embed, prune, model-change rebuild) + section-level chunks + scope-filtered vec0 KNN (scope filter on the vec0 metadata column) + typed ErrEmbeddingsDisabled degradation. No consumer wired (S2 is first); adds jarvis:embed* config + secretstore key. Build wiring: vendored `pkg/jarvisembed/csrc/sqlite3.h` + global `CGO_CFLAGS -I…/csrc` (preserve `-O2`); S2 threads it into the Taskfile — see docs/deferred.md. |
| S2 | Semantic consumers (L3 + L4) | — | — | — |
| S3 | Proactive resurfacing | — | — | — |
| U1 | Presence C ("Spaces") | [spec](2026-07-24-jarvis-u1-spaces-design.md) | [plan](../plans/2026-07-24-jarvis-u1-spaces.md) | Built — app-bar Space chip + Ctrl+P "Focus on task" group scope the Agent roster + Channels to a task's attributed runs (via D's EdgesFor); filter + "Show all" escape hatch; needs-you never suppressed; `ListDossiers`/`ResolveSpaceScope` pure-read RPCs (`pkg/wshrpc`). No embeddings/model/WaveObj/migration. Sessions/Radar/Jarvis-recall-default deferred |
| U2 | Tasks surface | — | — | — |
| U3 | Graph surface | — | — | — |

## Non-goals

All v1 non-goals carry forward (no embedding/executing Obsidian or its plugins; no Dataview/Canvas/theme compatibility; no replacing an external tracker; no auto-projecting task history into every coding agent; no copying full transcripts or Run evidence into Markdown; no cloud sync or collaborative editing; not a general-purpose knowledge-management product; no light mode). v2 adds no new product scope beyond the six sub-projects above.
