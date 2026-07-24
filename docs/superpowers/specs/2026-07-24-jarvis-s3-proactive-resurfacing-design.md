# Jarvis sub-project S3 — Proactive resurfacing — design

**Date:** 2026-07-24
**Status:** Design approved (brainstorming). Plan to follow.
**Type:** Sub-project spec (one `spec → plan → implementation` cycle under the [v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md)).

## Where S3 sits

Sub-project **S3** of the [Jarvis second-brain v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md) — **proactive resurfacing**: the headline v2 feature and the one standing noise risk, recall triggered by an *event* instead of a *question*. It is the last step of the semantic lane (`S1 → S2 → S3`); S1 (the embedding foundation, `pkg/jarvisembed`) and S2 (semantic consumers) are built and merged, so S3's hard dependency is cleared. S2 is a **soft** dependency only (relevance weighting) — S3 does not consume S2's L3/L4 code paths in this cycle.

This spec assumes the [S1 design](2026-07-24-jarvis-s1-embedding-foundation-design.md) (the `Query`/`Embed` seam, the `ErrEmbeddingsDisabled` degradation contract), the [C recall design](2026-07-24-jarvis-c-recall-design.md) (the dispatch capture hook S3 sits beside, and the `vault:<id>` grounding-nav convention), the [E continuity design](2026-07-24-jarvis-e-continuity-design.md) (the off-band, non-fatal lifecycle-hook pattern), and the v2 meta spec's [cross-cutting invariants](2026-07-24-jarvis-second-brain-v2-meta-spec.md#cross-cutting-invariants). It inherits as hard constraints: **the model synthesizes/judges, never searches** (v1 invariant 1); **embedding + the model run only at explicit boundaries, never on a background poll** (v1 invariant 1); **the collection/scope boundary is enforced by the retriever's tool set, not a prompt** (v1 invariant 4); **semantic is opt-in and strictly additive** (v2 invariant 10); **graceful degradation is mandatory — a missing/failing provider degrades, never errors the feature** (v2 invariant 11).

## Constraints inherited from the real codebase

S3 is designed against what S1, C, E, F, and G actually ship. The load-bearing facts:

1. **The dispatch boundary is already a wired, off-band hook.** C's `jarviscapture.CaptureRunDispatch(ctx, run)` is called non-fatally from `WshServer.CreateRunCommand` right after `wstore.AppendRun` (`pkg/wshrpc/wshserver/wshserver_runs.go`), and E's `CaptureRunBoundary` is dispatched off-band from `AdvanceRunCommand`. S3 is a third hook of exactly this shape at the *dispatch* boundary — no new event source, no background poll.
2. **A model call cannot run inline in the RPC handler.** `CreateRunCommand` runs on the wshrpc 5s budget; C's capture and E's summary are both dispatched off-band precisely because their work (git, vault, a model call) outlasts it (a known EC-TIME hazard). S3's evaluation is an embedding query *plus* a capable-model judgement — strictly more expensive — so it **must** run in a detached goroutine with its own context, never blocking or failing the dispatch.
3. **`waveobj.Run` carries a generic `Meta` map** (`pkg/waveobj/wtype.go:271`, `MetaMapType`). A dispatch suggestion is run-anchored derived data, so it lives on `run.Meta` — **no new registered WaveObj, no migration**. Persisting it via `wstore.UpdateRun` and then emitting the run's `SendWaveObjUpdate` (the same pair the run handlers already use, `wshserver_runs.go:84`) reaches the frontend over the `waveobj:update` channel it already consumes for run-status changes — so no new wps event stream is needed. Because S3's writer runs off-band (not inside the RPC handler), it emits that update itself; `wps.Broker.Publish` is safe from any goroutine.
4. **S1's query seam is `(*Index).Query(ctx, v *wavevault.Vault, queryText, k, scope) ([]ScoredChunk, error)`** (`pkg/jarvisembed/index.go:136`) — it reconciles lazily, embeds the query text, runs a scope-filtered cosine KNN over the vault chunk index, and returns `ScoredChunk{NodeID, Collection, SectionHeading, SectionIdx, Snippet, Score}` (`index.go:29`). Unavailable → `ErrEmbeddingsDisabled` (`index.go:23`), no network, no DB work. `jarvisembed.Cosine` (`reconcile.go:212`) and `Available()` (`index.go:93`) round out the seam S3 needs. `semanticSeeds` in `pkg/jarvisrecall/retrieve.go:43` is the existing precedent for this exact "open index → Query → degrade to nil on unavailable" shape.
5. **The index holds only vault Markdown** (tasks/decisions/memory sections) — not Runs. So "prior work" is past vault nodes (decisions, dossiers, memory), matched against the new run's `Goal`. This is the natural and only candidate space; no run-vector path is needed (that was S2 L4's concern, not S3's).
6. **The frontend already mounts ambient content on the run body** and can write object meta generically. `runbody.tsx:150` renders `<AmbientTags oref={sourceRefForRun(run).oref} />` under the run goal — the render slot S3's card sits beside. Dismissal writes through `ObjectService.UpdateObjectMeta(oref, meta)` (`frontend/app/store/services.ts:78`), the standard Wave object-meta write path — **no new RPC**.
7. **The capable model runs via `consult.SpecFor("claude") → consult.Run`** (C's synthesis, E's summary). There is no cheap tier (F deferred model tiering). S3 reuses this one capable model for its relevance judgement, gated so it runs at most once per qualifying dispatch.

## Design decisions

Settled in brainstorming:

- **One trigger this cycle: Run dispatch → "prior work."** When a Run is dispatched, S3 semantically matches its `Goal` against past vault nodes and, if the match clears a high bar, surfaces the single best "you've dealt with something like this before" card. Dispatch is the highest-leverage moment (anti-rework fires *before* effort is spent) and the purest expression of embedding-powered recall-from-an-event. Rest-boundary/continuity (which would wire E's dormant `Resume` seam) and conversation-turn triggers are **deferred** (§Deferred).
- **Two-stage noise gate: high-threshold embedding pre-filter → capable-model confirmation.** The cosine pre-filter narrows candidates cheaply; the model then judges whether *any* candidate is genuinely worth interrupting for, and picks the single best or answers "none." The model confirmation is S3's reason to exist over S2 — S2's own spec names "S3's higher relevance bar and/or a model check" as the escalation when cosine alone is too noisy. Both stages run off-band.
- **One card, single best match — never a list.** A "here are 5 possibly-related things" card is noise; "you decided X on this exact problem before" is signal. Ranked lists are a deferred lever.
- **Compute once, persist on the run, sticky dismissal.** The model runs *once* per qualifying dispatch; the result — a suggestion or a "none" sentinel — is written to `run.Meta` so re-viewing never re-pays model cost, and a dismiss is a durable meta flip that survives reload. Mirrors how Radar investigations and run evidence already persist.
- **Delivery rides the run's `waveobj:update`, not a dedicated stream.** Because the suggestion is run-anchored data on `run.Meta`, the run's existing update event delivers it. A dedicated `Event_JarvisProactive` stream (+ tsgen ritual + FE subscription) would be redundant plumbing. Dropped.
- **Graceful degradation is total.** Flag off / index unavailable / model unavailable / provider error → the gate returns "none," the run is untouched, no card. Opt-in and strictly additive (v2 invariants 10, 11).

## What S3 delivers

1. **A dispatch-triggered evaluation pipeline** — `pkg/jarvisproactive.EvaluateDispatch(ctx, run)`: open index → `Query` the goal → self-exclude → high-threshold pre-filter → one capable-model relevance judgement → persist the single best suggestion (or a "none" sentinel) on `run.Meta` (§1).
2. **The relevance gate** — a pure, fixture-testable pre-filter + prompt builder separate from the mockable model call, enforcing the single-best/none contract (§2).
3. **The dispatch hook** — one non-fatal, off-band call in `CreateRunCommand`, beside C's capture (§3).
4. **The run-anchored surface** — a single proactive card rendered on the run body from `run.Meta`, navigable to the cited vault node, dismissible via the standard object-meta write path with a sticky flag (§4).
5. **The degradation wiring** for the whole path, realizing v2 invariant 11 on top of S1's `ErrEmbeddingsDisabled` signal (§5).

## What S3 deliberately does NOT do

- **No trigger other than dispatch.** Rest-boundary/continuity resurfacing (and wiring E's `Resume(r, taskID) → Narrative` seam) and conversation-turn resurfacing are deferred (§Deferred).
- **No global proactive feed / inbox.** The card is anchored to the triggering run; a cross-event suggestion tray is a later addition if more trigger types land.
- **No ranked list.** Single best match only.
- **No new wps event, no new RPC, no new WaveObj, no migration, no `task generate`.** S3 is in-process Go at a lifecycle hook (like C/D/E), persisting to `run.Meta`; delivery rides the run's existing `waveobj:update`; dismissal rides `ObjectService.UpdateObjectMeta`.
- **No run-vector indexing.** Candidates are vault nodes from S1's chunk index; the new run's goal is the query. No `attrib_vectors`-style run cache (that was S2 L4).
- **No auto-promotion of a surfaced insight into `memory/**`** — human-gated at the memory boundary (v3, per the meta spec).
- **No model tiering.** One capable model via `consult`, gated to at most one call per qualifying dispatch (interim; tiering is the shared deferred lever).
- **No standing/background work.** Evaluation fires only at the dispatch boundary; nothing polls.

## Architecture

One new pure-Go package, one modified backend file, one modified frontend file.

- **`pkg/jarvisproactive` (new)** — the dispatch evaluator, deliberately separate from `jarvisrecall` (a pure reader), `jarviscapture` (dispatch *write*), and `jarviscontinuity` (rest-boundary write). Proposed files:

| File | Responsibility |
|---|---|
| `proactive.go` | `EvaluateDispatch(ctx, run)` orchestration (open index → `Query` → self-exclude → pre-filter → `judge` → write `run.Meta` → run update); the mockable `judge` var + `SetJudgeForTest`; the `openIndex`/`openVault` seams for tests. |
| `gate.go` | Pure, process-free helpers: the cosine pre-filter over `[]ScoredChunk`, self-exclusion, `buildJudgePrompt(goal, candidates) string`, and the parse of the model's single-best/none reply. Unit-testable with no vault, no model. |
| `suggestion.go` | The `run.Meta` payload shape (`ProactiveSuggestion`) + its meta key constants + the read/write helpers over `MetaMapType`. |
| `proactive_test.go`, `gate_test.go` | Go tests over a fixture vault (`wavevault.OpenVaultAtForTest`) + a mock embedder (`jarvisembed.SetEmbedderForTest`) + a mock judge (§6). |

- **`wshserver` — modified:** `pkg/wshrpc/wshserver/wshserver_runs.go` — `CreateRunCommand` gains one non-fatal, off-band `EvaluateDispatch` dispatch, after C's `CaptureRunDispatch`.
- **Frontend — modified:** `frontend/app/view/agents/runbody.tsx` — read `run.meta` proactive entry, render one card beside the existing `AmbientTags` slot; a small local pure helper (view-model + dismiss) is extracted for unit testing.

## 1. The dispatch evaluation pipeline

`jarvisproactive.EvaluateDispatch(ctx, run *waveobj.Run) error` — the whole write side, called off-band and non-fatal:

1. **Open the index** (`jarvisembed.OpenIndex(ctx)`). `!ix.Available()` → **no-op**, no write (degradation; the common default-install path).
2. **Open the vault** (`wavevault.OpenVault(ctx)`) for the query handle and self-exclusion read.
3. **Query** — `ix.Query(ctx, v, run.Goal, k, wavevault.AllScope())` → `[]ScoredChunk` (PLACEHOLDER `k`). `ErrEmbeddingsDisabled` or any error → no-op, no write.
4. **Self-exclude** — drop any candidate whose `NodeID` is the dossier C's capture just created for *this* run (the node linking `run-<run.OID>`, found via `Retriever.Query(Filter{HasLink:"run-"+run.OID})`). A run must never resurface against its own freshly-written dossier.
5. **Pre-filter** — keep candidates with `Score ≥ cosThreshold` (PLACEHOLDER, deliberately *high*). Empty → write the **"none" sentinel** to `run.Meta` (so a re-view never recomputes) and stop, **no model call**.
6. **Judge (the one model call, off-band)** — `judge(ctx, cwd, buildJudgePrompt(run.Goal, shortlist))` via `consult.SpecFor("claude") → consult.Run` with a no-op emit (one-shot, unstreamed), `cwd = run.ProjectPath` (vault-root fallback). The prompt asks for the single most-relevant candidate's index, or `none`. A `none` reply (or a parse failure) → write the "none" sentinel, stop.
7. **Persist** — build `ProactiveSuggestion{NodeID, SourceType, Title, Snippet, Why}` for the chosen candidate; write it to `run.Meta` under the proactive key via `wstore.UpdateRun`, then emit `SendWaveObjUpdate` for the run oref. The frontend re-renders the run with the card.

Steps 1–5 (`gate.go`) are pure/fixture-testable with the model absent; step 6's model call is mocked via `SetJudgeForTest`.

## 2. The relevance gate

- **Deterministic pre-filter (invariant 1 free side).** Cosine threshold + self-exclusion + a bound on shortlist size (PLACEHOLDER). No model runs unless the shortlist is non-empty — a below-bar dispatch costs zero tokens.
- **The judge prompt.** Given the goal and the numbered shortlist (each candidate's title + snippet), the model returns the single best index or `none`. The prompt instructs: prefer `none` unless a candidate is *genuinely* the same or closely-related prior problem; it is judging *worth-interrupting-for*, not mere topical overlap. It does **not** synthesize prose or invent a relationship (invariant 1 — the model judges the deterministic candidate set, it does not search).
- **Single-best/none contract.** The parse yields exactly one candidate or nothing. Any ambiguity, out-of-range index, or malformed reply → `none` (fail safe to silence, never to a wrong card).
- **The "none" sentinel is a first-class result**, persisted like a hit — a rewarded "nothing to surface" state that prevents recomputation, not an error.

## 3. The dispatch hook

In `CreateRunCommand` (`wshserver_runs.go`), after the existing `wstore.AppendRun` and C's `CaptureRunDispatch`:

```go
go func() {
    bgctx := context.Background() // detached, not the RPC ctx
    if err := jarvisproactive.EvaluateDispatch(bgctx, run); err != nil {
        log.Printf("jarvisproactive: dispatch eval failed for run %s: %v", run.OID, err)
    }
}()
```

**Off-band and non-fatal**, dispatched exactly like C's capture / E's `captureAsync`. S3 must never make `CreateRunCommand` slower or failable — an eval failure logs and is dropped; the run dispatch is unaffected. Ordering relative to C's capture does not matter: S3 self-excludes this run's dossier regardless of whether the capture commit is indexed yet.

## 4. The run-anchored surface

- **Render.** `runbody.tsx` reads `run.meta` for the proactive entry. A hit that is not dismissed renders **one** card beside the existing `AmbientTags` slot (`runbody.tsx:150`): the source-type label, `Title`, and a one-line `Why`. The "none" sentinel and a dismissed suggestion render nothing.
- **Navigation.** Clicking the card navigates to the cited vault node via the existing grounding-nav convention (`vault:<id>`; G already tolerates non-ORef nav targets — the same handling recall's grounding cards use). A deep-link into the future Tasks (U2) surface is a later refinement.
- **Dismiss.** A dismiss control calls `ObjectService.UpdateObjectMeta(runORef, {…dismissed flag…})` — the standard object-meta write path — flipping a durable flag on `run.Meta`. The run's `waveobj:update` re-renders it away; the flag is persisted, so the card stays gone across reload. No new RPC.
- **Design language.** Dark mode only; `@theme` tokens (never raw hex); existing cockpit fonts; restrained motion; visually subordinate to the run's own content (a suggestion, not a demand). Low-confidence framing parallels the ambient-tag treatment.

## 5. Degradation contract

Built on S1's `Available()` / `ErrEmbeddingsDisabled`:

- Flag off (default install) → `EvaluateDispatch` no-ops at step 1; no write, no card, zero standing cost. v2 == v1.
- Index reconcile / query error, or provider error mid-`Query` → no-op, no write.
- Model unavailable (`claude` CLI absent) or judge error → treated as `none`; the sentinel is written; no card.
- No path surfaces an embedding/model failure to the user or affects the run. S1 owns the signal; S3 owns the silent fallback.

## 6. Testing

Go tests only for the backend (no jsdom), over a fixture vault (`wavevault.OpenVaultAtForTest` — temp dir + real git) + a mock embedder (`jarvisembed.SetEmbedderForTest`, deterministic canned vectors keyed off text) + a mock judge (`SetJudgeForTest`). Matches S1/S2/C/D/E.

- **buildJudgePrompt (pure)** — the prompt contains the goal and each numbered candidate's title/snippet, and the prefer-`none` guardrail text. No vault, no model.
- **pre-filter (pure)** — candidates below `cosThreshold` are dropped; an empty shortlist yields the "none" sentinel and the judge is never called (assert mock judge call count 0).
- **self-exclusion** — a dispatch whose own freshly-written dossier (linking `run-<oid>`) scores highest is excluded from the shortlist; it never becomes the suggestion.
- **hit** — a goal semantically near a past decision (canned vector) + a mock judge picking index 1 → `run.Meta` carries a `ProactiveSuggestion` for that node; the run update is observable.
- **judge says none** — a non-empty shortlist + a mock judge returning `none` → the "none" sentinel is written, no suggestion.
- **parse fail-safe** — a malformed / out-of-range judge reply → `none`, never a wrong card.
- **degrade = no-op** — flag off (nil embedder): `EvaluateDispatch` writes nothing and the mock judge is never called; the run's meta is unchanged.
- **CDP** (`scripts/cdp/scenarios.mjs`, new `jarvis-proactive`): inject a seeded, embedded vault with a relevant decision + a stubbed judge; dispatch a run whose goal matches → the proactive card appears on the run body; dismiss → the card is gone and stays gone after reload. No jsdom (standing decision — wiring verified live).

## Seams S3 exposes / consumes

- **S3 ⇄ wshserver (exposes):** `jarvisproactive.EvaluateDispatch(ctx, run)` — the non-fatal, off-band dispatch hook.
- **S3 ⇄ S1 (consumes):** `jarvisembed.OpenIndex`, `(*Index).Available`, `(*Index).Query`, `Cosine`, `ErrEmbeddingsDisabled` (the degradation contract).
- **S3 ⇄ A (consumes):** `wavevault.OpenVault`, `AllScope`, `Retriever.Query(Filter{HasLink})` for self-exclusion.
- **S3 ⇄ wstore (consumes):** the `*waveobj.Run` handed to the hook (`Goal`, `ProjectPath`, `OID`, `Meta`) + the run update path that fires `SendWaveObjUpdate`.
- **S3 ⇄ consult (consumes):** `SpecFor("claude")` + `Run` — the interim capable model for the relevance judgement.
- **S3 ⇄ G (consumes, FE):** the run-body ambient render slot; `sourceRefForRun`; the `vault:<id>` grounding-nav convention; `ObjectService.UpdateObjectMeta` for dismissal.
- **S3 ⇄ S2 (soft, unused this cycle):** S2's L4 semantic edges could later weight relevance; S3 v1 queries S1 directly and does not depend on S2's code paths.
- **S3 ⇄ E (future):** a rest-boundary trigger increment would wire E's exposed-but-unwired `Resume(r, taskID) → Narrative` seam; out of this cycle.

## File-touch map

**Go — new:** `pkg/jarvisproactive/{proactive.go, gate.go, suggestion.go, proactive_test.go, gate_test.go}`.

**Go — modified:** `pkg/wshrpc/wshserver/wshserver_runs.go` — one non-fatal, off-band `EvaluateDispatch` dispatch in `CreateRunCommand`, beside C's capture.

**FE — modified:** `frontend/app/view/agents/runbody.tsx` — render the run-anchored proactive card from `run.meta`; extract a small pure view-model/dismiss helper (+ a vitest unit).

**No** RPC / wps event / WaveObj / migration / `task generate`.

**CDP:** `scripts/cdp/scenarios.mjs` — new `jarvis-proactive` scenario (+ an inject helper for a seeded, embedded vault, if not reusable from S2's smoke).

**Docs:** `docs/deferred.md` — S3 PLACEHOLDER tunables (`k`, `cosThreshold`, shortlist cap, the judge prompt) + the S3 deferrals (rest-boundary/continuity trigger + E `Resume` wiring, conversation trigger, global feed, ranked lists, "ask Jarvis" action, model tiering). The v2 meta-spec S3 tracking-table links (spec + plan) land at **S3 feature-commit time**, not now (the A–F/S1/S2 precedent: avoid mid-plan edits to the shared meta-spec file).

## Open risks

- **Relevance quality at dispatch (the real product risk).** A goal string is short signal; a cosine match over it can be topically-adjacent-but-useless. Mitigations: a deliberately *high* cosine bar, the capable-model confirmation with a prefer-`none` prompt, single-best-only, low-friction dismissal, and the sentinel that never nags twice. The threshold + prompt are PLACEHOLDERs to calibrate on a populated, embedded vault; if noise persists, tightening the bar or enriching the query (goal + first-phase context) are the levers.
- **Dark until the vault accretes + embeds.** Like C, S3 surfaces nothing until the vault holds past decisions/dossiers *and* embeddings are on. Accepted — the architecture is honest; the CDP scenario seeds a vault so the path is provable, and value grows as the vault does.
- **Off-band failure is silent.** The eval runs detached, logged not surfaced (like C's capture / E's seal). A persistently failing index/model leaves runs without cards but never blocks a dispatch. The log is the signal.
- **`run.Meta` growth.** One small suggestion (or sentinel) per dispatched run. Bounded and rebuildable (derived); deleting the meta key and re-dispatching reproduces it. Not committed to the vault.
- **Cost is opt-in only.** The embedding query + judge model call run only when the user enabled the flag and configured a provider, and the judge only when the pre-filter clears the bar. Off by default → zero S3 cost, v1 behavior exactly (v2 invariant 10).
